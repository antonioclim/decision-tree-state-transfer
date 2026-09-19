"""Strict two-tape DEV input and an explicit River evaluation entry point.

The test-double evaluator is separately named and never marked as a River run.
Reading source values and obtaining a successful constructor are not a complete
runtime-distribution lock or scientific confirmation.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import stat
import struct
import time

HASH = re.compile(r'[0-9a-f]{64}\Z')
BITS = re.compile(r'[0-9a-f]{16}\Z')
METHODS = ('HAT', 'ARF', 'SRP')
MAX_TAPE = 16 * 1024**2


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _json(data: bytes):
    def reject(value):
        raise ValueError(f'nonfinite JSON token: {value}')
    return json.loads(data.decode('utf-8'), object_pairs_hook=_object, parse_constant=reject)


def _regular(path: Path, maximum: int) -> bytes:
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > maximum:
        raise ValueError('bounded, unlinked regular input required')
    return path.read_bytes()


def _exact(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise ValueError('unexpected input fields')


class SeparatedSource:
    """Read a future label only after its corresponding feature request.

    Outer compressed bytes are checked at construction. Label JSON is decoded
    lazily, never passed to a predictor. Generator reconstruction is a separate
    Node verification, not an inference made from these self-contained files.
    """
    def __init__(self, directory: Path, expected_sha256: str):
        self.directory = Path(directory)
        if not HASH.fullmatch(expected_sha256 or ''):
            raise ValueError('external source digest required')
        if not stat.S_ISDIR(self.directory.lstat().st_mode):
            raise ValueError('genuine source directory required')
        if {p.name for p in self.directory.iterdir()} != {'SOURCE.json', 'features.jsonl.gz', 'labels.jsonl.gz'}:
            raise ValueError('unexpected source directory members')
        raw = _regular(self.directory / 'SOURCE.json', 1024**2)
        if _sha(raw) != expected_sha256:
            raise ValueError('source manifest anchor differs')
        m = _json(raw)
        _exact(m, ['schema_version', 'format', 'plan', 'stream_key', 'feature_count', 'prefix_rows', 'files',
                   'scientific_admission', 'confirmation_authorised'])
        p = m['plan']
        _exact(p, ['end', 'partition', 'protocol_sha256', 'realisation', 'scenario', 'schema_version'])
        scenarios = [f'{f}-{r}-{s}' for f in ('LOCAL_TREE', 'OBLIQUE') for r in ('ABRUPT', 'GRADUAL', 'RECURRENT') for s in ('MILD', 'SEVERE')]
        scenarios += [f'{f}-STATIONARY-NONE' for f in ('LOCAL_TREE', 'OBLIQUE')]
        if (type(m['schema_version']) is not int or m['schema_version'] != 1
                or m['format'] != 'DEV_SEPARATE_BINARY64_TAPES_V1' or m['feature_count'] != 8 or m['prefix_rows'] != 2000
                or p['partition'] != 'DEV' or type(p['schema_version']) is not int or p['schema_version'] != 1
                or type(p['end']) is not int or not 2001 <= p['end'] <= 26000
                or type(p['realisation']) is not int or not 0 <= p['realisation'] <= 2 or p['scenario'] not in scenarios
                or not HASH.fullmatch(p['protocol_sha256'] or '') or m['scientific_admission'] is not False
                or m['confirmation_authorised'] is not False):
            raise ValueError('unsupported source semantics; no CONF execution')
        address = f"DT-P9-v1|DEV|{p['scenario']}|r={p['realisation']:02d}"
        if m['stream_key'] != _sha(address.encode())[:16]:
            raise ValueError('DEV source key differs')
        if type(m['files']) is not list or len(m['files']) != 2:
            raise ValueError('two source tapes required')
        self._zipped = []
        for name, d in zip(('features.jsonl.gz', 'labels.jsonl.gz'), m['files'], strict=True):
            _exact(d, ['file', 'rows', 'raw_bytes', 'raw_sha256', 'gzip_bytes', 'gzip_sha256'])
            if (d['file'] != name or type(d['rows']) is not int or d['rows'] != p['end']
                    or type(d['raw_bytes']) is not int or not 0 < d['raw_bytes'] <= MAX_TAPE
                    or type(d['gzip_bytes']) is not int or not 0 < d['gzip_bytes'] <= MAX_TAPE
                    or not HASH.fullmatch(d['raw_sha256'] or '') or not HASH.fullmatch(d['gzip_sha256'] or '')):
                raise ValueError('invalid tape descriptor')
            zipped = _regular(self.directory / name, MAX_TAPE)
            if len(zipped) != d['gzip_bytes'] or _sha(zipped) != d['gzip_sha256']:
                raise ValueError('compressed source tape differs')
            self._zipped.append(zipped)
        self.manifest = m
        self.manifest_sha256 = expected_sha256
        self.end = p['end']
        self.index = 0
        self.pending = None
        self._features = self._rows(0)
        self._labels = self._rows(1)

    def _rows(self, tape):
        # GzipFile streaming enforces the declared output bound before JSON parsing.
        import io
        d = self.manifest['files'][tape]
        total = 0
        count = 0
        digest = hashlib.sha256()
        with gzip.GzipFile(fileobj=io.BytesIO(self._zipped[tape])) as stream:
            while line := stream.readline(4097):
                if len(line) > 4096 or not line.endswith(b'\n'):
                    raise ValueError('unbounded or truncated source row')
                total += len(line)
                count += 1
                if total > d['raw_bytes'] or count > self.end:
                    raise ValueError('source tape exceeds declared extent')
                digest.update(line)
                yield _json(line)
        if total != d['raw_bytes'] or count != self.end or digest.hexdigest() != d['raw_sha256']:
            raise ValueError('raw source count or digest differs')

    def features(self):
        if self.pending is not None or self.index >= self.end:
            raise ValueError('feature request out of order')
        row = next(self._features)
        _exact(row, ['index', 'bits'])
        if type(row['index']) is not int or row['index'] != self.index + 1 or type(row['bits']) is not list or len(row['bits']) != 8:
            raise ValueError('invalid feature index or dimension')
        values = []
        for b in row['bits']:
            if type(b) is not str or not BITS.fullmatch(b):
                raise ValueError('eight exact binary64 bit strings required')
            value = struct.unpack('>d', bytes.fromhex(b))[0]
            if not math.isfinite(value):
                raise ValueError('nonfinite feature')
            values.append(value)
        self.pending = row['index']
        return row['index'], {f'x{i}': value for i, value in enumerate(values)}

    def label(self, index):
        if type(index) is not int or index != self.pending:
            raise ValueError('label request must follow its features')
        row = next(self._labels)
        _exact(row, ['index', 'label'])
        if type(row['index']) is not int or row['index'] != index or type(row['label']) is not int or row['label'] not in (0, 1):
            raise ValueError('invalid or mismatched label')
        self.index = index
        self.pending = None
        return row['label']

    def finish(self):
        if self.index != self.end or self.pending is not None:
            raise ValueError('source not consumed completely')
        for stream in (self._features, self._labels):
            if next(stream, None) is not None:
                raise ValueError('extra source row')
        # Recheck external bytes after consumption, not only before model use.
        if _sha(_regular(self.directory / 'SOURCE.json', 1024**2)) != self.manifest_sha256:
            raise ValueError('source manifest changed')
        for d in self.manifest['files']:
            if _sha(_regular(self.directory / d['file'], MAX_TAPE)) != d['gzip_sha256']:
                raise ValueError('source tape changed')


def _evaluate(source, model, output, scope, constructor=None):
    """Common mechanism; only the production wrapper can assign actual River scope."""
    output = Path(output)
    output.mkdir(exist_ok=False)
    started = time.perf_counter_ns()
    cpu = time.process_time_ns()
    rows = 0
    digest = hashlib.sha256()
    target = output / 'events.jsonl.gz'
    constructor_digest = None
    try:
        # Constructor evidence must exist before a successful result can be issued.
        if constructor is not None:
            encoded = (json.dumps(constructor, indent=2, allow_nan=False) + '\n').encode()
            with (output / 'CONSTRUCTOR.json').open('xb') as handle:
                handle.write(encoded)
            constructor_digest = _sha(encoded)
        with target.open('xb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as stream:
            def emit(event):
                nonlocal rows
                data = (json.dumps(event, separators=(',', ':'), allow_nan=False) + '\n').encode()
                stream.write(data)
                digest.update(data)
                rows += 1
            for index in range(1, source.end + 1):
                t, x = source.features()
                if t != index:
                    raise ValueError('source order changed')
                if index > 2000:
                    prediction = model.predict_one(x)
                    if prediction is not None and (type(prediction) is not int or prediction not in (0, 1)):
                        raise ValueError('predict_one returned an unsupported binary value')
                    emit({'kind': 'prediction', 'index': index, 'prediction': prediction})
                y = source.label(index)
                if index > 2000:
                    emit({'kind': 'reveal', 'index': index, 'label': y, 'loss': int(prediction != y)})
                model.learn_one(x, y)
            source.finish()
        result = {'status': 'COMPLETE', 'scope': scope, 'source_sha256': source.manifest_sha256,
                  'constructor_sha256': constructor_digest,
                  'prefix_learn_calls': 2000, 'prediction_calls': source.end - 2000,
                  'learn_calls': source.end, 'event_rows': rows, 'events_sha256': digest.hexdigest(),
                  'gzip_sha256': _sha(target.read_bytes()), 'process_cpu_ns': time.process_time_ns() - cpu,
                  'elapsed_ns': time.perf_counter_ns() - started,
                  'scientific_admission': False, 'confirmation_authorised': False}
    except Exception as exc:
        (output / 'INTERRUPTED.json').write_text(json.dumps({'status': 'INTERRUPTED_NOT_ADMITTED',
            'error_type': type(exc).__name__, 'message': str(exc), 'event_rows': rows,
            'confirmation_authorised': False}, indent=2) + '\n')
        raise
    (output / 'RESULT.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    return result


def evaluate_test_double(source, model, output):
    return _evaluate(source, model, output, 'SOFTWARE_FIXTURE_TEST_DOUBLE_NOT_RIVER')


def evaluate_river(directory, source_digest, method, seed, output):
    if method not in METHODS or type(seed) is not int or not 0 <= seed < 2**64:
        raise ValueError('fixed comparator and unsigned seed required')
    p = Path(__file__).with_name('river-context-v2.py')
    spec = importlib.util.spec_from_file_location('river_context_v2', p)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    # Actual import/version/constructor is required before any source value is read.
    model, constructor = adapter.build_model(method, seed)
    source = SeparatedSource(Path(directory), source_digest)
    return _evaluate(source, model, output,
                     'ACTUAL_RIVER_0.22.0_DEV_NOT_FULL_MATRIX_ADMISSION', constructor)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--source', type=Path, required=True)
    ap.add_argument('--source-sha256', required=True)
    ap.add_argument('--method', choices=METHODS, required=True)
    ap.add_argument('--seed', type=int, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    try:
        evaluate_river(args.source, args.source_sha256, args.method, args.seed, args.output)
    except Exception as exc:
        print(json.dumps({'status': 'BLOCKED_OR_INTERRUPTED_NOT_ADMITTED', 'error_type': type(exc).__name__,
              'message': str(exc), 'confirmation_authorised': False}, allow_nan=False))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
