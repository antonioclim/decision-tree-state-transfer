import { createHash } from 'node:crypto';

export function floatBits(value) {
  if (!Number.isFinite(value)) throw new TypeError('finite predicate threshold required');
  const b = Buffer.allocUnsafe(8); b.writeDoubleBE(value); return b.toString('hex');
}
export function fromFloatBits(hex) {
  if (!/^[a-f0-9]{16}$/.test(hex)) throw new TypeError('invalid binary64 bits');
  const n = Buffer.from(hex, 'hex').readDoubleBE();
  if (!Number.isFinite(n)) throw new TypeError('non-finite predicate');
  return n;
}
export function nodeCount(n) { return n.type === 'leaf' ? 1 : 1 + nodeCount(n.left) + nodeCount(n.right); }
export function treeDepth(n) { return n.type === 'leaf' ? 0 : 1 + Math.max(treeDepth(n.left), treeDepth(n.right)); }
export function semanticTree(n) {
  return n.type === 'leaf' ? ['leaf', n.action]
    : ['split', n.feature, floatBits(n.threshold), semanticTree(n.left), semanticTree(n.right)];
}
export function treeHash(n) { return createHash('sha256').update(JSON.stringify(semanticTree(n))).digest('hex'); }
export function structurallyEqual(a, b, ledger = null) {
  ledger?.charge('selection_comparison');
  if (a.type !== b.type) return false;
  if (a.type === 'leaf') return a.action === b.action;
  return a.feature === b.feature && Object.is(a.threshold, b.threshold)
    && structurallyEqual(a.left, b.left, ledger) && structurallyEqual(a.right, b.right, ledger);
}

/** Provenance IDs are never used in fitness, random addresses or tie-breaking. */
export class TreeFactory {
  constructor({ ledger, prefix = 'p', update = 0, emit = null }) {
    if (!ledger || typeof prefix !== 'string' || !prefix) throw new TypeError('factory requires a ledger and prefix');
    this.ledger = ledger; this.prefix = prefix; this.update = update; this.serial = 0;
    this.emit = emit; this.eventCount = 0; this.provenanceNs = 0;
  }
  id(kind) { return `${this.prefix}:${kind}:${++this.serial}`; }
  record(event) {
    this.eventCount++;
    if (this.emit) { const start = process.hrtime.bigint(); this.emit(event); this.provenanceNs += Number(process.hrtime.bigint() - start); }
  }
  metadata(kind, source = null, witness = null) {
    const id = this.id('record');
    const token = source ? source._p.token : this.id('token');
    return { id, token, source: source?._p.id ?? null, birth_update: source?._p.birth_update ?? this.update,
      witness: witness ? { ...witness } : null, operation: kind };
  }
  edge(parent, child, slot, source = null) {
    if (source && (source.parent_token !== parent.token || source.child_token !== child._p.token || source.slot !== slot)) throw new Error('edge copy does not preserve its endpoints');
    const e = { id: this.id('edge'), token: source?.token ?? this.id('edge-token'), source: source?.id ?? null,
      parent_token: parent.token, child_token: child._p.token, slot };
    this.record({ kind: 'edge', ...e }); return e;
  }
  leaf(action, { source = null, operation = 'create', witness = null } = {}) {
    if (action !== 0 && action !== 1) throw new TypeError('binary leaf action required');
    if (source && (source.type !== 'leaf' || source.action !== action)) throw new Error('changed literal cannot inherit a token');
    this.ledger.charge('node_record_write');
    const p = this.metadata(operation, source, witness);
    const n = { type: 'leaf', action, _p: p };
    this.record({ kind: 'node', ...p, literal: ['leaf', action] }); return n;
  }
  split(feature, threshold, left, right, { source = null, leftEdge = null, rightEdge = null, witness = null, operation = 'create' } = {}) {
    if (!Number.isSafeInteger(feature) || feature < 0 || !Number.isFinite(threshold)) throw new TypeError('invalid split');
    if (source && (source.type !== 'split' || source.feature !== feature || !Object.is(source.threshold, threshold))) throw new Error('changed predicate cannot inherit a token');
    this.ledger.charge('node_record_write');
    const p = this.metadata(operation, source, witness);
    p.left_edge = this.edge(p, left, 'left', leftEdge);
    p.right_edge = this.edge(p, right, 'right', rightEdge);
    const n = { type: 'split', feature, threshold, left, right, _p: p };
    this.record({ kind: 'node', ...p, literal: ['split', feature, floatBits(threshold), '<'], left_record: left._p.id, right_record: right._p.id }); return n;
  }
  copy(n) {
    if (n.type === 'leaf') return this.leaf(n.action, { source: n, operation: 'copy', witness: n._p.witness });
    const left = this.copy(n.left); const right = this.copy(n.right);
    return this.split(n.feature, n.threshold, left, right, { source: n, leftEdge: n._p.left_edge,
      rightEdge: n._p.right_edge, witness: n._p.witness, operation: 'copy' });
  }
  rebuild(n, left, right, changedSlot = null, wholeUnchanged = false) {
    return this.split(n.feature, n.threshold, left, right, { source: n,
      leftEdge: changedSlot === 'left' || left._p.token !== n.left._p.token ? null : n._p.left_edge,
      rightEdge: changedSlot === 'right' || right._p.token !== n.right._p.token ? null : n._p.right_edge,
      witness: wholeUnchanged ? n._p.witness : null, operation: 'rebuild' });
  }
  realise(tree, individual) {
    const visit = (n) => {
      if (n.type === 'split') { visit(n.left); visit(n.right); }
      if (n._p.witness === null) {
        n._p.witness = { update: this.update, individual, root_record: n._p.id };
        this.record({ kind: 'realised-connected-subtree', record: n._p.id, witness: { ...n._p.witness } });
      }
    };
    visit(tree);
  }
}

export function predict(tree, x, ledger = null, online = null) {
  let n = tree;
  while (n.type !== 'leaf') {
    ledger?.charge('sample_predicate_test');
    if (ledger) ledger.nodeExampleVisits++;
    if (online) { online.predicate_tests++; online.node_visits = (online.node_visits ?? 0) + 1; }
    n = x[n.feature] < n.threshold ? n.left : n.right;
  }
  if (ledger) ledger.nodeExampleVisits++;
  if (online) online.node_visits = (online.node_visits ?? 0) + 1;
  return n.action;
}
export function collectPaths(n, path = [], out = []) {
  out.push(path);
  if (n.type === 'split') { collectPaths(n.left, [...path, 'left'], out); collectPaths(n.right, [...path, 'right'], out); }
  return out;
}
export function getSubtree(n, path) {
  for (const slot of path) {
    if (n.type !== 'split' || !['left', 'right'].includes(slot)) throw new TypeError('invalid tree path');
    n = n[slot];
  }
  return n;
}
export function replaceAt(n, path, replacement, factory) {
  if (path.length === 0) return factory.copy(replacement);
  const [slot, ...tail] = path;
  if (n.type !== 'split' || !['left', 'right'].includes(slot)) throw new TypeError('invalid replacement path');
  const left = slot === 'left' ? replaceAt(n.left, tail, replacement, factory) : factory.copy(n.left);
  const right = slot === 'right' ? replaceAt(n.right, tail, replacement, factory) : factory.copy(n.right);
  return factory.rebuild(n, left, right, slot);
}

export function simplify(n, factory, bounds = new Map()) {
  if (n.type === 'leaf') return { tree: factory.copy(n), changed: false };
  const [lo, hi] = bounds.get(n.feature) ?? [-Infinity, Infinity];
  factory.ledger.charge('selection_comparison', 2);
  if (n.threshold <= lo) return { tree: simplify(n.right, factory, bounds).tree, changed: true };
  if (n.threshold >= hi) return { tree: simplify(n.left, factory, bounds).tree, changed: true };
  const lb = new Map(bounds); lb.set(n.feature, [lo, Math.min(hi, n.threshold)]);
  const rb = new Map(bounds); rb.set(n.feature, [Math.max(lo, n.threshold), hi]);
  const left = simplify(n.left, factory, lb); const right = simplify(n.right, factory, rb);
  if (structurallyEqual(left.tree, right.tree, factory.ledger)) return { tree: left.tree, changed: true };
  return { tree: factory.rebuild(n, left.tree, right.tree, null, !left.changed && !right.changed), changed: left.changed || right.changed };
}

export function randomTree(thresholds, rng, factory, depth = 0, maxDepth = 4) {
  if (depth >= maxDepth || (depth > 0 && rng.uniform() < 0.30)) return factory.leaf(rng.integer(2));
  const feature = rng.integer(thresholds.length); const threshold = rng.choice(thresholds[feature]);
  const left = randomTree(thresholds, rng, factory, depth + 1, maxDepth);
  const right = randomTree(thresholds, rng, factory, depth + 1, maxDepth);
  return factory.split(feature, threshold, left, right);
}

export function candidateThresholds(rows, featureCount, count, ledger) {
  return Array.from({ length: featureCount }, (_, f) => {
    const sorted = rows.map((r) => r.x[f]).sort((a, b) => { ledger.charge('threshold_sort_comparison'); return a - b; });
    const values = sorted.filter((v, i) => { ledger.charge('threshold_sort_comparison'); return i === 0 || v !== sorted[i - 1]; });
    if (values.length < 2) return [values[0] ?? 0];
    const slots = Math.min(count, values.length - 1); const result = [];
    for (let k = 1; k <= slots; k++) {
      const i = Math.min(values.length - 2, Math.floor(k * (values.length - 1) / (slots + 1)));
      const midpoint = values[i] / 2 + values[i + 1] / 2;
      result.push(midpoint > values[i] && midpoint <= values[i + 1] ? midpoint : values[i + 1]);
    }
    return [...new Set(result)];
  });
}

function counts(rows, ledger) {
  let n0 = 0; let n1 = 0;
  for (const row of rows) { ledger.charge('label_count_update'); row.y === 0 ? n0++ : n1++; }
  return [n0, n1];
}
function gini(n0, n1) { const n = n0 + n1; return n === 0 ? 0 : 1 - (n0 / n) ** 2 - (n1 / n) ** 2; }
function midpoint(a, b) { const m = a / 2 + b / 2; return m > a && m <= b ? m : b; }

/** The unrestricted CART path matches the existing observed-midpoint implementation.
 * @param {Array<{x:number[], y:number, index?:number}>} rows
 * @param {TreeFactory} factory
 * @param {{featureCount?:number, maxDepth?:number, minLeaf?:number, minGain?:number,
 * tieAction?:number, maxNodes?:number, template?:any, thresholds?:number[][]}} options
 */
export function fitCart(rows, factory, { featureCount, maxDepth = 8, minLeaf = 10, minGain = 1e-12, tieAction = 1,
  maxNodes = 2 ** (maxDepth + 1) - 1, template = null, thresholds = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isInteger(featureCount) || featureCount < 1
    || !Number.isInteger(maxDepth) || maxDepth < 0 || !Number.isInteger(maxNodes) || maxNodes < 1
    || !Number.isInteger(minLeaf) || minLeaf < 1 || !Number.isFinite(minGain) || minGain < 0 || ![0, 1].includes(tieAction)) {
    throw new TypeError('invalid CART inputs');
  }
  for (const row of rows) {
    if (!Array.isArray(row.x) || row.x.length !== featureCount || !row.x.every(Number.isFinite) || ![0, 1].includes(row.y)) {
      throw new TypeError('CART requires finite fixed-width features and binary labels');
    }
  }
  const ledger = factory.ledger;
  function build(data, depth, allowance, shape) {
    ledger.boundary();
    const [total0, total1] = counts(data, ledger); const action = total0 === total1 ? tieAction : Number(total1 > total0);
    if (depth >= maxDepth || allowance < 3 || total0 === 0 || total1 === 0 || data.length < 2 * minLeaf
      || (template !== null && shape?.type !== 'split')) return factory.leaf(action);
    let best = null;
    const features = shape ? [shape.feature] : Array.from({ length: featureCount }, (_, f) => f);
    for (const feature of features) {
      if (shape) {
        // Bin each reaching row once against the sorted candidate thresholds.
        // Prefix sums recover the same strict-< class counts. Candidate evaluation
        // keeps its original order, including duplicates and nonascending fixtures.
        const cuts = thresholds[feature].map((threshold, index) => ({ threshold, index })).sort((a, b) => {
          ledger.charge('threshold_sort_comparison'); return a.threshold - b.threshold;
        });
        const bins0 = Array(cuts.length + 1).fill(0); const bins1 = Array(cuts.length + 1).fill(0);
        if (cuts.length > 0) for (const row of data) {
          let lo = 0; let hi = cuts.length;
          while (lo < hi) {
            const mid = lo + Math.floor((hi - lo) / 2);
            ledger.charge('sample_predicate_test');
            if (row.x[feature] < cuts[mid].threshold) hi = mid;
            else lo = mid + 1;
          }
          ledger.charge('label_count_update');
          if (row.y === 0) bins0[lo]++; else bins1[lo]++;
        }
        const leftCounts = []; let cumulative0 = 0; let cumulative1 = 0;
        for (let i = 0; i < cuts.length; i++) {
          ledger.charge('label_count_update', 2);
          cumulative0 += bins0[i]; cumulative1 += bins1[i];
          leftCounts[cuts[i].index] = [cumulative0, cumulative1];
        }
        for (let candidate = 0; candidate < thresholds[feature].length; candidate++) {
          const threshold = thresholds[feature][candidate];
          const [l0, l1] = leftCounts[candidate];
          const r0 = total0 - l0; const r1 = total1 - l1;
          if (l0 + l1 < minLeaf || r0 + r1 < minLeaf) continue;
          const impurity = (l0 + l1) / data.length * gini(l0, l1) + (r0 + r1) / data.length * gini(r0, r1);
          ledger.charge('selection_comparison');
          if (best === null || impurity < best.impurity) best = { feature, threshold, impurity };
        }
      } else {
        const sorted = data.map((r) => ({ value: r.x[feature], y: r.y })).sort((a, b) => {
          ledger.charge('threshold_sort_comparison'); return a.value - b.value;
        });
        let l0 = 0; let l1 = 0;
        for (let i = 0; i < sorted.length - 1; i++) {
          ledger.charge('label_count_update'); sorted[i].y === 0 ? l0++ : l1++;
          const nl = i + 1; const nr = data.length - nl;
          ledger.charge('threshold_sort_comparison');
          if (nl < minLeaf || nr < minLeaf || sorted[i].value === sorted[i + 1].value) continue;
          const impurity = nl / data.length * gini(l0, l1) + nr / data.length * gini(total0 - l0, total1 - l1);
          ledger.charge('selection_comparison');
          if (best === null || impurity < best.impurity) best = { feature, threshold: midpoint(sorted[i].value, sorted[i + 1].value), impurity };
        }
      }
    }
    ledger.charge('selection_comparison');
    if (best === null || gini(total0, total1) - best.impurity <= minGain) return factory.leaf(action);
    const leftRows = []; const rightRows = [];
    for (const row of data) { ledger.charge('sample_predicate_test'); (row.x[best.feature] < best.threshold ? leftRows : rightRows).push(row); }
    // Deterministic pre-order node allocation reserves one node for the right child.
    const left = build(leftRows, depth + 1, allowance - 2, shape?.left ?? null);
    const right = build(rightRows, depth + 1, allowance - 1 - nodeCount(left), shape?.right ?? null);
    return factory.split(best.feature, best.threshold, left, right);
  }
  return build(rows, 0, maxNodes, template);
}

export function mutate(tree, thresholds, rng, factory, maxDepth = 8) {
  const path = rng.choice(collectPaths(tree)); const n = getSubtree(tree, path);
  const op = rng.choice(n.type === 'leaf' ? ['flip', 'replace', 'replace'] : ['feature', 'threshold', 'threshold', 'replace', 'prune']);
  let replacement;
  if (op === 'flip') replacement = factory.leaf(1 - n.action, { operation: 'flip' });
  else if (op === 'prune') replacement = factory.leaf(rng.integer(2), { operation: 'prune' });
  else if (op === 'replace') replacement = randomTree(thresholds, rng, factory, 0, Math.min(3, Math.max(1, maxDepth - path.length)));
  else {
    let feature = n.feature; let threshold = n.threshold;
    if (op === 'feature') { feature = rng.integer(thresholds.length); threshold = rng.choice(thresholds[feature]); }
    else if (rng.uniform() < 0.8) {
      const values = thresholds[feature]; let index = 0; let best = Infinity;
      for (let i = 0; i < values.length; i++) {
        const distance = Math.abs(values[i] - threshold); factory.ledger.charge('selection_comparison');
        if (distance < best) { best = distance; index = i; }
      }
      const step = rng.choice([-4, -3, -2, -1, 1, 2, 3, 4]);
      threshold = values[Math.max(0, Math.min(values.length - 1, index + step))];
    } else threshold = rng.choice(thresholds[feature]);
    if (feature === n.feature && Object.is(threshold, n.threshold)) replacement = factory.copy(n);
    else replacement = factory.split(feature, threshold, factory.copy(n.left), factory.copy(n.right), { operation: op });
  }
  // A literal no-op transports the original connection, rather than inventing an edge change.
  const initial = replacement._p.token === n._p.token && structurallyEqual(replacement, n, factory.ledger)
    ? factory.copy(tree) : replaceAt(tree, path, replacement, factory);
  let child = simplify(initial, factory).tree;
  factory.ledger.charge('selection_comparison');
  const rejected = treeDepth(child) > maxDepth;
  if (rejected) { factory.ledger.rejectedOperators++; child = factory.copy(tree); }
  return { tree: child, operation: op, rejected, changed: !structurallyEqual(child, tree) };
}

export function crossover(a, b, rng, factory, maxDepth = 8) {
  const target = rng.choice(collectPaths(a)); const donor = rng.choice(collectPaths(b));
  let child = simplify(replaceAt(a, target, getSubtree(b, donor), factory), factory).tree;
  factory.ledger.charge('selection_comparison');
  const rejected = treeDepth(child) > maxDepth;
  if (rejected) { factory.ledger.rejectedOperators++; child = factory.copy(a); }
  return { tree: child, target, donor, rejected, changed: !structurallyEqual(child, a) };
}

export function exportTree(n) {
  return n.type === 'leaf' ? { type: 'leaf', action: n.action, _p: structuredClone(n._p) }
    : { type: 'split', feature: n.feature, threshold_bits: floatBits(n.threshold),
      left: exportTree(n.left), right: exportTree(n.right), _p: structuredClone(n._p) };
}
export function importTree(n) {
  if (n.type === 'leaf') return { type: 'leaf', action: n.action, _p: structuredClone(n._p) };
  return { type: 'split', feature: n.feature, threshold: fromFloatBits(n.threshold_bits),
    left: importTree(n.left), right: importTree(n.right), _p: structuredClone(n._p) };
}

export function validateTree(n, { featureCount = 8, maxDepth = 8, requireRealised = false } = {}) {
  const occurrenceIds = new Set();
  function visit(node, depth) {
    if (!node || !['leaf', 'split'].includes(node.type) || depth > maxDepth || !node._p || typeof node._p.id !== 'string'
      || typeof node._p.token !== 'string' || occurrenceIds.has(node._p.id)) throw new Error('invalid tree/provenance or aliased node');
    occurrenceIds.add(node._p.id);
    const witness = node._p.witness;
    if (requireRealised && (!witness || !Number.isSafeInteger(witness.update) || witness.update < 0
      || typeof witness.individual !== 'string' || typeof witness.root_record !== 'string')) throw new Error('unrealised subtree');
    if (node.type === 'leaf') { if (![0, 1].includes(node.action)) throw new Error('invalid action'); return; }
    if (!Number.isInteger(node.feature) || node.feature < 0 || node.feature >= featureCount || !Number.isFinite(node.threshold)) throw new Error('invalid predicate');
    for (const slot of ['left', 'right']) {
      const edge = node._p[`${slot}_edge`];
      if (!edge || edge.parent_token !== node._p.token || edge.child_token !== node[slot]?._p.token || edge.slot !== slot) throw new Error('invalid child-slot edge');
      visit(node[slot], depth + 1);
    }
  }
  visit(n, 0); return true;
}
