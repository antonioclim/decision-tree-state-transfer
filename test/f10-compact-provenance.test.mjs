import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { DiskProvenanceIndex } from '../assets/code/confirmatory/disk-provenance.mjs';
import { CompactProvenanceIndex } from '../assets/code/confirmatory/f10-compact-provenance.mjs';
import { frozenInterventionsV4 } from '../assets/code/confirmatory/material-v4.mjs';

const key = '0123456789abcdef';
const config = { populationSize: 12, cartDescendants: 5, elitism: 1, featureCount: 2, maxInitialDepth: 2, maxTreeDepth: 3,
  cartMaxDepth: 3, cartMinLeaf: 2, tournamentSize: 3, thresholdsPerFeature: 5, replacementFraction: .25 };
function rows(end, n = 80) {
  return Array.from({ length: n }, (_, i) => { const a = (i % 20) / 20, b = (Math.floor(i / 20) % 4) / 4;
    return { index: end - n + i + 1, x: [a, b], y: Number((a >= .5) !== (b >= .5)) }; });
}

function buildBoth() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f10-compact-proof-'));
  const disk = new DiskProvenanceIndex(path.join(root, 'trace.sqlite'));
  const compact = new CompactProvenanceIndex();
  const emit = (event) => { disk.append(structuredClone(event)); compact.append(structuredClone(event)); };
  const learner = new EvolutionLearner({ key, config, provenancePrefix: 'F10-COMPACT-TEST', emit });
  learner.initialise(rows(2000), 2000);
  compact.prune(learner.snapshot());
  for (let c = 2100; c <= 2700; c += 100) {
    learner.update(rows(c), { checkpoint: c, arm: 'PERSIST', cap: 250000, budgetTag: 'TEST' });
    compact.prune(learner.snapshot());
  }
  return { root, disk, compact, learner };
}

test('compact index verifies the same deployed snapshot as disk index', () => {
  const x = buildBoth();
  try {
    const snapshot = x.learner.snapshot();
    const a = x.disk.verifySnapshot(snapshot);
    const b = x.compact.verifySnapshot(snapshot);
    assert.equal(a.population_size, b.population_size);
    assert.equal(a.checked_node_occurrences, b.checked_node_occurrences);
    assert.equal(a.snapshot_sha256, b.snapshot_sha256);
  } finally { x.disk.close(); fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('compact and disk indexes yield identical material eligibility and intervention semantics', () => {
  const x = buildBoth();
  try {
    const window = rows(2700);
    const a = frozenInterventionsV4(x.learner, window, 2700, { provenanceIndex: x.disk, prefix: 'F10-COMPARE', eligibility: { minimumRows: 2 } });
    const b = frozenInterventionsV4(x.learner, window, 2700, { provenanceIndex: x.compact, prefix: 'F10-COMPARE', eligibility: { minimumRows: 2 } });
    assert.equal(a.status, b.status);
    assert.equal(a.eligible, b.eligible);
    assert.equal(a.eligible_count, b.eligible_count);
    if (a.eligible) {
      assert.deepEqual(a.site, b.site);
      for (const arm of ['MATERIAL-REPLACE', 'STRUCTURAL-SHAM']) {
        assert.equal(a.arms[arm].replacement_candidate_sha256, b.arms[arm].replacement_candidate_sha256);
        assert.equal(a.arms[arm].deployed_tree_sha256, b.arms[arm].deployed_tree_sha256);
        assert.deepEqual(a.arms[arm].cost.apw_components, b.arms[arm].cost.apw_components);
      }
    }
  } finally { x.disk.close(); fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('compact pruning preserves future copy validation while bounding live records', () => {
  const x = buildBoth();
  try {
    const before = x.compact.events;
    x.learner.update(rows(2800), { checkpoint: 2800, arm: 'PERSIST', cap: 250000, budgetTag: 'TEST' });
    assert.ok(x.compact.events > before);
    const p = x.compact.prune(x.learner.snapshot());
    assert.ok(p.retained_nodes < x.compact.counts.node_records);
    assert.ok(p.retained_edges < x.compact.counts.edge_records);
    assert.doesNotThrow(() => x.compact.verifySnapshot(x.learner.snapshot()));
  } finally { x.disk.close(); fs.rmSync(x.root, { recursive: true, force: true }); }
});
