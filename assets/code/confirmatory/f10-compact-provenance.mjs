import { createHash } from 'node:crypto';
import { strictJson } from './evidence.mjs';
import { EvolutionLearner } from './learner.mjs';
import { floatBits } from './trees.mjs';

const digest = (x) => createHash('sha256').update(strictJson(x)).digest('hex');
const identifier = (x) => typeof x === 'string' && x.length > 0 && x.length <= 512;
const witness = (x) => x && Number.isSafeInteger(x.update) && x.update >= 0 && identifier(x.individual) && identifier(x.root_record);
const equal = (a, b) => strictJson(a) === strictJson(b);

function idPrefix(id) {
  if (!identifier(id)) throw new Error('invalid provenance identifier');
  const match = /^(.*):(record|edge|token|edge-token):(\d+)$/.exec(id);
  if (!match || !match[1] || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1) throw new Error('non-canonical TreeFactory identifier');
  return { prefix: match[1], kind: match[2], serial: Number(match[3]) };
}

/**
 * Strict online provenance verifier with bounded live storage.
 *
 * It validates the same node/edge/witness invariants consumed by material-v4 as
 * DiskProvenanceIndex. After each committed learner update `prune(snapshot)`
 * retains only records reachable from the deployed population plus immutable
 * witness roots needed to prove connected literal continuity. Scratch records
 * remain covered by a rolling SHA-256 event transcript but are not kept in the
 * live lookup map after they can no longer be an ancestor of future material.
 */
export class CompactProvenanceIndex {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.witnesses = new Map();
    this.events = 0;
    this.counts = { node_records: 0, edge_records: 0, realised_witnesses: 0 };
    this.liveMax = { nodes: 0, edges: 0, witnesses: 0 };
    this.closed = false;
    this.poisoned = false;
    this.transcript = createHash('sha256');
    this.activePrefix = null;
    this.closedPrefixes = new Set();
    this.activeIdentifiers = new Set();
  }

  getNode(id) { return this.nodes.get(id) ?? null; }
  getEdge(id) { return this.edges.get(id) ?? null; }
  getWitness(id) { return this.witnesses.get(id) ?? null; }

  _activate(id) {
    const parsed = idPrefix(id);
    if (this.activePrefix === null) this.activePrefix = parsed.prefix;
    if (parsed.prefix !== this.activePrefix) {
      this.closedPrefixes.add(this.activePrefix);
      if (this.closedPrefixes.has(parsed.prefix)) throw new Error('provenance factory prefix re-entered after closure');
      this.activePrefix = parsed.prefix;
      this.activeIdentifiers.clear();
    }
    return parsed;
  }

  _newIdentifier(id, allowedKind) {
    const parsed = this._activate(id);
    if (!allowedKind.includes(parsed.kind) || this.activeIdentifiers.has(id)) throw new Error('duplicate or wrong-kind provenance identifier');
    this.activeIdentifiers.add(id);
    return parsed;
  }

  _newToken(token, source) {
    if (source !== null) return;
    const parsed = idPrefix(token);
    if (parsed.prefix !== this.activePrefix || !['token', 'edge-token'].includes(parsed.kind) || this.activeIdentifiers.has(token)) {
      throw new Error('duplicate or non-local fresh provenance token');
    }
    this.activeIdentifiers.add(token);
  }

  append(e) {
    if (this.closed || this.poisoned) throw new Error('index is closed or poisoned');
    try {
      strictJson(e);
      this.add(e);
      this.transcript.update(strictJson(e));
      this.transcript.update('\n');
      this.events += 1;
      this.liveMax.nodes = Math.max(this.liveMax.nodes, this.nodes.size);
      this.liveMax.edges = Math.max(this.liveMax.edges, this.edges.size);
      this.liveMax.witnesses = Math.max(this.liveMax.witnesses, this.witnesses.size);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  add(e) {
    if (e.kind === 'realised-connected-subtree') {
      if (!identifier(e.record) || !witness(e.witness) || e.witness.root_record !== e.record || !this.getNode(e.record) || this.witnesses.has(e.record)) {
        throw new Error('invalid realised witness');
      }
      this.witnesses.set(e.record, structuredClone(e.witness));
      this.counts.realised_witnesses += 1;
      return;
    }
    if (!['node', 'edge'].includes(e.kind) || !identifier(e.id) || !identifier(e.token) || (e.source !== null && !identifier(e.source))) {
      throw new Error('invalid provenance identity');
    }
    this._newIdentifier(e.id, e.kind === 'node' ? ['record'] : ['edge']);
    this._newToken(e.token, e.source);

    if (e.kind === 'edge') {
      if (!identifier(e.parent_token) || !identifier(e.child_token) || !['left', 'right'].includes(e.slot)) throw new Error('invalid edge endpoints');
      if (e.source !== null) {
        const old = this.getEdge(e.source);
        if (!old || ['token', 'parent_token', 'child_token', 'slot'].some((k) => old[k] !== e[k])) throw new Error('invalid edge copy');
      }
      if (this.edges.has(e.id)) throw new Error('duplicate edge record');
      this.edges.set(e.id, structuredClone(e));
      this.counts.edge_records += 1;
      return;
    }

    if (!Number.isSafeInteger(e.birth_update) || e.birth_update < 0 || !identifier(e.operation) || !Array.isArray(e.literal)
      || !['leaf', 'split'].includes(e.literal[0]) || (e.witness !== null && !witness(e.witness))) throw new Error('invalid node metadata');
    let material;
    if (e.literal[0] === 'leaf') {
      if (e.literal.length !== 2 || ![0, 1].includes(e.literal[1])) throw new Error('invalid leaf literal');
      material = digest(['leaf', e.token]);
    } else {
      if (e.literal.length !== 4 || !Number.isSafeInteger(e.literal[1]) || e.literal[1] < 0 || e.literal[3] !== '<'
        || !/^[a-f0-9]{16}$/.test(e.literal[2]) || !Number.isFinite(Buffer.from(e.literal[2], 'hex').readDoubleBE())) throw new Error('invalid split literal');
      const child = [];
      for (const slot of ['left', 'right']) {
        const embed = e[`${slot}_edge`];
        const edge = embed && this.getEdge(embed.id);
        const node = this.getNode(e[`${slot}_record`]);
        if (!edge || !node || edge.parent_token !== e.token || edge.child_token !== node.payload.token || edge.slot !== slot
          || ['id', 'token', 'source', 'parent_token', 'child_token', 'slot'].some((k) => edge[k] !== embed[k])) throw new Error('invalid canonical adjacency');
        child.push(edge.token, node.material);
      }
      material = digest(['split', e.token, ...child]);
    }
    if (e.source !== null) {
      const old = this.getNode(e.source);
      if (!old || old.payload.token !== e.token || old.payload.birth_update !== e.birth_update || !equal(old.payload.literal, e.literal)) {
        throw new Error('invalid literal copy');
      }
    } else if (e.witness !== null) throw new Error('new node cannot claim an inherited witness');
    if (e.witness !== null) {
      const oldWitness = this.getWitness(e.witness.root_record);
      const old = this.getNode(e.witness.root_record);
      if (!oldWitness || !old || !equal(oldWitness, e.witness) || old.material !== material) throw new Error('forged connected witness');
    }
    if (this.nodes.has(e.id)) throw new Error('duplicate node record');
    this.nodes.set(e.id, { payload: structuredClone(e), material });
    this.counts.node_records += 1;
  }

  verifySnapshot(snapshot) {
    if (this.closed || this.poisoned) throw new Error('unusable provenance index');
    const learner = EvolutionLearner.restore(snapshot);
    let nodes = 0;
    const visit = (tree, depth = 0) => {
      if (depth > learner.config.maxTreeDepth) throw new Error('snapshot depth violation');
      const record = this.getNode(tree._p.id);
      if (!record) throw new Error('snapshot references absent node');
      const e = record.payload;
      for (const key of ['id', 'token', 'source', 'birth_update', 'operation']) if (tree._p[key] !== e[key]) throw new Error('snapshot metadata differs from recorded origin');
      const expectedWitness = this.getWitness(e.id) ?? e.witness;
      if (!equal(tree._p.witness, expectedWitness)) throw new Error('snapshot witness differs from trace');
      const literal = tree.type === 'leaf' ? ['leaf', tree.action] : ['split', tree.feature, floatBits(tree.threshold), '<'];
      if (!equal(e.literal, literal)) throw new Error('snapshot literal differs from trace');
      if (tree.type === 'split') for (const slot of ['left', 'right']) {
        const edge = this.getEdge(tree._p[`${slot}_edge`].id);
        if (!edge || tree[slot]._p.id !== e[`${slot}_record`] || !equal(tree._p[`${slot}_edge`], e[`${slot}_edge`])) {
          throw new Error('snapshot topology differs from trace');
        }
        visit(tree[slot], depth + 1);
      }
      nodes += 1;
    };
    for (const item of learner.population) visit(item.tree);
    return { snapshot_sha256: digest(snapshot), population_size: learner.population.length, checked_node_occurrences: nodes, scientific_admission: false };
  }

  prune(snapshot) {
    const verified = this.verifySnapshot(snapshot);
    const learner = EvolutionLearner.restore(snapshot);
    const keepNodes = new Set();
    const keepEdges = new Set();
    const keepWitnesses = new Set();
    const visit = (tree) => {
      keepNodes.add(tree._p.id);
      const record = this.getNode(tree._p.id);
      const w = this.getWitness(record.payload.id) ?? record.payload.witness;
      if (w) {
        keepNodes.add(w.root_record);
        keepWitnesses.add(w.root_record);
      }
      if (tree.type === 'split') {
        keepEdges.add(tree._p.left_edge.id);
        keepEdges.add(tree._p.right_edge.id);
        visit(tree.left);
        visit(tree.right);
      }
    };
    for (const item of learner.population) visit(item.tree);
    for (const id of [...this.nodes.keys()]) if (!keepNodes.has(id)) this.nodes.delete(id);
    for (const id of [...this.edges.keys()]) if (!keepEdges.has(id)) this.edges.delete(id);
    for (const id of [...this.witnesses.keys()]) if (!keepWitnesses.has(id)) this.witnesses.delete(id);
    return { ...verified, retained_nodes: this.nodes.size, retained_edges: this.edges.size, retained_witnesses: this.witnesses.size };
  }

  finish(snapshot = null) {
    if (this.closed || this.poisoned) throw new Error('invalid compact index closure');
    const finalVerification = snapshot === null ? null : this.prune(snapshot);
    const result = {
      ...this.counts,
      events: this.events,
      transcript_sha256: this.transcript.digest('hex'),
      live_records_at_close: { nodes: this.nodes.size, edges: this.edges.size, witnesses: this.witnesses.size },
      maximum_live_records: { ...this.liveMax },
      closed_factory_prefixes: this.closedPrefixes.size,
      final_verification: finalVerification,
      storage: 'BOUNDED_IN_MEMORY_COMMITTED_TRACE_PLUS_TRANSCRIPT_DIGEST',
      scientific_admission: false
    };
    this.closed = true;
    this.nodes.clear();
    this.edges.clear();
    this.witnesses.clear();
    this.activeIdentifiers.clear();
    return result;
  }
}
