"""Stage an externally pinned wheel closure and launch an isolated import audit.

This is an additional mandatory admission route, not an assertion that the legacy
constructor-only entry points prove distribution provenance. No package import or
installation occurs before the complete wheel set passes the existing verifier.
The supported layout is deliberately restricted; unsupported spreading is refused.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import zipfile

_SPEC = importlib.util.spec_from_file_location('dt_distribution_set', Path(__file__).with_name('distribution_set.py'))
dist = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(dist)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, maximum=1024**3):
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > maximum:
        raise ValueError('bounded, unlinked regular file required')
    return path.read_bytes()


def destination(member):
    """One purelib/platlib site, no scripts, .pth, cached code or customisation."""
    dist.safe_name(member)
    parts = member.split('/')
    if parts[0].endswith('.data'):
        if len(parts) < 3 or parts[1] not in ('purelib', 'platlib'):
            raise ValueError('unsupported wheel spreading scheme')
        parts = parts[2:]
    top = parts[0].split('.')[0]
    if (top in sys.stdlib_module_names or top in ('sitecustomize', 'usercustomize')
            or any(p == '__pycache__' for p in parts)
            or parts[-1].endswith(('.pth', '.pyc', '.pyo'))):
        raise ValueError('startup hook, bytecode or standard-library shadow refused')
    return '/'.join(parts)


def expected_site(directory, lock):
    """Derive payload identity from the original archives, not an installed RECORD."""
    mapping = {}
    for artifact in lock['artifacts']:
        archive = Path(directory)/artifact['file']
        # The caller has checked complete dependency closure; independently reread.
        data = regular(archive, dist.MAX_ARCHIVE)
        if len(data) != artifact['bytes'] or sha(data) != artifact['sha256']:
            raise ValueError('wheel changed after dependency validation')
        import io
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                member = info.filename
                is_directory = dist.directory_member(info, enabled=lock['scope'] == dist.R06_SCOPE)
                target = destination(member[:-1] if is_directory else member)
                if target in mapping:
                    raise ValueError('cross-distribution payload collision')
                raw = z.read(member)
                mapping[target] = {'bytes':len(raw),'sha256':sha(raw),
                                   'distribution':artifact['name'],'archive_member':member,
                                   **({'kind': 'directory'} if is_directory else {})}
    # A file must not also be a directory implied by another entry.
    names = set(mapping)
    for name in names:
        parts = name.split('/')
        if any('/'.join(parts[:i]) in names and mapping['/'.join(parts[:i])].get('kind') != 'directory'
               for i in range(1,len(parts))):
            raise ValueError('payload file/directory collision')
    return mapping


def walk_files(root):
    root = Path(root)
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError('genuine site directory required')
    files, dirs = set(), set()
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        for name in dirnames:
            p=Path(current)/name
            if not stat.S_ISDIR(p.lstat().st_mode):
                raise ValueError('linked directory refused')
            dirs.add(p.relative_to(root).as_posix())
        for name in filenames:
            p=Path(current)/name
            regular(p)
            files.add(p.relative_to(root).as_posix())
    return files, dirs


def verify_site(root, mapping):
    files, dirs = walk_files(root)
    declared_dirs = {name for name, item in mapping.items() if item.get('kind') == 'directory'}
    expected_files = set(mapping) - declared_dirs
    expected_dirs = declared_dirs | {'/'.join(p.split('/')[:i]) for p in mapping for i in range(1,len(p.split('/')))}
    if files != expected_files or dirs != expected_dirs:
        raise ValueError('site has missing, additional or unexpected directory entries')
    for name,item in mapping.items():
        if name in declared_dirs:
            if item['bytes'] != 0 or item['sha256'] != sha(b''):
                raise ValueError('nonempty declared directory')
            continue
        raw=regular(Path(root)/name)
        if len(raw)!=item['bytes'] or sha(raw)!=item['sha256']:
            raise ValueError('installed payload differs from pinned wheel bytes')
    return {'files':len(files),'directories':len(dirs),'manifest_sha256':sha(canonical(mapping))}


def stage_runtime(directory, lock, anchor, target):
    """No pip, hooks, imports or dependency download. Write only a new directory."""
    directory=Path(directory).resolve(); target=Path(target).absolute()
    if target.exists() or target.is_symlink():
        raise FileExistsError('runtime target must be new')
    verified=dist.verify_distribution_set(directory, lock, anchor)
    mapping=expected_site(directory,lock)
    target.mkdir(parents=False,exist_ok=False)
    site=target/'site'; site.mkdir()
    try:
        for artifact in lock['artifacts']:
            with zipfile.ZipFile(directory/artifact['file']) as z:
                for info in z.infolist():
                    member=info.filename
                    if dist.directory_member(info, enabled=lock['scope'] == dist.R06_SCOPE):
                        (site/destination(member[:-1])).mkdir(parents=True,exist_ok=True)
                        continue
                    output=site/destination(member); output.parent.mkdir(parents=True,exist_ok=True)
                    with output.open('xb') as h:
                        h.write(z.read(member))
        check=verify_site(site,mapping)
        # Keep the canonical lock with the staged runtime, but do not trust it alone.
        with (target/'DISTRIBUTIONS.json').open('xb') as h:h.write(canonical(lock))
        result={'schema_version':1,'scope':lock['scope'],'site':str(site.resolve()),
                'wheel_directory':str(directory),'distribution_lock':lock,
                'distribution_lock_sha256':anchor,'files':mapping,
                'interpreter_path':str(Path(sys.executable).resolve()),
                'interpreter_sha256':sha(Path(sys.executable).resolve().read_bytes()),
                'python_version':'.'.join(map(str,sys.version_info[:3])),
                'runner_sha256':sha(regular(Path(__file__).with_name('locked_runtime_worker.py'))),
                'scientific_admission':False,'confirmation_authorised':False}
        with (target/'RUNTIME.json').open('xb') as h:h.write(canonical(result))
        return result,sha(canonical(result)),verified,check
    except Exception as exc:
        with (target/'INCOMPLETE.json').open('xb') as h:
            h.write(canonical({'status':'INCOMPLETE_NOT_ADMITTED','type':type(exc).__name__,'error':str(exc)}))
        raise


def validate_runtime(runtime, anchor):
    if sha(canonical(runtime))!=anchor:
        raise ValueError('external runtime anchor differs')
    dist.verify_distribution_set(Path(runtime['wheel_directory']),runtime['distribution_lock'],runtime['distribution_lock_sha256'])
    mapping=expected_site(runtime['wheel_directory'],runtime['distribution_lock'])
    if mapping!=runtime['files']:
        raise ValueError('runtime manifest is not derived from original wheels')
    return verify_site(runtime['site'],mapping)


def launch_probe(runtime, anchor, output, *, project_directory=None, timeout=120):
    """Probe actual constructors only for an actual pinned RIVER_RUNTIME closure.

    SOFTWARE_FIXTURE invokes runtime_probe.run_probe(), never a River-named model.
    No scientific stream is opened. Runtime and source files are rechecked after.
    """
    validate_runtime(runtime,anchor)
    output=Path(output)
    if output.exists() or output.is_symlink():raise FileExistsError('probe output must be new')
    if runtime['scope']=='RIVER_RUNTIME':
        if project_directory is None:raise ValueError('the exact project adapter is required')
        project_directory=Path(project_directory).resolve()
        adapter=project_directory/'river-context-v2.py'
        sources={'river-context-v2.py':{'path':str(adapter),'bytes':len(regular(adapter)), 'sha256':sha(regular(adapter))}}
        action='RIVER_CONSTRUCTORS'
    elif runtime['scope']=='SOFTWARE_FIXTURE':
        sources={}; action='SOFTWARE_FIXTURE_PROBE'
    else:raise ValueError('unknown runtime scope')
    runner=Path(__file__).with_name('locked_runtime_worker.py').resolve()
    if sha(regular(runner))!=runtime['runner_sha256']:raise ValueError('runner source changed')
    output.mkdir(parents=False,exist_ok=False)
    request={'schema_version':1,'runtime':runtime,'runtime_sha256':anchor,'action':action,'sources':sources}
    request_file=output/'REQUEST.json';request_file.write_bytes(canonical(request))
    request_anchor=sha(canonical(request))
    command=[sys.executable,'-I','-S','-B',str(runner),str(request_file),request_anchor]
    env={k:v for k,v in os.environ.items() if not k.startswith('PYTHON')}
    try:
        done=subprocess.run(command,env=env,capture_output=True,timeout=timeout,check=False)
        (output/'stdout.log').write_bytes(done.stdout);(output/'stderr.log').write_bytes(done.stderr)
        if done.returncode!=0:raise RuntimeError('isolated import probe failed; retained stderr and stdout')
        # A single strict worker result; ordinary prints from packages are not accepted.
        observed=json.loads(done.stdout)
        if observed.get('status')!='PASS_ISOLATED_RUNTIME_PROBE' or observed.get('request_sha256')!=request_anchor:
            raise ValueError('worker result identity differs')
        if observed.get('scope')!=runtime['scope'] or observed.get('actual_River_evaluations')!=0:
            raise ValueError('worker mislabels probe as algorithm evaluation')
        validate_runtime(runtime,anchor)
        for item in sources.values():
            raw=regular(item['path'])
            if len(raw)!=item['bytes'] or sha(raw)!=item['sha256']:raise ValueError('adapter source changed')
        receipt={'status':'PASS_ISOLATED_RUNTIME_PROBE','scope':runtime['scope'],
                 'runtime_sha256':anchor,'request_sha256':request_anchor,'command':command,
                 'worker':observed,'actual_River_evaluations':0,
                 'scientific_admission':False,'confirmation_authorised':False}
        (output/'RESULT.json').write_bytes(canonical(receipt))
        return receipt
    except Exception as exc:
        (output/'INVALIDATED.json').write_bytes(canonical({'status':'INVALIDATED_NOT_ADMITTED','type':type(exc).__name__,'error':str(exc)}))
        raise
