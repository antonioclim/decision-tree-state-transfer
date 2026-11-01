import { createHash } from 'node:crypto';
import { EvolutionLearner } from '../../assets/code/confirmatory/learner.mjs';
import { PrequentialSession } from '../../assets/code/confirmatory/session.mjs';
import { ClosedProvenanceAudit, forkI06State, populationMultisetDigest } from '../../assets/code/confirmatory/i06-state.mjs';
import { nodeCount, treeDepth, treeHash } from '../../assets/code/confirmatory/trees.mjs';
import { CompactProvenanceIndex } from '../../assets/code/confirmatory/f10-compact-provenance.mjs';

const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

class Metrics {
  constructor() {
    this.errors = 0; this.n = [0, 0]; this.correct = [0, 0];
    this.predictionNs = 0; this.predicateTests = 0; this.horizons = {};
  }
  add(offset, prediction, y, predictionNs = 0, predicateTests = 0) {
    const ok = prediction !== null && prediction === y;
    this.errors += Number(!ok); this.n[y] += 1; this.correct[y] += Number(ok);
    this.predictionNs += predictionNs; this.predicateTests += predicateTests;
    if ([500, 2000].includes(offset)) this.horizons[String(offset)] = this.snapshot(offset);
  }
  snapshot(offset) {
    const deficient = this.n[0] === 0 || this.n[1] === 0;
    return {
      predictions: offset,
      loss_sum: this.errors,
      mean_loss: this.errors / offset,
      balanced_error: deficient ? this.errors / offset : 1 - 0.5 * (this.correct[0] / this.n[0] + this.correct[1] / this.n[1]),
      class_deficient: deficient,
      class_0_n: this.n[0], class_1_n: this.n[1],
      class_0_error: this.n[0] ? 1 - this.correct[0] / this.n[0] : null,
      class_1_error: this.n[1] ? 1 - this.correct[1] / this.n[1] : null,
    };
  }
  finish() { return { horizons: this.horizons, prediction_ns_total: this.predictionNs, predicate_tests_total: this.predicateTests }; }
}

function sumReports(reports) {
  const sum = (key) => reports.reduce((total, r) => total + (Number.isFinite(r?.[key]) ? r[key] : 0), 0);
  const max = (key) => Math.max(0, ...reports.map((r) => Number.isFinite(r?.[key]) ? r[key] : 0));
  return {
    update_events: reports.length,
    adaptation_apw_total: sum('adaptation_apw_total'),
    construction_apw_total: sum('construction_apw_total'),
    candidate_evaluations: sum('candidate_evaluations'),
    node_example_visits: sum('node_example_visits'),
    update_process_cpu_ns: sum('process_cpu_ns') + sum('update_process_cpu_ns') + sum('construction_process_cpu_ns'),
    update_elapsed_ns: sum('elapsed_ns') + sum('update_elapsed_ns') + sum('construction_elapsed_ns'),
    max_reported_peak_rss_bytes: max('peak_rss_bytes'),
    mandatory_stage_failures: reports.filter((r) => r?.mandatory_stage_committed === false).length,
    terminal_failures: reports.filter((r) => r?.initialisation_failed === true || r?.failed === true).length,
  };
}

function endState(session) {
  if (!session) return { state_available: false, population_size: 0, champion_nodes: null, champion_depth: null,
    population_multiset_sha256: null, snapshot_bytes: 0 };
  const learner = session.learner;
  const champion = learner.champion?.tree ?? null;
  return {
    state_available: !learner.failed && champion !== null,
    population_size: learner.population.length,
    champion_nodes: champion ? nodeCount(champion) : null,
    champion_depth: champion ? treeDepth(champion) : null,
    champion_sha256: champion ? treeHash(champion) : null,
    population_multiset_sha256: learner.population.length ? populationMultisetDigest(learner.population) : null,
    snapshot_bytes: Buffer.byteLength(JSON.stringify(learner.snapshot())),
  };
}

function continueArm(session, tape, checkpoint, horizon, reports, initialStatus, provenanceAudit) {
  const metrics = new Metrics();
  const cursor = tape.cursor(checkpoint + 1, checkpoint + horizon);
  let failureAfterOffset = session?.learner.failed ? 0 : null;
  for (let offset = 1; offset <= horizon; offset += 1) {
    const { index, x } = cursor.features();
    let prediction = null; let predictionNs = 0; let predicateTests = 0;
    if (session) { session.input({ index, x }); prediction = session.predict(); }
    const y = cursor.label(index);
    if (session) {
      const rec = session.reveal(y);
      predictionNs = rec.prediction_ns; predicateTests = rec.prediction_predicate_tests;
      if (session.pendingUpdate) {
        const wasFailed = session.learner.failed;
        const report = session.adapt(); reports.push(report);
        if (!wasFailed && session.learner.failed && failureAfterOffset === null) failureAfterOffset = offset;
      }
    }
    metrics.add(offset, prediction, y, predictionNs, predicateTests);
  }
  cursor.finish();
  const status = session === null ? initialStatus : session.learner.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE';
  const provenance = session && provenanceAudit ? provenanceAudit.verifySnapshot(session.learner.snapshot()) : null;
  return { status, initial_status: initialStatus, failure_after_offset: failureAfterOffset,
    ...metrics.finish(), resources: sumReports(reports), end_state: endState(session), provenance };
}

export function runI06StateArm(snapshot, tape, checkpoint, arm, mediumCap, identity, parentVerification) {
  const wall = process.hrtime.bigint(); const cpu0 = process.cpuUsage();
  const audit = arm === 'PERSIST'
    ? new ClosedProvenanceAudit({ arm, parentCertificateSha256: parentVerification.snapshot_sha256 })
    : new ClosedProvenanceAudit({ arm });
  if (arm === 'PERSIST') audit.trustParentSnapshot(snapshot.learner);
  const fork = forkI06State(snapshot, {
    arm, cap: mediumCap, sourceKeyHex: identity.source_key_hex,
    budgetTag: `I06|stream=${identity.source_key_hex}|checkpoint=${checkpoint}`,
    provenancePrefix: `I06:${identity.scenario_id}:${identity.realisation}:c${checkpoint}:${arm}`,
    provenanceAudit: audit,
    attemptId: `I06-${identity.source_key_hex}-${checkpoint}-${arm}`,
    runId: identity.source_key_hex,
    integrityStatus: 'VERIFIED', parentProvenanceVerified: true,
  });
  const reports = fork.report ? [fork.report] : [];
  const out = continueArm(fork.session, tape, checkpoint, 2000, reports, fork.status, audit);
  const cpu = process.cpuUsage(cpu0);
  return {
    arm,
    treatment_applied: fork.treatment_applied,
    source_parent_available: fork.source_parent_available,
    transferred_champion_sha256: fork.transferred_champion_sha256 ?? null,
    before_update_audit: fork.before_update_audit ?? null,
    ...out,
    process_cpu_ns_total: (cpu.user + cpu.system) * 1000,
    elapsed_ns_total: Number(process.hrtime.bigint() - wall),
  };
}

export function runI06Unit({ tape, identity, protocolHash, mediumCap }) {
  if (!tape || !identity || !/^[a-f0-9]{64}$/.test(protocolHash)
      || !Number.isSafeInteger(mediumCap) || mediumCap < 1) throw new Error('invalid I06 unit configuration');
  const started = process.hrtime.bigint(); const cpu0 = process.cpuUsage();
  const parentIndex = new CompactProvenanceIndex();
  const learner = new EvolutionLearner({ key: identity.optimizer_key_hex,
    provenancePrefix: `I06-PARENT:${identity.scenario_id}:${identity.realisation}`,
    emit: (event) => parentIndex.append(event) });
  const initialWindow = tape.revealedWindow(2000, 500);
  const initial = learner.initialise(initialWindow, 2000);
  if (learner.failed || !initial.mandatory_stage_committed) throw new Error('common parent initialisation failed');
  parentIndex.prune(learner.snapshot());
  const session = new PrequentialSession({ learner, window: initialWindow, cap: mediumCap,
    budgetTag: `I06|PARENT|stream=${identity.source_key_hex}`, protocolHash,
    pendingUpdate: false, treatmentPending: false, arm: 'PERSIST',
    attemptId: `I06-PARENT-${identity.source_key_hex}`, runId: identity.source_key_hex });
  const cursor = tape.cursor(2001, 20000); const checkpoints = []; const parentReports = [initial];
  for (let t = 2001; t <= 20000; t += 1) {
    const { index, x } = cursor.features();
    session.input({ index, x }); session.predict(); const y = cursor.label(index); session.reveal(y);
    if (t === 10000 || t === 20000) {
      const snapshot = session.snapshot();
      const parentVerification = parentIndex.verifySnapshot(snapshot.learner);
      const state = {};
      for (const arm of ['PERSIST', 'CHAMPION-RESEED', 'POPULATION-RESEED']) {
        state[arm] = runI06StateArm(snapshot, tape, t, arm, mediumCap, identity, parentVerification);
      }
      checkpoints.push({ checkpoint: t, horizon_executed: 2000,
        parent_state: {
          snapshot_sha256: parentVerification.snapshot_sha256,
          completed_updates: learner.completedUpdates,
          champion_sha256: learner.champion ? treeHash(learner.champion.tree) : null,
          population_multiset_sha256: learner.population.length ? populationMultisetDigest(learner.population) : null,
          snapshot_bytes: Buffer.byteLength(JSON.stringify(snapshot.learner)),
        }, state });
    }
    if (session.pendingUpdate && t < 20000) {
      const report = session.adapt(); parentReports.push(report); parentIndex.prune(learner.snapshot());
    }
  }
  cursor.finish();
  const parentProvenance = parentIndex.finish(learner.snapshot());
  const cpu = process.cpuUsage(cpu0);
  const record = {
    schema_version: 1,
    phase: 'I06_NESTED_TRANSFER_STUDY',
    partition: identity.partition,
    protocol_id: 'DT-I05-NST-v1.0',
    scientific_interpretation_authorised: false,
    integrity_status: 'VALID_RAW_I06_EVIDENCE',
    identity,
    source: tape.manifest,
    primary_medium_update_cap: mediumCap,
    parent: {
      initialisation_apw: initial.adaptation_apw_total,
      reports: sumReports(parentReports),
      failed: learner.failed,
      provenance: parentProvenance,
    },
    checkpoints,
    execution: {
      node: process.version.slice(1),
      process_cpu_ns_total: (cpu.user + cpu.system) * 1000,
      elapsed_ns_total: Number(process.hrtime.bigint() - started),
      record_sha256_basis: 'canonical JSON without record_sha256',
    },
  };
  return sealI06Record(record);
}

export function sealI06Record(record) {
  const copy = structuredClone(record); delete copy.record_sha256;
  return { ...copy, record_sha256: sha256(JSON.stringify(copy)) };
}

export function verifyI06Record(record) {
  if (!record || record.phase !== 'I06_NESTED_TRANSFER_STUDY'
      || !['DEV', 'EXT'].includes(record.partition) || record.protocol_id !== 'DT-I05-NST-v1.0'
      || record.integrity_status !== 'VALID_RAW_I06_EVIDENCE' || record.checkpoints?.length !== 2) {
    throw new Error('invalid I06 record envelope');
  }
  for (const checkpoint of record.checkpoints) {
    if (![10000, 20000].includes(checkpoint.checkpoint) || checkpoint.horizon_executed !== 2000) throw new Error('invalid I06 checkpoint');
    for (const arm of ['PERSIST', 'CHAMPION-RESEED', 'POPULATION-RESEED']) {
      const value = checkpoint.state?.[arm];
      if (!value || !['COMPLETE', 'ALGORITHMIC_FAILURE', 'TREATMENT_UNAVAILABLE'].includes(value.status)
          || value.horizons?.['500']?.predictions !== 500 || value.horizons?.['2000']?.predictions !== 2000) {
        throw new Error(`invalid I06 arm evidence: ${arm}`);
      }
    }
  }
  const { record_sha256: claimed, ...basis } = record;
  if (!/^[a-f0-9]{64}$/.test(claimed) || sha256(JSON.stringify(basis)) !== claimed) throw new Error('I06 record digest mismatch');
  return true;
}
