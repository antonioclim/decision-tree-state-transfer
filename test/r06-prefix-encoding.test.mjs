import assert from 'node:assert/strict';
import test from 'node:test';
import { PrefixEncoder } from '../assets/code/confirmatory/diagnostic-baselines.mjs';

// These are deliberately constructed encoder inputs, not generated DEV or CONF rows.
const prefix = (make) => Array.from({ length: 2000 }, (_, index) => make(index));
const numeric = (rows) => new PrefixEncoder(rows, { numeric: ['value'], categorical: [] });

test('R03-A12 preserves a nonzero constant median when a later value is missing', () => {
  const encoder = numeric(prefix(() => ({ value: 7 })));
  assert.deepEqual(encoder.transform({ value: null }), [7, 1]);
  assert.deepEqual(encoder.transform({ value: undefined }), [7, 1]);
  assert.deepEqual(encoder.transform({ value: 7 }), [7, 0]);
  assert.equal(encoder.specification().numeric[0].median, 7);
});

test('R03-A12 does not count missing prefix values when estimating a constant median', () => {
  const encoder = numeric(prefix((i) => ({ value: i % 2 ? null : -11 })));
  assert.deepEqual(encoder.transform({}), [-11, 1]);
  assert.deepEqual(encoder.transform({ value: 123 }), [123, 0]);
});

test('an entirely missing prefix imputes zero and preserves later observed values', () => {
  const encoder = numeric(prefix((i) => (i % 2 ? { value: null } : {})));
  assert.deepEqual(encoder.transform({}), [0, 1]);
  assert.deepEqual(encoder.transform({ value: -9 }), [-9, 0]);
  assert.deepEqual(encoder.transform({ value: null }), [0, 1]);
  assert.equal(encoder.specification().numeric[0].median, 0);
});

test('a genuinely observed zero remains distinguishable from imputed missing zero', () => {
  const encoder = numeric(prefix(() => ({ value: 0 })));
  assert.deepEqual(encoder.transform({ value: 0 }), [0, 0]);
  assert.deepEqual(encoder.transform({}), [0, 1]);
});

test('even and odd observed prefix counts use the independently specified medians', () => {
  const even = numeric(prefix((i) => ({ value: i < 4 ? [2, 20, 4, 6][i] : null })));
  const odd = numeric(prefix((i) => ({ value: i < 3 ? [20, 2, 4][i] : null })));
  assert.deepEqual(even.transform({}), [5, 1]);
  assert.deepEqual(odd.transform({}), [4, 1]);
});

test('the median of two maximum finite values does not overflow', () => {
  const encoder = numeric(prefix((i) => ({ value: i < 2 ? Number.MAX_VALUE : null })));
  assert.deepEqual(encoder.transform({}), [Number.MAX_VALUE, 1]);
});

test('positive and negative constant subnormal prefixes retain their nonzero medians', () => {
  for (const value of [Number.MIN_VALUE, -Number.MIN_VALUE]) {
    const encoder = numeric(prefix(() => ({ value })));
    assert.deepEqual(encoder.transform({}), [value, 1]);
  }
});

test('adjacent subnormal midpoints round to the even representable value', () => {
  const smallest = Number.MIN_VALUE;
  for (const [a, b, expected] of [[smallest, 2 * smallest, 2 * smallest],
    [-2 * smallest, -smallest, -2 * smallest]]) {
    const encoder = numeric(prefix((i) => ({ value: i % 2 ? a : b })));
    assert.deepEqual(encoder.transform({}), [expected, 1]);
  }
});

test('opposite-sign and negative extreme medians remain finite and correct', () => {
  for (const [a, b, expected] of [[-Number.MAX_VALUE, Number.MAX_VALUE, 0],
    [-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE],
    [-Number.MIN_VALUE, Number.MIN_VALUE, 0],
    [-Number.MIN_VALUE, 3 * Number.MIN_VALUE, Number.MIN_VALUE]]) {
    const encoder = numeric(prefix((i) => ({ value: i % 2 ? a : b })));
    assert.deepEqual(encoder.transform({}), [expected, 1]);
  }
});

test('future values cannot alter a fitted median or initial-prefix vocabulary', () => {
  const encoder = new PrefixEncoder(prefix(() => ({ value: 3, category: 'known' })),
    { numeric: ['value'], categorical: ['category'] });
  const before = encoder.specification();
  encoder.transform({ value: 1e100, category: 'later' });
  encoder.transform({ value: -1e100, category: 'still later' });
  assert.deepEqual(encoder.transform({ value: null, category: 'known' }), [3, 1, 1, 0, 0]);
  assert.deepEqual(encoder.specification(), before);
});

test('literal category names UNKNOWN and MISSING do not collide with reserved slots', () => {
  const encoder = new PrefixEncoder(prefix((i) => ({ category: i % 2 ? 'UNKNOWN' : 'MISSING' })),
    { numeric: [], categorical: ['category'] });
  assert.deepEqual(encoder.transform({ category: 'MISSING' }), [1, 0, 0, 0]);
  assert.deepEqual(encoder.transform({ category: 'UNKNOWN' }), [0, 1, 0, 0]);
  assert.deepEqual(encoder.transform({ category: 'new' }), [0, 0, 1, 0]);
  assert.deepEqual(encoder.transform({ category: null }), [0, 0, 0, 1]);
});

test('an all-missing categorical prefix retains separate unknown and missing columns', () => {
  const encoder = new PrefixEncoder(prefix(() => ({})), { numeric: [], categorical: ['category'] });
  assert.equal(encoder.featureCount, 2);
  assert.deepEqual(encoder.transform({ category: 'first later category' }), [1, 0]);
  assert.deepEqual(encoder.transform({}), [0, 1]);
  assert.deepEqual(encoder.specification().categorical[0].vocabulary, []);
});

test('caller mutations to prefix rows and returned specifications do not refit the encoder', () => {
  const rows = prefix(() => ({ value: 7, category: 'initial' }));
  const encoder = new PrefixEncoder(rows, { numeric: ['value'], categorical: ['category'] });
  const snapshot = encoder.specification();
  rows[0].value = -9000;
  rows[0].category = 'edited';
  snapshot.numeric[0].median = 88;
  snapshot.categorical[0].vocabulary.push('edited');
  assert.deepEqual(encoder.transform({ value: null, category: 'edited' }), [7, 1, 0, 1, 0]);
  assert.deepEqual(encoder.specification().categorical[0].vocabulary, ['initial']);
});

test('invalid numeric types are rejected both during fitting and future transformation', () => {
  const encoder = numeric(prefix(() => ({ value: 1 })));
  for (const invalid of [NaN, Infinity, -Infinity, '1', true]) {
    assert.throws(() => encoder.transform({ value: invalid }));
    const rows = prefix(() => ({ value: 1 }));
    rows[1999].value = invalid;
    assert.throws(() => numeric(rows));
  }
});

test('the encoder refuses a prefix with a future row or duplicate schema fields', () => {
  const rows = prefix(() => ({ value: 1 }));
  assert.throws(() => numeric(rows.slice(0, 1999)));
  assert.throws(() => numeric([...rows, { value: 9999 }]));
  assert.throws(() => new PrefixEncoder(rows, { numeric: ['value'], categorical: ['value'] }));
  assert.throws(() => new PrefixEncoder(rows, { numeric: [''], categorical: [] }));
});
