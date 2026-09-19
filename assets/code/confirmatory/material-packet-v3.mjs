/** New Phase 10G implementation from the recovered Phase 9/10D contracts.
 * This is not the unavailable Phase 10E source. Hashes are integrity anchors,
 * not a signature, an independent timestamp or whole-study scientific admission.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DevelopmentStream } from './generator.mjs';
import { EvolutionLearner, CONFIG } from './learner.mjs';
import { keyFromAddress } from './random.mjs';
import { strictJson } from './evidence.mjs';
import { frozenShadows, shadowPredictions } from './material.mjs';
import { exportTree, treeHash } from './trees.mjs';

const protocolBytes = fs.readFileSync(new URL('../../../working/phase9/PROTOCOL_SPEC.json', import.meta.url));
export const MATERIAL_PROTOCOL_SHA256 = createHash('sha256').update(protocolBytes).digest('hex');
export const packetHash = (value) => createHash('sha256').update(strictJson(value)).digest('hex');
const same = (a, b) => strictJson(a) === strictJson(b);
function exactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new TypeError('unexpected fields');
}
function checkedParent(parent, identity, anchor) {
  strictJson(parent); strictJson(identity);
  exactKeys(identity, ['partition', 'scenario', 'realisation', 'optimiser', 'checkpoint']);
  if (identity.partition !== 'DEV' || ![10000, 20000].includes(identity.checkpoint)
    || !Number.isInteger(identity.optimiser) || identity.optimiser < 0 || identity.optimiser > 1) throw new Error('DEV identity required');
  if (!/^[a-f0-9]{64}$/.test(anchor) || packetHash(parent) !== anchor) throw new Error('external parent anchor mismatch');
  exactKeys(parent, ['schema_version', 'learner', 'window', 'lastIndex', 'pendingUpdate', 'protocolHash']);
  if (parent.schema_version !== 1 || parent.protocolHash !== MATERIAL_PROTOCOL_SHA256
    || parent.lastIndex !== identity.checkpoint || parent.pendingUpdate !== true) throw new Error('not a pre-update protocol checkpoint');
  const stream = new DevelopmentStream(identity);
  if (!same(parent.window, stream.window(identity.checkpoint))) throw new Error('parent window is not the declared DEV past');
  const key = keyFromAddress(`DT-P9-v1|DEV|${identity.scenario}|r=${String(identity.realisation).padStart(2, '0')}|optimiser=${String(identity.optimiser).padStart(2, '0')}`);
  if (parent.learner.key !== key || !same(parent.learner.config, { ...CONFIG })) throw new Error('learner key or configuration differs from protocol');
  const learner = EvolutionLearner.restore(parent.learner);
  if (!learner.failed && learner.population.length !== 150) throw new Error('incomplete parent population');
  return { learner, stream };
}
function workOnly(report) {
  if (report === null) return null;
  return Object.fromEntries(['apw_components', 'adaptation_apw_total', 'candidate_evaluations', 'node_example_visits',
    'rejected_operators', 'class_deficient_scores'].map((key) => [key, report[key]]));
}
/** Construct the complete 2,000-row frozen-shadow packet, without aggregate contrasts. */
export function createMaterialPacket(parent, identity, parentAnchor) {
  const { learner, stream } = checkedParent(parent, identity, parentAnchor);
  const before = packetHash(parent); const events = [];
  const prefix = `P10G-MATERIAL:${identity.scenario}:${identity.realisation}:${identity.optimiser}:${identity.checkpoint}`;
  const shadows = frozenShadows(learner, parent.window, identity.checkpoint, { prefix, emit: (e) => events.push(e) });
  // The old runtime returns a deliberately undefined rows field in selected metadata.
  // Remove that field explicitly rather than permit JSON to omit arbitrary values.
  const selected = shadows.selected ? Object.fromEntries(Object.entries(shadows.selected).filter(([key]) => key !== 'rows')) : null;
  const rows = [];
  for (let t = identity.checkpoint + 1; t <= identity.checkpoint + 2000; t++) {
    const x = stream.features(t);
    const predictions = shadowPredictions(shadows, x); // Deliberately before label access.
    const label = stream.label(t, x);
    rows.push({ observation_index: t, features_sha256: packetHash(x), label, predictions,
      loss: Object.fromEntries(Object.entries(predictions).map(([arm, p]) => [arm, p === null ? 1 : Number(p !== label)])) });
  }
  if (packetHash(parent) !== before) throw new Error('parent mutated during material intervention');
  if (!shadows.parent_unavailable && treeHash(shadows.sham) !== treeHash(learner.champion.tree)) throw new Error('sham is not semantically identical');
  return { schema_version: 3, implementation: 'P10G_EXPLICIT_REIMPLEMENTATION', partition: 'DEV',
    identity: { ...identity }, protocol_sha256: MATERIAL_PROTOCOL_SHA256, parent_session_sha256: parentAnchor,
    horizon: 2000, parent_unavailable: shadows.parent_unavailable, eligible_count: shadows.eligible_count,
    selected, fallback: shadows.fallback ?? null, cost: workOnly(shadows.cost),
    refit_tree: shadows.refit === null ? null : exportTree(shadows.refit),
    sham_tree: shadows.sham === null ? null : exportTree(shadows.sham), provenance: events, rows,
    scientific_admission: false, aggregate_contrasts_computed: false };
}
/** Recompute source, selection, trees and every prediction against external anchors.
 * A supplied index must already contain only the admitted parental prefix. */
export function verifyMaterialPacket(packet, parent, identity, { parentSha256, packetSha256, index = null }) {
  strictJson(packet);
  if (!/^[a-f0-9]{64}$/.test(packetSha256) || packetHash(packet) !== packetSha256) throw new Error('external packet anchor mismatch');
  if (index !== null) index.verifySnapshot(parent.learner);
  const expected = createMaterialPacket(parent, identity, parentSha256);
  if (!same(expected, packet)) throw new Error('material packet differs from independently reconstructed source-bound outcome');
  if (index !== null) for (const event of packet.provenance) index.append(event);
  return { status: 'PASS', packet_sha256: packetSha256, parent_sha256: parentSha256,
    source_rows: packet.rows.length, prediction_slots: packet.rows.length * 2,
    eligible_count: packet.eligible_count, provenance_prefix_verified: index !== null,
    parent_unavailable: packet.parent_unavailable, scientific_admission: false,
    aggregate_contrasts_computed: false, scope: 'Source-bound packet verification, not whole execution-matrix admission' };
}
