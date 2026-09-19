import assert from 'node:assert/strict';
import test from 'node:test';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { PrequentialSession } from '../assets/code/confirmatory/session.mjs';
import { validateRuntimePayload } from '../assets/code/confirmatory/record-contract.mjs';
import { validateChronology } from '../assets/code/confirmatory/evidence.mjs';
const config = { populationSize: 8, cartDescendants: 3, elitism: 1, featureCount: 2,
  maxInitialDepth: 2, maxTreeDepth: 3, cartMaxDepth: 3, cartMinLeaf: 2, tournamentSize: 3, thresholdsPerFeature: 5 };
const rows=Array.from({length:40},(_,i)=>({index:1961+i,x:[(i%11)/11,(i%7)/7],y:Number(i%11>5)}));
function run({parentFailed=false,arm='RESTART',cap=0}={}) {
  const parent=new EvolutionLearner({key:'0123456789abcdef',config});parent.initialise(rows,2000,{cap:parentFailed?0:100000});
  const original=new PrequentialSession({learner:parent,window:rows,cap,protocolHash:'a'.repeat(64),pendingUpdate:true});
  const events=[];const s=PrequentialSession.fork(original.snapshot(),{arm,cap,emit:e=>events.push(e)});s.adapt();
  for(let i=2001;i<=2200;i++) {s.input({index:i,x:[.2,.8]});s.predict();s.reveal(i%2);if(s.pendingUpdate)s.adapt();}
  return {events,s};
}
const opts={firstIndex:2001,lastIndex:2200,requireInitialUpdate:true,requireTerminalUpdate:true,requireFailurePolicy:true};
function check(events,initialFailure=false){return validateChronology(events,{...opts,initialFailure});}
function reindex(events){const ids=new Map(events.map((e,i)=>[e.event_sequence,i+1]));for(const [i,e] of events.entries()){for(const k of ['input_event_sequence','predict_event_sequence','reveal_event_sequence'])if(k in e)e[k]=ids.get(e[k]);e.event_sequence=i+1;}return events;}
test('cold failure journals every later unavailable update and every loss-one slot',()=>{
  const {events,s}=run();const r=check(events);assert.equal(r.predictions,200);assert.equal(r.failure_slots,200);assert.equal(r.unavailable_updates,2);
  assert.equal(s.treatmentCount,1);assert.equal(events[0].update_outcome,'ALGORITHMIC_FAILURE');
});
test('unavailable parent journals all three boundaries without inventing a treatment',()=>{
  const {events,s}=run({parentFailed:true});const r=check(events,true);assert.equal(r.unavailable_updates,3);assert.equal(r.failure_slots,200);assert.equal(s.treatmentCount,0);
});
test('retained state survives a zero APW allowance without being called freshly scored',()=>{
  const {events}=run({arm:'PERSIST'});const r=check(events);assert.equal(r.failure_slots,0);assert.equal(r.failure_latched,false);
  assert.ok(events.filter(e=>e.kind==='update').every(e=>e.update_outcome==='RETAINED_AFTER_BUDGET_EXHAUSTION'));
});
test('new runtime flags do not alter the legacy chronological route for genuine healthy records',()=>{
  const {events}=run({arm:'PERSIST'});assert.equal(validateChronology(events,{...opts,requireFailurePolicy:false}).predictions,200);
});
test('dropping a skipped update is rejected after event resequencing',()=>{
  const {events}=run();const bad=reindex(events.filter(e=>!(e.kind==='update_unavailable'&&e.revealed_through_index===2100)));assert.throws(()=>check(bad));
});
test('failure cannot silently recover into a valid prediction',()=>{
  const {events}=run();const p=events.find(e=>e.kind==='predict');p.prediction=0;p.model_sha256='b'.repeat(64);assert.throws(()=>check(events),/latched/);
});
test('a null prediction without a declared failure is rejected',()=>{
  const {events}=run({arm:'PERSIST'});const p=events.find(e=>e.kind==='predict');p.prediction=null;p.model_sha256=null;assert.throws(()=>check(events),/latched/);
});
test('skipped failed updates cannot spend APW',()=>{
  const {events}=run();const e=events.find(e=>e.kind==='update_unavailable');e.apw_components.selection_comparison=1;e.adaptation_apw_total=1;e.budget_cap=2;assert.throws(()=>check(events),/unavailable/);
});
test('failure reason must distinguish unavailable parent from later failure',()=>{
  const {events}=run();const e=events.find(e=>e.kind==='update_unavailable');e.reason='PARENT_UNAVAILABLE';assert.throws(()=>check(events),/unavailable/);
});
test('a failed update cannot claim a surviving population',()=>{
  const {events}=run();events[0].population_size=8;assert.throws(()=>check(events),/contradictory/);
});
test('a retained update cannot claim a new mandatory-stage commit',()=>{
  const {events}=run({arm:'PERSIST'});events[0].mandatory_stage_committed=true;assert.throws(()=>check(events),/contradictory/);
});
test('completed scoring is tied to the actual window endpoint',()=>{
  const {events}=run({arm:'PERSIST',cap:30000});assert.equal(events[0].update_outcome,'COMMITTED');check(events);events[0].scored_through_index=999;assert.throws(()=>check(events),/contradictory/);
});
test('invalid failure policy flags are rejected',()=>{
  assert.throws(()=>validateChronology([],{...opts,initialFailure:'yes'}),/failure policy/);
});
test('an unavailable parent may not invent a normal update later',()=>{
  const {events}=run({parentFailed:true});events[0].kind='update';assert.throws(()=>check(events,true),/failure contract/);
});

test('unavailable failure flags are literal booleans, not truthy substitutes',()=>{
  const {events}=run();events.find(e=>e.kind==='update_unavailable').failure_latched=1;
  assert.throws(()=>check(events),/unavailable/);
});
test('cold failure cannot invent a completed mandatory stage',()=>{
  const {events}=run();events[0].mandatory_stage_committed=true;assert.throws(()=>check(events),/contradictory/);
});
test('unsafe aggregate APW is rejected even if component values are individually safe',()=>{
  const {events}=run({arm:'PERSIST'});const e=events[0];e.budget_axis='PROCESS_CPU_NS';
  for(const key of Object.keys(e.apw_components))e.apw_components[key]=Number.MAX_SAFE_INTEGER;
  e.adaptation_apw_total=Object.values(e.apw_components).reduce((a,b)=>a+b,0);
  assert.throws(()=>check(events),/accounting/);
});

test('current payload accepts an explicitly empty failed production population',()=>{
  const {events}=run({cap:1});assert.equal(events[0].population_size,0);assert.equal(validateRuntimePayload(events[0]),true);
});
test('current payload rejects inconsistent mandatory-stage and scoring metadata',()=>{
  const {events}=run({cap:1});const bad=structuredClone(events[0]);bad.mandatory_stage_committed=true;assert.throws(()=>validateRuntimePayload(bad));
  const healthy=run({arm:'PERSIST',cap:30000}).events[0];healthy.population_size=150;
  assert.equal(validateRuntimePayload(healthy),true);healthy.scored_through_index=1999;assert.throws(()=>validateRuntimePayload(healthy));
});
