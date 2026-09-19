import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DevelopmentStream } from '../assets/code/confirmatory/generator.mjs';
import { MaterializedTape, materializeStream } from '../working/f10/f10_tape.mjs';
import { LineageRegistry, populationDiversity, sealRecord } from '../working/f10/f10_primary_core.mjs';

function leaf(id, action=0){return {tree:{type:'leaf',action,_p:{id:`r${id}`,token:`t${id}`,source:null,birth_update:0,witness:null,operation:'x'}},ordinal:id,id:`i${id}`,parents:[]};}

test('population diversity is the predeclared unordered-pair semantic diversity',()=>{
  const a=leaf(1,0),b=leaf(2,0),c=leaf(3,1);
  assert.equal(populationDiversity([a,b,c]), 1 - 2/(3*2));
  assert.equal(populationDiversity([a]),0);
});

test('lineage registry uses longest deployed parent path and fails closed on unresolved ancestry',()=>{
  const r=new LineageRegistry();
  r.observe([{id:'a',parents:[]},{id:'b',parents:['a']},{id:'c',parents:['a','b']}]);
  assert.equal(r.depth('a'),0);assert.equal(r.depth('b'),1);assert.equal(r.depth('c'),2);
  assert.throws(()=>new LineageRegistry().observe([{id:'z',parents:['missing']}]),/cannot resolve/);
});

test('two-tape cursor refuses future label access and preserves exact 26000-row DEV bytes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f10-tape-test-'));
  try{
    const stream=new DevelopmentStream({scenario:'LOCAL_TREE-STATIONARY-NONE',realisation:0});
    const tape=materializeStream(stream,{partition:'DEV',scenario_id:'LOCAL_TREE-STATIONARY-NONE',realisation:0,source_key_hex:stream.key,optimizer_key_hex:'0123456789abcdef',comparator_included:false},root);
    assert.ok(tape instanceof MaterializedTape);assert.equal(tape.rows,26000);
    const c=tape.cursor(10,12);assert.throws(()=>c.label(10),/pending/);const a=c.features();assert.equal(a.index,10);assert.throws(()=>c.features(),/two-tape order/);assert.throws(()=>c.label(11),/does not match pending feature row/);assert.ok([0,1].includes(c.label(10)));c.features();c.label(11);c.features();c.label(12);c.finish();
    assert.match(tape.manifest.feature_sha256,/^[a-f0-9]{64}$/);assert.match(tape.manifest.label_sha256,/^[a-f0-9]{64}$/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('sealed records are content-addressed without self-reference',()=>{
  const a=sealRecord({x:1,nested:{b:2}}),b=sealRecord({x:1,nested:{b:2}});assert.deepEqual(a,b);assert.match(a.record_sha256,/^[a-f0-9]{64}$/);
  assert.notEqual(sealRecord({x:2}).record_sha256,a.record_sha256);
});
