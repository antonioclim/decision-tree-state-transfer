"""Synthetic wheel-contract tests, not a River installation or algorithm test."""
from __future__ import annotations
import base64
import copy
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import zipfile

MODULE = Path(__file__).resolve().parents[1] / 'assets/code/confirmatory/distribution_set.py'
sp = importlib.util.spec_from_file_location('distribution_set', MODULE)
d = importlib.util.module_from_spec(sp); sp.loader.exec_module(d)


def wheel(directory, name='alpha', version='1.0', requirements=(), requires_python='>=3.10'):
    p = directory / f'{name}-{version}-py3-none-any.whl'
    prefix = f'{name}-{version}.dist-info'
    payload = {
        f'{name}/__init__.py': b'# deliberately constructed test package; not a real comparator\n',
        f'{prefix}/METADATA': (f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\nRequires-Python: {requires_python}\n' + ''.join(f'Requires-Dist: {r}\n' for r in requirements)).encode(),
        f'{prefix}/WHEEL': b'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    }
    write_payload(p, payload, prefix)
    return descriptor(p, name, version)


def write_payload(path, payload, prefix=None):
    if prefix is not None:
        stream = io.StringIO(); out = csv.writer(stream, lineterminator='\n')
        for name, raw in payload.items():
            out.writerow([name, 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).rstrip(b'=').decode(), len(raw)])
        out.writerow([f'{prefix}/RECORD', '', ''])
        payload[f'{prefix}/RECORD'] = stream.getvalue().encode()
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, value in payload.items():
            z.writestr(name, value)


def descriptor(p, name='alpha', version='1.0'):
    return {'file': p.name, 'name': name, 'version': version, 'bytes': p.stat().st_size,
            'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.a = wheel(self.root, requirements=['beta>=2,<3'])
        self.b = wheel(self.root, 'beta', '2.0')
        self.lock = {'schema_version': 1, 'scope': 'SOFTWARE_FIXTURE',
                     'python_version': '.'.join(map(str, sys.version_info[:3])),
                     'roots': ['alpha==1.0'], 'artifacts': [self.a, self.b]}

    def verify(self, lock=None):
        lock = self.lock if lock is None else lock
        return d.verify_distribution_set(self.root, lock, d.lock_hash(lock))

    def alter(self, mutate, rerecord=False):
        p = self.root / self.a['file']
        with zipfile.ZipFile(p) as z:
            payload = {n: z.read(n) for n in z.namelist()}
        mutate(payload)
        if rerecord:
            payload.pop('alpha-1.0.dist-info/RECORD', None)
        write_payload(p, payload, 'alpha-1.0.dist-info' if rerecord else None)
        self.lock['artifacts'][0] = descriptor(p)

    def test_complete_transitive_test_artifacts_not_installed(self):
        r = self.verify()
        self.assertEqual(len(r['distributions']), 2)
        self.assertFalse(r['installed']); self.assertFalse(r['confirmation_authorised'])
        self.assertEqual(r['actual_algorithm_evaluations'], 0)

    def test_external_hash_is_required(self):
        with self.assertRaises(ValueError):
            d.verify_distribution_set(self.root, self.lock, '0' * 64)

    def test_missing_dependency_not_replaced_by_system_install(self):
        (self.root / self.b['file']).unlink(); self.lock['artifacts'].pop()
        with self.assertRaisesRegex(ValueError, 'unsatisfied artifact'):
            self.verify()

    def test_extra_file_is_rejected(self):
        (self.root / 'extra.txt').write_text('x')
        with self.assertRaises(ValueError): self.verify()

    def test_unreachable_artifact_is_rejected(self):
        self.lock['artifacts'].append(wheel(self.root, 'gamma', '3.0'))
        with self.assertRaisesRegex(ValueError, 'extraneous'): self.verify()

    def test_platform_marker_does_not_create_false_dependency(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/METADATA', p['alpha-1.0.dist-info/METADATA'] + b'Requires-Dist: impossible; sys_platform == "win32"\n'), True)
        self.assertEqual(len(self.verify()['distributions']), 2)

    def test_wheel_not_imported_or_executed(self):
        self.alter(lambda p: p.__setitem__('alpha/__init__.py', b'raise RuntimeError("MUST NEVER EXECUTE")\n'), True)
        self.assertEqual(self.verify()['status'], 'PASS_PINNED_WHEEL_DEPENDENCY_CLOSURE')

    def test_signed_record_self_hash_not_accepted(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/RECORD', p['alpha-1.0.dist-info/RECORD'].replace(b'RECORD,,', b'RECORD,sha256=abc,3')))
        with self.assertRaises(ValueError): self.verify()

    def test_duplicate_record_row_is_rejected(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/RECORD', p['alpha-1.0.dist-info/RECORD'] + p['alpha-1.0.dist-info/RECORD'].splitlines(keepends=True)[0]))
        with self.assertRaises(ValueError): self.verify()

    def test_record_size_is_checked(self):
        self.alter(lambda p: p.__setitem__('alpha/__init__.py', p['alpha/__init__.py'] + b'x'))
        with self.assertRaisesRegex(ValueError, 'RECORD'): self.verify()

    def test_record_unlisted_payload_is_rejected(self):
        self.alter(lambda p: p.__setitem__('unlisted.txt', b'extra'))
        with self.assertRaises(ValueError): self.verify()

    def test_linked_wheel_is_rejected(self):
        original = self.root / self.a['file']; moved = self.root.parent / (self.root.name + '.whl')
        shutil.copyfile(original, moved); self.addCleanup(moved.unlink); original.unlink(); original.symlink_to(moved)
        with self.assertRaises(ValueError): self.verify()

    def test_missing_record_is_rejected(self):
        self.alter(lambda p: p.pop('alpha-1.0.dist-info/RECORD'))
        with self.assertRaises(ValueError): self.verify()

    def test_ambiguous_metadata_is_rejected(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/METADATA', p['alpha-1.0.dist-info/METADATA'] + b'Name: evil\n'), True)
        with self.assertRaises(ValueError): self.verify()

    def test_incompatible_python_is_rejected(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/METADATA', p['alpha-1.0.dist-info/METADATA'].replace(b'>=3.10', b'>=99')), True)
        with self.assertRaises(ValueError): self.verify()

    def test_wrong_wheel_tags_are_rejected(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/WHEEL', p['alpha-1.0.dist-info/WHEEL'].replace(b'py3-none-any', b'cp310-cp310-win_amd64')), True)
        with self.assertRaises(ValueError): self.verify()

    def test_old_wheel_format_is_rejected(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/WHEEL', p['alpha-1.0.dist-info/WHEEL'].replace(b'1.0', b'2.0')), True)
        with self.assertRaises(ValueError): self.verify()

    def test_direct_url_dependency_is_rejected(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/METADATA', p['alpha-1.0.dist-info/METADATA'] + b'Requires-Dist: other @ https://example.invalid/x.whl\n'), True)
        with self.assertRaises(ValueError): self.verify()

    def test_dependency_extra_is_not_silently_ignored(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/METADATA', p['alpha-1.0.dist-info/METADATA'] + b'Requires-Dist: beta[extra]>=2\n'), True)
        with self.assertRaises(ValueError): self.verify()

    def test_unsatisfied_dependency_version_is_rejected(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/METADATA', p['alpha-1.0.dist-info/METADATA'].replace(b'beta>=2,<3', b'beta>=3')), True)
        with self.assertRaisesRegex(ValueError, 'unsatisfied'): self.verify()

    def test_toy_packages_cannot_claim_real_river_runtime(self):
        self.lock['scope'] = 'RIVER_RUNTIME'
        with self.assertRaises(ValueError): self.verify()

    def test_duplicate_archive_member_is_rejected(self):
        p = self.root / self.a['file']
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            with zipfile.ZipFile(p, 'a') as z: z.writestr('alpha/__init__.py', b'new')
        self.lock['artifacts'][0] = descriptor(p)
        with self.assertRaises(ValueError): self.verify()

    def test_dot_only_archive_member_is_rejected_after_rehashing(self):
        self.alter(lambda p: p.__setitem__('.', b'not a canonical payload path'), True)
        with self.assertRaisesRegex(ValueError, 'invalid archive path'):
            self.verify()

    def test_record_hash_algorithm_is_not_downgraded(self):
        self.alter(lambda p: p.__setitem__('alpha-1.0.dist-info/RECORD', p['alpha-1.0.dist-info/RECORD'].replace(b'sha256=', b'md5=')))
        with self.assertRaises(ValueError): self.verify()


def make_lock_case(name, mutate):
    def method(self):
        s = copy.deepcopy(self.lock); mutate(s)
        with self.assertRaises((ValueError, TypeError, KeyError)):
            self.verify(s)
    method.__name__ = 'test_' + name
    return method

for name, mutate in [
    ('boolean_schema', lambda s: s.update(schema_version=True)),
    ('other_runtime', lambda s: s.update(python_version='3.10.0')),
    ('unknown_field', lambda s: s.update(approved=True)),
    ('unknown_scope', lambda s: s.update(scope='CONF')),
    ('unpinned_root', lambda s: s.update(roots=['alpha>=1'])),
    ('wildcard_root', lambda s: s.update(roots=['alpha==1.*'])),
    ('empty_roots', lambda s: s.update(roots=[])),
    ('empty_artifacts', lambda s: s.update(artifacts=[])),
    ('duplicate_artifact', lambda s: s['artifacts'].append(s['artifacts'][0])),
    ('wrong_external_artifact_digest', lambda s: s['artifacts'][0].update(sha256='0'*64)),
    ('boolean_archive_size', lambda s: s['artifacts'][0].update(bytes=True)),
    ('path_traversal', lambda s: s['artifacts'][0].update(file='../alpha.whl')),
    ('metadata_identity_mismatch', lambda s: s['artifacts'][0].update(name='other')),
]:
    setattr(DistributionTests, 'test_' + name, make_lock_case(name, mutate))

if __name__ == '__main__': unittest.main()
