import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiskProvenanceIndex } from '../assets/code/confirmatory/disk-provenance.mjs';
import { TreeFactory } from '../assets/code/confirmatory/trees.mjs';
import { WorkLedger } from '../assets/code/confirmatory/work.mjs';
import { validateProvenance } from '../assets/code/confirmatory/evidence.mjs';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { DevelopmentStream } from '../assets/code/confirmatory/generator.mjs';
function index(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'disk-index-'));const ix=new DiskProvenanceIndex(path.join(d,'audit.sqlite'));t.after(()=>{ix.close();fs.rmSync(d,{recursive:true,force:true});});return ix;}
function fixture(){const es=[];const f=new TreeFactory({ledger:new WorkLedger(),prefix:'FIX',update:4,emit:e=>es.push(structuredClone(e))});const tree=f.split(0,.5,f.leaf(0),f.leaf(1));f.realise(tree,'I0');const copied=f.copy(tree);f.realise(copied,'I1');return {es,tree,copied};}
test('disk index and historical independent traversal agree on real copy fixtures',t=>{const {es}=fixture();const ix=index(t);es.forEach(e=>ix.append(e));const r=ix.finish();const old=validateProvenance(es);for(const k of Object.keys(old))assert.equal(r[k],old[k]);assert.equal(r.integrity_check,'ok');assert.equal(r.scientific_admission,false);});
test('index handles a real learner snapshot, not only synthetic graph metadata',t=>{const ix=index(t);const learner=new EvolutionLearner({key:'0123456789abcdef',config:{populationSize:8,cartDescendants:4},emit:e=>ix.append(e)});learner.initialise(new DevelopmentStream({scenario:'LOCAL_TREE-STATIONARY-NONE',realisation:0}).window(2000));assert.equal(ix.verifySnapshot(learner.snapshot()).population_size,8);ix.finish();});
for(const [name,change] of [
 ['duplicate occurrence',es=>es.push(es[0])],['unknown source',es=>{es.find(e=>e.kind==='node'&&e.source).source='absent';}],
 ['changed literal',es=>{es.find(e=>e.kind==='node'&&e.source&&e.literal[0]==='leaf').literal[1]=2;}],
 ['forged birth age',es=>{es.find(e=>e.kind==='node'&&e.source).birth_update=0;}],
 ['forged witness age',es=>{es.find(e=>e.kind==='node'&&e.witness).witness.update=0;}],
 ['forged edge token',es=>{es.find(e=>e.kind==='node'&&e.literal[0]==='split').left_edge.token='FORGED';}],
 ['unknown edge source',es=>{es.find(e=>e.kind==='edge').source='missing';}],
 ['new node with witness',es=>{es.find(e=>e.kind==='node'&&!e.source).witness={update:0,individual:'X',root_record:'Y'};}],
 ['duplicate minted token',es=>{const ns=es.filter(e=>e.kind==='node'&&!e.source);ns[1].token=ns[0].token;}],
 ['invalid event',es=>es.push({kind:'other'})],
])test(`disk validator rejects ${name}`,t=>{const ix=index(t);const {es}=fixture();change(es);assert.throws(()=>es.forEach(e=>ix.append(e)));assert.throws(()=>ix.finish());});
for(const [name,change] of [
 ['absent source record',s=>{s.population[0].tree._p.id='ABSENT';}],
 ['changed provenance token',s=>{s.population[0].tree._p.token='FORGED';}],
 ['changed witness',s=>{s.population[0].tree._p.witness.update=999;}],
 ['changed tree literal',s=>{const n=s.population[0].tree;if(n.type==='split')n.threshold+=.01;else n.action=1-n.action;}],
])test(`snapshot check rejects ${name}`,t=>{const ix=index(t);const learner=new EvolutionLearner({key:'0123456789abcdef',config:{populationSize:8,cartDescendants:4},emit:e=>ix.append(e)});learner.initialise(new DevelopmentStream({scenario:'LOCAL_TREE-STATIONARY-NONE',realisation:0}).window(2000));const s=learner.snapshot();change(s);assert.throws(()=>ix.verifySnapshot(s));});
test('finish and append cannot reuse a completed index',t=>{const ix=index(t);fixture().es.forEach(e=>ix.append(e));ix.finish();assert.throws(()=>ix.finish());assert.throws(()=>ix.append({}));});
