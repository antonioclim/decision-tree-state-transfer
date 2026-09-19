import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DevelopmentStream } from './generator.mjs';
import { keyFromAddress } from './random.mjs';
import { EvolutionLearner } from './learner.mjs';
import { treeHash } from './trees.mjs';
import { hashObject } from './session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function devCases() {
  const lines = fs.readFileSync(path.join(root, 'working/phase9/SEED_SCHEDULE.tsv'), 'utf8').trim().split('\n');
  const header = lines.shift().split('\t');
  return lines.map((line) => Object.fromEntries(line.split('\t').map((v, i) => [header[i], v])))
    .filter((r) => r.partition === 'DEV').map((r) => ({ scenario: r.scenario_id, realisation: Number(r.realisation),
      optimiser: Number(r.optimiser_index), streamKey: r.stream_key_hex, key: r.optimiser_key_hex }));
}
export function sourceManifest() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return Object.fromEntries(fs.readdirSync(directory).filter((n) => n.endsWith('.mjs') || n.endsWith('.py')).sort()
    .map((n) => [n, createHash('sha256').update(fs.readFileSync(path.join(directory, n))).digest('hex')]));
}
/** Hash-only DEV diagnostic: not an archived provenance trace or scientific run admission. */
export function diagnosticTrace() {
  const hash = createHash('sha256'); let bytes = 0; let rows = 0; const kinds = {};
  return {
    emit(event) { const line = `${JSON.stringify(event)}\n`; bytes += Buffer.byteLength(line); rows++; kinds[event.kind] = (kinds[event.kind] ?? 0) + 1; hash.update(line); },
    summary() { return { rows, serialised_bytes: bytes, event_kinds: kinds, sha256: hash.digest('hex'),
      mode: 'HASH_ONLY_DEV_DIAGNOSTIC_NOT_RETAINED_TRACE' }; },
  };
}
function optimiserCheck(c) {
  const expected = keyFromAddress(`DT-P9-v1|DEV|${c.scenario}|r=${String(c.realisation).padStart(2, '0')}|optimiser=${String(c.optimiser).padStart(2, '0')}`);
  if (expected !== c.key) throw new Error('DEV optimiser key mismatch');
}
export function coldCase(c, checkpoint, { emit = null, prefix = 'calibration' } = {}) {
  optimiserCheck(c);
  const stream = new DevelopmentStream({ scenario: c.scenario, realisation: c.realisation, streamKey: c.streamKey });
  const window = stream.window(checkpoint);
  const learner = new EvolutionLearner({ key: c.key, provenancePrefix: `${prefix}:${c.scenario}:${c.realisation}:${c.optimiser}:${checkpoint}`, emit });
  const report = learner.initialise(window, checkpoint);
  if (learner.failed || !report.mandatory_stage_committed || report.population_size !== 150 || report.candidate_evaluations !== 150) throw new Error('incomplete cold calibration');
  return { report, window_sha256: hashObject(window), population_semantics_sha256: hashObject(learner.population.map((p) => treeHash(p.tree))) };
}
function run(directory) {
  fs.mkdirSync(directory); const source = sourceManifest(); const cases = devCases();
  if (cases.length !== 84) throw new Error('expected all 84 DEV keys');
  const started = new Date().toISOString(); const warmup = [];
  for (let i = 0; i < 3; i++) { const trace = diagnosticTrace(); const r = coldCase(cases[0], 10000, { emit: trace.emit, prefix: `warmup${i}` }); warmup.push({ ...r, trace: trace.summary() }); }
  fs.writeFileSync(path.join(directory, 'warmup.json'), `${JSON.stringify(warmup, null, 2)}\n`, { flag: 'wx' });
  const fd = fs.openSync(path.join(directory, 'cases.jsonl'), 'wx'); const results = [];
  try {
    for (const c of cases) for (const checkpoint of [10000, 20000]) {
      const trace = diagnosticTrace(); const result = { partition: 'DEV', ...c, checkpoint,
        ...coldCase(c, checkpoint, { emit: trace.emit }), trace: trace.summary() };
      fs.writeSync(fd, `${JSON.stringify(result)}\n`); results.push(result);
      if (results.length % 14 === 0) console.log(`complete cold cases ${results.length}/168`);
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const maxWork = Math.max(...results.map((r) => r.report.adaptation_apw_total));
  const maxCpu = Math.max(...results.map((r) => r.report.process_cpu_ns));
  const maximum = results.filter((r) => r.report.adaptation_apw_total === maxWork).map((r) => ({ scenario: r.scenario, realisation: r.realisation, optimiser: r.optimiser, checkpoint: r.checkpoint }));
  const out = { schema_version: 1, status: 'COLD_APW_CALIBRATION_COMPLETE_EXECUTION_STILL_BLOCKED', partition: 'DEV',
    started_at_utc: started, completed_at_utc: new Date().toISOString(), source_sha256: source,
    seed_schedule_sha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'working/phase9/SEED_SCHEDULE.tsv'))).digest('hex'),
    cases: results.length, maximum_complete_cold_APW: maxWork, maximum_cases: maximum, B0: 2 * maxWork,
    formula: 'ceil(2 * max of every complete cold initialisation over all 84 DEV keys and both windows)',
    maximum_measured_cpu_ns: maxCpu, diagnostic_cpu_cap_ns: 2 * maxCpu,
    cpu_lock_ready: false, cpu_limit_reason: 'Hash-only DEV serialisation does not establish the final archived-evidence I/O mode; this is not an authorised CPU lock.',
    warmup: 'Three complete repeats of DEV key 0 at checkpoint 10000; excluded from the maximum.',
    full_trace_retained: false, total_diagnostic_serialised_trace_bytes: results.reduce((s, r) => s + r.trace.serialised_bytes, 0),
    cases_sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, 'cases.jsonl'))).digest('hex'),
    parent_and_arm_feasibility: 'SEPARATE_PENDING_GATE', confirmation_values_generated: false };
  fs.writeFileSync(path.join(directory, 'calibration.json'), `${JSON.stringify(out, null, 2)}\n`, { flag: 'wx' }); console.log(JSON.stringify(out, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: node calibrate-dev.mjs NEW_OUTPUT_DIRECTORY');
  run(path.resolve(process.argv[2]));
}
