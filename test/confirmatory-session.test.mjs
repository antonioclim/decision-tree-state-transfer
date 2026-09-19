import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionLearner, makeConfig, scorePopulation } from '../assets/code/confirmatory/learner.mjs';
import { PrequentialSession, hashObject } from '../assets/code/confirmatory/session.mjs';
import { WorkLedger } from '../assets/code/confirmatory/work.mjs';
import { TreeFactory, treeHash, semanticTree } from '../assets/code/confirmatory/trees.mjs';
import { AttemptWriter, inspectAttempt, validateChronology, validateProvenance } from '../assets/code/confirmatory/evidence.mjs';
const key = '0123456789abcdef'; const protocolHash = 'a'.repeat(64);
const config = { populationSize: 8, cartDescendants: 3, elitism: 1, featureCount: 2, maxInitialDepth: 2,
  maxTreeDepth: 3, cartMaxDepth: 3, cartMinLeaf: 2, tournamentSize: 3, thresholdsPerFeature: 5 };
const rows = (end = 2000, n = 40) => Array.from({ length: n }, (_, i) => ({ index: end - n + i + 1, x: [(i % 11) / 11, (i % 7) / 7], y: Number(i % 11 > 5) }));
const make = (extra = {}) => new EvolutionLearner({ key, config, ...extra });
const semantics = (l) => ({ trees: l.population.map((p) => semanticTree(p.tree)), champion: treeHash(l.champion.tree), nextOrdinal: l.nextOrdinal });
function ready(extra = {}) { const l = make(extra); l.initialise(rows()); return l; }
function session(l = ready(), extra = {}) { return new PrequentialSession({ learner: l, window: rows(), cap: 30000, protocolHash, ...extra }); }
function step(s, i, label = Number(i % 2), feature = [0.2, 0.8]) { s.input({ index: i, x: feature }); s.predict(); return s.reveal(label); }

test('invalid configurations, windows and missing explicit adaptive allowances fail closed', () => {
  for (const c of [{ missing: 1 }, { featureCount: 0 }, { cartDescendants: 150 }, { replacementFraction: 0 }, { elitism: 150 }, { mutationRate: NaN }]) assert.throws(() => makeConfig(c));
  const l = make(); assert.throws(() => l.initialise([])); assert.throws(() => l.initialise(rows().reverse()));
  l.initialise(rows()); assert.throws(() => l.initialise(rows())); assert.throws(() => l.update(rows(), { checkpoint: 2000 }));
  assert.throws(() => session(l, { window: rows().reverse() })); assert.throws(() => session(l, { cap: -1 }));
});
test('full cold population admission requires exactly complete scores', () => {
  const reference = make(); const full = reference.initialise(rows()); const cost = full.adaptation_apw_total;
  const exact = make(); const yes = exact.initialise(rows(), 2000, { cap: cost });
  assert.equal(yes.candidate_evaluations, 8); assert.deepEqual(semantics(exact), semantics(reference));
  const short = make(); const no = short.initialise(rows(), 2000, { cap: cost - 1 });
  assert.equal(no.mandatory_stage_committed, false); assert.equal(short.failed, true); assert.equal(short.predict([0.1, 0.1]), null);
  assert.equal(short.population.length, 0); assert.throws(() => short.update(rows(), { checkpoint: 2000, cap: cost }));
});
test('zero allowance retains a non-cold deployed champion and never selects a partial score', () => {
  const l = ready(); const before = semantics(l); const oldIndex = l.scoredThrough; const n = l.completedUpdates;
  const report = l.update(rows(2100), { checkpoint: 2100, cap: 0 });
  assert.deepEqual(semantics(l), before); assert.equal(l.scoredThrough, oldIndex); assert.equal(l.completedUpdates, n);
  assert.equal(report.mandatory_stage_committed, false); assert.equal(report.partial_scratch_discarded, true);
  assert.equal(report.adaptation_apw_total, 0); assert.equal(l.failed, false);
});
test('complete evolutionary rounds account for pre- and post-scores plus discarded work', () => {
  const l = ready(); const r = l.update(rows(2100), { checkpoint: 2100, cap: 30000 });
  assert.ok(r.completed_rounds > 0); assert.ok(r.candidate_evaluations >= 8 * (1 + 2 * r.completed_rounds));
  assert.ok(r.adaptation_apw_total <= 30000); assert.equal(r.population_size, 8);
  assert.equal(r.adaptation_apw_total + r.unspent_APW, 30000); assert.equal(l.scoredThrough, 2100);
});
test('single-class training fallback is explicit and penalised consistently', () => {
  const ledger = new WorkLedger(); const f = new TreeFactory({ ledger }); const population = [0, 1].map((a) => ({ tree: f.leaf(a), ordinal: a }));
  const scored = scorePopulation(population, rows().map((r) => ({ ...r, y: 1 })), makeConfig(config), ledger);
  assert.equal(scored[0].individual.ordinal, 1); assert.equal(scored[0].fitness, 1 - makeConfig(config).complexityPenalty);
  assert.equal(ledger.classDeficientScores, 2); assert.equal(ledger.candidateEvaluations, 2);
});
test('JSON checkpoint replay preserves subsequent predictions, operators and work', () => {
  const a = ready(); const b = EvolutionLearner.restore(JSON.parse(JSON.stringify(a.snapshot())), { provenancePrefix: 'replay' });
  const ra = a.update(rows(2100), { checkpoint: 2100, cap: 30000 }); const rb = b.update(rows(2100), { checkpoint: 2100, cap: 30000 });
  assert.deepEqual(semantics(a), semantics(b)); assert.deepEqual(ra.apw_components, rb.apw_components);
});
test('arbitrary provenance prefixes are inert to selection, predictions and work', () => {
  const a = ready({ provenancePrefix: '000-renamed' }); const b = ready({ provenancePrefix: 'zzz-independent' });
  assert.notEqual(a.champion.id, b.champion.id); assert.deepEqual(semantics(a), semantics(b));
  for (const c of [2100, 2200]) { const x = a.update(rows(c), { checkpoint: c, cap: 30000 }); const y = b.update(rows(c), { checkpoint: c, cap: 30000 });
    assert.deepEqual(x.apw_components, y.apw_components); assert.deepEqual(semantics(a), semantics(b)); }
});
test('snapshot corruption and impossible populations cannot be restored', () => {
  const source = ready().snapshot();
  const cases = [(s) => { s.nextOrdinal = -1; }, (s) => { s.completedUpdates = '5'; }, (s) => { s.population.pop(); },
    (s) => { s.population[0].ordinal = s.population[1].ordinal; }, (s) => { s.failed = true; },
    (s) => { s.championOrdinal = 999; }, (s) => { s.population[0].tree._p.witness = null; }];
  for (const corrupt of cases) { const s = structuredClone(source); corrupt(s); assert.throws(() => EvolutionLearner.restore(s)); }
});
test('predict-before-reveal interface blocks labels and future rows, copying caller features', () => {
  const s = session(); assert.throws(() => s.reveal(0)); assert.throws(() => s.predict());
  assert.throws(() => s.input({ index: 2001, x: [0, 0], y: 1 })); assert.throws(() => s.input({ index: 2002, x: [0, 0] }));
  const x = [0.2, 0.8]; const expected = s.learner.predict(x); s.input({ index: 2001, x }); x[0] = 0.99;
  assert.throws(() => s.reveal(1)); assert.throws(() => s.snapshot()); assert.equal(s.predict(), expected);
  assert.throws(() => s.predict()); s.reveal(0); assert.deepEqual(s.window.at(-1).x, [0.2, 0.8]); assert.throws(() => s.reveal(0));
});
test('different future feature/label suffixes cannot change a prefix checkpoint', () => {
  const a = session(); const b = session(); for (let i = 2001; i <= 2050; i++) { assert.deepEqual(step(a, i).prediction, step(b, i).prediction); }
  assert.equal(hashObject(a.snapshot()), hashObject(b.snapshot()));
  const prefix = hashObject(a.snapshot()); step(a, 2051, 0, [0, 0]); step(b, 2051, 1, [1, 1]);
  assert.notEqual(hashObject(a.snapshot()), hashObject(b.snapshot())); assert.notEqual(prefix, hashObject(a.snapshot()));
});
test('all forks use the same pre-treatment snapshot and apply treatment exactly once', () => {
  const parent = session(ready(), { pendingUpdate: true }); const snap = parent.snapshot(); const hash = hashObject(snap);
  for (const arm of ['PERSIST', 'RESTART', 'CHAMPION']) {
    const f = PrequentialSession.fork(snap, { arm, cap: 30000 }); assert.equal(hashObject(f.window), hashObject(parent.window));
    assert.equal(hashObject(f.learner.snapshot()), hashObject(parent.learner.snapshot()));
    assert.throws(() => f.input({ index: 2001, x: [0, 0] })); assert.equal(f.adapt().arm, arm); assert.equal(f.treatmentCount, 1);
    for (let i = 2001; i <= 2100; i++) step(f, i); assert.equal(f.adapt().arm, 'PERSIST'); assert.equal(f.treatmentCount, 1);
  }
  assert.equal(hashObject(snap), hash); assert.throws(() => PrequentialSession.fork({ ...snap, pendingUpdate: false }, { arm: 'PERSIST', cap: 1 }));
});
test('cold interventions cannot borrow a champion after first-treatment exhaustion', () => {
  const snap = session(ready(), { pendingUpdate: true }).snapshot();
  for (const arm of ['RESTART', 'CHAMPION']) {
    const f = PrequentialSession.fork(snap, { arm, cap: 0 }); f.adapt(); assert.equal(f.learner.failed, true);
    const r = step(f, 2001, 0); assert.equal(r.loss, 1); assert.equal(r.imputed_failure, true);
  }
  const p = PrequentialSession.fork(snap, { arm: 'PERSIST', cap: 0 }); p.adapt(); assert.equal(p.learner.failed, false);
});
test('unavailable parent gives every paired arm a full loss-one denominator', () => {
  const failed = make(); failed.initialise(rows(), 2000, { cap: 0 });
  const snap = session(failed, { pendingUpdate: true }).snapshot();
  for (const arm of ['PERSIST', 'RESTART', 'CHAMPION']) {
    const f = PrequentialSession.fork(snap, { arm, cap: 30000 }); assert.equal(f.adapt().parent_unavailable, true);
    assert.equal(step(f, 2001, 1).loss, 1); assert.equal(f.learner.population.length, 0);
  }
});
test('secondary intervention paths are executable without altering original parent', () => {
  const snap = session(ready(), { pendingUpdate: true }).snapshot(); const sourceHash = hashObject(snap);
  for (const arm of ['NO_CROSSOVER', 'NO_MUTATION', 'RANDOM_RESTART', 'TEMPLATE_REFIT']) {
    const f = PrequentialSession.fork(snap, { arm, cap: 30000 }); const r = f.adapt();
    assert.equal(r.population_size, 8); assert.ok(r.adaptation_apw_total <= 30000); assert.ok([0, 1].includes(step(f, 2001).prediction));
  }
  assert.equal(hashObject(snap), sourceHash);
});
test('retention and champion-only initialisation have literal source links; restart does not', () => {
  const events = []; const l = ready({ emit: (e) => events.push(structuredClone(e)) }); const original = l.snapshot();
  const oldTokens = new Set(events.filter((e) => e.kind === 'node').map((e) => e.token));
  for (const arm of ['CHAMPION', 'RESTART']) {
    const childEvents = []; const copy = EvolutionLearner.restore(original, { provenancePrefix: arm, emit: (e) => childEvents.push(structuredClone(e)) });
    copy.update(rows(), { checkpoint: 2000, arm, cap: 30000, initialOnly: true });
    assert.ok(validateProvenance([...events, ...childEvents]));
    const overlap = childEvents.filter((e) => e.kind === 'node' && oldTokens.has(e.token));
    assert.equal(overlap.length > 0, arm === 'CHAMPION');
    if (arm === 'CHAMPION') assert.equal(treeHash(copy.population[0].tree), treeHash(l.champion.tree));
  }
});
test('bounded rolling buffer and scheduled update reject out-of-order continuation', () => {
  const s = session(); for (let i = 2001; i <= 2600; i++) { if (s.pendingUpdate) s.adapt(); step(s, i); }
  assert.equal(s.window.length, 500); assert.equal(s.window[0].index, 2101);
  assert.throws(() => s.input({ index: 2601, x: [0, 0] })); s.adapt(); assert.throws(() => s.adapt());
});
test('event validation independently rejects leaked, reordered, corrupt and truncated records', () => {
  const events = []; const s = session(ready(), { emit: (e) => events.push(structuredClone(e)) });
  for (let i = 2001; i <= 2100; i++) step(s, i); s.adapt();
  assert.equal(validateChronology(events, { firstIndex: 2001, lastIndex: 2100 }).predictions, 100);
  const mutations = [(e) => { e[0].label = 1; }, (e) => { e[1].event_sequence = 1; }, (e) => { e[3].loss = 2; },
    (e) => { e[3].observed_data_last_index = 2001; }, (e) => { e.at(-1).adaptation_apw_total++; },
    (e) => { e.at(-1).budget_axis = 'unknown'; }, (e) => { e.at(-1).window_last_index++; }, (e) => { e.splice(2, 1); }];
  for (const mutate of mutations) { const bad = structuredClone(events); mutate(bad); assert.throws(() => validateChronology(bad, { firstIndex: 2001, lastIndex: 2100 })); }
  assert.throws(() => validateChronology(events.slice(0, 399), { firstIndex: 2001, lastIndex: 2100 }));
});
test('immutable attempts reject overwrite, metadata substitution and torn evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-p10-test-'));
  try {
    const dir = path.join(root, 'attempt'); const meta = { partition: 'FIXTURE', attempt_id: 'DEV', run_id: 'DEV', protocol_sha256: protocolHash };
    const writer = new AttemptWriter(dir, meta); const s = session(ready(), { emit: (e) => writer.append(e) }); step(s, 2001);
    assert.throws(() => new AttemptWriter(dir, meta)); assert.throws(() => writer.finish('COMPLETE', { run_id: 'replaced' }));
    writer.finish('COMPLETE'); assert.throws(() => writer.append({}));
    assert.equal(inspectAttempt(dir, { firstIndex: 2001, lastIndex: 2001 }).scientific_admission, false);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), '{}'); assert.throws(() => inspectAttempt(dir, { firstIndex: 2001, lastIndex: 2001 }));
    assert.throws(() => new AttemptWriter(path.join(root, 'CONF'), { ...meta, partition: 'CONF' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('renaming every provenance identifier in a restored population is algorithmically inert', () => {
  const a = ready(); const original = a.snapshot(); const renamed = structuredClone(original);
  const fields = new Set(['id','token','source','parent_token','child_token','individual','root_record']);
  const rename = (s) => s === null ? null : `renamed:${hashObject(s).slice(0,24)}`;
  function visit(o) {
    if (o === null || typeof o !== 'object') return;
    for (const [k,v] of Object.entries(o)) {
      if (fields.has(k) && (typeof v === 'string' || v === null)) o[k] = rename(v);
      else if (k === 'parents') o[k] = v.map(rename);
      else visit(v);
    }
  }
  visit(renamed); const b = EvolutionLearner.restore(renamed, { provenancePrefix: 'rename' });
  assert.deepEqual(semantics(a), semantics(b));
  const x = a.update(rows(2100), { checkpoint: 2100, cap: 30000 }); const y = b.update(rows(2100), { checkpoint: 2100, cap: 30000 });
  assert.deepEqual(semantics(a), semantics(b)); assert.deepEqual(x.apw_components, y.apw_components);
});
test('all budget multipliers produce the same cold population before subsequent adaptation', () => {
  const a = make(); const cost = a.initialise(rows()).adaptation_apw_total;
  for (const multiplier of [1,2,4]) {
    const b = make(); const report = b.initialise(rows(), 2000, { cap: multiplier * cost, budgetTag: String(multiplier) });
    assert.deepEqual(semantics(a), semantics(b)); assert.equal(report.adaptation_apw_total, cost);
  }
});
