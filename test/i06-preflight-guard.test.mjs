import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  extSourceAddress,
  materializeExtTape,
  validateExtScheduleRow,
  verifyI06PreflightReceipt,
} from '../assets/code/confirmatory/i06-ext-source.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOCK = path.join(ROOT, 'working/i06/lock');
const PROTOCOL_SHA = 'd8eaac46d96f0ffc986e3ac5937112910cb28010e6d2cdc42ab08255aa17a622';
const SCHEDULE_SHA = '9990ceb030a2e85690d5d6595f1f872965c20abfbeb4970f03fc706efc3b2652';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
function sign(record) {
  const copy = structuredClone(record);
  delete copy.receipt_sha256;
  return { ...record, receipt_sha256: sha(Buffer.from(JSON.stringify(stable(copy)), 'utf8')) };
}
function readSchedule() {
  const lines = fs.readFileSync(path.join(LOCK, 'I05_STUDY2_SEED_SCHEDULE.tsv'), 'utf8').trimEnd().split('\n');
  const header = lines.shift().split('\t');
  return lines.map((line) => Object.fromEntries(header.map((key, i) => [key, i === 1 ? Number(line.split('\t')[i]) : line.split('\t')[i]])));
}

test('locked I05 protocol and seed schedule have exact authorised digests', () => {
  assert.equal(sha(fs.readFileSync(path.join(LOCK, 'I05_STUDY2_PROTOCOL_LOCK.json'))), PROTOCOL_SHA);
  assert.equal(sha(fs.readFileSync(path.join(LOCK, 'I05_STUDY2_SEED_SCHEDULE.tsv'))), SCHEDULE_SHA);
});

test('all 1,120 EXT schedule rows are exact, unique and namespace-disjoint from Study 1', () => {
  const rows = readSchedule();
  assert.equal(rows.length, 1120);
  const sources = new Set(); const optimisers = new Set();
  for (const row of rows) {
    validateExtScheduleRow(row);
    assert.ok(row.source_address.startsWith('DT-I05-NST-v1|EXT|SOURCE|'));
    assert.ok(row.optimizer_address.startsWith('DT-I05-NST-v1|EXT|OPTIMISER|'));
    assert.ok(!row.source_address.includes('DT-C8E1-F09-v1'));
    sources.add(row.source_key_hex); optimisers.add(row.optimizer_key_hex);
  }
  assert.equal(sources.size, 1120);
  assert.equal(optimisers.size, 1120);
  assert.equal([...sources].filter((x) => optimisers.has(x)).length, 0);
  assert.equal(extSourceAddress('LOCAL_TREE-ABRUPT-MILD', 0), rows[0].source_address);
  assert.equal(extSourceAddress('OBLIQUE-STATIONARY-NONE', 79), rows.at(-1).source_address);
});

test('EXT materialisation fails before a valid sealed preflight receipt exists', () => {
  const row = readSchedule()[0];
  const missing = path.join(os.tmpdir(), `i06-missing-${process.pid}.json`);
  assert.throws(() => materializeExtTape(row, { preflightReceiptPath: missing }), /ENOENT|preflight/);
});

test('forged or internally inconsistent preflight receipts fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i06-forged-'));
  const file = path.join(dir, 'receipt.json');
  const base = {
    schema_version: 1,
    status: 'PASS_I06_PREOUTCOME_GATE',
    protocol_id: 'DT-I05-NST-v1.0',
    namespace: 'DT-I05-NST-v1',
    protocol_sha256: PROTOCOL_SHA,
    seed_schedule_sha256: SCHEDULE_SHA,
    ext_source_values_materialised_before_seal: false,
    outcome_values_generated_before_seal: false,
    campaign_execution_authorised: true,
  };
  fs.writeFileSync(file, `${JSON.stringify({ ...base, receipt_sha256: '0'.repeat(64) }, null, 2)}\n`);
  assert.throws(() => verifyI06PreflightReceipt(file), /invalid/);
  fs.writeFileSync(file, `${JSON.stringify(sign({ ...base, ext_source_values_materialised_before_seal: true }), null, 2)}\n`);
  assert.throws(() => verifyI06PreflightReceipt(file), /invalid/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a correctly signed preflight control record verifies without generating an EXT value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i06-valid-receipt-'));
  const file = path.join(dir, 'receipt.json');
  const record = sign({
    schema_version: 1,
    status: 'PASS_I06_PREOUTCOME_GATE',
    protocol_id: 'DT-I05-NST-v1.0',
    namespace: 'DT-I05-NST-v1',
    protocol_sha256: PROTOCOL_SHA,
    seed_schedule_sha256: SCHEDULE_SHA,
    ext_source_values_materialised_before_seal: false,
    outcome_values_generated_before_seal: false,
    campaign_execution_authorised: true,
    synthetic_test_record_only: true,
  });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const verified = verifyI06PreflightReceipt(file);
  assert.equal(verified.receipt.receipt_sha256, record.receipt_sha256);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('source code checks the receipt before constructing the EXT stream', () => {
  const text = fs.readFileSync(path.join(ROOT, 'assets/code/confirmatory/i06-ext-source.mjs'), 'utf8');
  const gate = text.indexOf('verifyI06PreflightReceipt(preflightReceiptPath)');
  const stream = text.indexOf('new I06ExtStream(row)');
  assert.ok(gate >= 0 && stream > gate);
});
