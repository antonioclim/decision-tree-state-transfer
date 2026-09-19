import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DevelopmentStream, SCENARIOS, cleanLabel, conceptAt } from '../assets/code/confirmatory/generator.mjs';
import { keyFromAddress, drawAddress, uniformAt, openUniformFromDigest, roleRandom } from '../assets/code/confirmatory/random.mjs';
import { WorkLedger, BudgetExhausted, COMPONENTS } from '../assets/code/confirmatory/work.mjs';
import { TreeFactory, fitCart, candidateThresholds, predict, nodeCount, treeDepth, structurallyEqual, exportTree,
  importTree, validateTree, replaceAt, simplify, mutate, crossover, floatBits } from '../assets/code/confirmatory/trees.mjs';
import { buildGreedyBinaryTree } from '../assets/code/lib/greedy-cart.mjs';
import { eligibleSites, frozenShadows, shadowPredictions } from '../assets/code/confirmatory/material.mjs';
import { validateProvenance } from '../assets/code/confirmatory/evidence.mjs';

const key = '0123456789abcdef';
function setup() { const events = []; const ledger = new WorkLedger(); const factory = new TreeFactory({ ledger, update: 1, emit: (e) => events.push(structuredClone(e)) }); return { events, ledger, factory }; }
function rows(n = 40) { return Array.from({ length: n }, (_, i) => ({ index: 2000 - n + i + 1, x: [i / n, (i % 7) / 7], y: Number(i >= n / 2) })); }
function stump(f) { return f.split(0, 0.5, f.leaf(0), f.leaf(1)); }

test('all 14 scenarios and fixed DEV keys are exact', () => {
  assert.equal(SCENARIOS.length, 14);
  assert.equal(new DevelopmentStream({ scenario: SCENARIOS[0], realisation: 0 }).key, '9463861a45169367');
  assert.equal(keyFromAddress('DT-P9-v1|DEV|LOCAL_TREE-STATIONARY-NONE|r=00|optimiser=00'), '776cc053553f4026');
});
test('CONF values and disguised confirmation keys are rejected', () => {
  assert.throws(() => new DevelopmentStream({ partition: 'CONF', scenario: SCENARIOS[0], realisation: 0 }));
  assert.throws(() => new DevelopmentStream({ scenario: SCENARIOS[0], realisation: 0, streamKey: key }));
  assert.throws(() => new DevelopmentStream({ scenario: 'unknown', realisation: 0 }));
  assert.throws(() => new DevelopmentStream({ scenario: SCENARIOS[0], realisation: 3 }));
});
test('role random addresses are unambiguous, reproducible and isolated', () => {
  assert.equal(drawAddress(key, 'role', 4, 2), '["DT-P9-DRAW-v1","0123456789abcdef","role",4,2]');
  assert.equal(uniformAt(key, 'role', 4, 2), uniformAt(key, 'role', 4, 2));
  assert.notEqual(uniformAt(key, 'role', 4, 2), uniformAt(key, 'other', 4, 2));
  assert.throws(() => drawAddress('bad', 'role', 4, 2)); assert.throws(() => drawAddress(key, 'role', -1, 2));
  assert.throws(() => keyFromAddress(''));
  const r = roleRandom(key, 'test', 0, new WorkLedger()); r.uniform(); assert.equal(r.draws, 1); assert.throws(() => r.integer(0));
});
test('uniform endpoints remain strictly open even under binary64 rounding', () => {
  const zero = Buffer.alloc(32); const ones = Buffer.alloc(32, 255);
  assert.ok(openUniformFromDigest(zero) > 0); assert.equal(openUniformFromDigest(ones), 1 - 2 ** -53);
  assert.throws(() => openUniformFromDigest(Buffer.alloc(1)));
  const digest = createHash('sha256').update(drawAddress(key, 'role', 4, 2)).digest();
  assert.equal(openUniformFromDigest(digest), uniformAt(key, 'role', 4, 2));
});
test('synthetic transitions obey exact boundary and gradual mixture rules', () => {
  for (const family of ['LOCAL_TREE', 'OBLIQUE']) {
    assert.equal(conceptAt(`${family}-ABRUPT-MILD`, 10000, 0), 0);
    assert.equal(conceptAt(`${family}-ABRUPT-MILD`, 10001, 0), 1);
    assert.equal(conceptAt(`${family}-ABRUPT-MILD`, 20001, 0), 2);
    assert.equal(conceptAt(`${family}-RECURRENT-SEVERE`, 20001, 0), 0);
    assert.equal(conceptAt(`${family}-STATIONARY-NONE`, 26000, 0), 0);
    assert.equal(conceptAt(`${family}-GRADUAL-MILD`, 10001, 0), 1);
    assert.equal(conceptAt(`${family}-GRADUAL-MILD`, 10001, 0.5), 0);
    assert.equal(conceptAt(`${family}-GRADUAL-MILD`, 12000, 0.999), 1);
    assert.equal(conceptAt(`${family}-GRADUAL-MILD`, 15000, 0), 1);
    assert.equal(conceptAt(`${family}-GRADUAL-MILD`, 21000, 0.4), 2);
    assert.equal(conceptAt(`${family}-GRADUAL-MILD`, 21000, 0.6), 1);
    assert.equal(conceptAt(`${family}-GRADUAL-MILD`, 25000, 0), 2);
  }
  assert.throws(() => conceptAt(SCENARIOS[0], 0, 0));
});
test('local clean concepts agree with independent hand labels including periodic wrap', () => {
  const a = [0.2, 0.05, 0.2, 0, 0, 0, 0, 0];
  assert.equal(cleanLabel(a, 'LOCAL_TREE-ABRUPT-MILD', 0), 1);
  assert.equal(cleanLabel(a, 'LOCAL_TREE-ABRUPT-MILD', 1), 0);
  const b = [0.8, 0.2, 0.05, 0, 0, 0, 0, 0];
  assert.equal(cleanLabel(b, 'LOCAL_TREE-ABRUPT-MILD', 1), 1);
  assert.equal(cleanLabel(b, 'LOCAL_TREE-ABRUPT-MILD', 2), 0);
  assert.throws(() => cleanLabel([0], SCENARIOS[0], 0)); assert.throws(() => cleanLabel(a, SCENARIOS[0], 3));
});
test('oblique normal features are finite and exact replay has no shared mutable state', () => {
  const s = new DevelopmentStream({ scenario: 'OBLIQUE-GRADUAL-SEVERE', realisation: 0 });
  const before = s.row(10001); s.row(25000); assert.deepEqual(s.row(10001), before);
  assert.equal(before.x.length, 8); assert.ok(before.x.every(Number.isFinite));
  assert.throws(() => s.row(26001)); assert.throws(() => s.window(10, 11));
});
test('APW hand count, invalid components and exact non-overrun boundary', () => {
  const l = new WorkLedger({ cap: 3 }); l.charge('node_record_write'); l.charge('rng_variate', 2);
  assert.equal(l.total, 3); assert.throws(() => l.charge('sample_predicate_test'), BudgetExhausted); assert.equal(l.total, 3);
  assert.throws(() => l.charge('unknown')); assert.throws(() => l.charge('rng_variate', -1));
  assert.equal(Object.values(l.report().apw_components).reduce((a, b) => a + b), 3);
  assert.equal(COMPONENTS.length, 7); assert.throws(() => new WorkLedger({ cap: -1 }));
});
test('CPU safe boundary records overshoot rather than pretending exact pre-emption', () => {
  const l = new WorkLedger({ cpuCapNs: 1000, cpuClock: () => 1500 }); assert.throws(() => l.boundary(), BudgetExhausted);
  assert.equal(l.report().cpu_overshoot_ns, 500); assert.throws(() => new WorkLedger({ cpuCapNs: -1 }));
  assert.throws(() => new WorkLedger({ rssLimit: 1 }).boundary(), /RSS/);
});
test('tree creation and prediction primitives have independently countable work', () => {
  const { factory: f, ledger: l } = setup(); const t = stump(f);
  assert.equal(l.counts.node_record_write, 3);
  assert.equal(predict(t, [0.2, 0], l), 0); assert.equal(predict(t, [0.8, 0], l), 1);
  assert.equal(l.counts.sample_predicate_test, 2); assert.equal(l.nodeExampleVisits, 4);
  const before = l.total; const online = { predicate_tests: 0 }; predict(t, [0.8, 0], null, online);
  assert.equal(l.total, before); assert.equal(online.predicate_tests, 1); assert.equal(online.node_visits, 2);
});
test('instrumented unrestricted CART matches existing independent implementation', () => {
  for (let k = 0; k < 6; k++) {
    const data = rows(40 + k).map((r, i) => ({ ...r, y: Number((i + k) % 11 > 4) }));
    const { factory } = setup();
    const a = fitCart(data, factory, { featureCount: 2, maxDepth: 4, minLeaf: 2 });
    const b = buildGreedyBinaryTree(data, { featureCount: 2, maxDepth: 4, minLeaf: 2 });
    assert.ok(structurallyEqual(a, b));
  }
});
test('CART zero gain, single class, node/depth cap and class-zero refit tie', () => {
  const { factory } = setup(); const constant = rows().map((r, i) => ({ ...r, x: [0, 0], y: i % 2 }));
  assert.equal(fitCart(constant, factory, { featureCount: 2 }).type, 'leaf');
  assert.equal(fitCart(constant, factory, { featureCount: 2, tieAction: 0 }).action, 0);
  const single = rows().map((r) => ({ ...r, y: 1 })); assert.equal(fitCart(single, factory, { featureCount: 2 }).action, 1);
  for (const maxNodes of [1, 3, 5]) {
    const t = fitCart(rows(), factory, { featureCount: 2, maxDepth: 2, minLeaf: 2, maxNodes });
    assert.ok(nodeCount(t) <= maxNodes); assert.ok(treeDepth(t) <= 2);
  }
  assert.throws(() => fitCart([], factory, { featureCount: 2 }));
  assert.throws(() => fitCart([{ x: [NaN, 0], y: 0 }], factory, { featureCount: 2 }));
});
test('template refit keeps only template features and never old fitted fallback', () => {
  const { factory } = setup(); const t = factory.split(0, 0.999, factory.leaf(1), factory.leaf(0));
  const thresholds = [[0.25, 0.5, 0.75], [0.5]];
  const fitted = fitCart(rows(), factory, { featureCount: 2, minLeaf: 2, template: t, thresholds, tieAction: 0 });
  assert.equal(fitted.feature, 0); assert.equal(fitted.threshold, 0.5); assert.equal(fitted.left.action, 0);
  const collapsed = fitCart(rows().map((r) => ({ ...r, x: [0, 0] })), factory,
    { featureCount: 2, minLeaf: 2, template: t, thresholds, tieAction: 0 });
  assert.equal(collapsed.type, 'leaf'); assert.equal(collapsed.action, 0);
});
test('threshold preparation handles constants, finite extreme midpoint and ordinal quantiles', () => {
  const { ledger } = setup();
  assert.deepEqual(candidateThresholds([{ x: [1], y: 0 }], 1, 32, ledger), [[1]]);
  const t = candidateThresholds([{ x: [1e308], y: 0 }, { x: [1.1e308], y: 1 }], 1, 32, ledger);
  assert.ok(Number.isFinite(t[0][0])); assert.ok(t[0][0] > 1e308);
});
test('bit-exact threshold snapshot round trip preserves negative zero', () => {
  const { factory } = setup(); const n = factory.split(0, -0, factory.leaf(0), factory.leaf(1));
  const copy = importTree(JSON.parse(JSON.stringify(exportTree(n))));
  assert.ok(Object.is(copy.threshold, -0)); assert.equal(floatBits(copy.threshold), '8000000000000000');
  assert.throws(() => importTree({ type: 'split', threshold_bits: '7ff0000000000000' }));
});
test('independently identical material does not acquire inherited tokens', () => {
  const { factory: f, events } = setup(); const a = stump(f); f.realise(a, 'A'); const b = stump(f); f.realise(b, 'B');
  assert.ok(structurallyEqual(a, b)); assert.notEqual(a._p.token, b._p.token);
  assert.throws(() => f.leaf(1, { source: a.left }));
  assert.throws(() => f.split(0, 0.8, f.copy(a.left), f.copy(a.right), { source: a }));
  assert.ok(validateProvenance(events).node_records > 0);
});
test('whole copies preserve connected witness and exact source chains', () => {
  const { factory: f, events } = setup(); const a = stump(f); f.realise(a, 'A'); f.update = 8;
  const b = f.copy(a); f.realise(b, 'B');
  assert.equal(b._p.witness.update, 1); assert.equal(b._p.source, a._p.id);
  assert.equal(b._p.left_edge.source, a._p.left_edge.id); assert.equal(b._p.left_edge.token, a._p.left_edge.token);
  assert.ok(validateProvenance(events).realised_witnesses >= 3);
});
test('reassembling old nodes does not manufacture an old connected subtree', () => {
  const { factory: f, events } = setup(); const a = stump(f); f.realise(a, 'A'); f.update = 8;
  const b = f.rebuild(a, f.copy(a.right), f.copy(a.left), 'left'); f.realise(b, 'B');
  assert.equal(b._p.witness.update, 8); assert.equal(b.left._p.witness.update, 1);
  assert.notEqual(b._p.left_edge.token, a._p.left_edge.token); assert.ok(validateProvenance(events));
});
test('subtree movement preserves internal witness but resets its new attachment', () => {
  const { factory: f, events } = setup(); const t = f.split(1, 0.5, stump(f), f.leaf(0)); f.realise(t, 'A'); f.update = 9;
  const moved = replaceAt(t, ['right'], t.left, f); f.realise(moved, 'B');
  assert.equal(moved.right._p.witness.update, 1); assert.equal(moved._p.witness.update, 9);
  assert.notEqual(moved._p.right_edge.token, t._p.right_edge.token); assert.ok(validateProvenance(events));
});
test('simplification removes unreachable and identical-child splits without token invention', () => {
  const { factory: f, events } = setup();
  const t = f.split(0, 0.5, f.split(0, 0.8, f.leaf(0), f.leaf(1)), f.leaf(1)); f.realise(t, 'A');
  const s = simplify(t, f).tree; f.realise(s, 'B'); assert.equal(nodeCount(s), 3);
  for (const x of [0.1, 0.4, 0.6, 0.9]) assert.equal(predict(t, [x, 0]), predict(s, [x, 0]));
  const a = f.split(0, 0.5, f.leaf(1), f.leaf(1)); assert.equal(simplify(a, f).tree.type, 'leaf');
  assert.ok(validateProvenance(events));
});
test('maximal eligibility excludes root and nested duplicates, and checks window reach', () => {
  const { factory: f } = setup(); const nested = f.split(1, 0.4, stump(f), f.leaf(1));
  const t = f.split(0, 0.6, nested, f.leaf(0)); f.realise(t, 'A');
  const found = eligibleSites(t, rows(), 8, { minimumRows: 2 });
  assert.equal(found.length, 1); assert.deepEqual(found[0].path, ['left']);
  assert.equal(eligibleSites(t, rows(), 3).length, 0); assert.equal(eligibleSites(t, rows(), 8, { minimumRows: 500 }).length, 0);
});
test('frozen refit uses only reaching past rows and sham preserves every prediction', () => {
  const { factory: f } = setup(); const t = f.split(1, 0.8, stump(f), f.leaf(0)); f.realise(t, 'A');
  const learner = { champion: { tree: t }, key, completedUpdates: 8, config: { featureCount: 2, cartMinLeaf: 2, cartMinGain: 1e-12 } };
  const shadows = frozenShadows(learner, rows(), 2000, { eligibility: { minimumRows: 2 } });
  assert.equal(shadows.eligible_count, 1); assert.ok(shadows.replacement_nodes <= shadows.selected.nodes);
  for (const r of rows()) assert.equal(shadowPredictions(shadows, r.x).STRUCTURAL_SHAM, predict(t, r.x));
  const absent = frozenShadows({ ...learner, completedUpdates: 1 }, rows(), 2000);
  for (const r of rows()) assert.deepEqual(shadowPredictions(absent, r.x), { SUBTREE_REFIT: predict(t, r.x), STRUCTURAL_SHAM: predict(t, r.x) });
  assert.equal(frozenShadows({ ...learner, champion: null }, rows(), 2000).parent_unavailable, true);
});
test('mutations, self-crossover and rejected proposals retain verifiable actual copy links', () => {
  const { factory: f, events, ledger } = setup(); const t = stump(f); f.realise(t, 'A');
  const thresholds = [[0.1, 0.4, 0.5, 0.9], [0.2, 0.8]];
  for (let i = 0; i < 60; i++) {
    f.update = i + 2;
    const m = mutate(t, thresholds, roleRandom(key, 'mutation-fixture', i, ledger), f, 2); f.realise(m.tree, `M${i}`);
    const c = crossover(t, t, roleRandom(key, 'cross-fixture', i, ledger), f, 1); f.realise(c.tree, `C${i}`);
    validateTree(m.tree, { featureCount: 2, maxDepth: 2, requireRealised: true });
  }
  const deep = f.split(1, 0.4, f.split(0, 0.25, f.leaf(1), f.leaf(0)), f.leaf(1));
  f.realise(deep, 'deep-donor');
  const forced = crossover(t, deep, { choice: (paths) => paths[0] }, f, 1);
  assert.equal(forced.rejected, true); assert.ok(structurallyEqual(forced.tree, t));
  assert.ok(ledger.rejectedOperators > 0); assert.ok(validateProvenance(events));
});
test('forged provenance copies and falsely old connected witnesses are rejected', () => {
  const { factory: f, events } = setup(); const t = stump(f); f.realise(t, 'A'); f.copy(t);
  const bad = structuredClone(events); const last = bad.findLast((e) => e.kind === 'node'); last.literal[2] = '3fe8000000000000';
  assert.throws(() => validateProvenance(bad));
  const forged = structuredClone(events); forged.findLast((e) => e.kind === 'node').witness.update = -20;
  assert.throws(() => validateProvenance(forged));
  const corrupt = f.copy(t); corrupt._p.left_edge.child_token = 'fake'; assert.throws(() => validateTree(corrupt, { featureCount: 2 }));
});
test('tiny CART, threshold preparation and simplification match hand-derived full APW vectors', () => {
  const data = [{ index: 1, x: [0], y: 0 }, { index: 2, x: [1], y: 1 }];
  const { factory: f, ledger: l } = setup(); const t = fitCart(data, f, { featureCount: 1, maxDepth: 1, minLeaf: 1 });
  assert.deepEqual(l.counts, { sample_predicate_test: 2, label_count_update: 5, threshold_sort_comparison: 2,
    node_record_write: 3, rng_variate: 0, candidate_score_accumulation: 0, selection_comparison: 2 });
  assert.equal(l.total, 14);
  const thresholds = new WorkLedger(); assert.deepEqual(candidateThresholds(data, 1, 32, thresholds), [[.5]]);
  assert.equal(thresholds.total, 3); assert.equal(thresholds.counts.threshold_sort_comparison, 3);
  const clean = new WorkLedger(); const sf = new TreeFactory({ ledger: clean }); simplify(t, sf);
  assert.equal(clean.counts.node_record_write, 3); assert.equal(clean.counts.selection_comparison, 3); assert.equal(clean.total, 6);
});


test('embedded edge metadata cannot forge an older connected witness', () => {
  const events = [];
  const old = new TreeFactory({ ledger: new WorkLedger({ cap: 10000 }), prefix: 'witness-old', update: 1,
    emit: (event) => events.push(structuredClone(event)) });
  const ancestor = old.split(0, 0.5, old.leaf(0), old.leaf(1));
  old.realise(ancestor, 'ancestor-individual');
  const fresh = new TreeFactory({ ledger: new WorkLedger({ cap: 10000 }), prefix: 'witness-new', update: 10,
    emit: (event) => events.push(structuredClone(event)) });
  fresh.split(0, 0.5, fresh.copy(ancestor.left), fresh.copy(ancestor.right),
    { source: ancestor, witness: ancestor._p.witness });
  const forged = structuredClone(events);
  forged.at(-1).left_edge.token = ancestor._p.left_edge.token;
  forged.at(-1).right_edge.token = ancestor._p.right_edge.token;
  assert.throws(() => validateProvenance(forged), /invalid realised adjacency/);
});
