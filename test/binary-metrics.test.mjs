import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryMetricsFromPairs,
  formatPercent,
  requireDefinedMetric,
} from '../assets/code/lib/binary-metrics.mjs';

test('binaryMetricsFromPairs returns explicit confusion counts and recalls', () => {
  const metrics = binaryMetricsFromPairs([
    { y: 0, p: 0 },
    { y: 0, p: 1 },
    { y: 1, p: 1 },
    { y: 1, p: 1 },
  ]);

  assert.deepEqual(metrics, {
    accuracy: 0.75,
    balancedAccuracy: 0.75,
    recall0: 0.5,
    recall1: 1,
    support0: 2,
    support1: 2,
    c00: 1,
    c01: 1,
    c10: 0,
    c11: 2,
  });
});

test('an absent class produces an undefined recall and balanced accuracy', () => {
  const metrics = binaryMetricsFromPairs([
    { y: 0, p: 0 },
    { y: 0, p: 1 },
  ]);

  assert.equal(metrics.accuracy, 0.5);
  assert.equal(metrics.recall0, 0.5);
  assert.equal(metrics.recall1, null);
  assert.equal(metrics.balancedAccuracy, null);
  assert.equal(formatPercent(metrics.balancedAccuracy), 'NA');
});

test('an empty evaluation population has no defined rate metrics', () => {
  const metrics = binaryMetricsFromPairs([]);
  assert.equal(metrics.accuracy, null);
  assert.equal(metrics.balancedAccuracy, null);
  assert.equal(metrics.recall0, null);
  assert.equal(metrics.recall1, null);
  assert.deepEqual(
    [metrics.c00, metrics.c01, metrics.c10, metrics.c11],
    [0, 0, 0, 0],
  );
});

test('binaryMetricsFromPairs rejects non-binary actual and predicted values', () => {
  assert.throws(
    () => binaryMetricsFromPairs([{ y: 2, p: 0 }]),
    /actual class at pair 0 must be 0 or 1/,
  );
  assert.throws(
    () => binaryMetricsFromPairs([{ y: 0, p: -1 }]),
    /predicted class at pair 0 must be 0 or 1/,
  );
});

test('requireDefinedMetric prevents undefined balanced accuracy entering fitness', () => {
  assert.equal(requireDefinedMetric(0.75, 'balanced accuracy'), 0.75);
  assert.throws(
    () => requireDefinedMetric(null, 'balanced accuracy', 'both classes are required'),
    /balanced accuracy is undefined \(both classes are required\)/,
  );
});
