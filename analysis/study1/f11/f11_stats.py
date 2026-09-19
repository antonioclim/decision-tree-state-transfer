from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

import numpy as np

PROTOCOL_ID = "DT-C8E1-F09-v1.0"
SCHEDULE_SHA256 = "cb005bc52ca98255c834ccd04eabb14c6ece3ecf96a4e68e7a83f346485b3c93"
RAW_RECORD_ROOT_SHA256 = "35f67440cf96cde5bf72dd767aba7a61339b1f375cfdcc04f2e271d38f9387f5"
B = 9999
G = 14
N = 320
DELTA = 0.005
CRITICAL_ONE_BASED = 9834
PERCENTILE_LOWER_ONE_BASED = 250
PERCENTILE_UPPER_ONE_BASED = 9750
SCENARIOS = (
    "LOCAL_TREE-STATIONARY-NONE", "LOCAL_TREE-ABRUPT-MILD", "LOCAL_TREE-ABRUPT-SEVERE",
    "LOCAL_TREE-GRADUAL-MILD", "LOCAL_TREE-GRADUAL-SEVERE", "LOCAL_TREE-RECURRENT-MILD",
    "LOCAL_TREE-RECURRENT-SEVERE", "OBLIQUE-STATIONARY-NONE", "OBLIQUE-ABRUPT-MILD",
    "OBLIQUE-ABRUPT-SEVERE", "OBLIQUE-GRADUAL-MILD", "OBLIQUE-GRADUAL-SEVERE",
    "OBLIQUE-RECURRENT-MILD", "OBLIQUE-RECURRENT-SEVERE",
)
PRIMARY_SEEDS = {
    "H1": 1353558527596327882,
    "H2": 11095830246438979893,
    "H3": 14964784543515708419,
}
PREDICTORS = (
    "connected_subtree_age_completed_updates", "node_count", "subtree_depth", "recent_window_reach_rate",
    "past_only_local_error", "past_only_balanced_error", "class_deficiency_indicator", "lineage_depth",
    "global_champion_literal_retention_fraction", "population_diversity",
)
CONTINUOUS_PREDICTORS = tuple(x for x in PREDICTORS if x != "class_deficiency_indicator")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def analysis_seed(name: str) -> int:
    address = f"DT-C8E1-F09-v1|CONF|ANALYSIS|{name}|B=9999"
    return int(hashlib.sha256(address.encode("utf-8")).hexdigest()[:16], 16)


def as_python(value: Any) -> Any:
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.ndarray):
        return [as_python(v) for v in value.tolist()]
    if isinstance(value, dict):
        return {k: as_python(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [as_python(v) for v in value]
    return value


def equal_scenario_mean_se(values: np.ndarray) -> float:
    return math.sqrt(np.var(values, axis=1, ddof=1).sum() / (G * G * values.shape[1]))


def equal_scenario_ratio_se(a: np.ndarray, q: np.ndarray, theta: float | None = None) -> float:
    n = a.shape[1]
    abar = a.mean(axis=1).mean()
    qbar = q.mean(axis=1).mean()
    if qbar <= 0:
        return math.nan
    if theta is None:
        theta = abar / qbar
    z = a - theta * q
    return math.sqrt(np.var(z, axis=1, ddof=1).sum() / (G * G * n * qbar * qbar))


def bootstrap_t_mean(values: np.ndarray, seed: int) -> tuple[dict[str, Any], np.ndarray | None]:
    n = values.shape[1]
    theta = values.mean(axis=1).mean()
    se = equal_scenario_mean_se(values)
    if not np.isfinite(se) or se <= 0:
        return ({"estimate": theta, "se": se, "t_observed": None, "p_unadjusted": 1.0,
                 "critical_abs_t": math.inf, "ci": [-1.0, 1.0], "degenerate_resamples": B}, None)
    t_observed = theta / se
    rng = np.random.Generator(np.random.PCG64(seed))
    pivots, estimates = [], []
    for start in range(0, B, 250):
        batch = min(250, B - start)
        indices = rng.integers(0, n, size=(batch, G, n))
        sample = values[np.arange(G)[None, :, None], indices]
        theta_star = sample.mean(axis=2).mean(axis=1)
        se_star = np.sqrt(sample.var(axis=2, ddof=1).sum(axis=1) / (G * G * n))
        pivot = np.full(batch, np.inf)
        good = np.isfinite(se_star) & (se_star > 0)
        pivot[good] = (theta_star[good] - theta) / se_star[good]
        pivots.append(pivot)
        estimates.append(theta_star)
    pivots = np.concatenate(pivots)
    estimates = np.concatenate(estimates)
    absolute = np.abs(pivots)
    critical = np.sort(absolute)[CRITICAL_ONE_BASED - 1]
    p_value = (1 + np.count_nonzero(absolute >= abs(t_observed))) / (B + 1)
    interval = [max(-1.0, theta - critical * se), min(1.0, theta + critical * se)]
    result = {"estimate": theta, "se": se, "t_observed": t_observed, "p_unadjusted": p_value,
              "critical_abs_t": critical, "ci": interval,
              "degenerate_resamples": int(np.isinf(absolute).sum())}
    return result, np.column_stack([np.arange(1, B + 1), estimates, pivots])


def bootstrap_t_ratio(a: np.ndarray, q: np.ndarray, seed: int) -> tuple[dict[str, Any], np.ndarray | None]:
    n = a.shape[1]
    abar = a.mean(axis=1).mean()
    qbar = q.mean(axis=1).mean()
    if qbar <= 0:
        return ({"estimate": None, "observed_denominator": qbar, "se": None, "t_observed": None,
                 "p_unadjusted": 1.0, "critical_abs_t": math.inf, "ci": [-1.0, 1.0],
                 "degenerate_resamples": B}, None)
    theta = abar / qbar
    se = equal_scenario_ratio_se(a, q, theta)
    if not np.isfinite(se) or se <= 0:
        return ({"estimate": theta, "observed_denominator": qbar, "se": se, "t_observed": None,
                 "p_unadjusted": 1.0, "critical_abs_t": math.inf, "ci": [-1.0, 1.0],
                 "degenerate_resamples": B}, None)
    t_observed = theta / se
    rng = np.random.Generator(np.random.PCG64(seed))
    pivots, estimates = [], []
    for start in range(0, B, 250):
        batch = min(250, B - start)
        indices = rng.integers(0, n, size=(batch, G, n))
        sa = a[np.arange(G)[None, :, None], indices]
        sq = q[np.arange(G)[None, :, None], indices]
        aa = sa.mean(axis=2).mean(axis=1)
        qq = sq.mean(axis=2).mean(axis=1)
        theta_star = np.divide(aa, qq, out=np.full(batch, np.nan), where=qq > 0)
        pivot = np.full(batch, np.inf)
        valid = np.flatnonzero(qq > 0)
        if len(valid):
            z = sa[valid] - theta_star[valid, None, None] * sq[valid]
            se_star = np.sqrt(z.var(axis=2, ddof=1).sum(axis=1) / (G * G * n * qq[valid] ** 2))
            good = np.isfinite(se_star) & (se_star > 0)
            positions = valid[good]
            pivot[positions] = (theta_star[positions] - theta) / se_star[good]
        pivots.append(pivot)
        estimates.append(theta_star)
    pivots = np.concatenate(pivots)
    estimates = np.concatenate(estimates)
    absolute = np.abs(pivots)
    critical = np.sort(absolute)[CRITICAL_ONE_BASED - 1]
    p_value = (1 + np.count_nonzero(absolute >= abs(t_observed))) / (B + 1)
    interval = [max(-1.0, theta - critical * se), min(1.0, theta + critical * se)]
    result = {"estimate": theta, "observed_denominator": qbar, "se": se, "t_observed": t_observed,
              "p_unadjusted": p_value, "critical_abs_t": critical, "ci": interval,
              "degenerate_resamples": int(np.isinf(absolute).sum())}
    return result, np.column_stack([np.arange(1, B + 1), estimates, pivots])


def percentile_mean(values: np.ndarray, name: str) -> dict[str, Any]:
    n = values.shape[1]
    theta = values.mean(axis=1).mean()
    seed = analysis_seed(name)
    rng = np.random.Generator(np.random.PCG64(seed))
    resampled = []
    for start in range(0, B, 500):
        batch = min(500, B - start)
        indices = rng.integers(0, n, size=(batch, G, n))
        resampled.append(values[np.arange(G)[None, :, None], indices].mean(axis=2).mean(axis=1))
    ordered = np.sort(np.concatenate(resampled))
    return {"estimate": theta,
            "ci95_percentile": [ordered[PERCENTILE_LOWER_ONE_BASED - 1], ordered[PERCENTILE_UPPER_ONE_BASED - 1]],
            "seed_uint64": seed}


def percentile_ratio(a: np.ndarray, q: np.ndarray, name: str) -> dict[str, Any]:
    n = a.shape[1]
    abar = a.mean(axis=1).mean()
    qbar = q.mean(axis=1).mean()
    theta = abar / qbar if qbar > 0 else None
    seed = analysis_seed(name)
    rng = np.random.Generator(np.random.PCG64(seed))
    values = []
    for start in range(0, B, 500):
        batch = min(500, B - start)
        indices = rng.integers(0, n, size=(batch, G, n))
        sa = a[np.arange(G)[None, :, None], indices]
        sq = q[np.arange(G)[None, :, None], indices]
        aa = sa.mean(axis=2).mean(axis=1)
        qq = sq.mean(axis=2).mean(axis=1)
        values.append(np.divide(aa, qq, out=np.full(batch, np.nan), where=qq > 0))
    concatenated = np.concatenate(values)
    finite = np.sort(concatenated[np.isfinite(concatenated)])
    ci = ([finite[PERCENTILE_LOWER_ONE_BASED - 1], finite[PERCENTILE_UPPER_ONE_BASED - 1]]
          if len(finite) >= PERCENTILE_UPPER_ONE_BASED else [None, None])
    return {"estimate": theta, "observed_denominator": qbar, "ci95_percentile": ci,
            "finite_resamples": len(finite), "seed_uint64": seed}


def practical_classification(ci: list[float]) -> str:
    lo, hi = ci
    if lo > DELTA:
        return "BENEFICIAL"
    if hi < -DELTA:
        return "HARMFUL"
    if lo >= -DELTA and hi <= DELTA:
        return "EQUIVALENT"
    return "INCONCLUSIVE"


def apply_holm(results: dict[str, dict[str, Any]]) -> None:
    order = sorted(results, key=lambda h: results[h]["p_unadjusted"])
    running_adjusted = 0.0
    adjusted: dict[str, float] = {}
    rejected = {h: False for h in results}
    stopped = False
    m = len(order)
    for i, hypothesis in enumerate(order):
        raw = results[hypothesis]["p_unadjusted"]
        running_adjusted = max(running_adjusted, (m - i) * raw)
        adjusted[hypothesis] = min(1.0, running_adjusted)
        if not stopped and raw <= 0.05 / (m - i):
            rejected[hypothesis] = True
        else:
            stopped = True
    for hypothesis in results:
        results[hypothesis]["p_holm_adjusted"] = adjusted[hypothesis]
        results[hypothesis]["holm_reject_fwer_0_05"] = rejected[hypothesis]
        results[hypothesis]["practical_classification"] = practical_classification(results[hypothesis]["ci"])


def mechanism_solve(cxx: np.ndarray, cxy: np.ndarray) -> np.ndarray:
    """Solve active mechanism slopes; zero-variation columns remain NaN without redraw."""
    cxx = np.asarray(cxx, float)
    cxy = np.asarray(cxy, float)
    result = np.full(cxy.shape[0], np.nan)
    active = np.diag(cxx) > 0.0
    if not np.any(active):
        return result
    matrix = cxx[np.ix_(active, active)]
    vector = cxy[active]
    if np.linalg.matrix_rank(matrix) == len(vector):
        result[active] = np.linalg.solve(matrix, vector)
    return result
