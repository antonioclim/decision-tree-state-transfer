"""R06 CPython 3.12 wheel staging and externally anchored worker admission.

No installer, package hook or ambient River import is used. The supervisor owns
process creation, resource limits and cleanup; this module only prepares and
validates immutable inputs and the worker's retained provenance receipts.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
base = load('r06_staging_base', HERE / 'locked_runtime.py')
bootstrap = load('r06_provenance_base', HERE / 'locked_runtime_worker.py')
canonical, sha, regular = base.canonical, base.sha, base.regular
SCOPE = 'RIVER_RUNTIME_CP312_R06'
SOURCES = ('distribution_set.py', 'locked_runtime_worker.py', 'r06_locked_worker.py', 'r06_river_adapter.py')


def _source_manifest():
    paths = {name: HERE / name for name in SOURCES}
    paths['comparator_contracts.json'] = HERE.parents[2] / 'working/reaudit-2026-09-07/R03/comparator_contracts.json'
    return {name: {'path': str(path), 'bytes': len(regular(path)), 'sha256': sha(regular(path))}
            for name, path in paths.items()}


def verify_sources(sources):
    if type(sources) is not dict or set(sources) != set(SOURCES) | {'comparator_contracts.json'}:
        raise ValueError('exact R06 executable and comparator source closure required')
    for name, item in sources.items():
        bootstrap.exact(item, ('path', 'bytes', 'sha256'))
        raw = regular(item['path'])
        if (Path(item['path']).name != name or type(item['bytes']) is not int
                or len(raw) != item['bytes'] or sha(raw) != item['sha256']):
            raise ValueError('R06 source changed: ' + name)


def stage_runtime(wheel_directory, lock, lock_sha256, target):
    if lock.get('scope') != SCOPE:
        raise ValueError('R06 requires the separate CPython 3.12 profile')
    sources = _source_manifest()
    verify_sources(sources)
    runtime, runtime_hash, closure, site = base.stage_runtime(wheel_directory, lock, lock_sha256, target)
    envelope = {'schema_version': 2, 'profile': SCOPE, 'runtime': runtime, 'runtime_sha256': runtime_hash,
                'sources': sources, 'scientific_admission': False, 'confirmation_authorised': False}
    verify_sources(sources)
    path = Path(target) / 'R06_RUNTIME.json'
    with path.open('xb') as handle:
        handle.write(canonical(envelope))
    return {'path': str(path.resolve()), 'sha256': sha(canonical(envelope)), 'closure': closure, 'site': site}


def validate_admission(admitted_runtime):
    bootstrap.exact(admitted_runtime, ('path', 'sha256'))
    raw = regular(admitted_runtime['path'], 32 * 1024**2)
    if not base.dist.HASH.fullmatch(admitted_runtime['sha256'] or '') or sha(raw) != admitted_runtime['sha256']:
        raise ValueError('external R06 runtime anchor differs')
    envelope = bootstrap.strict_json(raw)
    bootstrap.exact(envelope, ('schema_version', 'profile', 'runtime', 'runtime_sha256', 'sources',
                               'scientific_admission', 'confirmation_authorised'))
    if (type(envelope['schema_version']) is not int or envelope['schema_version'] != 2
            or envelope['profile'] != SCOPE or envelope['runtime']['scope'] != SCOPE
            or envelope['scientific_admission'] is not False or envelope['confirmation_authorised'] is not False):
        raise ValueError('R06 profile or non-admission fields differ')
    verify_sources(envelope['sources'])
    runtime = envelope['runtime']
    binary = Path(sys.executable).resolve()
    if (str(binary) != runtime['interpreter_path'] or sha(binary.read_bytes()) != runtime['interpreter_sha256']
            or '.'.join(map(str, sys.version_info[:3])) != runtime['python_version']
            or runtime['runner_sha256'] != envelope['sources']['locked_runtime_worker.py']['sha256']):
        raise ValueError('current interpreter or staged bootstrap identity differs')
    base.validate_runtime(envelope['runtime'], envelope['runtime_sha256'])
    return envelope


def prepare_worker(runtime_file, runtime_sha256, config, output_directory, *, capability_probe=False,
                   trajectory_profile='R06_2500'):
    if type(capability_probe) is not bool:
        raise ValueError('capability_probe must be an exact boolean')
    if trajectory_profile not in ('R06_2500', 'R08A_DEV_22000') or capability_probe and trajectory_profile != 'R06_2500':
        raise ValueError('explicit supported trajectory profile required; capability remains one row')
    admitted = {'path': str(Path(runtime_file).resolve()), 'sha256': runtime_sha256}
    envelope = validate_admission(admitted)
    bootstrap.exact(config, ('kind', 'method', 'seed', 'stress'))
    if (config['kind'] != 'RIVER' or config['method'] not in ('HAT', 'ARF', 'SRP', 'SRP_NATIVE_022')
            or type(config['seed']) is not int or not 0 <= config['seed'] < 2**64 or config['stress'] is not None):
        raise ValueError('genuine, unstressed R06 River configuration required')
    output = Path(output_directory).absolute() / 'runtime'
    for key in ('site', 'wheel_directory'):
        protected = Path(envelope['runtime'][key]).resolve()
        if output.resolve().is_relative_to(protected) or protected.is_relative_to(output.resolve()):
            raise ValueError('worker output overlaps admitted distribution bytes')
    if output.exists() or output.is_symlink():
        raise FileExistsError('worker runtime output must be fresh')
    output.mkdir(parents=False, exist_ok=False)
    request = {'schema_version': 2, 'admitted_runtime': admitted, 'envelope': envelope,
               'config': config, 'output': str(output.resolve()),
               'action': ('RIVER_ONE_ROW_SOFTWARE_CAPABILITY_PROBE' if capability_probe else
                          'RIVER_R08A_DEV_22000' if trajectory_profile == 'R08A_DEV_22000' else 'RIVER_ROW_SERVICE')}
    raw = canonical(request)
    request_path = output / 'REQUEST.json'
    with request_path.open('xb') as handle:
        handle.write(raw)
    worker = envelope['sources']['r06_locked_worker.py']['path']
    env = {k: v for k, v in os.environ.items() if not k.startswith('PYTHON')}
    env.update(OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', NUMEXPR_NUM_THREADS='1')
    return {'command': [sys.executable, '-I', '-S', '-B', worker, str(request_path), sha(raw)],
            'env': env, 'request_sha256': sha(raw), 'runtime_sha256': runtime_sha256,
            'request_path': str(request_path), 'admitted_runtime': admitted, 'output': str(output)}


def finish_worker(prepared, allow_incomplete=False):
    envelope = validate_admission(prepared['admitted_runtime'])
    output = Path(prepared['output'])
    request_raw = regular(prepared['request_path'], 32 * 1024**2)
    if sha(request_raw) != prepared['request_sha256']:
        raise ValueError('worker request changed')
    complete_path = output / 'COMPLETE.json'
    if not complete_path.exists():
        if not allow_incomplete:
            raise ValueError('worker did not complete final import and payload verification')
        return {'status': 'PARENT_BYTES_RECHECKED_WORKER_FINAL_IMPORT_AUDIT_ABSENT',
                'runtime_sha256': prepared['runtime_sha256'], 'worker_final_imports_verified': False,
                'scientific_admission': False, 'confirmation_authorised': False}
    value = bootstrap.strict_json(regular(complete_path, 4 * 1024**2))
    expected_fields = {'schema_version', 'status', 'scope', 'request_sha256', 'runtime_sha256', 'learn_calls',
                       'prediction_calls', 'first_row_audited', 'artifacts', 'scientific_admission', 'confirmation_authorised'}
    bootstrap.exact(value, expected_fields)
    request = bootstrap.strict_json(request_raw)
    expected_scope = ('SOFTWARE_CAPABILITY_NO_DEV_SOURCE' if request['action'] == 'RIVER_ONE_ROW_SOFTWARE_CAPABILITY_PROBE'
                      else 'R08A_DEV_22000_NOT_SCIENTIFIC_ADMISSION' if request['action'] == 'RIVER_R08A_DEV_22000'
                      else 'ACTUAL_RIVER_DEV_NOT_SCIENTIFIC_ADMISSION')
    if (type(value['schema_version']) is not int or value['schema_version'] != 2 or value['status'] != 'PASS_ISOLATED_RIVER_ROW_SERVICE'
            or value['scope'] != expected_scope
            or value['request_sha256'] != prepared['request_sha256']
            or value['runtime_sha256'] != prepared['runtime_sha256']
            or value['scientific_admission'] is not False or value['confirmation_authorised'] is not False
            or any(type(value[k]) is not int or value[k] < 0 for k in ('learn_calls', 'prediction_calls'))
            or value['first_row_audited'] is not (value['learn_calls'] > 0)):
        raise ValueError('terminal worker identity differs')
    if expected_scope == 'SOFTWARE_CAPABILITY_NO_DEV_SOURCE' and (value['learn_calls'] != 1 or value['prediction_calls'] != 1):
        raise ValueError('capability probe must retain exactly one predict/learn pair')
    if expected_scope == 'R08A_DEV_22000_NOT_SCIENTIFIC_ADMISSION' and (value['learn_calls'] != 22000 or value['prediction_calls'] != 20000):
        raise ValueError('R08A completion requires its entire prefix and scored denominator')
    expected_artifacts = {'CONSTRUCTOR.json', 'IMPORTS_READY.json', 'IMPORTS_FINAL.json'}
    if value['learn_calls']:
        expected_artifacts.add('LAZY_FIRST_ROW.json')
    if set(value['artifacts']) != expected_artifacts:
        raise ValueError('terminal provenance inventory differs')
    if {p.name for p in output.iterdir()} != expected_artifacts | {'REQUEST.json', 'COMPLETE.json'}:
        raise ValueError('unexpected worker provenance output')
    for name, digest in value['artifacts'].items():
        if sha(regular(output / name, 32 * 1024**2)) != digest:
            raise ValueError('worker provenance artifact changed')
    verify_sources(envelope['sources'])
    return {'status': value['status'], 'runtime_sha256': prepared['runtime_sha256'],
            'complete_sha256': sha(regular(complete_path)), 'worker_final_imports_verified': True,
            'worker': value, 'scientific_admission': False, 'confirmation_authorised': False}
