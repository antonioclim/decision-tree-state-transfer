"""Verify an externally pinned, complete wheel dependency set without installing it.

No network, imports from the wheels, execution or dependency fallback occurs here.
RECORD checks are consistency checks subordinate to the externally supplied wheel
hashes. Supported profile: current host, no optional extras or direct URL edges.
"""
from __future__ import annotations
import base64
import csv
from email.parser import BytesParser
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.tags import parse_tag, sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version

HASH = re.compile(r'[0-9a-f]{64}\Z')
MAX_ARCHIVE = 256 * 1024 ** 2
MAX_EXPANDED = 1024 ** 3
RIVER_FILE = 'river-0.22.0-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
RIVER_SHA256 = 'f830f6459db13743fb20fcce83a73f9172e5bea5208d64b826e318f19ff946a7'
R06_SCOPE = 'RIVER_RUNTIME_CP312_R06'
R06_RIVER_FILE = 'river-0.22.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
R06_RIVER_SHA256 = '0fb478839a3ea59efaac93f106c3078979dcaa142f678a7ce8b249a2d0487573'


def lock_hash(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError('unexpected distribution-lock fields')


def safe_name(name: str) -> str:
    if type(name) is not str or not name or name == '.' or '\\' in name or ':' in name or '\x00' in name:
        raise ValueError('invalid archive path')
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or str(p) != name or name.endswith('/'):
        raise ValueError('unsafe or noncanonical archive path')
    return name


def directory_member(info, *, enabled=False):
    """R06 only: represent genuine zero-byte ZIP directories explicitly."""
    if not info.is_dir():
        return False
    if (not enabled or not info.filename.endswith('/') or info.file_size != 0
            or stat.S_IFMT(info.external_attr >> 16) not in (0, stat.S_IFDIR)
            or info.flag_bits & 1):
        raise ValueError('unsupported or invalid wheel directory entry')
    safe_name(info.filename[:-1])
    return True


def inspect_distribution(path: Path, descriptor: dict, *, allow_directory_entries=False) -> dict:
    """Verify exact bytes, compatible tags, metadata and every RECORD member."""
    exact(descriptor, ['file', 'name', 'version', 'bytes', 'sha256'])
    if safe_name(descriptor['file']) != path.name or '/' in descriptor['file']:
        raise ValueError('wheel filename mismatch')
    if type(descriptor['bytes']) is not int or not 0 < descriptor['bytes'] <= MAX_ARCHIVE:
        raise ValueError('invalid archive byte count')
    if type(descriptor['sha256']) is not str or not HASH.fullmatch(descriptor['sha256']):
        raise ValueError('missing external artifact digest')
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size != descriptor['bytes']:
        raise ValueError('distribution is missing, linked or has wrong size')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != descriptor['sha256']:
        raise ValueError('distribution SHA-256 differs from external pin')
    name, version, _, file_tags = parse_wheel_filename(path.name)
    if name != descriptor['name'] or str(version) != descriptor['version'] or not file_tags.intersection(sys_tags()):
        raise ValueError('wheel identity or interpreter/ABI/platform differs')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        infos = z.infolist()
        if not infos or len(infos) > 20000 or sum(i.file_size for i in infos) > MAX_EXPANDED:
            raise ValueError('wheel expansion limit exceeded')
        names = []
        directories = []
        for i in infos:
            if directory_member(i, enabled=allow_directory_entries):
                if z.read(i) != b'':
                    raise ValueError('nonempty wheel directory payload')
                directories.append(i.filename[:-1])
                continue
            safe_name(i.filename)
            if i.is_dir() or stat.S_ISLNK(i.external_attr >> 16) or i.flag_bits & 1:
                raise ValueError('encrypted, linked or directory members are not supported')
            names.append(i.filename)
        if (len(names) != len(set(names)) or len(directories) != len(set(directories))
                or set(names).intersection(directories) or z.testzip() is not None):
            raise ValueError('duplicate archive members or corrupt CRC')
        files = set(names)
        for member_name in names + directories:
            parts = member_name.split('/')
            if any('/'.join(parts[:j]) in files for j in range(1, len(parts))):
                raise ValueError('archive file/directory collision')
        metas = [n for n in names if n.endswith('.dist-info/METADATA')]
        if len(metas) != 1 or metas[0].count('/') != 1:
            raise ValueError('wheel must have exactly one top-level METADATA')
        prefix = metas[0].split('/')[0]
        expected_prefix = f'{name.replace("-", "_")}-{version}.dist-info'
        if prefix != expected_prefix:
            raise ValueError('dist-info identity differs from filename')
        for field in [metas[0], f'{prefix}/WHEEL', f'{prefix}/RECORD']:
            if field not in names or z.getinfo(field).file_size > 16 * 1024 ** 2:
                raise ValueError('missing or oversized wheel metadata')
        meta = BytesParser().parsebytes(z.read(metas[0]))
        if len(meta.get_all('Name', [])) != 1 or len(meta.get_all('Version', [])) != 1:
            raise ValueError('ambiguous package metadata')
        if canonicalize_name(meta['Name']) != name or Version(meta['Version']) != version:
            raise ValueError('METADATA identity differs')
        python_constraints = meta.get_all('Requires-Python', [])
        if len(python_constraints) > 1 or (python_constraints and Version(default_environment()['python_full_version']) not in SpecifierSet(python_constraints[0])):
            raise ValueError('incompatible or ambiguous Python requirement')
        wheel = BytesParser().parsebytes(z.read(f'{prefix}/WHEEL'))
        if wheel.get('Wheel-Version') != '1.0':
            raise ValueError('unsupported wheel format')
        declared_tags = set()
        for value in wheel.get_all('Tag', []):
            declared_tags.update(parse_tag(value))
        if declared_tags != file_tags:
            raise ValueError('WHEEL tags differ from filename')
        record_name = f'{prefix}/RECORD'
        record = list(csv.reader(io.StringIO(z.read(record_name).decode('utf-8'))))
        seen = set()
        for row in record:
            if len(row) != 3:
                raise ValueError('invalid RECORD row')
            filename, digest, count = row
            safe_name(filename)
            if filename not in names or filename in seen:
                raise ValueError('duplicate or absent RECORD member')
            seen.add(filename)
            if filename == record_name:
                if digest or count:
                    raise ValueError('RECORD must leave its own hash and size empty')
                continue
            if not digest.startswith('sha256=') or not re.fullmatch(r'0|[1-9][0-9]*', count):
                raise ValueError('every non-RECORD file needs SHA-256 and size')
            payload = z.read(filename)
            encoded = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).rstrip(b'=').decode()
            if digest != 'sha256=' + encoded or int(count) != len(payload):
                raise ValueError('RECORD hash or size mismatch')
        if seen != set(names):
            raise ValueError('wheel contains unrecorded payload')
        requirements = meta.get_all('Requires-Dist', [])
        for item in requirements:
            req = Requirement(item)
            if req.url or req.extras:
                raise ValueError('URL dependencies and optional extras require a different explicit profile')
        return {'name': str(name), 'version': str(version), 'sha256': descriptor['sha256'],
                'file': path.name, 'verified_payload_files': len(names), 'requirements': requirements,
                **({'verified_directory_entries': len(directories)} if allow_directory_entries else {})}


def verify_distribution_set(directory: Path, lock: dict, external_digest: str) -> dict:
    """Reject missing transitive artifacts even when packages are globally installed."""
    if type(external_digest) is not str or not HASH.fullmatch(external_digest) or lock_hash(lock) != external_digest:
        raise ValueError('independent distribution-set anchor required')
    exact(lock, ['schema_version', 'scope', 'python_version', 'roots', 'artifacts'])
    if type(lock['schema_version']) is not int or lock['schema_version'] != 1 or lock['scope'] not in ('RIVER_RUNTIME', 'SOFTWARE_FIXTURE', R06_SCOPE):
        raise ValueError('unsupported distribution profile')
    if lock['python_version'] != '.'.join(map(str, sys.version_info[:3])):
        raise ValueError('Python runtime differs from lock')
    if type(lock['roots']) is not list or not lock['roots'] or type(lock['artifacts']) is not list or not lock['artifacts']:
        raise ValueError('a nonempty root and artifact set is required')
    st = directory.lstat()
    if not stat.S_ISDIR(st.st_mode):
        raise ValueError('distribution root must be a genuine directory')
    filenames = [a.get('file') for a in lock['artifacts'] if type(a) is dict]
    if len(filenames) != len(lock['artifacts']) or len(set(filenames)) != len(filenames):
        raise ValueError('duplicate or malformed artifacts')
    if set(p.name for p in directory.iterdir()) != set(filenames):
        raise ValueError('distribution directory has missing or unlisted artifacts')
    observed = {}
    for artifact in lock['artifacts']:
        safe_name(artifact['file'])
        if '/' in artifact['file']:
            raise ValueError('nested distributions are not allowed')
        item = inspect_distribution(directory / artifact['file'], artifact,
                                    allow_directory_entries=lock['scope'] == R06_SCOPE)
        if item['name'] in observed:
            raise ValueError('multiple versions of the same distribution')
        observed[item['name']] = item
    queue = []
    for text in lock['roots']:
        req = Requirement(text)
        specs = list(req.specifier)
        if req.url or req.extras or req.marker or len(specs) != 1 or specs[0].operator != '==' or '*' in specs[0].version:
            raise ValueError('root requirements must be exact version pins')
        queue.append(req)
    if lock['scope'] == 'RIVER_RUNTIME':
        river = observed.get('river', {})
        if 'river==0.22.0' not in lock['roots'] or river.get('file') != RIVER_FILE or river.get('sha256') != RIVER_SHA256:
            raise ValueError('River root must use the independently verified official wheel pin')
    if lock['scope'] == R06_SCOPE:
        river = observed.get('river', {})
        if (sys.version_info[:2] != (3, 12) or 'river==0.22.0' not in lock['roots']
                or river.get('file') != R06_RIVER_FILE or river.get('sha256') != R06_RIVER_SHA256):
            raise ValueError('R06 requires the separate official CPython 3.12 River wheel pin')
    reached = set()
    while queue:
        req = queue.pop()
        if req.marker and not req.marker.evaluate({**default_environment(), 'extra': ''}):
            continue
        name = canonicalize_name(req.name)
        if name not in observed or Version(observed[name]['version']) not in req.specifier:
            raise ValueError(f'unsatisfied artifact dependency: {req}')
        if name not in reached:
            reached.add(name)
            queue.extend(Requirement(x) for x in observed[name]['requirements'])
    if reached != set(observed):
        raise ValueError('unreachable or extraneous distributions in lock')
    # Re-read the outer hashes after all RECORD and dependency checks.
    for item in lock['artifacts']:
        p = directory / item['file']; st = p.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or hashlib.sha256(p.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('distribution changed during validation')
    return {'status': 'PASS_PINNED_WHEEL_DEPENDENCY_CLOSURE', 'scope': lock['scope'],
            'distributions': [observed[k] for k in sorted(observed)], 'lock_sha256': external_digest,
            'installed': False, 'actual_algorithm_evaluations': 0, 'independent_build_reproduced': False,
            'complete_system_lock': False, 'confirmation_authorised': False}
