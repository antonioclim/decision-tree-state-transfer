"""New, explicit Phase 10G comparator adapter; never a River substitute.

The unavailable Phase 10E adapter is not reconstructed byte-for-byte. This module
implements the unchanged, versioned Phase 9 constructor contract and records
resolved constructor parameters only after a real successful import.
"""
from __future__ import annotations
import argparse
import importlib
import importlib.metadata as metadata
import inspect
import json
import math
from pathlib import Path

VERSION = '0.22.0'


def resolved_parameters(model, active=None):
    """Serialise constructor state, retaining nested class identities."""
    active = set() if active is None else active
    if model is None or type(model) in (str, int, bool):
        return model
    if type(model) is float:
        if not math.isfinite(model):
            return {'nonfinite_float': repr(model)}
        return model
    if type(model) in (list, tuple):
        return [resolved_parameters(x, active) for x in model]
    if type(model) is dict:
        if any(type(k) is not str for k in model):
            raise TypeError('parameter dictionaries require string keys')
        return {k: resolved_parameters(v, active) for k, v in model.items()}
    if id(model) in active:
        raise ValueError('cyclic constructor metadata')
    active.add(id(model))
    try:
        parameters = {}
        for name, p in inspect.signature(type(model).__init__).parameters.items():
            if name == 'self' or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                continue
            if not hasattr(model, name):
                raise ValueError(f'constructor parameter {name!r} has no readable state')
            parameters[name] = resolved_parameters(getattr(model, name), active)
        return {'class': f'{type(model).__module__}.{type(model).__qualname__}', 'parameters': parameters}
    finally:
        active.remove(id(model))


def build_model(method: str, seed: int):
    if method not in ('HAT', 'ARF', 'SRP'):
        raise ValueError('unknown contextual comparator')
    if type(seed) is not int or not 0 <= seed < 2**64:
        raise ValueError('an explicit unsigned 64-bit seed is required')
    installed = metadata.version('river')
    if installed != VERSION:
        raise RuntimeError(f'river=={VERSION} required, not {installed}')
    tree = importlib.import_module('river.tree')
    if method == 'HAT':
        model = tree.HoeffdingAdaptiveTreeClassifier(seed=seed, max_depth=8, leaf_prediction='mc')
    elif method == 'ARF':
        model = importlib.import_module('river.forest').ARFClassifier(seed=seed, n_models=10, max_depth=8, leaf_prediction='mc')
    else:
        base = tree.HoeffdingTreeClassifier(max_depth=8, leaf_prediction='mc')
        model = importlib.import_module('river.ensemble').SRPClassifier(seed=seed, n_models=10, model=base)
    return model, {'library': 'river', 'version': installed, 'method': method, 'seed': seed,
                   'resolved_constructor': resolved_parameters(model), 'scientific_admission': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('output must be a new file')
    result = {'implementation': 'P10G_EXPLICIT_REIMPLEMENTATION', 'algorithm_evaluations': 0,
              'confirmation_authorised': False, 'constructors': []}
    try:
        for method in ('HAT', 'ARF', 'SRP'):
            _, info = build_model(method, 0)
            result['constructors'].append(info)
        result['status'] = 'CONSTRUCTORS_AVAILABLE_NOT_ALGORITHM_VALIDATION'
        code = 0
    except Exception as exc:
        result['status'] = 'BLOCKED'
        result['error'] = {'type': type(exc).__name__, 'message': str(exc)}
        code = 2
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    return code

if __name__ == '__main__':
    raise SystemExit(main())
