#!/usr/bin/env python3
from __future__ import annotations
import fnmatch, hashlib, json, re, stat, sys
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[1]
MAN=ROOT/'PUBLIC_FILE_MANIFEST.json'
LIC=ROOT/'licensing/licence-map.json'
FORBIDDEN_PATHS=('.agents/','.github/workflows/','input/','literature/','manuscript/','release/','review/','working/','private/','cloud/','handover/','metadata-drafts/')
FORBIDDEN_FRAGMENTS=('/home/antonio_clim','/mnt/data/','dt-i06b-personal','dt-i06b-runner','europe-west1-b','R6_EXECUTION_AUTHORITY','BROWSER_AUTHORISATION','chatgpt.com/c/','private-user-images.githubusercontent.com','X-Goog-Signature','X-Amz-Signature')
CREDENTIALS=(re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),re.compile(r'\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b'),re.compile(r'\bAKIA[0-9A-Z]{16}\b'),re.compile(r'\bsk-[A-Za-z0-9_-]{20,}\b'))
TEXT_EXT={'.md','.txt','.json','.csv','.tsv','.py','.mjs','.js','.yml','.yaml','.cff',''}
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def resolve(rules,path):
 hits=[]
 for r in rules:
  if any(fnmatch.fnmatch(path,p) for p in r['patterns']):hits.append((r['precedence'],r['licence']))
 return max(hits)[1] if hits else None
m=json.loads(MAN.read_text()); lm=json.loads(LIC.read_text()); fails=[]
if m['status']!='AUTHORISED_FOR_PUBLIC_RELEASE' or m.get('authorised_for_public_release') is not True:fails.append('manifest release status')
expected=set()
for e in m['files']:
 expected.add(e['path']);p=ROOT/e['path']
 if not p.is_file():fails.append('missing '+e['path']);continue
 if p.stat().st_size!=e['bytes'] or sha(p)!=e['sha256']:fails.append('integrity '+e['path'])
 if stat.S_IMODE(p.stat().st_mode)!=int(e['mode'],8):fails.append('mode '+e['path'])
 if resolve(lm['rules'],e['path'])!=e['licence']:fails.append('licence '+e['path'])
for p in ROOT.rglob('*'):
 if p.is_symlink():fails.append('symlink '+p.relative_to(ROOT).as_posix())
 if not p.is_file():continue
 rel=p.relative_to(ROOT).as_posix()
 if rel not in expected and rel!='PUBLIC_FILE_MANIFEST.json':fails.append('unmanifested '+rel)
 if rel.startswith(FORBIDDEN_PATHS):fails.append('forbidden path '+rel)
 if p.suffix.lower() in TEXT_EXT and p.stat().st_size<16*1024*1024:
  if rel == 'validation/validate_public_candidate.py':continue
  text=p.read_text('utf-8',errors='replace')
  for f in FORBIDDEN_FRAGMENTS:
   if f in text:fails.append(f'private fragment {f} in {rel}')
  for rx in CREDENTIALS:
   if rx.search(text):fails.append('credential-like material '+rel)
  if p.suffix=='.json':
   try:json.loads(text)
   except Exception as x:fails.append(f'json parse {rel}: {x}')
for req in ['README.md','CITATION.cff','metadata/zenodo-deposit.json','LICENSE','LICENSE-POLICY.md','NOTICE.md','PUBLIC_RELEASE_GATE.json','REMOTE_PUBLICATION_PLAN.json','licensing/licence-map.json','licensing/RIGHTS_CONFIRMATION.md','data/study2/I06B_FINAL_PHASE_CLOSEOUT.json']:
 if not (ROOT/req).is_file():fails.append('required missing '+req)
gate=json.loads((ROOT/'PUBLIC_RELEASE_GATE.json').read_text())
if gate.get('authorised_for_public_release') is not True:fails.append('release gate closed')
if gate.get('historical_private_repository_must_remain_unchanged') is not True:fails.append('historical repo protection absent')
cff=yaml.safe_load((ROOT/'CITATION.cff').read_text())
if [a.get('family-names') for a in cff.get('authors',[])]!=['Toma','Clim']:fails.append('creator order')
if cff.get('version')!='1.0.0':fails.append('citation version')
zm=json.loads((ROOT/'metadata/zenodo-deposit.json').read_text())
if [a.get('name') for a in zm.get('creators',[])]!=['Toma, Andrei','Clim, Antonio']:fails.append('zenodo creator order')
if zm.get('version')!='1.0.0' or zm.get('upload_type')!='software':fails.append('zenodo metadata')
if fails:
 print('\n'.join('- '+x for x in fails));sys.exit(1)
print(f"PASS_PUBLIC_RELEASE_TREE_INTEGRITY_PRIVACY_LICENCE_METADATA_AND_GATE files={len(expected)}")
