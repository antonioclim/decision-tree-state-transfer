"""Four explicit River 0.22.0 profiles, with observed lazy-member evidence.

This module is loaded only by the R06 isolated worker in the admitted route.
Calling it alone does not authenticate a distribution or admit a trajectory.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.metadata
import inspect
import json
import math
import random
import sys

METHODS = ('HAT', 'ARF', 'SRP', 'SRP_NATIVE_022')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def snapshot(value, active=None):
    """Retain constructor parameters, RNG state identity and nested metric state."""
    if value is None or type(value) in (bool, int, str):
        return value
    if type(value) is float:
        return value if math.isfinite(value) else {'nonfinite_float': repr(value)}
    if isinstance(value, random.Random):
        return {'class': 'random.Random', 'state_sha256': hashlib.sha256(canonical(value.getstate())).hexdigest()}
    active = set() if active is None else active
    if id(value) in active:
        raise ValueError('cyclic observed parameter state')
    active.add(id(value))
    try:
        if isinstance(value, dict):
            if all(type(k) is str for k in value):
                return {k: snapshot(v, active) for k, v in value.items()}
            return {'mapping_items': sorted([[snapshot(k, active), snapshot(v, active)]
                                             for k, v in value.items()], key=canonical)}
        if isinstance(value, (list, tuple, set)):
            items = [snapshot(v, active) for v in value]
            return sorted(items, key=canonical) if isinstance(value, set) else items
        params = {}
        for name, param in inspect.signature(type(value).__init__).parameters.items():
            if name == 'self' or param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
                continue
            if not hasattr(value, name):
                raise ValueError('unreadable constructor parameter: ' + name)
            params[name] = snapshot(getattr(value, name), active)
        result = {'class': type(value).__module__ + '.' + type(value).__qualname__, 'parameters': params}
        if type(value).__module__.startswith('river.metrics'):
            result['observed_state'] = snapshot(vars(value), active)
        return result
    finally:
        active.remove(id(value))


def _same(actual, expected, seed):
    if expected == 'SCHEDULED':
        return type(actual) is int and actual == seed
    if type(expected) is dict and 'type' in expected:
        if type(actual).__name__ != expected['type'].split('.')[-1]:
            return False
        return all(hasattr(actual, k) and _same(getattr(actual, k), v, seed)
                   for k, v in expected.get('parameters', {}).items())
    if expected is None or type(expected) in (str, bool, int):
        return actual == expected and (type(actual) is bool) == (type(expected) is bool)
    return actual == expected


def validate_expected(model, method, seed, contract):
    expected = next(v for v in contract['river']['methods'] if v['id'] == ('SRP' if method == 'SRP_NATIVE_022' else method))
    for name, value in expected['expected_parameters'].items():
        if method == 'SRP_NATIVE_022' and name == 'model':
            continue
        if not hasattr(model, name) or not _same(getattr(model, name), value, seed):
            raise ValueError(f'River effective parameter differs: {method}.{name}')
    if method == 'SRP_NATIVE_022':
        base = model.model
        if (base.grace_period != 50 or base.delta != 0.01 or base.leaf_prediction != 'nba'
                or base.max_depth != sys.getrecursionlimit() - 20):
            raise ValueError('native SRP base differs from the separately adopted profile')


def build_model(method, seed, contract):
    if method not in METHODS or type(seed) is not int or not 0 <= seed < 2**64:
        raise ValueError('exact R06 profile and scheduled unsigned integer seed required')
    version = importlib.metadata.version('river')
    if version != '0.22.0':
        raise ValueError('River 0.22.0 is required')
    tree = importlib.import_module('river.tree')
    if method == 'HAT':
        model = tree.HoeffdingAdaptiveTreeClassifier(seed=seed, max_depth=8, leaf_prediction='mc')
    elif method == 'ARF':
        model = importlib.import_module('river.forest').ARFClassifier(seed=seed, n_models=10, max_depth=8, leaf_prediction='mc')
    elif method == 'SRP':
        base = tree.HoeffdingTreeClassifier(max_depth=8, leaf_prediction='mc')
        model = importlib.import_module('river.ensemble').SRPClassifier(seed=seed, n_models=10, model=base)
    else:
        model = importlib.import_module('river.ensemble').SRPClassifier(seed=seed, n_models=10)
    validate_expected(model, method, seed, contract)
    return model, {'library': 'river', 'version': version, 'method': method, 'seed': seed,
                   'profile': 'SRP_NATIVE_022' if method == 'SRP_NATIVE_022' else 'P9_MC_DEPTH8_EXPLICIT_BASE',
                   'interpreter_recursion_limit': sys.getrecursionlimit(),
                   'resolved_constructor': snapshot(model), 'scientific_admission': False}


def lazy_members(model, method, request):
    """Observe members after exactly the first permitted prefix learn operation."""
    if request['stage'] != 'learn' or request['index'] != 1:
        raise ValueError('lazy audit must follow the first prefix row')
    if method == 'HAT':
        members = [{'model': snapshot(model), 'root_class': type(model._root).__module__ + '.' + type(model._root).__qualname__}]
    elif method == 'ARF':
        if len(model) != 10 or model.max_features != round(math.sqrt(len(request['x']))):
            raise ValueError('ARF lazy ensemble size or feature count differs')
        members = []
        for i, item in enumerate(model):
            if (item.splitter.n_splits != 10 or item.max_depth != 8 or item.leaf_prediction != 'mc'
                    or item.grace_period != 50 or item.delta != 0.01):
                raise ValueError('ARF effective lazy base differs')
            members.append({'model': snapshot(item), 'drift_detector': snapshot(model._drift_detectors[i]),
                            'warning_detector': snapshot(model._warning_detectors[i]),
                            'metric': snapshot(model._metrics[i]), 'background': snapshot(model._background[i])})
    else:
        if len(model.models) != 10:
            raise ValueError('SRP lazy ensemble size differs')
        members = []
        for item in model.models:
            if (item.model.splitter.n_splits != 10 or item.model.grace_period != model.model.grace_period
                    or item.model.delta != model.model.delta or item.model.max_depth != model.model.max_depth
                    or item.model.leaf_prediction != model.model.leaf_prediction):
                raise ValueError('SRP effective lazy base differs')
            members.append({'model': snapshot(item.model), 'features': snapshot(item.features),
                            'drift_detector': snapshot(item.drift_detector), 'warning_detector': snapshot(item.warning_detector),
                            'metric': snapshot(item.metric), 'background': snapshot(item._background_learner)})
    return {'schema_version': 1, 'method': method, 'first_row_request_sha256': hashlib.sha256(canonical(request) + b'\n').hexdigest(),
            'request_index': 1, 'member_count': len(members), 'members': members,
            'scientific_admission': False, 'confirmation_authorised': False}
