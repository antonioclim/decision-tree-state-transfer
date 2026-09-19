import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createIsolatedRepository } from '../scripts/audit-lib.mjs';

function corruptFirstDataRow(root, relative, mutateFields) {
  const filename = path.join(root, relative);
  const lines = readFileSync(filename, 'utf8').trimEnd().split(/\r?\n/);
  const fields = lines[1].split(',');
  lines[1] = mutateFields(fields).join(',');
  writeFileSync(filename, `${lines.join('\n')}\n`);
}

function runExpectingFailure(root, entryPoint, expectedError) {
  const result = spawnSync(process.execPath, [entryPoint], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0, `${entryPoint} unexpectedly accepted a corrupt dataset`);
  assert.match(result.stderr, expectedError);
}

test('E03 rejects an unknown ELEC2 target before running the stream', () => {
  const sandbox = createIsolatedRepository('decision-tree-e03-invalid-');
  try {
    const dataset = 'assets/code/elec2-continuous-survival/electricity.csv';
    corruptFirstDataRow(sandbox.root, dataset, (fields) => {
      fields[fields.length - 1] = 'SIDEWAYS';
      return fields;
    });
    runExpectingFailure(
      sandbox.root,
      'assets/code/elec2-continuous-survival/continuous-survival-electricity.mjs',
      /unexpected target label "SIDEWAYS"/,
    );
  } finally {
    sandbox.remove();
  }
});

test('E04 rejects a malformed ELEC2 row before running the stream', () => {
  const sandbox = createIsolatedRepository('decision-tree-e04-invalid-');
  try {
    const dataset = 'assets/code/elec2-continuous-survival-fitness-vote/electricity.csv';
    corruptFirstDataRow(sandbox.root, dataset, (fields) => fields.slice(0, -1));
    runExpectingFailure(
      sandbox.root,
      'assets/code/elec2-continuous-survival-fitness-vote/continuous-survival-electricity.mjs',
      /malformed row has 8 fields; expected 9/,
    );
  } finally {
    sandbox.remove();
  }
});

test('the WDBC comparison rejects a non-finite feature before model fitting', () => {
  const sandbox = createIsolatedRepository('decision-tree-wdbc-invalid-');
  try {
    const dataset = 'assets/code/wdbc-cart-comparison/wdbc.csv';
    corruptFirstDataRow(sandbox.root, dataset, (fields) => {
      fields[1] = 'NaN';
      return fields;
    });
    runExpectingFailure(
      sandbox.root,
      'assets/code/wdbc-cart-comparison/compare-wdbc-cart.mjs',
      /non-finite numeric value "NaN"/,
    );
  } finally {
    sandbox.remove();
  }
});

test('the single-run WDBC experiment rejects an unknown diagnosis', () => {
  const sandbox = createIsolatedRepository('decision-tree-wdbc-label-');
  try {
    const dataset = 'assets/code/evolutionary-wdbc-experiment/wdbc.csv';
    corruptFirstDataRow(sandbox.root, dataset, (fields) => {
      fields[0] = 'U';
      return fields;
    });
    runExpectingFailure(
      sandbox.root,
      'assets/code/evolutionary-wdbc-experiment/evolve-wdbc.mjs',
      /unexpected target label "U"/,
    );
  } finally {
    sandbox.remove();
  }
});
