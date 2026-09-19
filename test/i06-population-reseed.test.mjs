import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import {
  ClosedProvenanceAudit,
  canonicalPopulationPlan,
  composePopulationReseed,
  forkI06State,
  populationMultisetDigest,
  snapshotIdentitySets,
  treatmentOptimiserAddress,
  treatmentOptimiserKey,
  validateFreshPopulationSnapshot,
  verifyNoInheritedState,
} from '../assets/code/confirmatory/i06-state.mjs';
import { semanticTree, treeHash } from '../assets/code/confirmatory/trees.mjs';

const PROTOCOL_HASH = 'd8eaac46d96f0ffc986e3ac5937112910cb28010e6d2cdc42ab08255aa17a622';
const SOURCE_KEY = '8f2ae83afa1a570d';
const CAP = 1_200_000;

function rows(end = 500, count = 500, featureCount = 4) {
  const out = [];
  for (let index = end - count + 1; index <= end; index += 1) {
    const x = Array.from({ length: featureCount }, (_, f) => {
      const z = Math.sin(index * (f + 1) * 0.013) + Math.cos(index * (f + 2) * 0.007);
      return z / 2;
    });
    const y = Number(x[0] + 0.7 * x[1] - 0.3 * x[2] > 0);
    out.push({ index, x, y });
  }
  return out;
}

function parentSnapshot() {
  const learner = new EvolutionLearner({
    key: '0123456789abcdef',
    config: {
      featureCount: 4,
      populationSize: 12,
      cartDescendants: 7,
      elitism: 2,
      tournamentSize: 3,
      thresholdsPerFeature: 8,
      maxInitialDepth: 3,
      maxTreeDepth: 5,
      cartMaxDepth: 5,
      cartMinLeaf: 5,
      replacementFraction: 0.25,
    },
    provenancePrefix: 'I06-DEV-PARENT',
  });
  const window = rows();
  const report = learner.initialise(window, 500);
  assert.equal(report.mandatory_stage_committed, true);
  return {
    schema_version: 1,
    learner: learner.snapshot(),
    window,
    lastIndex: 500,
    pendingUpdate: true,
    protocolHash: PROTOCOL_HASH,
  };
}

function freshAudit(arm) {
  return new ClosedProvenanceAudit({ arm });
}

function runFresh(snapshot, arm) {
  const audit = freshAudit(arm);
  const result = forkI06State(snapshot, {
    arm,
    cap: CAP,
    sourceKeyHex: SOURCE_KEY,
    budgetTag: 'I06-DEV',
    provenanceAudit: audit,
    integrityStatus: 'VERIFIED',
    parentProvenanceVerified: true,
  });
  assert.equal(result.status, 'COMPLETE');
  const provenance = audit.verifySnapshot(result.session.learner.snapshot());
  assert.equal(provenance.closed, true);
  return { result, provenance };
}

test('treatment optimiser addresses are deterministic, namespaced and arm-specific', () => {
  const championAddress = treatmentOptimiserAddress(SOURCE_KEY, 'CHAMPION-RESEED');
  const populationAddress = treatmentOptimiserAddress(SOURCE_KEY, 'POPULATION-RESEED');
  assert.equal(championAddress, 'DT-I05-NST-v1|EXT|RESET-OPTIMISER|stream=8f2ae83afa1a570d|arm=CHAMPION-RESEED');
  assert.equal(populationAddress, 'DT-I05-NST-v1|EXT|RESET-OPTIMISER|stream=8f2ae83afa1a570d|arm=POPULATION-RESEED');
  assert.notEqual(treatmentOptimiserKey(SOURCE_KEY, 'CHAMPION-RESEED'), treatmentOptimiserKey(SOURCE_KEY, 'POPULATION-RESEED'));
  assert.match(treatmentOptimiserKey(SOURCE_KEY, 'POPULATION-RESEED'), /^[a-f0-9]{16}$/);
});

test('POPULATION-RESEED preserves champion semantics and exact population semantic multiset', () => {
  const snapshot = parentSnapshot();
  const parent = EvolutionLearner.restore(snapshot.learner);
  const prepared = composePopulationReseed(snapshot, { sourceKeyHex: SOURCE_KEY, cap: CAP });
  assert.equal(prepared.status, 'COMPOSED');
  assert.equal(prepared.before_update_audit.champion_sha256, treeHash(parent.champion.tree));
  assert.equal(prepared.before_update_audit.population_multiset_sha256, populationMultisetDigest(parent.population));
  assert.equal(populationMultisetDigest(prepared.learner.population), populationMultisetDigest(parent.population));
  assert.equal(prepared.learner.population.length, parent.population.length);
  assert.equal(prepared.learner.champion, prepared.learner.population[0]);
});

test('POPULATION-RESEED removes inherited identifiers, parents, provenance tokens and continuation state', () => {
  const snapshot = parentSnapshot();
  const prepared = composePopulationReseed(snapshot, { sourceKeyHex: SOURCE_KEY, cap: CAP });
  const audit = prepared.before_update_audit;
  assert.equal(audit.completed_updates, 0);
  assert.equal(audit.scored_through, null);
  assert.equal(audit.event_serial, 0);
  assert.equal(audit.treatment_applied, false);
  assert.equal(audit.last_update_is_null, true);
  assert.equal(audit.parents_all_empty, true);
  assert.equal(audit.ordinals_are_canonical, true);
  assert.equal(audit.inherited_individual_id_overlap, 0);
  assert.equal(audit.inherited_provenance_id_overlap, 0);
  assert.equal(audit.inherited_token_overlap, 0);
  assert.notEqual(prepared.learner.key, snapshot.learner.key);
  assert.deepEqual([...prepared.learner.population.map((p) => p.ordinal)], Array.from({ length: 12 }, (_, i) => i));
});

test('canonical reconstruction is invariant to parent population array permutation', () => {
  const a = parentSnapshot();
  const b = structuredClone(a);
  b.learner.population.reverse();
  const pa = composePopulationReseed(a, { sourceKeyHex: SOURCE_KEY, cap: CAP, provenancePrefix: 'I06:PERMUTATION' });
  const pb = composePopulationReseed(b, { sourceKeyHex: SOURCE_KEY, cap: CAP, provenancePrefix: 'I06:PERMUTATION' });
  assert.deepEqual(pa.learner.snapshot(), pb.learner.snapshot());
  assert.deepEqual(pa.plan.map(({ representative, ...x }) => x), pb.plan.map(({ representative, ...x }) => x));
});

test('canonical plan is duplicate-safe and preserves multiplicity', () => {
  const snapshot = parentSnapshot();
  const source = EvolutionLearner.restore(snapshot.learner);
  source.population[2].tree = structuredClone(source.population[1].tree);
  const plan = canonicalPopulationPlan(source);
  const counts = new Map();
  for (const item of plan) counts.set(item.semantic_key, (counts.get(item.semantic_key) ?? 0) + 1);
  const expected = new Map();
  for (const item of source.population) {
    const key = JSON.stringify(semanticTree(item.tree));
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...counts.entries()].sort(), [...expected.entries()].sort());
  for (const [, group] of Map.groupBy(plan, (item) => item.semantic_key)) {
    const ranks = group.map((item) => item.duplicate_rank);
    assert.equal(new Set(ranks).size, ranks.length);
  }
});

test('fresh arms are deterministic under exact replay and produce referentially closed provenance', () => {
  const snapshot = parentSnapshot();
  for (const arm of ['CHAMPION-RESEED', 'POPULATION-RESEED']) {
    const one = runFresh(snapshot, arm);
    const two = runFresh(snapshot, arm);
    assert.deepEqual(one.result.session.learner.snapshot(), two.result.session.learner.snapshot());
    assert.equal(one.provenance.chain_sha256, two.provenance.chain_sha256);
    assert.ok(one.provenance.event_count > 0);
    assert.ok(one.provenance.event_bytes > 0);
    const noLeak = verifyNoInheritedState(snapshot.learner, one.result.session.learner.snapshot(), arm);
    assert.equal(noLeak.valid, true);
    assert.equal(validateFreshPopulationSnapshot(one.result.session.learner.snapshot()), true);
  }
});

test('all three arms share the same declared APW envelope and charge construction work', () => {
  const snapshot = parentSnapshot();
  const population = runFresh(snapshot, 'POPULATION-RESEED').result;
  const champion = runFresh(snapshot, 'CHAMPION-RESEED').result;
  const parentDigest = createHash('sha256').update(JSON.stringify(snapshot.learner)).digest('hex');
  const persistAudit = new ClosedProvenanceAudit({ arm: 'PERSIST', parentCertificateSha256: parentDigest });
  persistAudit.trustParentSnapshot(snapshot.learner);
  const persist = forkI06State(snapshot, {
    arm: 'PERSIST', cap: CAP, sourceKeyHex: SOURCE_KEY, budgetTag: 'I06-DEV',
    provenanceAudit: persistAudit, integrityStatus: 'VERIFIED', parentProvenanceVerified: true,
  });
  assert.equal(persist.status, 'COMPLETE');
  persistAudit.verifySnapshot(persist.session.learner.snapshot());
  for (const result of [persist, champion, population]) {
    assert.equal(result.report.budget_cap, CAP);
    assert.ok(result.report.adaptation_apw_total <= CAP);
    assert.equal(result.report.unspent_APW, CAP - result.report.adaptation_apw_total);
  }
  assert.equal(persist.report.construction_apw_total, 0);
  assert.ok(champion.report.construction_apw_total > 0);
  assert.ok(population.report.construction_apw_total > champion.report.construction_apw_total);
});

test('integrity and provenance gates fail closed', () => {
  const snapshot = parentSnapshot();
  assert.throws(() => forkI06State(snapshot, {
    arm: 'POPULATION-RESEED', cap: CAP, sourceKeyHex: SOURCE_KEY,
    integrityStatus: 'VERIFIED', parentProvenanceVerified: false,
  }), /requires verified tape/);
  assert.throws(() => forkI06State(snapshot, {
    arm: 'POPULATION-RESEED', cap: CAP, sourceKeyHex: SOURCE_KEY,
    integrityStatus: 'UNVERIFIED', parentProvenanceVerified: true,
  }), /requires verified tape/);
});

test('failed parent yields treatment unavailability and never a fallback arm', () => {
  const snapshot = parentSnapshot();
  snapshot.learner.failed = true;
  snapshot.learner.population = [];
  snapshot.learner.championOrdinal = null;
  snapshot.learner.scoredThrough = null;
  snapshot.learner.nextOrdinal = 0;
  for (const arm of ['CHAMPION-RESEED', 'POPULATION-RESEED']) {
    const result = forkI06State(snapshot, {
      arm, cap: CAP, sourceKeyHex: SOURCE_KEY, integrityStatus: 'VERIFIED', parentProvenanceVerified: true,
    });
    assert.equal(result.status, 'TREATMENT_UNAVAILABLE');
    assert.equal(result.session, null);
    assert.equal(result.treatment_applied, false);
  }
});

test('insufficient construction allowance fails before an EXT-capable session exists', () => {
  const snapshot = parentSnapshot();
  const result = forkI06State(snapshot, {
    arm: 'POPULATION-RESEED', cap: 1, sourceKeyHex: SOURCE_KEY,
    integrityStatus: 'VERIFIED', parentProvenanceVerified: true,
  });
  assert.equal(result.status, 'ALGORITHMIC_FAILURE');
  assert.equal(result.session, null);
});

test('I06 state module has no source-generator, tape or outcome dependency', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../assets/code/confirmatory/i06-state.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /generator\.mjs|f10-conf-source|materializeExt|\.label\(/);
});
