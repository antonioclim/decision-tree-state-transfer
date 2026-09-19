import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXPECTED_SCHEDULE_SHA256 = 'cb005bc52ca98255c834ccd04eabb14c6ece3ecf96a4e68e7a83f346485b3c93';
const EXPECTED_RECORDS = 4480;
const EXPECTED_SHARDS = 56;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function walk(dir, predicate, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, predicate, out); else if (predicate(p)) out.push(p);
  }
  return out;
}
function parseSchedule(text) {
  if (sha256(Buffer.from(text, 'utf8')) !== EXPECTED_SCHEDULE_SHA256) throw new Error('aggregate schedule digest mismatch');
  const lines = text.trimEnd().split(/\r?\n/); const h = lines.shift().split('\t');
  const rows = lines.map((line, i) => { const r = Object.fromEntries(line.split('\t').map((v, j) => [h[j], v])); return { ...r, global_schedule_index: i, realisation: Number(r.realisation), comparator_included: r.comparator_included === '1' }; });
  if (rows.length !== EXPECTED_RECORDS) throw new Error('aggregate schedule row count mismatch');
  return rows;
}
function selfHash(record) {
  const { record_sha256: claimed, ...basis } = record;
  const actual = sha256(JSON.stringify(basis));
  if (!/^[a-f0-9]{64}$/.test(claimed) || claimed !== actual) throw new Error('record self-hash mismatch');
  return claimed;
}
function validateRecord(record, expected) {
  const claimed = selfHash(record);
  if (record.partition !== 'CONF' || record.protocol_id !== 'DT-C8E1-F09-v1.0' || record.scientific_interpretation_authorised !== false
      || record.integrity_status !== 'VALID_RAW_CONFIRMATORY_EVIDENCE' || record.identity?.scenario_id !== expected.scenario_id
      || record.identity?.realisation !== expected.realisation || record.identity?.source_key_hex !== expected.source_key_hex
      || record.identity?.optimizer_key_hex !== expected.optimizer_key_hex || record.identity?.comparator_included !== expected.comparator_included
      || record.source?.feature_sha256?.length !== 64 || record.source?.label_sha256?.length !== 64 || record.checkpoints?.length !== 2) throw new Error(`record envelope mismatch ${expected.source_key_hex}`);
  const horizon = expected.comparator_included ? 5000 : 2000;
  for (const c of record.checkpoints) {
    if (![10000, 20000].includes(c.checkpoint) || c.horizon_executed !== horizon) throw new Error(`checkpoint/horizon mismatch ${expected.source_key_hex}`);
    for (const a of ['PERSIST', 'RESTART-CART', 'CHAMPION-RESEED']) {
      if (!c.state?.[a]?.horizons?.['2000'] || c.state[a].horizons['2000'].predictions !== 2000) throw new Error(`primary state horizon missing ${expected.source_key_hex}:${a}`);
    }
    if (!c.material?.arms?.['MATERIAL-REPLACE']?.horizons?.['2000'] || !c.material?.arms?.['STRUCTURAL-SHAM']?.horizons?.['2000']) throw new Error(`primary material horizon missing ${expected.source_key_hex}`);
    if (expected.comparator_included && c.random_restart_S1?.horizons?.['5000']?.predictions !== 5000) throw new Error(`S1 long horizon missing ${expected.source_key_hex}`);
    if (!expected.comparator_included && c.random_restart_S1 != null) throw new Error(`S1 leaked outside frozen subset ${expected.source_key_hex}`);
  }
  if (record.parent?.provenance?.storage !== 'BOUNDED_IN_MEMORY_COMMITTED_TRACE_PLUS_TRANSCRIPT_DIGEST') throw new Error(`unqualified provenance storage ${expected.source_key_hex}`);
  return claimed;
}
function atomicJson(file, value) { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); fs.renameSync(tmp, file); }

function main() {
  const [downloadsArg, scheduleArg, outArg] = process.argv.slice(2);
  if (!downloadsArg || !scheduleArg || !outArg) throw new Error('usage: node f10_conf_aggregate.mjs DOWNLOADS SCHEDULE OUT');
  const downloads = path.resolve(downloadsArg), schedulePath = path.resolve(scheduleArg), out = path.resolve(outArg);
  const scheduleText = fs.readFileSync(schedulePath, 'utf8'); const schedule = parseSchedule(scheduleText);
  const expectedByKey = new Map(schedule.map((r) => [r.source_key_hex, r]));
  fs.mkdirSync(out, { recursive: true }); const recordsOut = path.join(out, 'records'); fs.mkdirSync(recordsOut, { recursive: true });

  const manifestFiles = walk(downloads, (p) => path.basename(p) === 'SHARD_MANIFEST.json');
  if (manifestFiles.length !== EXPECTED_SHARDS) throw new Error(`expected ${EXPECTED_SHARDS} shard manifests, found ${manifestFiles.length}`);
  const seenShards = new Set(), seenKeys = new Set(), rows = [];
  for (const mf of manifestFiles) {
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (manifest.status !== 'COMPLETE_RAW_CONF_SHARD' || manifest.shards !== EXPECTED_SHARDS || manifest.workers !== 2 || manifest.records !== 80
        || manifest.schedule_sha256 !== EXPECTED_SCHEDULE_SHA256 || manifest.contains_outcome_summary !== false || seenShards.has(manifest.shard)) throw new Error(`invalid/duplicate shard manifest ${mf}`);
    seenShards.add(manifest.shard);
    const shardDir = path.dirname(mf);
    for (const meta of manifest.record_rows) {
      const expected = expectedByKey.get(meta.source_key_hex);
      if (!expected || seenKeys.has(meta.source_key_hex) || expected.global_schedule_index !== meta.global_schedule_index) throw new Error(`unexpected/duplicate record key ${meta.source_key_hex}`);
      const file = path.join(shardDir, 'records', `${meta.source_key_hex}.json`); const bytes = fs.readFileSync(file);
      if (sha256(bytes) !== meta.file_sha256 || bytes.length !== meta.record_bytes) throw new Error(`file digest/size mismatch ${meta.source_key_hex}`);
      const record = JSON.parse(bytes.toString('utf8')); const claimed = validateRecord(record, expected);
      if (claimed !== meta.record_sha256 || record.source.feature_sha256 !== meta.feature_sha256 || record.source.label_sha256 !== meta.label_sha256) throw new Error(`manifest-record mismatch ${meta.source_key_hex}`);
      const destination = path.join(recordsOut, `${meta.source_key_hex}.json`); fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
      seenKeys.add(meta.source_key_hex);
      rows.push({ global_schedule_index: expected.global_schedule_index, scenario_id: expected.scenario_id, realisation: expected.realisation,
        source_key_hex: expected.source_key_hex, comparator_included: expected.comparator_included, record_sha256: claimed,
        file_sha256: meta.file_sha256, record_bytes: meta.record_bytes, feature_sha256: record.source.feature_sha256, label_sha256: record.source.label_sha256 });
    }
  }
  if (seenKeys.size !== EXPECTED_RECORDS || rows.length !== EXPECTED_RECORDS || seenShards.size !== EXPECTED_SHARDS) throw new Error('raw campaign completeness failure');
  rows.sort((a, b) => a.global_schedule_index - b.global_schedule_index);
  for (let i = 0; i < rows.length; i += 1) if (rows[i].global_schedule_index !== i || rows[i].source_key_hex !== schedule[i].source_key_hex) throw new Error('aggregate schedule order/key mismatch');

  const recordRootBasis = rows.map((r) => `${r.global_schedule_index}\t${r.source_key_hex}\t${r.record_sha256}\t${r.file_sha256}`).join('\n') + '\n';
  const sourceRootBasis = rows.map((r) => `${r.global_schedule_index}\t${r.source_key_hex}\t${r.feature_sha256}\t${r.label_sha256}`).join('\n') + '\n';
  const selected = rows.filter((r) => r.comparator_included);
  if (selected.length !== 280) throw new Error('contextual subset cardinality differs from 280');
  const sourceDigestHeader = 'global_schedule_index\tscenario_id\trealisation\tsource_key_hex\tfeature_sha256\tlabel_sha256\n';
  const sourceDigestText = sourceDigestHeader + selected.map((r) => `${r.global_schedule_index}\t${r.scenario_id}\t${r.realisation}\t${r.source_key_hex}\t${r.feature_sha256}\t${r.label_sha256}`).join('\n') + '\n';
  fs.writeFileSync(path.join(out, 'SOURCE_DIGESTS_CONTEXTUAL.tsv'), sourceDigestText, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'EXPANDED_F09_CONF_SCHEDULE.tsv'), scheduleText, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'RAW_RECORD_INDEX.tsv'), 'global_schedule_index\tscenario_id\trealisation\tsource_key_hex\trecord_sha256\tfile_sha256\trecord_bytes\tfeature_sha256\tlabel_sha256\n' + rows.map((r) => `${r.global_schedule_index}\t${r.scenario_id}\t${r.realisation}\t${r.source_key_hex}\t${r.record_sha256}\t${r.file_sha256}\t${r.record_bytes}\t${r.feature_sha256}\t${r.label_sha256}`).join('\n') + '\n', { flag: 'wx' });
  const executionCommits = new Set(manifestFiles.map((mf) => JSON.parse(fs.readFileSync(mf, 'utf8')).execution_commit));
  if (executionCommits.size !== 1 || [...executionCommits][0] !== (process.env.GITHUB_SHA ?? [...executionCommits][0])) throw new Error('mixed execution commits across primary shards');
  const campaign = { schema_version: 1, phase: 'F10_CONFIRMATORY_CAMPAIGN', status: 'COMPLETE_RAW_PRIMARY_CONF_CAMPAIGN', protocol_id: 'DT-C8E1-F09-v1.0',
    schedule_sha256: EXPECTED_SCHEDULE_SHA256, records: rows.length, scenarios: 14, n_per_scenario: 320, shards: EXPECTED_SHARDS, workers_per_shard: 2,
    contextual_source_records: selected.length, execution_commit: [...executionCommits][0], raw_record_root_sha256: sha256(recordRootBasis), source_digest_root_sha256: sha256(sourceRootBasis),
    contextual_source_digest_tsv_sha256: sha256(sourceDigestText), contains_outcome_summary: false, scientific_interpretation_authorised: false,
    note: 'Completeness and integrity manifest only. H1/H2/H3 estimation, significance, practical classification and mechanism interpretation are deferred to F11.' };
  atomicJson(path.join(out, 'CAMPAIGN_MANIFEST.json'), campaign);
  console.log(`F10_PRIMARY_RAW_CAMPAIGN_COMPLETE ${campaign.records} ${campaign.raw_record_root_sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (e) { console.error(e?.stack ?? e); process.exit(1); } }
