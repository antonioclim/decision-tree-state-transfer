import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { DiskProvenanceIndex } from '../assets/code/confirmatory/disk-provenance.mjs';
import { TreeFactory, treeHash } from '../assets/code/confirmatory/trees.mjs';
import { WorkLedger } from '../assets/code/confirmatory/work.mjs';
import { frozenInterventionsV4, materialPredictionV4 } from '../assets/code/confirmatory/material-v4.mjs';

const key='0123456789abcdef';
const rows=(end=2700,n=80)=>Array.from({length:n},(_,i)=>{const a=(i%20)/20,b=(Math.floor(i/20)%4)/4;
  return {index:end-n+i+1,x:[a,b],y:Number((a>=.5)!=(b>=.5))};});
function controlledParent(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f02-v4-controlled-'));const events=[];const ledger=new WorkLedger({cap:1000000});
  const factory=new TreeFactory({ledger,prefix:'F02-MATERIAL-FIXTURE',update:1,emit:e=>events.push(structuredClone(e))});
  const original=factory.split(1,.8,factory.split(0,.5,factory.leaf(0),factory.leaf(1)),factory.leaf(0));factory.realise(original,'ancestor');
  const trees=[original];for(let i=1;i<4;i++){const t=factory.copy(original);factory.realise(t,`copy-${i}`);trees.push(t);}
  const config={populationSize:4,cartDescendants:1,elitism:0,featureCount:2,maxInitialDepth:2,maxTreeDepth:3,
    cartMaxDepth:3,cartMinLeaf:2,tournamentSize:2,thresholdsPerFeature:4,replacementFraction:.25};
  const learner=new EvolutionLearner({key,config,provenancePrefix:'F02-MATERIAL-PARENT'});
  learner.population=trees.map((tree,ordinal)=>({tree,ordinal,id:`fixture-ind-${ordinal}`,parents:[]}));learner.champion=learner.population[0];
  learner.nextOrdinal=4;learner.completedUpdates=8;learner.scoredThrough=2700;learner.failed=false;learner.eventSerial=0;learner.snapshotSchemaVersion=2;
  const index=new DiskProvenanceIndex(path.join(root,'trace.sqlite'));for(const e of events)index.append(e);
  return{root,index,learner,window:rows(),close(){index.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('trace-backed paired material arms share site/candidate but have independent ledgers and provenance',()=>{
  const x=controlledParent();try{const r=frozenInterventionsV4(x.learner,x.window,2700,{provenanceIndex:x.index,eligibility:{minimumRows:2}});
    assert.equal(r.status,'COMPLETE');assert.equal(r.eligible,true);assert.equal(r.eligible_count,1);
    const a=r.arms['MATERIAL-REPLACE'],s=r.arms['STRUCTURAL-SHAM'];assert.deepEqual(a.selected,s.selected);
    assert.equal(a.replacement_candidate_sha256,s.replacement_candidate_sha256);assert.equal(a.replacement_candidate_apw_total,s.replacement_candidate_apw_total);
    assert.notStrictEqual(a.cost,s.cost);assert.notStrictEqual(a.provenance,s.provenance);assert.ok(a.provenance_event_count>0);assert.ok(s.provenance_event_count>0);
    assert.equal(s.deployed_tree_sha256,r.parent_tree_sha256);assert.equal(s.token_overlap_with_original_site,0);
  }finally{x.close();}
});
test('material intervention is deterministic under the same parent and trace',()=>{
  const x=controlledParent();try{const a=frozenInterventionsV4(x.learner,x.window,2700,{provenanceIndex:x.index,prefix:'REPLAY',eligibility:{minimumRows:2}});
    const b=frozenInterventionsV4(x.learner,x.window,2700,{provenanceIndex:x.index,prefix:'REPLAY',eligibility:{minimumRows:2}});assert.equal(a.status,'COMPLETE');assert.deepEqual(a.site,b.site);
    for(const arm of ['MATERIAL-REPLACE','STRUCTURAL-SHAM']){assert.equal(a.arms[arm].deployed_tree_sha256,b.arms[arm].deployed_tree_sha256);
      assert.deepEqual(a.arms[arm].cost.apw_components,b.arms[arm].cost.apw_components);assert.deepEqual(a.arms[arm].provenance,b.arms[arm].provenance);}
  }finally{x.close();}
});
test('missing trace-backed provenance fails closed instead of granting eligibility',()=>{
  const x=controlledParent();try{assert.throws(()=>frozenInterventionsV4(x.learner,x.window,2700,{provenanceIndex:null}));}finally{x.close();}
});
test('sham predictions equal the parent while provenance is fresh at the selected site',()=>{
  const x=controlledParent();try{const r=frozenInterventionsV4(x.learner,x.window,2700,{provenanceIndex:x.index,eligibility:{minimumRows:2}});
    for(const z of [[.1,.1],[.8,.1],[.1,.8],[.8,.8]])assert.equal(materialPredictionV4(r,'STRUCTURAL-SHAM',z),x.learner.predict(z));
    assert.equal(treeHash(r.arms['STRUCTURAL-SHAM'].deployed_tree),treeHash(x.learner.champion.tree));
    assert.ok(r.arms['STRUCTURAL-SHAM'].provenance.some(e=>e.kind==='node'&&e.operation==='f02-sham-fresh-literal'));
  }finally{x.close();}
});
test('no eligible site is an explicit parent no-op with full predictions available',()=>{
  const x=controlledParent();try{const r=frozenInterventionsV4(x.learner,x.window,2700,{provenanceIndex:x.index,eligibility:{minimumRows:100000}});
    assert.equal(r.status,'NO_ELIGIBLE_SITE');assert.equal(r.eligible,false);assert.ok(r.parent_tree);
    for(const z of [[.1,.1],[.8,.8]])for(const arm of ['MATERIAL-REPLACE','STRUCTURAL-SHAM'])assert.equal(materialPredictionV4(r,arm,z),x.learner.predict(z));
  }finally{x.close();}
});
test('unavailable material parent returns null predictions rather than fabricated material',()=>{
  const x=controlledParent();try{x.learner.champion=null;const r=frozenInterventionsV4(x.learner,x.window,2700,{provenanceIndex:x.index});assert.equal(r.status,'PARENT_UNAVAILABLE');
    assert.equal(materialPredictionV4(r,'MATERIAL-REPLACE',[.1,.1]),null);assert.equal(materialPredictionV4(r,'STRUCTURAL-SHAM',[.1,.1]),null);
  }finally{x.close();}
});
