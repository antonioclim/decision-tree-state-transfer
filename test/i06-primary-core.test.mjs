import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DevelopmentStream } from '../assets/code/confirmatory/generator.mjs';
import { EvolutionLearner } from '../assets/code/confirmatory/learner.mjs';
import { CompactProvenanceIndex } from '../assets/code/confirmatory/f10-compact-provenance.mjs';
import { populationMultisetDigest } from '../assets/code/confirmatory/i06-state.mjs';
import { runI06StateArm, sealI06Record, verifyI06Record } from '../working/i06/i06_primary_core.mjs';

const PROTOCOL_HASH = 'd8eaac46d96f0ffc986e3ac5937112910cb28010e6d2cdc42ab08255aa17a622';
const SOURCE_KEY = '9463861a45169367';
const OPTIMISER_KEY = '776cc053553f4026';
const CAP = 1_500_000;

class DevTape {
  constructor(stream, rows = 2500) {
    this.rows = Array.from({ length: rows }, (_, offset) => stream.row(offset + 1));
    this.manifest = {
      partition: 'DEV', rows, source_key_hex: SOURCE_KEY,
      feature_sha256: createHash('sha256').update(JSON.stringify(this.rows.map((row) => row.x))).digest('hex'),
      label_sha256: createHash('sha256').update(Buffer.from(this.rows.map((row) => row.y))).digest('hex'),
    };
  }
  revealedWindow(end, length = 500) {
    return this.rows.slice(end - length, end).map((row) => structuredClone(row));
  }
  cursor(start, end) {
    let next = start;
    let pending = null;
    return {
      features: () => {
        if (pending !== null || next > end) throw new Error('feature request violates two-tape order');
        pending = next;
        return { index: next, x: [...this.rows[next - 1].x] };
      },
      label: (index) => {
        if (index !== pending) throw new Error('label reveal does not match pending feature row');
        const y = this.rows[index - 1].y;
        pending = null;
        next += 1;
        return y;
      },
      finish: () => {
        if (pending !== null || next !== end + 1) throw new Error('cursor did not consume declared extent');
      },
    };
  }
}

function qualificationFixture() {
  const stream = new DevelopmentStream({
    scenario: 'LOCAL_TREE-STATIONARY-NONE',
    realisation: 0,
    streamKey: SOURCE_KEY,
  });
  const tape = new DevTape(stream);
  const index = new CompactProvenanceIndex();
  const learner = new EvolutionLearner({
    key: OPTIMISER_KEY,
    config: {
      featureCount: 8,
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
    provenancePrefix: 'I06-BOUNDED-DEV-PARENT',
    emit: (event) => index.append(event),
  });
  const window = tape.revealedWindow(500, 500);
  const report = learner.initialise(window, 500);
  assert.equal(report.mandatory_stage_committed, true);
  index.prune(learner.snapshot());
  const verification = index.verifySnapshot(learner.snapshot());
  const snapshot = {
    schema_version: 1,
    learner: learner.snapshot(),
    window,
    lastIndex: 500,
    pendingUpdate: true,
    protocolHash: PROTOCOL_HASH,
  };
  const identity = {
    partition: 'DEV',
    scenario_id: 'LOCAL_TREE-STATIONARY-NONE',
    realisation: 0,
    source_key_hex: SOURCE_KEY,
    optimizer_key_hex: OPTIMISER_KEY,
  };
  return { tape, snapshot, identity, verification };
}

function deterministicArmProjection(value) {
  return {
    arm: value.arm,
    status: value.status,
    treatment_applied: value.treatment_applied,
    initial_status: value.initial_status,
    failure_after_offset: value.failure_after_offset,
    horizons: value.horizons,
    predicate_tests_total: value.predicate_tests_total,
    resources: {
      update_events: value.resources.update_events,
      adaptation_apw_total: value.resources.adaptation_apw_total,
      construction_apw_total: value.resources.construction_apw_total,
      candidate_evaluations: value.resources.candidate_evaluations,
      node_example_visits: value.resources.node_example_visits,
      mandatory_stage_failures: value.resources.mandatory_stage_failures,
      terminal_failures: value.resources.terminal_failures,
    },
    end_state: value.end_state,
    provenance: value.provenance,
    before_update_audit: value.before_update_audit,
  };
}

test('bounded DEV integration executes all three policies over the full 2,000-row primary horizon', { timeout: 120_000 }, () => {
  const fixture = qualificationFixture();
  const outputs = {};
  for (const arm of ['PERSIST', 'CHAMPION-RESEED', 'POPULATION-RESEED']) {
    outputs[arm] = runI06StateArm(
      fixture.snapshot,
      fixture.tape,
      500,
      arm,
      CAP,
      fixture.identity,
      fixture.verification,
    );
    assert.equal(outputs[arm].status, 'COMPLETE');
    assert.equal(outputs[arm].horizons['500'].predictions, 500);
    assert.equal(outputs[arm].horizons['2000'].predictions, 2000);
    assert.equal(outputs[arm].provenance.closed, true);
    assert.ok(outputs[arm].resources.adaptation_apw_total <= CAP * 21);
  }
  assert.equal(
    outputs['POPULATION-RESEED'].before_update_audit.population_multiset_sha256,
    populationMultisetDigest(EvolutionLearner.restore(fixture.snapshot.learner).population),
  );
  assert.equal(outputs.PERSIST.resources.construction_apw_total, 0);
  assert.ok(outputs['POPULATION-RESEED'].resources.construction_apw_total > 0);
});

test('bounded DEV policy replay is scientifically deterministic', { timeout: 120_000 }, () => {
  const fixture = qualificationFixture();
  const one = runI06StateArm(fixture.snapshot, fixture.tape, 500, 'POPULATION-RESEED', CAP, fixture.identity, fixture.verification);
  const two = runI06StateArm(fixture.snapshot, fixture.tape, 500, 'POPULATION-RESEED', CAP, fixture.identity, fixture.verification);
  assert.deepEqual(deterministicArmProjection(one), deterministicArmProjection(two));
});

test('construction exhaustion is totalised over the full planned denominator without fallback', () => {
  const fixture = qualificationFixture();
  const failed = runI06StateArm(fixture.snapshot, fixture.tape, 500, 'POPULATION-RESEED', 1, fixture.identity, fixture.verification);
  assert.equal(failed.initial_status, 'ALGORITHMIC_FAILURE');
  assert.equal(failed.status, 'ALGORITHMIC_FAILURE');
  assert.equal(failed.treatment_applied, true);
  assert.equal(failed.horizons['2000'].loss_sum, 2000);
  assert.equal(failed.horizons['2000'].mean_loss, 1);
});

test('I06 record envelope is self-authenticating and tamper-evident', () => {
  const arm = {
    status: 'COMPLETE',
    horizons: { '500': { predictions: 500 }, '2000': { predictions: 2000 } },
  };
  const record = sealI06Record({
    schema_version: 1,
    phase: 'I06_NESTED_TRANSFER_STUDY',
    partition: 'DEV',
    protocol_id: 'DT-I05-NST-v1.0',
    integrity_status: 'VALID_RAW_I06_EVIDENCE',
    checkpoints: [10000, 20000].map((checkpoint) => ({
      checkpoint,
      horizon_executed: 2000,
      state: {
        PERSIST: structuredClone(arm),
        'CHAMPION-RESEED': structuredClone(arm),
        'POPULATION-RESEED': structuredClone(arm),
      },
    })),
  });
  assert.equal(verifyI06Record(record), true);
  record.checkpoints[0].state.PERSIST.horizons['2000'].predictions = 1999;
  assert.throws(() => verifyI06Record(record), /invalid I06 arm evidence|digest mismatch/);
});
