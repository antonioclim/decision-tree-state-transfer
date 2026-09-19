import assert from 'node:assert/strict';
import test from 'node:test';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { PrequentialSession } from '../assets/code/confirmatory/session.mjs';
import { treeHash } from '../assets/code/confirmatory/trees.mjs';
import { F02_STATE_ARMS, f02BudgetTag, forkF02State } from '../assets/code/confirmatory/f02-state.mjs';

const key='0123456789abcdef'; const protocolHash='a'.repeat(64);
const config={populationSize:8,cartDescendants:3,elitism:1,featureCount:2,maxInitialDepth:2,maxTreeDepth:3,
  cartMaxDepth:3,cartMinLeaf:2,tournamentSize:3,thresholdsPerFeature:5,replacementFraction:.25};
const rows=(end=2000,n=80)=>Array.from({length:n},(_,i)=>{const a=(i%20)/20,b=(Math.floor(i/20)%4)/4;
  return {index:end-n+i+1,x:[a,b],y:Number((a>=.5)!=(b>=.5))};});
function parent(){const l=new EvolutionLearner({key,config});l.initialise(rows());return new PrequentialSession({learner:l,window:rows(),cap:50000,
  protocolHash,pendingUpdate:true}).snapshot();}
function fork(snapshot, options){return forkF02State(snapshot,{...options,integrityStatus:'VERIFIED'});}
const semantics=(r)=>({trees:r.session.learner.population.map(x=>treeHash(x.tree)),champion:treeHash(r.session.learner.champion.tree),
  nextOrdinal:r.session.learner.nextOrdinal,completedUpdates:r.session.learner.completedUpdates,eventSerial:r.session.learner.eventSerial});

test('F02 state arm list is exact',()=>assert.deepEqual(F02_STATE_ARMS,['PERSIST','RESTART-CART','CHAMPION-RESEED']));
test('F02 treatment-origin namespaces are stable and disjoint',()=>{
  assert.equal(f02BudgetTag('2','PERSIST'),'2|origin=PERSIST');
  assert.notEqual(f02BudgetTag('2','RESTART-CART'),f02BudgetTag('2','CHAMPION-RESEED'));
  assert.throws(()=>f02BudgetTag('', 'PERSIST'));
});
test('unverified state/data integrity is blocked before treatment',()=>{
  assert.throws(()=>forkF02State(parent(),{arm:'PERSIST',cap:50000}),/verified parent\/data integrity/);
  assert.throws(()=>forkF02State(parent(),{arm:'RESTART-CART',cap:50000,integrityStatus:'FAILED'}),/verified parent\/data integrity/);
});
test('RESTART-CART is invariant to inherited functional counters',()=>{
  const a=parent(), b=structuredClone(a); b.learner.nextOrdinal+=10000;b.learner.completedUpdates+=100;b.learner.eventSerial+=900;
  const x=fork(a,{arm:'RESTART-CART',cap:50000}); const y=fork(b,{arm:'RESTART-CART',cap:50000});
  assert.equal(x.status,'COMPLETE');assert.equal(y.status,'COMPLETE');assert.deepEqual(semantics(x),semantics(y));
  assert.deepEqual(x.report.apw_components,y.report.apw_components);
});
test('CHAMPION-RESEED is invariant to inherited functional counters',()=>{
  const a=parent(), b=structuredClone(a); b.learner.nextOrdinal+=10000;b.learner.completedUpdates+=100;b.learner.eventSerial+=900;
  const x=fork(a,{arm:'CHAMPION-RESEED',cap:50000}); const y=fork(b,{arm:'CHAMPION-RESEED',cap:50000});
  assert.equal(x.status,'COMPLETE');assert.equal(y.status,'COMPLETE');assert.deepEqual(semantics(x),semantics(y));
  assert.deepEqual(x.report.apw_components,y.report.apw_components);
});
test('same F02 treatment replays exactly while treatment origins remain separate',()=>{
  const s=parent();const a=fork(s,{arm:'RESTART-CART',cap:50000});const b=fork(s,{arm:'RESTART-CART',cap:50000});
  assert.deepEqual(semantics(a),semantics(b));
  const c=fork(s,{arm:'CHAMPION-RESEED',cap:50000});
  assert.equal(c.status,'COMPLETE');assert.equal(c.transferred_champion_sha256,treeHash(EvolutionLearner.restore(s.learner).champion.tree));
  assert.notEqual(a.session.budgetTag,c.session.budgetTag);
});
test('failed persistent state does not prevent RESTART-CART recovery from valid history',()=>{
  const failed=new EvolutionLearner({key,config});failed.initialise(rows(),2000,{cap:0});assert.equal(failed.failed,true);
  const snap=new PrequentialSession({learner:failed,window:rows(),cap:50000,protocolHash,pendingUpdate:true}).snapshot();
  const restart=fork(snap,{arm:'RESTART-CART',cap:50000});assert.equal(restart.status,'COMPLETE');assert.equal(restart.session.learner.failed,false);
  assert.equal(fork(snap,{arm:'PERSIST',cap:50000}).status,'TREATMENT_UNAVAILABLE');
  assert.equal(fork(snap,{arm:'CHAMPION-RESEED',cap:50000}).status,'TREATMENT_UNAVAILABLE');
});
test('cold treatments spend remaining allowance on same-checkpoint evolutionary work',()=>{
  for(const arm of ['RESTART-CART','CHAMPION-RESEED']){
    const r=fork(parent(),{arm,cap:50000});
    assert.ok(r.report.adaptation_apw_total>0 && r.report.adaptation_apw_total<=50000);
    assert.ok(r.report.completed_rounds>0,`${arm} stopped after cold construction`);
    assert.equal(r.session.arm,'PERSIST');assert.equal(r.session.pendingUpdate,false);
  }
});
test('zero cold allowance fails rather than borrowing parent state',()=>{
  const r=fork(parent(),{arm:'RESTART-CART',cap:0});assert.equal(r.status,'ALGORITHMIC_FAILURE');assert.equal(r.session.learner.population.length,0);
});
test('parent snapshot remains unchanged by all F02 state forks',()=>{
  const s=parent();const before=JSON.stringify(s);for(const arm of F02_STATE_ARMS)fork(s,{arm,cap:50000});assert.equal(JSON.stringify(s),before);
});
test('future continuation is persistent after the one-time treatment',()=>{
  const r=fork(parent(),{arm:'RESTART-CART',cap:50000});const i=2001;r.session.input({index:i,x:[.1,.7]});r.session.predict();r.session.reveal(1);
  assert.equal(r.session.arm,'PERSIST');assert.equal(r.session.treatmentPending,false);
});
