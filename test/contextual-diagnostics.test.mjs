import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { diagnosticEvents, recordDiagnostic, verifyDiagnostic, validateDiagnosticPlan, DIAGNOSTICS } from '../assets/code/confirmatory/contextual-diagnostics.mjs';
import { exportContextualSource, verifyContextualSource } from '../assets/code/confirmatory/contextual-source.mjs';
import { ChunkedEvidenceWriter, readChunkedEvents } from '../assets/code/confirmatory/chunked-evidence.mjs';
import { DevelopmentStream } from '../assets/code/confirmatory/generator.mjs';
import { strictJson } from '../assets/code/confirmatory/evidence.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const protocolHash = sha(fs.readFileSync(new URL('../working/phase9/PROTOCOL_SPEC.json', import.meta.url)));
const plan = method => ({ schema_version: 1, partition: 'DEV', method, scenario: 'LOCAL_TREE-STATIONARY-NONE', realisation: 0, end: 2010, protocol_sha256: protocolHash });
function temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'contextual-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
function alter(directory, receipt, mutate) {
  const audit = {}; const events = [...readChunkedEvents(path.join(directory, 'events'), audit, { expectedManifestSha256: receipt.result.trace.manifest_sha256 })];
  mutate(events);
  fs.rmSync(path.join(directory, 'events'), { recursive: true });
  const writer = new ChunkedEvidenceWriter(path.join(directory, 'events'), audit.metadata);
  for (const e of events) writer.append(e);
  receipt.result.trace = writer.finish(); receipt.result.deterministic_events = events.length;
  const complete = events.find(e => e.kind === 'complete'); if (complete) receipt.result.completion = complete;
  const bytes = Buffer.from(strictJson(receipt.result)+'\n'); fs.writeFileSync(path.join(directory, 'RESULT.json'), bytes);
  receipt.sha256 = sha(bytes);
}
for (const method of DIAGNOSTICS) test(`real diagnostic ${method} records and replays its complete short DEV horizon`, t => {
  const root = temp(t); const p = plan(method); const receipt = recordDiagnostic(path.join(root, 'run'), p);
  const v = verifyDiagnostic(path.join(root, 'run'), p, receipt.sha256);
  assert.equal(v.prediction_slots, 10); assert.equal(v.confirmation_authorised, false);
  assert.equal(v.training_calls, method.endsWith('CART') ? 1 : 0);
  assert.equal(v.independent_temporal_reference_checked, !method.endsWith('CART'));
});
test('rolling CART uses exactly the declared 100-label cadence', () => {
  const p = { ...plan('ROLLING_CART'), end: 2200 }; const events = [...diagnosticEvents(p)];
  assert.deepEqual(events.filter(e => e.kind === 'training').map(e => e.index), [2100, 2200]);
  for (const e of events.filter(e => e.kind === 'training')) {
    assert.equal(e.state.retained_window_rows, 500);
    assert.equal(Object.values(e.work.apw_components).reduce((a,b)=>a+b,0), e.work.adaptation_apw_total);
  }
});
test('future labels are requested only after the prediction event is yielded', () => {
  const original = DevelopmentStream.prototype.label; const calls = [];
  DevelopmentStream.prototype.label = function(t, x) { calls.push(t); return original.call(this, t, x); };
  try {
    const g = diagnosticEvents(plan('LAST_LABEL')); g.next(); assert.equal(calls.at(-1), 2000);
    const e = g.next().value; assert.equal(e.kind, 'prediction'); assert.equal(calls.at(-1), 2000);
    assert.equal(g.next().value.kind, 'reveal'); assert.equal(calls.at(-1), 2001);
  } finally { DevelopmentStream.prototype.label = original; }
});
for (const [name, change] of [
  ['CONF', p => { p.partition = 'CONF'; }], ['unknown method', p => { p.method = 'HAT'; }],
  ['bad scenario', p => { p.scenario = 'X'; }], ['extra field', p => { p.seed = 0; }],
  ['bad end', p => { p.end = 26001; }], ['boolean index', p => { p.end = true; }],
  ['invalid realisation', p => { p.realisation = 3; }], ['invalid protocol', p => { p.protocol_sha256 = ''; }],
]) test(`plan rejects ${name}`, () => { const p = plan('LAST_LABEL'); change(p); assert.throws(() => validateDiagnosticPlan(p)); });
for (const [name, mutate] of [
  ['label', es => { es.find(e => e.kind === 'reveal').label ^= 1; }],
  ['prediction', es => { es.find(e => e.kind === 'prediction').prediction ^= 1; }],
  ['loss', es => { es.find(e => e.kind === 'reveal').loss ^= 1; }],
  ['feature hash', es => { es.find(e => e.kind === 'prediction').feature_sha256 = 'b'.repeat(64); }],
  ['prefix hash', es => { es[0].prefix_sha256 = 'b'.repeat(64); }],
  ['work', es => { es[0].training.push({ fake: 1 }); }],
  ['missing event', es => { es.splice(2, 1); }],
  ['extra event', es => { es.push({ kind: 'surplus' }); }],
  ['completion', es => { es.at(-1).prediction_slots++; }],
]) test(`rehashed ${name} corruption is rejected by source replay`, t => {
  const dir = path.join(temp(t), 'run'); const p = plan('LAST_LABEL'); const r = recordDiagnostic(dir, p);
  alter(dir, r, mutate); assert.throws(() => verifyDiagnostic(dir, p, r.sha256));
});
test('external anchor, plan substitution and additional root files are rejected', t => {
  const dir = path.join(temp(t), 'run'); const p = plan('LAST_LABEL'); const r = recordDiagnostic(dir, p);
  assert.throws(() => verifyDiagnostic(dir, p, 'f'.repeat(64)));
  assert.throws(() => verifyDiagnostic(dir, { ...p, end: 2009 }, r.sha256));
  fs.writeFileSync(path.join(dir, 'extra'), 'x'); assert.throws(() => verifyDiagnostic(dir, p, r.sha256));
});
test('repeating into the same output cannot replace its original result', t => {
  const dir = path.join(temp(t), 'run'); const p = plan('LAST_LABEL'); const r = recordDiagnostic(dir, p);
  const before = fs.readFileSync(path.join(dir, 'RESULT.json'));
  assert.throws(() => recordDiagnostic(dir, p)); assert.deepEqual(fs.readFileSync(path.join(dir, 'RESULT.json')), before);
  assert.equal(verifyDiagnostic(dir, p, r.sha256).status, 'PASS_DEV_DIAGNOSTIC_REPLAY');
});
test('plausible timing changes are not presented as clock authentication', t => {
  const dir = path.join(temp(t), 'run'); const p = plan('LAST_LABEL'); const r = recordDiagnostic(dir, p);
  r.result.measurements.process_cpu_ns = 1; const bytes = Buffer.from(strictJson(r.result)+'\n'); fs.writeFileSync(path.join(dir, 'RESULT.json'), bytes);
  assert.equal(verifyDiagnostic(dir, p, sha(bytes)).timing_authenticated, false);
});
test('split binary64 source is regenerated exactly from DEV', t => {
  const { method, ...p } = plan('LAST_LABEL'); const dir = path.join(temp(t), 'source'); const r = exportContextualSource(dir, p);
  assert.equal(verifyContextualSource(dir, p, r.sha256).rows, 2010);
  assert.equal(r.manifest.files.length, 2); assert.throws(() => exportContextualSource(dir, p));
});
test('a rehashed label tape is not the declared generator output', t => {
  const { method, ...p } = plan('LAST_LABEL'); const dir = path.join(temp(t), 'source'); const r = exportContextualSource(dir, p);
  const d = r.manifest.files[1]; const raw = gunzipSync(fs.readFileSync(path.join(dir, d.file)));
  const rows = raw.toString().trimEnd().split('\n').map(JSON.parse); rows[2000].label ^= 1;
  const altered = Buffer.from(rows.map(strictJson).join('\n')+'\n'); const zipped = gzipSync(altered);
  fs.writeFileSync(path.join(dir, d.file), zipped); Object.assign(d, { raw_bytes: altered.length, raw_sha256: sha(altered), gzip_bytes: zipped.length, gzip_sha256: sha(zipped) });
  const manifest = Buffer.from(strictJson(r.manifest)+'\n'); fs.writeFileSync(path.join(dir, 'SOURCE.json'), manifest);
  assert.throws(() => verifyContextualSource(dir, p, sha(manifest)), /generator/);
});
test('source export refuses CONF and source verification rejects links', t => {
  const { method, ...p } = plan('LAST_LABEL'); const root = temp(t); const dir = path.join(root, 'source');
  assert.throws(() => exportContextualSource(dir, { ...p, partition: 'CONF' }));
  const r = exportContextualSource(dir, p); const f = path.join(dir, 'features.jsonl.gz'); fs.renameSync(f, path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), f); assert.throws(() => verifyContextualSource(dir, p, r.sha256));
});
