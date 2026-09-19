import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createMaterialPacket, verifyMaterialPacket, packetHash } from '../assets/code/confirmatory/material-packet-v3.mjs';

const parent = JSON.parse(gunzipSync(fs.readFileSync(new URL('../working/phase10g/fixtures/checkpoint-10000.json.gz', import.meta.url))));
const identity = { partition: 'DEV', scenario: 'LOCAL_TREE-STATIONARY-NONE', realisation: 0, optimiser: 0, checkpoint: 10000 };
const parentSha256 = packetHash(parent);
const packet = createMaterialPacket(parent, identity, parentSha256);
const verify = (p = packet, par = parent, id = identity, anchor = parentSha256) =>
  verifyMaterialPacket(p, par, id, { parentSha256: anchor, packetSha256: packetHash(p) });

test('new implementation reconstructs both frozen variants on the real archived DEV parent', () => {
  const r = verify(); assert.equal(r.source_rows, 2000); assert.equal(r.prediction_slots, 4000);
  assert.equal(r.eligible_count, 2); assert.equal(r.scientific_admission, false);
});
test('packet creation leaves the externally anchored parent unchanged', () => {
  createMaterialPacket(parent, identity, parentSha256); assert.equal(packetHash(parent), parentSha256);
});
test('repeated construction is byte-identical after excluding non-replayable clocks', () => {
  assert.equal(packetHash(createMaterialPacket(parent, identity, parentSha256)), packetHash(packet));
});
for (const [name, corrupt] of [
  ['label', p => { p.rows[0].label ^= 1; }],
  ['refit prediction', p => { p.rows[0].predictions.SUBTREE_REFIT ^= 1; }],
  ['sham prediction', p => { p.rows[0].predictions.STRUCTURAL_SHAM ^= 1; }],
  ['loss', p => { p.rows[0].loss.SUBTREE_REFIT ^= 1; }],
  ['feature digest', p => { p.rows[0].features_sha256 = '0'.repeat(64); }],
  ['missing row', p => { p.rows.pop(); }],
  ['duplicate row', p => { p.rows[1] = p.rows[0]; }],
  ['reordered rows', p => { p.rows.reverse(); }],
  ['row index', p => { p.rows[0].observation_index++; }],
  ['horizon', p => { p.horizon = 500; }],
  ['extra field', p => { p.approved = true; }],
  ['eligibility', p => { p.eligible_count = 0; }],
  ['selection', p => { p.selected.path = []; }],
  ['work', p => { p.cost.adaptation_apw_total++; }],
  ['component', p => { p.cost.apw_components.node_record_write++; }],
  ['provenance', p => { p.provenance[0].id += 'forged'; }],
  ['missing provenance', p => { p.provenance.pop(); }],
  ['tree', p => { p.sham_tree.type = 'forged'; }],
  ['boolean counter', p => { p.eligible_count = true; }],
  ['scientific approval', p => { p.scientific_admission = true; }],
  ['CONF partition', p => { p.partition = 'CONF'; }],
]) test(`rehashing cannot rescue a changed ${name}`, () => { const p = structuredClone(packet); corrupt(p); assert.throws(() => verify(p)); });
for (const [name, corrupt] of [
  ['protocol', p => { p.protocolHash = '0'.repeat(64); }],
  ['past labels', p => { p.window[0].y ^= 1; }],
  ['past features', p => { p.window[0].x[0] += 1; }],
  ['configuration', p => { p.learner.config.populationSize = 149; }],
  ['checkpoint order', p => { p.pendingUpdate = false; }],
  ['key', p => { p.learner.key = '0'.repeat(16); }],
]) test(`a rehashed parent with incorrect ${name} is rejected`, () => { const p = structuredClone(parent); corrupt(p); assert.throws(() => createMaterialPacket(p, identity, packetHash(p))); });
test('a parent anchor is required independently of the packet', () => {
  assert.throws(() => verify(packet, parent, identity, '0'.repeat(64)));
});
test('CONF identity cannot be relabelled as development', () => {
  assert.throws(() => createMaterialPacket(parent, { ...identity, partition: 'CONF' }, parentSha256));
});
test('non-JSON values are rejected before hashing', () => {
  const p = structuredClone(packet); p.cost.adaptation_apw_total = NaN; assert.throws(() => verify(p));
});
test('unavailable parent keeps every prediction slot and loss-one outcome', () => {
  const p = structuredClone(parent); p.learner.failed = true; p.learner.population = []; p.learner.championOrdinal = null;
  const pack = createMaterialPacket(p, identity, packetHash(p)); assert.equal(pack.rows.length, 2000);
  assert.equal(pack.parent_unavailable, true); assert.equal(pack.eligible_count, 0);
  assert.ok(pack.rows.every(r => r.predictions.SUBTREE_REFIT === null && r.loss.SUBTREE_REFIT === 1 && r.loss.STRUCTURAL_SHAM === 1));
  assert.equal(verify(pack, p, identity, packetHash(p)).status, 'PASS');
});
test('freshly fitted material is ineligible and both complete shadow paths remain identical', async () => {
  const { EvolutionLearner } = await import('../assets/code/confirmatory/learner.mjs');
  const { DevelopmentStream } = await import('../assets/code/confirmatory/generator.mjs');
  const stream = new DevelopmentStream(identity); const learner = new EvolutionLearner({key: parent.learner.key, provenancePrefix:'NO-ELIGIBLE'});
  learner.initialise(stream.window(10000),10000);
  const p = {...parent,learner:learner.snapshot()}; const pack = createMaterialPacket(p,identity,packetHash(p));
  assert.equal(pack.eligible_count,0); assert.equal(pack.fallback,'NO_ELIGIBLE_SITE');
  assert.ok(pack.rows.every(r=>r.predictions.SUBTREE_REFIT===r.predictions.STRUCTURAL_SHAM));
  assert.equal(verify(pack,p,identity,packetHash(p)).status,'PASS');
});
