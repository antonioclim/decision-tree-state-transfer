"""Frozen I05 primary inference, implemented before any EXT outcome is available.

This numerical kernel is deliberately not an evidence-admission entry point.
The scientific CLI in analyse.py admits only a complete verified campaign.
Test fixtures must remain explicitly labelled as software qualification.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
PROTOCOL_SHA = 'd8eaac46d96f0ffc986e3ac5937112910cb28010e6d2cdc42ab08255aa17a622'
G, N, B, DENOMINATOR, CRITICAL_RANK = 14, 80, 9999, 4000, 9750
ARMS = ('CHAMPION-RESEED', 'POPULATION-RESEED', 'PERSIST')
HYPOTHESES = ('J1', 'J2')
SEED_NAMES = ('J1_RESIDUAL_POPULATION', 'J2_CONTINUATION_STATE')
DELTA = 0.005


class AnalysisError(RuntimeError):
    """Input, numerical or evidence gate failure; never a scientific result."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AnalysisError(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def protocol() -> dict[str, Any]:
    data = (PACKAGE / '03_SEALED_INPUTS/I05_STUDY2_PROTOCOL_LOCK.json').read_bytes()
    require(sha(data) == PROTOCOL_SHA, 'I05 protocol seal mismatch')
    value = json.loads(data)
    require(value['primary_inference']['family'] == list(HYPOTHESES), 'primary family changed')
    require(value['primary_inference']['bootstrap_resamples'] == B, 'B changed')
    require(value['primary_inference']['practical_delta'] == DELTA, 'delta changed')
    return value


def runtime() -> dict[str, str]:
    import platform
    import sys
    require(np.__version__ == '2.3.5', 'NumPy 2.3.5 required for the frozen draw implementation')
    require(sys.version_info >= (3, 11), 'Python >=3.11 required')
    return {'python': sys.version, 'numpy': np.__version__, 'platform': platform.platform()}


def seed(hypothesis: str) -> int:
    require(hypothesis in HYPOTHESES, 'not a member of the fixed primary family')
    item = protocol()['primary_inference']['analysis_seeds'][SEED_NAMES[HYPOTHESES.index(hypothesis)]]
    require(sha(item['address'].encode())[:16] == item['hex16'], 'seed address mismatch')
    value = int(item['uint64_decimal'])
    require(value == int(item['hex16'], 16), 'seed precision loss or mismatch')
    return value


def index_batches(hypothesis: str):
    """The call shape, batch size and integer dtype are part of the freeze."""
    runtime()
    generator = np.random.Generator(np.random.PCG64(seed(hypothesis)))
    for start in range(0, B, 250):
        size = min(250, B - start)
        yield generator.integers(0, N, size=(size, G, N), dtype=np.int64, endpoint=False)


def draw_tape(hypothesis: str) -> bytes:
    return b''.join(batch.astype(np.uint8).tobytes(order='C') for batch in index_batches(hypothesis))


def validate_draws(tape: bytes, hypothesis: str) -> np.ndarray:
    require(len(tape) == B * G * N, 'draw tape has wrong cardinality')
    expected = json.loads((HERE / 'DRAW_SCHEDULE_SEALS.json').read_text())['draws'][hypothesis]
    require(sha(tape) == expected['sha256'], 'draw tape digest differs from the pre-outcome freeze')
    a = np.frombuffer(tape, dtype=np.uint8).reshape(B, G, N)
    require(int(a.max()) < N, 'draw outside its stratum')
    return a


def validate_counts(value: Any) -> np.ndarray:
    """Counts: scenario, stream, checkpoint, horizon (500/2000), arm."""
    a = np.asarray(value)
    require(a.shape == (G, N, 2, 2, 3), 'loss-count tensor must be exactly 14x80x2x2x3')
    require(a.dtype.kind in 'iu' and a.dtype.kind != 'b', 'integer loss counts required')
    require(bool(np.all(a >= 0)), 'negative loss count')
    require(bool(np.all(a[:, :, :, 0, :] <= 500)), '500-horizon count exceeds denominator')
    require(bool(np.all(a[:, :, :, 1, :] <= 2000)), '2000-horizon count exceeds denominator')
    suffix = a[:, :, :, 1, :].astype(np.int64) - a[:, :, :, 0, :].astype(np.int64)
    require(bool(np.all((suffix >= 0) & (suffix <= 1500))), 'nested horizon count inconsistency')
    return a.astype(np.int64)


def primary_numerators(counts: Any) -> dict[str, np.ndarray]:
    a = validate_counts(counts)[:, :, :, 1, :]
    j1 = (a[..., 0] - a[..., 1]).sum(axis=2)
    j2 = (a[..., 1] - a[..., 2]).sum(axis=2)
    total = (a[..., 0] - a[..., 2]).sum(axis=2)
    require(np.array_equal(j1 + j2, total), 'integer J_SUM closure failed')
    return {'J1': j1, 'J2': j2, 'J_SUM': total}


def integer_moments(numerators: np.ndarray, denominator: int = DENOMINATOR):
    """Exact integer sufficient statistics, then the unbiased stratified SE.

    The leading dimensions may index bootstrap replicates. The final two
    dimensions are scenarios and whole independent streams respectively.
    """
    a = np.asarray(numerators)
    require(a.ndim >= 2 and a.dtype.kind in 'iu', 'integer numerator array required')
    g, n = a.shape[-2:]
    require(g >= 1 and n >= 2 and denominator >= 1, 'invalid estimator dimensions')
    require(bool(np.all(np.abs(a.astype(np.int64)) <= 4000)), 'unsafe contrast numerator')
    a = a.astype(np.int64)
    sums = a.sum(axis=-1, dtype=np.int64)
    squares = (a * a).sum(axis=-1, dtype=np.int64)
    centred_integer = n * squares - sums * sums
    require(bool(np.all(centred_integer >= 0)), 'negative exact variance numerator')
    theta = sums.sum(axis=-1) / (g * n * denominator)
    se = np.sqrt(centred_integer.sum(axis=-1) / (g * g * n * n * (n - 1) * denominator * denominator))
    return theta, se


def classification(interval: list[float]) -> str:
    lo, hi = interval
    require(math.isfinite(lo) and math.isfinite(hi) and lo <= hi, 'invalid confidence interval')
    if lo > DELTA:
        return 'BENEFICIAL'
    if hi < -DELTA:
        return 'HARMFUL'
    if lo >= -DELTA and hi <= DELTA:
        return 'EQUIVALENT'
    return 'INCONCLUSIVE'


def summarise_pivots(theta: float, se: float, absolute: np.ndarray) -> dict[str, Any]:
    require(len(absolute) == B and not np.isnan(absolute).any(), 'invalid bootstrap pivot family')
    require(bool(np.all(absolute >= 0)), 'absolute pivots must be non-negative')
    if se == 0:
        return {'estimate': theta, 'se': 0.0, 't_observed_abs': None, 'critical_abs_t': '+Infinity',
                'critical_rank_one_based': CRITICAL_RANK, 'ci': [-1.0, 1.0], 'p_unadjusted': 1.0,
                'exceedances': B, 'degenerate_resamples': int(np.isinf(absolute).sum()),
                'observed_variance_zero': True, 'practical_classification': 'INCONCLUSIVE'}
    require(math.isfinite(se) and se > 0, 'non-finite observed standard error')
    observed = abs(theta / se)
    q = float(np.sort(absolute)[CRITICAL_RANK - 1])
    count = int(np.count_nonzero(absolute >= observed))
    ci = [max(-1.0, theta - q * se), min(1.0, theta + q * se)]
    return {'estimate': theta, 'se': se, 't_observed_abs': observed,
            'critical_abs_t': q if math.isfinite(q) else '+Infinity',
            'critical_rank_one_based': CRITICAL_RANK, 'ci': ci,
            'p_unadjusted': (1 + count) / (B + 1), 'exceedances': count,
            'degenerate_resamples': int(np.isinf(absolute).sum()), 'observed_variance_zero': False,
            'practical_classification': classification(ci)}


def bootstrap_primary(numerators: np.ndarray, hypothesis: str, tape: bytes):
    x = np.asarray(numerators)
    require(x.shape == (G, N), 'wrong whole-stream primary matrix')
    indices = validate_draws(tape, hypothesis)
    theta, se = (float(v) for v in integer_moments(x))
    means, ses = np.empty(B), np.empty(B)
    for start in range(0, B, 250):
        stop = min(start + 250, B)
        sample = x[np.arange(G)[None, :, None], indices[start:stop]]
        means[start:stop], ses[start:stop] = integer_moments(sample)
    absolute = np.full(B, np.inf)
    good = ses > 0
    absolute[good] = np.abs((means[good] - theta) / ses[good])
    result = summarise_pivots(theta, se, absolute)
    result['seed_uint64_decimal'] = str(seed(hypothesis))
    result['B'] = B
    return result, {'theta_star': means.tolist(), 'se_star': ses.tolist(),
                    'abs_t_star': [float(v) if np.isfinite(v) else '+Infinity' for v in absolute]}


def apply_holm(results: dict[str, dict[str, Any]]) -> None:
    require(set(results) == set(HYPOTHESES), 'Holm family must remain exactly J1 and J2')
    for h in HYPOTHESES:
        p = results[h]['p_unadjusted']
        require(isinstance(p, (int, float)) and math.isfinite(p) and 0 <= p <= 1, 'invalid p-value')
    order = sorted(HYPOTHESES, key=lambda h: results[h]['p_unadjusted'])
    running, stopped = 0.0, False
    for index, h in enumerate(order):
        raw = results[h]['p_unadjusted']
        running = min(1.0, max(running, (2 - index) * raw))
        reject = not stopped and raw <= 0.05 / (2 - index)
        stopped = stopped or not reject
        results[h]['p_holm_adjusted'] = running
        results[h]['holm_reject_fwer_0_05'] = reject


def cancellation(results: dict[str, dict[str, Any]]) -> str:
    a, b = (results[h]['practical_classification'] for h in HYPOTHESES)
    if 'INCONCLUSIVE' in (a, b):
        return 'UNRESOLVED_DECOMPOSITION'
    if a == b == 'EQUIVALENT':
        return 'COMPONENTWISE_EQUIVALENCE'
    if {a, b} == {'BENEFICIAL', 'HARMFUL'}:
        return 'CANCELLATION'
    if 'EQUIVALENT' in (a, b):
        return 'ASYMMETRIC_COMPONENT_CONTRIBUTION'
    return 'CONCORDANT_NON_EQUIVALENT_INCREMENTS_DESCRIPTIVE'


def primary_analysis(counts: Any, tapes: dict[str, bytes]):
    matrices = primary_numerators(counts)
    results, replicate_statistics = {}, {}
    for h in HYPOTHESES:
        results[h], replicate_statistics[h] = bootstrap_primary(matrices[h], h, tapes[h])
    apply_holm(results)
    closure = float(matrices['J_SUM'].sum() / (G * N * DENOMINATOR))
    return {'method': 'paired equal-scenario whole-stream symmetric absolute bootstrap-t',
            'independent_units': G * N, 'checkpoints_are_independent': False,
            'family': list(HYPOTHESES), 'primary': results,
            'j_sum_direct_point_estimate': closure, 'j_sum_integer_closure': True,
            'cancellation_diagnostic': cancellation(results),
            'scientific_phase_complete': False}, replicate_statistics


def secondary_points(counts: Any) -> dict[str, Any]:
    a = validate_counts(counts)
    p = protocol()
    family = np.array([s.startswith('LOCAL_TREE-') for s in p['scenario_ids']])
    output: dict[str, Any] = {'scope': 'PRESPECIFIED_SECONDARY_POINT_SUMMARIES_NO_SIGNIFICANCE_TESTS',
                             'not_in_primary_holm_family': True, 'hypotheses': {}}
    for h, left, right in [('J1', 0, 1), ('J2', 1, 2)]:
        d = a[:, :, :, :, left] - a[:, :, :, :, right]
        main = d[:, :, :, 1].sum(axis=2) / 4000
        output['hypotheses'][h] = {
            'by_scenario_primary': {s: float(main[i].mean()) for i, s in enumerate(p['scenario_ids'])},
            'family_LOCAL_TREE_minus_OBLIQUE': float(main[family].mean() - main[~family].mean()),
            'checkpoint_20000_minus_10000': float((d[:, :, 1, 1] - d[:, :, 0, 1]).mean() / 2000),
            'embedded_horizon_500': float(d[:, :, :, 0].mean() / 500),
        }
    return output
