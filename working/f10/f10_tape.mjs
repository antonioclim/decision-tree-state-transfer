import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfirmatoryStream } from '../../assets/code/confirmatory/f10-conf-source.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

export class MaterializedTape {
  constructor(features, labels, manifest) {
    if (!Array.isArray(features) || !Array.isArray(labels) || features.length !== labels.length || features.length !== manifest.rows) throw new Error('invalid materialized tape arrays');
    this.featuresRows = features; this.labels = labels; this.manifest = manifest; this.rows = features.length;
  }
  revealedWindow(end, length = 500) {
    if (!Number.isInteger(end) || !Number.isInteger(length) || length < 1 || end > this.rows || end - length < 0) throw new Error('invalid revealed window');
    return Array.from({ length }, (_, j) => { const i = end - length + j; return { index: i + 1, x: [...this.featuresRows[i]], y: this.labels[i] }; });
  }
  cursor(start, end) { return new TapeCursor(this, start, end); }
}

export class TapeCursor {
  constructor(tape, start, end) {
    if (!(tape instanceof MaterializedTape) || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > tape.rows) throw new Error('invalid tape cursor');
    this.tape = tape; this.next = start; this.end = end; this.pending = null;
  }
  features() {
    if (this.pending !== null || this.next > this.end) throw new Error('feature request violates two-tape order');
    this.pending = this.next;
    return { index: this.pending, x: [...this.tape.featuresRows[this.pending - 1]] };
  }
  label(index) {
    if (index !== this.pending) throw new Error('label reveal does not match pending feature row');
    const y = this.tape.labels[index - 1]; this.pending = null; this.next += 1; return y;
  }
  finish() { if (this.pending !== null || this.next !== this.end + 1) throw new Error('cursor did not consume declared extent'); }
}

export function materializeStream(stream, identity, directory) {
  if (!stream || typeof stream.row !== 'function' || !identity || typeof identity !== 'object') throw new Error('stream and identity required');
  fs.mkdirSync(directory, { recursive: true });
  const feature = ['index\tx0\tx1\tx2\tx3\tx4\tx5\tx6\tx7'];
  const label = ['index\ty'];
  const features = new Array(26000), labels = new Array(26000);
  for (let t = 1; t <= 26000; t += 1) {
    const r = stream.row(t);
    if (r.index !== t || !Array.isArray(r.x) || r.x.length !== 8 || !r.x.every(Number.isFinite) || ![0, 1].includes(r.y)) throw new Error(`invalid source row ${t}`);
    features[t - 1] = [...r.x]; labels[t - 1] = r.y;
    feature.push(`${t}\t${r.x.map((v) => v.toPrecision(17)).join('\t')}`); label.push(`${t}\t${r.y}`);
  }
  const featureBytes = Buffer.from(feature.join('\n') + '\n', 'utf8'), labelBytes = Buffer.from(label.join('\n') + '\n', 'utf8');
  const featurePath = path.join(directory, 'features.tsv'), labelPath = path.join(directory, 'labels.tsv');
  fs.writeFileSync(featurePath, featureBytes, { flag: 'wx' }); fs.writeFileSync(labelPath, labelBytes, { flag: 'wx' });
  // Re-read and hash the bytes that methods are bound to, not only the generation buffers.
  const f2 = fs.readFileSync(featurePath), l2 = fs.readFileSync(labelPath);
  if (!f2.equals(featureBytes) || !l2.equals(labelBytes)) throw new Error('source tape write/read identity failure');
  const manifest = { schema_version: 1, ...identity, rows: 26000, feature_sha256: sha(f2), label_sha256: sha(l2), feature_bytes: f2.length, label_bytes: l2.length,
    encoding: 'UTF-8 TSV; binary64 features rendered with JavaScript Number.toPrecision(17)', separate_feature_label_tapes: true };
  fs.writeFileSync(path.join(directory, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return new MaterializedTape(features, labels, manifest);
}

export function materializeConfSource(scheduleRow, directory) {
  if (!scheduleRow || scheduleRow.comparator_included === undefined || typeof scheduleRow.scenario_id !== 'string' || !Number.isInteger(scheduleRow.realisation)
      || !/^[a-f0-9]{16}$/.test(scheduleRow.source_key_hex) || !/^[a-f0-9]{16}$/.test(scheduleRow.optimizer_key_hex)) throw new Error('canonical F09 schedule row required');
  const stream = new ConfirmatoryStream({ scenario: scheduleRow.scenario_id, realisation: scheduleRow.realisation, streamKey: scheduleRow.source_key_hex });
  return materializeStream(stream, { partition: 'CONF', protocol_namespace: 'DT-C8E1-F09-v1', scenario_id: scheduleRow.scenario_id, realisation: scheduleRow.realisation,
    source_key_hex: scheduleRow.source_key_hex, optimizer_key_hex: scheduleRow.optimizer_key_hex, comparator_included: Boolean(scheduleRow.comparator_included) }, directory);
}
