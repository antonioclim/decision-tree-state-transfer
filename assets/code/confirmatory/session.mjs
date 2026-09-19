import { createHash } from 'node:crypto';
import { EvolutionLearner, ARMS } from './learner.mjs';
import { treeHash } from './trees.mjs';
import { COMPONENTS } from './work.mjs';

export function hashObject(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** A three-call information boundary. The learner sees no label at input/predict time. */
export class PrequentialSession {
  constructor({ learner, window, cap, budgetTag = '2', contextCheckpoint = 0, arm = 'PERSIST',
    pendingUpdate = false, treatmentPending = false, emit = null, attemptId = 'DEV', runId = 'DEV', protocolHash, ledgerFactory = null }) {
    if (!(learner instanceof EvolutionLearner) || !ARMS.includes(arm)) throw new TypeError('invalid session learner or arm');
    if (!/^[a-f0-9]{64}$/.test(protocolHash)) throw new TypeError('protocol SHA-256 required');
    if (!Array.isArray(window) || window.length === 0 || window.length > 500) throw new TypeError('invalid session window');
    const end = window.at(-1).index;
    if (!Number.isSafeInteger(end) || end < window.length || !Number.isSafeInteger(cap) || cap < 0
      || window.some((row, i) => row.index !== end - window.length + i + 1 || ![0, 1].includes(row.y)
        || !Array.isArray(row.x) || row.x.length !== learner.config.featureCount || !row.x.every(Number.isFinite))) throw new Error('invalid session chronology or allowance');
    this.learner = learner; this.window = structuredClone(window); this.lastIndex = window.at(-1).index;
    this.cap = cap; this.budgetTag = budgetTag; this.contextCheckpoint = contextCheckpoint; this.arm = arm;
    this.pendingUpdate = pendingUpdate; this.treatmentPending = treatmentPending; this.treatmentCount = 0;
    this.pending = null; this.sequence = 0; this.emit = emit; this.attemptId = attemptId; this.runId = runId;
    if (ledgerFactory !== null && typeof ledgerFactory !== 'function') throw new TypeError('invalid ledger factory');
    this.ledgerFactory = ledgerFactory;
    this.protocolHash = protocolHash; this.parentUnavailable = learner.failed;
  }
  event(kind, fields) {
    const e = { kind, attempt_id: this.attemptId, protocol_sha256: this.protocolHash,
      run_id: this.runId, event_sequence: ++this.sequence, ...fields };
    this.emit?.(e); return e.event_sequence;
  }
  input(payload) {
    if (!payload || Object.keys(payload).sort().join(',') !== 'index,x') throw new Error('input payload may contain features and index only');
    if (this.pending || this.pendingUpdate || payload.index !== this.lastIndex + 1
      || !Array.isArray(payload.x) || payload.x.length !== this.learner.config.featureCount || !payload.x.every(Number.isFinite)) {
      throw new Error('input violates chronology, update order or feature schema');
    }
    this.pending = { index: payload.index, x: [...payload.x], prediction: undefined, observed: this.lastIndex };
    this.pending.inputSeq = this.event('input', { observation_index: payload.index, x: [...payload.x], observed_data_last_index: this.lastIndex });
  }
  predict() {
    const p = this.pending;
    if (!p || p.prediction !== undefined) throw new Error('prediction must follow exactly one input');
    const counts = { predicate_tests: 0, node_visits: 0 }; const start = process.hrtime.bigint();
    p.prediction = this.learner.predict(p.x, counts); p.predictionNs = Number(process.hrtime.bigint() - start);
    p.predicateTests = counts.predicate_tests;
    p.modelHash = p.prediction !== null && this.learner.champion ? treeHash(this.learner.champion.tree) : null;
    p.predictSeq = this.event('predict', { observation_index: p.index, prediction: p.prediction, model_sha256: p.modelHash });
    return p.prediction;
  }
  reveal(label) {
    const p = this.pending;
    if (!p || p.prediction === undefined || ![0, 1].includes(label)) throw new Error('reveal must follow a binary prediction or declared failure');
    const revealSeq = this.event('reveal', { observation_index: p.index, label });
    const record = {
      observation_index: p.index, prediction: p.prediction, label,
      loss: p.prediction === null ? 1 : Number(p.prediction !== label), imputed_failure: p.prediction === null,
      model_sha256: p.modelHash, input_event_sequence: p.inputSeq, predict_event_sequence: p.predictSeq,
      reveal_event_sequence: revealSeq, observed_data_last_index: p.observed,
      prediction_ns: p.predictionNs, prediction_predicate_tests: p.predicateTests,
    };
    this.event('prediction', record);
    this.window.push({ index: p.index, x: [...p.x], y: label }); if (this.window.length > 500) this.window.shift();
    this.lastIndex = p.index; this.pending = null; this.pendingUpdate = this.lastIndex % 100 === 0;
    return record;
  }
  adapt({ cpuCapNs = null } = {}) {
    if (this.pending || !this.pendingUpdate) throw new Error('adaptation is not scheduled or a label is still hidden');
    if (this.learner.failed) {
      if (cpuCapNs !== null && (!Number.isSafeInteger(cpuCapNs) || cpuCapNs < 0)) throw new TypeError('invalid CPU allowance');
      const currentSnapshot = this.learner.snapshot();
      // A restored, already failed v1 snapshot remains historical. It cannot
      // acquire v3 terminal-state guarantees through a skipped operation.
      const historical = currentSnapshot.schema_version === 1;
      this.event('update_unavailable', { runtime_schema_version: historical ? 2 : 3,
        revealed_through_index: this.lastIndex, window_first_index: this.window[0].index, window_last_index: this.lastIndex,
        budget_axis: cpuCapNs === null ? 'APW_v1' : 'PROCESS_CPU_NS', budget_cap: cpuCapNs === null ? this.cap : cpuCapNs,
        apw_components: Object.fromEntries(COMPONENTS.map((key) => [key, 0])), adaptation_apw_total: 0,
        reason: this.parentUnavailable ? 'PARENT_UNAVAILABLE' : 'ALGORITHMIC_FAILURE_LATCHED',
        failure_latched: true, parent_unavailable: this.parentUnavailable, treatment_applied: false,
        population_size: 0, snapshot_sha256: hashObject(currentSnapshot),
        ...(historical ? {} : { update_index: this.learner.completedUpdates,
          scored_through_index: this.learner.scoredThrough, deployed_state_available: false }),
      });
      this.pendingUpdate = false;
      return { parent_unavailable: this.parentUnavailable, failed: true };
    }
    const arm = this.treatmentPending ? this.arm : ['NO_CROSSOVER', 'NO_MUTATION'].includes(this.arm) ? this.arm : 'PERSIST';
    const completedUpdatesBefore = this.learner.completedUpdates;
    const result = this.learner.update(this.window, { checkpoint: this.lastIndex, arm, cap: this.cap,
      cpuCapNs, budgetTag: this.budgetTag, contextCheckpoint: this.contextCheckpoint, ledgerFactory: this.ledgerFactory });
    if (this.treatmentPending) { this.treatmentCount++; this.learner.treatmentApplied = true; this.treatmentPending = false; }
    this.pendingUpdate = false;
    this.event('update', { runtime_schema_version: 3,
      update_index: this.learner.completedUpdates, revealed_through_index: this.lastIndex,
      window_first_index: this.window[0].index, window_last_index: this.lastIndex,
      budget_axis: cpuCapNs === null ? 'APW_v1' : 'PROCESS_CPU_NS', budget_cap: cpuCapNs === null ? this.cap : cpuCapNs,
      apw_components: result.apw_components, adaptation_apw_total: result.adaptation_apw_total,
      elapsed_ns: result.elapsed_ns, process_cpu_ns: result.process_cpu_ns, peak_rss_bytes: result.peak_rss_bytes,
      completed_rounds: result.completed_rounds, rejected_operations: result.rejected_operators,
      partial_scratch_discarded: result.partial_scratch_discarded, population_size: result.population_size,
      snapshot_sha256: hashObject(this.learner.snapshot()),
      update_outcome: this.learner.failed ? 'ALGORITHMIC_FAILURE'
        : result.mandatory_stage_committed ? 'COMMITTED' : 'RETAINED_AFTER_BUDGET_EXHAUSTION',
      failure_latched: this.learner.failed, mandatory_stage_committed: result.mandatory_stage_committed,
      deployed_state_available: !this.learner.failed, completed_updates_before: completedUpdatesBefore,
      exhausted_axis: result.exhausted_axis,
      scored_through_index: this.learner.scoredThrough, treatment_applied: arm === this.arm && this.treatmentCount === 1
        && this.contextCheckpoint === this.lastIndex,
      arm,
    });
    return result;
  }
  snapshot() {
    if (this.pending !== null) throw new Error('cannot checkpoint between input and label revelation');
    return { schema_version: 1, learner: this.learner.snapshot(), window: structuredClone(this.window),
      lastIndex: this.lastIndex, pendingUpdate: this.pendingUpdate, protocolHash: this.protocolHash };
  }
  static fork(snapshot, { arm, cap, budgetTag = '2', provenancePrefix = arm, emit = null, provenanceEmit = null,
    attemptId = 'DEV-FORK', runId = 'DEV-FORK', ledgerFactory = null }) {
    if (snapshot.schema_version !== 1 || snapshot.pendingUpdate !== true || snapshot.lastIndex !== snapshot.window.at(-1)?.index) {
      throw new Error('fork must capture the revealed checkpoint before its update');
    }
    const learner = EvolutionLearner.restore(snapshot.learner, { provenancePrefix, emit: provenanceEmit });
    const session = new PrequentialSession({ learner, window: snapshot.window, cap, budgetTag,
      contextCheckpoint: snapshot.lastIndex, arm, pendingUpdate: true, treatmentPending: true, emit,
      attemptId, runId, protocolHash: snapshot.protocolHash, ledgerFactory });
    return session;
  }
}
