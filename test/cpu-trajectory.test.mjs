import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import test, { after } from 'node:test';
import { WorkLedger, BudgetExhausted } from '../assets/code/confirmatory/work.mjs';
import { CpuClockTape } from '../assets/code/confirmatory/cpu-clock-tape.mjs';
import { EvolutionLearner, CONFIG } from '../assets/code/confirmatory/learner.mjs';
import { PrequentialSession, hashObject } from '../assets/code/confirmatory/session.mjs';
import { DevelopmentStream } from '../assets/code/confirmatory/generator.mjs';
import { keyFromAddress } from '../assets/code/confirmatory/random.mjs';
import { strictJson } from '../assets/code/confirmatory/evidence.mjs';
import { ChunkedEvidenceWriter, readChunkedEvents } from '../assets/code/confirmatory/chunked-evidence.mjs';
import { recordTrajectory, verifyTrajectory } from '../assets/code/confirmatory/trajectory-replay.mjs';
import { validateCpuPlan, recordCpuTrajectory, verifyCpuTrajectory } from '../assets/code/confirmatory/cpu-trajectory.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-trajectory-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = b => createHash('sha256').update(b).digest('hex');
const protocol = sha(fs.readFileSync(new URL('../working/phase9/PROTOCOL_SPEC.json', import.meta.url)));
const config = { ...CONFIG, populationSize: 6, cartDescendants: 3, elitism: 1, tournamentSize: 2,
  maxInitialDepth: 2, maxTreeDepth: 3, thresholdsPerFeature: 3, cartMaxDepth: 3 };
const pplan = { schema_version: 1, scope: 'FIXTURE', partition: 'DEV', scenario: 'OBLIQUE-ABRUPT-SEVERE', realisation: 0, optimiser: 0,
  protocol_sha256: protocol, arm: 'PARENT', start: 500, end: 700, apw_cap: 20000, budget_tag: '2', config,
  provenance_prefix: 'CLOCK-PARENT', run_id: 'CLOCK-PARENT', attempt_id: 'CLOCK-PARENT', parent_session_sha256: null, save_checkpoints: [600] };
const pp = recordTrajectory(path.join(tmp, 'parent'), pplan);
const parent = verifyTrajectory(path.join(tmp, 'parent'), pplan, { capsuleSha256: pp.capsule_sha256 }).checkpoints[600];
const plan = { ...pplan, kind: 'CPU_SAFE_BOUNDARY_V1', arm: 'PERSIST', start: 600, end: 800,
  apw_cap: Number.MAX_SAFE_INTEGER, budget_tag: 'CPU', cpu_cap_ns: 10000000, save_checkpoints: [],
  parent_session_sha256: hashObject(parent), provenance_prefix: 'CLOCK-CPU', run_id: 'CLOCK-CPU', attempt_id: 'CLOCK-CPU' };
const sampler = (_ledger, anchor) => ({ cpu_ns: anchor.sample_index * 100000, rss_bytes: 1000000 });
const original = path.join(tmp, 'original');
const recorded = recordCpuTrajectory(original, plan, parent, { fixtureSampler: sampler });
let serial = 0;
const newDir = prefix => path.join(tmp, `${prefix}-${++serial}`);
function copy() { const dir = newDir('copy'); fs.cpSync(original, dir, { recursive: true }); return dir; }
function load(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'CAPSULE.json'))); }
function save(dir, c) { const raw = Buffer.from(strictJson(c) + '\n'); fs.writeFileSync(path.join(dir, 'CAPSULE.json'), raw); return sha(raw); }
function verify(dir, p = plan, par = parent, digest = undefined) {
  return verifyCpuTrajectory(dir, p, { parent: par, capsuleSha256: digest ?? sha(fs.readFileSync(path.join(dir, 'CAPSULE.json'))) });
}
function change(dir, archive, fn) {
  const c = load(dir); const key = { events: 'event_manifest_sha256', provenance: 'provenance_manifest_sha256', clocks: 'clock_manifest_sha256' }[archive];
  const audit = {}; const rows = [...readChunkedEvents(path.join(dir, archive), audit, { expectedManifestSha256: c[key] })]; fn(rows);
  fs.rmSync(path.join(dir, archive), { recursive: true }); const w = new ChunkedEvidenceWriter(path.join(dir, archive), audit.metadata);
  for (const e of rows) w.append(e); c[key] = w.finish(c.status).manifest_sha256; save(dir, c);
}

test('CPU safe-boundary capsule replays source, work, states and conditional clocks', () => {
  const r = verify(original); assert.equal(r.predictions, 200); assert.equal(r.updates, 3);
  assert.equal(r.cpu_limit_exits, 3); assert.equal(r.apw_guard_exits, 0); assert.equal(r.failed, false);
  assert.equal(r.measured_CPU_independently_reproduced, false); assert.equal(r.conditional_on_recorded_clock_and_RSS, true);
  assert.equal(r.scientific_admission, false); assert.equal(r.confirmation_authorised, false);
});
for (const arm of ['RESTART', 'CHAMPION', 'NO_CROSSOVER', 'NO_MUTATION', 'RANDOM_RESTART', 'TEMPLATE_REFIT']) {
  test(`${arm} uses its real learner branch under the recorded CPU policy`, () => {
    const p = { ...plan, arm, provenance_prefix: arm, run_id: arm, attempt_id: arm };
    const dir = newDir(arm); recordCpuTrajectory(dir, p, parent, { fixtureSampler: sampler });
    const r = verify(dir, p); assert.equal(r.updates, 3); assert.equal(r.predictions, 200);
  });
}
test('actual process CPU recorder is exercised without a synthetic sampler', () => {
  const dir = newDir('actual'); const rec = recordCpuTrajectory(dir, plan, parent);
  assert.equal(rec.capsule.measurement_origin, 'process.cpuUsage_and_memoryUsage.rss');
  assert.equal(verify(dir).status, 'PASS_SOURCE_BOUND_CONDITIONAL_CPU_REPLAY');
});
test('zero CPU restart preserves all failed slots and future unavailable updates', () => {
  const p = { ...plan, arm: 'RESTART', cpu_cap_ns: 0 }; const dir = newDir('zero');
  recordCpuTrajectory(dir, p, parent, { fixtureSampler: sampler }); const r = verify(dir, p);
  assert.equal(r.failure_slots, 200); assert.equal(r.failed, true); assert.equal(r.clocks.ledgers, 1);
  assert.equal(r.chronology.unavailable_updates, 2);
});
test('RSS exhaustion is distinct from a CPU stop and is retained during conditional replay', () => {
  const dir = newDir('rss'); recordCpuTrajectory(dir, plan, parent, { fixtureSampler: () => ({ cpu_ns: 1000, rss_bytes: 3 * 1024 ** 3 }) });
  const r = verify(dir); assert.equal(r.rss_limit_exits, 1); assert.equal(r.cpu_limit_exits, 0); assert.equal(r.failure_slots, 200);
});
test('a failed parent preserves all slots without creating fictitious CPU samples', () => {
  const failed = structuredClone(parent); failed.learner.failed = true; failed.learner.population = []; failed.learner.championOrdinal = null;
  failed.learner.scoredThrough = null;
  const p = { ...plan, parent_session_sha256: hashObject(failed) }; const dir = newDir('parentfailed');
  recordCpuTrajectory(dir, p, failed, { fixtureSampler: sampler }); const r = verify(dir, p, failed);
  assert.equal(r.failure_slots, 200); assert.equal(r.clocks.samples, 0); assert.equal(r.chronology.unavailable_updates, 3);
});
test('safe-boundary overshoot is retained, not clipped to the cap', () => {
  const p = { ...plan, cpu_cap_ns: 10000001 }; const dir = newDir('overshoot');
  recordCpuTrajectory(dir, p, parent, { fixtureSampler: sampler }); const r = verify(dir, p);
  assert.ok(r.maximum_reported_cpu_overshoot_ns > 0);
});
test('CPU capsule requires an independently supplied outer digest', () => assert.throws(() => verifyCpuTrajectory(original, plan, { parent })));
test('wrong external hash is not silently replaced', () => assert.throws(() => verify(original, plan, parent, '0'.repeat(64))));
test('an existing attempt cannot be overwritten', () => assert.throws(() => recordCpuTrajectory(original, plan, parent)));
test('APW-only verifier rejects a CPU plan instead of suppressing its time budget', () => assert.throws(() => verifyTrajectory(original, plan, { capsuleSha256: recorded.capsule_sha256, parent })));
for (const [name, fn] of [
  ['CONF', p => { p.partition = 'CONF'; }], ['dual APW allowance', p => { p.apw_cap = 3110120; }],
  ['negative CPU cap', p => { p.cpu_cap_ns = -1; }], ['boolean CPU cap', p => { p.cpu_cap_ns = true; }],
  ['parent without source history', p => { p.arm = 'PARENT'; }], ['too long horizon', p => { p.end = p.start + 5001; }],
  ['unknown field', p => { p.approved = true; }], ['unknown kind', p => { p.kind = 'OTHER'; }],
  ['APW tag', p => { p.budget_tag = '2'; }], ['changed parent digest', p => { p.parent_session_sha256 = '0'.repeat(64); }],
  ['checkpoint inventory', p => { p.save_checkpoints = [700]; }], ['nonconforming production promotion', p => { p.scope = 'DEV_CHECK'; }],
]) test(`CPU plan rejects ${name}`, () => { const p = structuredClone(plan); fn(p); assert.throws(() => validateCpuPlan(p, parent)); });
for (const [archive, name, fn] of [
  ['events', 'features', rows => { rows.find(e => e.kind === 'input').x[0] += 1; }],
  ['events', 'labels', rows => { rows.find(e => e.kind === 'reveal').label ^= 1; }],
  ['events', 'predictions', rows => { rows.find(e => e.kind === 'predict').prediction ^= 1; }],
  ['events', 'losses', rows => { rows.find(e => e.kind === 'prediction').loss ^= 1; }],
  ['events', 'self-consistent false APW', rows => { const e = rows.find(e => e.kind === 'update'); e.apw_components.rng_variate++; e.adaptation_apw_total++; }],
  ['events', 'CPU report not matching tape', rows => { rows.find(e => e.kind === 'update').process_cpu_ns++; }],
  ['events', 'false overshoot', rows => { rows.find(e => e.kind === 'update').cpu_overshoot_ns++; }],
  ['events', 'missing update', rows => { rows.splice(rows.findIndex(e => e.kind === 'update'), 1); }],
  ['events', 'additional record', rows => { rows.push(rows.at(-1)); }],
  ['events', 'invalid non-CPU clock', rows => { rows.find(e => e.kind === 'prediction').prediction_ns = -1; }],
  ['provenance', 'fabricated node', rows => { rows[0].id = 'forged'; }],
  ['provenance', 'truncated provenance', rows => { rows.pop(); }],
  ['clocks', 'missing sample', rows => { rows.splice(1, 1); }],
  ['clocks', 'extra sample', rows => { rows.push(rows.at(-1)); }],
  ['clocks', 'decreasing CPU sample', rows => { rows[1].cpu_ns = 0; }],
  ['clocks', 'work-prefix mismatch', rows => { rows[1].adaptation_apw_total++; }],
  ['clocks', 'negative RSS', rows => { rows[0].rss_bytes = -1; }],
  ['clocks', 'boolean CPU time', rows => { rows[0].cpu_ns = true; }],
  ['clocks', 'changed stop decision', rows => { rows[0].cpu_ns = plan.cpu_cap_ns; }],
  ['clocks', 'different update identity', rows => { rows[0].checkpoint++; }],
]) test(`rehashing does not rescue ${name}`, () => { const dir = copy(); change(dir, archive, fn); assert.throws(() => verify(dir)); });
for (const [name, fn] of [
  ['summary', c => { c.summary.predictions++; }], ['timing authentication', c => { c.timing_authenticated = true; }],
  ['scientific admission', c => { c.scientific_admission = true; }], ['source', c => { c.sources['assets/code/confirmatory/learner.mjs'] = '0'.repeat(64); }],
  ['snapshot traversal', c => { c.snapshots[0].file = '../x'; }], ['duplicate snapshot', c => { c.snapshots.push(c.snapshots[0]); }],
  ['wrong status', c => { c.status = 'ALGORITHMIC_FAILURE'; }], ['unknown measurement origin', c => { c.measurement_origin = 'asserted'; }],
]) test(`rehashed capsule rejects ${name}`, () => { const dir = copy(); const c = load(dir); fn(c); save(dir, c); assert.throws(() => verify(dir)); });
test('snapshot contents are reconstructed, not merely rehashed', () => {
  const dir = copy(); const c = load(dir); const s = c.snapshots[0]; const p = path.join(dir, 'snapshots', s.file);
  const v = JSON.parse(gunzipSync(fs.readFileSync(p))); v.nextOrdinal++; const raw = Buffer.from(strictJson(v) + '\n'); const gz = gzipSync(raw);
  fs.writeFileSync(p, gz); Object.assign(s, { raw_bytes: raw.length, gzip_bytes: gz.length, sha256: sha(raw), gzip_sha256: sha(gz) }); save(dir, c); assert.throws(() => verify(dir));
});
for (const name of ['root', 'snapshots', 'clocks']) test(`unlisted ${name} file is rejected`, () => {
  const dir = copy(); fs.writeFileSync(path.join(dir, name === 'root' ? 'extra' : `${name}/extra`), 'x'); assert.throws(() => verify(dir));
});
test('symbolic-link snapshot is rejected', () => {
  const dir = copy(); const p = path.join(dir, 'snapshots', 'initial.json.gz'); fs.unlinkSync(p); fs.symlinkSync(path.join(original, 'snapshots', 'initial.json.gz'), p); assert.throws(() => verify(dir));
});
test('plausible changed non-CPU timings are outside the replay claim', () => {
  const dir = copy(); change(dir, 'events', rows => rows.filter(e => e.kind === 'prediction').forEach(e => { e.prediction_ns = 0; }));
  assert.equal(verify(dir).measured_CPU_independently_reproduced, false);
});

test('clock tape validates its construction and rejects custom samplers outside fixtures', () => {
  for (const opts of [{ mode: 'unknown' }, { mode: 'record' }, { mode: 'replay' }, { mode: 'record', emit: () => {}, fixtureSampler: sampler }]) assert.throws(() => new CpuClockTape(opts));
});
test('clock tape cannot have overlapping ledger intervals, duplicate reports or extra samples', () => {
  const rows = []; const t = new CpuClockTape({ mode: 'record', emit: e => rows.push(e), scope: 'FIXTURE', fixtureSampler: sampler });
  const context = { checkpoint: 600, arm: 'PERSIST', initialOnly: false }; const l = t.makeLedger({ cap: 100, cpuCapNs: 10000000 }, context);
  assert.throws(() => t.makeLedger({ cap: 100, cpuCapNs: 10000000 }, context)); assert.throws(() => t.finish());
  l.boundary(); l.report(); assert.throws(() => l.report()); assert.throws(() => l.boundary()); t.finish(); assert.throws(() => t.finish());
  const replay = new CpuClockTape({ mode: 'replay', iterator: [...rows, rows.at(-1)][Symbol.iterator](), scope: 'FIXTURE' });
  const rl = replay.makeLedger({ cap: 100, cpuCapNs: 10000000 }, context); rl.boundary(); rl.report(); assert.throws(() => replay.finish());
});
test('plausible clocks are not independently authenticated by a tape', () => {
  const t = new CpuClockTape({ mode: 'replay', scope: 'FIXTURE', iterator: [
    { kind: 'CPU_RSS_OBSERVATION_V1', ledger_index: 1, sample_index: 1, checkpoint: 600, arm: 'PERSIST', initial_only: false,
      phase: 'boundary', apw_cap: 100, cpu_cap_ns: 10000000, rss_limit_bytes: 2147483648, adaptation_apw_total: 0,
      apw_components: { ...new WorkLedger().counts }, cpu_ns: 123456, rss_bytes: 1234 },
    { kind: 'CPU_RSS_OBSERVATION_V1', ledger_index: 1, sample_index: 2, checkpoint: 600, arm: 'PERSIST', initial_only: false,
      phase: 'report', apw_cap: 100, cpu_cap_ns: 10000000, rss_limit_bytes: 2147483648, adaptation_apw_total: 0,
      apw_components: { ...new WorkLedger().counts }, cpu_ns: 123457, rss_bytes: 1234 },
  ][Symbol.iterator]() });
  const l = t.makeLedger({ cap: 100, cpuCapNs: 10000000 }, { checkpoint: 600, arm: 'PERSIST', initialOnly: false }); l.boundary(); l.report();
  assert.equal(t.finish().timing_authenticated, false);
});
test('default learner and injected ledger agree when clock does not stop the update', () => {
  const stream = new DevelopmentStream({ partition: 'DEV', scenario: plan.scenario, realisation: 0 });
  const key = keyFromAddress(`${stream.address}|optimiser=00`); const rows = stream.window(500);
  const a = new EvolutionLearner({ key, config, provenancePrefix: 'EQUAL' });
  const b = new EvolutionLearner({ key, config, provenancePrefix: 'EQUAL' });
  const t = new CpuClockTape({ mode: 'record', scope: 'FIXTURE', emit: () => {}, fixtureSampler: () => ({ cpu_ns: 0, rss_bytes: 1000 }) });
  const ra = a.initialise(rows, 500); const rb = b.initialise(rows, 500, { ledgerFactory: (o, c) => t.makeLedger(o, c) });
  assert.deepEqual(a.snapshot(), b.snapshot()); assert.deepEqual(ra.apw_components, rb.apw_components); t.finish();
});
test('a factory may not change an allowance or start with already debited work', () => {
  const stream = new DevelopmentStream({ partition: 'DEV', scenario: plan.scenario, realisation: 0 });
  const key = keyFromAddress(`${stream.address}|optimiser=00`);
  for (const f of [7, () => ({}), () => new WorkLedger({ cap: 1 }), opts => { const l = new WorkLedger(opts); l.charge('rng_variate'); return l; }]) {
    const l = new EvolutionLearner({ key, config }); assert.throws(() => l.initialise(stream.window(500), 500, { ledgerFactory: f }));
  }
});
test('invalid session ledger factory cannot be installed', () => assert.throws(() => PrequentialSession.fork(parent, { arm: 'PERSIST', cap: 100, ledgerFactory: 3 })));
test('budget exceptions retain their identity under observation', () => {
  const t = new CpuClockTape({ mode: 'record', scope: 'FIXTURE', emit: () => {}, fixtureSampler: () => ({ cpu_ns: 9, rss_bytes: 1000 }) });
  const l = t.makeLedger({ cap: 100, cpuCapNs: 8 }, { checkpoint: 600, arm: 'RESTART', initialOnly: false });
  assert.throws(() => l.boundary(), e => e instanceof BudgetExhausted && e.axis === 'CPU');
  const r = l.report(); assert.equal(r.cpu_overshoot_ns, 1); t.finish();
});
