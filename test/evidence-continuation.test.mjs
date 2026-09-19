import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { strictJson, AttemptWriter, validateChronology } from '../assets/code/confirmatory/evidence.mjs';
import { COMPONENTS } from '../assets/code/confirmatory/work.mjs';
const metadata = { partition: 'FIXTURE', attempt_id: 'TRACE', run_id: 'TRACE', protocol_sha256: 'a'.repeat(64) };
function trace(start = 99, end = 101, includeTerminal = true) {
  const events = []; const add = (e) => events.push({ ...metadata, ...e, event_sequence: events.length + 1 });
  for (let i = start; i <= end; i++) {
    const s = events.length;
    add({ kind: 'input', observation_index: i, observed_data_last_index: i - 1, x: [0.1] });
    add({ kind: 'predict', observation_index: i, prediction: 0, model_sha256: 'b'.repeat(64) });
    add({ kind: 'reveal', observation_index: i, label: 0 });
    add({ kind: 'prediction', observation_index: i, prediction: 0, label: 0, loss: 0, imputed_failure: false,
      model_sha256: 'b'.repeat(64), observed_data_last_index: i - 1, input_event_sequence: s + 1,
      predict_event_sequence: s + 2, reveal_event_sequence: s + 3 });
    if (i % 100 === 0 && (i < end || includeTerminal)) add({ kind: 'update', revealed_through_index: i,
      window_first_index: Math.max(1, i - 499), window_last_index: i, budget_axis: 'APW_v1', budget_cap: 100,
      apw_components: Object.fromEntries(COMPONENTS.map((k) => [k, 0])), adaptation_apw_total: 0 });
  }
  return events;
}
function renumber(events) {
  // Preserve explicit prediction references while removing or duplicating a non-prediction event.
  const references = new Map(events.map((e, i) => [e.event_sequence, i + 1]));
  for (const [i,e] of events.entries()) {
    for (const k of ['input_event_sequence','predict_event_sequence','reveal_event_sequence']) if (e[k] !== undefined) e[k] = references.get(e[k]);
    e.event_sequence = i + 1;
  }
  return events;
}
test('complete scheduled event trace is accepted', () => assert.equal(validateChronology(trace(), { firstIndex: 99, lastIndex: 101 }).predictions, 3));
test('omitted mid-horizon update is rejected even after resequencing', () => {
  const e=renumber(trace().filter((r)=>r.kind!=='update'));
  assert.throws(()=>validateChronology(e,{firstIndex:99,lastIndex:101}),/input boundary/);
});
test('duplicate updates at one boundary are rejected', () => {
  const e=trace();e.splice(9,0,structuredClone(e[8]));renumber(e);
  assert.throws(()=>validateChronology(e,{firstIndex:99,lastIndex:101}));
});
test('contradictory predict/record model identity is rejected', () => {
  const e=trace();e[3].model_sha256='c'.repeat(64);
  assert.throws(()=>validateChronology(e,{firstIndex:99,lastIndex:101}),/prediction evidence/);
});
test('predict events cannot carry a hidden y label', () => {
  const e=trace();e[1].y=0;assert.throws(()=>validateChronology(e,{firstIndex:99,lastIndex:101}),/predict event/);
});
test('invalid model hash is rejected', () => {
  const e=trace();e[1].model_sha256='x';assert.throws(()=>validateChronology(e,{firstIndex:99,lastIndex:101}));
});
test('failed prediction cannot claim a deployed model', () => {
  const e=trace();e[1].prediction=null;assert.throws(()=>validateChronology(e,{firstIndex:99,lastIndex:101}));
});
test('terminal update policy is explicit rather than silently inferred', () => {
  const e=trace(99,100,false);
  assert.equal(validateChronology(e,{firstIndex:99,lastIndex:100}).predictions,2);
  assert.throws(()=>validateChronology(e,{firstIndex:99,lastIndex:100,requireTerminalUpdate:true}),/incomplete/);
  assert.equal(validateChronology(trace(99,100),{firstIndex:99,lastIndex:100,requireTerminalUpdate:true}).predictions,2);
});
test('a required initial intervention cannot be omitted', () => {
  assert.throws(()=>validateChronology(trace(101,102),{firstIndex:101,lastIndex:102,requireInitialUpdate:true}),/input boundary/);
});
test('strict JSON accepts finite plain records and shared acyclic objects', () => {
  const child={value:1};assert.equal(strictJson({a:child,b:child}),'{"a":{"value":1},"b":{"value":1}}');
  assert.equal(strictJson([null,true,1,'x']), '[null,true,1,"x"]');
});
for (const [label,value] of [['NaN',NaN],['infinity',Infinity],['undefined',undefined],['bigint',1n],['function',()=>1],['date',new Date(0)]]) {
  test(`strict JSON rejects ${label} rather than silently rewriting it`,()=>assert.throws(()=>strictJson({value})));
}
test('strict JSON rejects cycles, sparse arrays, symbols and accessors', () => {
  const cycle={a:null};cycle.a=cycle;assert.throws(()=>strictJson(cycle));
  assert.throws(()=>strictJson(Array(2)));assert.throws(()=>strictJson({[Symbol('x')]:1}));
  assert.throws(()=>strictJson({get x(){return 1;}}));
});
test('invalid evidence does not change rows or physical byte count', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dt-p10b-writer-'));
  try {
    const w=new AttemptWriter(path.join(root,'attempt'),metadata);
    assert.throws(()=>w.append({x:NaN}));assert.equal(w.rows,0);assert.equal(w.bytes,0);
    w.append({x:1});const report=w.finish('COMPLETE');assert.equal(report.evidence_rows,1);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('partial system writes are looped and hashed exactly once', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dt-p10b-short-'));const original=fs.writeSync;
  try {
    const w=new AttemptWriter(path.join(root,'attempt'),metadata);
    const spy=t.mock.method(fs,'writeSync',(fd,bytes,offset,length)=>original(fd,bytes,offset,Math.min(length,3)));
    w.append({word:'αβγ'});spy.mock.restore();const report=w.finish('COMPLETE');
    const actual=fs.readFileSync(path.join(root,'attempt/events.jsonl'));
    assert.equal(actual.toString(),'{"word":"αβγ"}\n');assert.equal(report.evidence_bytes,actual.length);
    assert.equal(report.events_sha256,createHash('sha256').update(actual).digest('hex'));
  } finally {t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});
test('a torn write cannot be promoted to a complete attempt', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dt-p10b-torn-'));const original=fs.writeSync;
  try {
    const w=new AttemptWriter(path.join(root,'attempt'),metadata);let calls=0;
    const spy=t.mock.method(fs,'writeSync',(fd,bytes,offset,length)=>{
      if(calls++)throw new Error('injected storage fault');return original(fd,bytes,offset,Math.min(length,3));
    });
    assert.throws(()=>w.append({word:'unfinished'}));spy.mock.restore();assert.equal(w.poisoned,true);
    assert.throws(()=>w.append({x:1}));assert.throws(()=>w.finish('COMPLETE'));
    const report=w.finish('INFRASTRUCTURE_INTERRUPTION');const actual=fs.readFileSync(path.join(root,'attempt/events.jsonl'));
    assert.equal(report.evidence_rows,0);assert.equal(report.evidence_bytes,3);
    assert.equal(report.events_sha256,createHash('sha256').update(actual).digest('hex'));
  } finally {t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});
test('non-progressing writes poison the attempt instead of hanging', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dt-p10b-zero-'));
  try {
    const w=new AttemptWriter(path.join(root,'attempt'),metadata);const spy=t.mock.method(fs,'writeSync',()=>0);
    assert.throws(()=>w.append({x:1}));spy.mock.restore();w.finish('INVALIDATED');
  } finally {t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});

test('array serialisers, accessors and hidden fields cannot rewrite evidence', () => {
  const a=[]; a.toJSON=()=>[1]; assert.throws(()=>strictJson(a));
  const b=[1]; Object.defineProperty(b,'0',{get(){return 2;}}); assert.throws(()=>strictJson(b));
  const c={x:1}; Object.defineProperty(c,'hidden',{value:undefined,enumerable:false});assert.throws(()=>strictJson(c));
});
test('update-boundary options require literal booleans and an actual boundary', () => {
  assert.throws(()=>validateChronology(trace(),{firstIndex:99,lastIndex:101,requireInitialUpdate:true}),/boundary policy/);
  assert.throws(()=>validateChronology(trace(),{firstIndex:99,lastIndex:101,requireTerminalUpdate:'true'}),/boundary policy/);
});
