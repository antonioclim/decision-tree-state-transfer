"""Paired stratified bootstrap-t candidate; admission remains DEV/FIXTURE-only.

This is a prospectively documented replacement candidate, not the Phase 9 rule.
The native kernel is an acceleration of a separately tested reference calculation.
Neither successful execution nor a bootstrap interval supplies universal coverage.
"""
from __future__ import annotations

import ctypes
import hashlib
import math
from pathlib import Path
import subprocess
import tempfile

import numpy as np

ALPHA = 0.05
RESAMPLES = 9999
MASK = (1 << 64) - 1
HYPOTHESES = ("H1", "H2", "H3")


def addressed_seed(namespace: str, case: str) -> int:
    if not isinstance(namespace, str) or not namespace or not isinstance(case, str) or not case:
        raise ValueError("nonempty namespace and case are required")
    text = f"DT-P10B-BOOTSTRAP-v1|{namespace}|{case}"
    return int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")


def prepare(values: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = np.asarray(values, dtype=np.float64)
    if x.ndim != 3 or x.shape[2] != 3 or x.shape[0] < 1 or x.shape[1] < 2:
        raise ValueError("expected (scenario, independent_stream, three paired contrasts)")
    if not np.isfinite(x).all() or (np.abs(x) > 1).any():
        raise ValueError("finite loss contrasts in [-1,1] are required")
    g, n, _ = x.shape
    # First subtract a within-stratum anchor. This avoids loss of tiny variations
    # around a large offset and preserves exact zero variance for constant strata.
    residual = x - x[:, :1, :]
    centre = residual.mean(axis=1, keepdims=True)
    centred = residual - centre
    estimate = (x[:, 0, :] + centre[:, 0, :]).mean(axis=0)
    var = (centred*centred).sum(axis=(0, 1)) / (g*g*n*(n-1))
    return np.ascontiguousarray(centred), estimate, np.sqrt(var)


class NativeKernel:
    """Compile a content-addressed local library; no binary is fetched or bundled."""
    def __init__(self, directory: Path | None = None):
        source = Path(__file__).with_name("bootstrap_kernel.cpp")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        cache = directory or Path(tempfile.mkdtemp(prefix="dt-bootstrap-"))
        cache.mkdir(parents=True, exist_ok=True)
        target = cache / f"kernel-{digest}.so"
        if target.exists():
            raise FileExistsError("refusing an unverified pre-existing compiled library")
        command = ["g++", "-std=c++17", "-O3", "-ffp-contract=off", "-fPIC", "-shared",
                   str(source), "-o", str(target)]
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
        self.provenance = {"source_sha256": digest, "command": command,
                           "binary_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                           "compiler": subprocess.check_output(["g++", "--version"], text=True).splitlines()[0]}
        self.library = ctypes.CDLL(str(target))
        self.function = self.library.paired_bootstrap_t
        pointer = ctypes.POINTER(ctypes.c_double)
        self.function.argtypes = [pointer, ctypes.c_size_t, ctypes.c_size_t,
                                  ctypes.c_size_t, ctypes.c_uint64, pointer]
        self.function.restype = ctypes.c_int

    def pivots(self, centred: np.ndarray, resamples: int, seed: int) -> np.ndarray:
        x = np.ascontiguousarray(centred, dtype=np.float64)
        if x.ndim != 3 or x.shape[-1] != 3 or x.shape[0] < 1 or x.shape[1] < 2 or not np.isfinite(x).all():
            raise ValueError("invalid centred bootstrap input")
        if type(resamples) is not int or not 1 <= resamples <= 1000000:
            raise ValueError("invalid resample count")
        if type(seed) is not int or not 0 <= seed <= MASK:
            raise ValueError("seed must be an unsigned 64-bit integer")
        out = np.empty((resamples, 3), dtype=np.float64)
        pointer = ctypes.POINTER(ctypes.c_double)
        status = self.function(x.ctypes.data_as(pointer), x.shape[0], x.shape[1],
                               resamples, seed, out.ctypes.data_as(pointer))
        if status:
            raise ArithmeticError(f"bootstrap kernel failed with status {status}")
        if np.isnan(out).any():
            raise ArithmeticError("undefined bootstrap pivot")
        return out


def reference_pivots(centred: np.ndarray, resamples: int, seed: int) -> np.ndarray:
    """Deliberately simple reference implementation for small numerical fixtures."""
    state = seed
    def index(n: int) -> int:
        nonlocal state
        threshold = ((1 << 64) - n) % n
        while True:
            state = (state + 0x9e3779b97f4a7c15) & MASK
            z = state
            z = ((z ^ (z >> 30)) * 0xbf58476d1ce4e5b9) & MASK
            z = ((z ^ (z >> 27)) * 0x94d049bb133111eb) & MASK
            z ^= z >> 31
            if z >= threshold:
                return z % n
    x = np.asarray(centred, dtype=float)
    g, n, _ = x.shape
    out = np.empty((resamples, 3))
    for b in range(resamples):
        y = np.array([[x[j, index(n)] for _ in range(n)] for j in range(g)])
        d = y.mean(axis=(0, 1))
        s2 = y.var(axis=1, ddof=1)
        s2 = np.where(np.ptp(y, axis=1) == 0, 0., s2)
        se = np.sqrt(s2.sum(axis=0)/(g*g*n))
        for h in range(3):
            out[b, h] = d[h]/se[h] if se[h] else (0 if d[h] == 0 else math.copysign(math.inf, d[h]))
    return out


def summarise(estimate: np.ndarray, se: np.ndarray, pivots: np.ndarray,
              total_streams: int, alpha: float = ALPHA, null: float = 0.) -> dict:
    """Invert inclusive absolute-pivot counts; retain infinite, never drop failed, pivots."""
    estimate, se, t = (np.asarray(v, dtype=float) for v in (estimate, se, pivots))
    if estimate.shape != (3,) or se.shape != (3,) or not np.isfinite(estimate).all() or not np.isfinite(se).all() or (se < 0).any():
        raise ValueError("invalid estimate or standard error")
    if not np.isfinite(null) or not -1 <= null <= 1 or not 0 < alpha < 1:
        raise ValueError("invalid null or significance level")
    if type(total_streams) is not int or total_streams < 2:
        raise ValueError("independent stream count is required")
    if t.ndim != 2 or t.shape[1] != 3 or np.isnan(t).any():
        raise ValueError("invalid bootstrap pivots")
    b = len(t)
    k = math.floor(alpha*(b+1)/3)
    if k < 1 or k > b//2:
        raise ValueError("too few bootstrap replicates for the simultaneous tail level")
    lower = np.empty(3); upper = np.empty(3); p = np.ones(3)
    fallback = se == 0
    sorted_t = np.sort(np.abs(t), axis=0)
    for h in range(3):
        if fallback[h]:
            radius = math.sqrt(2*math.log(6/alpha)/total_streams)
            lower[h], upper[h] = max(-1., estimate[h]-radius), min(1., estimate[h]+radius)
        else:
            observed = (estimate[h]-null)/se[h]
            extreme = int(np.count_nonzero(np.abs(t[:, h]) >= abs(observed)))
            p[h] = (1+extreme)/(b+1)
            radius = sorted_t[b-k, h]*se[h]
            lower[h] = max(-1., estimate[h] - radius)
            upper[h] = min(1., estimate[h] + radius)
    order = np.argsort(p, kind="stable")
    adjusted = np.empty(3)
    adjusted[order] = np.minimum(1., np.maximum.accumulate(p[order]*[3, 2, 1]))
    return {"estimate": estimate, "se": se, "p": p, "adjusted_p": adjusted,
            "holm_reject": adjusted <= alpha, "lower": lower, "upper": upper,
            "zero_variance_fallback": fallback, "infinite_pivots": np.isinf(t).sum(axis=0),
            "resamples": b, "one_based_tail_rank": k,
            "method": "PAIRED_STRATIFIED_ABSOLUTE_BOOTSTRAP_T_A2_CANDIDATE"}


def infer_bootstrap(values: np.ndarray, *, namespace: str, case: str,
                    kernel: NativeKernel, resamples: int = RESAMPLES,
                    partition: str = "FIXTURE") -> dict:
    if partition not in ("FIXTURE", "DEV"):
        raise ValueError("confirmation and real-data admission remain blocked")
    centred, estimate, se = prepare(values)
    seed = addressed_seed(namespace, case)
    pivots = kernel.pivots(centred, resamples, seed)
    result = summarise(estimate, se, pivots, centred.shape[0]*centred.shape[1])
    result.update({"partition": partition, "seed_hex": f"{seed:016x}",
                   "confirmation_authorised": False})
    return result
