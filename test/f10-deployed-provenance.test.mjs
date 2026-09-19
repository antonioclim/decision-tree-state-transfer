import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DevelopmentStream } from '../assets/code/confirmatory/generator.mjs';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { DiskProvenanceIndex } from '../assets/code/confirmatory/disk-provenance.mjs';
import { CompactProvenanceIndex } from '../assets/code/confirmatory/f10-compact-provenance.mjs';
import { DeployedProvenanceIndex } from '../assets/code/confirmatory/f10-deployed-provenance.mjs';
import { frozenInterventionsV4 } from '../assets/code/confirmatory/material-v4.mjs';

const key = '0123456789abcdef';
const scenario = 'LOCAL_TREE-ABRUPT-MILD';

function summary(result) {
  return {
    status: result.status,
    eligible: result.eligible,
    eligible_count: result.eligible_count,
    site: result.site ?? null,
    candidate: result.arms?.['MATERIAL-REPLACE']?.replacement_candidate_sha256 ?? null,
    candidate_apw: result.arms?.['MATERIAL-REPLACE']?.replacement_candidate_apw_total ?? null,
    replace_apw: result.arms?.['MATERIAL-REPLACE']?.cost?.adaptation_apw_total ?? null,
    sham_apw: result.arms?.['STRUCTURAL-SHAM']?.cost?.adaptation_apw_total ?? null
  };
}

test('deployed-only provenance matches Disk and Compact on committed material semantics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f10-deployed-prov-'));
  const disk = new DiskProvenanceIndex(path.join(root, 'trace.sqlite'));
  const compact = new CompactProvenanceIndex();
  const deployed = new DeployedProvenanceIndex();
  try {
    const emit = (event) => { disk.append(event); compact.append(event); deployed.append(event); };
    const stream = new DevelopmentStream({ scenario, realisation: 0 });
    const learner = new EvolutionLearner({ key, provenancePrefix: 'F10-DEPLOYED-TEST', emit });
    const initial = stream.window(2000, 500);
    learner.initialise(initial, 2000);
    compact.prune(learner.snapshot()); deployed.prune(learner.snapshot());
    for (let checkpoint = 2100; checkpoint <= 2800; checkpoint += 100) {
      const report = learner.update(stream.window(checkpoint, 500), { checkpoint, arm: 'PERSIST', cap: 3110120, budgetTag: 'TEST' });
      assert.equal(report.mandatory_stage_committed, true);
      compact.prune(learner.snapshot()); deployed.prune(learner.snapshot());
    }
    const snap = learner.snapshot();
    assert.equal(disk.verifySnapshot(snap).snapshot_sha256, compact.verifySnapshot(snap).snapshot_sha256);
    assert.equal(compact.verifySnapshot(snap).snapshot_sha256, deployed.verifySnapshot(snap).snapshot_sha256);
    const rows = stream.window(2800, 500);
    const a = frozenInterventionsV4(learner, rows, 2800, { provenanceIndex: disk, prefix: 'DISK' });
    const b = frozenInterventionsV4(learner, rows, 2800, { provenanceIndex: compact, prefix: 'COMPACT' });
    const c = frozenInterventionsV4(learner, rows, 2800, { provenanceIndex: deployed, prefix: 'DEPLOYED' });
    assert.deepEqual(summary(c), summary(a));
    assert.deepEqual(summary(c), summary(b));
    const close = deployed.finish(snap);
    assert.equal(close.storage, 'DEPLOYED_RECORDS_WITH_PROOF_CARRYING_EDGE_PATH_COMPRESSION');
    assert.ok(close.maximum_staged_records.nodes > 0);
    assert.equal(close.live_records_at_close.edge_certificates, close.live_records_at_close.edges);
    assert.ok(close.maximum_edge_certificate_bytes > 0 && close.maximum_edge_certificate_bytes < 1024);
    assert.ok(close.maximum_compressed_chain_length > 0);
  } finally {
    try { compact.close?.(); } catch {}
    try { disk.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deployed verifier fails closed on unsupported provenance event kind', () => {
  const index = new DeployedProvenanceIndex();
  assert.throws(() => index.append({ kind: 'forged-event' }), /unsupported provenance event kind/);
  assert.throws(() => index.append({ kind: 'forged-event' }), /closed or poisoned/);
});
