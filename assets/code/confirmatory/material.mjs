import { roleRandom } from './random.mjs';
import { WorkLedger } from './work.mjs';
import { TreeFactory, collectPaths, fitCart, getSubtree, nodeCount, predict, replaceAt, treeDepth } from './trees.mjs';

export function reachingRows(tree, path, rows) {
  return rows.filter((r) => {
    let node = tree;
    for (const slot of path) {
      if (node.type !== 'split') throw new Error('invalid subtree site');
      const actual = r.x[node.feature] < node.threshold ? 'left' : 'right';
      if (actual !== slot) return false;
      node = node[slot];
    }
    return true;
  });
}

export function eligibleSites(tree, rows, completedUpdates, { minimumAge = 5, minimumNodes = 3, maximumNodes = 31, minimumRows = 20 } = {}) {
  const eligible = [];
  // Pre-order plus ancestor filtering implements maximal eligible sites exactly.
  for (const path of collectPaths(tree).slice(1)) {
    if (eligible.some((site) => site.path.every((slot, i) => path[i] === slot))) continue;
    const n = getSubtree(tree, path); const count = nodeCount(n);
    const witness = n._p.witness;
    if (witness === null || completedUpdates - witness.update < minimumAge || count < minimumNodes || count > maximumNodes) continue;
    const reaching = reachingRows(tree, path, rows);
    if (reaching.length < minimumRows) continue;
    eligible.push({ path, rows: reaching, nodes: count, depth: treeDepth(n), age: completedUpdates - witness.update,
      witness: { ...witness } });
  }
  return eligible;
}

export function frozenShadows(learner, rows, checkpoint, { prefix = 'shadow', emit = null, eligibility = {} } = {}) {
  const tree = learner.champion?.tree;
  if (tree === undefined) return { parent_unavailable: true, eligible_count: 0, refit: null, sham: null, cost: null };
  const sites = eligibleSites(tree, rows, learner.completedUpdates, eligibility);
  const ledger = new WorkLedger();
  const factory = new TreeFactory({ ledger, prefix, update: learner.completedUpdates, emit });
  if (sites.length === 0) {
    return { parent_unavailable: false, eligible_count: 0, selected: null, refit: factory.copy(tree), sham: factory.copy(tree),
      cost: ledger.report(), mode: 'FROZEN_SHADOW', fallback: 'NO_ELIGIBLE_SITE' };
  }
  const rng = roleRandom(learner.key, 'subtree_selection', checkpoint, ledger);
  const selected = rng.choice(sites);
  const replacement = fitCart(selected.rows, factory, { featureCount: learner.config.featureCount,
    maxDepth: selected.depth, maxNodes: selected.nodes, minLeaf: learner.config.cartMinLeaf,
    minGain: learner.config.cartMinGain, tieAction: 0 });
  const refit = replaceAt(tree, selected.path, replacement, factory);
  // Copying the complete unchanged tree preserves every original edge token,
  // including the selected site's incoming attachment; a generic replacement does not.
  const sham = factory.copy(tree);
  return { parent_unavailable: false, eligible_count: sites.length,
    selected: { ...selected, rows: undefined, reaching_rows: selected.rows.length }, refit, sham,
    replacement_nodes: nodeCount(replacement), replacement_depth: treeDepth(replacement),
    cost: ledger.report(), mode: 'FROZEN_SHADOW', fallback: replacement.type === 'leaf' ? 'MAJORITY_OR_PURE_LEAF' : null };
}

export function shadowPredictions(shadows, x) {
  if (shadows.parent_unavailable) return { SUBTREE_REFIT: null, STRUCTURAL_SHAM: null };
  return { SUBTREE_REFIT: predict(shadows.refit, x), STRUCTURAL_SHAM: predict(shadows.sham, x) };
}
