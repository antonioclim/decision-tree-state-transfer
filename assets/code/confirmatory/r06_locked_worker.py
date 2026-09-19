"""Isolated R06 River row service with pre/post wheel and import provenance.

This trusted-code boundary excludes ambient Python packages. Observed operating
system libraries are inventoried separately; this is not a full OS lock or a
sandbox for malicious native extensions. No source tape or future label is read.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import sys
import time

MAX_LINE = 16384
SOURCE_NAMES = {'distribution_set.py', 'locked_runtime_worker.py', 'r06_locked_worker.py',
                'r06_river_adapter.py', 'comparator_contracts.json'}


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def regular(path, maximum=32 * 1024**2):
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or not 0 <= st.st_size <= maximum:
        raise ValueError('bounded, unlinked regular input required')
    return path.read_bytes()


def decode(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError('duplicate JSON field')
            out[key] = value
        return out
    def reject(_):
        raise ValueError('nonfinite JSON number')
    return json.loads(raw.decode(), object_pairs_hook=pairs, parse_constant=reject)


def exact(value, names):
    if type(value) is not dict or set(value) != set(names):
        raise ValueError('exact field contract required')


def verify_sources(sources):
    if type(sources) is not dict or set(sources) != SOURCE_NAMES:
        raise ValueError('R06 source closure differs')
    for name, item in sources.items():
        exact(item, ('path', 'bytes', 'sha256'))
        raw = regular(item['path'])
        if Path(item['path']).name != name or type(item['bytes']) is not int or len(raw) != item['bytes'] or sha(raw) != item['sha256']:
            raise ValueError('R06 project source differs: ' + name)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_new(path, value):
    with Path(path).open('xb') as handle:
        raw = canonical(value)
        if handle.write(raw) != len(raw):
            raise OSError('short provenance write')
    return sha(raw)


def native_images(runtime):
    """Identify mapped files, distinguishing wheel payloads from observed OS files."""
    if sys.platform != 'linux':
        raise ValueError('Linux mapped-image provenance is required for this profile')
    site = Path(runtime['site']).resolve()
    names = set()
    for line in Path('/proc/self/maps').read_text().splitlines():
        parts = line.split(maxsplit=5)
        if len(parts) == 6 and parts[5].startswith('/'):
            if parts[5].endswith(' (deleted)'):
                raise ValueError('mapped executable file was deleted')
            names.add(parts[5])
    result = []
    for name in sorted(names):
        path = Path(name).resolve()
        if not path.is_file() or path.stat().st_size > 512 * 1024**2:
            raise ValueError('unavailable or oversized mapped image')
        digest = sha(path.read_bytes())
        item = {'path': str(path), 'sha256': digest, 'bytes': path.stat().st_size}
        if path.is_relative_to(site):
            relative = path.relative_to(site).as_posix()
            pinned = runtime['files'].get(relative)
            if pinned is None or pinned['sha256'] != digest:
                raise ValueError('mapped native image differs from wheel payload')
            item.update(scope='PINNED_DISTRIBUTION_PAYLOAD', relative_path=relative,
                        distribution=pinned['distribution'])
        else:
            item['scope'] = 'OBSERVED_SYSTEM_IMAGE_NOT_EXTERNALLY_LOCKED'
        result.append(item)
    return result


def row_request(value, sequence, learned, pending, *, prefix_rows=2000, end=2500):
    exact(value, ('seq', 'stage', 'index', 'x', 'y'))
    if (type(value['seq']) is not int or value['seq'] != sequence
            or type(value['index']) is not int or value['index'] != learned + 1 or not 1 <= value['index'] <= end
            or value['stage'] not in ('predict', 'learn') or type(value['x']) is not dict
            or set(value['x']) != {f'x{i}' for i in range(8)}
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in value['x'].values())):
        raise ValueError('chronological row identity or features differ')
    if value['stage'] == 'predict':
        if value['y'] is not None or learned < prefix_rows or pending is not None:
            raise ValueError('prediction cannot contain a label or precede the approved prefix')
    else:
        if type(value['y']) is not int or value['y'] not in (0, 1):
            raise ValueError('learning requires an exact binary label')
        if learned >= prefix_rows and (pending is None or canonical(value['x']) != pending):
            raise ValueError('scored learning must follow prediction on identical features')


def run(request_path, anchor):
    if not (sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode):
        raise ValueError('R06 worker requires -I -S -B')
    raw = regular(request_path)
    if sha(raw) != anchor:
        raise ValueError('independent worker request anchor differs')
    request = decode(raw)
    exact(request, ('schema_version', 'admitted_runtime', 'envelope', 'config', 'output', 'action'))
    if type(request['schema_version']) is not int or request['schema_version'] != 2 or request['action'] not in ('RIVER_ROW_SERVICE', 'RIVER_ONE_ROW_SOFTWARE_CAPABILITY_PROBE', 'RIVER_R08A_DEV_22000'):
        raise ValueError('R06 worker request profile differs')
    capability = request['action'] == 'RIVER_ONE_ROW_SOFTWARE_CAPABILITY_PROBE'
    extended = request['action'] == 'RIVER_R08A_DEV_22000'
    envelope = request['envelope']
    exact(envelope, ('schema_version', 'profile', 'runtime', 'runtime_sha256', 'sources',
                     'scientific_admission', 'confirmation_authorised'))
    runtime = envelope['runtime']
    exact(runtime, ('schema_version', 'scope', 'site', 'wheel_directory', 'distribution_lock',
                    'distribution_lock_sha256', 'files', 'interpreter_path', 'interpreter_sha256',
                    'python_version', 'runner_sha256', 'scientific_admission', 'confirmation_authorised'))
    admitted = request['admitted_runtime']
    exact(admitted, ('path', 'sha256'))
    external = regular(admitted['path'])
    if sha(external) != admitted['sha256'] or external != canonical(envelope):
        raise ValueError('external runtime envelope differs')
    if (type(envelope['schema_version']) is not int or envelope['schema_version'] != 2
            or type(runtime['schema_version']) is not int or runtime['schema_version'] != 1
            or runtime['scientific_admission'] is not False or runtime['confirmation_authorised'] is not False
            or envelope['profile'] != 'RIVER_RUNTIME_CP312_R06'
            or runtime['scope'] != envelope['profile'] or envelope['scientific_admission'] is not False
            or envelope['confirmation_authorised'] is not False or sha(canonical(runtime)) != envelope['runtime_sha256']):
        raise ValueError('runtime profile or binding differs')
    sources = envelope['sources']
    verify_sources(sources)
    binary = Path(sys.executable).resolve()
    if (str(binary) != runtime['interpreter_path'] or sha(binary.read_bytes()) != runtime['interpreter_sha256']
            or '.'.join(map(str, sys.version_info[:3])) != runtime['python_version']
            or sources['locked_runtime_worker.py']['sha256'] != runtime['runner_sha256']
            or Path(sources['r06_locked_worker.py']['path']).resolve() != Path(__file__).resolve()):
        raise ValueError('interpreter or executable bootstrap identity differs')
    provenance = load('r06_pinned_provenance', sources['locked_runtime_worker.py']['path'])
    provenance.verify_site(runtime)
    baseline = list(sys.path)
    if any(not p or 'site-packages' in p or 'dist-packages' in p for p in baseline):
        raise ValueError('ambient import search path is forbidden')
    if provenance.loaded_modules(runtime, sources):
        raise ValueError('third-party imports preceded isolated admission')
    sys.path.append(runtime['site'])
    importlib.invalidate_caches()
    # Packaging itself must resolve from the acquired closure. Metadata closure
    # verification therefore runs again inside the isolated interpreter.
    distributions = load('r06_pinned_distributions', sources['distribution_set.py']['path'])
    distributions.verify_distribution_set(Path(runtime['wheel_directory']), runtime['distribution_lock'],
                                          runtime['distribution_lock_sha256'])
    config = request['config']
    exact(config, ('kind', 'method', 'seed', 'stress'))
    if config['kind'] != 'RIVER' or config['stress'] is not None:
        raise ValueError('only genuine, unstressed River is admitted here')
    contract = decode(regular(sources['comparator_contracts.json']['path']))
    adapter = load('r06_pinned_adapter', sources['r06_river_adapter.py']['path'])
    started_cpu = time.process_time_ns()
    started_wall = time.perf_counter_ns()
    model, metadata = adapter.build_model(config['method'], config['seed'], contract)
    construction = {'cpu_ns': time.process_time_ns() - started_cpu,
                    'elapsed_ns': time.perf_counter_ns() - started_wall}
    output = Path(request['output'])
    if not stat.S_ISDIR(output.lstat().st_mode) or {p.name for p in output.iterdir()} != {'REQUEST.json'}:
        raise ValueError('fresh worker output inventory required')
    artifacts = {}
    artifacts['CONSTRUCTOR.json'] = write_new(output / 'CONSTRUCTOR.json', metadata)

    def imports():
        if sys.path != baseline + [runtime['site']]:
            raise ValueError('imported package changed Python search paths')
        return {'loaded_payload_modules': provenance.loaded_modules(runtime, sources),
                'mapped_files': native_images(runtime), 'complete_system_lock': False,
                'hostile_code_sandbox': False}

    artifacts['IMPORTS_READY.json'] = write_new(output / 'IMPORTS_READY.json', imports())
    ready = {'kind': 'ready', 'pid': os.getpid(), 'model': {**metadata,
             'runtime_sha256': admitted['sha256'], 'request_sha256': anchor,
             'constructor_sha256': artifacts['CONSTRUCTOR.json'], 'imports_ready_sha256': artifacts['IMPORTS_READY.json'],
             'construction_cost': construction, 'complete_system_lock': False}}
    encoded = canonical(ready)
    if len(encoded) > MAX_LINE:
        raise ValueError('constructor handshake exceeds IPC bound')
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    learned = predicted = sequence = 0
    pending = None
    while line := sys.stdin.buffer.readline(MAX_LINE + 1):
        if len(line) > MAX_LINE or not line.endswith(b'\n'):
            raise ValueError('bounded complete IPC line required')
        row = decode(line)
        sequence += 1
        row_request(row, sequence, learned, pending, prefix_rows=0 if capability else 2000,
                    end=1 if capability else 22000 if extended else 2500)
        if row['stage'] == 'predict':
            result = model.predict_one(row['x'])
            if result is not None and (type(result) is not int or result not in (0, 1)):
                raise ValueError('unsupported actual River prediction')
            pending = canonical(row['x'])
            predicted += 1
        else:
            model.learn_one(row['x'], row['y'])
            learned += 1
            pending = None
            result = None
            if learned == 1:
                artifacts['LAZY_FIRST_ROW.json'] = write_new(output / 'LAZY_FIRST_ROW.json',
                                                            adapter.lazy_members(model, config['method'], row))
                imports()  # Check newly imported lazy modules before acknowledging.
        sys.stdout.buffer.write(canonical({'kind': 'reply', 'seq': sequence, 'result': result}))
        sys.stdout.buffer.flush()
    if pending is not None:
        raise ValueError('worker stream ended between prediction and learning')
    if capability and (learned != 1 or predicted != 1):
        raise ValueError('one actual predict/learn pair is required for the capability probe')
    if extended and (learned != 22000 or predicted != 20000):
        raise ValueError('R08A requires exactly 22000 learns and 20000 predictions')
    artifacts['IMPORTS_FINAL.json'] = write_new(output / 'IMPORTS_FINAL.json', imports())
    provenance.verify_site(runtime)
    verify_sources(sources)
    if sha(regular(admitted['path'])) != admitted['sha256'] or sha(regular(request_path)) != anchor:
        raise ValueError('external runtime or request changed during execution')
    write_new(output / 'COMPLETE.json', {'schema_version': 2, 'status': 'PASS_ISOLATED_RIVER_ROW_SERVICE',
              'scope': ('SOFTWARE_CAPABILITY_NO_DEV_SOURCE' if capability else
                        'R08A_DEV_22000_NOT_SCIENTIFIC_ADMISSION' if extended else 'ACTUAL_RIVER_DEV_NOT_SCIENTIFIC_ADMISSION'),
              'request_sha256': anchor, 'runtime_sha256': admitted['sha256'], 'learn_calls': learned,
              'prediction_calls': predicted, 'first_row_audited': learned > 0, 'artifacts': artifacts,
              'scientific_admission': False, 'confirmation_authorised': False})
    return 0


def main():
    try:
        if len(sys.argv) != 3:
            raise ValueError('request file and external digest required')
        return run(sys.argv[1], sys.argv[2])
    except Exception as exc:
        value = {'kind': 'error', 'type': type(exc).__name__, 'message': str(exc)[:1000]}
        try:
            sys.stdout.buffer.write(canonical(value))
            sys.stdout.buffer.flush()
        except OSError:
            pass
        sys.stderr.buffer.write(canonical({'status': 'INVALIDATED_NOT_ADMITTED', **value}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
