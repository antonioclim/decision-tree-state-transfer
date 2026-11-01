import { createHash } from 'node:crypto';
import { EvolutionLearner } from '../../assets/code/confirmatory/learner.mjs';
import { PrequentialSession } from '../../assets/code/confirmatory/session.mjs';
import { forkF02State } from '../../assets/code/confirmatory/f02-state.mjs';
import { frozenInterventionsV4, materialPredictionV4 } from '../../assets/code/confirmatory/material-v4.mjs';
import { reachingRows } from '../../assets/code/confirmatory/material.mjs';
import { getSubtree, nodeCount, predict, treeDepth, treeHash } from '../../assets/code/confirmatory/trees.mjs';

const sha = (x) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

export class LineageRegistry {
  constructor() { this.depths = new Map(); }
  observe(population) {
    const pending = population.filter((p) => !this.depths.has(p.id));
    for (let pass = 0; pending.length && pass <= population.length + 2; pass += 1) {
      let progressed = false;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const p = pending[i];
        if (!Array.isArray(p.parents) || !p.parents.every((x) => typeof x === 'string')) throw new Error('invalid individual parent registry');
        if (p.parents.length === 0 || p.parents.every((id) => this.depths.has(id))) {
          this.depths.set(p.id, p.parents.length === 0 ? 0 : 1 + Math.max(...p.parents.map((id) => this.depths.get(id))));
          pending.splice(i, 1); progressed = true;
        }
      }
      if (!progressed && pending.length) break;
    }
    if (pending.length) throw new Error(`lineage registry cannot resolve ${pending.length} deployed individuals`);
  }
  depth(id) { if (!this.depths.has(id)) throw new Error('champion absent from lineage registry'); return this.depths.get(id); }
}

export class TrackedEvolutionLearner extends EvolutionLearner {
  constructor(options, registry) { super(options); this.lineageRegistry = registry; }
  commit(population, scores, nextOrdinal, checkpoint, factory) {
    super.commit(population, scores, nextOrdinal, checkpoint, factory);
    this.lineageRegistry.observe(this.population);
  }
}

function tokens(tree, out = new Set()) {
  out.add(tree._p.token);
  if (tree.type === 'split') { out.add(tree._p.left_edge.token); out.add(tree._p.right_edge.token); tokens(tree.left, out); tokens(tree.right, out); }
  return out;
}
function retentionFraction(before, after) {
  if (!before || !after || after.size === 0) return null;
  let retained = 0; for (const t of after) if (before.has(t)) retained += 1; return retained / after.size;
}
export function populationDiversity(population) {
  const n = population.length; if (n < 2) return 0;
  const counts = new Map(); for (const p of population) counts.set(treeHash(p.tree), (counts.get(treeHash(p.tree)) ?? 0) + 1);
  let same = 0; for (const k of counts.values()) same += k * (k - 1); return 1 - same / (n * (n - 1));
}

class Metrics {
  constructor(horizon) { this.horizon = horizon; this.errors = 0; this.n = [0, 0]; this.correct = [0, 0]; this.predictionNs = 0; this.predicateTests = 0; this.curve = []; this.horizons = {}; }
  add(offset, prediction, y, predictionNs = 0, predicateTests = 0) {
    const ok = prediction !== null && prediction === y; this.errors += Number(!ok); this.n[y] += 1; this.correct[y] += Number(ok);
    this.predictionNs += predictionNs; this.predicateTests += predicateTests;
    if (offset % 100 === 0) this.curve.push([offset, this.errors]);
    if ([500, 2000, 5000].includes(offset)) this.horizons[String(offset)] = this.snapshot(offset);
  }
  snapshot(offset = this.horizon) {
    const loss = this.errors / offset, deficient = this.n[0] === 0 || this.n[1] === 0;
    const balanced = deficient ? loss : 1 - 0.5 * (this.correct[0] / this.n[0] + this.correct[1] / this.n[1]);
    return { predictions: offset, loss_sum: this.errors, mean_loss: loss, balanced_error: balanced, class_deficient: deficient,
      class_0_n: this.n[0], class_1_n: this.n[1], class_0_error: this.n[0] ? 1 - this.correct[0] / this.n[0] : null,
      class_1_error: this.n[1] ? 1 - this.correct[1] / this.n[1] : null };
  }
  finish() { return { horizons: this.horizons, cumulative_errors_each_100: this.curve, prediction_ns_total: this.predictionNs, predicate_tests_total: this.predicateTests }; }
}

function reportSummary(reports) {
  const numeric = (key) => reports.reduce((s, r) => s + (Number.isFinite(r?.[key]) ? r[key] : 0), 0);
  const max = (key) => Math.max(0, ...reports.map((r) => Number.isFinite(r?.[key]) ? r[key] : 0));
  return { update_events: reports.length, adaptation_apw_total: numeric('adaptation_apw_total'), candidate_evaluations: numeric('candidate_evaluations'),
    node_example_visits: numeric('node_example_visits'), update_process_cpu_ns: numeric('process_cpu_ns'), update_elapsed_ns: numeric('elapsed_ns'),
    provenance_ns: numeric('provenance_ns'), max_reported_peak_rss_bytes: max('peak_rss_bytes'),
    mandatory_stage_failures: reports.filter((r) => r?.mandatory_stage_committed === false).length,
    terminal_failures: reports.filter((r) => r?.initialisation_failed === true).length };
}
function endState(session) {
  if (!session) return { state_available: false, population_size: 0, champion_nodes: null, champion_depth: null, population_diversity: null, snapshot_bytes: 0 };
  const l = session.learner, champion = l.champion?.tree ?? null;
  return { state_available: !l.failed && champion !== null, population_size: l.population.length, champion_nodes: champion ? nodeCount(champion) : null,
    champion_depth: champion ? treeDepth(champion) : null, population_diversity: l.population.length ? populationDiversity(l.population) : null,
    snapshot_bytes: Buffer.byteLength(JSON.stringify(l.snapshot())) };
}

function continueSession(session, tape, checkpoint, horizon, reports, initialStatus) {
  const metrics = new Metrics(horizon), cursor = tape.cursor(checkpoint + 1, checkpoint + horizon);
  let failureAfterOffset = session?.learner.failed ? 0 : null;
  for (let offset = 1; offset <= horizon; offset += 1) {
    const { index, x } = cursor.features();
    let prediction = null, predictionNs = 0, predicateTests = 0;
    if (session) { session.input({ index, x }); prediction = session.predict(); }
    const y = cursor.label(index);
    if (session) {
      const rec = session.reveal(y); predictionNs = rec.prediction_ns; predicateTests = rec.prediction_predicate_tests;
    }
    metrics.add(offset, prediction, y, predictionNs, predicateTests);
    if (session?.pendingUpdate) {
      const wasFailed = session.learner.failed; const report = session.adapt(); reports.push(report);
      if (!wasFailed && session.learner.failed && failureAfterOffset === null) failureAfterOffset = offset;
    }
  }
  cursor.finish();
  const status = session === null ? initialStatus : session.learner.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE';
  return { status, initial_status: initialStatus, failure_after_offset: failureAfterOffset, ...metrics.finish(), resources: reportSummary(reports), end_state: endState(session) };
}

export function runStateArm(snapshot, tape, checkpoint, horizon, arm, mediumCap, identity) {
  const wall = process.hrtime.bigint(), cpu0 = process.cpuUsage();
  const origin = `F10|stream=${identity.source_key_hex}|checkpoint=${checkpoint}`;
  const fork = forkF02State(snapshot, { arm, cap: mediumCap, budgetTag: origin,
    provenancePrefix: `F10:${identity.scenario_id}:${identity.realisation}:c${checkpoint}:${arm}`,
    attemptId: `F10-${identity.source_key_hex}-${checkpoint}-${arm}`, runId: identity.source_key_hex, integrityStatus: 'VERIFIED' });
  const reports = fork.report ? [fork.report] : [];
  const out = continueSession(fork.session, tape, checkpoint, horizon, reports, fork.status);
  const cpu = process.cpuUsage(cpu0);
  return { arm, treatment_applied: fork.treatment_applied, source_parent_available: fork.source_parent_available,
    transferred_champion_sha256: fork.transferred_champion_sha256 ?? null, ...out,
    process_cpu_ns_total: (cpu.user + cpu.system) * 1000, elapsed_ns_total: Number(process.hrtime.bigint() - wall) };
}

export function runRandomRestart(snapshot, tape, checkpoint, horizon, mediumCap, identity) {
  const wall = process.hrtime.bigint(), cpu0 = process.cpuUsage();
  const source = EvolutionLearner.restore(snapshot.learner);
  const fresh = new EvolutionLearner({ key: source.key, config: source.config, provenancePrefix: `F10:${identity.source_key_hex}:c${checkpoint}:RANDOM_RESTART` });
  const tag = `F10|stream=${identity.source_key_hex}|checkpoint=${checkpoint}|origin=RANDOM_RESTART`;
  const report = fresh.update(snapshot.window, { checkpoint, arm: 'RANDOM_RESTART', cap: mediumCap, budgetTag: tag, contextCheckpoint: checkpoint });
  const session = new PrequentialSession({ learner: fresh, window: snapshot.window, cap: mediumCap, budgetTag: tag, contextCheckpoint: checkpoint,
    arm: 'PERSIST', pendingUpdate: false, treatmentPending: false, protocolHash: snapshot.protocolHash,
    attemptId: `F10-${identity.source_key_hex}-${checkpoint}-RANDOM_RESTART`, runId: identity.source_key_hex });
  const out = continueSession(session, tape, checkpoint, horizon, [report], fresh.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE');
  const cpu = process.cpuUsage(cpu0);
  return { arm: 'RANDOM_RESTART', treatment_applied: true, secondary_only: true, ...out,
    process_cpu_ns_total: (cpu.user + cpu.system) * 1000, elapsed_ns_total: Number(process.hrtime.bigint() - wall) };
}

function mechanismPredictors(learner, window, site, lineage, lastRetention) {
  if (!site) return null;
  const rows = reachingRows(learner.champion.tree, site.path, window), subtree = getSubtree(learner.champion.tree, site.path);
  let errors = 0; const n = [0, 0], correct = [0, 0];
  for (const row of rows) { const p = predict(subtree, row.x); errors += Number(p !== row.y); n[row.y] += 1; correct[row.y] += Number(p === row.y); }
  const local = errors / rows.length, deficient = n[0] === 0 || n[1] === 0;
  const balanced = deficient ? local : 1 - 0.5 * (correct[0] / n[0] + correct[1] / n[1]);
  return { connected_subtree_age_completed_updates: site.age, node_count: site.nodes, subtree_depth: site.depth,
    recent_window_reach_rate: rows.length / window.length, past_only_local_error: local, past_only_balanced_error: balanced,
    class_deficiency_indicator: Number(deficient), lineage_depth: lineage.depth(learner.champion.id),
    global_champion_literal_retention_fraction: lastRetention, population_diversity: populationDiversity(learner.population) };
}

export function runMaterial(snapshot, learner, index, tape, checkpoint, horizon, identity, lineage, lastRetention) {
  const wall = process.hrtime.bigint(), cpu0 = process.cpuUsage();
  const material = frozenInterventionsV4(learner, snapshot.window, checkpoint, { provenanceIndex: index,
    prefix: `F10:${identity.scenario_id}:${identity.realisation}:c${checkpoint}:MATERIAL` });
  const predictors = material.eligible ? mechanismPredictors(learner, snapshot.window, material.site, lineage, lastRetention) : null;
  const metrics = { 'MATERIAL-REPLACE': new Metrics(horizon), 'STRUCTURAL-SHAM': new Metrics(horizon) };
  const cursor = tape.cursor(checkpoint + 1, checkpoint + horizon);
  for (let offset = 1; offset <= horizon; offset += 1) {
    const { index: i, x } = cursor.features();
    const timed = {};
    for (const arm of ['MATERIAL-REPLACE', 'STRUCTURAL-SHAM']) { const t0 = process.hrtime.bigint(); const prediction = materialPredictionV4(material, arm, x); timed[arm] = [prediction, Number(process.hrtime.bigint() - t0)]; }
    const y = cursor.label(i);
    for (const arm of ['MATERIAL-REPLACE', 'STRUCTURAL-SHAM']) metrics[arm].add(offset, timed[arm][0], y, timed[arm][1], 0);
  }
  cursor.finish(); const cpu = process.cpuUsage(cpu0);
  const arms = Object.fromEntries(Object.entries(metrics).map(([a, m]) => [a, m.finish()]));
  const contrasts = {}; for (const h of ['500', '2000', '5000']) if (arms['MATERIAL-REPLACE'].horizons[h]) contrasts[h] = arms['MATERIAL-REPLACE'].horizons[h].mean_loss - arms['STRUCTURAL-SHAM'].horizons[h].mean_loss;
  return { status: material.status, eligible: material.eligible, eligible_count: material.eligible_count, selected_site: material.site ?? null, mechanism_predictors: predictors,
    replacement_candidate_sha256: material.arms?.['MATERIAL-REPLACE']?.replacement_candidate_sha256 ?? null,
    replacement_candidate_apw_total: material.arms?.['MATERIAL-REPLACE']?.replacement_candidate_apw_total ?? null,
    arm_costs: material.arms ? Object.fromEntries(Object.entries(material.arms).map(([a, r]) => [a, r.cost])) : null,
    arm_tree_sha256: material.arms ? Object.fromEntries(Object.entries(material.arms).map(([a, r]) => [a, r.deployed_tree_sha256])) : null,
    contrasts, arms, process_cpu_ns_total: (cpu.user + cpu.system) * 1000, elapsed_ns_total: Number(process.hrtime.bigint() - wall) };
}

export function runPrimaryUnit({ tape, identity, protocolHash, mediumCap, ProvenanceIndex }) {
  if (!tape || !identity || !/^[a-f0-9]{64}$/.test(protocolHash) || !Number.isSafeInteger(mediumCap) || mediumCap < 1 || typeof ProvenanceIndex !== 'function') throw new Error('invalid F10 primary unit configuration');
  const started = process.hrtime.bigint(), cpu0 = process.cpuUsage(); const lineage = new LineageRegistry(), index = new ProvenanceIndex();
  const prefix = `F10-PARENT:${identity.scenario_id}:${identity.realisation}`;
  const learner = new TrackedEvolutionLearner({ key: identity.optimizer_key_hex, provenancePrefix: prefix, emit: (e) => index.append(e) }, lineage);
  const initialWindow = tape.revealedWindow(2000, 500), initial = learner.initialise(initialWindow, 2000);
  if (learner.failed || !initial.mandatory_stage_committed) throw new Error('common parent initialisation failed before confirmatory trajectory');
  index.prune(learner.snapshot());
  const session = new PrequentialSession({ learner, window: initialWindow, cap: mediumCap, budgetTag: `F10|PARENT|stream=${identity.source_key_hex}`,
    protocolHash, pendingUpdate: false, treatmentPending: false, arm: 'PERSIST', attemptId: `F10-PARENT-${identity.source_key_hex}`, runId: identity.source_key_hex });
  const parentCursor = tape.cursor(2001, 20000), checkpoints = []; let lastRetention = null; const parentReports = [initial];
  for (let t = 2001; t <= 20000; t += 1) {
    const { index: i, x } = parentCursor.features(); session.input({ index: i, x }); session.predict(); const y = parentCursor.label(i); session.reveal(y);
    if (t === 10000 || t === 20000) {
      const snapshot = session.snapshot(), verified = index.verifySnapshot(snapshot.learner), long = identity.comparator_included ? 5000 : 2000;
      const parentState = { snapshot_sha256: verified.snapshot_sha256, completed_updates: learner.completedUpdates,
        champion_nodes: learner.champion ? nodeCount(learner.champion.tree) : null, champion_depth: learner.champion ? treeDepth(learner.champion.tree) : null,
        population_diversity: learner.population.length ? populationDiversity(learner.population) : null,
        lineage_depth: learner.champion ? lineage.depth(learner.champion.id) : null, global_champion_literal_retention_fraction: lastRetention };
      const state = {};
      for (const arm of ['PERSIST', 'RESTART-CART', 'CHAMPION-RESEED']) state[arm] = runStateArm(snapshot, tape, t, long, arm, mediumCap, identity);
      const material = runMaterial(snapshot, learner, index, tape, t, long, identity, lineage, lastRetention);
      const randomRestart = identity.comparator_included ? runRandomRestart(snapshot, tape, t, 5000, mediumCap, identity) : null;
      checkpoints.push({ checkpoint: t, horizon_executed: long, parent_state: parentState, state, material, random_restart_S1: randomRestart });
    }
    if (session.pendingUpdate && t < 20000) {
      const beforeTokens = learner.champion ? tokens(learner.champion.tree) : null, beforeUpdates = learner.completedUpdates;
      const report = session.adapt(); parentReports.push(report);
      if (learner.completedUpdates > beforeUpdates) lastRetention = retentionFraction(beforeTokens, learner.champion ? tokens(learner.champion.tree) : null);
      index.prune(learner.snapshot());
    }
  }
  parentCursor.finish(); const provenance = index.finish(learner.snapshot()), cpu = process.cpuUsage(cpu0);
  return { schema_version: 1, phase: 'F10_CONFIRMATORY_CAMPAIGN', partition: identity.partition, protocol_id: 'DT-C8E1-F09-v1.0',
    scientific_interpretation_authorised: false, integrity_status: 'VALID_RAW_CONFIRMATORY_EVIDENCE', identity, source: tape.manifest,
    primary_medium_update_cap: mediumCap, parent: { initialisation_apw: initial.adaptation_apw_total, reports: reportSummary(parentReports), failed: learner.failed,
      provenance, final_population_diversity: learner.population.length ? populationDiversity(learner.population) : null }, checkpoints,
    execution: { node: process.version.slice(1), process_cpu_ns_total: (cpu.user + cpu.system) * 1000, elapsed_ns_total: Number(process.hrtime.bigint() - started), record_sha256_basis: 'JSON without record_sha256' } };
}

export function sealRecord(record) { const copy = structuredClone(record); delete copy.record_sha256; return { ...copy, record_sha256: sha(JSON.stringify(copy)) }; }
