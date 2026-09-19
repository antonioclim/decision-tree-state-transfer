import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DevelopmentStream, SCENARIOS } from './generator.mjs';
import { floatBits } from './trees.mjs';
import { strictJson } from './evidence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export function validateSourcePlan(plan) {
  if (!plan || Object.keys(plan).sort().join(',') !== 'end,partition,protocol_sha256,realisation,scenario,schema_version'
    || plan.schema_version !== 1 || plan.partition !== 'DEV' || !SCENARIOS.includes(plan.scenario)
    || !Number.isSafeInteger(plan.realisation) || plan.realisation < 0 || plan.realisation > 2
    || !Number.isSafeInteger(plan.end) || plan.end < 2001 || plan.end > 26000
    || !/^[a-f0-9]{64}$/.test(plan.protocol_sha256)) throw new Error('bounded exact DEV source plan required');
  const protocol = fs.readFileSync(new URL('../../../working/phase9/PROTOCOL_SPEC.json', import.meta.url));
  if (plan.protocol_sha256 !== sha(protocol)) throw new Error('protocol does not match the current pinned bytes');
  return structuredClone(plan);
}

/** Separate feature and label tapes allow a reader to postpone reading each future label. */
export function exportContextualSource(directory, input) {
  const plan = validateSourcePlan(input);
  fs.mkdirSync(directory);
  const stream = new DevelopmentStream({ scenario: plan.scenario, realisation: plan.realisation });
  const xRows = []; const yRows = [];
  for (let i = 1; i <= plan.end; i++) {
    const x = stream.features(i);
    xRows.push(strictJson({ index: i, bits: x.map(floatBits) }) + '\n');
    yRows.push(strictJson({ index: i, label: stream.label(i, x) }) + '\n');
  }
  const files = [];
  const tapes = /** @type {Array<[string, string[]]>} */ ([['features.jsonl.gz', xRows], ['labels.jsonl.gz', yRows]]);
  for (const [file, rows] of tapes) {
    const raw = Buffer.from(rows.join('')); const zipped = gzipSync(raw, { level: 6 });
    fs.writeFileSync(path.join(directory, file), zipped, { flag: 'wx' });
    files.push({ file, rows: plan.end, raw_bytes: raw.length, raw_sha256: sha(raw), gzip_bytes: zipped.length, gzip_sha256: sha(zipped) });
  }
  const result = { schema_version: 1, format: 'DEV_SEPARATE_BINARY64_TAPES_V1', plan, stream_key: stream.key,
    feature_count: 8, prefix_rows: 2000, files, scientific_admission: false, confirmation_authorised: false };
  const bytes = Buffer.from(strictJson(result) + '\n');
  fs.writeFileSync(path.join(directory, 'SOURCE.json'), bytes, { flag: 'wx' });
  return { manifest: result, sha256: sha(bytes) };
}

export function verifyContextualSource(directory, input, externalHash) {
  const plan = validateSourcePlan(input);
  if (!/^[a-f0-9]{64}$/.test(externalHash ?? '')) throw new Error('external source digest required');
  if (!fs.lstatSync(directory).isDirectory() || fs.readdirSync(directory).sort().join(',') !== 'SOURCE.json,features.jsonl.gz,labels.jsonl.gz') {
    throw new Error('unexpected source inventory');
  }
  function read(file, limit) {
    const p = path.join(directory, file); const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > limit) throw new Error('bounded unlinked source file required');
    return fs.readFileSync(p);
  }
  const bytes = read('SOURCE.json', 1024 * 1024);
  if (sha(bytes) !== externalHash) throw new Error('source digest mismatch');
  const m = JSON.parse(bytes.toString('utf8'));
  const stream = new DevelopmentStream({ scenario: plan.scenario, realisation: plan.realisation });
  if (strictJson(m) + '\n' !== bytes.toString('utf8') || strictJson(m.plan) !== strictJson(plan)
    || m.format !== 'DEV_SEPARATE_BINARY64_TAPES_V1' || m.stream_key !== stream.key
    || m.feature_count !== 8 || m.prefix_rows !== 2000 || !Array.isArray(m.files) || m.files.length !== 2
    || m.scientific_admission !== false || m.confirmation_authorised !== false) throw new Error('source manifest semantics differ');
  for (let tape = 0; tape < 2; tape++) {
    const d = m.files[tape]; const file = tape === 0 ? 'features.jsonl.gz' : 'labels.jsonl.gz';
    if (d.file !== file || d.rows !== plan.end) throw new Error('source tape identity differs');
    const z = read(file, 16 * 1024 ** 2);
    const raw = gunzipSync(z, { maxOutputLength: 16 * 1024 ** 2 });
    if (z.length !== d.gzip_bytes || sha(z) !== d.gzip_sha256 || raw.length !== d.raw_bytes || sha(raw) !== d.raw_sha256) {
      throw new Error('source tape bytes differ');
    }
    const expected = createHash('sha256');
    for (let i = 1; i <= plan.end; i++) {
      const x = stream.features(i);
      expected.update(strictJson(tape === 0 ? { index: i, bits: x.map(floatBits) } : { index: i, label: stream.label(i, x) }) + '\n');
    }
    if (expected.digest('hex') !== d.raw_sha256) throw new Error('source tape is not the declared DEV generator output');
  }
  if (sha(read('SOURCE.json', 1024 * 1024)) !== externalHash) throw new Error('source manifest changed');
  return { status: 'PASS_SOURCE_GENERATOR_RECONSTRUCTION', source_sha256: externalHash, rows: plan.end, features: 8,
    partition: 'DEV', scientific_admission: false, confirmation_authorised: false };
}
