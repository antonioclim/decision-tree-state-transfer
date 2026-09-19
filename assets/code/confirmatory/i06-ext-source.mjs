/** EXT source materialisation for the locked DT-I05-NST-v1.0 campaign.
 * Every value-producing entry point requires a sealed I06 pre-outcome receipt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cleanLabel, conceptAt, parseScenario, SCENARIOS } from './generator.mjs';
import { keyFromAddress, uniformAt } from './random.mjs';

export const I06_EXT_NAMESPACE = 'DT-I05-NST-v1';
export const I06_EXT_ROWS = 22000;
export const I06_EXT_REALISATIONS_PER_SCENARIO = 80;
export const I06_PROTOCOL_SHA256 = 'd8eaac46d96f0ffc986e3ac5937112910cb28010e6d2cdc42ab08255aa17a622';
export const I06_SEED_SCHEDULE_SHA256 = '9990ceb030a2e85690d5d6595f1f872965c20abfbeb4970f03fc706efc3b2652';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function receiptDigest(record) {
  const copy = structuredClone(record);
  delete copy.receipt_sha256;
  return sha256(Buffer.from(JSON.stringify(stable(copy)), 'utf8'));
}

export function extSourceAddress(scenario, realisation) {
  if (!SCENARIOS.includes(scenario)) throw new TypeError(`unknown EXT scenario: ${scenario}`);
  if (!Number.isInteger(realisation) || realisation < 0 || realisation >= I06_EXT_REALISATIONS_PER_SCENARIO) {
    throw new TypeError('EXT realisation must be 0..79');
  }
  return `${I06_EXT_NAMESPACE}|EXT|SOURCE|scenario=${scenario}|r=${String(realisation).padStart(3, '0')}`;
}

export function extOptimiserAddress(sourceKeyHex) {
  if (!/^[a-f0-9]{16}$/.test(sourceKeyHex)) throw new TypeError('invalid EXT source key');
  return `${I06_EXT_NAMESPACE}|EXT|OPTIMISER|stream=${sourceKeyHex}`;
}

export function validateExtScheduleRow(row) {
  if (!row || typeof row !== 'object' || !SCENARIOS.includes(row.scenario_id)
      || !Number.isInteger(row.realisation) || row.realisation < 0 || row.realisation >= 80
      || typeof row.source_address !== 'string' || typeof row.optimizer_address !== 'string'
      || !/^[a-f0-9]{16}$/.test(row.source_key_hex) || !/^[a-f0-9]{16}$/.test(row.optimizer_key_hex)) {
    throw new Error('canonical I05 EXT schedule row required');
  }
  const sourceAddress = extSourceAddress(row.scenario_id, row.realisation);
  const sourceKey = keyFromAddress(sourceAddress);
  const optimiserAddress = extOptimiserAddress(sourceKey);
  const optimiserKey = keyFromAddress(optimiserAddress);
  if (row.source_address !== sourceAddress || row.source_key_hex !== sourceKey
      || row.optimizer_address !== optimiserAddress || row.optimizer_key_hex !== optimiserKey) {
    throw new Error('I05 EXT schedule row does not match its locked addresses');
  }
  return row;
}

export function verifyI06PreflightReceipt(receiptPath) {
  const absolute = path.resolve(receiptPath);
  const bytes = fs.readFileSync(absolute);
  const receipt = JSON.parse(bytes.toString('utf8'));
  if (receipt.status !== 'PASS_I06_PREOUTCOME_GATE'
      || receipt.protocol_id !== 'DT-I05-NST-v1.0'
      || receipt.namespace !== I06_EXT_NAMESPACE
      || receipt.protocol_sha256 !== I06_PROTOCOL_SHA256
      || receipt.seed_schedule_sha256 !== I06_SEED_SCHEDULE_SHA256
      || receipt.ext_source_values_materialised_before_seal !== false
      || receipt.outcome_values_generated_before_seal !== false
      || receipt.campaign_execution_authorised !== true
      || !/^[a-f0-9]{64}$/.test(receipt.receipt_sha256)
      || receiptDigest(receipt) !== receipt.receipt_sha256) {
    throw new Error('I06 preflight receipt is absent, invalid or does not authorise EXT materialisation');
  }
  return { receipt, receipt_sha256: sha256(bytes), path: absolute };
}

class I06ExtStream {
  constructor(row) {
    validateExtScheduleRow(row);
    this.scenario = parseScenario(row.scenario_id);
    this.realisation = row.realisation;
    this.address = row.source_address;
    this.key = row.source_key_hex;
  }
  features(t) {
    if (!Number.isInteger(t) || t < 1 || t > I06_EXT_ROWS) throw new TypeError('observation index outside EXT design');
    return Array.from({ length: 8 }, (_, f) => {
      const role = `features:${f}`;
      const u = uniformAt(this.key, role, t, 0);
      if (this.scenario.family === 'LOCAL_TREE') return u;
      const v = uniformAt(this.key, role, t, 1);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    });
  }
  label(t, x = this.features(t)) {
    const concept = conceptAt(this.scenario, t, uniformAt(this.key, 'mixture', t, 0));
    const clean = cleanLabel(x, this.scenario, concept);
    return uniformAt(this.key, 'label_noise', t, 0) < 0.1 ? 1 - clean : clean;
  }
}

export class MaterializedExtTape {
  constructor(features, labels, manifest) {
    if (!(features instanceof Float64Array) || !(labels instanceof Uint8Array)
        || features.length !== I06_EXT_ROWS * 8 || labels.length !== I06_EXT_ROWS
        || manifest.rows !== I06_EXT_ROWS) throw new Error('invalid I06 materialized tape');
    this.featureValues = features;
    this.labels = labels;
    this.manifest = manifest;
    this.rows = I06_EXT_ROWS;
  }
  features(index) {
    if (!Number.isInteger(index) || index < 1 || index > this.rows) throw new RangeError('invalid tape index');
    const base = (index - 1) * 8;
    return Array.from(this.featureValues.subarray(base, base + 8));
  }
  revealedWindow(end, length = 500) {
    if (!Number.isInteger(end) || !Number.isInteger(length) || length < 1 || end > this.rows || end - length < 0) {
      throw new Error('invalid revealed window');
    }
    return Array.from({ length }, (_, j) => {
      const index = end - length + 1 + j;
      return { index, x: this.features(index), y: this.labels[index - 1] };
    });
  }
  cursor(start, end) { return new ExtTapeCursor(this, start, end); }
}

export class ExtTapeCursor {
  constructor(tape, start, end) {
    if (!(tape instanceof MaterializedExtTape) || !Number.isInteger(start) || !Number.isInteger(end)
        || start < 1 || end < start || end > tape.rows) throw new Error('invalid EXT tape cursor');
    this.tape = tape; this.next = start; this.end = end; this.pending = null;
  }
  features() {
    if (this.pending !== null || this.next > this.end) throw new Error('feature request violates two-tape order');
    this.pending = this.next;
    return { index: this.pending, x: this.tape.features(this.pending) };
  }
  label(index) {
    if (index !== this.pending) throw new Error('label reveal does not match pending feature row');
    const y = this.tape.labels[index - 1];
    this.pending = null; this.next += 1; return y;
  }
  finish() { if (this.pending !== null || this.next !== this.end + 1) throw new Error('cursor did not consume declared extent'); }
}

/**
 * Materialise all 22,000 rows into exact binary64/uint8 tapes. The binary
 * feature encoding is row-major IEEE-754 binary64 big-endian; row indices are
 * implicit and bound by the manifest. No source value is generated before the
 * receipt has been verified.
 */
export function materializeExtTape(row, { preflightReceiptPath }) {
  const gate = verifyI06PreflightReceipt(preflightReceiptPath);
  validateExtScheduleRow(row);
  const stream = new I06ExtStream(row);
  const values = new Float64Array(I06_EXT_ROWS * 8);
  const labels = new Uint8Array(I06_EXT_ROWS);
  const featureBytes = Buffer.allocUnsafe(I06_EXT_ROWS * 8 * 8);
  for (let t = 1; t <= I06_EXT_ROWS; t += 1) {
    const x = stream.features(t);
    const y = stream.label(t, x);
    labels[t - 1] = y;
    for (let f = 0; f < 8; f += 1) {
      const offset = ((t - 1) * 8 + f);
      values[offset] = x[f];
      featureBytes.writeDoubleBE(x[f], offset * 8);
    }
  }
  const labelBytes = Buffer.from(labels);
  const manifest = {
    schema_version: 1,
    partition: 'EXT',
    protocol_id: 'DT-I05-NST-v1.0',
    protocol_namespace: I06_EXT_NAMESPACE,
    scenario_id: row.scenario_id,
    realisation: row.realisation,
    source_address: row.source_address,
    source_key_hex: row.source_key_hex,
    optimizer_address: row.optimizer_address,
    optimizer_key_hex: row.optimizer_key_hex,
    rows: I06_EXT_ROWS,
    feature_count: 8,
    feature_sha256: sha256(featureBytes),
    label_sha256: sha256(labelBytes),
    feature_bytes: featureBytes.length,
    label_bytes: labelBytes.length,
    feature_encoding: 'row-major IEEE-754 binary64 big-endian; implicit 1-based row index',
    label_encoding: 'one unsigned byte per binary label; implicit 1-based row index',
    separate_feature_label_tapes: true,
    preflight_receipt_file_sha256: gate.receipt_sha256,
    preflight_receipt_claim_sha256: gate.receipt.receipt_sha256,
  };
  return new MaterializedExtTape(values, labels, manifest);
}
