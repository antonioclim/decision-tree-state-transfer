import assert from 'node:assert/strict';
import test from 'node:test';
import { validateF02Record } from '../assets/code/confirmatory/f02-record-contract.mjs';
const base={schema_version:1,partition:'DEV',scenario:'LOCAL_TREE-ABRUPT-MILD',realisation:0,optimiser:0,checkpoint:10000,
  status:'COMPLETE',predictions:2000,loss:.1,resource:{adaptation_apw_total:10}};
test('F02 complete state and material records are strict DEV records',()=>{
  assert.ok(validateF02Record({...base,kind:'state',treatment:'PERSIST'}));
  assert.ok(validateF02Record({...base,kind:'material',treatment:'MATERIAL-REPLACE',eligible:true}));
  assert.throws(()=>validateF02Record({...base,partition:'CONF',kind:'state',treatment:'PERSIST'}));
});
test('state scientific failures retain full-horizon losses',()=>{
  assert.ok(validateF02Record({...base,kind:'state',treatment:'PERSIST',status:'ALGORITHMIC_FAILURE',loss:.7}));
  assert.ok(validateF02Record({...base,kind:'state',treatment:'PERSIST',status:'TREATMENT_UNAVAILABLE',loss:1}));
  assert.throws(()=>validateF02Record({...base,kind:'state',treatment:'PERSIST',status:'TREATMENT_UNAVAILABLE',loss:.9}));
  assert.throws(()=>validateF02Record({...base,kind:'state',treatment:'PERSIST',predictions:0}));
});
test('material ineligibility keeps a complete denominator instead of null loss',()=>{
  assert.ok(validateF02Record({...base,kind:'material',treatment:'STRUCTURAL-SHAM',eligible:false,status:'NO_ELIGIBLE_SITE',loss:.2}));
  assert.ok(validateF02Record({...base,kind:'material',treatment:'STRUCTURAL-SHAM',eligible:false,status:'PARENT_UNAVAILABLE',loss:1}));
  assert.throws(()=>validateF02Record({...base,kind:'material',treatment:'STRUCTURAL-SHAM',eligible:false,status:'PARENT_UNAVAILABLE',loss:.8}));
  assert.throws(()=>validateF02Record({...base,kind:'material',treatment:'STRUCTURAL-SHAM',eligible:false,status:'NO_ELIGIBLE_SITE',loss:null}));
  assert.throws(()=>validateF02Record({...base,kind:'material',treatment:'STRUCTURAL-SHAM',eligible:false,status:'COMPLETE'}));
});
