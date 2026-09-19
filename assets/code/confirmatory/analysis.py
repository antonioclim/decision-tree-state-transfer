"""Prospective cluster analysis. Inputs are contrasts, never independent time-series rows.

The command-line execution gate is deliberately DEV/FIXTURE-only in Phase 10.
No public registration or confirmation authorisation is supplied by this module.
"""
from __future__ import annotations

import hashlib
import math
from typing import Iterable

import numpy as np
from scipy import stats

HYPOTHESES = ("H1", "H2", "H3")
ALPHA = 0.05
DELTA = 0.005


def holm(p_values: Iterable[float], alpha: float = ALPHA) -> tuple[np.ndarray, np.ndarray]:
    """Stable step-down adjusted p-values in original hypothesis order."""
    p = np.asarray(list(p_values), dtype=float)
    if p.shape != (3,) or not np.isfinite(p).all() or ((p < 0) | (p > 1)).any():
        raise ValueError("the prospective family contains exactly three finite p-values")
    if not 0 < alpha < 1:
        raise ValueError("invalid alpha")
    order = np.argsort(p, kind="stable")
    adjusted = np.empty(3)
    adjusted[order] = np.minimum(1, np.maximum.accumulate(p[order] * np.array([3, 2, 1])))
    return adjusted, adjusted <= alpha


def decision(lower: float, upper: float, delta: float = DELTA) -> str:
    if not all(math.isfinite(x) for x in (lower, upper, delta)) or lower > upper or delta <= 0:
        raise ValueError("invalid interval or practical threshold")
    if lower > delta:
        return "PRACTICALLY_BENEFICIAL"
    if upper < -delta:
        return "PRACTICALLY_HARMFUL"
    if lower >= -delta and upper <= delta:
        return "PRACTICALLY_EQUIVALENT"
    return "INCONCLUSIVE"


def infer_array(values: np.ndarray) -> dict[str, np.ndarray]:
    """Vectorised equal-stratum inference; trailing axes are scenario, stream, H1..H3.

    Leading axes are independent analytical fixtures, not extra scientific replicates.
    All three contrasts share precisely the same cluster ordering.
    """
    x = np.asarray(values, dtype=float)
    if x.ndim < 3 or x.shape[-1] != 3 or x.shape[-2] < 2 or x.shape[-3] < 1:
        raise ValueError("expected (..., scenario, independent_stream, 3) with n >= 2")
    if not np.isfinite(x).all() or (np.abs(x) > 1).any():
        raise ValueError("loss contrasts must be finite and bounded by [-1, 1]")
    groups, n = x.shape[-3:-1]
    means = x.mean(axis=-2)
    # NumPy reductions can give a tiny positive variance for an exactly constant decimal.
    sample_variance = np.where(np.ptp(x, axis=-2) == 0, 0.0, x.var(axis=-2, ddof=1))
    components = sample_variance / (groups * groups * n)
    estimate = means.mean(axis=-2)
    variance = components.sum(axis=-2)
    denominator = np.square(components).sum(axis=-2) / (n - 1)
    positive = variance > 0
    df = np.full_like(variance, np.inf)
    np.divide(np.square(variance), denominator, out=df, where=positive & (denominator > 0))
    se = np.sqrt(variance)
    statistic = np.zeros_like(estimate)
    np.divide(estimate, se, out=statistic, where=positive)
    p = np.where(positive, 2 * stats.t.sf(np.abs(statistic), df), 1.0)
    critical = stats.t.ppf(1 - ALPHA / 6, df)
    # Hoeffding uses each independent stream's bounded contrast, not each observation.
    radius = math.sqrt(2 * math.log(6 / ALPHA) / (groups * n))
    half = np.where(positive, critical * se, radius)
    lower, upper = np.maximum(-1, estimate - half), np.minimum(1, estimate + half)
    order = np.argsort(p, axis=-1, kind="stable")
    ranked = np.take_along_axis(p, order, axis=-1)
    adjusted_ranked = np.minimum(1, np.maximum.accumulate(ranked * [3, 2, 1], axis=-1))
    adjusted = np.empty_like(p)
    np.put_along_axis(adjusted, order, adjusted_ranked, axis=-1)
    return {"estimate": estimate, "variance": variance, "df": df, "se": se,
            "p": p, "adjusted_p": adjusted, "holm_reject": adjusted <= ALPHA,
            "lower": lower, "upper": upper, "zero_variance": ~positive,
            "scenario_estimate": means}


def aggregate_records(records: Iterable[dict], scenarios: list[str], n_streams: int = 20,
                      optimiser_count: int = 3, checkpoints: tuple[int, ...] = (10000, 20000),
                      horizon: int = 2000, partition: str = "FIXTURE") -> np.ndarray:
    """Require every prespecified cell. Never silently drop failed or absent cells.

    Each record contains already averaged losses over exactly `horizon` predictions.
    An algorithmic failure has its missing predictions explicitly filled with loss one.
    This interface does not substitute for event-file admission by the evidence runner.
    """
    if partition not in ("DEV", "FIXTURE"):
        raise ValueError("Phase 10 analysis admission is closed to CONF and REAL")
    if len(set(scenarios)) != len(scenarios) or not scenarios or n_streams < 2 or optimiser_count < 1:
        raise ValueError("invalid cluster design")
    cells: dict[tuple, dict] = {}
    arms = ("PERSIST", "RESTART", "CHAMPION", "SUBTREE_REFIT", "STRUCTURAL_SHAM")
    for r in records:
        if r.get("partition") != partition or r.get("scenario") not in scenarios:
            raise ValueError("record outside declared partition/scenarios")
        if r.get("status") not in ("COMPLETE", "ALGORITHMIC_FAILURE", "PARENT_UNAVAILABLE"):
            raise ValueError("integrity/infrastructure faults are not scientific failure scores")
        if r.get("arm") not in arms or not isinstance(r.get("realisation"), int) or not 0 <= r["realisation"] < n_streams:
            raise ValueError("invalid arm or independent stream")
        if not isinstance(r.get("optimiser"), int) or not 0 <= r["optimiser"] < optimiser_count or r.get("checkpoint") not in checkpoints:
            raise ValueError("invalid nested key")
        loss = r.get("loss")
        if not isinstance(loss, (float, int)) or not math.isfinite(loss) or not 0 <= loss <= 1 or r.get("predictions") != horizon:
            raise ValueError("loss lacks its complete prospective denominator")
        if r["status"] == "PARENT_UNAVAILABLE" and loss != 1:
            raise ValueError("unavailable parent must preserve full loss-one slots")
        cell = (r["scenario"], r["realisation"], r["optimiser"], r["checkpoint"], r["arm"])
        if cell in cells:
            raise ValueError("duplicate cell; repeated attempts are not independent evidence")
        cells[cell] = r
    out = np.empty((len(scenarios), n_streams, 3))
    for gi, g in enumerate(scenarios):
        for ri in range(n_streams):
            nested = []
            for optimiser in range(optimiser_count):
                for cp in checkpoints:
                    try:
                        group = [cells[(g, ri, optimiser, cp, a)] for a in arms]
                    except KeyError as error:
                        raise ValueError("incomplete prospective cells") from error
                    unavailable = [r["status"] == "PARENT_UNAVAILABLE" for r in group]
                    if any(unavailable) and not all(unavailable):
                        raise ValueError("parent unavailability must apply to every paired arm")
                    p, restart, champ, refit, sham = (r["loss"] for r in group)
                    nested.append([restart - p, champ - p, refit - sham])
            out[gi, ri] = np.mean(nested, axis=0)
    return out


def cluster_bootstrap(values: np.ndarray, resamples: int = 20000,
                      seed_namespace: str = "DT-P9-v1|BOOTSTRAP") -> dict:
    """Whole-stream, within-scenario resampling, with the same indices for all H's."""
    x = np.asarray(values, dtype=float)
    infer_array(x)
    if x.ndim != 3 or not isinstance(resamples, int) or resamples < 2 or not seed_namespace:
        raise ValueError("invalid bootstrap request")
    seed = int.from_bytes(hashlib.sha256(seed_namespace.encode()).digest()[:8], "big")
    rng = np.random.Generator(np.random.PCG64(seed))
    g, n, _ = x.shape
    means = np.zeros((resamples, 3))
    for group in range(g):
        indices = rng.integers(n, size=(resamples, n))
        means += x[group, indices].mean(axis=1) / g
    bounds = np.quantile(means, [ALPHA / 6, 1 - ALPHA / 6], axis=0, method="linear")
    return {"resamples": resamples, "seed_hex": f"{seed:016x}", "bit_generator": "PCG64",
            "numpy_version": np.__version__, "interval": bounds.tolist(),
            "draws_sha256": hashlib.sha256(means.astype("<f8").tobytes()).hexdigest(),
            "role": "SENSITIVITY_NOT_ADDITIONAL_PRIMARY_TEST"}
