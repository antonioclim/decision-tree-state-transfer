"""Failure-aware DEV contextual execution with an unchanged prediction denominator.

Only explicitly declared model failures are imputed. Input, package, serialization
and unexpected implementation errors interrupt an attempt and never enter analysis.
The reference-fault entry point is not a River implementation or efficacy study.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import time

_spec = importlib.util.spec_from_file_location('contextual_source_bridge', Path(__file__).with_name('river_prequential.py'))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

POLICY = 'DT-P10M-TERMINAL-DENOMINATOR-v1'
REFERENCE = 'REFERENCE_FAULT_VALIDATION_NOT_RIVER'
RIVER = 'ACTUAL_RIVER_DEV_NOT_CONFIRMATION'
REASONS = ('RESOURCE_LIMIT', 'NUMERICAL_FAILURE')
PLAN_FIELDS = ('schema_version', 'partition', 'scope', 'method', 'seed', 'end', 'protocol_sha256', 'fault', 'failure_policy')
MAX_RAW = 256 * 1024**2
MAX_GZIP = 64 * 1024**2


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def validate_plan(plan):
    bridge._exact(plan, PLAN_FIELDS)
    if (type(plan['schema_version']) is not int or plan['schema_version'] != 1
            or plan['partition'] != 'DEV' or plan['failure_policy'] != POLICY
            or type(plan['seed']) is not int or not 0 <= plan['seed'] < 2**64
            or type(plan['end']) is not int or not 2001 <= plan['end'] <= 26000
            or type(plan['protocol_sha256']) is not str or not bridge.HASH.fullmatch(plan['protocol_sha256'])):
        raise ValueError('strict bounded DEV plan required; CONF is not supported')
    if plan['scope'] == REFERENCE:
        if plan['method'] not in ('LAST_LABEL', 'PREFIX_MAJORITY'):
            raise ValueError('reference methods cannot impersonate River')
    elif plan['scope'] == RIVER:
        if plan['method'] not in bridge.METHODS or plan['fault'] is not None:
            raise ValueError('actual River plans cannot contain injected faults')
    else:
        raise ValueError('unknown execution scope')
    fault = plan['fault']
    if fault is not None:
        bridge._exact(fault, ('stage', 'index', 'reason'))
        if (fault['stage'] not in ('predict', 'learn') or fault['reason'] not in REASONS
                or type(fault['index']) is not int or not 1 <= fault['index'] <= plan['end']
                or fault['stage'] == 'predict' and fault['index'] <= 2000):
            raise ValueError('invalid prospective fault address')
    return bridge._json(canonical(plan))


class DeclaredModelFailure(Exception):
    """Typed contract for a separately justified model/resource failure only.

    This class is not an automatic classifier of arbitrary Python exceptions.
    A production resource supervisor must supply its own measured evidence.
    """
    def __init__(self, reason):
        if reason not in REASONS:
            raise ValueError('unrecognised failure reason')
        self.reason = reason
        super().__init__(reason)


class ReferenceModel:
    """Elementary lag-one/majority controls; deliberate faults are always labelled."""
    def __init__(self, method, fault):
        self.method = method
        self.fault = fault
        self.learned = 0
        self.counts = [0, 0]
        self.last = None

    def _boundary(self, stage):
        if self.fault is not None and self.fault['stage'] == stage and self.fault['index'] == self.learned + 1:
            raise DeclaredModelFailure(self.fault['reason'])

    def predict_one(self, x):
        self._boundary('predict')
        return self.last if self.method == 'LAST_LABEL' else int(self.counts[1] > self.counts[0])

    def learn_one(self, x, y):
        self._boundary('learn')
        self.learned += 1
        self.counts[y] += 1
        self.last = y


def build_model(plan):
    """Native dispatch, not a caller-supplied success receipt or verifier callback."""
    plan = validate_plan(plan)
    if plan['scope'] == REFERENCE:
        return ReferenceModel(plan['method'], plan['fault']), {
            'implementation': 'ELEMENTARY_PYTHON_REFERENCE_NOT_RIVER', 'method': plan['method'],
            'fault_injection': plan['fault'], 'independent_algorithmic_failure_observation': False}
    adapter_spec = importlib.util.spec_from_file_location('contextual_real_river', Path(__file__).with_name('river-context-v2.py'))
    adapter = importlib.util.module_from_spec(adapter_spec)
    adapter_spec.loader.exec_module(adapter)
    return adapter.build_model(plan['method'], plan['seed'])


def _events(source, model, plan, constructor_sha256):
    """Prediction, reveal, update and score are separate ordered events.

    A failed post-prediction update overrides the effective loss of that same
    observation to one; the observed predictive loss remains visible separately.
    All later prediction/update slots are retained without calling the failed model.
    """
    if source.end != plan['end'] or source.manifest['plan']['protocol_sha256'] != plan['protocol_sha256']:
        raise ValueError('source extent or protocol differs from external plan')
    failure = None
    counts = dict(prediction_slots=0, prediction_calls_attempted=0, learn_calls_attempted=0,
                  learn_calls_completed=0, prefix_update_slots=0, scored_update_slots=0,
                  failure_imputed_slots=0, null_prediction_slots=0)
    yield dict(kind='start', plan=plan, source_sha256=source.manifest_sha256,
               constructor_sha256=constructor_sha256, initial_prefix=2000)
    for index in range(1, source.end + 1):
        t, x = source.features()
        if t != index:
            raise ValueError('source index differs')
        prediction = None
        if index > 2000:
            if failure is None:
                counts['prediction_calls_attempted'] += 1
                try:
                    prediction = model.predict_one(x)
                except DeclaredModelFailure as exc:
                    failure = dict(index=index, stage='predict', reason=exc.reason)
                    yield dict(kind='model_failure', **failure)
                if prediction is not None and (type(prediction) is not int or prediction not in (0, 1)):
                    raise ValueError('unsupported prediction is an integrity failure, not an imputed model failure')
            counts['prediction_slots'] += 1
            counts['null_prediction_slots'] += int(prediction is None)
            yield dict(kind='prediction', index=index, prediction=prediction,
                       feature_bits_sha256=sha(b''.join(bridge.struct.pack('>d', v) for v in x.values())),
                       model_available=failure is None)
        # The label is decoded only after the preceding prediction event was yielded.
        y = source.label(index)
        if index > 2000:
            yield dict(kind='reveal', index=index, label=y)
        update = 'UNAVAILABLE'
        if failure is None:
            counts['learn_calls_attempted'] += 1
            try:
                model.learn_one(x, y)
                counts['learn_calls_completed'] += 1
                update = 'COMPLETED'
            except DeclaredModelFailure as exc:
                failure = dict(index=index, stage='learn', reason=exc.reason)
                update = 'ALGORITHMIC_FAILURE'
                yield dict(kind='model_failure', **failure)
        counts['prefix_update_slots' if index <= 2000 else 'scored_update_slots'] += 1
        yield dict(kind='prefix_update' if index <= 2000 else 'update', index=index, outcome=update)
        if index > 2000:
            imputed = failure is not None
            counts['failure_imputed_slots'] += int(imputed)
            observed = int(prediction != y)
            yield dict(kind='score', index=index, observed_loss=observed,
                       effective_loss=1 if imputed else observed, failure_imputed=imputed)
    source.finish()  # Even a failed model must not excuse a truncated or corrupted source.
    yield dict(kind='complete', status='ALGORITHMIC_FAILURE' if failure else 'COMPLETE',
               first_failure=failure, counts=counts, scientific_admission=False,
               confirmation_authorised=False)


def _write_new(path, data):
    with path.open('xb') as handle:
        written = handle.write(data)
        if written != len(data):
            raise OSError('short metadata write')


def _record(source, model, constructor, plan, output):
    """Internal mechanism; public record_run fixes the genuine model and scope."""
    plan = validate_plan(plan)
    encoded_constructor = canonical(constructor)  # Fail before any model call.
    constructor_sha = sha(encoded_constructor)
    output = Path(output)
    output.mkdir(exist_ok=False)
    clock = time.perf_counter_ns()
    cpu = time.process_time_ns()
    event_rows = 0
    raw_bytes = 0
    digest = hashlib.sha256()
    completion = None
    try:
        _write_new(output / 'CONSTRUCTOR.json', encoded_constructor)
        _write_new(output / 'PLAN.json', canonical(plan))
        with (output / 'events.jsonl.gz').open('xb') as file:
            with gzip.GzipFile(filename='', fileobj=file, mode='wb', mtime=0) as zipped:
                for event in _events(source, model, plan, constructor_sha):
                    row = canonical(event)
                    if len(row) > 65536 or raw_bytes + len(row) > MAX_RAW:
                        raise ValueError('bounded event output exceeded')
                    if zipped.write(row) != len(row):
                        raise OSError('short event write')
                    digest.update(row)
                    event_rows += 1
                    raw_bytes += len(row)
                    if event['kind'] == 'complete':
                        completion = event
        if completion is None:
            raise ValueError('missing completion')
        events = bridge._regular(output / 'events.jsonl.gz', MAX_GZIP)
        result = dict(schema_version=1, status=completion['status'], plan=plan,
                      source_sha256=source.manifest_sha256, constructor_sha256=constructor_sha,
                      completion=completion, event_rows=event_rows, raw_bytes=raw_bytes,
                      raw_sha256=digest.hexdigest(), gzip_bytes=len(events), gzip_sha256=sha(events),
                      process_cpu_ns=time.process_time_ns() - cpu, elapsed_ns=time.perf_counter_ns() - clock,
                      scientific_admission=False, confirmation_authorised=False)
        # Publish only after the complete result file has closed successfully.
        pending = output / '.RESULT.pending'
        _write_new(pending, canonical(result))
        os.link(pending, output / 'RESULT.json')  # Exclusive target creation, not overwrite.
        pending.unlink()  # A failed unlink leaves an extra member and cannot pass admission.
        return result
    except BaseException as exc:
        interrupted = dict(status='INTERRUPTED_NOT_ADMITTED', error_type=type(exc).__name__,
                           event_rows=event_rows, scientific_admission=False, confirmation_authorised=False)
        try:
            _write_new(output / 'INTERRUPTED.json', canonical(interrupted))
        except OSError:
            pass  # Original error and absence of RESULT remain authoritative.
        raise


def record_run(directory, source_sha256, plan, output):
    plan = validate_plan(plan)
    # Package/import errors precede source creation and cannot be imputed as algorithmic failures.
    model, constructor = build_model(plan)
    source = bridge.SeparatedSource(Path(directory), source_sha256)
    return _record(source, model, constructor, plan, output)


def _archived_events(zipped, raw_limit, audit):
    import io
    count = 0
    size = 0
    digest = hashlib.sha256()
    with gzip.GzipFile(fileobj=io.BytesIO(zipped)) as stream:
        while row := stream.readline(65537):
            if len(row) > 65536 or not row.endswith(b'\n'):
                raise ValueError('unbounded or truncated event row')
            size += len(row)
            count += 1
            if size > raw_limit or count > 110000:
                raise ValueError('event extent exceeded')
            event = bridge._json(row)
            if canonical(event) != row:
                raise ValueError('noncanonical event or duplicate key')
            digest.update(row)
            yield event
    audit.update(event_rows=count, raw_bytes=size, raw_sha256=digest.hexdigest())


def verify_run(directory, source_sha256, plan, output, result_sha256):
    """Source-bound native replay, not timing authentication or global admission."""
    plan = validate_plan(plan)
    model, constructor = build_model(plan)
    source = bridge.SeparatedSource(Path(directory), source_sha256)
    output = Path(output)
    if not stat.S_ISDIR(output.lstat().st_mode):
        raise ValueError('real output directory required')
    if {p.name for p in output.iterdir()} != {'PLAN.json', 'CONSTRUCTOR.json', 'RESULT.json', 'events.jsonl.gz'}:
        raise ValueError('unexpected or incomplete attempt members')
    blobs = {name: bridge._regular(output / name, MAX_GZIP if name.endswith('.gz') else 1024**2)
             for name in ('PLAN.json', 'CONSTRUCTOR.json', 'RESULT.json', 'events.jsonl.gz')}
    if not bridge.HASH.fullmatch(result_sha256 or '') or sha(blobs['RESULT.json']) != result_sha256:
        raise ValueError('external result anchor differs')
    if blobs['PLAN.json'] != canonical(plan) or blobs['CONSTRUCTOR.json'] != canonical(constructor):
        raise ValueError('plan, scope or constructor differs')
    result = bridge._json(blobs['RESULT.json'])
    bridge._exact(result, ('schema_version', 'status', 'plan', 'source_sha256', 'constructor_sha256',
                          'completion', 'event_rows', 'raw_bytes', 'raw_sha256', 'gzip_bytes', 'gzip_sha256',
                          'process_cpu_ns', 'elapsed_ns', 'scientific_admission', 'confirmation_authorised'))
    if (type(result['schema_version']) is not int or result['schema_version'] != 1
            or result['scientific_admission'] is not False or result['confirmation_authorised'] is not False
            or result['source_sha256'] != source_sha256 or canonical(result['plan']) != canonical(plan)
            or result['constructor_sha256'] != sha(blobs['CONSTRUCTOR.json'])):
        raise ValueError('invalid identity or premature admission')
    for field in ('event_rows', 'raw_bytes', 'gzip_bytes', 'process_cpu_ns', 'elapsed_ns'):
        if type(result[field]) is not int or not 0 <= result[field] <= 2**63-1:
            raise ValueError('invalid exact numeric field')
    if not 0 < result['raw_bytes'] <= MAX_RAW or result['gzip_bytes'] != len(blobs['events.jsonl.gz']) or result['gzip_sha256'] != sha(blobs['events.jsonl.gz']):
        raise ValueError('invalid archive extent or hash')
    audit = {}
    recorded = _archived_events(blobs['events.jsonl.gz'], result['raw_bytes'], audit)
    complete = None
    for expected in _events(source, model, plan, sha(blobs['CONSTRUCTOR.json'])):
        actual = next(recorded, None)
        if actual is None or canonical(actual) != canonical(expected):
            raise ValueError('native replay differs; rehashing does not repair evidence')
        if expected['kind'] == 'complete':
            complete = expected
    if next(recorded, None) is not None or canonical(complete) != canonical(result['completion']) or result['status'] != complete['status']:
        raise ValueError('false completion or surplus events')
    if any(result[k] != v for k, v in audit.items()):
        raise ValueError('false event totals')
    if {p.name for p in output.iterdir()} != set(blobs):
        raise ValueError('attempt inventory changed during replay')
    for name, data in blobs.items():
        if bridge._regular(output / name, MAX_GZIP if name.endswith('.gz') else 1024**2) != data:
            raise ValueError('attempt changed during replay')
    return dict(status='PASS_SOURCE_BOUND_CONTEXTUAL_LIFECYCLE', result_sha256=result_sha256,
                scope=plan['scope'], completion=complete, **audit,
                conditional_on_declared_faults=plan['fault'] is not None,
                independent_fault_observation=False, timing_authenticated=False,
                real_River_evaluation=plan['scope'] == RIVER,
                scientific_admission=False, confirmation_authorised=False)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--source-sha256', required=True)
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--verify-sha256')
    args = p.parse_args()
    try:
        plan = bridge._json(args.plan.read_bytes())
        if args.verify_sha256:
            result = verify_run(args.source, args.source_sha256, plan, args.output, args.verify_sha256)
        else:
            result = record_run(args.source, args.source_sha256, plan, args.output)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
    except Exception as exc:
        print(json.dumps(dict(status='BLOCKED_OR_INTERRUPTED_NOT_ADMITTED', error_type=type(exc).__name__,
                              message=str(exc), confirmation_authorised=False)))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
