"""Standard-library bootstrap for a pinned isolated constructor/provenance probe.

Invoked only as python -I -S -B. This is not a hostile-code sandbox or a complete
interpreter/OS/shared-library lock. Distribution bytes and imported Python paths
are checked against externally anchored original wheels, before and after import.
"""
from __future__ import annotations
import hashlib
import importlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import sysconfig
import zipfile

RIVER_FILE='river-0.22.0-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
RIVER_HASH='f830f6459db13743fb20fcce83a73f9172e5bea5208d64b826e318f19ff946a7'
R06_SCOPE='RIVER_RUNTIME_CP312_R06'
R06_RIVER_FILE='river-0.22.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
R06_RIVER_HASH='0fb478839a3ea59efaac93f106c3078979dcaa142f678a7ce8b249a2d0487573'


def canonical(x):return (json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()
def sha(x):return hashlib.sha256(x).hexdigest()

def strict_json(raw):
    def pairs(items):
        d={}
        for k,v in items:
            if k in d:raise ValueError('duplicate JSON key')
            d[k]=v
        return d
    def reject(_):raise ValueError('nonfinite JSON number')
    return json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,parse_constant=reject)


def exact(value,fields):
    if type(value) is not dict or set(value)!=set(fields):raise ValueError('unexpected manifest fields')


def regular(path,limit=1024**3):
    p=Path(path);s=p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>limit:raise ValueError('regular unlinked file required')
    return p.read_bytes()


def target(name):
    if type(name) is not str or not name or name=='.' or '\\' in name or ':' in name or '\x00' in name:raise ValueError('unsafe archive path')
    p=PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or str(p)!=name or name.endswith('/'):raise ValueError('unsafe archive path')
    parts=list(p.parts)
    if parts[0].endswith('.data'):
        if len(parts)<3 or parts[1] not in ('purelib','platlib'):raise ValueError('unsupported wheel spreading')
        parts=parts[2:]
    if (parts[0].split('.')[0] in sys.stdlib_module_names
        or parts[0].split('.')[0] in ('sitecustomize','usercustomize')
        or '__pycache__' in parts or parts[-1].endswith(('.pth','.pyc','.pyo'))):raise ValueError('hook or shadow path')
    return '/'.join(parts)


def directory_member(info, scope):
    if not info.is_dir():return False
    if (scope!=R06_SCOPE or info.file_size!=0 or stat.S_IFMT(info.external_attr>>16) not in (0,stat.S_IFDIR)
        or info.flag_bits&1):raise ValueError('unsupported or invalid wheel directory')
    target(info.filename[:-1])
    return True


def wheel_mapping(runtime):
    lock=runtime['distribution_lock']
    exact(lock,('schema_version','scope','python_version','roots','artifacts'))
    # Existing distribution_set lock hashing intentionally does not have a newline.
    encoded=json.dumps(lock,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    if sha(encoded)!=runtime['distribution_lock_sha256']:raise ValueError('distribution lock anchor differs')
    if lock['scope']!=runtime['scope'] or lock['python_version']!=runtime['python_version']:raise ValueError('distribution profile differs')
    if runtime['scope']=='RIVER_RUNTIME':
        rivers=[a for a in lock['artifacts'] if a['name']=='river']
        if (len(rivers)!=1 or rivers[0]['file']!=RIVER_FILE or rivers[0]['sha256']!=RIVER_HASH
            or rivers[0]['version']!='0.22.0' or 'river==0.22.0' not in lock['roots']):raise ValueError('official River archive pin required')
    elif runtime['scope']==R06_SCOPE:
        rivers=[a for a in lock['artifacts'] if a['name']=='river']
        if (sys.version_info[:2]!=(3,12) or len(rivers)!=1 or rivers[0]['file']!=R06_RIVER_FILE
            or rivers[0]['sha256']!=R06_RIVER_HASH or rivers[0]['version']!='0.22.0'
            or 'river==0.22.0' not in lock['roots']):raise ValueError('separate official CPython 3.12 River pin required')
    elif runtime['scope']!='SOFTWARE_FIXTURE':raise ValueError('unknown profile')
    root=Path(runtime['wheel_directory'])
    if not stat.S_ISDIR(root.lstat().st_mode):raise ValueError('wheel root is not genuine')
    if {p.name for p in root.iterdir()}!={a['file'] for a in lock['artifacts']}:raise ValueError('wheel inventory differs')
    mapping={}
    for a in lock['artifacts']:
        if '/' in target(a['file']):raise ValueError('nested wheel file')
        raw=regular(root/a['file'],256*1024**2)
        if len(raw)!=a['bytes'] or sha(raw)!=a['sha256']:raise ValueError('original wheel bytes differ')
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            infos=z.infolist()
            if len(infos)>20000 or sum(i.file_size for i in infos)>1024**3:raise ValueError('wheel expansion bound')
            for info in infos:
                is_directory=directory_member(info,runtime['scope'])
                name=target(info.filename[:-1] if is_directory else info.filename)
                if name in mapping or stat.S_ISLNK(info.external_attr>>16):raise ValueError('wheel collision or link')
                raw=z.read(info)
                if is_directory and raw!=b'':raise ValueError('nonempty wheel directory')
                mapping[name]={'bytes':len(raw),'sha256':sha(raw),'distribution':a['name'],'archive_member':info.filename,
                               **({'kind':'directory'} if is_directory else {})}
    for name in mapping:
        parts=name.split('/')
        if any('/'.join(parts[:i]) in mapping and mapping['/'.join(parts[:i])].get('kind')!='directory'
               for i in range(1,len(parts))):raise ValueError('wheel file/directory collision')
    if mapping!=runtime['files']:raise ValueError('staged manifest is not bound to original wheel payloads')
    return mapping


def verify_site(runtime):
    mapping=wheel_mapping(runtime)
    site=Path(runtime['site'])
    if not stat.S_ISDIR(site.lstat().st_mode):raise ValueError('genuine site required')
    files=set();dirs=set()
    for root,children,names in os.walk(site,followlinks=False):
        for name in children:
            p=Path(root)/name
            if not stat.S_ISDIR(p.lstat().st_mode):raise ValueError('linked site directory')
            dirs.add(p.relative_to(site).as_posix())
        for name in names:
            p=Path(root)/name;key=p.relative_to(site).as_posix();files.add(key)
            raw=regular(p)
            if key not in mapping or mapping[key].get('kind')=='directory' or len(raw)!=mapping[key]['bytes'] or sha(raw)!=mapping[key]['sha256']:raise ValueError('unlisted or modified site payload')
    declared={name for name,item in mapping.items() if item.get('kind')=='directory'}
    wanted=declared|{'/'.join(n.split('/')[:i]) for n in mapping for i in range(1,len(n.split('/')))}
    if files!=set(mapping)-declared or dirs!=wanted:raise ValueError('site inventory differs')
    return mapping


def verify_sources(sources):
    for name,item in sources.items():
        if name!='river-context-v2.py':raise ValueError('unexpected executable project source')
        exact(item,('path','bytes','sha256'))
        raw=regular(item['path'])
        if Path(item['path']).name!=name or len(raw)!=item['bytes'] or sha(raw)!=item['sha256']:raise ValueError('project adapter differs')


def loaded_modules(runtime,sources):
    site=Path(runtime['site']).resolve();standard=Path(sysconfig.get_path('stdlib')).resolve()
    project={str(Path(v['path']).resolve()):v for v in sources.values()}
    own=str(Path(__file__).resolve());records=[]
    for name,m in list(sys.modules.items()):
        if m is None:continue
        # Namespace packages normally have no file origin. Their search paths
        # still decide which payloads a later import can resolve.
        for location in getattr(m,'__path__',[]):
            q=Path(location).resolve()
            if not q.is_relative_to(site) and not (q.is_relative_to(standard) and not {'site-packages','dist-packages'}.intersection(q.parts)):
                raise ValueError('unlocked package search path: '+name)
        origin=getattr(getattr(m,'__spec__',None),'origin',None) or getattr(m,'__file__',None)
        if origin in (None,'built-in','frozen'):continue
        path=Path(origin).resolve()
        if path.is_relative_to(site):
            key=path.relative_to(site).as_posix()
            item=runtime['files'].get(key)
            if item is None or sha(regular(path))!=item['sha256']:raise ValueError('loaded module outside pinned file map')
            reported=getattr(m,'__file__',str(path))
            if reported and Path(reported).resolve()!=path:raise ValueError('module file/origin differs')
            records.append({'module':name,'relative_path':key,'sha256':item['sha256'],'distribution':item['distribution']})
        elif str(path) in project:
            if sha(regular(path))!=project[str(path)]['sha256']:raise ValueError('loaded adapter changed')
        elif str(path)==own:pass
        elif path.is_relative_to(standard) and not {'site-packages','dist-packages'}.intersection(path.parts):pass
        else:raise ValueError('unlocked non-standard-library module imported: '+name)
    return sorted(records,key=lambda r:r['module'])


def run(request,request_hash):
    if not (sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode):raise RuntimeError('requires -I -S -B interpreter isolation')
    exact(request,('schema_version','runtime','runtime_sha256','action','sources'))
    if type(request['schema_version']) is not int or request['schema_version']!=1:raise ValueError('request schema')
    runtime=request['runtime']
    exact(runtime,('schema_version','scope','site','wheel_directory','distribution_lock','distribution_lock_sha256','files','interpreter_path','interpreter_sha256','python_version','runner_sha256','scientific_admission','confirmation_authorised'))
    if (type(runtime['schema_version']) is not int or runtime['schema_version']!=1
        or runtime['scientific_admission'] is not False or runtime['confirmation_authorised'] is not False):raise ValueError('premature admission')
    if sha(canonical(runtime))!=request['runtime_sha256']:raise ValueError('runtime anchor')
    binary=Path(sys.executable).resolve()
    if (str(binary)!=runtime['interpreter_path'] or sha(binary.read_bytes())!=runtime['interpreter_sha256']
        or '.'.join(map(str,sys.version_info[:3]))!=runtime['python_version']):raise ValueError('interpreter identity differs')
    if sha(regular(__file__))!=runtime['runner_sha256']:raise ValueError('bootstrap source differs')
    verify_site(runtime);verify_sources(request['sources'])
    baseline=list(sys.path)
    # -I -S excludes user site, cwd, PYTHONPATH and automatic .pth processing.
    if any('site-packages' in p or 'dist-packages' in p or not p for p in baseline):raise ValueError('unexpected initial import path')
    sys.path.append(runtime['site']);importlib.invalidate_caches()
    before=loaded_modules(runtime,request['sources'])
    if before:raise ValueError('third-party payload imported before the admission point')
    if request['action']=='SOFTWARE_FIXTURE_PROBE':
        if runtime['scope']!='SOFTWARE_FIXTURE' or request['sources']:raise ValueError('fixture scope mismatch')
        probe=importlib.import_module('runtime_probe')
        value=probe.run_probe()
        canonical(value)
        constructors=[]
    elif request['action']=='RIVER_CONSTRUCTORS':
        if runtime['scope']!='RIVER_RUNTIME' or set(request['sources'])!={'river-context-v2.py'}:raise ValueError('real constructor requires real archived runtime')
        source=request['sources']['river-context-v2.py']['path']
        spec=importlib.util.spec_from_file_location('dt_locked_adapter',source)
        adapter=importlib.util.module_from_spec(spec);sys.modules[spec.name]=adapter;spec.loader.exec_module(adapter)
        constructors=[]
        for method in ('HAT','ARF','SRP'):
            model,info=adapter.build_model(method,0);constructors.append(info)
        value=None
    else:raise ValueError('unknown probe action')
    modules=loaded_modules(runtime,request['sources'])
    if sys.path!=baseline+[runtime['site']]:raise ValueError('package changed the search path')
    verify_site(runtime);verify_sources(request['sources'])
    return {'status':'PASS_ISOLATED_RUNTIME_PROBE','scope':runtime['scope'],'request_sha256':request_hash,
            'runtime_sha256':request['runtime_sha256'],'interpreter_flags':{'isolated':sys.flags.isolated,'no_site':sys.flags.no_site,'dont_write_bytecode':sys.flags.dont_write_bytecode},
            'loaded_payload_modules':modules,'constructors':constructors,'fixture_value':value,
            'actual_River_evaluations':0,'source_rows_consumed':0,'scientific_admission':False,'confirmation_authorised':False,
            'complete_system_lock':False,'hostile_code_sandbox':False}


def main():
    try:
        if len(sys.argv)!=3:raise ValueError('request and external SHA-256 required')
        raw=regular(sys.argv[1],32*1024**2)
        if sha(raw)!=sys.argv[2]:raise ValueError('request anchor differs')
        result=run(strict_json(raw),sys.argv[2]);sys.stdout.buffer.write(canonical(result));return 0
    except Exception as exc:
        sys.stderr.buffer.write(canonical({'status':'BLOCKED_NOT_ADMITTED','type':type(exc).__name__,'error':str(exc)}));return 2

if __name__=='__main__':raise SystemExit(main())
