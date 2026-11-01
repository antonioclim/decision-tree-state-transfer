import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');

export const E03_OUTPUTS = [
  'assets/code/elec2-continuous-survival/final-champion-tree.txt',
  'assets/code/elec2-continuous-survival/final-summary.csv',
  'assets/code/elec2-continuous-survival/lineage.csv',
  'assets/code/elec2-continuous-survival/lineage-summary.json',
  'assets/code/elec2-continuous-survival/segment-summary.csv',
  'assets/code/elec2-continuous-survival/selection-events.csv',
  'assets/code/elec2-continuous-survival/stream-results.csv',
];

export const E04_OUTPUTS = [
  'assets/code/elec2-continuous-survival-fitness-vote/final-champion-tree.txt',
  'assets/code/elec2-continuous-survival-fitness-vote/final-summary.csv',
  'assets/code/elec2-continuous-survival-fitness-vote/lineage.csv',
  'assets/code/elec2-continuous-survival-fitness-vote/lineage-summary.json',
  'assets/code/elec2-continuous-survival-fitness-vote/segment-summary.csv',
  'assets/code/elec2-continuous-survival-fitness-vote/selection-events.csv',
  'assets/code/elec2-continuous-survival-fitness-vote/stream-results.csv',
];

export const MANUSCRIPT_ASSET_OUTPUTS = [
  'assets/tables/T01-nearest-work.md',
  'assets/tables/T02-experiment-matrix.md',
  'assets/tables/T03-elec2-metrics.md',
  'assets/tables/T04-feasibility-results.md',
  'assets/diagrams/F03-continuous-survival.mmd',
  'assets/figures/F03-continuous-survival.svg',
  'assets/figures/F04-segment-balanced-accuracy.svg',
];

export const NODE_LIBRARY_MODULES = [
  'assets/code/lib/binary-metrics.mjs',
  'assets/code/lib/execution-guard.mjs',
  'assets/code/lib/greedy-cart.mjs',
  'assets/code/lib/lineage.mjs',
  'assets/code/lib/stream-runtime.mjs',
  'assets/code/lib/strict-csv.mjs',
];

export const NODE_ENTRY_POINTS = [
  {
    id: 'E01 synthetic evolutionary policy tree',
    file: 'assets/code/evolve-policy-tree.js',
    expectedText: 'BEST POLICY',
  },
  {
    id: 'E02 WDBC evolutionary experiment',
    file: 'assets/code/evolutionary-wdbc-experiment/evolve-wdbc.mjs',
    expectedText: 'BEST EVOLVED TREE',
  },
  {
    id: 'E02 WDBC CART comparison',
    file: 'assets/code/wdbc-cart-comparison/compare-wdbc-cart.mjs',
    expectedText: 'SUMMARY (mean',
  },
  {
    id: 'E03 ELEC2 continuous survival',
    file: 'assets/code/elec2-continuous-survival/continuous-survival-electricity.mjs',
    expectedText: 'FINAL PREQUENTIAL RESULTS',
    outputs: E03_OUTPUTS,
  },
  {
    id: 'E04 ELEC2 fitness-weighted vote',
    file: 'assets/code/elec2-continuous-survival-fitness-vote/continuous-survival-electricity.mjs',
    expectedText: 'Evo fitness vote',
    outputs: E04_OUTPUTS,
  },
  {
    id: 'Manuscript asset generation',
    file: 'assets/code/generate-manuscript-assets.mjs',
    expectedText: 'Generated T01-T04',
    outputs: MANUSCRIPT_ASSET_OUTPUTS,
  },
  {
    id: 'Manuscript assembly',
    file: 'manuscript/assemble.mjs',
    expectedText: 'Assembled 9 sections',
    outputs: ['manuscript/article.md'],
  },
];

export const RELEASE_TOOLS = ['bash', 'python3', 'pandoc', 'xelatex', 'inkscape', 'magick'];

export const RELEASE_OUTPUTS = [
  'release/internal/article.tex',
  'release/internal/article.docx',
  'release/internal/article.pdf',
  'release/publisher-preview/article.tex',
  'release/publisher-preview/article.docx',
  'release/publisher-preview/article.pdf',
  'release/build-manifest.json',
  'release/generated/F03-continuous-survival.png',
  'release/generated/F04-segment-balanced-accuracy.png',
];

export const GOLDEN_EXPERIMENTS = [
  {
    id: 'E03',
    entryPoint: 'assets/code/elec2-continuous-survival/continuous-survival-electricity.mjs',
    outputs: E03_OUTPUTS,
  },
  {
    id: 'E04',
    entryPoint: 'assets/code/elec2-continuous-survival-fitness-vote/continuous-survival-electricity.mjs',
    outputs: E04_OUTPUTS,
  },
];

export function sha256File(filename) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filename));
  return hash.digest('hex');
}

export function readBaselineManifest(root = REPOSITORY_ROOT) {
  const filename = path.join(root, 'docs/audit/BASELINE-MANIFEST.json');
  return JSON.parse(readFileSync(filename, 'utf8'));
}

export function readActiveOutputManifest(root = REPOSITORY_ROOT) {
  const filename = path.join(root, 'docs/audit/ACTIVE-OUTPUT-MANIFEST.json');
  if (!existsSync(filename)) return null;
  const manifest = JSON.parse(readFileSync(filename, 'utf8'));
  if (manifest.schemaVersion !== 1) {
    throw new TypeError('ACTIVE-OUTPUT-MANIFEST.json must use schemaVersion 1');
  }
  if (!Array.isArray(manifest.outputOverrides)) {
    throw new TypeError('ACTIVE-OUTPUT-MANIFEST.json must contain outputOverrides');
  }
  const seenPaths = new Set();
  for (const entry of manifest.outputOverrides) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new TypeError('active output entries require a non-empty relative path');
    }
    const normalisedPath = path.posix.normalize(entry.path);
    if (
      entry.path.includes('\\')
      || path.posix.isAbsolute(entry.path)
      || entry.path.split('/').includes('..')
      || normalisedPath !== entry.path
      || normalisedPath === '.'
    ) {
      throw new TypeError(`active output path must remain within the repository: ${entry.path}`);
    }
    if (seenPaths.has(entry.path)) {
      throw new TypeError(`ACTIVE-OUTPUT-MANIFEST.json contains duplicate path ${entry.path}`);
    }
    seenPaths.add(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new TypeError(
        `active output ${entry.path} requires non-negative integer bytes and lowercase SHA-256`,
      );
    }
  }
  return manifest;
}

export function currentOutputEntries(root = REPOSITORY_ROOT) {
  const baseline = readBaselineManifest(root);
  const protectedPaths = new Set([
    ...baseline.researchInputs.map((entry) => entry.path),
    ...baseline.datasets.map((entry) => entry.path),
  ]);
  const byPath = new Map(
    baseline.referenceOutputs.map((entry) => [entry.path, { ...entry }]),
  );
  const active = readActiveOutputManifest(root);
  for (const entry of active?.outputOverrides ?? []) {
    if (protectedPaths.has(entry.path)) {
      throw new Error(
        `active output manifest cannot override protected input or dataset ${entry.path}`,
      );
    }
    byPath.set(entry.path, { ...entry });
  }
  const retirements = active?.retiredOutputs ?? [];
  if (!Array.isArray(retirements)) throw new TypeError('retiredOutputs must be an array');
  const retiredPaths = new Set();
  for (const item of retirements) {
    if (!item || typeof item.path !== 'string' || protectedPaths.has(item.path)) {
      throw new Error('output retirement cannot remove a protected input or dataset');
    }
    if (retiredPaths.has(item.path)) throw new Error(`duplicate retired output ${item.path}`);
    retiredPaths.add(item.path);
    const previous = byPath.get(item.path);
    if (!previous || previous.sha256 !== item.previousSha256) {
      throw new Error(`retirement must identify the current recorded output hash: ${item.path}`);
    }
    if (!/^release\/article\.(pdf|docx|tex)$/.test(item.path)) {
      throw new Error(`retirement is limited to obsolete top-level document outputs: ${item.path}`);
    }
    if (typeof item.reason !== 'string' || item.reason.trim().length < 10
      || !Array.isArray(item.replacements) || item.replacements.length !== 2) {
      throw new Error(`retirement requires a reason and two replacement variants: ${item.path}`);
    }
    const extension = path.posix.extname(item.path);
    const expected = ['internal', 'publisher-preview']
      .map((variant) => `release/${variant}/article${extension}`);
    if (item.replacements.length !== new Set(item.replacements).size
      || expected.some((replacement) => !item.replacements.includes(replacement)
        || !byPath.has(replacement))) {
      throw new Error(`retirement replacements are not both recorded variants: ${item.path}`);
    }
    byPath.delete(item.path);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function expectedHashMap(root = REPOSITORY_ROOT) {
  const baseline = readBaselineManifest(root);
  const entries = [
    ...baseline.researchInputs,
    ...baseline.datasets,
    ...currentOutputEntries(root),
  ];
  return new Map(entries.map((entry) => [entry.path, entry.sha256]));
}

export function verifyManifest(root = REPOSITORY_ROOT) {
  const baseline = readBaselineManifest(root);
  const entries = [
    ...baseline.researchInputs,
    ...baseline.datasets,
    ...currentOutputEntries(root),
  ];
  const failures = [];

  for (const entry of entries) {
    const filename = path.join(root, entry.path);
    if (!existsSync(filename)) {
      failures.push(`${entry.path}: missing`);
      continue;
    }

    const observedSize = statSync(filename).size;
    const observedHash = sha256File(filename);
    if (observedSize !== entry.bytes) {
      failures.push(`${entry.path}: size ${observedSize}, expected ${entry.bytes}`);
    }
    if (observedHash !== entry.sha256) {
      failures.push(`${entry.path}: SHA-256 ${observedHash}, expected ${entry.sha256}`);
    }
  }

  return { checked: entries.length, failures };
}

function shouldCopy(source) {
  const relative = path.relative(REPOSITORY_ROOT, source);
  if (!relative) return true;
  const first = relative.split(path.sep)[0];
  return !['.git', 'node_modules', 'coverage', 'runs', 'artifacts'].includes(first);
}

export function createIsolatedRepository(prefix = 'decision-tree-audit-') {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const root = path.join(base, 'repository');
  cpSync(REPOSITORY_ROOT, root, {
    recursive: true,
    filter: shouldCopy,
    preserveTimestamps: true,
  });
  return {
    base,
    root,
    remove() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function commandExists(command) {
  const result = spawnSync('sh', ['-c', `command -v -- ${command}`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

export function runCommand(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TZ: 'UTC',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      ...options.env,
    },
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

  if (result.error) {
    /** @type {Error & {stdout?: string, stderr?: string}} */
    const error = new Error(`${command} failed before completion: ${result.error.message}`);
    error.cause = result.error;
    error.stdout = result.stdout ?? '';
    error.stderr = result.stderr ?? '';
    throw error;
  }

  if (result.status !== 0) {
    /** @type {Error & {stdout?: string, stderr?: string}} */
    const error = new Error(`${command} exited with status ${result.status}`);
    error.stdout = result.stdout ?? '';
    error.stderr = result.stderr ?? '';
    throw error;
  }

  return {
    elapsedMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function removeFiles(root, files) {
  for (const relative of files) {
    rmSync(path.join(root, relative), { force: true });
  }
}

export function assertNonEmptyFiles(root, files) {
  const failures = [];
  for (const relative of files) {
    const filename = path.join(root, relative);
    if (!existsSync(filename)) {
      failures.push(`${relative}: missing`);
    } else if (statSync(filename).size === 0) {
      failures.push(`${relative}: empty`);
    }
  }
  return failures;
}

export function formatFailure(error) {
  const sections = [error.message];
  if (error.stdout) sections.push(`stdout:\n${error.stdout.slice(-4000)}`);
  if (error.stderr) sections.push(`stderr:\n${error.stderr.slice(-4000)}`);
  return sections.join('\n');
}
