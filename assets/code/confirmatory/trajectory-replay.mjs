/** Source-bound deterministic APW replay. This module never authorises CONF.
 * It re-executes the same pinned learner, not an independently implemented method.
 * Measured clocks are type-checked but excluded from deterministic comparison.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DevelopmentStream } from './generator.mjs';
import { EvolutionLearner, CONFIG, ARMS, makeConfig } from './learner.mjs';
import { keyFromAddress } from './random.mjs';
import { PrequentialSession, hashObject } from './session.mjs';
import { strictJson, validateChronology } from './evidence.mjs';
import { ChunkedEvidenceWriter, readChunkedEvents } from './chunked-evidence.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TIMING_FIELDS = Object.freeze({
  prediction: ['prediction_ns'],
  update: ['elapsed_ns', 'process_cpu_ns', 'peak_rss_bytes'],
});
const PLAN_FIELDS = ['schema_version', 'scope', 'partition', 'scenario', 'realisation', 'optimiser',
  'protocol_sha256', 'arm', 'start', 'end', 'apw_cap', 'budget_tag', 'config', 'provenance_prefix',
  'run_id', 'attempt_id', 'parent_session_sha256', 'save_checkpoints'];
const MODULE_PATHS = ['generator.mjs', 'random.mjs', 'learner.mjs', 'trees.mjs', 'work.mjs',
  'session.mjs', 'evidence.mjs', 'chunked-evidence.mjs', 'trajectory-replay.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function equal(a, b, message) { if (strictJson(a) !== strictJson(b)) throw new Error(message); }
function exactFields(object, fields, message) {
  if (!object || Array.isArray(object) || Object.keys(object).sort().join('|') !== [...fields].sort().join('|')) throw new Error(message);
}
export function replaySourceHashes() {
  return Object.fromEntries(MODULE_PATHS.map(name => [`assets/code/confirmatory/${name}`, sha(fs.readFileSync(new URL(name, import.meta.url)))]));
}
export function validateReplayPlan(plan, parent = null) {
  strictJson(plan); exactFields(plan, PLAN_FIELDS, 'unexpected plan fields');
  if (plan.schema_version !== 1 || plan.partition !== 'DEV' || !['DEV_CHECK', 'FIXTURE'].includes(plan.scope)) throw new Error('DEV/FIXTURE only; CONF remains closed');
  const protocol = sha(fs.readFileSync(path.join(ROOT, 'working/phase9/PROTOCOL_SPEC.json')));
  if (plan.protocol_sha256 !== protocol) throw new Error('protocol does not match the current pinned bytes');
  if (!Number.isSafeInteger(plan.optimiser) || plan.optimiser < 0 || plan.optimiser > 1) throw new Error('invalid DEV optimiser');
  if (plan.arm !== 'PARENT' && !ARMS.includes(plan.arm)) throw new Error('unknown trajectory arm');
  if (![plan.start, plan.end, plan.apw_cap].every(Number.isSafeInteger) || plan.start < 500 || plan.start % 100 !== 0
    || plan.end <= plan.start || plan.end > 26000 || plan.apw_cap < 0 || plan.apw_cap >= Number.MAX_SAFE_INTEGER) throw new Error('invalid trajectory range or APW allowance');
  if (typeof plan.budget_tag !== 'string' || !/^[124]$/.test(plan.budget_tag)) throw new Error('CPU or unspecified budget cannot enter deterministic APW replay');
  if (![plan.provenance_prefix, plan.run_id, plan.attempt_id].every(x => typeof x === 'string' && ID.test(x))) throw new Error('invalid replay namespace');
  if (!Array.isArray(plan.save_checkpoints) || new Set(plan.save_checkpoints).size !== plan.save_checkpoints.length
    || plan.save_checkpoints.some(t => !Number.isSafeInteger(t) || t <= plan.start || t > plan.end || t % 100 !== 0)
    || plan.save_checkpoints.some((t, i) => i > 0 && t <= plan.save_checkpoints[i-1])) throw new Error('invalid checkpoint inventory');
  const config = makeConfig(plan.config);
  equal(plan.config, config, 'configuration must contain exactly the effective constructor fields');
  if (plan.scope === 'DEV_CHECK') {
    equal(config, CONFIG, 'production-size DEV check must use the fixed configuration');
    if (plan.apw_cap !== 1555060 * Number(plan.budget_tag)) throw new Error('DEV allowance does not match the fixed APW calibration');
    if (plan.arm === 'PARENT' ? plan.start !== 2000 : ![10000, 20000].includes(plan.start)) throw new Error('invalid full-size DEV intervention checkpoint');
  }
  const stream = new DevelopmentStream({ partition: plan.partition, scenario: plan.scenario, realisation: plan.realisation });
  const key = keyFromAddress(`${stream.address}|optimiser=${String(plan.optimiser).padStart(2, '0')}`);
  if (plan.arm === 'PARENT') {
    if (parent !== null || plan.parent_session_sha256 !== null) throw new Error('cold parent cannot import a supplied ancestor');
  } else {
    if (!parent || !HASH.test(plan.parent_session_sha256 ?? '') || hashObject(parent) !== plan.parent_session_sha256) throw new Error('independent parent session anchor required');
    if (parent.schema_version !== 1 || parent.pendingUpdate !== true || parent.lastIndex !== plan.start || parent.protocolHash !== protocol
      || parent.learner.key !== key || parent.learner.scoredThrough > plan.start) throw new Error('parent identity or temporal boundary differs');
    equal(parent.window, stream.window(plan.start), 'parent source window differs');
    equal(parent.learner.config, config, 'parent configuration differs');
    EvolutionLearner.restore(parent.learner);
  }
  return { stream, key, config };
}

/** Only three measured event quantities and the prediction clock are excluded. */
export function deterministicEvent(event) {
  const excluded = TIMING_FIELDS[event.kind] ?? [];
  for (const field of excluded) if (!Number.isSafeInteger(event[field]) || event[field] < 0) throw new Error(`invalid measured field: ${field}`);
  return Object.fromEntries(Object.entries(event).filter(([key]) => !excluded.includes(key)));
}

function run(plan, parent, eventEmit, provenanceEmit, snapshotEmit) {
  const { stream, key, config } = validateReplayPlan(plan, parent);
  let session; let predictions = 0; let updates = 0; let failures = 0;
  const checkpoints = {};
  const events = createHash('sha256'); const provenance = createHash('sha256');
  const trace = e => { provenance.update(strictJson(e)+'\n'); provenanceEmit(e); };
  const emit = e => {
    events.update(strictJson(deterministicEvent(e))+'\n'); eventEmit(e);
    if (e.kind === 'prediction') { predictions++; failures += Number(e.imputed_failure); }
    if (e.kind === 'update' || e.kind === 'update_unavailable') {
      updates++; snapshotEmit(`after-${e.revealed_through_index}`, session.learner.snapshot());
    }
  };
  if (plan.arm === 'PARENT') {
    const learner = new EvolutionLearner({ key, config, provenancePrefix: plan.provenance_prefix, emit: trace });
    learner.initialise(stream.window(plan.start), plan.start);
    session = new PrequentialSession({ learner, window: stream.window(plan.start), cap: plan.apw_cap, budgetTag: plan.budget_tag,
      protocolHash: plan.protocol_sha256, emit, attemptId: plan.attempt_id, runId: plan.run_id });
  } else {
    session = PrequentialSession.fork(parent, { arm: plan.arm, cap: plan.apw_cap, budgetTag: plan.budget_tag,
      provenancePrefix: plan.provenance_prefix, provenanceEmit: trace, emit, attemptId: plan.attempt_id, runId: plan.run_id });
  }
  snapshotEmit('initial', session.learner.snapshot());
  if (session.pendingUpdate) session.adapt();
  for (let t = plan.start+1; t <= plan.end; t++) {
    const x = stream.features(t); session.input({ index: t, x }); session.predict(); session.reveal(stream.label(t, x));
    if (plan.save_checkpoints.includes(t)) {
      checkpoints[t] = session.snapshot(); snapshotEmit(`checkpoint-${t}`, checkpoints[t]);
    }
    if (session.pendingUpdate) session.adapt();
  }
  const final = session.snapshot(); snapshotEmit('final-session', final);
  return { summary: { predictions, updates, failure_slots: failures, failed: session.learner.failed,
    event_signature_sha256: events.digest('hex'), provenance_sha256: provenance.digest('hex'), final_state_sha256: hashObject(final) },
    checkpoints };
}

function readRegular(filename, maxBytes) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > maxBytes) throw new Error('unbounded or nonregular capsule file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function loadJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const value = JSON.parse(text);
  if (strictJson(value)+'\n' !== text) throw new Error('noncanonical capsule JSON');
  return value;
}
function ensureDirectory(directory) {
  const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('capsule directory is not a genuine directory');
}
function snapshotDescriptor(name, value, directory) {
  const bytes = Buffer.from(strictJson(value)+'\n'); const gzip = gzipSync(bytes, { level: 6 }); const file = name+'.json.gz';
  fs.writeFileSync(path.join(directory, file), gzip, { flag: 'wx' });
  return { name, file, raw_bytes: bytes.length, gzip_bytes: gzip.length, sha256: sha(bytes), gzip_sha256: sha(gzip) };
}
export function recordTrajectory(directory, plan, parent = null) {
  validateReplayPlan(plan, parent); fs.mkdirSync(directory); fs.mkdirSync(path.join(directory, 'snapshots'));
  const metadata = { partition: plan.scope === 'FIXTURE' ? 'FIXTURE' : 'DEV', attempt_id: plan.attempt_id, run_id: plan.run_id, protocol_sha256: plan.protocol_sha256 };
  fs.writeFileSync(path.join(directory, 'PLAN.json'), strictJson(plan)+'\n', { flag: 'wx' });
  const eventWriter = new ChunkedEvidenceWriter(path.join(directory, 'events'), metadata);
  const traceWriter = new ChunkedEvidenceWriter(path.join(directory, 'provenance'), metadata);
  const snapshots = [];
  // A failed execution is deliberately left incomplete. No synthetic COMPLETE receipt is written.
  const started = process.cpuUsage();
  const result = run(plan, parent, e => eventWriter.append(e), e => traceWriter.append(e),
    (name, value) => snapshots.push(snapshotDescriptor(name, value, path.join(directory, 'snapshots'))));
  const status = result.summary.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE';
  const traceManifest = traceWriter.finish(status); const eventManifest = eventWriter.finish(status);
  const used = process.cpuUsage(started);
  const capsule = { schema_version: 1, kind: 'APW_DETERMINISTIC_REPLAY_V1', plan_sha256: hashObject(plan), sources: replaySourceHashes(),
    status, summary: result.summary, snapshots, event_manifest_sha256: eventManifest.manifest_sha256,
    provenance_manifest_sha256: traceManifest.manifest_sha256, recording_cpu_ns: (used.user+used.system)*1000,
    scientific_admission: false, confirmation_authorised: false };
  const bytes = Buffer.from(strictJson(capsule)+'\n'); fs.writeFileSync(path.join(directory, 'CAPSULE.json'), bytes, { flag: 'wx' });
  return { capsule, capsule_sha256: sha(bytes), checkpoints: result.checkpoints };
}

export function verifyTrajectory(directory, plan, { capsuleSha256 = undefined, parent = null } = {}) {
  validateReplayPlan(plan, parent); if (!HASH.test(capsuleSha256 ?? '')) throw new Error('external capsule SHA-256 required');
  ensureDirectory(directory); ensureDirectory(path.join(directory, 'snapshots'));
  equal(fs.readdirSync(directory).sort(), ['CAPSULE.json', 'PLAN.json', 'events', 'provenance', 'snapshots'].sort(), 'unlisted capsule file');
  const raw = readRegular(path.join(directory, 'CAPSULE.json'), 16*1024*1024);
  if (sha(raw) !== capsuleSha256) throw new Error('capsule SHA-256 mismatch');
  const c = loadJson(raw);
  exactFields(c, ['schema_version','kind','plan_sha256','sources','status','summary','snapshots','event_manifest_sha256',
    'provenance_manifest_sha256','recording_cpu_ns','scientific_admission','confirmation_authorised'], 'invalid capsule fields');
  if (c.schema_version !== 1 || c.kind !== 'APW_DETERMINISTIC_REPLAY_V1' || c.plan_sha256 !== hashObject(plan)
    || !['COMPLETE','ALGORITHMIC_FAILURE'].includes(c.status) || c.scientific_admission !== false || c.confirmation_authorised !== false
    || !Number.isSafeInteger(c.recording_cpu_ns) || c.recording_cpu_ns < 0) throw new Error('invalid capsule identity/status');
  equal(c.sources, replaySourceHashes(), 'executing source hashes differ');
  equal(loadJson(readRegular(path.join(directory, 'PLAN.json'), 1024*1024)), plan, 'external plan differs');
  if (!Array.isArray(c.snapshots) || c.snapshots.length > 1000) throw new Error('invalid snapshot inventory');
  const names = new Set();
  for (const s of c.snapshots) {
    exactFields(s, ['name','file','raw_bytes','gzip_bytes','sha256','gzip_sha256'], 'invalid snapshot descriptor');
    if (!ID.test(s.name) || s.file !== s.name+'.json.gz' || names.has(s.name) || !HASH.test(s.sha256) || !HASH.test(s.gzip_sha256)
      || ![s.raw_bytes,s.gzip_bytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16*1024*1024)) throw new Error('invalid snapshot reference');
    names.add(s.name);
  }
  equal(fs.readdirSync(path.join(directory, 'snapshots')).sort(), c.snapshots.map(s => s.file).sort(), 'unlisted snapshot or missing snapshot');
  const eventAudit = {}; const traceAudit = {};
  const events = readChunkedEvents(path.join(directory,'events'), eventAudit, { expectedManifestSha256: c.event_manifest_sha256 });
  const traces = readChunkedEvents(path.join(directory,'provenance'), traceAudit, { expectedManifestSha256: c.provenance_manifest_sha256 });
  let snapshotIndex = 0; let comparedEvents = 0; let comparedTrace = 0;
  const result = run(plan, parent, e => {
    const entry = events.next(); if (entry.done) throw new Error('recorded events end before replay');
    equal(deterministicEvent(entry.value), deterministicEvent(e), `source-bound event mismatch at ${comparedEvents+1}`); comparedEvents++;
  }, e => {
    const entry = traces.next(); if (entry.done) throw new Error('recorded provenance ends before replay');
    equal(entry.value, e, `source-bound provenance mismatch at ${comparedTrace+1}`); comparedTrace++;
  }, (name, value) => {
    const s = c.snapshots[snapshotIndex++]; if (!s || s.name !== name) throw new Error('snapshot order differs from replay');
    const gzip = readRegular(path.join(directory, 'snapshots', s.file), 16*1024*1024);
    if (gzip.length !== s.gzip_bytes || sha(gzip) !== s.gzip_sha256) throw new Error('compressed snapshot mismatch');
    const bytes = gunzipSync(gzip, { maxOutputLength: 16*1024*1024 });
    if (bytes.length !== s.raw_bytes || sha(bytes) !== s.sha256) throw new Error('raw snapshot mismatch');
    equal(loadJson(bytes), value, 'snapshot differs from replayed learner state');
  });
  // Force exhaustion, which also performs final chunk/hash/row reconciliation.
  if (!events.next().done || !traces.next().done || snapshotIndex !== c.snapshots.length) throw new Error('surplus evidence beyond declared trajectory');
  equal(result.summary, c.summary, 'capsule summary differs from actual replay');
  const status = result.summary.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE';
  if (c.status !== status || eventAudit.status !== status || traceAudit.status !== status) throw new Error('closure contradicts reconstructed state');
  const metadata = { partition: plan.scope === 'FIXTURE' ? 'FIXTURE' : 'DEV', attempt_id: plan.attempt_id, run_id: plan.run_id, protocol_sha256: plan.protocol_sha256 };
  equal(eventAudit.metadata, metadata, 'event metadata differs'); equal(traceAudit.metadata, metadata, 'provenance metadata differs');
  const chronology = validateChronology(readChunkedEvents(path.join(directory,'events'), {}, { expectedManifestSha256: c.event_manifest_sha256 }),
    { firstIndex:plan.start+1, lastIndex:plan.end, requireInitialUpdate:plan.arm!=='PARENT', requireTerminalUpdate:true,
      requireFailurePolicy:true, initialFailure:parent?.learner.failed??false });
  return { status:'PASS_SOURCE_BOUND_APW_REPLAY', capsule_sha256:capsuleSha256, scope:plan.scope,
    ...result.summary, events_compared:comparedEvents, provenance_records_compared:comparedTrace,
    snapshots_compared:snapshotIndex, chronology, provenance_archive:traceAudit, event_archive:eventAudit,
    timing_values_reproduced:false, independent_algorithm_implementation:false, scientific_admission:false,
    confirmation_authorised:false, checkpoints:result.checkpoints };
}
