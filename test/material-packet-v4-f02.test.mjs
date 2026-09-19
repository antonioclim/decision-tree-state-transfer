import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { DevelopmentStream } from '../assets/code/confirmatory/generator.mjs';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { keyFromAddress } from '../assets/code/confirmatory/random.mjs';
import { PrequentialSession } from '../assets/code/confirmatory/session.mjs';
import { DiskProvenanceIndex } from '../assets/code/confirmatory/disk-provenance.mjs';
import { createMaterialPacketV4, packetHashV4, verifyMaterialPacketV4 } from '../assets/code/confirmatory/material-packet-v4.mjs';

const identity={partition:'DEV',scenario:'LOCAL_TREE-STATIONARY-NONE',realisation:0,optimiser:0,checkpoint:10000};
const optimiserKey=keyFromAddress('DT-P9-v1|DEV|LOCAL_TREE-STATIONARY-NONE|r=00|optimiser=00');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'f02-packet-v4-'));const index=new DiskProvenanceIndex(path.join(root,'trace.sqlite'));
const stream=new DevelopmentStream(identity);const window=stream.window(identity.checkpoint);
const learner=new EvolutionLearner({key:optimiserKey,emit:e=>index.append(structuredClone(e)),provenancePrefix:'F02-PACKET-PARENT'});
learner.initialise(window,identity.checkpoint);
const parent=new PrequentialSession({learner,window,cap:1,protocolHash:'a'.repeat(64),pendingUpdate:true}).snapshot();
const parentHash=packetHashV4(parent);
after(()=>{index.close();fs.rmSync(root,{recursive:true,force:true});});

test('source-bound F02 packet retains a complete no-eligible no-op horizon',()=>{
  const p=createMaterialPacketV4(parent,identity,parentHash,{provenanceIndex:index,horizon:5});
  assert.equal(p.horizon,5);assert.equal(p.rows.length,5);assert.equal(p.eligible,false);assert.equal(p.eligibility_status,'NO_ELIGIBLE_SITE');
  assert.equal(p.conditional_intervention_contrast,null);assert.equal(p.policy_intervention_contrast,0);
  assert.ok(p.rows.every(r=>r.loss['MATERIAL-REPLACE']===r.loss['STRUCTURAL-SHAM'] && r.loss['MATERIAL-REPLACE']!==null));
});
test('source-bound F02 packet reconstructs exactly from parent and trace',()=>{
  const p=createMaterialPacketV4(parent,identity,parentHash,{provenanceIndex:index,horizon:5});
  const r=verifyMaterialPacketV4(p,parent,identity,{parentSha256:parentHash,packetSha256:packetHashV4(p),provenanceIndex:index});
  assert.equal(r.status,'PASS');assert.equal(r.source_rows,5);assert.equal(r.policy_intervention_contrast,0);
});
test('CONF material identity is rejected before any packet construction',()=>{
  assert.throws(()=>createMaterialPacketV4(parent,{...identity,partition:'CONF'},parentHash,{provenanceIndex:index,horizon:2}),/DEV identity required/);
});
test('optimiser identity is cryptographically bound to the DEV namespace',()=>{
  assert.throws(()=>createMaterialPacketV4(parent,{...identity,optimiser:1},parentHash,{provenanceIndex:index,horizon:2}),/identity\/configuration/);
});
test('learner configuration cannot be changed and rescued by rehashing the parent',()=>{
  const bad=structuredClone(parent);bad.learner.config.complexityPenalty=.0003;
  assert.throws(()=>createMaterialPacketV4(bad,identity,packetHashV4(bad),{provenanceIndex:index,horizon:2}),/identity\/configuration/);
});
test('rehashing a changed packet cannot rescue it against source-bound reconstruction',()=>{
  const p=createMaterialPacketV4(parent,identity,parentHash,{provenanceIndex:index,horizon:3});const bad=structuredClone(p);bad.rows[0].label^=1;
  assert.throws(()=>verifyMaterialPacketV4(bad,parent,identity,{parentSha256:parentHash,packetSha256:packetHashV4(bad),provenanceIndex:index}),/differs from reconstruction/);
});
