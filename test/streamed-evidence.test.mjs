import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readCanonicalEvents, AttemptWriter, inspectAttempt } from '../assets/code/confirmatory/evidence.mjs';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { PrequentialSession } from '../assets/code/confirmatory/session.mjs';
function tmp(fn){const d=fs.mkdtempSync(path.join(os.tmpdir(),'dt-p10c-read-'));try{return fn(d);}finally{fs.rmSync(d,{recursive:true,force:true});}}
function read(d,bytes,options={}){const p=path.join(d,'events.jsonl');fs.writeFileSync(p,bytes);const audit={};const values=[...readCanonicalEvents(p,audit,options)];return {values,audit};}
test('stream reader hashes all bytes and handles Unicode across the 64 KiB boundary',()=>tmp(d=>{
  const bytes=Buffer.from(JSON.stringify({x:'a'.repeat(65520)+'αβγ😀'})+'\n'+JSON.stringify({i:2})+'\n');
  const r=read(d,bytes);assert.equal(r.values.length,2);assert.equal(r.audit.bytes,bytes.length);assert.equal(r.audit.rows,2);assert.equal(r.audit.sha256,createHash('sha256').update(bytes).digest('hex'));
}));
for(const [name,bytes] of [['empty',''],['missing newline','{"x":1}'],['blank line','\n'],['duplicates','{"x":0,"x":1}\n'],['noncanonical','{ "x": 1 }\n'],['nonfinite','{"x":1e999}\n']]) {
  test(`stream reader rejects ${name}`,()=>tmp(d=>assert.throws(()=>read(d,bytes))));
}
test('invalid UTF-8 is not silently rewritten',()=>tmp(d=>assert.throws(()=>read(d,Buffer.from([123,34,120,34,58,34,255,34,125,10])))));
test('unfinished oversized input is rejected before loading a complete file',()=>tmp(d=>assert.throws(()=>read(d,'x'.repeat(200000),{maxLineBytes:1000}))));
test('complete oversized event is rejected',()=>tmp(d=>assert.throws(()=>read(d,'{"x":"'+'a'.repeat(50)+'"}\n',{maxLineBytes:20}))));
test('invalid line caps rejected',()=>tmp(d=>assert.throws(()=>read(d,'{}\n',{maxLineBytes:0}))));
function attempt(d,failed) {
  const meta={partition:'FIXTURE',attempt_id:'x',run_id:'r',protocol_sha256:'a'.repeat(64),parent_unavailable:failed};
  const rows=Array.from({length:40},(_,i)=>({index:1961+i,x:[i/40,0],y:i%2}));
  const config={populationSize:8,cartDescendants:3,elitism:1,featureCount:2,maxInitialDepth:2,maxTreeDepth:3,cartMaxDepth:3,cartMinLeaf:2,tournamentSize:3,thresholdsPerFeature:5};
  const learner=new EvolutionLearner({key:'0123456789abcdef',config});learner.initialise(rows,2000,{cap:failed?0:100000});
  const w=new AttemptWriter(path.join(d,'a'),meta);
  const s=new PrequentialSession({learner,window:rows,cap:0,protocolHash:meta.protocol_sha256,emit:e=>w.append(e),attemptId:'x',runId:'r',pendingUpdate:true});
  s.adapt();s.input({index:2001,x:[.1,0]});s.predict();s.reveal(0);w.finish(failed?'ALGORITHMIC_FAILURE':'COMPLETE');return path.join(d,'a');
}
const opts={firstIndex:2001,lastIndex:2001,requireInitialUpdate:true,requireFailurePolicy:true};
test('streamed failed attempt closes with explicit denominator',()=>tmp(d=>{
  const a=attempt(d,true);const result=inspectAttempt(a,{...opts,initialFailure:true});assert.equal(result.failure_slots,1);assert.equal(result.scientific_admission,false);
}));
test('a failed trace cannot be certified COMPLETE',()=>tmp(d=>{
  const a=attempt(d,true);const p=path.join(a,'finished.json');const m=JSON.parse(fs.readFileSync(p));m.status='COMPLETE';fs.writeFileSync(p,JSON.stringify(m));assert.throws(()=>inspectAttempt(a,{...opts,initialFailure:true}),/closure/);
}));
test('a healthy trace cannot be relabelled ALGORITHMIC_FAILURE',()=>tmp(d=>{
  const a=attempt(d,false);const p=path.join(a,'finished.json');const m=JSON.parse(fs.readFileSync(p));m.status='ALGORITHMIC_FAILURE';fs.writeFileSync(p,JSON.stringify(m));assert.throws(()=>inspectAttempt(a,opts),/closure/);
}));
test('caller cannot override the initial parent availability',()=>tmp(d=>{
  const a=attempt(d,true);assert.throws(()=>inspectAttempt(a,opts),/initial failure/);
}));
test('physical digest is verified after complete streaming consumption',()=>tmp(d=>{
  const a=attempt(d,false);const p=path.join(a,'finished.json');const m=JSON.parse(fs.readFileSync(p));m.events_sha256='0'.repeat(64);fs.writeFileSync(p,JSON.stringify(m));assert.throws(()=>inspectAttempt(a,opts),/corrupt/);
}));
