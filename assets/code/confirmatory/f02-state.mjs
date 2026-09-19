/** F02 state-treatment implementation. Historical PrequentialSession.fork remains unchanged. */
import { EvolutionLearner } from './learner.mjs';
import { PrequentialSession } from './session.mjs';
import { treeHash } from './trees.mjs';

export const F02_STATE_ARMS = Object.freeze(['PERSIST', 'RESTART-CART', 'CHAMPION-RESEED']);
const INTERNAL_ARM = Object.freeze({ 'PERSIST': 'PERSIST', 'RESTART-CART': 'RESTART', 'CHAMPION-RESEED': 'CHAMPION' });
export function f02BudgetTag(base, arm) {
  if (!F02_STATE_ARMS.includes(arm) || typeof base !== 'string' || !base) throw new TypeError('invalid F02 treatment origin');
  return `${base}|origin=${arm}`;
}
function checkedSnapshot(snapshot) {
  if (!snapshot || snapshot.schema_version !== 1 || snapshot.pendingUpdate !== true
      || snapshot.lastIndex !== snapshot.window?.at(-1)?.index || !snapshot.learner) throw new Error('F02 fork requires a revealed pre-update snapshot');
  return snapshot;
}
function freshLearnerFromSnapshot(snapshot, { preserveChampion = false, provenancePrefix = 'F02-COLD', emit = null } = {}) {
  const source = EvolutionLearner.restore(snapshot.learner);
  const fresh = new EvolutionLearner({ key: source.key, config: source.config, provenancePrefix, emit });
  let transferredChampionSha256 = null;
  if (preserveChampion) {
    if (source.failed || source.champion === null) return { fresh, source, available: false, transferredChampionSha256 };
    fresh.champion = structuredClone(source.champion); transferredChampionSha256 = treeHash(source.champion.tree);
  }
  return { fresh, source, available: true, transferredChampionSha256 };
}
/** Apply one F02 treatment and return a persistent future session under the same post-fork allowance.
 * @param {any} snapshot
 * @param {{arm:string,cap:number,budgetTag?:string,provenancePrefix?:string|null,emit?:any,provenanceEmit?:any,attemptId?:string,runId?:string,ledgerFactory?:any,integrityStatus?:string|null}} options
 */
export function forkF02State(snapshot, options) {
  const { arm, cap, budgetTag = 'F02', provenancePrefix = null, emit = null, provenanceEmit = null,
    attemptId = 'F02-DEV', runId = 'F02-DEV', ledgerFactory = null, integrityStatus = null } = options ?? {};
  checkedSnapshot(snapshot);
  if (integrityStatus !== 'VERIFIED') throw new Error('F02 fork requires verified parent/data integrity');
  if (!F02_STATE_ARMS.includes(arm) || !Number.isSafeInteger(cap) || cap < 0) throw new TypeError('invalid F02 state treatment');
  const prefix = provenancePrefix ?? `F02:${arm}:${snapshot.lastIndex}`; const originTag = f02BudgetTag(budgetTag, arm);
  let learner; let sourceParentAvailable = true; let report; let treatmentAvailable = true; let transferredChampionSha256 = null;
  if (arm === 'PERSIST') {
    learner = EvolutionLearner.restore(snapshot.learner, { provenancePrefix: prefix, emit: provenanceEmit });
    sourceParentAvailable = !learner.failed; if (!sourceParentAvailable) treatmentAvailable = false;
    else report = learner.update(snapshot.window, { checkpoint: snapshot.lastIndex, arm: 'PERSIST', cap,
      budgetTag: originTag, contextCheckpoint: snapshot.lastIndex, ledgerFactory });
  } else {
    const preserveChampion = arm === 'CHAMPION-RESEED';
    const prepared = freshLearnerFromSnapshot(snapshot, { preserveChampion, provenancePrefix: prefix, emit: provenanceEmit });
    learner = prepared.fresh; sourceParentAvailable = !prepared.source.failed; transferredChampionSha256 = prepared.transferredChampionSha256;
    if (preserveChampion && !prepared.available) treatmentAvailable = false;
    if (treatmentAvailable) report = learner.update(snapshot.window, { checkpoint: snapshot.lastIndex, arm: INTERNAL_ARM[arm], cap,
      budgetTag: originTag, contextCheckpoint: snapshot.lastIndex, initialOnly: false, ledgerFactory });
  }
  if (!treatmentAvailable) return { status: 'TREATMENT_UNAVAILABLE', arm, source_parent_available: sourceParentAvailable,
    reason: arm === 'CHAMPION-RESEED' ? 'NO_VALID_PARENT_CHAMPION' : 'PARENT_STATE_UNAVAILABLE', treatment_applied: false,
    transferred_champion_sha256: transferredChampionSha256, report: null, session: null };
  const session = new PrequentialSession({ learner, window: snapshot.window, cap, budgetTag: originTag,
    contextCheckpoint: snapshot.lastIndex, arm: 'PERSIST', pendingUpdate: false, treatmentPending: false,
    emit, attemptId, runId, protocolHash: snapshot.protocolHash, ledgerFactory });
  return { status: learner.failed ? 'ALGORITHMIC_FAILURE' : 'COMPLETE', arm, source_parent_available: sourceParentAvailable,
    treatment_applied: true, transferred_champion_sha256: transferredChampionSha256, report, session };
}
