import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticBaseline, PrefixEncoder } from '../assets/code/confirmatory/diagnostic-baselines.mjs';
import { treeHash } from '../assets/code/confirmatory/trees.mjs';
const prefix = () => Array.from({ length: 2000 }, (_, i) => ({ index: i + 1, x: [i / 2000], y: i % 2 }));
test('temporal diagnostics use only revealed labels and preserve class-zero majority ties', () => {
  const last = new DiagnosticBaseline('LAST_LABEL', prefix(), { featureCount: 1 });
  const maj = new DiagnosticBaseline('PREFIX_MAJORITY', prefix(), { featureCount: 1 });
  assert.equal(last.predictInput({ index: 2001, x: [0] }), 1); assert.equal(maj.predictInput({ index: 2001, x: [0] }), 0);
  last.reveal(0); maj.reveal(1); assert.equal(last.predictInput({ index: 2002, x: [0] }), 0); assert.equal(maj.predictInput({ index: 2002, x: [0] }), 1);
  assert.throws(() => maj.predictInput({ index: 2002, x: [0] }));
});
test('frozen CART stays fixed while rolling CART updates each 100 revealed rows', () => {
  const f = new DiagnosticBaseline('FROZEN_CART', prefix(), { featureCount: 1 });
  const r = new DiagnosticBaseline('ROLLING_CART', prefix(), { featureCount: 1 }); const h = treeHash(f.tree);
  for (let i = 2001; i <= 2100; i++) { for (const b of [f,r]) { assert.ok([0,1].includes(b.predictInput({ index: i, x: [0] }))); b.reveal(1); } }
  assert.equal(treeHash(f.tree), h); assert.equal(f.trainingCosts.length, 1); assert.equal(r.trainingCosts.length, 2);
  assert.equal(r.window.length, 500); assert.throws(() => r.reveal(1));
});
test('diagnostic malformed prefix and nonchronological predictions are rejected', () => {
  assert.throws(() => new DiagnosticBaseline('unknown', prefix())); assert.throws(() => new DiagnosticBaseline('LAST_LABEL', []));
  const p = prefix(); p[4].index = 100; assert.throws(() => new DiagnosticBaseline('LAST_LABEL', p, { featureCount: 1 }));
  const b = new DiagnosticBaseline('LAST_LABEL', prefix(), { featureCount: 1 }); assert.throws(() => b.predictInput({ index: 2002, x: [0] }));
  assert.throws(() => b.predictInput({ index: 2001, x: [0], label: 1 }));
});
test('encoder freezes numeric medians and disjoint unknown/missing category slots', () => {
  const p = Array.from({ length: 2000 }, (_, i) => ({ n: i, all: null, category: i % 2 ? 'UNKNOWN' : 'a' }));
  const e = new PrefixEncoder(p, { numeric: ['n','all'], categorical: ['category'] }); const before = JSON.stringify(e.specification());
  assert.deepEqual(e.transform({ n: null, all: null, category: 'NEW' }), [999.5,1,0,1,0,0,1,0]);
  assert.deepEqual(e.transform({ n: 999999, all: 3, category: null }), [999999,0,3,0,0,0,0,1]);
  assert.deepEqual(e.transform({ n: 0, all: 0, category: 'UNKNOWN' }), [0,0,0,0,1,0,0,0]);
  assert.equal(JSON.stringify(e.specification()), before); p[0].n = -99999; assert.equal(e.specification().numeric[0].median, 999.5);
});
test('encoder refuses schema duplication, invalid numeric data and future refitting', () => {
  const p = Array.from({ length: 2000 }, () => ({ n: 0, c: 'a' }));
  assert.throws(() => new PrefixEncoder(p, { numeric: ['n'], categorical: ['n'] }));
  const e = new PrefixEncoder(p, { numeric: ['n'], categorical: ['c'] });
  assert.throws(() => e.transform({ n: NaN, c: 'a' })); assert.throws(() => e.transform({ n: 1, c: 5 }));
  p[0].n = NaN; assert.throws(() => new PrefixEncoder(p, { numeric: ['n'], categorical: ['c'] }));
});
