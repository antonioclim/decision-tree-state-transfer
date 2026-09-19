import assert from 'node:assert/strict';
import test from 'node:test';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { PrequentialSession } from '../assets/code/confirmatory/session.mjs';
import { validateRuntimePayload, validateProtocolRecord } from '../assets/code/confirmatory/record-contract.mjs';
const row = { attempt_id:'FIXTURE',protocol_sha256:'a'.repeat(64),event_sequence:4,run_id:'FIXTURE',observation_index:2001,
  prediction:0,label:1,loss:1,imputed_failure:false,model_sha256:'b'.repeat(64),input_event_sequence:1,predict_event_sequence:2,
  reveal_event_sequence:3,observed_data_last_index:2000,prediction_ns:10,prediction_predicate_tests:1 };
test('minimum prediction payload is checked against the preserved Phase 9 schema', () => {
  assert.equal(validateProtocolRecord('prediction',row),true);
  assert.equal(validateRuntimePayload({kind:'prediction',...row}),true);
  assert.throws(()=>validateProtocolRecord('prediction',{kind:'prediction',...row}));
});
test('strict payload checks reject missing, extra, unsafe, nonfinite and mistyped fields', () => {
  for(const change of [(r)=>{delete r.loss;},(r)=>{r.surprise=1;},(r)=>{r.event_sequence=2**53;},(r)=>{r.prediction_ns=NaN;},
    (r)=>{r.label=2;},(r)=>{r.imputed_failure=0;},(r)=>{r.model_sha256='bad';},(r)=>{r.attempt_id='';},(r)=>{r.prediction_ns=-1;}]) {
    const bad=structuredClone(row);change(bad);assert.throws(()=>validateProtocolRecord('prediction',bad));
  }
  assert.throws(()=>validateProtocolRecord('unknown',row));assert.throws(()=>validateProtocolRecord('prediction',null));
});
test('failure prediction permits null model and prediction without relaxing binary label/loss', () => {
  assert.ok(validateProtocolRecord('prediction',{...row,prediction:null,model_sha256:null,imputed_failure:true}));
  // Cross-record loss consistency remains the separate chronology validator's responsibility.
});
test('full-sized runtime predictions and committed APW updates conform to the fixed payload', () => {
  const rows=Array.from({length:40},(_,i)=>({index:1961+i,x:Array(8).fill(i/40),y:Number(i>=20)}));
  const learner=new EvolutionLearner({key:'0123456789abcdef'});learner.initialise(rows);
  const events=[];const s=new PrequentialSession({learner,window:rows,cap:1000000,protocolHash:'a'.repeat(64),emit:(e)=>events.push(e)});
  for(let i=2001;i<=2100;i++){s.input({index:i,x:Array(8).fill(.2)});s.predict();s.reveal(0);}s.adapt();
  const governed=events.filter((e)=>['prediction','update'].includes(e.kind));assert.equal(governed.length,101);
  for(const e of governed)assert.ok(validateRuntimePayload(e));
});
