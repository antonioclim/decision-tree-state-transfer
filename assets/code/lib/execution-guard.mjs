import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prevent an experiment from overwriting reviewed outputs in a Git working
 * tree. The transactional runner executes in a disposable copy without `.git`.
 *
 * @param {string} importMetaUrl
 */
export function assertSafeExperimentExecution(importMetaUrl) {
  if (process.env.DT_ALLOW_TRACKED_OUTPUT_WRITE === '1') return;

  let directory = path.dirname(fileURLToPath(importMetaUrl));
  while (true) {
    if (fs.existsSync(path.join(directory, '.git'))) {
      throw new Error(
        'Direct execution inside a Git working tree is disabled because this '
        + 'experiment writes reviewed outputs. Use `npm run run -- '
        + '--experiment e03|e04 --run-id <id>`.',
      );
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
