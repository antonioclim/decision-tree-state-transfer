#!/usr/bin/env python3
"""Reproduce I07 Study 2 decision economics from the verified I06B return.

This script does not execute the learner, contact the network, modify the source
archive or perform monetary conversion. It verifies the I06B closeout binding,
extracts the 1,120 admitted raw records, reproduces the scoped resource panel
and generates descriptive, Pareto, hard-budget and shadow-price analyses.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import platform
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

VERSION = "DT-I07-DECISION-ECONOMICS-v1.0"
EXPECTED_RETURN_SHA256 = "fdfbcb09298419209e4b0a26ca561a1dd76df3fa390acdf0066499614cce6330"
EXPECTED_RETURN_BYTES = 143160111
EXPECTED_CLOSEOUT_SHA256 = "9a81a77127476719f431830b03d425e6546751eb08b5ffe926006bc980ec1800"
EXPECTED_CLOSEOUT_STATUS = "PASS_I06B_FINAL_ADVERSARIAL_SCIENTIFIC_AUDIT_AND_EXPLICIT_PHASE_CLOSEOUT"
EXPECTED_EVIDENCE_ROOT = "3f62e9316a394e433114eee6f18453dce565acf2efdc361e56680ac7d9b2e212"
EXPECTED_RESOURCE_SUMMARY_SHA256 = "e872d172e177a4861f0a8581a48a7528e4682d6edcab1f5da842fc676ad2f677"
EXPECTED_PRIMARY_INFERENCE_SHA256 = "ac9d5162be27fe877c5c98101d14a3c5cbd32439a0c3bb1c0c2d354042c868c0"
EXPECTED_RESOURCE_SEGMENT_NOTICE_SHA256 = None  # recorded dynamically in receipt
G = 14
N = 80
B = 9999
DELTA = 0.005
ARMS = ["CHAMPION-RESEED", "POPULATION-RESEED", "PERSIST"]
PAIRS = [
    ("CHAMPION-RESEED", "POPULATION-RESEED"),
    ("POPULATION-RESEED", "PERSIST"),
    ("CHAMPION-RESEED", "PERSIST"),
]
CANONICAL_METRICS = [
    "total_apw",
    "process_cpu_seconds",
    "elapsed_seconds",
    "prediction_ns_per_prediction",
    "state_snapshot_mib",
    "provenance_mib",
]
DIAGNOSTIC_METRICS = [
    "adaptation_apw_total",
    "construction_apw_total",
    "provenance_event_count",
    "peak_rss_mib",
]
ALL_SUMMARY_METRICS = ["mean_loss_2000", *CANONICAL_METRICS, *DIAGNOSTIC_METRICS]
METRIC_LABELS = {
    "mean_loss_2000": ("Mean prequential 0-1 loss", "probability", "lower"),
    "total_apw": ("Total deterministic work", "APW_v1", "lower"),
    "adaptation_apw_total": ("Adaptation deterministic work", "APW_v1", "lower"),
    "construction_apw_total": ("Treatment construction work", "APW_v1", "lower"),
    "process_cpu_seconds": ("Arm process CPU time", "seconds", "lower"),
    "elapsed_seconds": ("Arm elapsed time", "seconds", "lower"),
    "prediction_ns_per_prediction": ("Mean prediction time", "nanoseconds per prediction", "lower"),
    "peak_rss_mib": ("Reported shared-process lifetime peak RSS", "MiB", "context only"),
    "state_snapshot_mib": ("End-state snapshot size", "MiB", "lower"),
    "provenance_mib": ("Provenance event bytes", "MiB", "lower"),
    "provenance_event_count": ("Provenance event count", "events", "lower"),
}


def need(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def write_tsv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def equal_scenario_mean(values: pd.Series, scenarios: pd.Series) -> float:
    frame = pd.DataFrame({"v": values.to_numpy(), "s": scenarios.to_numpy()})
    scenario_values = []
    for scenario, group in frame.groupby("s", sort=False):
        vals = [float(v) for v in group["v"].tolist()]
        need(len(vals) == N, f"Scenario {scenario} does not contain 80 streams.")
        scenario_values.append(math.fsum(vals) / N)
    need(len(scenario_values) == G, "Equal-scenario mean requires all 14 scenarios.")
    return math.fsum(scenario_values) / G


def segment_for_index(index: int) -> str:
    if 0 <= index <= 167:
        return "R4"
    if 168 <= index <= 1018:
        return "R5"
    if 1019 <= index <= 1119:
        return "R6"
    raise RuntimeError(f"Unexpected schedule index: {index}")


def extract_records(return_archive: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, str]]:
    panel_rows: list[dict[str, Any]] = []
    parent_rows: list[dict[str, Any]] = []
    official_resource: dict[str, Any] | None = None
    official_primary: dict[str, Any] | None = None
    segment_notice: dict[str, Any] | None = None
    source_hashes: dict[str, str] = {}
    record_count = 0
    identities: set[tuple[str, int]] = set()

    with tarfile.open(return_archive, "r:gz") as tar:
        for member in tar:
            name = member.name
            if not member.isfile():
                continue
            if name in {
                "runtime/workspace/analysis/RESOURCE_SUMMARIES.json",
                "runtime/workspace/analysis/PRIMARY_INFERENCE.json",
                "runtime/RESOURCE_SEGMENT_NOTICE.json",
            }:
                data = tar.extractfile(member).read()
                source_hashes[name] = sha256_bytes(data)
                obj = json.loads(data)
                if name.endswith("RESOURCE_SUMMARIES.json"):
                    official_resource = obj
                elif name.endswith("PRIMARY_INFERENCE.json"):
                    official_primary = obj
                else:
                    segment_notice = obj
                continue
            if not (name.startswith("runtime/workspace/run/attempts/") and "/records/" in name and name.endswith(".json")):
                continue
            record = json.load(tar.extractfile(member))
            need(record["phase"] == "I06_NESTED_TRANSFER_STUDY", "Unexpected phase in raw record.")
            need(record["partition"] == "EXT", "Non-EXT record found.")
            need(record["protocol_id"] == "DT-I05-NST-v1.0", "Protocol mismatch.")
            need(record["integrity_status"] == "VALID_RAW_I06_EVIDENCE", "Invalid raw record status.")
            identity = record["identity"]
            scenario = identity["scenario_id"]
            realisation = identity["realisation"]
            index = identity["global_schedule_index"]
            key = (scenario, realisation)
            need(key not in identities, f"Duplicate stream identity: {key}")
            identities.add(key)
            need([x["checkpoint"] for x in record["checkpoints"]] == [10000, 20000], "Checkpoint pairing differs.")
            need(set(record["checkpoints"][0]["state"]) == set(ARMS), "Arm set differs.")
            segment = segment_for_index(index)

            for arm in ARMS:
                lists: dict[str, list[float]] = {
                    "mean_loss_2000": [],
                    "adaptation_apw_total": [],
                    "construction_apw_total": [],
                    "process_cpu_ns": [],
                    "elapsed_ns": [],
                    "prediction_time_ns_total": [],
                    "reported_process_lifetime_peak_rss_bytes": [],
                    "state_snapshot_bytes": [],
                    "provenance_event_bytes": [],
                    "provenance_event_count": [],
                }
                for checkpoint in record["checkpoints"]:
                    arm_record = checkpoint["state"][arm]
                    need(arm_record["status"] == "COMPLETE", "Non-complete arm found in admitted record.")
                    lists["mean_loss_2000"].append(float(arm_record["horizons"]["2000"]["mean_loss"]))
                    lists["adaptation_apw_total"].append(float(arm_record["resources"]["adaptation_apw_total"]))
                    lists["construction_apw_total"].append(float(arm_record["resources"]["construction_apw_total"]))
                    lists["process_cpu_ns"].append(float(arm_record["process_cpu_ns_total"]))
                    lists["elapsed_ns"].append(float(arm_record["elapsed_ns_total"]))
                    lists["prediction_time_ns_total"].append(float(arm_record["prediction_ns_total"]))
                    lists["reported_process_lifetime_peak_rss_bytes"].append(float(arm_record["resources"]["max_reported_peak_rss_bytes"]))
                    need(arm_record["end_state"]["state_available"] is True, "Missing end-state snapshot.")
                    lists["state_snapshot_bytes"].append(float(arm_record["end_state"]["snapshot_bytes"]))
                    lists["provenance_event_bytes"].append(float(arm_record["provenance"]["event_bytes"]))
                    lists["provenance_event_count"].append(float(arm_record["provenance"]["event_count"]))
                row: dict[str, Any] = {
                    "global_schedule_index": index,
                    "segment": segment,
                    "scenario_id": scenario,
                    "realisation": realisation,
                    "source_key_hex": identity["source_key_hex"],
                    "arm": arm,
                }
                for metric, values in lists.items():
                    need(len(values) == 2 and all(math.isfinite(v) and v >= 0 for v in values), f"Invalid metric {metric}.")
                    row[metric] = math.fsum(values) / 2.0
                row["total_apw"] = row["adaptation_apw_total"] + row["construction_apw_total"]
                row["process_cpu_ns_total"] = row.pop("process_cpu_ns")
                row["elapsed_ns_total"] = row.pop("elapsed_ns")
                row["process_cpu_seconds"] = row["process_cpu_ns_total"] / 1e9
                row["elapsed_seconds"] = row["elapsed_ns_total"] / 1e9
                row["prediction_ns_per_prediction"] = row["prediction_time_ns_total"] / 2000.0
                row["peak_rss_bytes"] = row.pop("reported_process_lifetime_peak_rss_bytes")
                row["peak_rss_mib"] = row["peak_rss_bytes"] / (1024.0 ** 2)
                row["state_snapshot_bytes"] = row["state_snapshot_bytes"]
                row["state_snapshot_mib"] = row["state_snapshot_bytes"] / (1024.0 ** 2)
                row["provenance_event_bytes"] = row["provenance_event_bytes"]
                row["provenance_mib"] = row["provenance_event_bytes"] / (1024.0 ** 2)
                panel_rows.append(row)

            parent = record["parent"]
            source = record["source"]
            execution = record["execution"]
            parent_rows.append({
                "global_schedule_index": index,
                "segment": segment,
                "scenario_id": scenario,
                "realisation": realisation,
                "source_key_hex": identity["source_key_hex"],
                "source_tape_bytes": source["feature_bytes"] + source["label_bytes"],
                "parent_initialisation_apw": parent["initialisation_apw"],
                "parent_adaptation_apw": parent["reports"]["adaptation_apw_total"],
                "parent_construction_apw": parent["reports"]["construction_apw_total"],
                "parent_update_cpu_seconds": parent["reports"]["update_process_cpu_ns"] / 1e9,
                "parent_update_elapsed_seconds": parent["reports"]["update_elapsed_ns"] / 1e9,
                "parent_peak_rss_mib": parent["reports"]["max_reported_peak_rss_bytes"] / (1024.0 ** 2),
                "parent_provenance_events": parent["provenance"]["events"],
                "record_process_cpu_seconds": execution["process_cpu_ns_total"] / 1e9,
                "record_elapsed_seconds": execution["elapsed_ns_total"] / 1e9,
            })
            record_count += 1

    need(record_count == G * N, f"Expected 1120 records, found {record_count}.")
    need(len(identities) == G * N, "Identity cardinality differs.")
    need(official_resource is not None and official_primary is not None and segment_notice is not None, "Required analysis files missing from return.")
    need(source_hashes["runtime/workspace/analysis/RESOURCE_SUMMARIES.json"] == EXPECTED_RESOURCE_SUMMARY_SHA256, "Resource summary hash differs.")
    need(source_hashes["runtime/workspace/analysis/PRIMARY_INFERENCE.json"] == EXPECTED_PRIMARY_INFERENCE_SHA256, "Primary inference hash differs.")
    panel = pd.DataFrame(panel_rows).sort_values(["global_schedule_index", "arm"]).reset_index(drop=True)
    parent_panel = pd.DataFrame(parent_rows).sort_values("global_schedule_index").reset_index(drop=True)
    need(len(panel) == G * N * len(ARMS), "Stream-arm panel cardinality differs.")
    counts = panel.drop_duplicates(["scenario_id", "realisation"]).groupby("scenario_id").size()
    need(len(counts) == G and counts.eq(N).all(), "Scenario allocation differs.")
    return panel, parent_panel, official_resource, official_primary, segment_notice, source_hashes


def validate_official_resource(panel: pd.DataFrame, official: dict[str, Any]) -> dict[str, Any]:
    mapping = {
        "adaptation_apw_total": "adaptation_apw_total",
        "construction_apw_total": "construction_apw_total",
        "arm_process_cpu_ns": "process_cpu_ns_total",
        "arm_elapsed_ns": "elapsed_ns_total",
        "prediction_time_ns_total": "prediction_time_ns_total",
        "reported_process_lifetime_peak_rss_bytes": "peak_rss_bytes",
        "state_snapshot_bytes": "state_snapshot_bytes",
        "provenance_event_bytes": "provenance_event_bytes",
        "provenance_event_count": "provenance_event_count",
    }
    max_abs = 0.0
    comparisons = 0
    for official_name, local_name in mapping.items():
        item = official["metrics"][official_name]
        for arm in ARMS:
            local = equal_scenario_mean(panel.loc[panel.arm == arm, local_name], panel.loc[panel.arm == arm, "scenario_id"])
            expected = item["arm_cluster_summaries"][arm]["equal_scenario_full_target_mean"]
            max_abs = max(max_abs, abs(local - expected))
            comparisons += 1
        if official_name != "reported_process_lifetime_peak_rss_bytes":
            for label, left, right in [
                ("J1_policy_resource_increment", ARMS[0], ARMS[1]),
                ("J2_policy_resource_increment", ARMS[1], ARMS[2]),
            ]:
                wide = panel.pivot(index=["scenario_id", "realisation"], columns="arm", values=local_name)
                local = equal_scenario_mean(wide[left] - wide[right], pd.Series(wide.index.get_level_values("scenario_id"), index=wide.index))
                expected = item["paired_stream_difference_summaries"][label]["equal_scenario_full_target_mean"]
                max_abs = max(max_abs, abs(local - expected))
                comparisons += 1
    need(max_abs <= 1e-6, f"Official resource reproduction differs: {max_abs}")
    return {"status": "PASS_OFFICIAL_RESOURCE_SUMMARY_REPRODUCTION", "comparisons": comparisons, "max_abs_difference": max_abs}


def arm_summaries(panel: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for arm in ARMS:
        sub = panel[panel.arm == arm]
        for metric in ALL_SUMMARY_METRICS:
            scenario_means = sub.groupby("scenario_id", sort=False)[metric].mean()
            rows.append({
                "arm": arm,
                "metric": metric,
                "label": METRIC_LABELS[metric][0],
                "unit": METRIC_LABELS[metric][1],
                "decision_orientation": METRIC_LABELS[metric][2],
                "streams": len(sub),
                "equal_scenario_mean": float(scenario_means.mean()),
                "median_stream": float(sub[metric].median()),
                "q05_stream": float(sub[metric].quantile(0.05)),
                "q25_stream": float(sub[metric].quantile(0.25)),
                "q75_stream": float(sub[metric].quantile(0.75)),
                "q95_stream": float(sub[metric].quantile(0.95)),
                "min_scenario_mean": float(scenario_means.min()),
                "max_scenario_mean": float(scenario_means.max()),
            })
    return pd.DataFrame(rows)


def scenario_summaries(panel: pd.DataFrame) -> pd.DataFrame:
    return panel.groupby(["scenario_id", "arm"], sort=False)[ALL_SUMMARY_METRICS].mean().reset_index()


def est_se(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    # x: scenario, stream, contrast
    scenario_means = x.mean(axis=1)
    estimate = scenario_means.mean(axis=0)
    within_variance = x.var(axis=1, ddof=1)
    se = np.sqrt((within_variance / N).sum(axis=0) / (G ** 2))
    return estimate, se


def resource_bootstrap(panel: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    scenarios = list(dict.fromkeys(panel.sort_values("global_schedule_index")["scenario_id"]))
    array = np.empty((G, N, len(ARMS), len(CANONICAL_METRICS)), dtype=float)
    for gi, scenario in enumerate(scenarios):
        for ri in range(N):
            sub = panel[(panel.scenario_id == scenario) & (panel.realisation == ri)].set_index("arm")
            need(len(sub) == len(ARMS), "Pairing failure in bootstrap panel.")
            for ai, arm in enumerate(ARMS):
                array[gi, ri, ai, :] = sub.loc[arm, CANONICAL_METRICS].to_numpy(float)
    contrasts: list[np.ndarray] = []
    labels: list[tuple[str, str, str]] = []
    for left, right in PAIRS:
        li, ri = ARMS.index(left), ARMS.index(right)
        for mi, metric in enumerate(CANONICAL_METRICS):
            contrasts.append(array[:, :, li, mi] - array[:, :, ri, mi])
            labels.append((left, right, metric))
    data = np.stack(contrasts, axis=-1)
    estimate, se = est_se(data)
    seed = int.from_bytes(hashlib.sha256(b"DT-I07-STUDY2-RESOURCE-SIMULTANEOUS-MAXT-v1").digest()[:8], "big")
    rng = np.random.default_rng(seed)
    replicates = np.empty((B, data.shape[-1]), dtype=float)
    tvalues = np.empty_like(replicates)
    for b in range(B):
        indices = rng.integers(0, N, size=(G, N))
        sampled = np.take_along_axis(data, indices[:, :, None], axis=1)
        e_b, se_b = est_se(sampled)
        replicates[b] = e_b
        tvalues[b] = np.divide(e_b - estimate, se_b, out=np.zeros_like(e_b), where=se_b > 0)
    critical = float(np.quantile(np.max(np.abs(tvalues), axis=1), 0.95, method="higher"))
    rows: list[dict[str, Any]] = []
    for i, (left, right, metric) in enumerate(labels):
        pct = np.quantile(replicates[:, i], [0.025, 0.975])
        lo = float(estimate[i] - critical * se[i])
        hi = float(estimate[i] + critical * se[i])
        if hi < 0:
            direction = "LEFT_LOWER"
        elif lo > 0:
            direction = "RIGHT_LOWER"
        else:
            direction = "UNRESOLVED"
        rows.append({
            "left": left,
            "right": right,
            "sign": "left_minus_right",
            "metric": metric,
            "unit": METRIC_LABELS[metric][1],
            "estimate": float(estimate[i]),
            "se": float(se[i]),
            "percentile_95_lo": float(pct[0]),
            "percentile_95_hi": float(pct[1]),
            "simultaneous_95_lo": lo,
            "simultaneous_95_hi": hi,
            "simultaneous_direction": direction,
            "simultaneous_family_size": len(labels),
            "critical_abs_t": critical,
            "B": B,
            "seed_uint64": seed,
            "scope": "exploratory_decision_economic_uncertainty_not_new_confirmatory_family",
        })
    meta = {
        "method": "paired equal-scenario within-scenario whole-stream bootstrap-t with max-|t| simultaneous intervals",
        "B": B,
        "seed_uint64": seed,
        "family_size": len(labels),
        "critical_abs_t": critical,
        "p_values_computed": False,
        "confirmatory_family_modified": False,
    }
    return pd.DataFrame(rows), meta


def primary_anchor(panel: pd.DataFrame, official_primary: dict[str, Any]) -> dict[str, Any]:
    means = {arm: equal_scenario_mean(panel.loc[panel.arm == arm, "mean_loss_2000"], panel.loc[panel.arm == arm, "scenario_id"]) for arm in ARMS}
    j1 = official_primary["primary"]["J1"]
    j2 = official_primary["primary"]["J2"]
    derived_ci = [j1["ci"][0] + j2["ci"][0], j1["ci"][1] + j2["ci"][1]]
    need(derived_ci[0] >= -DELTA and derived_ci[1] <= DELTA, "Derived conservative CHAMPION-PERSIST interval leaves equivalence margin.")
    return {
        "status": "PASS_ALL_THREE_PAIRWISE_LOSS_CONTRASTS_WITHIN_PRACTICAL_EQUIVALENCE_MARGIN",
        "delta": DELTA,
        "arm_equal_scenario_mean_loss": means,
        "J1_CHAMPION_minus_POPULATION": j1,
        "J2_POPULATION_minus_PERSIST": j2,
        "J_SUM_CHAMPION_minus_PERSIST": {
            "estimate": official_primary["j_sum_direct_point_estimate"],
            "conservative_interval_from_simultaneous_J1_plus_J2": derived_ci,
            "classification": "EQUIVALENT_DERIVED_NO_NEW_P_VALUE",
            "note": "Minkowski sum of the already simultaneous J1 and J2 intervals; not a third Holm-family test.",
        },
        "cancellation_diagnostic": official_primary["cancellation_diagnostic"],
    }


def pareto_results(arm_summary: pd.DataFrame, contrasts: pd.DataFrame, anchor: dict[str, Any]) -> dict[str, Any]:
    means = arm_summary.pivot(index="arm", columns="metric", values="equal_scenario_mean")
    def dominates(left: str, right: str, metrics: list[str]) -> bool:
        diff = means.loc[left, metrics] - means.loc[right, metrics]
        return bool((diff <= 0).all() and (diff < 0).any())
    pointwise_resource = []
    for left in ARMS:
        for right in ARMS:
            if left != right and dominates(left, right, CANONICAL_METRICS):
                pointwise_resource.append({"dominant": left, "dominated": right, "axes": CANONICAL_METRICS})
    five_axes = [m for m in CANONICAL_METRICS if m != "prediction_ns_per_prediction"]
    uncertainty_relations = []
    for left, right in PAIRS:
        sub = contrasts[(contrasts.left == left) & (contrasts.right == right)].set_index("metric")
        directions = {m: sub.loc[m, "simultaneous_direction"] for m in CANONICAL_METRICS}
        # RIGHT_LOWER means the right arm has lower burden on left-minus-right orientation.
        right_all_five = all(directions[m] == "RIGHT_LOWER" for m in five_axes)
        left_all_five = all(directions[m] == "LEFT_LOWER" for m in five_axes)
        right_all_six = all(directions[m] == "RIGHT_LOWER" for m in CANONICAL_METRICS)
        left_all_six = all(directions[m] == "LEFT_LOWER" for m in CANONICAL_METRICS)
        uncertainty_relations.append({
            "left": left,
            "right": right,
            "simultaneous_axis_directions": directions,
            "six_axis_dominance": right if right_all_six else (left if left_all_six else None),
            "five_non_latency_axis_dominance": right if right_all_five else (left if left_all_five else None),
        })
    return {
        "loss_orientation": "lower",
        "resource_orientation": "lower",
        "loss_equivalence_anchor": anchor["status"],
        "strict_full_vector_loss_plus_resources_nondominated_arms": ARMS,
        "pointwise_resource_only_dominance": pointwise_resource,
        "equivalence_aware_resource_dominance": pointwise_resource,
        "uncertainty_aware_relations": uncertainty_relations,
        "rss_excluded": True,
        "rss_reason": "Reported RSS is a shared-process lifetime high-water report and causal arm-specific comparison is not permitted.",
        "interpretation": "A dominance claim is valid only for the axes explicitly listed. Six-axis simultaneous dominance is not established when prediction-time uncertainty is unresolved.",
    }


def hard_budget(panel: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    quantiles = [0.50, 0.75, 0.90, 0.95]
    threshold_map: dict[str, dict[str, float]] = {}
    rows: list[dict[str, Any]] = []
    for q in quantiles:
        profile = f"POOLED_Q{int(q * 100)}"
        threshold_map[profile] = {m: float(panel[m].quantile(q)) for m in CANONICAL_METRICS}
        for metric in CANONICAL_METRICS:
            cap = threshold_map[profile][metric]
            for arm in ARMS:
                sub = panel[panel.arm == arm].copy()
                sub["feasible"] = sub[metric] <= cap
                scenario = sub.groupby("scenario_id")["feasible"].mean()
                rows.append({
                    "profile": profile,
                    "quantile": q,
                    "scope": "single_axis",
                    "metric": metric,
                    "arm": arm,
                    "cap": cap,
                    "unit": METRIC_LABELS[metric][1],
                    "equal_scenario_feasibility": float(scenario.mean()),
                    "min_scenario_feasibility": float(scenario.min()),
                    "max_scenario_feasibility": float(scenario.max()),
                    "feasible_streams": int(sub.feasible.sum()),
                    "total_streams": len(sub),
                })
        for scope, metrics in [
            ("joint_all_six", CANONICAL_METRICS),
            ("joint_five_non_latency", [m for m in CANONICAL_METRICS if m != "prediction_ns_per_prediction"]),
        ]:
            for arm in ARMS:
                sub = panel[panel.arm == arm].copy()
                feasible = np.ones(len(sub), dtype=bool)
                for metric in metrics:
                    feasible &= sub[metric].to_numpy() <= threshold_map[profile][metric]
                sub["feasible"] = feasible
                scenario = sub.groupby("scenario_id")["feasible"].mean()
                rows.append({
                    "profile": profile,
                    "quantile": q,
                    "scope": scope,
                    "metric": "ALL_CANONICAL_AXES" if scope == "joint_all_six" else "ALL_EXCEPT_PREDICTION",
                    "arm": arm,
                    "cap": None,
                    "unit": "vector budget",
                    "equal_scenario_feasibility": float(scenario.mean()),
                    "min_scenario_feasibility": float(scenario.min()),
                    "max_scenario_feasibility": float(scenario.max()),
                    "feasible_streams": int(sub.feasible.sum()),
                    "total_streams": len(sub),
                })
    meta = {
        "status": "DESCRIPTIVE_DATA_DERIVED_HARD_BUDGET_SENSITIVITY",
        "thresholds": threshold_map,
        "external_budget_claim": False,
        "note": "Pooled quantile profiles are transparent sensitivity thresholds, not claimed deployment budgets or monetary costs.",
    }
    return pd.DataFrame(rows), meta


def minimum_rates(panel: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for metric in CANONICAL_METRICS:
        for _, group in panel.groupby("global_schedule_index"):
            minimum = group[metric].min()
            winners = group[np.isclose(group[metric], minimum, rtol=0, atol=1e-12)]["arm"].tolist()
            for arm in ARMS:
                rows.append({
                    "metric": metric,
                    "arm": arm,
                    "win_credit": 1.0 / len(winners) if arm in winners else 0.0,
                    "strict_min": int(len(winners) == 1 and arm in winners),
                })
    return pd.DataFrame(rows).groupby(["metric", "arm"], as_index=False).agg(
        equal_share_win_rate=("win_credit", "mean"),
        strict_min_rate=("strict_min", "mean"),
    )


def shadow_boundaries(arm_summary: pd.DataFrame, anchor: dict[str, Any]) -> pd.DataFrame:
    means = arm_summary.pivot(index="arm", columns="metric", values="equal_scenario_mean")
    loss = anchor["arm_equal_scenario_mean_loss"]
    rows: list[dict[str, Any]] = []
    for left, right in PAIRS:
        loss_diff = loss[left] - loss[right]
        for metric in CANONICAL_METRICS:
            resource_diff = float(means.loc[left, metric] - means.loc[right, metric])
            threshold = None
            status = "NO_POSITIVE_SINGLE_AXIS_BREAK_EVEN"
            if resource_diff != 0:
                candidate = -loss_diff / resource_diff
                if candidate > 0:
                    threshold = candidate
                    status = "POSITIVE_SINGLE_AXIS_BREAK_EVEN"
            rows.append({
                "left": left,
                "right": right,
                "objective_difference": "J(left)-J(right)",
                "loss_difference": loss_diff,
                "metric": metric,
                "resource_difference_left_minus_right": resource_diff,
                "resource_unit": METRIC_LABELS[metric][1],
                "single_axis_shadow_price_threshold_loss_units_per_resource_unit": threshold,
                "status": status,
                "decision_rule": "left preferred when loss_difference + lambda*resource_difference < 0",
                "money_interpretation_permitted": False,
            })
    return pd.DataFrame(rows)


def parent_summary(parent_panel: pd.DataFrame) -> pd.DataFrame:
    metrics = [c for c in parent_panel.columns if c not in {"global_schedule_index", "segment", "scenario_id", "realisation", "source_key_hex"}]
    rows = []
    for metric in metrics:
        scenario = parent_panel.groupby("scenario_id")[metric].mean()
        rows.append({
            "metric": metric,
            "streams": len(parent_panel),
            "equal_scenario_mean": float(scenario.mean()),
            "median_stream": float(parent_panel[metric].median()),
            "q05_stream": float(parent_panel[metric].quantile(0.05)),
            "q95_stream": float(parent_panel[metric].quantile(0.95)),
            "decision_role": "shared pre-fork context; cancels from paired arm contrasts but contributes to total deployment burden",
        })
    return pd.DataFrame(rows)


def host_epoch_inventory(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    identities = panel.drop_duplicates("global_schedule_index")
    counts = identities.groupby(["scenario_id", "segment"]).size().unstack(fill_value=0).reset_index()
    segment_means = panel.groupby(["segment", "arm"], as_index=False)[["process_cpu_seconds", "elapsed_seconds", "prediction_ns_per_prediction", "peak_rss_mib"]].mean()
    return counts, segment_means


def claim_contract(anchor: dict[str, Any], pareto: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "phase": "I07_DECISION_ECONOMICS",
        "status": "PASS_I07_CLAIMS_CONTRACT",
        "permitted_claims": [
            "All three Study 2 policies are pairwise practically equivalent in primary loss under the prespecified ±0.005 margin, with CHAMPION-RESEED versus PERSIST supported only as a derived conservative interval and no new p-value.",
            "PERSIST has the lowest equal-scenario mean on total APW, process CPU, elapsed time, end-state snapshot bytes and provenance bytes; POPULATION-RESEED has the lowest mean prediction time.",
            "Under practical-equivalence tie-breaking, PERSIST pointwise dominates CHAMPION-RESEED on the six declared canonical resource axes.",
            "Using simultaneous exploratory resource intervals, PERSIST robustly dominates both alternatives on the five non-latency axes, while prediction-time direction remains unresolved for comparisons involving PERSIST.",
            "Hard-budget results are descriptive sensitivity maps under explicitly listed data-derived caps, not externally calibrated deployment budgets.",
        ],
        "prohibited_claims": [
            "monetary cost-effectiveness",
            "universal superiority of PERSIST",
            "universal irrelevance of diversity, history or genealogy",
            "arm-specific causal interpretation of shared-process peak RSS",
            "latency percentile claims from total prediction time",
            "all resource observations came from one uninterrupted host epoch",
            "new confirmatory p-values or modification of the J1/J2 family",
            "order-independent or Shapley component attribution",
        ],
        "required_qualifiers": [
            "name the resource axis and unit",
            "state that checkpoint values were averaged within stream and streams are the independent units",
            "state that the target is the equal mixture of fourteen prespecified scenarios",
            "separate deterministic APW from realised CPU, elapsed time and storage",
            "state that money is undefined without an audited external price map",
        ],
        "loss_anchor_status": anchor["status"],
        "pareto_axes": CANONICAL_METRICS,
        "rss_in_pareto": False,
    }


def markdown_reports(out: Path, arm: pd.DataFrame, contrasts: pd.DataFrame, anchor: dict[str, Any], pareto: dict[str, Any], budgets: pd.DataFrame, segment_counts: pd.DataFrame) -> None:
    (out / "00_READ_FIRST").mkdir(parents=True, exist_ok=True)
    (out / "03_RESULTS").mkdir(parents=True, exist_ok=True)
    means = arm.pivot(index="arm", columns="metric", values="equal_scenario_mean")
    joint = budgets[budgets.scope == "joint_all_six"].copy()
    table_rows = []
    for a in ARMS:
        table_rows.append(
            f"| {a} | {means.loc[a,'mean_loss_2000']:.9f} | {means.loc[a,'total_apw']:.3f} | {means.loc[a,'process_cpu_seconds']:.6f} | {means.loc[a,'elapsed_seconds']:.6f} | {means.loc[a,'prediction_ns_per_prediction']:.3f} | {means.loc[a,'state_snapshot_mib']:.6f} | {means.loc[a,'provenance_mib']:.6f} |"
        )
    budget_lines = []
    for profile in ["POOLED_Q50", "POOLED_Q75", "POOLED_Q90", "POOLED_Q95"]:
        sub = joint[joint.profile == profile].set_index("arm")
        budget_lines.append(f"| {profile} | {sub.loc['CHAMPION-RESEED','equal_scenario_feasibility']:.3f} | {sub.loc['POPULATION-RESEED','equal_scenario_feasibility']:.3f} | {sub.loc['PERSIST','equal_scenario_feasibility']:.3f} |")
    decision_ro = f"""# I07 — decision economics: închidere locală

## Verdict

**PASS — `PASS_I07_LOCAL_DECISION_ECONOMICS_COMPLETE_NO_REMOTE_WRITES`**

Analiza utilizează exclusiv returnarea I06B verificată, cele 1.120 de unităţi admise şi closeout-ul ştiinţific I06B. Nu a fost reexecutat learner-ul, nu a fost contactat cloud-ul şi nu s-a realizat nicio conversie monetară.

## Rezultatul decizional central

J1 şi J2 sunt practic echivalente la marja prestabilită ±0,005. Intervalul conservator derivat pentru CHAMPION-RESEED minus PERSIST, obţinut prin suma Minkowski a intervalelor simultane J1 şi J2, este [{anchor['J_SUM_CHAMPION_minus_PERSIST']['conservative_interval_from_simultaneous_J1_plus_J2'][0]:.9f}, {anchor['J_SUM_CHAMPION_minus_PERSIST']['conservative_interval_from_simultaneous_J1_plus_J2'][1]:.9f}] şi rămâne în interiorul marjei. Nu a fost creat un al treilea test şi nu a fost calculată o nouă valoare p.

În această frontieră de echivalenţă predictivă, PERSIST are cea mai mică medie pe cinci axe primare non-latenţă: APW total, CPU, timp elapsed, snapshot de stare şi bytes de provenienţă. POPULATION-RESEED are cea mai mică medie a timpului de predicţie. PERSIST domină punctual CHAMPION-RESEED pe toate cele şase axe canonice de resurse, însă dominanţa simultană pe toate cele şase nu este stabilită deoarece intervalul simultan al diferenţei de timp de predicţie include zero.

## Medii equal-scenario

| Policy | Loss | Total APW | CPU s | Elapsed s | Prediction ns/prediction | State MiB | Provenance MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
{chr(10).join(table_rows)}

## Sensibilitatea hard-budget

Pragurile Q50–Q95 sunt cuantile comune ale distribuţiei observate şi reprezintă numai profiluri de sensibilitate, nu bugete externe.

| Profil comun, toate cele 6 axe | CHAMPION | POPULATION | PERSIST |
|---|---:|---:|---:|
{chr(10).join(budget_lines)}

## Limite obligatorii

- APW nu este CPU, elapsed sau bani.
- RSS este high-water mark al procesului comun şi nu intră în dominanţa cauzală între braţe.
- Timpul de predicţie este un total împărţit la 2.000, nu o distribuţie de latenţă şi nu autorizează percentile de latenţă.
- R4, R5 şi R6 sunt epoci host distincte şi sunt confundate cu ordinea scenariilor; comparaţiile între epoci sunt descriptive.
- Concluzia este condiţională pe cele paisprezece scenarii, learner-ul, intervenţiile, orizontul şi contractul de resurse.

## Frontiera fazei

I07 este închis local. Următoarea fază este I08 — evidence/claim graph. Un `next` simplu autorizează numai integrarea locală a closeout-urilor Study 1, Study 2 şi I07 într-un graf trasabil de afirmaţii şi dovezi. Nu autorizează GitHub, Zenodo, publicare sau submission.
"""
    (out / "00_READ_FIRST" / "DECISION_RO.md").write_text(decision_ro, encoding="utf-8")

    methods_en = """# I07 methods text for later manuscript integration

Decision economics was evaluated after completion and independent audit of the 1,120-stream Study 2 campaign. The independent unit was the stream cluster. For every policy and resource coordinate, the two checkpoint-specific values were averaged within stream, then scenario-specific stream means were combined with equal weight across the fourteen prespecified scenarios. Deterministic accounted primitive work (APW) was kept distinct from realised process CPU time, elapsed time, prediction time, memory and storage quantities. Total APW was defined as adaptation APW plus treatment-construction APW; the two components were also retained separately as mechanism diagnostics.

The canonical decision vector comprised total APW, process CPU seconds, elapsed seconds, mean prediction nanoseconds per prediction, end-state snapshot MiB and provenance-event MiB, with lower values preferred. Reported peak RSS was excluded from pairwise dominance because it is a shared-process lifetime high-water report rather than an isolated arm-specific peak. Prediction time was treated as a total divided by the fixed 2,000-prediction horizon, not as a latency distribution.

Resource contrasts were paired within stream. Exploratory uncertainty was quantified by resampling whole streams within scenario, preserving policy pairing and equal scenario weighting. A single 9,999-replicate schedule was shared across the eighteen pair-by-resource contrasts and max-|t| intervals controlled simultaneous coverage across that declared family. No resource p-values were calculated and the confirmatory J1/J2 family was not modified. Hard-budget feasibility was reported under transparent pooled-quantile sensitivity profiles rather than externally calibrated or monetary budgets. Dimensioned shadow-price boundaries were reported algebraically; no resource coordinate was converted to money.
"""
    (out / "03_RESULTS" / "I07_METHODS_EN.md").write_text(methods_en, encoding="utf-8")

    results_en = f"""# I07 results text for later manuscript integration

The three policies were pairwise practically equivalent in primary loss under the prespecified ±0.005 margin. CHAMPION-RESEED minus POPULATION-RESEED was {anchor['J1_CHAMPION_minus_POPULATION']['estimate']:.9f} and POPULATION-RESEED minus PERSIST was {anchor['J2_POPULATION_minus_PERSIST']['estimate']:.9f}. The derived CHAMPION-RESEED minus PERSIST point estimate was {anchor['J_SUM_CHAMPION_minus_PERSIST']['estimate']:.9f}; the conservative interval formed by summing the simultaneous component intervals was [{anchor['J_SUM_CHAMPION_minus_PERSIST']['conservative_interval_from_simultaneous_J1_plus_J2'][0]:.9f}, {anchor['J_SUM_CHAMPION_minus_PERSIST']['conservative_interval_from_simultaneous_J1_plus_J2'][1]:.9f}], also wholly inside the practical-equivalence region.

Against PERSIST, CHAMPION-RESEED required an additional {means.loc['CHAMPION-RESEED','total_apw']-means.loc['PERSIST','total_apw']:.3f} APW, {means.loc['CHAMPION-RESEED','process_cpu_seconds']-means.loc['PERSIST','process_cpu_seconds']:.6f} process-CPU seconds, {means.loc['CHAMPION-RESEED','elapsed_seconds']-means.loc['PERSIST','elapsed_seconds']:.6f} elapsed seconds, {means.loc['CHAMPION-RESEED','state_snapshot_mib']-means.loc['PERSIST','state_snapshot_mib']:.6f} MiB of end-state snapshot and {means.loc['CHAMPION-RESEED','provenance_mib']-means.loc['PERSIST','provenance_mib']:.6f} MiB of provenance events per stream cluster. POPULATION-RESEED likewise exceeded PERSIST by {means.loc['POPULATION-RESEED','total_apw']-means.loc['PERSIST','total_apw']:.3f} APW, {means.loc['POPULATION-RESEED','process_cpu_seconds']-means.loc['PERSIST','process_cpu_seconds']:.6f} CPU seconds, {means.loc['POPULATION-RESEED','elapsed_seconds']-means.loc['PERSIST','elapsed_seconds']:.6f} elapsed seconds, {means.loc['POPULATION-RESEED','state_snapshot_mib']-means.loc['PERSIST','state_snapshot_mib']:.6f} state MiB and {means.loc['POPULATION-RESEED','provenance_mib']-means.loc['PERSIST','provenance_mib']:.6f} provenance MiB. POPULATION-RESEED had the lowest mean prediction time, improving on PERSIST by {means.loc['PERSIST','prediction_ns_per_prediction']-means.loc['POPULATION-RESEED','prediction_ns_per_prediction']:.3f} ns per prediction.

Accordingly, PERSIST pointwise dominated CHAMPION-RESEED on the six declared resource coordinates once the prespecified loss-equivalence rule was applied. Simultaneous resource intervals established PERSIST's lower burden relative to both alternatives on total APW, process CPU, elapsed time, state size and provenance bytes. Prediction-time contrasts involving PERSIST remained unresolved in the simultaneous family, so six-axis uncertainty-aware dominance was not claimed. Data-derived hard-budget profiles favoured PERSIST under the Q75, Q90 and Q95 joint six-axis caps, while the stricter Q50 profile did not yield a universal ordering. These profiles are sensitivity analyses and not deployment-specific budgets.
"""
    (out / "03_RESULTS" / "I07_RESULTS_EN.md").write_text(results_en, encoding="utf-8")

    limitations_en = """# I07 limitations text for later manuscript integration

The resource results are conditional on the implemented learner, fixed two-checkpoint design, 2,000-prediction primary horizon and equal mixture of fourteen synthetic scenarios. R4, R5 and R6 constitute distinct host epochs and their index ranges are confounded with scenario order; host-epoch means are therefore descriptive and must not be interpreted as platform effects. Within-stream policy contrasts remain paired, but realised CPU and elapsed time are implementation-specific rather than deterministic work measures. Reported peak RSS is a shared-process lifetime high-water report and cannot support causal arm-specific comparisons. Prediction time is an accumulated total rather than a latency distribution, so no percentile-latency claim is warranted. The hard-budget profiles are based on pooled empirical quantiles, not externally elicited service-level constraints. Shadow prices are dimensioned loss-equivalent coefficients, not money. No conclusion generalises automatically to different learners, drift systems, resource contracts or deployment platforms.
"""
    (out / "03_RESULTS" / "I07_LIMITATIONS_EN.md").write_text(limitations_en, encoding="utf-8")


def make_claim_ledger(anchor: dict[str, Any], arm_summary: pd.DataFrame, contrasts: pd.DataFrame) -> list[dict[str, Any]]:
    return [
        {
            "claim_id": "I07-C01",
            "claim": "All three Study 2 policies are pairwise practically equivalent in primary loss at delta=0.005.",
            "classification": "confirmatory plus derived algebraic consequence",
            "evidence": "I06B closeout J1/J2 simultaneous intervals; derived Minkowski-sum interval for CHAMPION-PERSIST",
            "prohibited_extension": "universal irrelevance of state components",
        },
        {
            "claim_id": "I07-C02",
            "claim": "PERSIST has the lowest equal-scenario mean on total APW, CPU, elapsed time, state bytes and provenance bytes.",
            "classification": "descriptive decision economics",
            "evidence": "I07_ARM_LEVEL_RESOURCE_SUMMARIES.csv",
            "prohibited_extension": "universal policy recommendation",
        },
        {
            "claim_id": "I07-C03",
            "claim": "POPULATION-RESEED has the lowest mean prediction time.",
            "classification": "descriptive decision economics",
            "evidence": "I07_ARM_LEVEL_RESOURCE_SUMMARIES.csv",
            "prohibited_extension": "latency percentile or service-level guarantee",
        },
        {
            "claim_id": "I07-C04",
            "claim": "PERSIST pointwise dominates CHAMPION-RESEED on the six canonical resource coordinates after applying the fixed loss-equivalence rule.",
            "classification": "equivalence-aware pointwise Pareto",
            "evidence": "I07_PARETO_RESULTS.json",
            "prohibited_extension": "six-axis uncertainty-aware dominance",
        },
        {
            "claim_id": "I07-C05",
            "claim": "PERSIST robustly has lower burden than both alternatives on the five non-latency resource axes in the simultaneous exploratory family.",
            "classification": "exploratory uncertainty-aware Pareto",
            "evidence": "I07_PAIRED_RESOURCE_CONTRASTS.csv",
            "prohibited_extension": "new confirmatory family or p-value claim",
        },
        {
            "claim_id": "I07-C06",
            "claim": "Pooled-quantile hard-budget profiles are sensitivity maps only.",
            "classification": "descriptive sensitivity",
            "evidence": "I07_HARD_BUDGET_FEASIBILITY.csv and I07_HARD_BUDGET_THRESHOLDS.json",
            "prohibited_extension": "externally calibrated or monetary budget claim",
        },
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--return-archive", type=Path, required=True)
    parser.add_argument("--i06-closeout", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    out = args.output
    out.mkdir(parents=True, exist_ok=False)

    need(args.return_archive.stat().st_size == EXPECTED_RETURN_BYTES, "Return archive byte size differs.")
    need(sha256_file(args.return_archive) == EXPECTED_RETURN_SHA256, "Return archive SHA-256 differs.")
    need(sha256_file(args.i06_closeout) == EXPECTED_CLOSEOUT_SHA256, "I06 closeout SHA-256 differs.")
    closeout = json.loads(args.i06_closeout.read_text(encoding="utf-8"))
    need(closeout["status"] == EXPECTED_CLOSEOUT_STATUS and closeout["scientific_phase_complete"] is True, "I06 closeout is not terminal.")
    need(closeout["raw_evidence"]["evidence_root_sha256"] == EXPECTED_EVIDENCE_ROOT, "Evidence root differs.")
    need(closeout["resource_summary_audit"]["I07_decision_economics_performed"] is False, "I07 already marked as performed in source closeout.")

    panel, parent_panel, official_resource, official_primary, segment_notice, source_hashes = extract_records(args.return_archive)
    reproduction = validate_official_resource(panel, official_resource)
    anchor = primary_anchor(panel, official_primary)
    arm = arm_summaries(panel)
    scenario = scenario_summaries(panel)
    contrasts, bootstrap_meta = resource_bootstrap(panel)
    pareto = pareto_results(arm, contrasts, anchor)
    budgets, budget_meta = hard_budget(panel)
    minimum = minimum_rates(panel)
    shadow = shadow_boundaries(arm, anchor)
    parent = parent_summary(parent_panel)
    segment_counts, segment_means = host_epoch_inventory(panel)
    claims = claim_contract(anchor, pareto)

    data_dir = out / "02_DATA"
    data_dir.mkdir(parents=True)
    panel.to_csv(data_dir / "I07_STREAM_ARM_RESOURCE_PANEL.csv", index=False)
    parent_panel.to_csv(data_dir / "I07_SHARED_PARENT_OVERHEAD_PANEL.csv", index=False)
    arm.to_csv(data_dir / "I07_ARM_LEVEL_RESOURCE_SUMMARIES.csv", index=False)
    scenario.to_csv(data_dir / "I07_SCENARIO_LEVEL_RESOURCE_SUMMARIES.csv", index=False)
    contrasts.to_csv(data_dir / "I07_PAIRED_RESOURCE_CONTRASTS.csv", index=False)
    budgets.to_csv(data_dir / "I07_HARD_BUDGET_FEASIBILITY.csv", index=False)
    minimum.to_csv(data_dir / "I07_PER_STREAM_RESOURCE_MINIMUM_RATES.csv", index=False)
    shadow.to_csv(data_dir / "I07_SHADOW_PRICE_BOUNDARIES.csv", index=False)
    parent.to_csv(data_dir / "I07_SHARED_PARENT_OVERHEAD_SUMMARY.csv", index=False)
    segment_counts.to_csv(data_dir / "I07_HOST_EPOCH_SCENARIO_COUNTS.csv", index=False)
    segment_means.to_csv(data_dir / "I07_HOST_EPOCH_DESCRIPTIVE_MEANS.csv", index=False)
    write_json(data_dir / "I07_HARD_BUDGET_THRESHOLDS.json", budget_meta)
    write_json(data_dir / "I07_PRIMARY_PREDICTIVE_ANCHOR.json", anchor)
    write_json(data_dir / "I07_PARETO_RESULTS.json", pareto)

    contract_dir = out / "01_CONTRACT"
    contract_dir.mkdir(parents=True)
    write_json(contract_dir / "I07_CLAIMS_CONTRACT.json", claims)
    resource_type = {
        "schema_version": 1,
        "phase": "I07_DECISION_ECONOMICS",
        "canonical_resource_vector": CANONICAL_METRICS,
        "mechanism_diagnostics": ["adaptation_apw_total", "construction_apw_total", "provenance_event_count"],
        "context_only": ["peak_rss_mib"],
        "rules": [
            "Different physical or protocol dimensions are not added without an explicit dimensioned coefficient.",
            "APW is not CPU, elapsed time or money.",
            "Peak RSS is excluded from causal arm-specific Pareto comparisons.",
            "Prediction time is a fixed-horizon total converted to a mean per prediction, not a latency distribution.",
            "Monetary conversion is forbidden without an audited external price map.",
        ],
    }
    write_json(contract_dir / "I07_RESOURCE_TYPE_AND_FIREWALL.json", resource_type)
    contract_md = """# I07 decision-economics analysis contract

## Perspective

The decision maker is an implementer selecting one of the three internal state-transfer policies under the locked Study 2 learner, source, horizon and equal-scenario target mixture. The analysis is not a societal, financial or cloud-billing evaluation.

## Decision unit and aggregation

The independent unit is the stream cluster. Two checkpoint values are averaged within stream. Scenario-specific stream means receive equal weight across fourteen scenarios. All three policies remain paired on the same stream and checkpoint records.

## Outcome and resources

Lower primary loss is preferred. The fixed practical-equivalence margin is ±0.005. The canonical lower-is-better resource vector is total APW, process CPU seconds, elapsed seconds, mean prediction nanoseconds per prediction, end-state snapshot MiB and provenance-event MiB. Total APW is adaptation plus treatment-construction APW; both components are retained separately as diagnostics. Peak RSS is context only.

## Decision analyses

1. exact pointwise Pareto relations;
2. practical-equivalence-aware Pareto relations;
3. exploratory simultaneous uncertainty across eighteen paired resource contrasts;
4. transparent data-derived hard-budget sensitivity;
5. dimensioned shadow-price decision boundaries;
6. host-epoch inventory without causal epoch comparison.

## Firewalls

No new confirmatory p-values are computed. J1/J2 are not modified. No money is inferred. No latency percentile is invented. No RSS causal contrast is made. No host-epoch effect is estimated. No universal policy recommendation is authorised.
"""
    (contract_dir / "I07_DECISION_ECONOMICS_CONTRACT.md").write_text(contract_md, encoding="utf-8")

    results_dir = out / "03_RESULTS"
    results_dir.mkdir(parents=True)
    markdown_reports(out, arm, contrasts, anchor, pareto, budgets, segment_counts)
    ledger = make_claim_ledger(anchor, arm, contrasts)
    write_tsv(results_dir / "I07_CLAIM_LEDGER.tsv", ledger)
    table_rows = []
    means = arm.pivot(index="arm", columns="metric", values="equal_scenario_mean")
    for a in ARMS:
        table_rows.append({
            "policy": a,
            "mean_loss_2000": means.loc[a, "mean_loss_2000"],
            "total_apw": means.loc[a, "total_apw"],
            "process_cpu_seconds": means.loc[a, "process_cpu_seconds"],
            "elapsed_seconds": means.loc[a, "elapsed_seconds"],
            "prediction_ns_per_prediction": means.loc[a, "prediction_ns_per_prediction"],
            "state_snapshot_mib": means.loc[a, "state_snapshot_mib"],
            "provenance_mib": means.loc[a, "provenance_mib"],
            "peak_rss_mib_context_only": means.loc[a, "peak_rss_mib"],
        })
    write_tsv(results_dir / "I07_TABLE_INTERNAL_DECISION_ECONOMICS.tsv", table_rows)
    figure_spec = """# I07 figure-data specification for I11

A future I11 panel may plot mean primary loss against any one declared resource axis, with policy labels and the ±0.005 practical-equivalence annotation. The plot must not place heterogeneous resource dimensions on a single additive scale. A separate hard-budget panel may show the joint six-axis feasibility proportions for Q50, Q75, Q90 and Q95 sensitivity profiles. Peak RSS must be labelled context only and must not enter an arm-specific Pareto frontier.
"""
    (results_dir / "I07_FIGURE_SPEC_FOR_I11.md").write_text(figure_spec, encoding="utf-8")

    code_dir = out / "04_CODE"
    code_dir.mkdir(parents=True)
    script_source = Path(__file__).read_text(encoding="utf-8")
    (code_dir / "reproduce_i07.py").write_text(script_source, encoding="utf-8")

    audit_dir = out / "05_AUDIT"
    audit_dir.mkdir(parents=True)
    source_bindings = {
        "return_archive": {"sha256": EXPECTED_RETURN_SHA256, "bytes": EXPECTED_RETURN_BYTES},
        "i06_closeout": {"sha256": EXPECTED_CLOSEOUT_SHA256, "status": EXPECTED_CLOSEOUT_STATUS},
        "evidence_root_sha256": EXPECTED_EVIDENCE_ROOT,
        "source_analysis_files": source_hashes,
        "protocol_sha256": closeout["bindings"]["protocol_sha256"],
        "schedule_sha256": closeout["bindings"]["schedule_sha256"],
        "analysis_preoutcome_binding_sha256": closeout["bindings"]["analysis_preoutcome_binding_sha256"],
        "source_tree": closeout["bindings"]["source_tree"],
    }
    write_json(audit_dir / "I07_SOURCE_BINDINGS.json", source_bindings)
    receipt = {
        "schema_version": 1,
        "version": VERSION,
        "status": "PASS_I07_LOCAL_DECISION_ECONOMICS_COMPLETE_NO_REMOTE_WRITES",
        "scientific_phase_complete": True,
        "generated_at_utc": pd.Timestamp.utcnow().isoformat(),
        "runtime": {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "platform": platform.platform()},
        "input": source_bindings,
        "coverage": {"independent_streams": 1120, "scenario_count": 14, "streams_per_scenario": 80, "arms": ARMS, "checkpoints_averaged_within_stream": 2},
        "resource_reproduction": reproduction,
        "bootstrap": bootstrap_meta,
        "primary_anchor": anchor,
        "pareto": pareto,
        "hard_budget": budget_meta,
        "host_epoch_notice": segment_notice,
        "firewalls": {
            "learner_reexecuted": False,
            "network_accessed": False,
            "cloud_accessed": False,
            "github_written": False,
            "zenodo_written": False,
            "money_conversion": False,
            "new_confirmatory_p_values": False,
            "rss_causal_pairwise_comparison": False,
        },
        "next_phase": "I08_EVIDENCE_CLAIM_GRAPH",
    }
    write_json(audit_dir / "I07_REPRODUCTION_RECEIPT.json", receipt)

    file_map = """# I07 file map

- `00_READ_FIRST/DECISION_RO.md`: Romanian phase verdict and decision summary.
- `01_CONTRACT/`: analysis perspective, typed-resource rules and claims firewall.
- `02_DATA/`: complete stream-arm panel and all derived tables.
- `03_RESULTS/`: manuscript-facing British English methods, results and limitations plus claim ledger.
- `04_CODE/reproduce_i07.py`: deterministic local reproducer.
- `05_AUDIT/`: source bindings and reproduction receipt.
"""
    (out / "00_READ_FIRST" / "FILE_MAP.md").write_text(file_map, encoding="utf-8")
    boundary = """# I07 phase boundary

I07 is complete locally. A plain `next` authorises only I08 local construction of the evidence/claim graph from the immutable Study 1 authorities, I06B closeout and this I07 package. It does not authorise GitHub writes, Zenodo, cloud execution, publication or submission.
"""
    (out / "00_READ_FIRST" / "PHASE_BOUNDARY.md").write_text(boundary, encoding="utf-8")

    print(json.dumps({"status": receipt["status"], "output": str(out), "streams": 1120, "resource_max_abs_difference": reproduction["max_abs_difference"]}, sort_keys=True))


if __name__ == "__main__":
    main()
