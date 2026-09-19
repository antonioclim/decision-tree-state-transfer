import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { COMPONENTS } from './work.mjs';

/** JSON must not silently convert NaN, omit undefined fields or invoke user serialisers. */
export function strictJson(value) {
  const active = new Set();
  function inspect(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || active.has(item)) throw new TypeError('non-JSON value or cycle in evidence');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('evidence objects must have a plain JSON representation');
    }
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('symbol fields cannot be serialised as evidence');
    active.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertyNames(item).some((key) => key !== 'length'
        && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) throw new TypeError('non-index array fields are not JSON evidence');
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new TypeError('sparse arrays cannot be serialised as evidence');
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (descriptor.get || descriptor.set) throw new TypeError('array accessors are not supported');
        inspect(item[i]);
      }
    } else {
      if (Object.getOwnPropertyNames(item).length !== Object.keys(item).length) throw new TypeError('non-enumerable fields are not JSON evidence');
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor.get || descriptor.set) throw new TypeError('evidence accessors are not supported');
        inspect(item[key]);
      }
    }
    active.delete(item);
  }
  inspect(value); return JSON.stringify(value);
}

export class AttemptWriter {
  constructor(directory, metadata) {
    if (!['DEV', 'FIXTURE'].includes(metadata.partition)) throw new Error('Phase 10 accepts development evidence only');
    if (!metadata.attempt_id || !metadata.run_id || !/^[a-f0-9]{64}$/.test(metadata.protocol_sha256)) throw new Error('missing attempt metadata');
    strictJson(metadata);
    fs.mkdirSync(directory); // No recursive/overwrite escape: an attempt is immutable.
    this.directory = directory; this.metadata = structuredClone(metadata); this.closed = false;
    this.fd = fs.openSync(path.join(directory, 'events.jsonl'), 'wx'); this.digest = createHash('sha256');
    this.rows = 0; this.bytes = 0; this.poisoned = false;
    fs.writeFileSync(path.join(directory, 'started.json'), `${JSON.stringify({ ...metadata, status: 'RUNNING' }, null, 2)}\n`, { flag: 'wx' });
  }
  append(event) {
    if (this.closed || this.poisoned) throw new Error('attempt is closed or has an interrupted write');
    const bytes = Buffer.from(`${strictJson(event)}\n`, 'utf8');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error('invalid partial write result');
        this.digest.update(bytes.subarray(offset, offset + count)); this.bytes += count; offset += count;
      }
      this.rows++;
    } catch (error) { this.poisoned = true; throw error; }
  }
  finish(status, details = {}) {
    if (this.closed || !['COMPLETE', 'ALGORITHMIC_FAILURE', 'INFRASTRUCTURE_INTERRUPTION', 'INVALIDATED'].includes(status)) throw new Error('invalid attempt closure');
    if (this.poisoned && !['INVALIDATED', 'INFRASTRUCTURE_INTERRUPTION'].includes(status)) throw new Error('interrupted write cannot be certified complete');
    strictJson(details);
    for (const key of ['status', 'evidence_rows', 'evidence_bytes', 'events_sha256', ...Object.keys(this.metadata)]) {
      if (Object.hasOwn(details, key)) throw new Error(`closure cannot replace protected field: ${key}`);
    }
    fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.closed = true;
    const result = { ...this.metadata, ...details, status, evidence_rows: this.rows, evidence_bytes: this.bytes,
      events_sha256: this.digest.digest('hex') };
    fs.writeFileSync(path.join(this.directory, 'finished.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    return result;
  }
}

export function validateChronology(events, { firstIndex, lastIndex, requireInitialUpdate = false, requireTerminalUpdate = false,
  requireFailurePolicy = false, initialFailure = false }) {
  if (typeof requireInitialUpdate !== 'boolean' || typeof requireTerminalUpdate !== 'boolean'
    || (requireInitialUpdate && (firstIndex - 1) % 100 !== 0)) throw new Error('invalid update-boundary policy');
  if (!Number.isSafeInteger(firstIndex) || !Number.isSafeInteger(lastIndex) || firstIndex < 1 || lastIndex < firstIndex) throw new Error('invalid expected range');
  if (typeof requireFailurePolicy !== 'boolean' || typeof initialFailure !== 'boolean') throw new Error('invalid failure policy');
  let failureLatched = initialFailure; let failureSlots = 0; let unavailableUpdates = 0;
  let sequence = 0; let next = firstIndex; let updateDue = requireInitialUpdate; let lastUpdateAt = null;
  let completedUpdates = null; let runtimeVersion = null;
  /** @type {{input: any, predict: any, reveal: any} | null} */
  let pending = null; let predictions = 0;
  for (const e of events) {
    if (!Number.isSafeInteger(e.event_sequence) || e.event_sequence !== sequence + 1) throw new Error('non-contiguous event sequence');
    sequence = e.event_sequence;
    if (e.kind === 'input') {
      if (updateDue || pending || e.observation_index !== next || e.observed_data_last_index !== next - 1 || Object.hasOwn(e, 'label') || Object.hasOwn(e, 'y')) throw new Error('invalid input boundary');
      if (!Array.isArray(e.x) || !e.x.every(Number.isFinite)) throw new Error('invalid input features');
      pending = { input: e, predict: null, reveal: null };
    } else if (e.kind === 'predict') {
      if (!pending || pending.predict || e.observation_index !== next || ![0, 1, null].includes(e.prediction) || Object.hasOwn(e, 'label') || Object.hasOwn(e, 'y')
        || (e.prediction === null ? e.model_sha256 !== null : !/^[a-f0-9]{64}$/.test(e.model_sha256))) throw new Error('invalid predict event');
      if (requireFailurePolicy && (e.prediction === null) !== failureLatched) throw new Error('prediction violates latched failure policy');
      pending.predict = e;
    } else if (e.kind === 'reveal') {
      if (!pending?.predict || pending.reveal || e.observation_index !== next || ![0, 1].includes(e.label)) throw new Error('invalid reveal event');
      pending.reveal = e;
    } else if (e.kind === 'prediction') {
      if (!pending?.reveal || e.observation_index !== next || e.input_event_sequence !== pending.input.event_sequence
        || e.predict_event_sequence !== pending.predict.event_sequence || e.reveal_event_sequence !== pending.reveal.event_sequence
        || e.prediction !== pending.predict.prediction || e.model_sha256 !== pending.predict.model_sha256 || e.label !== pending.reveal.label
        || e.observed_data_last_index !== next - 1 || e.imputed_failure !== (e.prediction === null)
        || e.loss !== (e.prediction === null ? 1 : Number(e.prediction !== e.label))) throw new Error('invalid prediction evidence');
      failureSlots += Number(e.prediction === null);
      updateDue = next % 100 === 0; next++; predictions++; pending = null;
    } else if (e.kind === 'update' || e.kind === 'update_unavailable') {
      if (pending || lastUpdateAt === next - 1 || (!updateDue && next !== firstIndex) || e.revealed_through_index !== next - 1 || e.window_last_index !== next - 1
        || !['APW_v1', 'PROCESS_CPU_NS'].includes(e.budget_axis) || !Number.isSafeInteger(e.budget_cap) || e.budget_cap < 0
        || e.revealed_through_index % 100 !== 0 || !Number.isSafeInteger(e.window_first_index) || e.window_first_index < 1
        || e.window_first_index > e.window_last_index || e.window_last_index - e.window_first_index >= 500) throw new Error('update uses unrevealed data');
      updateDue = false; lastUpdateAt = next - 1;
      const c = e.apw_components;
      if (!c || Object.keys(c).sort().join(',') !== [...COMPONENTS].sort().join(',')
        || !Object.values(c).every((v) => Number.isSafeInteger(v) && v >= 0)
        || !Number.isSafeInteger(e.adaptation_apw_total) || e.adaptation_apw_total < 0
        || Object.values(c).reduce((a, b) => a + b, 0) !== e.adaptation_apw_total
        || (e.budget_axis === 'APW_v1' && e.adaptation_apw_total > e.budget_cap)) throw new Error('invalid adaptation accounting');
      if (e.kind === 'update_unavailable') {
        if (![2, 3].includes(e.runtime_schema_version) || e.failure_latched !== true || e.population_size !== 0 || e.adaptation_apw_total !== 0 || e.treatment_applied !== false
          || typeof e.parent_unavailable !== 'boolean' || !/^[a-f0-9]{64}$/.test(e.snapshot_sha256)
          || e.reason !== (e.parent_unavailable ? 'PARENT_UNAVAILABLE' : 'ALGORITHMIC_FAILURE_LATCHED')
          || (requireFailurePolicy && (!failureLatched || e.parent_unavailable !== initialFailure))) throw new Error('invalid unavailable-update declaration');
        if (e.runtime_schema_version === 3) {
          if (!Number.isSafeInteger(e.update_index) || e.update_index < 0 || e.scored_through_index !== null
            || e.deployed_state_available !== false || (completedUpdates !== null && e.update_index !== completedUpdates)) {
            throw new Error('contradictory version-3 unavailable update');
          }
          completedUpdates = e.update_index;
        }
        failureLatched = true; unavailableUpdates++;
      } else if (e.runtime_schema_version === 3) {
        if (failureLatched || typeof e.failure_latched !== 'boolean' || typeof e.mandatory_stage_committed !== 'boolean'
          || typeof e.treatment_applied !== 'boolean' || typeof e.arm !== 'string' || !e.arm
          || typeof e.deployed_state_available !== 'boolean' || !/^[a-f0-9]{64}$/.test(e.snapshot_sha256)
          || !Number.isSafeInteger(e.population_size) || e.population_size < 0
          || !Number.isSafeInteger(e.completed_rounds) || e.completed_rounds < 0
          || !Number.isSafeInteger(e.completed_updates_before) || e.completed_updates_before < 0
          || !Number.isSafeInteger(e.update_index) || e.update_index < 0
          || ![null, 'APW', 'CPU', 'RSS'].includes(e.exhausted_axis)) throw new Error('invalid version-3 update failure contract');
        const failed = e.update_outcome === 'ALGORITHMIC_FAILURE';
        const committed = e.update_outcome === 'COMMITTED';
        const retained = e.update_outcome === 'RETAINED_AFTER_BUDGET_EXHAUSTION';
        if ((!failed && !committed && !retained) || e.failure_latched !== failed || e.deployed_state_available === failed
          || e.update_index !== e.completed_updates_before + Number(e.mandatory_stage_committed)
          || (completedUpdates !== null && e.completed_updates_before !== completedUpdates)
          || (!e.mandatory_stage_committed && e.completed_rounds !== 0)
          || (e.exhausted_axis !== null && e.partial_scratch_discarded !== true)
          || (e.exhausted_axis === 'CPU' && e.budget_axis !== 'PROCESS_CPU_NS')
          || (failed && (e.population_size !== 0 || e.scored_through_index !== null || e.exhausted_axis === null))
          || (failed && e.mandatory_stage_committed && e.exhausted_axis !== 'RSS')
          || (!failed && (e.population_size === 0 || e.exhausted_axis === 'RSS'
            || !Number.isSafeInteger(e.scored_through_index) || e.scored_through_index < 1 || e.scored_through_index > next - 1))
          || (committed && (!e.mandatory_stage_committed || e.scored_through_index !== next - 1))
          || (retained && (e.mandatory_stage_committed || !['APW', 'CPU'].includes(e.exhausted_axis)))) {
          throw new Error('contradictory version-3 update outcome or stage counter');
        }
        completedUpdates = e.update_index; failureLatched = failed;
      } else if (requireFailurePolicy) {
        if (e.runtime_schema_version !== 2 || failureLatched || typeof e.failure_latched !== 'boolean' || typeof e.mandatory_stage_committed !== 'boolean'
          || typeof e.treatment_applied !== 'boolean' || !/^[a-f0-9]{64}$/.test(e.snapshot_sha256)
          || !Number.isSafeInteger(e.population_size) || e.population_size < 0
          || !['COMMITTED', 'ALGORITHMIC_FAILURE', 'RETAINED_AFTER_BUDGET_EXHAUSTION'].includes(e.update_outcome)) throw new Error('invalid update failure contract');
        if (e.failure_latched !== (e.update_outcome === 'ALGORITHMIC_FAILURE') || (e.failure_latched && e.population_size !== 0)
          || (!e.failure_latched && e.population_size === 0)
          || (e.update_outcome === 'COMMITTED' && (!e.mandatory_stage_committed || e.scored_through_index !== next - 1))
          || (e.update_outcome === 'RETAINED_AFTER_BUDGET_EXHAUSTION' && e.mandatory_stage_committed)
          || (e.failure_latched && e.mandatory_stage_committed)) throw new Error('contradictory update outcome');
        failureLatched = e.failure_latched;
      }
      if (requireFailurePolicy) {
        if (runtimeVersion !== null && runtimeVersion !== e.runtime_schema_version) throw new Error('mixed runtime failure contracts');
        runtimeVersion = e.runtime_schema_version;
      }

    } else throw new Error(`unrecognised event: ${e.kind}`);
  }
  if ((requireTerminalUpdate && updateDue) || pending || next !== lastIndex + 1 || predictions !== lastIndex - firstIndex + 1) throw new Error('incomplete prediction series');
  return { predictions, events: sequence, failure_slots: failureSlots, unavailable_updates: unavailableUpdates, failure_latched: failureLatched };
}

/** Verifies actual source links and connected witnesses, not just content equality. */
export function validateProvenance(events) {
  const nodes = new Map(); const edges = new Map(); const tokens = new Set(); const witnesses = new Map();
  function material(id) {
    const n = nodes.get(id);
    if (!n) throw new Error('unknown material node');
    return n.literal[0] === 'leaf' ? [n.token]
      : [n.token, n.left_edge.token, material(n.left_record), n.right_edge.token, material(n.right_record)];
  }
  for (const e of events) {
    if (e.kind === 'edge') {
      if (edges.has(e.id)) throw new Error('duplicate edge occurrence');
      if (e.source !== null) {
        const old = edges.get(e.source);
        if (!old || ['token', 'parent_token', 'child_token', 'slot'].some((k) => old[k] !== e[k])) throw new Error('invalid edge copy');
      } else {
        if (tokens.has(e.token)) throw new Error('independently minted duplicate token');
        tokens.add(e.token);
      }
      edges.set(e.id, structuredClone(e));
    } else if (e.kind === 'node') {
      if (nodes.has(e.id)) throw new Error('duplicate node occurrence');
      if (e.source !== null) {
        const old = nodes.get(e.source);
        if (!old || old.token !== e.token || JSON.stringify(old.literal) !== JSON.stringify(e.literal)) throw new Error('invalid literal copy');
      } else {
        if (tokens.has(e.token) || e.witness !== null) throw new Error('new material cannot claim old tokens or witnesses');
        tokens.add(e.token);
      }
      if (e.literal[0] === 'split') {
        for (const slot of ['left', 'right']) {
          const edge = edges.get(e[`${slot}_edge`].id); const child = nodes.get(e[`${slot}_record`]);
          if (!edge || !child || edge.parent_token !== e.token || edge.child_token !== child.token || edge.slot !== slot
            || ['id', 'token', 'source', 'parent_token', 'child_token', 'slot'].some((k) => edge[k] !== e[`${slot}_edge`][k])) throw new Error('invalid realised adjacency');
        }
      }
      nodes.set(e.id, structuredClone(e));
      if (e.witness !== null) {
        const witness = witnesses.get(e.witness.root_record);
        if (!witness || witness.update !== e.witness.update || witness.individual !== e.witness.individual
          || JSON.stringify(material(e.id)) !== JSON.stringify(material(e.witness.root_record))) throw new Error('forged connected-copy witness');
      }
    } else if (e.kind === 'realised-connected-subtree') {
      if (!nodes.has(e.record) || witnesses.has(e.record) || e.witness.root_record !== e.record
        || !Number.isInteger(e.witness.update) || e.witness.update < 0 || !e.witness.individual) throw new Error('invalid realised witness');
      witnesses.set(e.record, { ...e.witness });
    } else throw new Error('unrecognised provenance event');
  }
  return { node_records: nodes.size, edge_records: edges.size, realised_witnesses: witnesses.size };
}

/** Bounded-memory physical reader. Canonical writer bytes reject duplicate JSON keys. */
export function* readCanonicalEvents(filename, audit, { maxLineBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError('invalid line limit');
  const fd = fs.openSync(filename, 'r'); const buffer = Buffer.alloc(65536); const digest = createHash('sha256');
  let pending = Buffer.alloc(0); let total = 0; let rows = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count)); total += count;
      const block = Buffer.concat([pending, buffer.subarray(0, count)]); let start = 0;
      for (;;) {
        const end = block.indexOf(10, start); if (end < 0) break;
        const bytes = block.subarray(start, end);
        if (bytes.length === 0 || bytes.length > maxLineBytes) throw new Error('empty or oversized event line');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const event = JSON.parse(text);
        if (strictJson(event) !== text) throw new Error('noncanonical event encoding or duplicate JSON keys');
        rows++; yield event; start = end + 1;
      }
      pending = Buffer.from(block.subarray(start));
      if (pending.length > maxLineBytes) throw new Error('oversized unfinished event line');
    }
    if (pending.length || rows === 0) throw new Error('truncated or empty event file');
    Object.assign(audit, { bytes: total, rows, sha256: digest.digest('hex') });
  } finally { fs.closeSync(fd); }
}

/** Physical/chronological checks do not grant scientific or execution-lock admission. */
export function inspectAttempt(directory, { firstIndex, lastIndex, requireInitialUpdate = false, requireTerminalUpdate = false,
  requireFailurePolicy = false, initialFailure = false, maxLineBytes = 1024 * 1024 }) {
  const start = JSON.parse(fs.readFileSync(path.join(directory, 'started.json'), 'utf8'));
  const finish = JSON.parse(fs.readFileSync(path.join(directory, 'finished.json'), 'utf8'));
  if (!['COMPLETE', 'ALGORITHMIC_FAILURE'].includes(finish.status) || start.status !== 'RUNNING') throw new Error('attempt is not complete');
  for (const key of Object.keys(start).filter((k) => k !== 'status')) {
    if (JSON.stringify(start[key]) !== JSON.stringify(finish[key])) throw new Error('attempt metadata changed');
  }
  if (requireFailurePolicy && start.parent_unavailable !== initialFailure) throw new Error('initial failure differs from manifest');
  const audit = { bytes: 0, rows: 0, sha256: '' };
  function* identifiedEvents() {
    for (const event of readCanonicalEvents(path.join(directory, 'events.jsonl'), audit, { maxLineBytes })) {
      if (event.attempt_id !== start.attempt_id || event.run_id !== start.run_id || event.protocol_sha256 !== start.protocol_sha256) throw new Error('mixed attempt identity');
      yield event;
    }
  }
  const checked = validateChronology(identifiedEvents(), { firstIndex, lastIndex, requireInitialUpdate, requireTerminalUpdate,
    requireFailurePolicy, initialFailure });
  if (audit.bytes !== finish.evidence_bytes || audit.rows !== finish.evidence_rows || audit.sha256 !== finish.events_sha256) throw new Error('truncated or corrupt attempt');
  if (requireFailurePolicy && ((finish.status === 'ALGORITHMIC_FAILURE') !== checked.failure_latched)) throw new Error('closure contradicts failure lifecycle');
  return { ...checked, status: 'PHYSICAL_AND_CHRONOLOGICAL_CHECK_PASSED',
    scientific_admission: false, reason: 'Full source, provenance and execution-lock admission remain separate.' };
}
