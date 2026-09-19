function assertBinaryValue(value, name, index) {
  if (value !== 0 && value !== 1) {
    throw new TypeError(`${name} at pair ${index} must be 0 or 1; received ${String(value)}`);
  }
}

/**
 * Compute binary confusion counts and recalls from explicit actual/predicted pairs.
 * A class recall is null when that class has no observations. Balanced accuracy is
 * null unless both class recalls are defined; it is never silently imputed as zero.
 */
export function binaryMetricsFromPairs(pairs) {
  if (!Array.isArray(pairs)) {
    throw new TypeError('pairs must be an array');
  }

  let c00 = 0;
  let c01 = 0;
  let c10 = 0;
  let c11 = 0;

  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (pair == null || typeof pair !== 'object') {
      throw new TypeError(`pair ${index} must be an object with y and p fields`);
    }
    assertBinaryValue(pair.y, 'actual class', index);
    assertBinaryValue(pair.p, 'predicted class', index);

    if (pair.y === 0) {
      pair.p === 0 ? c00++ : c01++;
    } else {
      pair.p === 1 ? c11++ : c10++;
    }
  }

  const support0 = c00 + c01;
  const support1 = c11 + c10;
  const recall0 = support0 === 0 ? null : c00 / support0;
  const recall1 = support1 === 0 ? null : c11 / support1;
  const accuracy = pairs.length === 0 ? null : (c00 + c11) / pairs.length;
  const balancedAccuracy = recall0 === null || recall1 === null
    ? null
    : (recall0 + recall1) / 2;

  return {
    accuracy,
    balancedAccuracy,
    recall0,
    recall1,
    support0,
    support1,
    c00,
    c01,
    c10,
    c11,
  };
}

export function requireDefinedMetric(value, name, context = '') {
  if (value === null || !Number.isFinite(value)) {
    const suffix = context ? ` (${context})` : '';
    throw new Error(`${name} is undefined${suffix}`);
  }
  return value;
}

export function formatPercent(value, digits = 2) {
  if (value === null) return 'NA';
  if (!Number.isFinite(value)) throw new TypeError('percentage value must be finite or null');
  return `${(100 * value).toFixed(digits)}%`;
}
