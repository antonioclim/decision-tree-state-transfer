import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DevelopmentStream, SCENARIOS } from './generator.mjs';
import { DiagnosticBaseline } from './diagnostic-baselines.mjs';
import { semanticTree, nodeCount, treeDepth, floatBits } from './trees.mjs';
import { ChunkedEvidenceWriter, readChunkedEvents } from './chunked-evidence.mjs';
import { strictJson } from './evidence.mjs';

export const DIAGNOSTICS = ['FROZEN_CART', 'ROLLING_CART', 'LAST_LABEL', 'PREFIX_MAJORITY'];
const HASH = /^[a-f0-9]{64}$/;
export const digestJson = value => createHash('sha256').update(strictJson(value)).digest('hex');
const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateDiagnosticPlan(plan) {
  if (!plan || Object.keys(plan).sort().join(',') !== 'end,method,partition,protocol_sha256,realisation,scenario,schema_version'
    || plan.schema_version !== 1 || plan.partition !== 'DEV' || !DIAGNOSTICS.includes(plan.method)
    || !SCENARIOS.includes(plan.scenario) || !Number.isSafeInteger(plan.realisation) || plan.realisation < 0 || plan.realisation > 2
    || !Number.isSafeInteger(plan.end) || plan.end < 2001 || plan.end > 26000 || !HASH.test(plan.protocol_sha256)) {
    throw new Error('exact, bounded DEV diagnostic plan required; CONF and River methods are not accepted here');
  }
  strictJson(plan);
  return structuredClone(plan);
}

function deterministicWork(report) {
  // Clocks are not compared as deterministic data. Each training ledger retains its work components.
  const fields = ['apw_components', 'adaptation_apw_total', 'candidate_evaluations', 'node_example_visits', 'rejected_operators', 'class_deficient_scores'];
  const out = {};
  for (const field of fields) if (Object.hasOwn(report, field)) out[field] = structuredClone(report[field]);
  return out;
}

function snapshot(model) {
  if (model.tree && treeDepth(model.tree) > 8) throw new Error('diagnostic depth exceeds the unchanged protocol');
  return { index: model.lastIndex, last_label: model.lastLabel, counts: [...model.counts],
    tree: model.tree ? semanticTree(model.tree) : null, nodes: model.tree ? nodeCount(model.tree) : 0,
    depth: model.tree ? treeDepth(model.tree) : 0, training_calls: model.trainingCosts.length,
    retained_window_rows: model.window.length };
}

/** DEV-only test-then-reveal transcript. Yielding a prediction precedes requesting its label. */
export function* diagnosticEvents(input) {
  const plan = validateDiagnosticPlan(input);
  const source = new DevelopmentStream({ scenario: plan.scenario, realisation: plan.realisation });
  const prefix = source.window(2000, 2000);
  const model = new DiagnosticBaseline(plan.method, prefix);
  // Independent temporal references do not call the baseline's prediction/update routines.
  const referenceCounts = [prefix.filter(r => r.y === 0).length, prefix.filter(r => r.y === 1).length];
  let previousLabel = prefix[1999].y;
  const initialTree = model.tree ? digestJson(semanticTree(model.tree)) : null;
  yield { kind: 'start', plan, stream_key: source.key, prefix_sha256: digestJson(prefix), state: snapshot(model),
    training: model.trainingCosts.map(deterministicWork),
    scope: 'DIAGNOSTIC_DEV_REPLAY_NOT_CONFIRMATORY_OR_COMPUTE_MATCHED' };
  for (let index = 2001; index <= plan.end; index++) {
    const x = source.features(index);
    const prediction = model.predictInput({ index, x });
    if (prediction !== 0 && prediction !== 1) throw new Error('diagnostic returned a non-binary prediction');
    if (plan.method === 'LAST_LABEL' && prediction !== previousLabel) throw new Error('lag-one reference disagrees');
    if (plan.method === 'PREFIX_MAJORITY' && prediction !== Number(referenceCounts[1] > referenceCounts[0])) {
      throw new Error('past-only cumulative majority reference disagrees');
    }
    yield { kind: 'prediction', index, feature_sha256: digestJson(x.map(floatBits)), prediction };
    const y = source.label(index, x);
    yield { kind: 'reveal', index, label: y, loss: Number(prediction !== y) };
    const previousTraining = model.trainingCosts.length;
    model.reveal(y);
    previousLabel = y; referenceCounts[y]++;
    if (plan.method === 'FROZEN_CART' && digestJson(semanticTree(model.tree)) !== initialTree) throw new Error('frozen tree changed');
    const expectedCalls = plan.method === 'ROLLING_CART' ? 1 + Math.floor((index - 2000) / 100)
      : plan.method === 'FROZEN_CART' ? 1 : 0;
    if (model.trainingCosts.length !== expectedCalls) throw new Error('training schedule differs');
    if (model.trainingCosts.length !== previousTraining) yield { kind: 'training', index,
      work: deterministicWork(model.trainingCosts.at(-1)), state: snapshot(model) };
  }
  yield { kind: 'complete', prediction_slots: plan.end - 2000, state: snapshot(model),
    independent_temporal_reference_checked: ['LAST_LABEL', 'PREFIX_MAJORITY'].includes(plan.method),
    scientific_admission: false, confirmation_authorised: false };
}

function exactRoot(directory) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('real diagnostic directory required');
  if (fs.readdirSync(directory).sort().join(',') !== 'RESULT.json,events') throw new Error('unexpected diagnostic member');
}
function readResult(directory, externalDigest) {
  exactRoot(directory);
  if (!HASH.test(externalDigest ?? '')) throw new Error('external result digest required');
  const filename = path.join(directory, 'RESULT.json');
  const st = fs.lstatSync(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1024 * 1024) throw new Error('bounded unlinked result required');
  const bytes = fs.readFileSync(filename);
  if (fileHash(bytes) !== externalDigest) throw new Error('result anchor differs');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const result = JSON.parse(text);
  if (strictJson(result) + '\n' !== text || result.schema_version !== 1 || result.status !== 'COMPLETE_DEV_DIAGNOSTIC'
    || result.scientific_admission !== false || result.confirmation_authorised !== false) throw new Error('invalid diagnostic result');
  validateDiagnosticPlan(result.plan);
  return result;
}

export function recordDiagnostic(directory, input) {
  const plan = validateDiagnosticPlan(input);
  fs.mkdirSync(directory);
  const runId = `D10L-${plan.scenario}-r${plan.realisation}-${plan.method}-${plan.end}`;
  const metadata = { partition: 'DEV', run_id: runId, attempt_id: 'record-1', protocol_sha256: plan.protocol_sha256 };
  const writer = new ChunkedEvidenceWriter(path.join(directory, 'events'), metadata);
  const cpu = process.cpuUsage(); const started = process.hrtime.bigint(); let count = 0; let complete = null;
  for (const event of diagnosticEvents(plan)) { writer.append(event); count++; if (event.kind === 'complete') complete = event; }
  const trace = writer.finish();
  const used = process.cpuUsage(cpu);
  const result = { schema_version: 1, status: 'COMPLETE_DEV_DIAGNOSTIC', plan, run_id: runId, attempt_id: 'record-1',
    trace, deterministic_events: count, completion: complete,
    measurements: { process_cpu_ns: 1000 * (used.user + used.system), elapsed_ns: Number(process.hrtime.bigint() - started),
      process_high_water_rss_bytes: process.resourceUsage().maxRSS * 1024,
      scope: 'RUN_INCLUDES_GENERATION_LEARNING_RECORDING_AND_CLOSURE; NOT_PER_UPDATE_CAP_OR_INDEPENDENT_TIMING' },
    scientific_admission: false, confirmation_authorised: false };
  const bytes = Buffer.from(strictJson(result) + '\n');
  fs.writeFileSync(path.join(directory, 'RESULT.json'), bytes, { flag: 'wx' });
  return { result, sha256: fileHash(bytes) };
}

/** Recompute the declared baseline, do not merely trust a receipt or the transcript's own hashes. */
export function verifyDiagnostic(directory, expectedPlan, externalDigest) {
  const plan = validateDiagnosticPlan(expectedPlan);
  const result = readResult(directory, externalDigest);
  if (strictJson(plan) !== strictJson(result.plan)) throw new Error('diagnostic plan substitution');
  const expectedRunId = `D10L-${plan.scenario}-r${plan.realisation}-${plan.method}-${plan.end}`;
  if (result.run_id !== expectedRunId || result.attempt_id !== 'record-1') throw new Error('diagnostic identity differs');
  for (const name of ['process_cpu_ns', 'elapsed_ns', 'process_high_water_rss_bytes']) {
    if (!Number.isSafeInteger(result.measurements?.[name]) || result.measurements[name] < 0) throw new Error('invalid measured number');
  }
  const audit = {};
  const recorded = readChunkedEvents(path.join(directory, 'events'), audit,
    { expectedManifestSha256: result.trace?.manifest_sha256 });
  let count = 0; let completion = null; let training = 0;
  for (const event of diagnosticEvents(plan)) {
    const next = recorded.next();
    if (next.done || strictJson(next.value) !== strictJson(event)) throw new Error(`source-bound diagnostic mismatch at event ${count}`);
    if (event.kind === 'start') training += event.training.length;
    if (event.kind === 'training') training++;
    if (event.kind === 'complete') completion = event;
    count++;
  }
  if (!recorded.next().done || count !== result.deterministic_events || strictJson(completion) !== strictJson(result.completion)) {
    throw new Error('extra records or false completion summary');
  }
  const expectedMetadata = { partition: 'DEV', run_id: expectedRunId, attempt_id: 'record-1', protocol_sha256: plan.protocol_sha256 };
  if (strictJson(audit['metadata']) !== strictJson(expectedMetadata) || audit['status'] !== 'COMPLETE') throw new Error('trace identity or status differs');
  for (const [field, actual] of [['evidence_rows', audit['rows']], ['evidence_bytes', audit['bytes']],
    ['gzip_bytes', audit['gzip_bytes']], ['events_sha256', audit['sha256']]]) {
    if (result.trace[field] !== actual) throw new Error(`false trace total ${field}`);
  }
  // The surrounding campaign supplies the source hashes. This method proves same-source replay only.
  readResult(directory, externalDigest);
  return { status: 'PASS_DEV_DIAGNOSTIC_REPLAY', plan, result_sha256: externalDigest,
    prediction_slots: plan.end - 2000, training_calls: training, event_records: count,
    canonical_event_sha256: audit['sha256'], raw_event_bytes: audit['bytes'], gzip_event_bytes: audit['gzip_bytes'],
    independent_temporal_reference_checked: completion.independent_temporal_reference_checked,
    timing_authenticated: false, real_River_evaluation: false, scientific_admission: false, confirmation_authorised: false };
}
