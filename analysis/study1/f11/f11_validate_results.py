from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

SCENARIOS = (
    "LOCAL_TREE-STATIONARY-NONE", "LOCAL_TREE-ABRUPT-MILD", "LOCAL_TREE-ABRUPT-SEVERE",
    "LOCAL_TREE-GRADUAL-MILD", "LOCAL_TREE-GRADUAL-SEVERE", "LOCAL_TREE-RECURRENT-MILD",
    "LOCAL_TREE-RECURRENT-SEVERE", "OBLIQUE-STATIONARY-NONE", "OBLIQUE-ABRUPT-MILD",
    "OBLIQUE-ABRUPT-SEVERE", "OBLIQUE-GRADUAL-MILD", "OBLIQUE-GRADUAL-SEVERE",
    "OBLIQUE-RECURRENT-MILD", "OBLIQUE-RECURRENT-SEVERE",
)
PREDICTORS = (
    "connected_subtree_age_completed_updates", "node_count", "subtree_depth", "recent_window_reach_rate",
    "past_only_local_error", "past_only_balanced_error", "class_deficiency_indicator", "lineage_depth",
    "global_champion_literal_retention_fraction", "population_diversity",
)
CONTINUOUS = tuple(x for x in PREDICTORS if x != "class_deficiency_indicator")
G, N, B, DELTA = 14, 320, 9999, 0.005
CRITICAL_INDEX = 9834 - 1
TOL = 2e-12


def close(a: float, b: float, tol: float = TOL) -> None:
    if not (math.isfinite(a) and math.isfinite(b) and abs(a - b) <= tol * max(1.0, abs(a), abs(b))):
        raise RuntimeError(f"numeric mismatch: {a!r} != {b!r}")


def load_streams(path: Path) -> dict[tuple[str, int], dict[str, float]]:
    rows = list(csv.DictReader(path.read_text(encoding="utf-8").splitlines(), delimiter="\t"))
    if len(rows) != 4480:
        raise RuntimeError(f"expected 4480 stream estimators, found {len(rows)}")
    out = {}
    for row in rows:
        key = (row["scenario_id"], int(row["realisation"]))
        if key in out:
            raise RuntimeError(f"duplicate stream estimator {key}")
        out[key] = {k: float(row[k]) for k in ("H1", "H2", "A", "Q")}
    if set(out) != {(s, r) for s in SCENARIOS for r in range(N)}:
        raise RuntimeError("stream estimator support differs from frozen design")
    return out


def matrix(streams, field: str) -> np.ndarray:
    return np.asarray([[streams[(s, r)][field] for r in range(N)] for s in SCENARIOS], dtype=float)


def mean_se(values: np.ndarray) -> tuple[float, float]:
    theta = float(values.mean(axis=1).mean())
    se = float(math.sqrt(values.var(axis=1, ddof=1).sum() / (G * G * N)))
    return theta, se


def ratio_se(a: np.ndarray, q: np.ndarray) -> tuple[float, float, float]:
    abar = float(a.mean(axis=1).mean())
    qbar = float(q.mean(axis=1).mean())
    if qbar <= 0:
        raise RuntimeError("observed H3 denominator non-positive")
    theta = abar / qbar
    z = a - theta * q
    se = float(math.sqrt(z.var(axis=1, ddof=1).sum() / (G * G * N * qbar * qbar)))
    return theta, se, qbar


def classify(ci: list[float]) -> str:
    lo, hi = ci
    if lo > DELTA:
        return "BENEFICIAL"
    if hi < -DELTA:
        return "HARMFUL"
    if lo >= -DELTA and hi <= DELTA:
        return "EQUIVALENT"
    return "INCONCLUSIVE"


def holm(raw: dict[str, float]) -> tuple[dict[str, float], dict[str, bool]]:
    ordered = sorted(raw, key=raw.get)
    adj, reject = {}, {h: False for h in raw}
    running, stopped = 0.0, False
    m = len(ordered)
    for i, h in enumerate(ordered):
        running = max(running, (m - i) * raw[h])
        adj[h] = min(1.0, running)
        if not stopped and raw[h] <= 0.05 / (m - i):
            reject[h] = True
        else:
            stopped = True
    return adj, reject


def validate_primary(out: Path) -> None:
    streams = load_streams(out / "STREAM_ESTIMATORS.tsv")
    reported = json.loads((out / "PRIMARY_INFERENCE.json").read_text(encoding="utf-8"))["results"]
    expected = {}
    h1, h2, a, q = matrix(streams, "H1"), matrix(streams, "H2"), matrix(streams, "A"), matrix(streams, "Q")
    expected["H1"] = mean_se(h1)
    expected["H2"] = mean_se(h2)
    h3_theta, h3_se, h3_q = ratio_se(a, q)
    expected["H3"] = (h3_theta, h3_se)
    close(float(reported["H3"]["observed_denominator"]), h3_q)

    pivots: dict[str, list[float]] = defaultdict(list)
    with (out / "PRIMARY_BOOTSTRAP.tsv").open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            pivots[row["hypothesis"]].append(float(row["pivot_t_star"]))
    if {h: len(v) for h, v in pivots.items()} != {"H1": B, "H2": B, "H3": B}:
        raise RuntimeError("primary bootstrap cardinality mismatch")

    raw = {}
    for h in ("H1", "H2", "H3"):
        theta, se = expected[h]
        close(float(reported[h]["estimate"]), theta)
        close(float(reported[h]["se"]), se)
        tobs = theta / se
        close(float(reported[h]["t_observed"]), tobs)
        absolute = np.abs(np.asarray(pivots[h], dtype=float))
        critical = float(np.sort(absolute)[CRITICAL_INDEX])
        p = (1 + int(np.count_nonzero(absolute >= abs(tobs)))) / (B + 1)
        ci = [max(-1.0, theta - critical * se), min(1.0, theta + critical * se)]
        close(float(reported[h]["critical_abs_t"]), critical)
        close(float(reported[h]["p_unadjusted"]), p)
        close(float(reported[h]["ci"][0]), ci[0])
        close(float(reported[h]["ci"][1]), ci[1])
        if reported[h]["practical_classification"] != classify(ci):
            raise RuntimeError(f"practical classification mismatch for {h}")
        raw[h] = p
    adjusted, rejected = holm(raw)
    for h in raw:
        close(float(reported[h]["p_holm_adjusted"]), adjusted[h])
        if bool(reported[h]["holm_reject_fwer_0_05"]) != rejected[h]:
            raise RuntimeError(f"Holm decision mismatch for {h}")


def validate_mechanism(out: Path) -> None:
    rows = list(csv.DictReader((out / "MECHANISM_ROWS.tsv").read_text(encoding="utf-8").splitlines(), delimiter="\t"))
    model = json.loads((out / "MECHANISM_MODEL.json").read_text(encoding="utf-8"))
    if len(rows) != int(model["eligible_checkpoint_rows"]):
        raise RuntimeError("mechanism row count mismatch")
    means = {p: float(np.mean([float(r[p]) for r in rows])) for p in CONTINUOUS}
    sds = {p: float(np.std([float(r[p]) for r in rows], ddof=1)) for p in CONTINUOUS}
    xpred = np.asarray([[(float(r[p]) - means[p]) / sds[p] if p in CONTINUOUS else float(r[p]) for p in PREDICTORS] for r in rows])
    y = np.asarray([float(r["outcome"]) for r in rows])
    dummies = np.zeros((len(rows), 13))
    for i, row in enumerate(rows):
        idx = SCENARIOS.index(row["scenario_id"])
        if idx > 0:
            dummies[i, idx - 1] = 1.0
    design = np.column_stack([np.ones(len(rows)), dummies, xpred])
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    if int(model["model_rank"]) != int(np.linalg.matrix_rank(design)) or int(model["design_columns"]) != design.shape[1]:
        raise RuntimeError("mechanism design rank/width mismatch")
    close(float(model["intercept"]), float(beta[0]), 1e-10)
    coeff = {x["predictor"]: x for x in model["predictor_coefficients"]}
    for j, p in enumerate(PREDICTORS):
        close(float(coeff[p]["coefficient"]), float(beta[14 + j]), 1e-10)
    ones = sum(int(float(r["class_deficiency_indicator"])) for r in rows)
    if ones != int(model["binary_support"]["class_deficiency_indicator_ones"]):
        raise RuntimeError("class-deficiency support mismatch")
    if ones == 1 and coeff["class_deficiency_indicator"]["finite_bootstrap_coefficients"] == B:
        raise RuntimeError("rare binary predictor unexpectedly claims fully estimable bootstrap support")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    out = args.output.resolve()
    validate_primary(out)
    validate_mechanism(out)
    receipt = json.loads((out / "F11_ANALYSIS_RECEIPT.json").read_text(encoding="utf-8"))
    if receipt.get("f12_started") is not False or receipt.get("manuscript_modified") is not False:
        raise RuntimeError("F11 firewall violation in receipt")
    print(json.dumps({"status": "PASS_INDEPENDENT_F11_VALIDATION", "primary_hypotheses": 3,
                      "stream_estimators": 4480, "mechanism_rows": int(json.loads((out / "MECHANISM_MODEL.json").read_text())["eligible_checkpoint_rows"])},
                     sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
