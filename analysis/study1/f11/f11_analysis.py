from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from f11_stats import (
    B, CONTINUOUS_PREDICTORS, N, PERCENTILE_LOWER_ONE_BASED, PERCENTILE_UPPER_ONE_BASED,
    PREDICTORS, PRIMARY_SEEDS, PROTOCOL_ID, RAW_RECORD_ROOT_SHA256, SCENARIOS, SCHEDULE_SHA256,
    apply_holm, as_python, bootstrap_t_mean, bootstrap_t_ratio, mechanism_solve,
    percentile_mean, percentile_ratio, sha256_file,
)


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(as_python(value), indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def require_runtime() -> None:
    if sys.version_info[:3] != (3, 12, 13):
        raise RuntimeError(f"Python 3.12.13 required, observed {sys.version.split()[0]}")
    if np.__version__ != "2.5.3":
        raise RuntimeError(f"numpy 2.5.3 required, observed {np.__version__}")


def load_stream_estimators(root: Path) -> tuple[dict[tuple[str, int], dict[str, Any]], list[dict[str, Any]], list[tuple[str, int, int, int]]]:
    streams: dict[tuple[str, int], dict[str, Any]] = {}
    mechanism_rows: list[dict[str, Any]] = []
    eligibility_rows: list[tuple[str, int, int, int]] = []
    for file in sorted((root / "records").glob("*.json")):
        record = json.loads(file.read_text(encoding="utf-8"))
        scenario = record["identity"]["scenario_id"]
        realisation = int(record["identity"]["realisation"])
        comparator = bool(record["identity"]["comparator_included"])
        if record.get("protocol_id") != PROTOCOL_ID or record.get("integrity_status") != "VALID_RAW_CONFIRMATORY_EVIDENCE":
            raise RuntimeError("raw record envelope invalid")
        h1: list[float] = []; h2: list[float] = []; h1_500: list[float] = []; h2_500: list[float] = []
        h1_bal: list[float] = []; h2_bal: list[float] = []; h1_5000: list[float] = []; h2_5000: list[float] = []
        rr_persist_2: list[float] = []; rr_restart_2: list[float] = []; rr_persist_5: list[float] = []; rr_restart_5: list[float] = []
        a = q = itt = a500 = q500 = itt500 = abe = qbe = 0.0
        a5000 = q5000 = itt5000 = 0.0
        for checkpoint in record["checkpoints"]:
            state = checkpoint["state"]
            persist = state["PERSIST"]["horizons"]
            restart = state["RESTART-CART"]["horizons"]
            champion = state["CHAMPION-RESEED"]["horizons"]
            h1.append(restart["2000"]["mean_loss"] - persist["2000"]["mean_loss"])
            h2.append(champion["2000"]["mean_loss"] - persist["2000"]["mean_loss"])
            h1_500.append(restart["500"]["mean_loss"] - persist["500"]["mean_loss"])
            h2_500.append(champion["500"]["mean_loss"] - persist["500"]["mean_loss"])
            h1_bal.append(restart["2000"]["balanced_error"] - persist["2000"]["balanced_error"])
            h2_bal.append(champion["2000"]["balanced_error"] - persist["2000"]["balanced_error"])
            material = checkpoint["material"]
            eligible = 1.0 if material["eligible"] else 0.0
            eligibility_rows.append((scenario, realisation, checkpoint["checkpoint"], int(eligible)))
            if eligible:
                d = float(material["contrasts"]["2000"])
                d500 = float(material["contrasts"]["500"])
                d_bal = (material["arms"]["MATERIAL-REPLACE"]["horizons"]["2000"]["balanced_error"] -
                         material["arms"]["STRUCTURAL-SHAM"]["horizons"]["2000"]["balanced_error"])
                mechanism_rows.append({"scenario_id": scenario, "realisation": realisation,
                    "source_key_hex": record["identity"]["source_key_hex"], "checkpoint": checkpoint["checkpoint"],
                    "outcome": d, **material["mechanism_predictors"]})
            else:
                d = d500 = d_bal = 0.0
            a += eligible * d / 2; q += eligible / 2; itt += d / 2
            a500 += eligible * d500 / 2; q500 += eligible / 2; itt500 += d500 / 2
            abe += eligible * d_bal / 2; qbe += eligible / 2
            if comparator:
                h1_5000.append(restart["5000"]["mean_loss"] - persist["5000"]["mean_loss"])
                h2_5000.append(champion["5000"]["mean_loss"] - persist["5000"]["mean_loss"])
                d5000 = float(material["contrasts"]["5000"]) if eligible else 0.0
                a5000 += eligible * d5000 / 2; q5000 += eligible / 2; itt5000 += d5000 / 2
                random_restart = checkpoint["random_restart_S1"]["horizons"]
                rr_persist_2.append(random_restart["2000"]["mean_loss"] - persist["2000"]["mean_loss"])
                rr_restart_2.append(random_restart["2000"]["mean_loss"] - restart["2000"]["mean_loss"])
                rr_persist_5.append(random_restart["5000"]["mean_loss"] - persist["5000"]["mean_loss"])
                rr_restart_5.append(random_restart["5000"]["mean_loss"] - restart["5000"]["mean_loss"])
        streams[(scenario, realisation)] = {
            "source_key_hex": record["identity"]["source_key_hex"], "comparator_included": comparator,
            "H1": sum(h1) / 2, "H2": sum(h2) / 2, "A": a, "Q": q, "H3_ITT": itt,
            "H1_500": sum(h1_500) / 2, "H2_500": sum(h2_500) / 2, "A500": a500, "Q500": q500,
            "H3_ITT_500": itt500, "H1_BE": sum(h1_bal) / 2, "H2_BE": sum(h2_bal) / 2, "ABE": abe, "QBE": qbe,
            "H1_5000": sum(h1_5000) / 2 if comparator else None, "H2_5000": sum(h2_5000) / 2 if comparator else None,
            "A5000": a5000 if comparator else None, "Q5000": q5000 if comparator else None,
            "H3_ITT_5000": itt5000 if comparator else None,
            "RR_PERSIST_2000": sum(rr_persist_2) / 2 if comparator else None,
            "RR_RESTART_2000": sum(rr_restart_2) / 2 if comparator else None,
            "RR_PERSIST_5000": sum(rr_persist_5) / 2 if comparator else None,
            "RR_RESTART_5000": sum(rr_restart_5) / 2 if comparator else None,
        }
    if len(streams) != 4480:
        raise RuntimeError("stream estimator cardinality mismatch")
    return streams, mechanism_rows, eligibility_rows


def matrix(streams: dict[tuple[str, int], dict[str, Any]], field: str, subset: bool = False) -> np.ndarray:
    rows = []
    for scenario in SCENARIOS:
        values = [streams[(scenario, r)][field] for r in range(N)
                  if not subset or streams[(scenario, r)]["comparator_included"]]
        expected = 20 if subset else N
        if len(values) != expected:
            raise RuntimeError(f"stratum cardinality mismatch for {field}: {scenario}")
        rows.append(values)
    return np.asarray(rows, float)


def write_stream_outputs(out: Path, streams: dict[tuple[str, int], dict[str, Any]]) -> None:
    fields = ["scenario_id", "realisation", "source_key_hex", "comparator_included", "H1", "H2", "A", "Q",
              "H3_ITT", "H1_500", "H2_500", "A500", "Q500", "H3_ITT_500", "H1_5000", "H2_5000",
              "A5000", "Q5000", "H3_ITT_5000"]
    with (out / "STREAM_ESTIMATORS.tsv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        for scenario in SCENARIOS:
            for realisation in range(N):
                writer.writerow({"scenario_id": scenario, "realisation": realisation,
                    **{k: streams[(scenario, realisation)].get(k) for k in fields if k not in ("scenario_id", "realisation")}})
    with (out / "PRIMARY_BY_SCENARIO.tsv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, delimiter="\t", lineterminator="\n")
        writer.writerow(["scenario_id", "H1_mean", "H2_mean", "A_mean", "Q_mean", "H3_conditional_ratio", "H3_ITT_mean"])
        for scenario in SCENARIOS:
            rows = [streams[(scenario, r)] for r in range(N)]
            abar = np.mean([x["A"] for x in rows]); qbar = np.mean([x["Q"] for x in rows])
            writer.writerow([scenario, np.mean([x["H1"] for x in rows]), np.mean([x["H2"] for x in rows]),
                             abar, qbar, abar / qbar if qbar > 0 else "", np.mean([x["H3_ITT"] for x in rows])])


def mechanism_analysis(rows: list[dict[str, Any]]) -> dict[str, Any]:
    means = {p: float(np.mean([r[p] for r in rows])) for p in CONTINUOUS_PREDICTORS}
    sds = {p: float(np.std([r[p] for r in rows], ddof=1)) for p in CONTINUOUS_PREDICTORS}
    xpred = np.asarray([[((r[p] - means[p]) / sds[p] if p in CONTINUOUS_PREDICTORS else float(r[p]))
                         for p in PREDICTORS] for r in rows], float)
    y = np.asarray([r["outcome"] for r in rows], float)
    dummies = np.zeros((len(rows), 13))
    for i, row in enumerate(rows):
        scenario_index = SCENARIOS.index(row["scenario_id"])
        if scenario_index > 0:
            dummies[i, scenario_index - 1] = 1.0
    design = np.column_stack([np.ones(len(rows)), dummies, xpred])
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    rank = int(np.linalg.matrix_rank(design))

    p_dim = len(PREDICTORS)
    sufficient = []
    for scenario in SCENARIOS:
        by_stream = []
        for realisation in range(N):
            indices = [i for i, row in enumerate(rows)
                       if row["scenario_id"] == scenario and row["realisation"] == realisation]
            if indices:
                x = xpred[indices]; yy = y[indices]
                by_stream.append(np.concatenate([[len(indices)], x.sum(axis=0), [yy.sum()],
                                                 (x.T @ x).reshape(-1), x.T @ yy]))
            else:
                by_stream.append(np.zeros(1 + p_dim + 1 + p_dim * p_dim + p_dim))
        sufficient.append(np.stack(by_stream))

    rng = np.random.Generator(np.random.PCG64(8085499736201925965))
    boot = np.full((B, p_dim), np.nan)
    probabilities = np.full(N, 1 / N)
    for start in range(0, B, 100):
        batch = min(100, B - start)
        cxx = np.zeros((batch, p_dim, p_dim)); cxy = np.zeros((batch, p_dim))
        for flat in sufficient:
            counts = rng.multinomial(N, probabilities, size=batch).astype(float)
            agg = counts @ flat
            cluster_rows = agg[:, 0]; sx = agg[:, 1:1 + p_dim]; sy = agg[:, 1 + p_dim]
            offset = 2 + p_dim
            sxx = agg[:, offset:offset + p_dim * p_dim].reshape(batch, p_dim, p_dim)
            sxy = agg[:, offset + p_dim * p_dim:offset + p_dim * p_dim + p_dim]
            good = cluster_rows > 0
            cxx[good] += sxx[good] - np.einsum("bi,bj->bij", sx[good], sx[good]) / cluster_rows[good, None, None]
            cxy[good] += sxy[good] - sx[good] * sy[good, None] / cluster_rows[good, None]
        for j in range(batch):
            boot[start + j] = mechanism_solve(cxx[j], cxy[j])

    coefficients = []
    for j, predictor in enumerate(PREDICTORS):
        finite = boot[np.isfinite(boot[:, j]), j]
        entry = {"predictor": predictor, "coefficient": beta[14 + j],
                 "finite_bootstrap_coefficients": len(finite), "finite_fraction": len(finite) / B,
                 "standardised": predictor in CONTINUOUS_PREDICTORS}
        if len(finite) == B:
            ordered = np.sort(finite)
            entry.update({"interval_status": "ESTIMABLE",
                          "ci95_percentile": [ordered[PERCENTILE_LOWER_ONE_BASED - 1],
                                              ordered[PERCENTILE_UPPER_ONE_BASED - 1]]})
        else:
            entry.update({"interval_status": "NOT_ESTIMABLE_BOOTSTRAP_DEGENERACY", "ci95_percentile": [None, None]})
        coefficients.append(entry)
    scenario_effects = [{"scenario_id": SCENARIOS[0], "reference": True, "coefficient_vs_reference": 0.0}]
    scenario_effects.extend({"scenario_id": SCENARIOS[i], "reference": False, "coefficient_vs_reference": beta[i]}
                            for i in range(1, 14))
    return {"schema_version": 1, "status": "SECONDARY_ASSOCIATIONAL_PRETREATMENT_ONLY",
            "eligible_checkpoint_rows": len(rows),
            "unique_stream_clusters": len(set((r["scenario_id"], r["realisation"]) for r in rows)),
            "model_rank": rank, "design_columns": design.shape[1], "reference_scenario": SCENARIOS[0],
            "intercept": beta[0],
            "predictor_scaling": {p: {"mean": means[p], "sample_sd": sds[p]} for p in CONTINUOUS_PREDICTORS},
            "binary_support": {"class_deficiency_indicator_ones": int(sum(r["class_deficiency_indicator"] for r in rows)),
                               "rows": len(rows)},
            "predictor_coefficients": coefficients, "scenario_fixed_effects": scenario_effects,
            "bootstrap_resamples": B, "bootstrap_seed_uint64": 8085499736201925965,
            "interpretation": "Associational effect-modification model only; positive outcome/coefficient direction means larger replace-minus-sham loss contrast, hence greater observed advantage of retaining selected inherited material. No causal-mediation interpretation."}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require_runtime()
    root, out = args.input.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((root / "CAMPAIGN_MANIFEST.json").read_text(encoding="utf-8"))
    if manifest.get("status") != "COMPLETE_RAW_PRIMARY_CONF_CAMPAIGN" or manifest.get("records") != 4480 or manifest.get("raw_record_root_sha256") != RAW_RECORD_ROOT_SHA256:
        raise RuntimeError("F10 primary manifest mismatch")
    if sha256_file(root / "EXPANDED_F09_CONF_SCHEDULE.tsv") != SCHEDULE_SHA256:
        raise RuntimeError("F09 schedule SHA mismatch")
    streams, mechanism_rows, eligibility_rows = load_stream_estimators(root)
    h1, h2, a, q = matrix(streams, "H1"), matrix(streams, "H2"), matrix(streams, "A"), matrix(streams, "Q")
    primary: dict[str, dict[str, Any]] = {}; boot: dict[str, np.ndarray] = {}
    primary["H1"], boot["H1"] = bootstrap_t_mean(h1, PRIMARY_SEEDS["H1"])
    primary["H2"], boot["H2"] = bootstrap_t_mean(h2, PRIMARY_SEEDS["H2"])
    primary["H3"], boot["H3"] = bootstrap_t_ratio(a, q, PRIMARY_SEEDS["H3"])
    apply_holm(primary)
    write_json(out / "PRIMARY_INFERENCE.json", {"schema_version": 1, "phase": "F11_STATISTICS_AND_MECHANISM",
        "protocol_id": PROTOCOL_ID, "familywise_alpha": 0.05, "delta": 0.005, "bootstrap_resamples": B, "results": primary})
    with (out / "PRIMARY_BOOTSTRAP.tsv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, delimiter="\t", lineterminator="\n")
        writer.writerow(["hypothesis", "replicate", "estimate_star", "pivot_t_star"])
        for hypothesis in ("H1", "H2", "H3"):
            if boot[hypothesis] is None:
                continue
            for row in boot[hypothesis]:
                writer.writerow([hypothesis, int(row[0]), repr(float(row[1])), repr(float(row[2]))])
    write_stream_outputs(out, streams)

    secondary: dict[str, Any] = {}
    secondary["H1_500"] = percentile_mean(matrix(streams, "H1_500"), "SECONDARY-H1-500")
    secondary["H2_500"] = percentile_mean(matrix(streams, "H2_500"), "SECONDARY-H2-500")
    secondary["H3_500"] = percentile_ratio(matrix(streams, "A500"), matrix(streams, "Q500"), "SECONDARY-H3-500")
    secondary["H3_ITT_500"] = percentile_mean(matrix(streams, "H3_ITT_500"), "SECONDARY-H3-ITT-500")
    secondary["H3_ITT_2000"] = percentile_mean(matrix(streams, "H3_ITT"), "SECONDARY-H3-ITT-2000")
    secondary["H1_5000"] = percentile_mean(matrix(streams, "H1_5000", True), "SECONDARY-H1-5000")
    secondary["H2_5000"] = percentile_mean(matrix(streams, "H2_5000", True), "SECONDARY-H2-5000")
    secondary["H3_5000"] = percentile_ratio(matrix(streams, "A5000", True), matrix(streams, "Q5000", True), "SECONDARY-H3-5000")
    secondary["H3_ITT_5000"] = percentile_mean(matrix(streams, "H3_ITT_5000", True), "SECONDARY-H3-ITT-5000")
    for field, name in (("RR_PERSIST_2000", "SECONDARY-RANDOM-MINUS-PERSIST-2000"),
                        ("RR_RESTART_2000", "SECONDARY-RANDOM-MINUS-RESTART-2000"),
                        ("RR_PERSIST_5000", "SECONDARY-RANDOM-MINUS-PERSIST-5000"),
                        ("RR_RESTART_5000", "SECONDARY-RANDOM-MINUS-RESTART-5000")):
        secondary[field] = percentile_mean(matrix(streams, field, True), name)
    secondary["H1_BALANCED_2000"] = percentile_mean(matrix(streams, "H1_BE"), "SECONDARY-H1-BALANCED-2000")
    secondary["H2_BALANCED_2000"] = percentile_mean(matrix(streams, "H2_BE"), "SECONDARY-H2-BALANCED-2000")
    secondary["H3_BALANCED_2000"] = percentile_ratio(matrix(streams, "ABE"), matrix(streams, "QBE"), "SECONDARY-H3-BALANCED-2000")
    eligibility = defaultdict(lambda: {"eligible": 0, "total": 0})
    for scenario, _realisation, checkpoint, eligible in eligibility_rows:
        eligibility[(scenario, checkpoint)]["eligible"] += eligible
        eligibility[(scenario, checkpoint)]["total"] += 1
    total_eligible = sum(row[-1] for row in eligibility_rows)
    secondary["eligibility_overall"] = {"eligible_checkpoints": total_eligible, "total_checkpoints": len(eligibility_rows),
                                         "rate": total_eligible / len(eligibility_rows)}
    secondary["eligibility_by_scenario_checkpoint"] = [
        {"scenario_id": s, "checkpoint": c, **v, "rate": v["eligible"] / v["total"]}
        for (s, c), v in sorted(eligibility.items(), key=lambda item: (SCENARIOS.index(item[0][0]), item[0][1]))]
    write_json(out / "SECONDARY_SENSITIVITY.json", secondary)

    mechanism = mechanism_analysis(mechanism_rows)
    write_json(out / "MECHANISM_MODEL.json", mechanism)
    with (out / "MECHANISM_ROWS.tsv").open("w", encoding="utf-8", newline="") as fh:
        fields = ["scenario_id", "realisation", "source_key_hex", "checkpoint", "outcome", *PREDICTORS]
        writer = csv.DictWriter(fh, fieldnames=fields, delimiter="\t", lineterminator="\n")
        writer.writeheader(); writer.writerows(mechanism_rows)

    receipt = {"schema_version": 1, "phase": "F11_STATISTICS_AND_MECHANISM", "status": "COMPLETE_F11_ANALYSIS",
        "protocol_id": PROTOCOL_ID, "raw_primary_records": 4480, "eligible_mechanism_rows": len(mechanism_rows),
        "runtime": {"python": sys.version.split()[0], "numpy": np.__version__, "bit_generator": "PCG64"},
        "primary_results_sha256": sha256_file(out / "PRIMARY_INFERENCE.json"),
        "secondary_sha256": sha256_file(out / "SECONDARY_SENSITIVITY.json"),
        "mechanism_sha256": sha256_file(out / "MECHANISM_MODEL.json"),
        "stream_estimators_sha256": sha256_file(out / "STREAM_ESTIMATORS.tsv"),
        "primary_bootstrap_sha256": sha256_file(out / "PRIMARY_BOOTSTRAP.tsv"),
        "f12_started": False, "manuscript_modified": False}
    write_json(out / "F11_ANALYSIS_RECEIPT.json", receipt)
    print(json.dumps(as_python({"primary": primary, "receipt": receipt}), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
