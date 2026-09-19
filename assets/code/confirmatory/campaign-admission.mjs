/** Admit a fixed DEV campaign only after complete inventory and native replay.
 * The caller supplies the independently anchored specification hash. This is a
 * composition of existing verifiers, not independent clock authentication or a
 * gate for generating CONF data. All operations assume a stable local filesystem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strictJson } from './evidence.mjs';
import { verifyTrajectory, replaySourceHashes } from './trajectory-replay.mjs';
import { verifyCpuTrajectory } from './cpu-trajectory.mjs';
import { hashObject } from './session.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_FILES = 50000;
const MAX_BYTES = 16 * 1024 ** 3;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => strictJson(a) === strictJson(b);
function exact(value, keys) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('unexpected campaign fields');
}
function relative(name) {
  if (typeof name !== 'string' || name.length > 400 || !name.split('/').every(p => /^[A-Za-z0-9_.-]{1,100}$/.test(p) && p !== '.' && p !== '..')) {
    throw new Error('unsafe or noncanonical relative path');
  }
  return name;
}
function regularHash(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > MAX_BYTES) throw new Error('nonregular, linked or oversized input');
    const h = createHash('sha256'); const buffer = Buffer.alloc(65536); let bytes = 0; let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { bytes += n; h.update(buffer.subarray(0, n)); }
    if (bytes !== s.size) throw new Error('file changed while hashing');
    return { bytes, sha256: h.digest('hex') };
  } finally { fs.closeSync(fd); }
}
/** Canonical manifest for files AND implicit directories; no symlinks or hardlinks. */
export function campaignInventory(directory) {
  const root = path.resolve(directory); const files = []; const directories = []; let bytes = 0;
  function walk(dir, prefix) {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('campaign path must be a real directory');
    for (const entry of fs.readdirSync(dir).sort()) {
      const rel = relative(prefix ? `${prefix}/${entry}` : entry); const full = path.join(root, rel); const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new Error('symbolic links are not campaign evidence');
      if (st.isDirectory()) {
        directories.push(rel); if (directories.length > MAX_FILES) throw new Error('too many directories'); walk(full, rel);
      } else {
        const item = { path: rel, ...regularHash(full) }; files.push(item); bytes += item.bytes;
        if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('campaign inventory resource limit');
      }
    }
  }
  walk(root, '');
  return { files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), directories: directories.sort(), bytes };
}
export function admissionSourceHashes() {
  return { ...replaySourceHashes(), ...Object.fromEntries(['cpu-clock-tape.mjs', 'cpu-trajectory.mjs', 'campaign-admission.mjs'].map(name =>
    [`assets/code/confirmatory/${name}`, sha(fs.readFileSync(new URL(name, import.meta.url)))])),
    'working/phase9/PROTOCOL_SPEC.json': sha(fs.readFileSync(path.join(ROOT, 'working/phase9/PROTOCOL_SPEC.json'))),
    'working/phase9/SEED_SCHEDULE.tsv': sha(fs.readFileSync(path.join(ROOT, 'working/phase9/SEED_SCHEDULE.tsv'))) };
}
export const campaignSpecHash = spec => sha(Buffer.from(strictJson(spec) + '\n'));

/** This does not execute a trajectory or treat receipts as successful evidence. */
export function validateCampaignSpecification(spec, specSha256) {
  strictJson(spec);
  if (!HASH.test(specSha256 ?? '') || campaignSpecHash(spec) !== specSha256) throw new Error('independent specification anchor required');
  exact(spec, ['schema_version', 'scope', 'source_execution_commit', 'sources', 'tasks', 'inventory', 'scientific_admission', 'confirmation_authorised']);
  if (spec.schema_version !== 1 || !['DEV_CHECK', 'FIXTURE'].includes(spec.scope) || spec.scientific_admission !== false
    || spec.confirmation_authorised !== false || !/^[a-f0-9]{40}$/.test(spec.source_execution_commit ?? '')) throw new Error('only scoped DEV/FIXTURE specifications are admitted');
  if (!equal(spec.sources, admissionSourceHashes())) throw new Error('current source closure differs from the specification');
  if (!Array.isArray(spec.tasks) || !spec.tasks.length || spec.tasks.length > 21000) throw new Error('invalid task inventory');
  const tasks = new Map(); const runs = new Set(); const attempts = new Set(); const namespaces = new Set();
  for (const task of spec.tasks) {
    exact(task, ['id', 'kind', 'parent_id', 'plan', 'capsule_sha256']);
    if (!ID.test(task.id ?? '') || tasks.has(task.id) || !HASH.test(task.capsule_sha256 ?? '')
      || !['APW_PARENT', 'APW_FORK', 'CPU_FORK'].includes(task.kind)) throw new Error('duplicate, unknown or unanchored task');
    const p = task.plan;
    if (!p || p.partition !== 'DEV' || p.scope !== spec.scope || !ID.test(p.run_id ?? '') || !ID.test(p.attempt_id ?? '')
      || !ID.test(p.provenance_prefix ?? '') || runs.has(p.run_id) || attempts.has(p.attempt_id) || namespaces.has(p.provenance_prefix)) throw new Error('mixed scope or reused run/attempt/provenance identity');
    if (task.kind === 'APW_PARENT' ? (task.parent_id !== null || p.arm !== 'PARENT')
      : (!ID.test(task.parent_id ?? '') || p.arm === 'PARENT')) throw new Error('wrong task-parent role');
    if (task.kind === 'CPU_FORK' ? p.kind !== 'CPU_SAFE_BOUNDARY_V1' : Object.hasOwn(p, 'kind')) throw new Error('wrong resource-specific verifier');
    tasks.set(task.id, task); runs.add(p.run_id); attempts.add(p.attempt_id); namespaces.add(p.provenance_prefix);
  }
  for (const task of tasks.values()) if (task.parent_id !== null) {
    const parent = tasks.get(task.parent_id);
    if (!parent || parent.kind !== 'APW_PARENT' || !parent.plan.save_checkpoints?.includes(task.plan.start)) throw new Error('missing parent or unavailable checkpoint in expected graph');
    for (const key of ['scenario', 'realisation', 'optimiser', 'protocol_sha256']) {
      if (parent.plan[key] !== task.plan[key]) throw new Error('fork points to another stream or protocol');
    }
  }
  exact(spec.inventory, ['files', 'directories', 'bytes']);
  if (!Array.isArray(spec.inventory.files) || !Array.isArray(spec.inventory.directories)
    || spec.inventory.files.length > MAX_FILES || spec.inventory.directories.length > MAX_FILES
    || !Number.isSafeInteger(spec.inventory.bytes) || spec.inventory.bytes < 1 || spec.inventory.bytes > MAX_BYTES) throw new Error('invalid file inventory');
  const names = new Set(); const dirs = new Set(); let bytes = 0;
  for (const file of spec.inventory.files) {
    exact(file, ['path', 'bytes', 'sha256']); relative(file.path);
    if (names.has(file.path) || !HASH.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('invalid or duplicate file descriptor');
    names.add(file.path); bytes += file.bytes;
    const parts = file.path.split('/'); parts.pop(); while (parts.length) { dirs.add(parts.join('/')); parts.pop(); }
  }
  for (const dir of spec.inventory.directories) relative(dir);
  if (!Number.isSafeInteger(bytes) || bytes !== spec.inventory.bytes
    || !equal([...dirs].sort(), spec.inventory.directories) || names.size === 0) throw new Error('inventory directory closure or total differs');
  for (const task of tasks.values()) {
    const descriptor = spec.inventory.files.find(f => f.path === `${task.id}/CAPSULE.json`);
    if (!descriptor || descriptor.sha256 !== task.capsule_sha256) throw new Error('task capsule is not anchored by the inventory');
  }
  // No arbitrary user-selected verifier, executable path, or success Boolean.
  return [...tasks.values()].sort((a, b) => Number(a.parent_id !== null) - Number(b.parent_id !== null) || a.id.localeCompare(b.id));
}

export function admitCampaign(directory, spec, { specSha256 = undefined } = {}) {
  const tasks = validateCampaignSpecification(spec, specSha256);
  // Historical execution identity is checked against available Git blobs. The
  // newly added coordinator was not executed by historical campaigns.
  for (const [name, expected] of Object.entries(spec.sources)) {
    if (name.endsWith('/campaign-admission.mjs')) continue;
    const bytes = execFileSync('git', ['show', `${spec.source_execution_commit}:${name}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (sha(bytes) !== expected) throw new Error('historical execution commit has different source bytes');
  }
  if (!equal(campaignInventory(directory), spec.inventory)) throw new Error('campaign inventory mismatch before replay');
  const parents = new Map(); const receipts = [];
  for (const task of tasks) {
    const plan = task.plan; const parent = task.parent_id === null ? null : parents.get(task.parent_id)?.[plan.start];
    if (task.parent_id !== null && (!parent || hashObject(parent) !== plan.parent_session_sha256)) throw new Error('replayed parent anchor differs');
    const dir = path.join(directory, task.id);
    const result = task.kind === 'CPU_FORK'
      ? { ...verifyCpuTrajectory(dir, plan, { parent, capsuleSha256: task.capsule_sha256 }), checkpoints: null }
      : verifyTrajectory(dir, plan, { parent, capsuleSha256: task.capsule_sha256 });
    if (task.parent_id === null) parents.set(task.id, result.checkpoints);
    const { checkpoints: unusedCheckpoints, ...summary } = result;
    if (unusedCheckpoints && task.parent_id !== null && Object.keys(unusedCheckpoints).length) throw new Error('fork checkpoints are not accepted by this graph');
    receipts.push({ id: task.id, kind: task.kind, parent_id: task.parent_id, plan_sha256: hashObject(plan), verification: summary });
  }
  if (!equal(campaignInventory(directory), spec.inventory) || !equal(spec.sources, admissionSourceHashes())) throw new Error('source or campaign changed during replay');
  const streams = new Set(tasks.map(t => strictJson([t.plan.scenario, t.plan.realisation])));
  return { schema_version: 1, status: 'PASS_COMPLETE_DECLARED_DEV_PACKAGE', scope: spec.scope,
    specification_sha256: specSha256, source_execution_commit: spec.source_execution_commit, sources: spec.sources,
    files_verified_twice: spec.inventory.files.length, bytes_verified_per_pass: spec.inventory.bytes,
    tasks: receipts.length, distinct_DEV_streams: streams.size, receipts,
    predictions: receipts.reduce((n, r) => n + r.verification.predictions, 0),
    updates: receipts.reduce((n, r) => n + r.verification.updates, 0),
    source_execution_commit_verified_against_git: true, source_bound_replay_performed: true, per_task_integrity_is_not_complete_study: true,
    independent_algorithm_implementation: false, clock_authentication: false,
    full_experimental_matrix_admitted: false, scientific_admission: false, confirmation_authorised: false };
}
