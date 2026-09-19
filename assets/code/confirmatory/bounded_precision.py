"""Bounded-mean planning reference, independent of the bootstrap candidate.

Hoeffding's inequality applies to independent, not necessarily identically
 distributed, observations with known bounds. These radii are not post-hoc
 replacements or intersections with A2 intervals. No observed sample extrema
 are used to narrow the known support.
"""
from __future__ import annotations
import math
import numbers
import numpy as np


def hoeffding_radius(counts, weights=None, alpha=0.05, hypotheses=3, support=(-1., 1.)):
    """Simultaneous two-sided reference for a weighted mean of stratum means."""
    counts = list(counts)
    if not counts or any(isinstance(n, (bool, np.bool_)) or not isinstance(n, numbers.Integral) or n < 1 for n in counts):
        raise ValueError('positive integer independent-unit counts required')
    if isinstance(hypotheses, bool) or type(hypotheses) is not int or hypotheses < 1:
        raise ValueError('positive integer hypothesis count required')
    if isinstance(alpha, bool) or not isinstance(alpha, numbers.Real) or not math.isfinite(alpha) or not 0 < alpha < 1:
        raise ValueError('alpha must lie strictly between zero and one')
    if len(support) != 2 or any(isinstance(v, bool) or not isinstance(v, numbers.Real) or not math.isfinite(v) for v in support) or support[0] >= support[1]:
        raise ValueError('finite ordered known support required')
    w = [1 / len(counts)] * len(counts) if weights is None else list(weights)
    if len(w) != len(counts) or any(isinstance(v, bool) or not isinstance(v, numbers.Real) or not math.isfinite(v) or v < 0 for v in w) or not math.isclose(math.fsum(w), 1., rel_tol=0., abs_tol=1e-12):
        raise ValueError('non-negative stratum weights must sum to one')
    squared_ranges = (support[1] - support[0])**2 * math.fsum(a*a/n for a, n in zip(w, counts))
    return math.sqrt(0.5 * squared_ranges * math.log(2 * hypotheses / alpha))


def sparse_no_event_probability(total_streams, event_probability=0.01):
    if type(total_streams) is not int or total_streams < 1 or not 0 <= event_probability <= 1:
        raise ValueError('invalid Bernoulli planning parameters')
    return (1. - event_probability)**total_streams


def sparse_bootstrap_zero_variance_probability(values):
    """Exact conditional zero-variance mass for finite empirical strata.

Every resampled stratum has zero sample variance exactly when all its n draws
 are in one equal-valued category. The product assumes independent resampling
 between strata. Zero variance need not imply an infinite studentised pivot.
"""
    x = np.asarray(values, dtype=float)
    if x.ndim != 2 or x.shape[0] < 1 or x.shape[1] < 2 or not np.isfinite(x).all():
        raise ValueError('finite (stratum, independent_stream) matrix required')
    n = x.shape[1]
    return math.prod(math.fsum((int(c)/n)**n for c in np.unique(row, return_counts=True)[1]) for row in x)
