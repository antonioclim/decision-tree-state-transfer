import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertSafeExperimentExecution } from '../assets/code/lib/execution-guard.mjs';

test('execution guard permits a file outside a Git working tree', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-tree-guard-'));
  try {
    const filename = path.join(directory, 'experiment.mjs');
    fs.writeFileSync(filename, '', 'utf8');
    assert.doesNotThrow(() => assertSafeExperimentExecution(pathToFileURL(filename).href));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('execution guard blocks tracked-output execution beneath a .git marker', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-tree-guard-'));
  try {
    fs.mkdirSync(path.join(directory, '.git'));
    const nested = path.join(directory, 'assets', 'code');
    fs.mkdirSync(nested, { recursive: true });
    const filename = path.join(nested, 'experiment.mjs');
    fs.writeFileSync(filename, '', 'utf8');
    assert.throws(
      () => assertSafeExperimentExecution(pathToFileURL(filename).href),
      /Direct execution inside a Git working tree is disabled/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('execution guard permits the runner-scoped explicit override', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-tree-guard-'));
  const previous = process.env.DT_ALLOW_TRACKED_OUTPUT_WRITE;
  try {
    fs.mkdirSync(path.join(directory, '.git'));
    const filename = path.join(directory, 'experiment.mjs');
    fs.writeFileSync(filename, '', 'utf8');
    process.env.DT_ALLOW_TRACKED_OUTPUT_WRITE = '1';
    assert.doesNotThrow(() => assertSafeExperimentExecution(pathToFileURL(filename).href));
  } finally {
    if (previous === undefined) delete process.env.DT_ALLOW_TRACKED_OUTPUT_WRITE;
    else process.env.DT_ALLOW_TRACKED_OUTPUT_WRITE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
