import assert from 'node:assert/strict';
import test from 'node:test';
import { F02_STATE_ARMS, f02BudgetTag } from '../assets/code/confirmatory/f02-state.mjs';
import { validateF02Record } from '../assets/code/confirmatory/f02-record-contract.mjs';

const state={schema_version:1,partition:'DEV',kind:'state',scenario:'S',realisation:0,optimiser:0,checkpoint:10000,
  treatment:'PERSIST',status:'COMPLETE',predictions:2000,loss:.2,resource:{adaptation_apw_total:10}};
const material={schema_version:1,partition:'DEV',kind:'material',scenario:'S',realisation:0,optimiser:0,checkpoint:10000,
  treatment:'MATERIAL-REPLACE',status:'COMPLETE',eligible:true,predictions:2000,loss:.2,resource:{adaptation_apw_total:10}};

test('state arm count is frozen at three',()=>assert.equal(F02_STATE_ARMS.length,3));
test('state arm names are unique',()=>assert.equal(new Set(F02_STATE_ARMS).size,F02_STATE_ARMS.length));
test('historical generic RESTART alias is not publication-facing F02 state arm',()=>assert.equal(F02_STATE_ARMS.includes('RESTART'),false));
test('historical generic CHAMPION alias is not publication-facing F02 state arm',()=>assert.equal(F02_STATE_ARMS.includes('CHAMPION'),false));
test('budget tag repeats exactly',()=>assert.equal(f02BudgetTag('B','PERSIST'),f02BudgetTag('B','PERSIST')));
test('budget tag contains treatment origin',()=>assert.equal(f02BudgetTag('B','RESTART-CART'),'B|origin=RESTART-CART'));
test('budget tag rejects unknown treatment',()=>assert.throws(()=>f02BudgetTag('B','UNKNOWN')));
test('budget tag rejects empty base',()=>assert.throws(()=>f02BudgetTag('','PERSIST')));
test('record contract rejects unknown kind',()=>assert.throws(()=>validateF02Record({...state,kind:'other'})));
test('record contract rejects unknown state treatment',()=>assert.throws(()=>validateF02Record({...state,treatment:'RESTART'})));
test('record contract rejects unknown material treatment',()=>assert.throws(()=>validateF02Record({...material,treatment:'SUBTREE_REFIT'})));
test('record contract rejects negative realisation',()=>assert.throws(()=>validateF02Record({...state,realisation:-1})));
test('record contract rejects negative optimiser',()=>assert.throws(()=>validateF02Record({...state,optimiser:-1})));
test('record contract rejects negative checkpoint',()=>assert.throws(()=>validateF02Record({...state,checkpoint:-1})));
test('record contract rejects boolean prediction denominator',()=>assert.throws(()=>validateF02Record({...state,predictions:true})));
test('record contract rejects zero prediction denominator',()=>assert.throws(()=>validateF02Record({...state,predictions:0})));
test('record contract rejects NaN loss',()=>assert.throws(()=>validateF02Record({...state,loss:NaN})));
test('record contract rejects loss above one',()=>assert.throws(()=>validateF02Record({...state,loss:1.001})));
test('record contract rejects missing resource object',()=>{const r={...state};delete r.resource;assert.throws(()=>validateF02Record(r));});
test('record contract rejects invalid status',()=>assert.throws(()=>validateF02Record({...state,status:'INTERRUPTED'})));
test('material record requires explicit eligibility',()=>{const r={...material};delete r.eligible;assert.throws(()=>validateF02Record(r));});
test('eligible material cannot be marked NO_ELIGIBLE_SITE',()=>assert.throws(()=>validateF02Record({...material,status:'NO_ELIGIBLE_SITE'})));
test('ineligible material cannot be marked COMPLETE',()=>assert.throws(()=>validateF02Record({...material,eligible:false,status:'COMPLETE'})));
test('parent-unavailable material requires loss one',()=>assert.throws(()=>validateF02Record({...material,eligible:false,status:'PARENT_UNAVAILABLE',loss:.999})));
test('NO_ELIGIBLE_SITE retains finite parent loss',()=>assert.equal(validateF02Record({...material,eligible:false,status:'NO_ELIGIBLE_SITE',loss:.37}),true));
test('state treatment-unavailable loss one is admitted',()=>assert.equal(validateF02Record({...state,status:'TREATMENT_UNAVAILABLE',loss:1}),true));
test('state treatment-unavailable loss below one is rejected',()=>assert.throws(()=>validateF02Record({...state,status:'TREATMENT_UNAVAILABLE',loss:.999})));
test('state algorithmic failure keeps an observed full-horizon loss',()=>assert.equal(validateF02Record({...state,status:'ALGORITHMIC_FAILURE',loss:.73}),true));
test('FIXTURE cannot masquerade as DEV evidence record',()=>assert.throws(()=>validateF02Record({...state,partition:'FIXTURE'})));
