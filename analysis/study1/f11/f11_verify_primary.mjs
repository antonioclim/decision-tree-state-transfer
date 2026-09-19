import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EXPECTED_RECORDS = 4480;
const EXPECTED_SCHEDULE_SHA256 = 'cb005bc52ca98255c834ccd04eabb14c6ece3ecf96a4e68e7a83f346485b3c93';
const EXPECTED_RAW_ROOT = '35f67440cf96cde5bf72dd767aba7a61339b1f375cfdcc04f2e271d38f9387f5';
const EXPECTED_SOURCE_ROOT = 'f0e9a072f67156978cb576f3aec5e81fda817b0c41d1bdc3505fe3f9e258cc56';
const EXPECTED_BRIDGE_SHA256 = 'aca2abe9d241fbedcbde15ceb161f1d2cd23417e92c314fc60df7ff935bce73a';
const sha256 = (x) => createHash('sha256').update(x).digest('hex');

function parseTsv(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  const header = lines.shift().split('\t');
  return lines.map((line) => Object.fromEntries(line.split('\t').map((value, i) => [header[i], value])));
}
function selfHash(record) {
  const { record_sha256: claimed, ...basis } = record;
  const actual = sha256(Buffer.from(JSON.stringify(basis), 'utf8'));
  if (claimed !== actual) throw new Error(`record self-hash mismatch: ${record.identity?.source_key_hex}`);
  return claimed;
}
function main() {
  const [rootArg, outArg] = process.argv.slice(2);
  if (!rootArg || !outArg) throw new Error('usage: node f11_verify_primary.mjs PRIMARY_DIR OUTPUT_JSON');
  const root = path.resolve(rootArg), out = path.resolve(outArg);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'CAMPAIGN_MANIFEST.json'), 'utf8'));
  if (manifest.status !== 'COMPLETE_RAW_PRIMARY_CONF_CAMPAIGN' || manifest.records !== EXPECTED_RECORDS ||
      manifest.protocol_id !== 'DT-C8E1-F09-v1.0' || manifest.raw_record_root_sha256 !== EXPECTED_RAW_ROOT ||
      manifest.source_digest_root_sha256 !== EXPECTED_SOURCE_ROOT || manifest.contextual_source_digest_tsv_sha256 !== EXPECTED_BRIDGE_SHA256) {
    throw new Error('primary campaign manifest mismatch');
  }
  const scheduleBytes = fs.readFileSync(path.join(root, 'EXPANDED_F09_CONF_SCHEDULE.tsv'));
  if (sha256(scheduleBytes) !== EXPECTED_SCHEDULE_SHA256) throw new Error('expanded schedule digest mismatch');
  const bridgeBytes = fs.readFileSync(path.join(root, 'SOURCE_DIGESTS_CONTEXTUAL.tsv'));
  if (sha256(bridgeBytes) !== EXPECTED_BRIDGE_SHA256) throw new Error('contextual source bridge digest mismatch');
  const indexRows = parseTsv(fs.readFileSync(path.join(root, 'RAW_RECORD_INDEX.tsv'), 'utf8'));
  if (indexRows.length !== EXPECTED_RECORDS) throw new Error(`raw record index cardinality ${indexRows.length}`);
  const seen = new Set(), recordBasis = [], sourceBasis = [];
  for (let i = 0; i < indexRows.length; i += 1) {
    const row = indexRows[i];
    if (Number(row.global_schedule_index) !== i || seen.has(row.source_key_hex)) throw new Error('index order or duplicate source key');
    const file = path.join(root, 'records', `${row.source_key_hex}.json`);
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== row.file_sha256 || bytes.length !== Number(row.record_bytes)) throw new Error(`record file digest/size mismatch ${row.source_key_hex}`);
    const record = JSON.parse(bytes.toString('utf8'));
    const claimed = selfHash(record);
    if (claimed !== row.record_sha256 || record.identity?.source_key_hex !== row.source_key_hex ||
        record.identity?.scenario_id !== row.scenario_id || Number(record.identity?.realisation) !== Number(row.realisation) ||
        record.source?.feature_sha256 !== row.feature_sha256 || record.source?.label_sha256 !== row.label_sha256 ||
        record.partition !== 'CONF' || record.protocol_id !== 'DT-C8E1-F09-v1.0' ||
        record.integrity_status !== 'VALID_RAW_CONFIRMATORY_EVIDENCE' || record.checkpoints?.length !== 2) {
      throw new Error(`record/index envelope mismatch ${row.source_key_hex}`);
    }
    seen.add(row.source_key_hex);
    recordBasis.push(`${i}\t${row.source_key_hex}\t${row.record_sha256}\t${row.file_sha256}`);
    sourceBasis.push(`${i}\t${row.source_key_hex}\t${row.feature_sha256}\t${row.label_sha256}`);
  }
  const rawRoot = sha256(Buffer.from(recordBasis.join('\n') + '\n', 'utf8'));
  const sourceRoot = sha256(Buffer.from(sourceBasis.join('\n') + '\n', 'utf8'));
  if (rawRoot !== EXPECTED_RAW_ROOT || sourceRoot !== EXPECTED_SOURCE_ROOT) throw new Error('independently reconstructed root mismatch');
  const receipt = {schema_version:1, phase:'F11_STATISTICS_AND_MECHANISM', status:'PASS_F10_PRIMARY_INPUT_INTEGRITY',
    records:EXPECTED_RECORDS, unique_source_keys:seen.size, schedule_sha256:EXPECTED_SCHEDULE_SHA256,
    raw_record_root_sha256:rawRoot, source_digest_root_sha256:sourceRoot,
    contextual_source_bridge_sha256:EXPECTED_BRIDGE_SHA256, outcome_interpretation_performed:false};
  fs.mkdirSync(path.dirname(out), {recursive:true});
  fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n', {flag:'wx'});
  console.log(JSON.stringify(receipt));
}
try { main(); } catch (e) { console.error(e?.stack ?? e); process.exit(1); }
