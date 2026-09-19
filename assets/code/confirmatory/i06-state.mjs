/**
 * I06 nested-transfer state interventions.
 *
 * This module is outcome-blind. It may inspect only a verified checkpoint
 * snapshot and its revealed 500-row window. It implements the locked
 * DT-I05-NST-v1.0 policies and does not materialise EXT stream values.
 */
import { createHash } from 'node:crypto';
import { EvolutionLearner } from './learner.mjs';
import { PrequentialSession } from './session.mjs';
import { keyFromAddress } from './random.mjs';
import { TreeFactory, semanticTree, treeHash, validateTree } from './trees.mjs';
import { BudgetExhausted, COMPONENTS, WorkLedger } from './work.mjs';

export const I06_NAMESPACE = 'DT-I05-NST-v1';
export const I06_PROTOCOL_ID = 'DT-I05-NST-v1.0';
export const I06_STATE_ARMS = Object.freeze(['PERSIST', 'CHAMPION-RESEED', 'POPULATION-RESEED']);

/** @typedef {{sourceKeyHex:string, cap:number, provenancePrefix?:string|null, provenanceEmit?:((event:object)=>void)|null}} ReseedOptions */

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value), 'utf8');

function checkedSnapshot(snapshot) {
  if (!snapshot || snapshot.schema_version !== 1 || snapshot.pendingUpdate !== true
      || snapshot.lastIndex !== snapshot.window?.at(-1)?.index || !snapshot.learner
      || !/^[a-f0-9]{64}$/.test(snapshot.protocolHash)) {
    throw new Error('I06 fork requires a verified revealed pre-update checkpoint snapshot');
  }
  return snapshot;
}

function exactComponentZeroes() {
  return Object.fromEntries(COMPONENTS.map((name) => [name, 0]));
}

function addComponents(a, b) {
  return Object.fromEntries(COMPONENTS.map((name) => [name, (a?.[name] ?? 0) + (b?.[name] ?? 0)]));
}

function semanticKey(tree) {
  return JSON.stringify(semanticTree(tree));
}

function collectTreeProvenance(tree, out) {
  out.node_ids.add(tree._p.id);
  out.tokens.add(tree._p.token);
  if (tree._p.source !== null) out.source_ids.add(tree._p.source);
  if (tree.type === 'split') {
    for (const edge of [tree._p.left_edge, tree._p.right_edge]) {
      out.edge_ids.add(edge.id);
      out.tokens.add(edge.token);
      if (edge.source !== null) out.source_ids.add(edge.source);
    }
    collectTreeProvenance(tree.left, out);
    collectTreeProvenance(tree.right, out);
  }
}

export function snapshotIdentitySets(learnerSnapshot) {
  const out = {
    individual_ids: new Set(),
    node_ids: new Set(),
    edge_ids: new Set(),
    source_ids: new Set(),
    tokens: new Set(),
  };
  for (const individual of learnerSnapshot.population ?? []) {
    out.individual_ids.add(individual.id);
    collectTreeProvenance(individual.tree, out);
  }
  return out;
}

function newTreeFromSemantics(sourceTree, factory) {
  if (sourceTree.type === 'leaf') {
    return factory.leaf(sourceTree.action, { operation: 'population-reseed-fresh' });
  }
  const left = newTreeFromSemantics(sourceTree.left, factory);
  const right = newTreeFromSemantics(sourceTree.right, factory);
  return factory.split(sourceTree.feature, sourceTree.threshold, left, right, {
    operation: 'population-reseed-fresh',
  });
}

/**
 * Canonical population plan independent of source array order, identifiers,
 * ordinals, parent links and provenance IDs. Cryptographic hash collisions are
 * detected by retaining the full semantic serialisation next to each digest.
 */
export function canonicalPopulationPlan(sourceLearner) {
  if (!(sourceLearner instanceof EvolutionLearner) || sourceLearner.failed || sourceLearner.champion === null) {
    throw new Error('canonical population plan requires an available parent learner');
  }
  const bySemantic = new Map();
  const digestToSemantic = new Map();
  for (const member of sourceLearner.population) {
    const key = semanticKey(member.tree);
    const digest = treeHash(member.tree);
    const prior = digestToSemantic.get(digest);
    if (prior !== undefined && prior !== key) throw new Error('tree-hash collision detected; refusing canonicalisation');
    digestToSemantic.set(digest, key);
    const entry = bySemantic.get(key) ?? { digest, key, count: 0, representative: member.tree };
    entry.count += 1;
    bySemantic.set(key, entry);
  }
  const championKey = semanticKey(sourceLearner.champion.tree);
  const championDigest = treeHash(sourceLearner.champion.tree);
  const championEntry = bySemantic.get(championKey);
  if (!championEntry || championEntry.count < 1 || championEntry.digest !== championDigest) {
    throw new Error('champion semantics absent from parent population');
  }
  championEntry.count -= 1;

  const plan = [{ role: 'CHAMPION', digest: championDigest, semantic_key: championKey,
    duplicate_rank: 0, representative: sourceLearner.champion.tree }];
  const residual = [...bySemantic.values()].filter((entry) => entry.count > 0)
    .sort((a, b) => a.digest.localeCompare(b.digest) || a.key.localeCompare(b.key));
  for (const entry of residual) {
    const startsAt = entry.key === championKey ? 1 : 0;
    for (let j = 0; j < entry.count; j += 1) {
      plan.push({ role: 'RESIDUAL', digest: entry.digest, semantic_key: entry.key,
        duplicate_rank: startsAt + j, representative: entry.representative });
    }
  }
  if (plan.length !== sourceLearner.config.populationSize) throw new Error('canonical plan changed population size');
  return plan;
}

export function treatmentOptimiserAddress(sourceKeyHex, arm, namespace = I06_NAMESPACE) {
  if (!/^[a-f0-9]{16}$/.test(sourceKeyHex) || !['CHAMPION-RESEED', 'POPULATION-RESEED'].includes(arm)
      || namespace !== I06_NAMESPACE) throw new TypeError('invalid I06 treatment optimiser address request');
  return `${namespace}|EXT|RESET-OPTIMISER|stream=${sourceKeyHex}|arm=${arm}`;
}

export function treatmentOptimiserKey(sourceKeyHex, arm, namespace = I06_NAMESPACE) {
  return keyFromAddress(treatmentOptimiserAddress(sourceKeyHex, arm, namespace));
}

/**
 * Streaming provenance closure audit. A verified parent snapshot may form a
 * trusted boundary for PERSIST. Fresh arms are not allowed such a boundary.
 */
export class ClosedProvenanceAudit {
  /** @param {{arm:string, parentCertificateSha256?:string|null}} options */
  constructor(options) {
    const { arm, parentCertificateSha256 = null } = options;
    if (!I06_STATE_ARMS.includes(arm)) throw new TypeError('invalid provenance audit arm');
    if (parentCertificateSha256 !== null && !/^[a-f0-9]{64}$/.test(parentCertificateSha256)) {
      throw new TypeError('invalid parent provenance certificate digest');
    }
    this.arm = arm;
    this.parentCertificateSha256 = parentCertificateSha256;
    this.ids = new Set();
    this.trustedBoundaryIds = new Set();
    this.eventCount = 0;
    this.eventBytes = 0;
    this.chain = Buffer.alloc(32, 0);
    this.closed = true;
  }
  trustParentSnapshot(learnerSnapshot) {
    if (this.arm !== 'PERSIST' || this.parentCertificateSha256 === null) {
      throw new Error('only PERSIST may trust an independently verified parent boundary');
    }
    const sets = snapshotIdentitySets(learnerSnapshot);
    for (const id of [...sets.node_ids, ...sets.edge_ids, ...sets.source_ids]) this.trustedBoundaryIds.add(id);
  }
  append(event) {
    if (!event || typeof event !== 'object' || typeof event.kind !== 'string') throw new Error('malformed provenance event');
    if (['node', 'edge'].includes(event.kind)) {
      if (typeof event.id !== 'string' || !event.id || this.ids.has(event.id) || this.trustedBoundaryIds.has(event.id)) {
        throw new Error('duplicate or invalid provenance event id');
      }
      if (event.source !== null && event.source !== undefined
          && !this.ids.has(event.source) && !this.trustedBoundaryIds.has(event.source)) {
        this.closed = false;
        throw new Error(`provenance source absent: ${event.source}`);
      }
      this.ids.add(event.id);
    } else if (event.kind === 'realised-connected-subtree') {
      if (typeof event.record !== 'string' || (!this.ids.has(event.record) && !this.trustedBoundaryIds.has(event.record))) {
        this.closed = false;
        throw new Error('realisation references absent provenance record');
      }
    } else {
      throw new Error(`unsupported I06 provenance event kind: ${event.kind}`);
    }
    const bytes = jsonBytes(event);
    this.eventCount += 1;
    this.eventBytes += bytes.length;
    this.chain = createHash('sha256').update(this.chain).update(bytes).digest();
  }
  verifySnapshot(learnerSnapshot) {
    const sets = snapshotIdentitySets(learnerSnapshot);
    for (const id of [...sets.node_ids, ...sets.edge_ids]) {
      if (!this.ids.has(id) && !this.trustedBoundaryIds.has(id)) throw new Error(`snapshot provenance id absent: ${id}`);
    }
    for (const id of sets.source_ids) {
      if (!this.ids.has(id) && !this.trustedBoundaryIds.has(id)) throw new Error(`snapshot source id absent: ${id}`);
    }
    return {
      closed: this.closed,
      event_count: this.eventCount,
      event_bytes: this.eventBytes,
      live_id_count: this.ids.size,
      trusted_boundary_id_count: this.trustedBoundaryIds.size,
      chain_sha256: this.chain.toString('hex'),
      parent_certificate_sha256: this.parentCertificateSha256,
      snapshot_sha256: sha256(JSON.stringify(learnerSnapshot)),
    };
  }
}

function mergeTreatmentReports({ arm, cap, construction, update, canonicalPlan = null }) {
  const updateComponents = update?.apw_components ?? exactComponentZeroes();
  const constructionComponents = construction?.apw_components ?? exactComponentZeroes();
  const total = (construction?.adaptation_apw_total ?? 0) + (update?.adaptation_apw_total ?? 0);
  if (total > cap) throw new Error('combined I06 treatment work exceeded the declared APW allowance');
  return {
    arm,
    budget_cap: cap,
    construction_apw_total: construction?.adaptation_apw_total ?? 0,
    update_apw_total: update?.adaptation_apw_total ?? 0,
    adaptation_apw_total: total,
    unspent_APW: cap - total,
    apw_components: addComponents(constructionComponents, updateComponents),
    construction_process_cpu_ns: construction?.process_cpu_ns ?? 0,
    construction_elapsed_ns: construction?.elapsed_ns ?? 0,
    update_process_cpu_ns: update?.process_cpu_ns ?? 0,
    update_elapsed_ns: update?.elapsed_ns ?? 0,
    candidate_evaluations: update?.candidate_evaluations ?? 0,
    node_example_visits: update?.node_example_visits ?? 0,
    completed_rounds: update?.completed_rounds ?? 0,
    mandatory_stage_committed: update?.mandatory_stage_committed ?? false,
    partial_scratch_discarded: update?.partial_scratch_discarded ?? false,
    exhausted_axis: update?.exhausted_axis ?? null,
    initialisation_failed: update?.initialisation_failed ?? false,
    population_size: update?.population_size ?? 0,
    scored_through: update?.scored_through ?? null,
    provenance_records: (construction?.provenance_records ?? 0) + (update?.provenance_records ?? 0),
    provenance_ns: (construction?.provenance_ns ?? 0) + (update?.provenance_ns ?? 0),
    canonical_plan_sha256: canonicalPlan === null ? null : sha256(JSON.stringify(canonicalPlan.map(({ representative, ...x }) => x))),
  };
}

function constructionReport(ledger, factory) {
  const report = ledger.report();
  return { ...report, provenance_records: factory.eventCount, provenance_ns: factory.provenanceNs };
}

function freshCommon(source, key, prefix, emit) {
  return new EvolutionLearner({ key, config: source.config, provenancePrefix: prefix, emit });
}

/** @param {object} snapshot @param {ReseedOptions} options */
export function composePopulationReseed(snapshot, options) {
  const { sourceKeyHex, cap, provenancePrefix, provenanceEmit = null } = options;
  checkedSnapshot(snapshot);
  if (!/^[a-f0-9]{16}$/.test(sourceKeyHex) || !Number.isSafeInteger(cap) || cap < 1) throw new TypeError('invalid POPULATION-RESEED composition');
  const source = EvolutionLearner.restore(snapshot.learner);
  if (source.failed || source.champion === null) return { status: 'TREATMENT_UNAVAILABLE', reason: 'PARENT_STATE_UNAVAILABLE' };
  const key = treatmentOptimiserKey(sourceKeyHex, 'POPULATION-RESEED');
  const prefix = provenancePrefix ?? `I06:${sourceKeyHex}:c${snapshot.lastIndex}:POPULATION-RESEED`;
  const ledger = new WorkLedger({ cap });
  const factory = new TreeFactory({ ledger, prefix: `${prefix}:transfer`, update: 1, emit: provenanceEmit });
  const plan = canonicalPopulationPlan(source);
  const population = [];
  let fresh;
  try {
    for (let ordinal = 0; ordinal < plan.length; ordinal += 1) {
      ledger.boundary();
      const tree = newTreeFromSemantics(plan[ordinal].representative, factory);
      const individual = { tree, ordinal, id: factory.id('individual'), parents: [] };
      factory.realise(tree, individual.id);
      population.push(individual);
    }
    fresh = freshCommon(source, key, prefix, provenanceEmit);
    fresh.population = population;
    fresh.champion = population[0];
    fresh.nextOrdinal = population.length;
    fresh.completedUpdates = 0;
    fresh.scoredThrough = null;
    fresh.failed = false;
    fresh.treatmentApplied = false;
    fresh.lastUpdate = null;
    fresh.eventSerial = 0;
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    return { status: 'ALGORITHMIC_FAILURE', reason: 'CONSTRUCTION_ALLOWANCE_EXHAUSTED', exhausted_axis: error.axis };
  }
  const sourceSets = snapshotIdentitySets(snapshot.learner);
  const freshSets = snapshotIdentitySets(fresh.snapshot());
  const identityOverlap = [...freshSets.individual_ids].filter((id) => sourceSets.individual_ids.has(id));
  const provenanceOverlap = [...freshSets.node_ids, ...freshSets.edge_ids].filter((id) => sourceSets.node_ids.has(id) || sourceSets.edge_ids.has(id));
  const tokenOverlap = [...freshSets.tokens].filter((token) => sourceSets.tokens.has(token));
  const beforeUpdateAudit = {
    champion_sha256: treeHash(fresh.champion.tree),
    population_multiset_sha256: populationMultisetDigest(fresh.population),
    optimiser_key_hex: fresh.key,
    next_ordinal: fresh.nextOrdinal,
    completed_updates: fresh.completedUpdates,
    scored_through: fresh.scoredThrough,
    event_serial: fresh.eventSerial,
    treatment_applied: fresh.treatmentApplied,
    last_update_is_null: fresh.lastUpdate === null,
    parents_all_empty: fresh.population.every((p) => p.parents.length === 0),
    ordinals_are_canonical: fresh.population.every((p, i) => p.ordinal === i),
    inherited_individual_id_overlap: identityOverlap.length,
    inherited_provenance_id_overlap: provenanceOverlap.length,
    inherited_token_overlap: tokenOverlap.length,
  };
  if (beforeUpdateAudit.champion_sha256 !== treeHash(source.champion.tree)
      || beforeUpdateAudit.population_multiset_sha256 !== populationMultisetDigest(source.population)
      || beforeUpdateAudit.optimiser_key_hex === source.key
      || !beforeUpdateAudit.parents_all_empty || !beforeUpdateAudit.ordinals_are_canonical
      || identityOverlap.length || provenanceOverlap.length || tokenOverlap.length) {
    throw new Error('POPULATION-RESEED pre-update proof obligation failed');
  }
  return { status: 'COMPOSED', source, learner: fresh, plan, construction_ledger: ledger,
    construction_factory: factory, before_update_audit: beforeUpdateAudit,
    transferred_champion_sha256: beforeUpdateAudit.champion_sha256 };
}

/** @param {object} snapshot @param {ReseedOptions} options */
export function composeChampionReseed(snapshot, options) {
  const { sourceKeyHex, cap, provenancePrefix, provenanceEmit = null } = options;
  checkedSnapshot(snapshot);
  if (!/^[a-f0-9]{16}$/.test(sourceKeyHex) || !Number.isSafeInteger(cap) || cap < 1) throw new TypeError('invalid CHAMPION-RESEED composition');
  const source = EvolutionLearner.restore(snapshot.learner);
  if (source.failed || source.champion === null) return { status: 'TREATMENT_UNAVAILABLE', reason: 'NO_VALID_PARENT_CHAMPION' };
  const key = treatmentOptimiserKey(sourceKeyHex, 'CHAMPION-RESEED');
  const prefix = provenancePrefix ?? `I06:${sourceKeyHex}:c${snapshot.lastIndex}:CHAMPION-RESEED`;
  const ledger = new WorkLedger({ cap });
  const factory = new TreeFactory({ ledger, prefix: `${prefix}:transfer`, update: 1, emit: provenanceEmit });
  let fresh;
  try {
    const tree = newTreeFromSemantics(source.champion.tree, factory);
    const anchor = { tree, ordinal: 0, id: factory.id('champion-anchor'), parents: [] };
    factory.realise(tree, anchor.id);
    fresh = freshCommon(source, key, prefix, provenanceEmit);
    fresh.champion = anchor;
    fresh.population = [];
    fresh.nextOrdinal = 0;
    fresh.completedUpdates = 0;
    fresh.scoredThrough = null;
    fresh.failed = false;
    fresh.treatmentApplied = false;
    fresh.lastUpdate = null;
    fresh.eventSerial = 0;
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    return { status: 'ALGORITHMIC_FAILURE', reason: 'CONSTRUCTION_ALLOWANCE_EXHAUSTED', exhausted_axis: error.axis };
  }
  const sourceSets = snapshotIdentitySets(snapshot.learner);
  const anchorSets = { individual_ids: new Set([fresh.champion.id]), node_ids: new Set(), edge_ids: new Set(), source_ids: new Set(), tokens: new Set() };
  collectTreeProvenance(fresh.champion.tree, anchorSets);
  const beforeUpdateAudit = {
    champion_sha256: treeHash(fresh.champion.tree),
    optimiser_key_hex: fresh.key,
    next_ordinal: 0,
    completed_updates: 0,
    scored_through: null,
    event_serial: 0,
    treatment_applied: false,
    last_update_is_null: true,
    anchor_parents_empty: fresh.champion.parents.length === 0,
    inherited_individual_id_overlap: Number(sourceSets.individual_ids.has(fresh.champion.id)),
    inherited_provenance_id_overlap: [...anchorSets.node_ids, ...anchorSets.edge_ids].filter((id) => sourceSets.node_ids.has(id) || sourceSets.edge_ids.has(id)).length,
    inherited_token_overlap: [...anchorSets.tokens].filter((token) => sourceSets.tokens.has(token)).length,
  };
  if (beforeUpdateAudit.champion_sha256 !== treeHash(source.champion.tree)
      || beforeUpdateAudit.optimiser_key_hex === source.key || !beforeUpdateAudit.anchor_parents_empty
      || beforeUpdateAudit.inherited_individual_id_overlap || beforeUpdateAudit.inherited_provenance_id_overlap
      || beforeUpdateAudit.inherited_token_overlap) throw new Error('CHAMPION-RESEED pre-update proof obligation failed');
  return { status: 'COMPOSED', source, learner: fresh, plan: null, construction_ledger: ledger,
    construction_factory: factory, before_update_audit: beforeUpdateAudit,
    transferred_champion_sha256: beforeUpdateAudit.champion_sha256 };
}

export function populationMultiset(population) {
  const counts = new Map();
  for (const member of population) {
    const key = semanticKey(member.tree);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function populationMultisetDigest(population) {
  return sha256(JSON.stringify(populationMultiset(population)));
}

/**
 * Apply the locked I06 treatment at a verified checkpoint. The first treatment
 * stage and any construction work share one declared APW envelope. Subsequent
 * 100-row updates use the same full per-update cap as Study 1.
 */
export function forkI06State(snapshot, options) {
  const {
    arm, cap, sourceKeyHex, budgetTag = 'I06', provenancePrefix = null,
    emit = null, provenanceAudit = null, attemptId = 'I06-DEV', runId = 'I06-DEV',
    integrityStatus = null, parentProvenanceVerified = false,
  } = options ?? {};
  checkedSnapshot(snapshot);
  if (integrityStatus !== 'VERIFIED' || !parentProvenanceVerified) {
    throw new Error('I06 fork requires verified tape, parent snapshot and provenance');
  }
  if (!I06_STATE_ARMS.includes(arm) || !Number.isSafeInteger(cap) || cap < 1
      || !/^[a-f0-9]{16}$/.test(sourceKeyHex)) throw new TypeError('invalid I06 treatment request');
  const prefix = provenancePrefix ?? `I06:${sourceKeyHex}:c${snapshot.lastIndex}:${arm}`;
  const originTag = `${budgetTag}|origin=${arm}`;
  let learner;
  let sourceParentAvailable = true;
  let transferredChampionSha256 = null;
  let beforeUpdateAudit = null;
  let construction = null;
  let plan = null;
  let update = null;

  if (arm === 'PERSIST') {
    learner = EvolutionLearner.restore(snapshot.learner, { provenancePrefix: prefix,
      emit: provenanceAudit ? (event) => provenanceAudit.append(event) : null });
    sourceParentAvailable = !learner.failed;
    if (!sourceParentAvailable) return { status: 'TREATMENT_UNAVAILABLE', arm, source_parent_available: false,
      reason: 'PARENT_STATE_UNAVAILABLE', treatment_applied: false, report: null, session: null };
    update = learner.update(snapshot.window, { checkpoint: snapshot.lastIndex, arm: 'PERSIST', cap,
      budgetTag: originTag, contextCheckpoint: snapshot.lastIndex });
  } else {
    const compose = arm === 'POPULATION-RESEED' ? composePopulationReseed : composeChampionReseed;
    const prepared = compose(snapshot, { sourceKeyHex, cap, provenancePrefix: prefix,
      provenanceEmit: provenanceAudit ? (event) => provenanceAudit.append(event) : null });
    if (prepared.status !== 'COMPOSED') return { status: prepared.status, arm, source_parent_available: true,
      reason: prepared.reason, treatment_applied: prepared.status === 'ALGORITHMIC_FAILURE', report: null, session: null };
    learner = prepared.learner;
    plan = prepared.plan;
    transferredChampionSha256 = prepared.transferred_champion_sha256;
    beforeUpdateAudit = prepared.before_update_audit;
    construction = constructionReport(prepared.construction_ledger, prepared.construction_factory);
    const remaining = cap - construction.adaptation_apw_total;
    const internalArm = arm === 'CHAMPION-RESEED' ? 'CHAMPION' : 'PERSIST';
    update = learner.update(snapshot.window, { checkpoint: snapshot.lastIndex, arm: internalArm, cap: remaining,
      budgetTag: originTag, contextCheckpoint: snapshot.lastIndex });
  }
  learner.treatmentApplied = true;
  const report = mergeTreatmentReports({ arm, cap, construction, update, canonicalPlan: plan });
  const session = new PrequentialSession({ learner, window: snapshot.window, cap, budgetTag: originTag,
    contextCheckpoint: snapshot.lastIndex, arm: 'PERSIST', pendingUpdate: false, treatmentPending: false,
    emit, attemptId, runId, protocolHash: snapshot.protocolHash });
  const status = learner.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE';
  return { status, arm, source_parent_available: sourceParentAvailable, treatment_applied: true,
    transferred_champion_sha256: transferredChampionSha256, before_update_audit: beforeUpdateAudit,
    report, session };
}

export function verifyNoInheritedState(parentSnapshot, childLearnerSnapshot, arm) {
  if (!['CHAMPION-RESEED', 'POPULATION-RESEED'].includes(arm)) throw new TypeError('fresh-state arm required');
  const parent = snapshotIdentitySets(parentSnapshot);
  const child = snapshotIdentitySets(childLearnerSnapshot);
  const individualOverlap = [...child.individual_ids].filter((id) => parent.individual_ids.has(id));
  const provenanceOverlap = [...child.node_ids, ...child.edge_ids].filter((id) => parent.node_ids.has(id) || parent.edge_ids.has(id));
  const tokenOverlap = [...child.tokens].filter((id) => parent.tokens.has(id));
  return {
    valid: individualOverlap.length === 0 && provenanceOverlap.length === 0 && tokenOverlap.length === 0,
    individual_id_overlap: individualOverlap,
    provenance_id_overlap: provenanceOverlap,
    token_overlap: tokenOverlap,
  };
}

export function validateFreshPopulationSnapshot(snapshot) {
  const learner = EvolutionLearner.restore(snapshot);
  for (const member of learner.population) validateTree(member.tree, {
    featureCount: learner.config.featureCount,
    maxDepth: learner.config.maxTreeDepth,
    requireRealised: true,
  });
  return true;
}
