import { createHash } from 'node:crypto';
import { strictJson } from './evidence.mjs';
import { EvolutionLearner } from './learner.mjs';
import { floatBits } from './trees.mjs';

const digest = (x) => createHash('sha256').update(strictJson(x)).digest('hex');
const tagged = (x) => `sha256:${digest(x)}`;
const equal = (a, b) => strictJson(a) === strictJson(b);
const validId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 512;
const validDigest = (x) => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
const validWitness = (x) => x && Number.isSafeInteger(x.update) && x.update >= 0
  && validId(x.individual) && validId(x.root_record);

function prefixOf(id) {
  if (!validId(id)) throw new Error('invalid provenance identifier');
  const m = /^(.*):(record|edge|token|edge-token):(\d+)$/.exec(id);
  if (!m || !m[1] || !Number.isSafeInteger(Number(m[3])) || Number(m[3]) < 1) {
    throw new Error('non-canonical TreeFactory identifier');
  }
  return m[1];
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function edgeSemantics(edge) {
  return [edge.token, edge.parent_token, edge.child_token, edge.slot];
}

/**
 * Verify deployed provenance while discarding unreachable scratch records.
 *
 * Version 2 closes the historical dangling-edge defect by replacing discarded
 * edge-copy prefixes with immutable proof-carrying path-compression
 * certificates.  A certificate binds the direct source identifier, invariant
 * edge semantics, terminal fresh edge, chain length and a recursive SHA-256
 * commitment.  The live storage cost is one fixed-schema certificate per live
 * edge; it does not retain the discarded source records.
 *
 * This backend remains scientifically non-admitted for Study 1.  It is an I03
 * qualification target and must agree with DiskProvenanceIndex and the compact
 * backend before it can be exposed for future non-confirmatory use.
 */
export class DeployedProvenanceIndex {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map(); // id -> frozen { payload, certificate }
    this.witnesses = new Map();
    this.currentNodes = new Map();
    this.currentEdges = new Map();
    this.pendingEdges = new Map();
    this.currentWitnesses = new Map();
    this.currentFreshTokens = new Set();
    this.activePrefix = null;
    this.closedPrefixes = new Set();
    this.events = 0;
    this.counts = { node_records: 0, edge_records: 0, realised_witnesses: 0 };
    this.maximumStaged = { nodes: 0, edges: 0, witnesses: 0 };
    this.maximumRetained = { nodes: 0, edges: 0, witnesses: 0, edge_certificates: 0 };
    this.maximumCertificateBytes = 0;
    this.maximumCompressedChainLength = 0;
    this.closed = false;
    this.poisoned = false;
  }

  getNode(id) { return this.nodes.get(id) ?? null; }
  getEdge(id) { return this.edges.get(id)?.payload ?? null; }
  getEdgeCertificate(id) {
    const certificate = this.edges.get(id)?.certificate ?? null;
    return certificate === null ? null : structuredClone(certificate);
  }
  getWitness(id) { return this.witnesses.get(id) ?? null; }

  _activate(id) {
    const prefix = prefixOf(id);
    if (this.activePrefix === null) this.activePrefix = prefix;
    if (prefix !== this.activePrefix) {
      if (this.currentNodes.size || this.currentEdges.size || this.pendingEdges.size || this.currentWitnesses.size) {
        throw new Error('new provenance factory began before deployed-state commit');
      }
      this.closedPrefixes.add(this.activePrefix);
      if (this.closedPrefixes.has(prefix)) throw new Error('provenance factory prefix re-entered after closure');
      this.activePrefix = prefix;
      this.currentFreshTokens.clear();
    }
    return prefix;
  }

  _validateEdgeShape(edge) {
    if (!edge || !validId(edge.id) || !validId(edge.token) || !validId(edge.parent_token)
      || !validId(edge.child_token) || !['left', 'right'].includes(edge.slot)
      || (edge.source !== null && !validId(edge.source))) {
      throw new Error('malformed deployed edge');
    }
  }

  append(e) {
    if (this.closed || this.poisoned) throw new Error('index is closed or poisoned');
    try {
      if (!e || typeof e !== 'object' || typeof e.kind !== 'string') throw new Error('invalid provenance event');
      strictJson(e);
      this.events += 1;
      if (e.kind === 'edge') {
        this._activate(e.id);
        this._validateEdgeShape(e);
        if (this.pendingEdges.has(e.id) || this.currentEdges.has(e.id) || this.edges.has(e.id)) {
          throw new Error('duplicate edge record');
        }
        this.pendingEdges.set(e.id, structuredClone(e));
        this.counts.edge_records += 1;
        return;
      }
      if (e.kind === 'node') {
        const prefix = this._activate(e.id);
        if (this.currentNodes.has(e.id) || this.nodes.has(e.id) || !validId(e.token)) {
          throw new Error('duplicate or invalid node record');
        }
        if (e.source === null) {
          if (prefixOf(e.token) !== prefix || this.currentFreshTokens.has(e.token)) {
            throw new Error('invalid fresh node token');
          }
          this.currentFreshTokens.add(e.token);
        }
        if (e.literal?.[0] === 'split') {
          for (const slot of ['left', 'right']) {
            const edge = e[`${slot}_edge`];
            this._validateEdgeShape(edge);
            const emitted = this.pendingEdges.get(edge.id);
            if (!emitted || !equal(emitted, { kind: 'edge', ...edge })) {
              throw new Error('embedded edge differs from emitted edge record');
            }
            this.pendingEdges.delete(edge.id);
            if (this.currentEdges.has(edge.id) || this.edges.has(edge.id)) throw new Error('duplicate embedded edge record');
            if (edge.source === null) {
              if (prefixOf(edge.token) !== prefix || this.currentFreshTokens.has(edge.token)) {
                throw new Error('invalid fresh edge token');
              }
              this.currentFreshTokens.add(edge.token);
            }
            this.currentEdges.set(edge.id, structuredClone(edge));
          }
        }
        this.currentNodes.set(e.id, structuredClone(e));
        this.counts.node_records += 1;
      } else if (e.kind === 'realised-connected-subtree') {
        this._activate(e.record);
        if (!validWitness(e.witness) || e.witness.root_record !== e.record
          || this.currentWitnesses.has(e.record) || this.witnesses.has(e.record)) {
          throw new Error('invalid realised witness');
        }
        this.currentWitnesses.set(e.record, structuredClone(e.witness));
        this.counts.realised_witnesses += 1;
      } else {
        throw new Error(`unsupported provenance event kind: ${e.kind}`);
      }
      this.maximumStaged.nodes = Math.max(this.maximumStaged.nodes, this.currentNodes.size);
      this.maximumStaged.edges = Math.max(this.maximumStaged.edges, this.currentEdges.size);
      this.maximumStaged.witnesses = Math.max(this.maximumStaged.witnesses, this.currentWitnesses.size);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  _lookupNode(id) { return this.currentNodes.get(id) ?? this.nodes.get(id)?.payload ?? null; }
  _lookupEdgeEntry(id) {
    if (this.currentEdges.has(id)) return { payload: this.currentEdges.get(id), certificate: null, staged: true };
    const persisted = this.edges.get(id);
    return persisted ? { ...persisted, staged: false } : null;
  }
  _lookupEdge(id) { return this._lookupEdgeEntry(id)?.payload ?? null; }
  _lookupWitness(id) { return this.currentWitnesses.get(id) ?? this.witnesses.get(id) ?? null; }

  _certificateBody(edge, sourceCertificate) {
    const semanticsSha256 = tagged(['DT-DEPLOYED-EDGE-SEMANTICS-v1', ...edgeSemantics(edge)]);
    if (edge.source === null) {
      return {
        schema_version: 1,
        proof_type: 'EDGE_COPY_CHAIN_COMPRESSION',
        subject_id: edge.id,
        direct_source_id: null,
        semantics_sha256: semanticsSha256,
        chain_length: 0,
        terminal_fresh_edge_id: edge.id,
        chain_commitment: tagged(['DT-DEPLOYED-EDGE-CHAIN-ROOT-v1', edge.id, semanticsSha256])
      };
    }
    if (!sourceCertificate) throw new Error('edge source certificate absent');
    return {
      schema_version: 1,
      proof_type: 'EDGE_COPY_CHAIN_COMPRESSION',
      subject_id: edge.id,
      direct_source_id: edge.source,
      semantics_sha256: semanticsSha256,
      chain_length: sourceCertificate.chain_length + 1,
      terminal_fresh_edge_id: sourceCertificate.terminal_fresh_edge_id,
      chain_commitment: tagged([
        'DT-DEPLOYED-EDGE-CHAIN-LINK-v1', edge.id, edge.source, semanticsSha256,
        sourceCertificate.chain_commitment
      ])
    };
  }

  _sealCertificate(body) {
    const certificate = { ...body, certificate_digest: tagged(['DT-DEPLOYED-EDGE-CERTIFICATE-v1', body]) };
    return deepFreeze(certificate);
  }

  _validateStoredCertificate(edge, certificate) {
    if (!certificate || certificate.schema_version !== 1
      || certificate.proof_type !== 'EDGE_COPY_CHAIN_COMPRESSION'
      || certificate.subject_id !== edge.id || certificate.direct_source_id !== edge.source
      || !validDigest(certificate.semantics_sha256) || !validDigest(certificate.chain_commitment)
      || !validDigest(certificate.certificate_digest)
      || !Number.isSafeInteger(certificate.chain_length) || certificate.chain_length < 0
      || !validId(certificate.terminal_fresh_edge_id)) {
      throw new Error('malformed edge-chain certificate');
    }
    const semanticsSha256 = tagged(['DT-DEPLOYED-EDGE-SEMANTICS-v1', ...edgeSemantics(edge)]);
    if (certificate.semantics_sha256 !== semanticsSha256
      || certificate.chain_length !== (edge.source === null ? 0 : Math.max(1, certificate.chain_length))) {
      throw new Error('edge-chain certificate does not bind subject semantics');
    }
    const { certificate_digest: observed, ...body } = certificate;
    if (observed !== tagged(['DT-DEPLOYED-EDGE-CERTIFICATE-v1', body])) {
      throw new Error('edge-chain certificate seal mismatch');
    }
    if (edge.source === null) {
      const expected = this._sealCertificate(this._certificateBody(edge, null));
      if (!equal(expected, certificate)) throw new Error('fresh-edge certificate mismatch');
    } else if (certificate.chain_length < 1) {
      throw new Error('copied edge has zero-length source proof');
    }
    return true;
  }

  _edgeCertificate(edge, stack = new Set()) {
    this._validateEdgeShape(edge);
    if (stack.has(edge.id)) throw new Error('cyclic edge copy chain');
    if (edge.source === null) return this._sealCertificate(this._certificateBody(edge, null));

    const sourceEntry = this._lookupEdgeEntry(edge.source);
    if (!sourceEntry) {
      const stored = this.edges.get(edge.id)?.certificate ?? null;
      if (!stored) throw new Error('deployed edge source absent and no compression certificate exists');
      this._validateStoredCertificate(edge, stored);
      return stored;
    }
    const source = sourceEntry.payload;
    for (const key of ['token', 'parent_token', 'child_token', 'slot']) {
      if (source[key] !== edge[key]) throw new Error('deployed edge copy changed semantics');
    }
    const next = new Set(stack);
    next.add(edge.id);
    let sourceCertificate;
    if (sourceEntry.staged) {
      sourceCertificate = this._edgeCertificate(source, next);
    } else {
      this._validateStoredCertificate(source, sourceEntry.certificate);
      sourceCertificate = sourceEntry.certificate;
    }
    return this._sealCertificate(this._certificateBody(edge, sourceCertificate));
  }

  _validateEdge(edge) {
    this._edgeCertificate(edge);
    return true;
  }

  _material(id, memo = new Map(), stack = new Set()) {
    if (memo.has(id)) return memo.get(id);
    const persisted = this.nodes.get(id);
    if (persisted && !this.currentNodes.has(id)) {
      memo.set(id, persisted.material);
      return persisted.material;
    }
    if (stack.has(id)) throw new Error('cyclic node topology');
    const e = this._lookupNode(id);
    if (!e || !validId(e.id) || !validId(e.token) || !Array.isArray(e.literal)) {
      throw new Error('deployed node record absent or malformed');
    }
    const next = new Set(stack);
    next.add(id);
    let material;
    if (e.literal[0] === 'leaf') {
      if (e.literal.length !== 2 || ![0, 1].includes(e.literal[1])) throw new Error('invalid leaf literal');
      material = digest(['leaf', e.token]);
    } else {
      if (e.literal[0] !== 'split' || e.literal.length !== 4
        || !Number.isSafeInteger(e.literal[1]) || e.literal[1] < 0
        || !/^[a-f0-9]{16}$/.test(e.literal[2]) || e.literal[3] !== '<'
        || !Number.isFinite(Buffer.from(e.literal[2], 'hex').readDoubleBE())) {
        throw new Error('invalid split literal');
      }
      const parts = [];
      for (const slot of ['left', 'right']) {
        const edge = e[`${slot}_edge`];
        const childId = e[`${slot}_record`];
        const child = this._lookupNode(childId);
        if (!edge || !child || edge.id !== this._lookupEdge(edge.id)?.id
          || edge.parent_token !== e.token || edge.child_token !== child.token || edge.slot !== slot) {
          throw new Error('invalid deployed adjacency');
        }
        this._validateEdge(edge);
        parts.push(edge.token, this._material(childId, memo, next));
      }
      material = digest(['split', e.token, ...parts]);
    }
    if (e.source !== null) {
      const source = this._lookupNode(e.source);
      if (!source || source.token !== e.token || source.birth_update !== e.birth_update || !equal(source.literal, e.literal)) {
        throw new Error('deployed node copy changed literal identity');
      }
      if (this.currentNodes.has(e.source)) {
        const sourceStack = new Set(stack);
        sourceStack.add(id);
        if (sourceStack.has(e.source)) throw new Error('cyclic node copy chain');
        this._material(e.source, memo, sourceStack);
      }
    } else if (e.witness !== null) {
      throw new Error('fresh node claimed inherited witness');
    }
    memo.set(id, material);
    return material;
  }

  _verifyTree(tree, learner, retained, memo, depth = 0) {
    if (depth > learner.config.maxTreeDepth) throw new Error('snapshot depth violation');
    const e = this._lookupNode(tree._p.id);
    if (!e) throw new Error('snapshot references absent node');
    for (const key of ['id', 'token', 'source', 'birth_update', 'operation']) {
      if (tree._p[key] !== e[key]) throw new Error('snapshot metadata differs from provenance event');
    }
    const literal = tree.type === 'leaf'
      ? ['leaf', tree.action]
      : ['split', tree.feature, floatBits(tree.threshold), '<'];
    if (!equal(literal, e.literal)) throw new Error('snapshot literal differs from provenance event');
    const material = this._material(e.id, memo);
    const expectedWitness = this._lookupWitness(e.id) ?? e.witness;
    if (!equal(tree._p.witness, expectedWitness)) throw new Error('snapshot witness differs from realised trace');
    if (tree._p.witness !== null) {
      const w = tree._p.witness;
      const rootEvent = this._lookupNode(w.root_record);
      const rootWitness = this._lookupWitness(w.root_record);
      if (!validWitness(w) || !rootEvent || !rootWitness || !equal(rootWitness, w)
        || this._material(w.root_record, memo) !== material) {
        throw new Error('connected witness does not prove identical deployed material');
      }
      retained.witnessRoots.add(w.root_record);
    }
    retained.nodes.add(e.id);
    if (tree.type === 'split') {
      for (const slot of ['left', 'right']) {
        const edge = tree._p[`${slot}_edge`];
        if (!equal(edge, e[`${slot}_edge`]) || tree[slot]._p.id !== e[`${slot}_record`]) {
          throw new Error('snapshot topology differs from provenance event');
        }
        this._validateEdge(edge);
        retained.edges.add(edge.id);
        this._verifyTree(tree[slot], learner, retained, memo, depth + 1);
      }
    }
    return material;
  }

  verifySnapshot(snapshot) {
    if (this.closed || this.poisoned) throw new Error('unusable deployed provenance index');
    if (this.pendingEdges.size) throw new Error('unconsumed emitted edge records remain staged');
    const learner = EvolutionLearner.restore(snapshot);
    const retained = { nodes: new Set(), edges: new Set(), witnessRoots: new Set() };
    const memo = new Map();
    let checked = 0;
    for (const item of learner.population) {
      const before = retained.nodes.size;
      this._verifyTree(item.tree, learner, retained, memo);
      checked += retained.nodes.size - before;
    }
    return {
      snapshot_sha256: digest(snapshot),
      population_size: learner.population.length,
      checked_node_occurrences: checked,
      scientific_admission: false,
      _retained: retained,
      _memo: memo
    };
  }

  prune(snapshot) {
    const verified = this.verifySnapshot(snapshot);
    const { _retained: retained, _memo: memo } = verified;
    const nextNodes = new Map();
    const nextEdges = new Map();
    const nextWitnesses = new Map();
    for (const id of retained.nodes) {
      const e = this._lookupNode(id);
      nextNodes.set(id, { payload: structuredClone(e), material: this._material(id, memo) });
      const w = this._lookupWitness(id);
      if (w) nextWitnesses.set(id, structuredClone(w));
    }
    for (const id of retained.edges) {
      const e = this._lookupEdge(id);
      const certificate = this._edgeCertificate(e);
      const entry = deepFreeze({ payload: structuredClone(e), certificate });
      nextEdges.set(id, entry);
      const bytes = Buffer.byteLength(strictJson(certificate));
      this.maximumCertificateBytes = Math.max(this.maximumCertificateBytes, bytes);
      this.maximumCompressedChainLength = Math.max(this.maximumCompressedChainLength, certificate.chain_length);
    }
    for (const id of retained.witnessRoots) {
      const e = this._lookupNode(id);
      const w = this._lookupWitness(id);
      if (!e || !w) throw new Error('witness root disappeared before commit');
      nextNodes.set(id, { payload: structuredClone(e), material: this._material(id, memo) });
      nextWitnesses.set(id, structuredClone(w));
    }
    this.nodes = nextNodes;
    this.edges = nextEdges;
    this.witnesses = nextWitnesses;
    this.maximumRetained.nodes = Math.max(this.maximumRetained.nodes, this.nodes.size);
    this.maximumRetained.edges = Math.max(this.maximumRetained.edges, this.edges.size);
    this.maximumRetained.witnesses = Math.max(this.maximumRetained.witnesses, this.witnesses.size);
    this.maximumRetained.edge_certificates = Math.max(this.maximumRetained.edge_certificates, this.edges.size);
    this.currentNodes.clear();
    this.currentEdges.clear();
    this.pendingEdges.clear();
    this.currentWitnesses.clear();
    this.currentFreshTokens.clear();
    const { _retained, _memo, ...publicVerified } = verified;
    return {
      ...publicVerified,
      retained_nodes: this.nodes.size,
      retained_edges: this.edges.size,
      retained_witnesses: this.witnesses.size,
      retained_edge_certificates: this.edges.size,
      maximum_edge_certificate_bytes: this.maximumCertificateBytes,
      maximum_compressed_chain_length: this.maximumCompressedChainLength
    };
  }

  finish(snapshot = null) {
    if (this.closed || this.poisoned) throw new Error('invalid deployed provenance closure');
    const finalVerification = snapshot === null ? null : this.prune(snapshot);
    const result = {
      ...this.counts,
      events_observed: this.events,
      maximum_staged_records: { ...this.maximumStaged },
      maximum_retained_records: { ...this.maximumRetained },
      live_records_at_close: {
        nodes: this.nodes.size,
        edges: this.edges.size,
        witnesses: this.witnesses.size,
        edge_certificates: this.edges.size
      },
      maximum_edge_certificate_bytes: this.maximumCertificateBytes,
      maximum_compressed_chain_length: this.maximumCompressedChainLength,
      closed_factory_prefixes: this.closedPrefixes.size,
      final_verification: finalVerification,
      storage: 'DEPLOYED_RECORDS_WITH_PROOF_CARRYING_EDGE_PATH_COMPRESSION',
      discarded_scratch_policy: 'discarded source records are replaced by immutable constant-schema edge-chain certificates generated only after live-chain validation',
      scientific_admission: false
    };
    this.closed = true;
    this.nodes.clear();
    this.edges.clear();
    this.witnesses.clear();
    this.currentNodes.clear();
    this.currentEdges.clear();
    this.pendingEdges.clear();
    this.currentWitnesses.clear();
    return result;
  }
}
