import assert from 'node:assert/strict';
import test from 'node:test';
import * as current from '../assets/code/confirmatory/trees.mjs';
import * as reference from '../working/phase10i/reference/trees-10h.mjs';
import { WorkLedger, BudgetExhausted } from '../assets/code/confirmatory/work.mjs';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';

function compare(rows, template, thresholds, extra = {}, record = true) {
  const before = JSON.stringify({ rows, template, thresholds });
  const options = { featureCount: rows[0].x.length, maxDepth: 8, minLeaf: 1, tieAction: 0,
    maxNodes: 511, template, thresholds, ...extra };
  const run = (module) => {
    const events = []; const ledger = new WorkLedger();
    const factory = new module.TreeFactory({ ledger, prefix: 'same-reference', update: 6,
      emit: record ? e => events.push(structuredClone(e)) : null });
    const tree = module.fitCart(rows, factory, options);
    factory.realise(tree, 'individual');
    return { tree, events, ledger };
  };
  const a = run(reference); const b = run(current);
  assert.deepEqual(current.exportTree(b.tree), reference.exportTree(a.tree));
  assert.deepEqual(b.events, a.events);
  for (const row of rows) assert.equal(current.predict(b.tree, row.x), reference.predict(a.tree, row.x));
  assert.equal(JSON.stringify({ rows, template, thresholds }), before);
  return { a, b };
}
const leaf = action => ({ type: 'leaf', action });
const split = (feature, left = leaf(0), right = leaf(1)) => ({ type: 'split', feature, threshold: 100, left, right });
const sample = Array.from({ length: 16 }, (_, i) => ({ index: 1+i, x: [i%8, (i*7)%11], y: Number(i%8 >= 4) }));

for (const [name, rows, shape, cuts, extra] of [
  ['strict less-than at observed values', sample, split(0), [[0,1,2,3,4,5,6,7], [2]], {}],
  ['candidates outside support', sample, split(0), [[-100,0,4,8,100],[2]], {}],
  ['single candidate', sample, split(0), [[4],[2]], {}],
  ['empty candidate set collapses', sample, split(0), [[],[2]], {}],
  ['duplicate candidates', sample, split(0), [[4,4,0,7,4],[2]], {}],
  ['unsorted candidates retain historical tie order', sample, split(0), [[7,4,1,6,2,4],[2]], {}],
  ['signed zero', [{x:[-0],y:0},{x:[0],y:1},{x:[1],y:1},{x:[-1],y:0}], split(0), [[0,-0,0.5]], {}],
  ['finite extreme values', [{x:[-1e308],y:0},{x:[1e308],y:1},{x:[0],y:0},{x:[1],y:1}], split(0), [[-1e308,0,1,1e308]], {}],
  ['constant feature', sample.map(r=>({...r,x:[2,2]})), split(0), [[1,2,3],[2]], {}],
  ['class zero only', sample.map(r=>({...r,y:0})), split(0), [[4],[2]], {}],
  ['class one only', sample.map(r=>({...r,y:1})), split(0), [[4],[2]], {}],
  ['leaf template', sample, leaf(1), [[4],[2]], {}],
  ['node allowance one', sample, split(0), [[4],[2]], {maxNodes:1}],
  ['depth zero', sample, split(0), [[4],[2]], {maxDepth:0}],
  ['min leaf infeasible', sample, split(0), [[4],[2]], {minLeaf:20}],
  ['gain gate', sample, split(0), [[4],[2]], {minGain:1}],
  ['nested features and pruned descendants', sample, split(1,split(0),split(1)), [[1,2,4,6],[2,4,5,8]], {}],
  ['class-one tie rule remains available', sample, leaf(0), [[4],[2]], {tieAction:1}],
  ['unrestricted CART is byte and work identical', sample, null, null, {}],
]) {
  test(name, () => { const {a,b}=compare(rows,shape,cuts,extra); if(shape===null)assert.deepEqual(a.ledger.counts,b.ledger.counts); });
}

test('512 deterministic differential cases preserve full trees and literal provenance', () => {
  let state=0x51aa8921;
  const draw=()=> {state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
  const shape=(depth)=>depth===0||draw()<0.25 ? leaf(Number(draw()<0.5)) : split(Math.floor(draw()*3),shape(depth-1),shape(depth-1));
  for(let k=0;k<512;k++) {
    const rows=Array.from({length:10+Math.floor(draw()*91)},(_,i)=>({index:i+1,
      x:Array.from({length:3},()=>Math.floor(draw()*17)-8),y:Number(draw()<0.4)}));
    const cuts=Array.from({length:3},()=>Array.from({length:1+Math.floor(draw()*12)},()=>Math.floor(draw()*21)-10));
    compare(rows,shape(4),cuts,{maxNodes:1+2*Math.floor(draw()*16),maxDepth:Math.floor(draw()*6),minLeaf:1+Math.floor(draw()*5)});
  }
});

test('old fitted thresholds and leaf actions are never read by template refitting', () => {
  const shape=split(0);
  Object.defineProperty(shape,'threshold',{get(){throw new Error('old threshold was read');},enumerable:false});
  Object.defineProperty(shape.left,'action',{get(){throw new Error('old leaf action was read');},enumerable:false});
  Object.defineProperty(shape.right,'action',{get(){throw new Error('old leaf action was read');},enumerable:false});
  const ledger=new WorkLedger();const f=new current.TreeFactory({ledger});
  const t=current.fitCart(sample,f,{featureCount:2,template:shape,thresholds:[[4],[2]],minLeaf:1,tieAction:0});
  assert.equal(t.threshold,4);assert.equal(t.left.action,0);assert.equal(t.right.action,1);
});

test('bounded-support fixture charges the prefix-label pass once, not once per threshold', () => {
  const data=[{x:[0],y:0},{x:[1],y:1},{x:[2],y:0},{x:[3],y:1}];
  const {a,b}=compare(data,split(0),[[0,1,2,3,4]],{minGain:1});
  assert.equal(a.ledger.counts.label_count_update,24);assert.equal(b.ledger.counts.label_count_update,18); // 4 total labels + 4 bins + 2*5 prefix counts
  assert.equal(a.ledger.counts.sample_predicate_test,20);assert.equal(b.ledger.counts.sample_predicate_test,11); // upper-bound paths: 3 + 2 + 3 + 3
  assert.ok(b.ledger.counts.threshold_sort_comparison>0);
});

test('a 500-row 32-threshold fixture reduces measured APW without changing output', () => {
  const data=Array.from({length:500},(_,i)=>({index:i+1,x:[i],y:Number(i>=250)}));
  const {a,b}=compare(data,split(0),[Array.from({length:32},(_,i)=>15*(i+1))]);
  assert.ok(b.ledger.total<a.ledger.total);assert.ok(b.ledger.counts.label_count_update<a.ledger.counts.label_count_update);
});

test('a tiny allowance still fails before returning a partial fitted tree', () => {
  const ledger=new WorkLedger({cap:10});const f=new current.TreeFactory({ledger});
  assert.throws(()=>current.fitCart(sample,f,{featureCount:2,template:split(0),thresholds:[[4],[2]],minLeaf:1}),BudgetExhausted);
  assert.equal(ledger.total,10);
});

test('exhausted template update retains a previously committed population', () => {
  const rows=Array.from({length:30},(_,i)=>({index:1971+i,x:[i/30],y:Number(i>15)}));
  const l=new EvolutionLearner({key:'0123456789abcdef',config:{populationSize:5,cartDescendants:1,featureCount:1,elitism:1,cartMinLeaf:2}});
  assert.equal(l.initialise(rows,2000).mandatory_stage_committed,true);
  const before=l.snapshot();const result=l.update(rows,{checkpoint:2000,arm:'TEMPLATE_REFIT',cap:1,initialOnly:true});
  assert.equal(result.mandatory_stage_committed,false);assert.equal(result.initialisation_failed,false);
  assert.deepEqual(l.snapshot().population,before.population);assert.equal(l.scoredThrough,before.scoredThrough);
});
