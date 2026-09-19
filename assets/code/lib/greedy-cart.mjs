const DEFAULT_MIN_IMPURITY_DECREASE = 1e-12;

export function countBinaryClasses(rows) {
  let n0 = 0;
  let n1 = 0;
  for (let index = 0; index < rows.length; index++) {
    const y = rows[index]?.y;
    if (y === 0) n0++;
    else if (y === 1) n1++;
    else throw new TypeError(`row ${index} has non-binary class ${String(y)}`);
  }
  return [n0, n1];
}

export function giniImpurity(n0, n1) {
  if (!Number.isInteger(n0) || n0 < 0 || !Number.isInteger(n1) || n1 < 0) {
    throw new TypeError('class counts must be non-negative integers');
  }
  const n = n0 + n1;
  if (n === 0) return 0;
  const p0 = n0 / n;
  const p1 = n1 / n;
  return 1 - p0 * p0 - p1 * p1;
}

function validateConfiguration({
  featureCount,
  maxDepth,
  minLeaf,
  minImpurityDecrease,
  tieAction,
  candidateThresholds,
}) {
  if (!Number.isInteger(featureCount) || featureCount < 1) {
    throw new TypeError('featureCount must be a positive integer');
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError('maxDepth must be a non-negative integer');
  }
  if (!Number.isInteger(minLeaf) || minLeaf < 1) {
    throw new TypeError('minLeaf must be a positive integer');
  }
  if (!Number.isFinite(minImpurityDecrease) || minImpurityDecrease < 0) {
    throw new TypeError('minImpurityDecrease must be a non-negative finite number');
  }
  if (tieAction !== 0 && tieAction !== 1) {
    throw new TypeError('tieAction must be 0 or 1');
  }
  if (candidateThresholds != null) {
    if (!Array.isArray(candidateThresholds) || candidateThresholds.length !== featureCount) {
      throw new TypeError('candidateThresholds must contain one threshold array per feature');
    }
    for (let feature = 0; feature < candidateThresholds.length; feature++) {
      const thresholds = candidateThresholds[feature];
      if (!Array.isArray(thresholds)) {
        throw new TypeError(`candidateThresholds[${feature}] must be an array`);
      }
      for (const threshold of thresholds) {
        if (!Number.isFinite(threshold)) {
          throw new TypeError(`candidate threshold for feature ${feature} must be finite`);
        }
      }
    }
  }
}

function validateRows(rows, featureCount) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError('rows must be a non-empty array');
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row == null || !Array.isArray(row.x) || row.x.length !== featureCount) {
      throw new TypeError(`row ${rowIndex} must contain exactly ${featureCount} features`);
    }
    if (row.y !== 0 && row.y !== 1) {
      throw new TypeError(`row ${rowIndex} has non-binary class ${String(row.y)}`);
    }
    for (let feature = 0; feature < featureCount; feature++) {
      if (!Number.isFinite(row.x[feature])) {
        throw new TypeError(`row ${rowIndex}, feature ${feature} is not finite`);
      }
    }
  }
}

function finitePartitionThreshold(lower, upper) {
  // Dividing first avoids overflow from (lower + upper) / 2 for large finite values.
  const midpoint = lower / 2 + upper / 2;
  return midpoint > lower && midpoint <= upper ? midpoint : upper;
}

function bestObservedMidpointSplit(rows, featureCount, minLeaf) {
  const [total0, total1] = countBinaryClasses(rows);
  let best = null;

  for (let feature = 0; feature < featureCount; feature++) {
    const sorted = rows
      .map((row) => ({ value: row.x[feature], y: row.y }))
      .sort((a, b) => a.value - b.value);
    let left0 = 0;
    let left1 = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      sorted[i].y === 0 ? left0++ : left1++;
      const leftSize = i + 1;
      const rightSize = sorted.length - leftSize;
      if (leftSize < minLeaf || rightSize < minLeaf) continue;
      if (sorted[i].value === sorted[i + 1].value) continue;

      const right0 = total0 - left0;
      const right1 = total1 - left1;
      const impurity =
        (leftSize / rows.length) * giniImpurity(left0, left1) +
        (rightSize / rows.length) * giniImpurity(right0, right1);

      if (best === null || impurity < best.impurity) {
        best = {
          feature,
          threshold: finitePartitionThreshold(sorted[i].value, sorted[i + 1].value),
          impurity,
        };
      }
    }
  }

  return best;
}

function bestCandidateThresholdSplit(rows, featureCount, minLeaf, candidateThresholds) {
  let best = null;

  for (let feature = 0; feature < featureCount; feature++) {
    for (const threshold of candidateThresholds[feature]) {
      let left0 = 0;
      let left1 = 0;
      let right0 = 0;
      let right1 = 0;

      for (const row of rows) {
        if (row.x[feature] < threshold) {
          row.y === 0 ? left0++ : left1++;
        } else {
          row.y === 0 ? right0++ : right1++;
        }
      }

      const leftSize = left0 + left1;
      const rightSize = right0 + right1;
      if (leftSize < minLeaf || rightSize < minLeaf) continue;

      const impurity =
        (leftSize / rows.length) * giniImpurity(left0, left1) +
        (rightSize / rows.length) * giniImpurity(right0, right1);

      if (best === null || impurity < best.impurity) {
        best = { feature, threshold, impurity };
      }
    }
  }

  return best;
}

/**
 * @param {Array<{x: number[], y: 0 | 1}>} rows
 * @param {{featureCount?: number, minLeaf?: number, candidateThresholds?: number[][] | null}} [options]
 */
export function findBestGiniSplit(rows, {
  featureCount,
  minLeaf,
  candidateThresholds = null,
} = {}) {
  validateConfiguration({
    featureCount,
    maxDepth: 0,
    minLeaf,
    minImpurityDecrease: 0,
    tieAction: 1,
    candidateThresholds,
  });
  validateRows(rows, featureCount);

  return candidateThresholds == null
    ? bestObservedMidpointSplit(rows, featureCount, minLeaf)
    : bestCandidateThresholdSplit(rows, featureCount, minLeaf, candidateThresholds);
}

/**
 * Build an unpruned greedy binary tree. A candidate split is accepted only when
 * its weighted Gini impurity is lower than the parent impurity by more than the
 * configured tolerance. This prevents structurally larger zero-gain trees.
 */
/**
 * @param {Array<{x: number[], y: 0 | 1}>} rows
 * @param {{
 *   featureCount?: number,
 *   maxDepth?: number,
 *   minLeaf?: number,
 *   candidateThresholds?: number[][] | null,
 *   minImpurityDecrease?: number,
 *   tieAction?: 0 | 1,
 * }} [options]
 */
export function buildGreedyBinaryTree(rows, {
  featureCount,
  maxDepth,
  minLeaf,
  candidateThresholds = null,
  minImpurityDecrease = DEFAULT_MIN_IMPURITY_DECREASE,
  tieAction = 1,
} = {}) {
  const config = {
    featureCount,
    maxDepth,
    minLeaf,
    candidateThresholds,
    minImpurityDecrease,
    tieAction,
  };
  validateConfiguration(config);
  validateRows(rows, featureCount);

  function build(nodeRows, depth) {
    const [n0, n1] = countBinaryClasses(nodeRows);
    const action = n0 === n1 ? tieAction : n1 > n0 ? 1 : 0;

    if (
      depth >= maxDepth ||
      n0 === 0 || n1 === 0 ||
      nodeRows.length < 2 * minLeaf
    ) {
      return { type: 'leaf', action };
    }

    const split = candidateThresholds == null
      ? bestObservedMidpointSplit(nodeRows, featureCount, minLeaf)
      : bestCandidateThresholdSplit(nodeRows, featureCount, minLeaf, candidateThresholds);
    if (split === null) return { type: 'leaf', action };

    const parentImpurity = giniImpurity(n0, n1);
    const impurityDecrease = parentImpurity - split.impurity;
    if (!(impurityDecrease > minImpurityDecrease)) {
      return { type: 'leaf', action };
    }

    const left = [];
    const right = [];
    for (const row of nodeRows) {
      (row.x[split.feature] < split.threshold ? left : right).push(row);
    }

    return {
      type: 'split',
      feature: split.feature,
      threshold: split.threshold,
      left: build(left, depth + 1),
      right: build(right, depth + 1),
    };
  }

  return build(rows, 0);
}
