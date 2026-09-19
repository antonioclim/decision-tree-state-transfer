import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DevelopmentStream } from './generator.mjs';
import { EvolutionLearner } from './learner.mjs';
import { PrequentialSession, hashObject } from './session.mjs';
import { frozenShadows } from './material.mjs';
import { treeHash } from './trees.mjs';
import { devCases, sourceManifest } from './calibrate-dev.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function assessParent(c, b0, protocolHash) {
  const start = process.hrtime.bigint(); const cpuStart = process.cpuUsage();
  const stream = new DevelopmentStream({ scenario: c.scenario, realisation: c.realisation, streamKey: c.streamKey });
  const learner = new EvolutionLearner({ key: c.key, provenancePrefix: `DEV:${c.scenario}:${c.realisation}:${c.optimiser}` });
  const window = stream.window(2000); const initial = learner.initialise(window);
  const session = new PrequentialSession({ learner, window, cap: 2 * b0, protocolHash });
  const updates = []; const checkpoints = []; let inputRows = 0;
  for (let t = 2001; t <= 20000; t++) {
    const x = stream.features(t); session.input({ index: t, x }); session.predict(); session.reveal(stream.label(t, x)); inputRows++;
    if (t === 10000 || t === 20000) {
      const snapshot = session.snapshot(); const before = hashObject(snapshot); const forks = [];
      for (const multiplier of [1, 2, 4]) for (const arm of ['PERSIST', 'RESTART', 'CHAMPION']) {
        const f = PrequentialSession.fork(snapshot, { arm, cap: multiplier * b0, budgetTag: String(multiplier),
          provenancePrefix: `DEV-FORK:${c.scenario}:${c.realisation}:${c.optimiser}:${t}:${multiplier}:${arm}` });
        const report = f.adapt();
        forks.push({ arm, multiplier, parent_snapshot_sha256: before, window_sha256: hashObject(f.window),
          treatment_count: f.treatmentCount, report, mandatory_feasible: 'mandatory_stage_committed' in report && report.mandatory_stage_committed === true && !f.learner.failed });
      }
      const material = frozenShadows(learner, session.window, t);
      const shamExact = material.parent_unavailable || treeHash(material.sham) === treeHash(learner.champion.tree);
      if (!shamExact || hashObject(snapshot) !== before || hashObject(session.snapshot()) !== before) throw new Error('fork/shadow mutated its common parent');
      checkpoints.push({ checkpoint: t, parent_snapshot_sha256: before, snapshot_bytes: Buffer.byteLength(JSON.stringify(snapshot)),
        common_window_sha256: hashObject(session.window), forks,
        material: { eligible_count: material.eligible_count, selected: material.selected, replacement_nodes: material.replacement_nodes,
          sham_exact: shamExact, parent_unavailable: material.parent_unavailable, cost: material.cost } });
    }
    if (session.pendingUpdate) updates.push(session.adapt());
  }
  const cpu = process.cpuUsage(cpuStart);
  return { partition: 'DEV', ...c, common_initialisation: initial, input_rows: inputRows, parent_updates: updates.length,
    parent_failed: learner.failed, checkpoints,
    parent_update_work: updates.reduce((s, r) => s + ('adaptation_apw_total' in r ? r.adaptation_apw_total : 0), 0),
    parent_provenance_event_count: updates.reduce((s, r) => s + ('provenance_records' in r ? r.provenance_records : 0), 0),
    mandatory_parent_update_failures: updates.filter((r) => !('mandatory_stage_committed' in r && r.mandatory_stage_committed)).length,
    all_fork_mandatory_stages_feasible: checkpoints.every((p) => p.forks.every((f) => f.mandatory_feasible)),
    elapsed_ns: Number(process.hrtime.bigint() - start), process_cpu_ns: (cpu.user + cpu.system) * 1000,
    process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    tracing_mode: 'LIVE_LITERAL_METADATA_NO_EVENT_SERIALISATION_DEV_ONLY',
    archived_parent_trace: false, confirmation_values_generated: false,
    status: learner.failed || checkpoints.some((p) => p.forks.some((f) => !f.mandatory_feasible)) ? 'FEASIBILITY_FAIL' : 'APW_FEASIBILITY_PASS' };
}
function run(calibrationFile, directory, worker, workers) {
  if (!Number.isSafeInteger(worker) || !Number.isSafeInteger(workers) || worker < 0 || worker >= workers || workers < 1) throw new Error('invalid worker partition');
  const cal = JSON.parse(fs.readFileSync(calibrationFile, 'utf8'));
  if (cal.cases !== 168 || cal.B0 !== 2 * cal.maximum_complete_cold_APW || cal.partition !== 'DEV') throw new Error('incomplete cold calibration');
  fs.mkdirSync(directory); const sources = sourceManifest(); const protocol = fs.readFileSync(path.join(root, 'working/phase9/PROTOCOL_SPEC.json'));
  const protocolHash = hashBytes(protocol); const assigned = devCases().filter((_, i) => i % workers === worker);
  fs.writeFileSync(path.join(directory, 'started.json'), `${JSON.stringify({ sources, worker, workers, B0: cal.B0,
    partition: 'DEV', status: 'RUNNING', started_at_utc: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
  const fd = fs.openSync(path.join(directory, 'parents.jsonl'), 'wx'); let complete = 0;
  try {
    for (const c of assigned) {
      const result = assessParent(c, cal.B0, protocolHash); fs.writeSync(fd, `${JSON.stringify(result)}\n`); fs.fsyncSync(fd);
      console.log(`${++complete}/${assigned.length} ${c.scenario} ${c.realisation}:${c.optimiser} ${result.status}`);
    }
  } finally { fs.closeSync(fd); }
  fs.writeFileSync(path.join(directory, 'finished.json'), `${JSON.stringify({ worker, workers, complete, status: 'COMPLETE',
    completed_at_utc: new Date().toISOString(), parents_sha256: hashBytes(fs.readFileSync(path.join(directory, 'parents.jsonl'))) }, null, 2)}\n`, { flag: 'wx' });
}
function hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) throw new Error('usage: node dev-feasibility.mjs CALIBRATION.json NEW_OUTPUT_DIRECTORY WORKER WORKERS');
  run(path.resolve(process.argv[2]), path.resolve(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]));
}
