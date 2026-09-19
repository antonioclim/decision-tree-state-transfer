import { createHash } from 'node:crypto';

const BIRTH_ROLES = new Set([
  'initial-cart',
  'initial-cart-descendant',
  'random-initial',
  'offspring',
]);

const PARENT_POOLS = new Set([
  'none',
  'initial-cart-seed',
  'pre-replacement-population',
]);

const ORIGINS = new Set([
  'initial-cart',
  'initial-cart-clone',
  'initial-cart-mutation',
  'random-initial',
  'clone',
  'crossover',
  'mutation',
  'crossover+mutation',
]);

const MUTATION_OPERATIONS = new Set([
  'feature',
  'flip',
  'prune',
  'replace',
  'threshold',
]);

function requireSafeInteger(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be boolean`);
  }
}

function canonicalNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * Return a property-order-independent representation of the decision tree.
 * This is an exact structural representation, not a statement that two trees
 * are behaviourally equivalent on all possible observations.
 */
export function canonicalTree(tree) {
  function visit(node, location) {
    if (!node || typeof node !== 'object') {
      throw new TypeError(`${location} must be a tree-node object`);
    }
    if (node.type === 'leaf') {
      if (node.action !== 0 && node.action !== 1) {
        throw new TypeError(`${location}.action must be 0 or 1`);
      }
      return `L(${node.action})`;
    }
    if (node.type !== 'split') {
      throw new TypeError(`${location}.type must be "leaf" or "split"`);
    }
    requireSafeInteger(node.feature, `${location}.feature`, 0);
    const threshold = canonicalNumber(node.threshold, `${location}.threshold`);
    return `S(${node.feature},${threshold},${visit(node.left, `${location}.left`)},${visit(node.right, `${location}.right`)})`;
  }

  return visit(tree, 'tree');
}

export function treeFingerprint(tree) {
  return createHash('sha256').update(canonicalTree(tree)).digest('hex');
}

export function treesStructurallyEqual(left, right) {
  return canonicalTree(left) === canonicalTree(right);
}

export function deriveLineageOrigin({
  birthRole,
  treeChangedFromParentA,
  crossoverStructurallyEffective,
  mutationStructurallyEffectiveCount,
}) {
  if (!BIRTH_ROLES.has(birthRole)) {
    throw new TypeError(`unknown birthRole ${JSON.stringify(birthRole)}`);
  }
  requireBoolean(crossoverStructurallyEffective, 'crossoverStructurallyEffective');
  requireSafeInteger(
    mutationStructurallyEffectiveCount,
    'mutationStructurallyEffectiveCount',
    0,
  );

  if (birthRole === 'initial-cart') return 'initial-cart';
  if (birthRole === 'random-initial') return 'random-initial';

  requireBoolean(treeChangedFromParentA, 'treeChangedFromParentA');
  if (birthRole === 'initial-cart-descendant') {
    if (treeChangedFromParentA && mutationStructurallyEffectiveCount === 0) {
      throw new Error('initial CART descendant changed without a structurally effective mutation');
    }
    return treeChangedFromParentA ? 'initial-cart-mutation' : 'initial-cart-clone';
  }

  // `origin` is a compact net-change class. A final tree identical to parent A
  // is a clone. Otherwise, the label lists operator classes that changed their
  // immediate input during the birth sequence; it does not prove that material
  // from every listed step survives in the final tree.
  if (!treeChangedFromParentA) return 'clone';
  const mutationEffective = mutationStructurallyEffectiveCount > 0;
  if (crossoverStructurallyEffective && mutationEffective) return 'crossover+mutation';
  if (crossoverStructurallyEffective) return 'crossover';
  if (mutationEffective) return 'mutation';
  throw new Error('net structural change is not explained by an effective operator');
}

function normaliseMutationTrace(trace, index) {
  if (!trace || typeof trace !== 'object') {
    throw new TypeError(`mutations[${index}] must be an object`);
  }
  if (typeof trace.operation !== 'string' || trace.operation.length === 0) {
    throw new TypeError(`mutations[${index}].operation must be a non-empty string`);
  }
  if (!MUTATION_OPERATIONS.has(trace.operation)) {
    throw new TypeError(`mutations[${index}].operation is unsupported: ${trace.operation}`);
  }
  requireBoolean(trace.structurallyEffective, `mutations[${index}].structurallyEffective`);
  requireBoolean(trace.depthRejected, `mutations[${index}].depthRejected`);
  if (trace.structurallyEffective && trace.depthRejected) {
    throw new TypeError(`mutations[${index}] cannot be effective and depth-rejected`);
  }
  return Object.freeze({
    operation: trace.operation,
    structurallyEffective: trace.structurallyEffective,
    depthRejected: trace.depthRejected,
  });
}

function normaliseCrossoverTrace(trace) {
  if (trace == null) return null;
  if (typeof trace !== 'object') {
    throw new TypeError('crossover must be an object or null');
  }
  requireBoolean(trace.structurallyEffective, 'crossover.structurallyEffective');
  requireBoolean(trace.depthRejected, 'crossover.depthRejected');
  if (trace.structurallyEffective && trace.depthRejected) {
    throw new TypeError('crossover cannot be effective and depth-rejected');
  }
  return Object.freeze({
    structurallyEffective: trace.structurallyEffective,
    depthRejected: trace.depthRejected,
  });
}

/**
 * Construct an immutable record from the exact operator trace used to create
 * an individual. Parent objects must expose `id` and `tree`.
 */
/**
 * @param {{
 *   id?: number,
 *   bornAt?: number,
 *   tree?: unknown,
 *   birthRole?: string,
 *   parents?: Array<{id: number, tree: unknown}>,
 *   parentPool?: string,
 *   parentRetained?: boolean[],
 *   crossover?: {structurallyEffective: boolean, depthRejected: boolean} | null,
 *   mutations?: Array<{operation: string, structurallyEffective: boolean, depthRejected: boolean}>,
 * }} [input]
 */
export function createLineageRecord({
  id,
  bornAt,
  tree,
  birthRole = 'offspring',
  parents = [],
  parentPool = 'none',
  parentRetained = [],
  crossover = null,
  mutations = [],
} = {}) {
  requireSafeInteger(id, 'id', 1);
  requireSafeInteger(bornAt, 'bornAt', 0);
  if (!BIRTH_ROLES.has(birthRole)) {
    throw new TypeError(`unknown birthRole ${JSON.stringify(birthRole)}`);
  }
  if (!PARENT_POOLS.has(parentPool)) {
    throw new TypeError(`unknown parentPool ${JSON.stringify(parentPool)}`);
  }
  if (!Array.isArray(parents)) throw new TypeError('parents must be an array');
  if (!Array.isArray(parentRetained)) throw new TypeError('parentRetained must be an array');
  if (!Array.isArray(mutations)) throw new TypeError('mutations must be an array');

  const normalisedParents = parents.map((parent, index) => {
    if (!parent || typeof parent !== 'object') {
      throw new TypeError(`parents[${index}] must be an individual object`);
    }
    requireSafeInteger(parent.id, `parents[${index}].id`, 1);
    canonicalTree(parent.tree);
    return Object.freeze({ id: parent.id, tree: parent.tree });
  });
  const selectedParents = normalisedParents.map((parent) => parent.id);
  const normalisedParentRetained = parentRetained.map((value, index) => {
    requireBoolean(value, `parentRetained[${index}]`);
    return value;
  });
  const crossoverTrace = normaliseCrossoverTrace(crossover);
  const mutationTraces = mutations.map(normaliseMutationTrace);

  const crossoverAttempted = crossoverTrace !== null;
  const crossoverStructurallyEffective = crossoverTrace?.structurallyEffective ?? false;
  const crossoverDepthRejected = crossoverTrace?.depthRejected ?? false;
  const selfCrossover = crossoverAttempted
    && selectedParents.length === 2
    && selectedParents[0] === selectedParents[1];
  const mutationStructurallyEffectiveCount = mutationTraces.filter(
    (trace) => trace.structurallyEffective,
  ).length;
  const mutationDepthRejectionCount = mutationTraces.filter(
    (trace) => trace.depthRejected,
  ).length;
  const treeChangedFromParentA = normalisedParents.length === 0
    ? null
    : !treesStructurallyEqual(tree, normalisedParents[0].tree);
  const origin = deriveLineageOrigin({
    birthRole,
    treeChangedFromParentA,
    crossoverStructurallyEffective,
    mutationStructurallyEffectiveCount,
  });

  return Object.freeze({
    id,
    bornAt,
    birthRole,
    origin,
    selectedParents: Object.freeze([...selectedParents]),
    parentPool,
    parentRetained: Object.freeze([...normalisedParentRetained]),
    distinctSelectedParentCount: new Set(selectedParents).size,
    crossoverAttempted,
    crossoverStructurallyEffective,
    selfCrossover,
    crossoverDepthRejected,
    mutationAttemptCount: mutationTraces.length,
    mutationStructurallyEffectiveCount,
    mutationDepthRejectionCount,
    mutationOperations: Object.freeze(mutationTraces.map((trace) => trace.operation)),
    mutationStructurallyEffectiveFlags: Object.freeze(
      mutationTraces.map((trace) => trace.structurallyEffective),
    ),
    mutationDepthRejectedFlags: Object.freeze(
      mutationTraces.map((trace) => trace.depthRejected),
    ),
    treeChangedFromParentA,
    treeSha256: treeFingerprint(tree),
  });
}

function toRecordMap(records) {
  if (records instanceof Map) return new Map(records);
  if (!Array.isArray(records)) {
    throw new TypeError('lineage records must be a Map or an array');
  }
  const map = new Map();
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object') {
      throw new TypeError(`lineage records[${index}] must be an object`);
    }
    if (map.has(record.id)) {
      throw new Error(`lineage contains duplicate id ${record.id}`);
    }
    map.set(record.id, record);
  }
  return map;
}

function assertRecordShape(record, mapKey) {
  if (!record || typeof record !== 'object') {
    throw new TypeError(`lineage record ${mapKey} must be an object`);
  }
  requireSafeInteger(record.id, `lineage record ${mapKey}.id`, 1);
  if (record.id !== mapKey) {
    throw new Error(`lineage map key ${mapKey} does not match record id ${record.id}`);
  }
  requireSafeInteger(record.bornAt, `lineage record ${record.id}.bornAt`, 0);
  if (!BIRTH_ROLES.has(record.birthRole)) {
    throw new Error(`lineage record ${record.id} has unsupported birthRole`);
  }
  if (!ORIGINS.has(record.origin)) {
    throw new Error(`lineage record ${record.id} has unsupported origin ${record.origin}`);
  }
  if (!PARENT_POOLS.has(record.parentPool)) {
    throw new Error(`lineage record ${record.id} has unsupported parentPool`);
  }
  for (const field of ['selectedParents', 'parentRetained']) {
    if (!Array.isArray(record[field])) {
      throw new TypeError(`lineage record ${record.id}.${field} must be an array`);
    }
  }
  for (const field of [
    'crossoverAttempted',
    'crossoverStructurallyEffective',
    'selfCrossover',
    'crossoverDepthRejected',
  ]) {
    requireBoolean(record[field], `lineage record ${record.id}.${field}`);
  }
  for (const field of [
    'mutationAttemptCount',
    'mutationStructurallyEffectiveCount',
    'mutationDepthRejectionCount',
    'distinctSelectedParentCount',
  ]) {
    requireSafeInteger(record[field], `lineage record ${record.id}.${field}`, 0);
  }
  for (const field of [
    'mutationOperations',
    'mutationStructurallyEffectiveFlags',
    'mutationDepthRejectedFlags',
  ]) {
    if (!Array.isArray(record[field])) {
      throw new TypeError(`lineage record ${record.id}.${field} must be an array`);
    }
  }
  if (record.treeChangedFromParentA !== null) {
    requireBoolean(record.treeChangedFromParentA, `lineage record ${record.id}.treeChangedFromParentA`);
  }
  if (typeof record.treeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.treeSha256)) {
    throw new TypeError(`lineage record ${record.id}.treeSha256 must be a lowercase SHA-256 string`);
  }
}

/**
 * Validate parent existence, temporal ordering, operator semantics and
 * acyclicity. Duplicate selected parents are permitted only as explicit
 * self-crossover.
 */
export function validateLineage(records) {
  const map = toRecordMap(records);
  if (map.size === 0) throw new Error('lineage is empty');

  const sortedIds = [...map.keys()].sort((left, right) => left - right);
  for (let index = 0; index < sortedIds.length; index++) {
    if (sortedIds[index] !== index + 1) {
      throw new Error(`lineage ids must be contiguous from 1; missing position ${index + 1}`);
    }
  }
  for (const [id, record] of map) assertRecordShape(record, id);

  const initialCartRecords = [...map.values()].filter(
    (record) => record.birthRole === 'initial-cart',
  );
  if (initialCartRecords.length !== 1) {
    throw new Error(`lineage must contain exactly one initial CART; found ${initialCartRecords.length}`);
  }
  const initialCartId = initialCartRecords[0].id;

  for (const record of map.values()) {
    const parents = record.selectedParents;

    if (record.birthRole === 'initial-cart' || record.birthRole === 'random-initial') {
      if (record.bornAt !== 0) {
        throw new Error(`initial root record ${record.id} must be born at position 0`);
      }
      if (parents.length !== 0) throw new Error(`root record ${record.id} must not have parents`);
      if (record.parentPool !== 'none') {
        throw new Error(`root record ${record.id} must use parentPool=none`);
      }
      if (record.parentRetained.length !== 0) {
        throw new Error(`root record ${record.id} must not have parent retention flags`);
      }
      if (record.treeChangedFromParentA !== null) {
        throw new Error(`root record ${record.id} cannot have a parent-A change flag`);
      }
      if (record.crossoverAttempted || record.mutationAttemptCount !== 0) {
        throw new Error(`root record ${record.id} cannot record evolutionary operators`);
      }
    } else if (record.birthRole === 'initial-cart-descendant') {
      if (record.bornAt !== 0) {
        throw new Error(`initial CART descendant ${record.id} must be born at position 0`);
      }
      if (parents.length !== 1) {
        throw new Error(`initial CART descendant ${record.id} must have one parent`);
      }
      if (record.parentPool !== 'initial-cart-seed') {
        throw new Error(`initial CART descendant ${record.id} must use the initial CART seed pool`);
      }
      if (record.parentRetained.length !== 0) {
        throw new Error(`initial CART descendant ${record.id} must not use survivor flags`);
      }
      if (record.crossoverAttempted) {
        throw new Error(`initial CART descendant ${record.id} cannot record crossover`);
      }
      if (record.mutationAttemptCount < 1 || record.mutationAttemptCount > 2) {
        throw new Error(`initial CART descendant ${record.id} must record one or two mutations`);
      }
      if (parents[0] !== initialCartId) {
        throw new Error(`initial CART descendant ${record.id} must reference initial CART ${initialCartId}`);
      }
    } else {
      if (record.bornAt <= 0) {
        throw new Error(`update offspring ${record.id} must be born after position 0`);
      }
      const expectedParentCount = record.crossoverAttempted ? 2 : 1;
      if (parents.length !== expectedParentCount) {
        throw new Error(
          `offspring ${record.id} records ${parents.length} parents; expected ${expectedParentCount}`,
        );
      }
      if (record.parentPool !== 'pre-replacement-population') {
        throw new Error(`offspring ${record.id} must use the pre-replacement population`);
      }
      if (record.parentRetained.length !== parents.length) {
        throw new Error(`offspring ${record.id} must record retained status for every parent`);
      }
      if (record.mutationAttemptCount > 1) {
        throw new Error(`update offspring ${record.id} cannot record more than one mutation attempt`);
      }
    }

    if (record.distinctSelectedParentCount !== new Set(parents).size) {
      throw new Error(`record ${record.id} has an incorrect distinct parent count`);
    }
    if (record.selfCrossover !== (
      record.crossoverAttempted
      && parents.length === 2
      && parents[0] === parents[1]
    )) {
      throw new Error(`record ${record.id} has inconsistent self-crossover metadata`);
    }
    if (!record.crossoverAttempted && (
      record.crossoverStructurallyEffective
      || record.crossoverDepthRejected
      || record.selfCrossover
    )) {
      throw new Error(`record ${record.id} reports crossover effects without an attempt`);
    }
    if (record.crossoverStructurallyEffective && record.crossoverDepthRejected) {
      throw new Error(`record ${record.id} cannot have effective and depth-rejected crossover`);
    }

    if (
      record.mutationOperations.length !== record.mutationAttemptCount
      || record.mutationStructurallyEffectiveFlags.length !== record.mutationAttemptCount
      || record.mutationDepthRejectedFlags.length !== record.mutationAttemptCount
    ) {
      throw new Error(`record ${record.id} has inconsistent mutation trace lengths`);
    }
    const effectiveMutations = record.mutationStructurallyEffectiveFlags.filter(Boolean).length;
    const rejectedMutations = record.mutationDepthRejectedFlags.filter(Boolean).length;
    if (effectiveMutations !== record.mutationStructurallyEffectiveCount) {
      throw new Error(`record ${record.id} has an incorrect effective mutation count`);
    }
    if (rejectedMutations !== record.mutationDepthRejectionCount) {
      throw new Error(`record ${record.id} has an incorrect depth-rejected mutation count`);
    }
    for (let index = 0; index < record.mutationAttemptCount; index++) {
      requireBoolean(
        record.mutationStructurallyEffectiveFlags[index],
        `record ${record.id} mutation ${index} structurally-effective flag`,
      );
      requireBoolean(
        record.mutationDepthRejectedFlags[index],
        `record ${record.id} mutation ${index} depth-rejected flag`,
      );
      if (
        record.mutationStructurallyEffectiveFlags[index]
        && record.mutationDepthRejectedFlags[index]
      ) {
        throw new Error(`record ${record.id} mutation ${index} is effective and depth-rejected`);
      }
      if (
        typeof record.mutationOperations[index] !== 'string'
        || record.mutationOperations[index].length === 0
      ) {
        throw new Error(`record ${record.id} mutation ${index} lacks an operation name`);
      }
      if (!MUTATION_OPERATIONS.has(record.mutationOperations[index])) {
        throw new Error(
          `record ${record.id} mutation ${index} has unsupported operation ${record.mutationOperations[index]}`,
        );
      }
    }

    const expectedOrigin = deriveLineageOrigin({
      birthRole: record.birthRole,
      treeChangedFromParentA: record.treeChangedFromParentA,
      crossoverStructurallyEffective: record.crossoverStructurallyEffective,
      mutationStructurallyEffectiveCount: record.mutationStructurallyEffectiveCount,
    });
    if (record.origin !== expectedOrigin) {
      throw new Error(`record ${record.id} has origin ${record.origin}; expected ${expectedOrigin}`);
    }
    if ((parents.length === 0) !== (record.treeChangedFromParentA === null)) {
      throw new Error(`record ${record.id} has inconsistent parent-A change metadata`);
    }

    for (const retained of record.parentRetained) requireBoolean(retained, 'parentRetained item');
    for (const parentId of parents) {
      requireSafeInteger(parentId, `record ${record.id} parent id`, 1);
      if (parentId === record.id) throw new Error(`record ${record.id} is its own parent`);
      const parent = map.get(parentId);
      if (!parent) throw new Error(`record ${record.id} references missing parent ${parentId}`);
      if (parentId >= record.id) {
        throw new Error(`record ${record.id} references non-earlier parent ${parentId}`);
      }
      if (parent.bornAt > record.bornAt) {
        throw new Error(`record ${record.id} predates parent ${parentId}`);
      }
      if (record.birthRole === 'offspring' && parent.bornAt >= record.bornAt) {
        throw new Error(
          `update offspring ${record.id} must select parents from an earlier update state`,
        );
      }
      if (
        record.birthRole === 'initial-cart-descendant'
        && parent.birthRole !== 'initial-cart'
      ) {
        throw new Error(`initial CART descendant ${record.id} does not reference the initial CART`);
      }
    }
  }

  const state = new Map();
  function visit(id) {
    const colour = state.get(id) ?? 0;
    if (colour === 1) throw new Error(`lineage contains a cycle involving ${id}`);
    if (colour === 2) return;
    state.set(id, 1);
    for (const parentId of map.get(id).selectedParents) visit(parentId);
    state.set(id, 2);
  }
  for (const id of map.keys()) visit(id);

  return {
    recordCount: map.size,
    rootCount: [...map.values()].filter((record) => record.selectedParents.length === 0).length,
  };
}

export function ancestorsExclusive(records, id) {
  const map = toRecordMap(records);
  if (!map.has(id)) throw new Error(`unknown lineage id ${id}`);
  const seen = new Set();
  const stack = [...map.get(id).selectedParents];

  while (stack.length > 0) {
    const parentId = stack.pop();
    if (parentId === id) throw new Error(`lineage cycle returns to focal individual ${id}`);
    if (seen.has(parentId)) continue;
    const parent = map.get(parentId);
    if (!parent) throw new Error(`lineage references missing parent ${parentId}`);
    seen.add(parentId);
    stack.push(...parent.selectedParents);
  }
  return seen;
}

export function maximumAncestryDepth(records, id) {
  const map = toRecordMap(records);
  if (!map.has(id)) throw new Error(`unknown lineage id ${id}`);
  const memo = new Map();
  const visiting = new Set();

  function depth(currentId) {
    if (memo.has(currentId)) return memo.get(currentId);
    if (visiting.has(currentId)) throw new Error(`lineage cycle encountered at ${currentId}`);
    const record = map.get(currentId);
    if (!record) throw new Error(`unknown lineage id ${currentId}`);
    visiting.add(currentId);
    const result = record.selectedParents.length === 0
      ? 0
      : 1 + Math.max(...record.selectedParents.map(depth));
    visiting.delete(currentId);
    memo.set(currentId, result);
    return result;
  }

  return depth(id);
}

function countBy(records, field) {
  const counts = {};
  for (const record of records) {
    const key = String(record[field]);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countMutationOperations(records, { structurallyEffectiveOnly = false } = {}) {
  const counts = {};
  for (const record of records) {
    for (let index = 0; index < record.mutationOperations.length; index++) {
      if (
        structurallyEffectiveOnly
        && !record.mutationStructurallyEffectiveFlags[index]
      ) {
        continue;
      }
      const operation = record.mutationOperations[index];
      counts[operation] = (counts[operation] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * @param {Map<number, any> | Iterable<any>} records
 * @param {{finalChampionId?: number, initialCartId?: number}} [options]
 */
export function summariseLineage(records, { finalChampionId, initialCartId } = {}) {
  const map = toRecordMap(records);
  const validation = validateLineage(map);
  const finalChampion = map.get(finalChampionId);
  if (!finalChampion) throw new Error(`unknown final champion id ${finalChampionId}`);
  const initialCart = map.get(initialCartId);
  if (!initialCart) throw new Error(`unknown initial CART id ${initialCartId}`);
  if (initialCart.birthRole !== 'initial-cart') {
    throw new Error(`lineage id ${initialCartId} is not the initial CART`);
  }

  const values = [...map.values()];
  const ancestors = ancestorsExclusive(map, finalChampionId);
  const initialDescendants = values.filter(
    (record) => record.birthRole === 'initial-cart-descendant',
  );
  const updateOffspring = values.filter((record) => record.birthRole === 'offspring');
  const parentOutsideRetainedEdges = updateOffspring.reduce(
    (total, record) => total + record.parentRetained.filter((retained) => !retained).length,
    0,
  );

  return {
    schemaVersion: 1,
    semantics: {
      graph: 'selected-parent genealogy; duplicate parent ids denote explicit self-crossover',
      operatorEffect: 'structural equality is exact tree equality, not behavioural equivalence',
      origin: 'clone is defined by net equality to parent A; non-clone labels list step-effective operator classes',
      causalScope: 'parent selection and operator traces do not establish inherited functional contribution',
    },
    validation,
    totalIndividuals: values.length,
    rootIndividuals: values.filter((record) => record.selectedParents.length === 0).length,
    initialIndividuals: values.filter((record) => record.bornAt === 0).length,
    offspringIndividuals: updateOffspring.length,
    birthRoleCounts: countBy(values, 'birthRole'),
    originCounts: countBy(values, 'origin'),
    initialCartDescendants: {
      count: initialDescendants.length,
      mutationAttemptCount: initialDescendants.reduce(
        (total, record) => total + record.mutationAttemptCount,
        0,
      ),
      mutationStructurallyEffectiveCount: initialDescendants.reduce(
        (total, record) => total + record.mutationStructurallyEffectiveCount,
        0,
      ),
      mutationDepthRejectionCount: initialDescendants.reduce(
        (total, record) => total + record.mutationDepthRejectionCount,
        0,
      ),
      netStructuralCloneCount: initialDescendants.filter(
        (record) => record.treeChangedFromParentA === false,
      ).length,
    },
    updateOffspring: {
      count: updateOffspring.length,
      noOperatorAttemptCount: updateOffspring.filter(
        (record) => !record.crossoverAttempted && record.mutationAttemptCount === 0,
      ).length,
      noStructurallyEffectiveOperatorCount: updateOffspring.filter(
        (record) => !record.crossoverStructurallyEffective
          && record.mutationStructurallyEffectiveCount === 0,
      ).length,
      crossoverAttemptedCount: updateOffspring.filter(
        (record) => record.crossoverAttempted,
      ).length,
      crossoverStructurallyEffectiveCount: updateOffspring.filter(
        (record) => record.crossoverStructurallyEffective,
      ).length,
      crossoverDepthRejectionCount: updateOffspring.filter(
        (record) => record.crossoverDepthRejected,
      ).length,
      selfCrossoverCount: updateOffspring.filter((record) => record.selfCrossover).length,
      mutationAttemptCount: updateOffspring.reduce(
        (total, record) => total + record.mutationAttemptCount,
        0,
      ),
      mutationStructurallyEffectiveCount: updateOffspring.reduce(
        (total, record) => total + record.mutationStructurallyEffectiveCount,
        0,
      ),
      mutationDepthRejectionCount: updateOffspring.reduce(
        (total, record) => total + record.mutationDepthRejectionCount,
        0,
      ),
      mutationOperationCounts: {
        attempted: countMutationOperations(updateOffspring),
        structurallyEffective: countMutationOperations(updateOffspring, {
          structurallyEffectiveOnly: true,
        }),
      },
      netStructuralCloneCount: updateOffspring.filter(
        (record) => record.treeChangedFromParentA === false,
      ).length,
      netCloneAfterStepEffectiveOperatorCount: updateOffspring.filter(
        (record) => record.treeChangedFromParentA === false
          && (record.crossoverStructurallyEffective
            || record.mutationStructurallyEffectiveCount > 0),
      ).length,
      parentSelection: {
        pool: 'pre-replacement-population',
        parentOutsideRetainedEdges,
        offspringWithParentOutsideRetainedSet: updateOffspring.filter(
          (record) => record.parentRetained.some((retained) => !retained),
        ).length,
      },
    },
    finalChampion: {
      id: finalChampion.id,
      bornAt: finalChampion.bornAt,
      origin: finalChampion.origin,
      selectedParents: [...finalChampion.selectedParents],
      selfCrossover: finalChampion.selfCrossover,
      treeSha256: finalChampion.treeSha256,
      selectedParentAncestorCountExclusive: ancestors.size,
      selectedParentAncestrySubgraphSizeIncludingChampion: ancestors.size + 1,
      maximumSelectedParentAncestryDepth: maximumAncestryDepth(map, finalChampionId),
      initialCartInSelectedParentAncestry: ancestors.has(initialCartId),
    },
  };
}

function csvBoolean(value) {
  if (value === null || value === undefined) return '';
  return value ? 1 : 0;
}

export function lineageRecordToCsvRow(record) {
  return {
    id: record.id,
    born_at: record.bornAt,
    birth_role: record.birthRole,
    origin: record.origin,
    selected_parents: record.selectedParents.join('|'),
    parent_pool: record.parentPool,
    parent_retained: record.parentRetained.map(csvBoolean).join('|'),
    distinct_selected_parent_count: record.distinctSelectedParentCount,
    crossover_attempted: csvBoolean(record.crossoverAttempted),
    crossover_structurally_effective: csvBoolean(record.crossoverStructurallyEffective),
    self_crossover: csvBoolean(record.selfCrossover),
    crossover_depth_rejected: csvBoolean(record.crossoverDepthRejected),
    mutation_attempt_count: record.mutationAttemptCount,
    mutation_structurally_effective_count: record.mutationStructurallyEffectiveCount,
    mutation_depth_rejection_count: record.mutationDepthRejectionCount,
    mutation_operations: record.mutationOperations.join('|'),
    mutation_structurally_effective_flags:
      record.mutationStructurallyEffectiveFlags.map(csvBoolean).join('|'),
    mutation_depth_rejected_flags: record.mutationDepthRejectedFlags.map(csvBoolean).join('|'),
    tree_changed_from_parent_a: csvBoolean(record.treeChangedFromParentA),
    tree_sha256: record.treeSha256,
  };
}

export class LineageRegistry {
  #records = new Map();

  get size() {
    return this.#records.size;
  }

  add(input) {
    const expectedId = this.#records.size + 1;
    if (input.id !== expectedId) {
      throw new Error(`lineage id ${input.id} is not the next contiguous id ${expectedId}`);
    }
    const record = createLineageRecord(input);
    for (const parent of input.parents ?? []) {
      const registered = this.#records.get(parent.id);
      if (!registered) {
        throw new Error(`lineage id ${record.id} references parent ${parent.id} before registration`);
      }
      if (registered.treeSha256 !== treeFingerprint(parent.tree)) {
        throw new Error(`lineage parent object ${parent.id} does not match its registered tree`);
      }
    }
    this.#records.set(record.id, record);
    return record;
  }

  get(id) {
    return this.#records.get(id);
  }

  values() {
    return this.#records.values();
  }

  asMap() {
    return new Map(this.#records);
  }

  validate() {
    return validateLineage(this.#records);
  }

  ancestorsExclusive(id) {
    return ancestorsExclusive(this.#records, id);
  }

  maximumAncestryDepth(id) {
    return maximumAncestryDepth(this.#records, id);
  }

  summary(options) {
    return summariseLineage(this.#records, options);
  }
}
