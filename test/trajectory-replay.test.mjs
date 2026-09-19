import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { CONFIG } from '../assets/code/confirmatory/learner.mjs';
import { hashObject } from '../assets/code/confirmatory/session.mjs';
import { strictJson } from '../assets/code/confirmatory/evidence.mjs';
import { ChunkedEvidenceWriter, readChunkedEvents } from '../assets/code/confirmatory/chunked-evidence.mjs';
import { recordTrajectory, verifyTrajectory, validateReplayPlan, deterministicEvent } from '../assets/code/confirmatory/trajectory-replay.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'apw-replay-'));
after(() => fs.rmSync(tmp, { recursive:true, force:true }));
const sha = b => createHash('sha256').update(b).digest('hex');
const protocol = sha(fs.readFileSync(new URL('../working/phase9/PROTOCOL_SPEC.json', import.meta.url)));
const config = { ...CONFIG, populationSize:6, cartDescendants:3, elitism:1, tournamentSize:2,
  maxInitialDepth:2, maxTreeDepth:3, thresholdsPerFeature:3, cartMaxDepth:3 };
const plan = { schema_version:1, scope:'FIXTURE', partition:'DEV', scenario:'OBLIQUE-ABRUPT-SEVERE', realisation:0, optimiser:0,
  protocol_sha256:protocol, arm:'PARENT', start:500, end:700, apw_cap:20000, budget_tag:'2', config,
  provenance_prefix:'UNIT-PARENT', run_id:'UNIT-PARENT', attempt_id:'UNIT-PARENT', parent_session_sha256:null, save_checkpoints:[600] };
const original = path.join(tmp,'original'); const recorded = recordTrajectory(original,plan);
let serial = 0;
function copy() { const dir = path.join(tmp,`case-${++serial}`); fs.cpSync(original,dir,{ recursive:true }); return dir; }
function saveCapsule(dir,c) { const b=Buffer.from(strictJson(c)+'\n');fs.writeFileSync(path.join(dir,'CAPSULE.json'),b);return sha(b); }
function readCapsule(dir) { return JSON.parse(fs.readFileSync(path.join(dir,'CAPSULE.json'),'utf8')); }
function verify(dir, p=plan, anchor=null, parent=null) { return verifyTrajectory(dir,p,{ capsuleSha256:anchor??sha(fs.readFileSync(path.join(dir,'CAPSULE.json'))),parent }); }
function corruptEvents(dir, name, mutate) {
  const c=readCapsule(dir);const key=name==='events'?'event_manifest_sha256':'provenance_manifest_sha256';
  const rows=[...readChunkedEvents(path.join(dir,name),{}, { expectedManifestSha256:c[key] })];mutate(rows);
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,name,'finished.json')));
  fs.rmSync(path.join(dir,name),{recursive:true});const w=new ChunkedEvidenceWriter(path.join(dir,name),manifest.metadata);
  rows.forEach(e=>w.append(e));c[key]=w.finish(c.status).manifest_sha256;saveCapsule(dir,c);
}

test('full archived APW fixture replays every source row, event, state and provenance record',()=>{
  const r=verify(original);assert.equal(r.predictions,200);assert.equal(r.updates,2);assert.equal(r.snapshots_compared,5);
  assert.equal(r.provenance_records_compared,recorded.capsule.summary.provenance_sha256? r.provenance_archive.rows:0);
  assert.equal(r.scientific_admission,false);assert.equal(r.confirmation_authorised,false);
});
test('parent replay yields exactly the pre-update checkpoint used for each fork',()=>{
  const r=verify(original);assert.equal(hashObject(r.checkpoints[600]),hashObject(recorded.checkpoints[600]));
  assert.equal(r.checkpoints[600].pendingUpdate,true);
});
for(const arm of ['PERSIST','RESTART','CHAMPION','NO_CROSSOVER','NO_MUTATION','RANDOM_RESTART','TEMPLATE_REFIT']){
  test(`${arm} fixture is an actual learner replay, not a receipt placeholder`,()=>{
    const parent=recorded.checkpoints[600];const p={...plan,arm,start:600,end:800,save_checkpoints:[],parent_session_sha256:hashObject(parent),
      provenance_prefix:`UNIT-${arm}`,run_id:arm,attempt_id:arm};
    const dir=path.join(tmp,`fork-${arm}`);recordTrajectory(dir,p,parent);const r=verify(dir,p,null,parent);
    assert.equal(r.updates,3);assert.equal(r.predictions,200);
  });
}
test('a failed restart retains every loss-one slot and every unavailable update',()=>{
  const parent=recorded.checkpoints[600];const p={...plan,arm:'RESTART',start:600,end:800,apw_cap:0,save_checkpoints:[],parent_session_sha256:hashObject(parent)};
  const dir=path.join(tmp,'failed');recordTrajectory(dir,p,parent);const r=verify(dir,p,null,parent);
  assert.equal(r.failed,true);assert.equal(r.failure_slots,200);assert.equal(r.chronology.unavailable_updates,2);
});
test('recording cannot overwrite a previous successful attempt',()=>assert.throws(()=>recordTrajectory(original,plan)));
test('an independently supplied capsule digest is mandatory',()=>assert.throws(()=>verifyTrajectory(original,plan)));
test('the wrong external digest is not replaced with a locally calculated one',()=>assert.throws(()=>verify(original,plan,'0'.repeat(64))));
for(const [name,mutate] of [
  ['CONF',p=>{p.partition='CONF';}],['unknown field',p=>{p.approved=true;}],['protocol',p=>{p.protocol_sha256='0'.repeat(64);}],
  ['optimiser boolean',p=>{p.optimiser=true;}],['unknown arm',p=>{p.arm='OTHER';}],['range',p=>{p.end=499;}],
  ['APW boolean',p=>{p.apw_cap=true;}],['CPU budget',p=>{p.budget_tag='CPU';}],['namespace traversal',p=>{p.provenance_prefix='../bad';}],
  ['duplicate checkpoint',p=>{p.save_checkpoints=[600,600];}],['checkpoint beyond run',p=>{p.save_checkpoints=[800];}],
  ['incorrect config',p=>{p.config.populationSize=0;}],['undeclared fixture promotion',p=>{p.scope='DEV_CHECK';}],
  ['unexpected parent',p=>{p.parent_session_sha256='0'.repeat(64);}],['unknown scenario',p=>{p.scenario='UNKNOWN';}],
])test(`plan rejects ${name} before executing a learner`,()=>{const p=structuredClone(plan);mutate(p);assert.throws(()=>validateReplayPlan(p));});
for(const [name,mutate] of [
  ['prediction',rows=>{rows.find(e=>e.kind==='predict').prediction^=1;}],
  ['label',rows=>{rows.find(e=>e.kind==='reveal').label^=1;}],
  ['features',rows=>{rows.find(e=>e.kind==='input').x[0]+=1;}],
  ['loss',rows=>{rows.find(e=>e.kind==='prediction').loss^=1;}],
  ['work with preserved sum',rows=>{const e=rows.find(x=>x.kind==='update');e.apw_components.rng_variate++;e.adaptation_apw_total++;}],
  ['missing update',rows=>{rows.splice(rows.findIndex(x=>x.kind==='update'),1);}],
  ['extra event',rows=>{rows.push({...rows.at(-1)});}],
  ['run identity',rows=>{rows[0].run_id='OTHER';}],
  ['future information',rows=>{rows.find(x=>x.kind==='input').label=0;}],
  ['negative measured clock',rows=>{rows.find(x=>x.kind==='prediction').prediction_ns=-1;}],
])test(`rehashing the archive does not rescue a changed ${name}`,()=>{const dir=copy();corruptEvents(dir,'events',mutate);assert.throws(()=>verify(dir));});
test('rehashed provenance with an altered actual copy is rejected by replay',()=>{
  const dir=copy();corruptEvents(dir,'provenance',rows=>{rows[0].id='forged';});assert.throws(()=>verify(dir));
});
test('a missing provenance suffix is rejected even after every file hash is recomputed',()=>{
  const dir=copy();corruptEvents(dir,'provenance',rows=>rows.pop());assert.throws(()=>verify(dir));
});
test('nonnegative changed clocks are deliberately outside the deterministic claim',()=>{
  const dir=copy();corruptEvents(dir,'events',rows=>{rows.filter(e=>e.kind==='prediction').forEach(e=>{e.prediction_ns=0;});});
  assert.equal(verify(dir).timing_values_reproduced,false);
});
for(const [name,mutate] of [
  ['summary',c=>{c.summary.predictions++;}],['source hash',c=>{c.sources['assets/code/confirmatory/trees.mjs']='0'.repeat(64);}],
  ['promotion',c=>{c.scientific_admission=true;}],['closure',c=>{c.status='ALGORITHMIC_FAILURE';}],
  ['snapshot traversal',c=>{c.snapshots[0].file='../initial.json.gz';}],['duplicate snapshot',c=>{c.snapshots.push(c.snapshots[0]);}],
])test(`rehashed capsule rejects ${name}`,()=>{const dir=copy();const c=readCapsule(dir);mutate(c);saveCapsule(dir,c);assert.throws(()=>verify(dir));});
test('an internally plausible but changed snapshot is rejected after recompression and rehashing',()=>{
  const dir=copy();const c=readCapsule(dir);const s=c.snapshots[0];const file=path.join(dir,'snapshots',s.file);
  const state=JSON.parse(gunzipSync(fs.readFileSync(file)));state.nextOrdinal++;const raw=Buffer.from(strictJson(state)+'\n');const gzip=gzipSync(raw);
  fs.writeFileSync(file,gzip);Object.assign(s,{raw_bytes:raw.length,gzip_bytes:gzip.length,sha256:sha(raw),gzip_sha256:sha(gzip)});
  saveCapsule(dir,c);assert.throws(()=>verify(dir));
});
for(const kind of ['root','snapshot'])test(`unlisted ${kind} file is rejected`,()=>{
  const dir=copy();fs.writeFileSync(path.join(dir,kind==='root'?'extra':'snapshots/extra'),'x');assert.throws(()=>verify(dir));
});
test('snapshot symlinks are not followed',()=>{
  const dir=copy();const file=path.join(dir,'snapshots','initial.json.gz');fs.unlinkSync(file);fs.symlinkSync(path.join(original,'snapshots','initial.json.gz'),file);assert.throws(()=>verify(dir));
});
test('archive directory symlinks are not followed',()=>{
  const dir=copy();fs.rmSync(path.join(dir,'events'),{recursive:true});fs.symlinkSync(path.join(original,'events'),path.join(dir,'events'));assert.throws(()=>verify(dir));
});
for(const [name,mutate]of[
  ['future scoring',p=>{p.learner.scoredThrough=601;}],['past label',p=>{p.window[0].y^=1;}],
  ['key',p=>{p.learner.key='0'.repeat(16);}],['pending flag',p=>{p.pendingUpdate=false;}],
])test(`rehashed parent still rejects ${name}`,()=>{
  const parent=structuredClone(recorded.checkpoints[600]);mutate(parent);
  const p={...plan,arm:'PERSIST',start:600,end:800,save_checkpoints:[],parent_session_sha256:hashObject(parent)};
  assert.throws(()=>validateReplayPlan(p,parent));
});
test('nonfinite measured clock is rejected before comparison',()=>assert.throws(()=>deterministicEvent({kind:'prediction',prediction_ns:Infinity})));

test('a source alteration passes chronology alone but fails source-bound replay',async()=>{
  const {validateChronology}=await import('../assets/code/confirmatory/evidence.mjs');
  const dir=copy();corruptEvents(dir,'events',rows=>{rows.find(e=>e.kind==='input').x[0]+=0.1;});const c=readCapsule(dir);
  const r=validateChronology(readChunkedEvents(path.join(dir,'events'),{},{expectedManifestSha256:c.event_manifest_sha256}),
    {firstIndex:501,lastIndex:700,requireTerminalUpdate:true,requireFailurePolicy:true});
  assert.equal(r.predictions,200);assert.throws(()=>verify(dir),/source-bound event mismatch/);
});
test('a self-consistent false APW count passes chronology but not deterministic replay',async()=>{
  const {validateChronology}=await import('../assets/code/confirmatory/evidence.mjs');
  const dir=copy();corruptEvents(dir,'events',rows=>{
    const e=rows.find(x=>x.kind==='update');const key=Object.keys(e.apw_components).find(k=>e.apw_components[k]>0);
    e.apw_components[key]--;e.adaptation_apw_total--;
  });const c=readCapsule(dir);
  const r=validateChronology(readChunkedEvents(path.join(dir,'events'),{},{expectedManifestSha256:c.event_manifest_sha256}),
    {firstIndex:501,lastIndex:700,requireTerminalUpdate:true,requireFailurePolicy:true});
  assert.equal(r.predictions,200);assert.throws(()=>verify(dir),/source-bound event mismatch/);
});
