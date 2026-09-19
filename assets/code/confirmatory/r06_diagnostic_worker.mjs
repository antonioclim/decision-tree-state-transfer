import { DiagnosticBaseline } from './diagnostic-baselines.mjs';

// A fixed row service for the actual four Node diagnostics. No source tape is opened.
const METHODS = ['LAST_LABEL', 'PREFIX_MAJORITY', 'FROZEN_CART', 'ROLLING_CART'];
const MAX_LINE = 16384;
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function main() {
  const extended = process.argv.length === 4 && process.argv[3] === '--r08a-dev-22000';
  if (process.argv.length !== 3 && !extended) throw new Error('one configuration and optional exact R08A profile are required');
  const config = JSON.parse(process.argv[2]);
  if (Object.keys(config).sort().join(',') !== 'kind,method,seed,stress'
      || config.kind !== 'R06_DIAGNOSTIC' || !METHODS.includes(config.method)
      || config.stress !== null || typeof config.seed !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(config.seed) || BigInt(config.seed) >= 2n ** 64n) {
    throw new Error('exact diagnostic profile and lossless scheduled seed string required');
  }
  output({ kind: 'ready', pid: process.pid, model: {
    implementation: extended ? 'R08A_ACTUAL_NODE_DIAGNOSTIC_22000' : 'R06_ACTUAL_NODE_DIAGNOSTIC', method: config.method,
    pairing_seed_decimal_string: config.seed, initial_prefix_rows: 2000,
    feature_count: 8, scientific_admission: false,
  } });
  let model = null;
  let learned = 0;
  let sequence = 0;
  let pending = null;
  let prefix = [];
  let buffered = Buffer.alloc(0);
  function request(raw) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    const value = JSON.parse(text);
    if (!value || Object.keys(value).sort().join(',') !== 'index,seq,stage,x,y'
        || !Number.isSafeInteger(value.seq) || value.seq !== sequence + 1
        || !Number.isSafeInteger(value.index) || value.index !== learned + 1 || value.index > (extended ? 22000 : 2500)
        || !['predict', 'learn'].includes(value.stage) || value.x === null || Array.isArray(value.x)
        || typeof value.x !== 'object' || Object.keys(value.x).sort().join(',') !== 'x0,x1,x2,x3,x4,x5,x6,x7'
        || Object.values(value.x).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('chronological diagnostic request or feature identity differs');
    }
    // This fixed schema has no free-text keys or values. Reject duplicate or escaped
    // spellings of its thirteen keys before accepting otherwise valid JSON.
    for (const name of ['seq', 'stage', 'index', 'x', 'y', ...Array.from({ length: 8 }, (_, i) => `x${i}`)]) {
      if ([...text.matchAll(new RegExp(`"${name}"\\s*:`, 'g'))].length !== 1) {
        throw new Error('duplicate or nonliteral diagnostic request key');
      }
    }
    sequence++;
    const x = Array.from({ length: 8 }, (_, i) => value.x[`x${i}`]);
    let result = null;
    if (value.stage === 'predict') {
      if (value.y !== null || learned < 2000 || pending !== null) {
        throw new Error('features-only prediction after the full prefix is required');
      }
      pending = x;
      result = model.predictInput({ index: value.index, x });
      if (result !== 0 && result !== 1) throw new Error('diagnostic prediction is not binary');
    } else {
      if ((value.y !== 0 && value.y !== 1) || !Number.isInteger(value.y)
          || (learned >= 2000 && (pending === null || x.some((v, i) => !Object.is(v, pending[i]))))) {
        throw new Error('learn requires the binary label and identical previously predicted features');
      }
      if (learned < 2000) {
        prefix.push({ index: value.index, x, y: value.y });
        if (value.index === 2000) {
          model = new DiagnosticBaseline(config.method, prefix, { featureCount: 8 });
          prefix = [];
        }
      } else {
        model.reveal(value.y);
      }
      learned++;
      pending = null;
    }
    output({ kind: 'reply', seq: sequence, result });
  }
  for await (const chunk of process.stdin) {
    buffered = Buffer.concat([buffered, chunk]);
    let newline;
    while ((newline = buffered.indexOf(10)) !== -1) {
      if (newline + 1 > MAX_LINE) throw new Error('diagnostic request exceeds byte bound');
      request(buffered.subarray(0, newline));
      buffered = buffered.subarray(newline + 1);
    }
    if (buffered.length > MAX_LINE) throw new Error('unbounded incomplete diagnostic request');
  }
  if (buffered.length || pending !== null) throw new Error('diagnostic input ended mid-request or before learning');
  if (extended && learned !== 22000) throw new Error('R08A diagnostic denominator is incomplete');
}

main().catch((error) => {
  output({ kind: 'error', type: error.name, message: error.message.slice(0, 1000) });
  process.exitCode = 2;
});
