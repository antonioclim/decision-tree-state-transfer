/** CPU-limited DEV capsules. Replay is conditional on the recorded CPU/RSS tape.
 * It validates computed work and outputs under those decisions, not elapsed CPU
 * on another run. APW-only trajectories retain their separate verifier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PrequentialSession, hashObject } from './session.mjs';
import { strictJson, validateChronology } from './evidence.mjs';
import { ChunkedEvidenceWriter, readChunkedEvents } from './chunked-evidence.mjs';
import { CpuClockTape } from './cpu-clock-tape.mjs';
import { validateReplayPlan, replaySourceHashes } from './trajectory-replay.mjs';

const HASH = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function equal(a, b, message) { if (strictJson(a) !== strictJson(b)) throw new Error(message); }
function exact(value, fields) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) throw new Error('unexpected CPU capsule fields');
}
function regular(filename, max = 16 * 1024 * 1024) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > max) throw new Error('nonregular or oversized CPU capsule file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function canonical(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const value = JSON.parse(text);
  if (strictJson(value) + '\n' !== text) throw new Error('noncanonical CPU capsule JSON');
  return value;
}
function directory(dir) { const s = fs.lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('invalid CPU capsule directory'); }
function sources() {
  return { ...replaySourceHashes(), ...Object.fromEntries(['cpu-clock-tape.mjs', 'cpu-trajectory.mjs'].map(name =>
    [`assets/code/confirmatory/${name}`, sha(fs.readFileSync(new URL(name, import.meta.url)))])) };
}

export function validateCpuPlan(plan, parent) {
  strictJson(plan);
  if (plan.kind !== 'CPU_SAFE_BOUNDARY_V1' || plan.budget_tag !== 'CPU'
    || !Number.isSafeInteger(plan.cpu_cap_ns) || plan.cpu_cap_ns < 0
    || plan.apw_cap !== Number.MAX_SAFE_INTEGER || plan.arm === 'PARENT'
    || plan.end - plan.start > 5000 || plan.save_checkpoints?.length !== 0
    || (plan.scope === 'DEV_CHECK' && plan.cpu_cap_ns === 0)) throw new Error('invalid CPU-only DEV plan');
  // Reuse the strict identity/source/parent contract, not its APW execution path.
  const { cpu_cap_ns: unusedCap, kind: unusedKind, ...identity } = plan;
  if (unusedCap === undefined || unusedKind === undefined) throw new Error('missing CPU identity');
  const checked = validateReplayPlan({ ...identity, apw_cap: 3110120, budget_tag: '2' }, parent);
  return checked;
}
function eventDeterministic(e) {
  const omitted = e.kind === 'prediction' ? ['prediction_ns'] : e.kind === 'update' ? ['elapsed_ns', 'peak_rss_bytes'] : [];
  for (const field of omitted) if (!Number.isSafeInteger(e[field]) || e[field] < 0) throw new Error('invalid measured event quantity');
  // process_cpu_ns and CPU overshoot must match the consumed tape, not a new clock.
  return Object.fromEntries(Object.entries(e).filter(([key]) => !omitted.includes(key)));
}

function execute(plan, parent, tape, eventEmit, traceEmit, snapshotEmit) {
  const { stream } = validateCpuPlan(plan, parent);
  let session; let predictions = 0; let updates = 0; let failures = 0; let committed = 0;
  let maxOvershoot = 0; let cpuExits = 0; let apwGuardExits = 0; let rssExits = 0;
  const events = createHash('sha256'); const provenance = createHash('sha256');
  const trace = e => { provenance.update(strictJson(e) + '\n'); traceEmit(e); };
  const emit = original => {
    let e = original;
    if (e.kind === 'update') {
      const r = session.learner.lastUpdate;
      e = { ...e, cpu_cap_ns: r.cpu_cap_ns, cpu_overshoot_ns: r.cpu_overshoot_ns,
        exhausted_axis: r.exhausted_axis, apw_guard_cap: r.budget_cap };
      maxOvershoot = Math.max(maxOvershoot, r.cpu_overshoot_ns);
      committed += Number(r.mandatory_stage_committed); cpuExits += Number(r.exhausted_axis === 'CPU');
      apwGuardExits += Number(r.exhausted_axis === 'APW'); rssExits += Number(r.exhausted_axis === 'RSS');
    }
    events.update(strictJson(eventDeterministic(e)) + '\n'); eventEmit(e);
    if (e.kind === 'prediction') { predictions++; failures += Number(e.imputed_failure); }
    if (['update', 'update_unavailable'].includes(e.kind)) { updates++; snapshotEmit(`after-${e.revealed_through_index}`, session.learner.snapshot()); }
  };
  session = PrequentialSession.fork(parent, { arm: plan.arm, cap: plan.apw_cap, budgetTag: 'CPU',
    provenancePrefix: plan.provenance_prefix, provenanceEmit: trace, emit, attemptId: plan.attempt_id,
    runId: plan.run_id, ledgerFactory: (opts, context) => tape.makeLedger(opts, context) });
  snapshotEmit('initial', session.learner.snapshot());
  session.adapt({ cpuCapNs: plan.cpu_cap_ns });
  for (let t = plan.start + 1; t <= plan.end; t++) {
    const x = stream.features(t); session.input({ index: t, x }); session.predict(); session.reveal(stream.label(t, x));
    if (session.pendingUpdate) session.adapt({ cpuCapNs: plan.cpu_cap_ns });
  }
  const final = session.snapshot(); snapshotEmit('final-session', final);
  return { predictions, updates, failure_slots: failures, mandatory_stages_committed: committed,
    cpu_limit_exits: cpuExits, apw_guard_exits: apwGuardExits, rss_limit_exits: rssExits,
    maximum_reported_cpu_overshoot_ns: maxOvershoot, failed: session.learner.failed,
    event_signature_sha256: events.digest('hex'), provenance_sha256: provenance.digest('hex'),
    final_state_sha256: hashObject(final), clocks: tape.finish() };
}
function snapshotDescriptor(name, value, dir) {
  const bytes = Buffer.from(strictJson(value) + '\n'); const gzip = gzipSync(bytes, { level: 6 });
  const file = `${name}.json.gz`; fs.writeFileSync(path.join(dir, file), gzip, { flag: 'wx' });
  return { name, file, raw_bytes: bytes.length, gzip_bytes: gzip.length, sha256: sha(bytes), gzip_sha256: sha(gzip) };
}
export function recordCpuTrajectory(dir, plan, parent, { fixtureSampler = null } = {}) {
  validateCpuPlan(plan, parent);
  if (fixtureSampler !== null && plan.scope !== 'FIXTURE') throw new Error('DEV may not use a synthetic CPU clock');
  fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'snapshots'));
  fs.writeFileSync(path.join(dir, 'PLAN.json'), strictJson(plan) + '\n', { flag: 'wx' });
  const meta = { partition: plan.scope === 'FIXTURE' ? 'FIXTURE' : 'DEV', attempt_id: plan.attempt_id,
    run_id: plan.run_id, protocol_sha256: plan.protocol_sha256 };
  const eventWriter = new ChunkedEvidenceWriter(path.join(dir, 'events'), meta);
  const traceWriter = new ChunkedEvidenceWriter(path.join(dir, 'provenance'), meta);
  const clockWriter = new ChunkedEvidenceWriter(path.join(dir, 'clocks'), meta);
  const tape = new CpuClockTape({ mode: 'record', scope: plan.scope, emit: e => clockWriter.append(e), fixtureSampler });
  const snapshots = []; const start = process.cpuUsage();
  const summary = execute(plan, parent, tape, e => eventWriter.append(e), e => traceWriter.append(e),
    (name, value) => snapshots.push(snapshotDescriptor(name, value, path.join(dir, 'snapshots'))));
  const status = summary.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE';
  const eventManifest = eventWriter.finish(status); const traceManifest = traceWriter.finish(status); const clockManifest = clockWriter.finish(status);
  const cpu = process.cpuUsage(start);
  const capsule = { schema_version: 1, kind: 'CPU_CONDITIONAL_REPLAY_V1', plan_sha256: hashObject(plan), sources: sources(),
    status, summary, snapshots, event_manifest_sha256: eventManifest.manifest_sha256, provenance_manifest_sha256: traceManifest.manifest_sha256,
    clock_manifest_sha256: clockManifest.manifest_sha256, recording_cpu_ns: (cpu.user + cpu.system) * 1000,
    measurement_origin: fixtureSampler === null ? 'process.cpuUsage_and_memoryUsage.rss' : 'SYNTHETIC_FIXTURE',
    timing_authenticated: false, scientific_admission: false, confirmation_authorised: false };
  const raw = Buffer.from(strictJson(capsule) + '\n'); fs.writeFileSync(path.join(dir, 'CAPSULE.json'), raw, { flag: 'wx' });
  return { capsule, capsule_sha256: sha(raw) };
}

export function verifyCpuTrajectory(dir, plan, { parent, capsuleSha256 }) {
  validateCpuPlan(plan, parent); if (!HASH.test(capsuleSha256 ?? '')) throw new Error('external CPU capsule SHA-256 required');
  directory(dir); directory(path.join(dir, 'snapshots'));
  equal(fs.readdirSync(dir).sort(), ['CAPSULE.json', 'PLAN.json', 'clocks', 'events', 'provenance', 'snapshots'].sort(), 'unexpected CPU capsule member');
  const raw = regular(path.join(dir, 'CAPSULE.json')); if (sha(raw) !== capsuleSha256) throw new Error('CPU capsule hash mismatch');
  const c = canonical(raw);
  exact(c, ['schema_version', 'kind', 'plan_sha256', 'sources', 'status', 'summary', 'snapshots', 'event_manifest_sha256',
    'provenance_manifest_sha256', 'clock_manifest_sha256', 'recording_cpu_ns', 'measurement_origin', 'timing_authenticated', 'scientific_admission', 'confirmation_authorised']);
  if (c.schema_version !== 1 || c.kind !== 'CPU_CONDITIONAL_REPLAY_V1' || c.plan_sha256 !== hashObject(plan)
    || !['COMPLETE', 'ALGORITHMIC_FAILURE'].includes(c.status) || c.timing_authenticated !== false || c.scientific_admission !== false
    || c.confirmation_authorised !== false || !Number.isSafeInteger(c.recording_cpu_ns) || c.recording_cpu_ns < 0
    || !['process.cpuUsage_and_memoryUsage.rss', 'SYNTHETIC_FIXTURE'].includes(c.measurement_origin)
    || (plan.scope !== 'FIXTURE' && c.measurement_origin === 'SYNTHETIC_FIXTURE')) throw new Error('invalid CPU identity or admission claim');
  equal(c.sources, sources(), 'CPU source hashes differ');
  equal(canonical(regular(path.join(dir, 'PLAN.json'))), plan, 'CPU plan differs');
  if (!Array.isArray(c.snapshots) || c.snapshots.length > 1000) throw new Error('invalid CPU snapshot inventory');
  const names = new Set();
  for (const s of c.snapshots) {
    exact(s, ['name', 'file', 'raw_bytes', 'gzip_bytes', 'sha256', 'gzip_sha256']);
    if (typeof s.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(s.name) || s.file !== `${s.name}.json.gz`
      || names.has(s.name) || !HASH.test(s.sha256) || !HASH.test(s.gzip_sha256)
      || ![s.raw_bytes, s.gzip_bytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16*1024*1024)) throw new Error('invalid CPU snapshot descriptor');
    names.add(s.name);
  }
  equal(fs.readdirSync(path.join(dir, 'snapshots')).sort(), c.snapshots.map(s => s.file).sort(), 'CPU snapshots missing or surplus');
  const eventAudit = {}; const traceAudit = {}; const clockAudit = {};
  const events = readChunkedEvents(path.join(dir, 'events'), eventAudit, { expectedManifestSha256: c.event_manifest_sha256 });
  const traces = readChunkedEvents(path.join(dir, 'provenance'), traceAudit, { expectedManifestSha256: c.provenance_manifest_sha256 });
  const clocks = readChunkedEvents(path.join(dir, 'clocks'), clockAudit, { expectedManifestSha256: c.clock_manifest_sha256 });
  const tape = new CpuClockTape({ mode: 'replay', scope: plan.scope, iterator: clocks });
  let comparedEvents = 0; let comparedTrace = 0; let snapshotIndex = 0;
  const summary = execute(plan, parent, tape, e => {
    const observed = events.next(); if (observed.done) throw new Error('CPU event transcript is truncated');
    equal(eventDeterministic(observed.value), eventDeterministic(e), 'CPU conditional event mismatch'); comparedEvents++;
  }, e => {
    const observed = traces.next(); if (observed.done) throw new Error('CPU provenance transcript is truncated');
    equal(observed.value, e, 'CPU conditional provenance mismatch'); comparedTrace++;
  }, (name, value) => {
    const s = c.snapshots[snapshotIndex++]; if (!s || s.name !== name) throw new Error('CPU snapshot order differs');
    const gzip = regular(path.join(dir, 'snapshots', s.file));
    if (gzip.length !== s.gzip_bytes || sha(gzip) !== s.gzip_sha256) throw new Error('CPU gzip snapshot changed');
    const bytes = gunzipSync(gzip, { maxOutputLength: 16*1024*1024 });
    if (bytes.length !== s.raw_bytes || sha(bytes) !== s.sha256) throw new Error('CPU raw snapshot changed');
    equal(canonical(bytes), value, 'CPU snapshot does not reproduce recorded clock decisions');
  });
  if (!events.next().done || !traces.next().done || snapshotIndex !== c.snapshots.length) throw new Error('surplus CPU evidence');
  equal(c.summary, summary, 'CPU summary differs');
  const status = summary.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE';
  const meta = { partition: plan.scope === 'FIXTURE' ? 'FIXTURE' : 'DEV', attempt_id: plan.attempt_id,
    run_id: plan.run_id, protocol_sha256: plan.protocol_sha256 };
  for (const audit of [eventAudit, traceAudit, clockAudit]) {
    if (audit.status !== status || c.status !== status) throw new Error('CPU closure differs from replay');
    equal(audit.metadata, meta, 'CPU evidence identity differs');
  }
  const chronology = validateChronology(readChunkedEvents(path.join(dir, 'events'), {}, { expectedManifestSha256: c.event_manifest_sha256 }),
    { firstIndex: plan.start+1, lastIndex: plan.end, requireInitialUpdate: true, requireTerminalUpdate: true,
      requireFailurePolicy: true, initialFailure: parent.learner.failed });
  return { status: 'PASS_SOURCE_BOUND_CONDITIONAL_CPU_REPLAY', capsule_sha256: capsuleSha256, ...summary,
    events_compared: comparedEvents, provenance_records_compared: comparedTrace, snapshots_compared: snapshotIndex,
    event_archive: eventAudit, provenance_archive: traceAudit, clock_archive: clockAudit, chronology,
    measured_CPU_independently_reproduced: false, RSS_independently_reproduced: false, scientific_admission: false,
    confirmation_authorised: false, conditional_on_recorded_clock_and_RSS: true };
}
