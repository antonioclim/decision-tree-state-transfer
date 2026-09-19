"""Actual isolated subprocesses loading constructed wheels, never actual River."""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]

def load(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

rt=load('locked_runtime_test',ROOT/'assets/code/confirmatory/locked_runtime.py')
worker=load('locked_worker_test',ROOT/'assets/code/confirmatory/locked_runtime_worker.py')
helper=load('wheel_fixture_helpers',ROOT/'test/test_distribution_set.py')


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.wheels=self.root/'wheels';self.wheels.mkdir()
        self.a=self.make('alpha','1.0',{'runtime_probe/__init__.py':b'import helper_probe\ndef run_probe(): return {"value": helper_probe.VALUE, "scope":"CONSTRUCTED_WHEEL_FIXTURE"}\n'},['beta>=2,<3'])
        self.b=self.make('beta','2.0',{'helper_probe.py':b'VALUE=17\n'})
        self.lock={'schema_version':1,'scope':'SOFTWARE_FIXTURE','python_version':'.'.join(map(str,sys.version_info[:3])),
                   'roots':['alpha==1.0'],'artifacts':[self.a,self.b]}

    def make(self,name,version,files,requires=()):
        p=self.wheels/f'{name}-{version}-py3-none-any.whl';d=f'{name}-{version}.dist-info'
        data={**files,f'{d}/METADATA':(f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\nRequires-Python: >=3.10\n'+''.join(f'Requires-Dist: {r}\n' for r in requires)).encode(),
              f'{d}/WHEEL':b'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
        helper.write_payload(p,data,d);return helper.descriptor(p,name,version)

    def replace_alpha(self,files):
        self.a=self.make('alpha','1.0',files,['beta>=2,<3']);self.lock['artifacts'][0]=self.a

    def stage(self):
        return rt.stage_runtime(self.wheels,self.lock,rt.dist.lock_hash(self.lock),self.root/'runtime')[:2]

    def probe(self):
        runtime,anchor=self.stage();return rt.launch_probe(runtime,anchor,self.root/'probe')

    def child(self,runtime,anchor,action='SOFTWARE_FIXTURE_PROBE',flags=('-I','-S','-B')):
        r={'schema_version':1,'runtime':runtime,'runtime_sha256':anchor,'action':action,'sources':{}}
        p=self.root/'request.json';p.write_bytes(rt.canonical(r))
        return subprocess.run([sys.executable,*flags,str(ROOT/'assets/code/confirmatory/locked_runtime_worker.py'),str(p),rt.sha(p.read_bytes())],capture_output=True,text=True)

    def test_transitive_wheel_files_staged_byte_exact_without_import(self):
        runtime,anchor=self.stage()
        self.assertEqual(len(runtime['files']),8)
        self.assertEqual(rt.validate_runtime(runtime,anchor)['files'],8)
        self.assertNotIn('runtime_probe',sys.modules)

    def test_real_isolated_process_loads_both_fixture_distributions(self):
        result=self.probe();w=result['worker']
        self.assertEqual(w['fixture_value']['value'],17)
        self.assertEqual({x['distribution'] for x in w['loaded_payload_modules']},{'alpha','beta'})
        self.assertEqual(w['source_rows_consumed'],0);self.assertEqual(w['actual_River_evaluations'],0)
        self.assertFalse(w['confirmation_authorised']);self.assertFalse(w['scientific_admission'])
        self.assertEqual(w['interpreter_flags'],dict(isolated=1,no_site=1,dont_write_bytecode=1))

    def test_output_no_pycache_created(self):
        runtime,anchor=self.stage();rt.launch_probe(runtime,anchor,self.root/'probe')
        self.assertFalse(list((self.root/'runtime/site').rglob('*.pyc')))

    def test_pythonpath_and_cwd_shadow_not_imported(self):
        runtime,anchor=self.stage();shadow=self.root/'shadow';shadow.mkdir()
        (shadow/'helper_probe.py').write_text('raise RuntimeError("UNPINNED")\n')
        with patch.dict(os.environ,{'PYTHONPATH':str(shadow),'PYTHONSTARTUP':str(shadow/'helper_probe.py')}):
            result=rt.launch_probe(runtime,anchor,self.root/'probe')
        self.assertEqual(result['worker']['fixture_value']['value'],17)

    def test_global_package_not_borrowed(self):
        self.replace_alpha({'runtime_probe/__init__.py':b'import numpy\ndef run_probe(): return 1\n'})
        runtime,anchor=self.stage()
        with self.assertRaises(RuntimeError):rt.launch_probe(runtime,anchor,self.root/'probe')
        self.assertTrue((self.root/'probe/INVALIDATED.json').is_file())
        self.assertFalse((self.root/'probe/RESULT.json').exists())

    def test_missing_archive_not_satisfied_by_staged_site(self):
        r,a=self.stage();(self.wheels/self.b['file']).unlink()
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')
        self.assertFalse((self.root/'probe').exists())

    def test_modified_payload_rejected_before_import(self):
        r,a=self.stage();(Path(r['site'])/'helper_probe.py').write_text('VALUE=99\n')
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_rehashed_site_manifest_cannot_replace_original_wheels(self):
        r,a=self.stage();p=Path(r['site'])/'helper_probe.py';p.write_text('VALUE=99\n')
        r['files']['helper_probe.py'].update(bytes=p.stat().st_size,sha256=rt.sha(p.read_bytes()))
        a=rt.sha(rt.canonical(r))
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')
        child=self.child(r,a);self.assertEqual(child.returncode,2);self.assertIn('original wheel',child.stderr)

    def test_extra_site_file_rejected(self):
        r,a=self.stage();(Path(r['site'])/'extra.py').write_text('x=1')
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_extra_empty_directory_rejected(self):
        r,a=self.stage();(Path(r['site'])/'empty').mkdir()
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_missing_site_file_rejected(self):
        r,a=self.stage();(Path(r['site'])/'helper_probe.py').unlink()
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_symlink_payload_rejected(self):
        r,a=self.stage();p=Path(r['site'])/'helper_probe.py';other=self.root/'original';p.rename(other);p.symlink_to(other)
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_hardlinked_payload_rejected(self):
        r,a=self.stage();os.link(Path(r['site'])/'helper_probe.py',self.root/'hardlink')
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_symlink_directory_rejected(self):
        r,a=self.stage();p=Path(r['site'])/'runtime_probe';other=self.root/'moved';p.rename(other);p.symlink_to(other,target_is_directory=True)
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_wrong_runtime_anchor_rejected(self):
        r,a=self.stage()
        with self.assertRaises(ValueError):rt.launch_probe(r,'0'*64,self.root/'probe')

    def test_fixture_cannot_be_promoted_to_real_river(self):
        r,a=self.stage();r['scope']='RIVER_RUNTIME';r['distribution_lock']['scope']='RIVER_RUNTIME';r['distribution_lock_sha256']=rt.dist.lock_hash(r['distribution_lock']);a=rt.sha(rt.canonical(r))
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')
        done=self.child(r,a,'RIVER_CONSTRUCTORS');self.assertEqual(done.returncode,2)

    def test_existing_stage_not_overwritten(self):
        self.stage()
        with self.assertRaises(FileExistsError):self.stage()

    def test_existing_probe_not_overwritten(self):
        r,a=self.stage();(self.root/'probe').mkdir()
        with self.assertRaises(FileExistsError):rt.launch_probe(r,a,self.root/'probe')

    def test_hook_pth_rejected(self):
        self.replace_alpha({'runtime_probe.pth':b'import bad\n'})
        with self.assertRaises(ValueError):self.stage()

    def test_bytecode_rejected(self):
        self.replace_alpha({'runtime_probe.pyc':b'fake bytes'})
        with self.assertRaises(ValueError):self.stage()

    def test_sitecustomize_rejected(self):
        self.replace_alpha({'sitecustomize.py':b'x=1'})
        with self.assertRaises(ValueError):self.stage()

    def test_stdlib_shadow_rejected(self):
        self.replace_alpha({'json/__init__.py':b'x=1'})
        with self.assertRaises(ValueError):self.stage()

    def test_purelib_spreading(self):
        self.replace_alpha({'alpha-1.0.data/purelib/runtime_probe/__init__.py':b'import helper_probe\ndef run_probe():return helper_probe.VALUE\n'})
        self.assertEqual(self.probe()['worker']['fixture_value'],17)

    def test_scripts_not_silently_dropped(self):
        self.replace_alpha({'alpha-1.0.data/scripts/run':b'#!/bin/sh\n'})
        with self.assertRaises(ValueError):self.stage()

    def test_cross_wheel_collision_rejected(self):
        self.replace_alpha({'helper_probe.py':b'VALUE=22\n'})
        with self.assertRaises(ValueError):self.stage()

    def test_file_directory_collision_rejected(self):
        self.replace_alpha({'runtime_probe':b'x','runtime_probe/__init__.py':b'x'})
        with self.assertRaises(ValueError):self.stage()

    def test_wheel_changed_after_staging_rejected(self):
        r,a=self.stage();p=self.wheels/self.a['file'];p.write_bytes(p.read_bytes()+b'x')
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_self_modifying_fixture_cannot_publish_success(self):
        self.replace_alpha({'runtime_probe/__init__.py':b'from pathlib import Path\ndef run_probe():\n Path(__file__).write_text("changed")\n return 1\n'})
        r,a=self.stage()
        with self.assertRaises(RuntimeError):rt.launch_probe(r,a,self.root/'probe')
        self.assertFalse((self.root/'probe/RESULT.json').exists())

    def test_search_path_change_rejected(self):
        self.replace_alpha({'runtime_probe/__init__.py':b'import sys\ndef run_probe():\n sys.path.append("/tmp")\n return 1\n'})
        r,a=self.stage()
        with self.assertRaises(RuntimeError):rt.launch_probe(r,a,self.root/'probe')

    def test_fixture_exception_invalidates(self):
        self.replace_alpha({'runtime_probe/__init__.py':b'raise RuntimeError("fixture failure")\n'})
        r,a=self.stage()
        with self.assertRaises(RuntimeError):rt.launch_probe(r,a,self.root/'probe')

    def test_timeout_invalidates_not_completes(self):
        self.replace_alpha({'runtime_probe/__init__.py':b'import time\ndef run_probe():time.sleep(5)\n'})
        r,a=self.stage()
        with self.assertRaises(subprocess.TimeoutExpired):rt.launch_probe(r,a,self.root/'probe',timeout=.2)
        self.assertTrue((self.root/'probe/INVALIDATED.json').exists());self.assertFalse((self.root/'probe/RESULT.json').exists())

    def test_wrong_interpreter_hash_rejected(self):
        r,a=self.stage();r['interpreter_sha256']='0'*64;a=rt.sha(rt.canonical(r))
        done=self.child(r,a);self.assertEqual(done.returncode,2);self.assertIn('interpreter identity',done.stderr)

    def test_wrong_runner_hash_rejected(self):
        r,a=self.stage();r['runner_sha256']='0'*64;a=rt.sha(rt.canonical(r))
        with self.assertRaises(ValueError):rt.launch_probe(r,a,self.root/'probe')

    def test_without_isolation_flags_rejected_before_payload(self):
        r,a=self.stage();done=self.child(r,a,flags=('-B',))
        self.assertEqual(done.returncode,2);self.assertIn('requires -I -S -B',done.stderr)

    def test_fixture_action_cannot_invoke_real_constructor(self):
        r,a=self.stage();done=self.child(r,a,'RIVER_CONSTRUCTORS');self.assertEqual(done.returncode,2)

    def test_premature_admission_rejected(self):
        r,a=self.stage();r['scientific_admission']=True;a=rt.sha(rt.canonical(r))
        done=self.child(r,a);self.assertEqual(done.returncode,2)

    def test_request_must_have_external_hash(self):
        r,a=self.stage();p=self.root/'request';p.write_bytes(b'{}')
        done=subprocess.run([sys.executable,'-I','-S','-B',str(ROOT/'assets/code/confirmatory/locked_runtime_worker.py'),str(p),'0'*64],capture_output=True)
        self.assertEqual(done.returncode,2)

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(ValueError):worker.strict_json(b'{"a":1,"a":2}')

    def test_nonfinite_json_rejected(self):
        with self.assertRaises(ValueError):worker.strict_json(b'{"a":NaN}')

    def test_unsafe_archive_paths(self):
        for name in ('.','../x','/x','a//b','x\\y','x:y','x/',''):
            with self.subTest(name=name),self.assertRaises(ValueError):worker.target(name)

if __name__=='__main__':unittest.main()
