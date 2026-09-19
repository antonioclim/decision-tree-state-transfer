import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../assets/code/confirmatory/learner.mjs';
import { hashObject } from '../assets/code/confirmatory/session.mjs';
import { recordTrajectory, verifyTrajectory } from '../assets/code/confirmatory/trajectory-replay.mjs';
import { recordCpuTrajectory } from '../assets/code/confirmatory/cpu-trajectory.mjs';
import { admissionSourceHashes, campaignInventory, campaignSpecHash, validateCampaignSpecification, admitCampaign } from '../assets/code/confirmatory/campaign-admission.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-admission-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, 'original'); fs.mkdirSync(root);
const sources = admissionSourceHashes();
// These are FIXTURE sources, not a claim about a historical research execution.
// Use real Git objects without depending on the checkout's history or copying its
// .git directory into a source-export image. The production verifier is unchanged.
const previousGitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('GIT_')));
for (const name of Object.keys(previousGitEnvironment)) delete process.env[name];
const gitDirectory = path.join(tmp, 'source-objects.git');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const emptyGitConfig = path.join(tmp, 'empty-gitconfig');
fs.writeFileSync(emptyGitConfig, '');
execFileSync('git', ['init', '--bare', '--quiet', gitDirectory], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGitConfig },
});
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_DIR: gitDirectory, GIT_WORK_TREE: sourceRoot,
  GIT_AUTHOR_NAME: 'Regression fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Regression fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
});
after(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
  Object.assign(process.env, previousGitEnvironment);
});
execFileSync('git', ['add', '--force', '--', ...Object.keys(sources)], { cwd: sourceRoot });
const fixtureTree = execFileSync('git', ['write-tree'], { encoding: 'utf8' }).trim();
const fixtureCommit = execFileSync('git', ['commit-tree', fixtureTree, '-m', 'Current-source regression fixture'], { encoding: 'utf8' }).trim();

const config = { ...CONFIG, populationSize: 6, cartDescendants: 3, elitism: 1, tournamentSize: 2,
  maxInitialDepth: 2, maxTreeDepth: 3, thresholdsPerFeature: 3, cartMaxDepth: 3 };
const parentPlan = { schema_version: 1, scope: 'FIXTURE', partition: 'DEV', scenario: 'OBLIQUE-ABRUPT-SEVERE', realisation: 0, optimiser: 0,
  protocol_sha256: sources['working/phase9/PROTOCOL_SPEC.json'], arm: 'PARENT', start: 500, end: 700, apw_cap: 20000,
  budget_tag: '2', config, provenance_prefix: 'ADMIT-P', run_id: 'ADMIT-P', attempt_id: 'ADMIT-P', parent_session_sha256: null, save_checkpoints: [600] };
const pp = recordTrajectory(path.join(root, 'PARENT'), parentPlan);
const par = verifyTrajectory(path.join(root, 'PARENT'), parentPlan, { capsuleSha256: pp.capsule_sha256 }).checkpoints[600];
const ap = { ...parentPlan, arm: 'PERSIST', start: 600, end: 800, save_checkpoints: [], parent_session_sha256: hashObject(par),
  provenance_prefix: 'ADMIT-A', run_id: 'ADMIT-A', attempt_id: 'ADMIT-A' };
const ar = recordTrajectory(path.join(root, 'APW'), ap, par);
const cp = { ...ap, kind: 'CPU_SAFE_BOUNDARY_V1', apw_cap: Number.MAX_SAFE_INTEGER, budget_tag: 'CPU', cpu_cap_ns: 10000000,
  provenance_prefix: 'ADMIT-C', run_id: 'ADMIT-C', attempt_id: 'ADMIT-C' };
const cr = recordCpuTrajectory(path.join(root, 'CPU'), cp, par, { fixtureSampler: (_ledger, a) => ({ cpu_ns: a.sample_index * 100000, rss_bytes: 1000000 }) });
const fp = { ...ap, arm: 'RESTART', apw_cap: 0, provenance_prefix: 'ADMIT-F', run_id: 'ADMIT-F', attempt_id: 'ADMIT-F' };
const fr = recordTrajectory(path.join(root, 'FAILED'), fp, par);
const spec = { schema_version: 1, scope: 'FIXTURE', source_execution_commit: fixtureCommit, sources,
  tasks: [
    { id: 'PARENT', kind: 'APW_PARENT', parent_id: null, plan: parentPlan, capsule_sha256: pp.capsule_sha256 },
    { id: 'APW', kind: 'APW_FORK', parent_id: 'PARENT', plan: ap, capsule_sha256: ar.capsule_sha256 },
    { id: 'CPU', kind: 'CPU_FORK', parent_id: 'PARENT', plan: cp, capsule_sha256: cr.capsule_sha256 },
    { id: 'FAILED', kind: 'APW_FORK', parent_id: 'PARENT', plan: fp, capsule_sha256: fr.capsule_sha256 },
  ], inventory: campaignInventory(root), scientific_admission: false, confirmation_authorised: false };
const digest = campaignSpecHash(spec);
let serial = 0;
function copy() { const dir = path.join(tmp, `copy-${++serial}`); fs.cpSync(root, dir, { recursive: true }); return dir; }
function seal(s) { return { specSha256: campaignSpecHash(s) }; }

test('source fixtures use a real Git object store outside the project checkout', () => {
  assert.equal(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), gitDirectory);
  assert.equal(execFileSync('git', ['cat-file', '-t', fixtureCommit], { encoding: 'utf8' }).trim(), 'commit');
});

test('integrated APW/CPU campaign executes native verifiers and retains algorithmic failures', () => {
  const r = admitCampaign(root, spec, { specSha256: digest });
  assert.equal(r.status, 'PASS_COMPLETE_DECLARED_DEV_PACKAGE'); assert.equal(r.tasks, 4); assert.equal(r.predictions, 800);
  assert.equal(r.distinct_DEV_streams, 1); assert.equal(r.clock_authentication, false); assert.equal(r.confirmation_authorised, false);
  assert.equal(r.full_experimental_matrix_admitted, false);
  assert.equal(r.receipts.find(t => t.id === 'FAILED').verification.failure_slots, 200);
});
test('task order is not a trust boundary; parents replay before any dependent fork', () => {
  const s = structuredClone(spec); s.tasks.reverse(); const r = admitCampaign(root, s, seal(s)); assert.equal(r.tasks, 4);
});
test('missing external specification anchor is rejected', () => assert.throws(() => admitCampaign(root, spec)));
test('wrong external specification anchor is rejected', () => assert.throws(() => admitCampaign(root, spec, { specSha256: '0'.repeat(64) })));
for (const [name, fn] of [
  ['CONF promotion', s => { s.scope = 'CONF'; }],
  ['successful-science flag', s => { s.scientific_admission = true; }],
  ['execution authorisation', s => { s.confirmation_authorised = true; }],
  ['schema bool', s => { s.schema_version = true; }],
  ['current source mismatch', s => { s.sources['assets/code/confirmatory/trees.mjs'] = '0'.repeat(64); }],
  ['additional source entry', s => { s.sources.extra = '0'.repeat(64); }],
  ['unknown scope field', s => { s.approved = true; }],
  ['missing tasks', s => { s.tasks = []; }],
  ['duplicate task', s => { s.tasks.push(s.tasks[0]); }],
  ['task pathname traversal', s => { s.tasks[1].id = '../x'; }],
  ['unknown verifier', s => { s.tasks[1].kind = 'RIVER'; }],
  ['reused run', s => { s.tasks[1].plan.run_id = s.tasks[0].plan.run_id; }],
  ['reused attempt', s => { s.tasks[1].plan.attempt_id = s.tasks[0].plan.attempt_id; }],
  ['reused provenance', s => { s.tasks[1].plan.provenance_prefix = s.tasks[0].plan.provenance_prefix; }],
  ['missing parent', s => { s.tasks[1].parent_id = 'ABSENT'; }],
  ['self-parent', s => { s.tasks[1].parent_id = 'APW'; }],
  ['parent role mismatch', s => { s.tasks[0].parent_id = 'APW'; }],
  ['checkpoint not saved', s => { s.tasks[1].plan.start = 650; }],
  ['other stream parent', s => { s.tasks[1].plan.realisation = 1; }],
  ['wrong resource verifier', s => { s.tasks[2].kind = 'APW_FORK'; }],
  ['forged capsule anchor', s => { s.tasks[1].capsule_sha256 = '0'.repeat(64); }],
  ['missing source commit', s => { s.source_execution_commit = null; }],
  ['duplicate file', s => { s.inventory.files.push(s.inventory.files[0]); }],
  ['path traversal', s => { s.inventory.files[0].path = '../x'; }],
  ['non-normal path', s => { s.inventory.files[0].path = 'PARENT//x'; }],
  ['boolean bytes', s => { s.inventory.files[0].bytes = true; }],
  ['unsafe total', s => { s.inventory.bytes = Number.MAX_SAFE_INTEGER; }],
  ['false directory closure', s => { s.inventory.directories.push('EXTRA'); }],
  ['false byte total', s => { s.inventory.bytes++; }],
  ['fake receipt as proof', s => { s.tasks[1].verification = { status: 'PASS' }; }],
]) test(`specification rejects ${name}`, () => { const s = structuredClone(spec); fn(s); assert.throws(() => validateCampaignSpecification(s, campaignSpecHash(s))); });
test('mutation cannot silently replace the already supplied external digest', () => {
  const s = structuredClone(spec); s.tasks.pop(); assert.throws(() => validateCampaignSpecification(s, digest));
});
for (const [name, mutate] of [
  ['missing file', dir => fs.unlinkSync(path.join(dir, 'APW/PLAN.json'))],
  ['additional file', dir => fs.writeFileSync(path.join(dir, 'note.txt'), 'forged')],
  ['additional empty directory', dir => fs.mkdirSync(path.join(dir, 'empty'))],
  ['altered bytes', dir => fs.appendFileSync(path.join(dir, 'APW/PLAN.json'), ' ')],
  ['symlink file', dir => { fs.unlinkSync(path.join(dir, 'APW/PLAN.json')); fs.symlinkSync(path.join(root, 'APW/PLAN.json'), path.join(dir, 'APW/PLAN.json')); }],
  ['symlink directory', dir => { fs.rmSync(path.join(dir, 'APW'), { recursive: true }); fs.symlinkSync(path.join(root, 'APW'), path.join(dir, 'APW')); }],
  ['hardlink file', dir => { fs.unlinkSync(path.join(dir, 'APW/PLAN.json')); fs.linkSync(path.join(dir, 'CPU/PLAN.json'), path.join(dir, 'APW/PLAN.json')); }],
]) test(`physical preflight rejects ${name}`, () => { const dir = copy(); mutate(dir); assert.throws(() => admitCampaign(dir, spec, { specSha256: digest })); });
test('unavailable historical Git object cannot acquire execution identity', () => {
  const s = structuredClone(spec); s.source_execution_commit = 'f'.repeat(40); assert.throws(() => admitCampaign(root, s, seal(s)));
});
test('a wrong parent-session hash fails even with a newly anchored outer specification', () => {
  const s = structuredClone(spec); s.tasks[1].plan.parent_session_sha256 = '0'.repeat(64); assert.throws(() => admitCampaign(root, s, seal(s)));
});
test('a rehashed but corrupted inner PLAN cannot bypass the native verifier', () => {
  const dir = copy(); const p = path.join(dir, 'APW/PLAN.json'); const v = JSON.parse(fs.readFileSync(p)); v.end = 900;
  fs.writeFileSync(p, JSON.stringify(v) + '\n'); const s = structuredClone(spec); s.inventory = campaignInventory(dir);
  assert.throws(() => admitCampaign(dir, s, seal(s)));
});
