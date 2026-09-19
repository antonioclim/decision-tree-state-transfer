import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { strictJson } from './evidence.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const MAX_MANIFEST = 32 * 1024 * 1024;
const MAX_CHUNKS = 100000;
export const CHUNK_BYTES = 1024 * 1024;

function readRegular(filename, limit) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('not a bounded regular archive file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function safeDirectory(directory) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('archive directory must not be a symlink');
}
function writeNew(filename, bytes) {
  const fd = fs.openSync(filename, 'wx');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(n) || n <= 0 || n > bytes.length - offset) throw new Error('invalid short archive write');
      offset += n;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Reversible transport only. No learner events, counters or semantics are changed. */
export class ChunkedEvidenceWriter {
  constructor(directory, metadata, { chunkBytes = CHUNK_BYTES } = {}) {
    if (!metadata || !['DEV', 'FIXTURE'].includes(metadata.partition) || !metadata.attempt_id
      || !metadata.run_id || !HASH.test(metadata.protocol_sha256)) throw new Error('DEV/FIXTURE metadata required');
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 128 || chunkBytes > CHUNK_BYTES) throw new Error('invalid chunk bound');
    strictJson(metadata);
    fs.mkdirSync(directory); this.directory = directory; this.metadata = structuredClone(metadata);
    this.chunkBytes = chunkBytes; this.parts = []; this.pendingBytes = 0; this.pendingRows = 0;
    this.rows = 0; this.bytes = 0; this.chunks = []; this.digest = createHash('sha256');
    this.closed = false; this.poisoned = false; this.maxBufferedBytes = 0;
    this.started = { schema_version: 1, transport: 'CANONICAL_JSONL_GZIP_CHUNKS_V1', metadata: this.metadata,
      chunk_bytes: chunkBytes, gzip_level: 6, status: 'RUNNING' };
    writeNew(path.join(directory, 'started.json'), Buffer.from(strictJson(this.started)+'\n'));
  }
  append(event) {
    if (this.closed || this.poisoned) throw new Error('archive is closed or poisoned');
    try {
      const bytes = Buffer.from(strictJson(event)+'\n');
      if (bytes.length > this.chunkBytes) throw new Error('event exceeds chunk bound');
      if (this.pendingBytes + bytes.length > this.chunkBytes) this.flush();
      this.parts.push(bytes); this.pendingBytes += bytes.length; this.pendingRows++;
      this.maxBufferedBytes = Math.max(this.maxBufferedBytes, this.pendingBytes);
      this.digest.update(bytes); this.rows++; this.bytes += bytes.length;
      if (!Number.isSafeInteger(this.bytes)) throw new Error('unsafe archive size');
    } catch (error) { this.poisoned = true; throw error; }
  }
  flush() {
    if (!this.pendingBytes) return;
    if (this.chunks.length >= MAX_CHUNKS) throw new Error('chunk count limit exceeded');
    const raw = Buffer.concat(this.parts, this.pendingBytes); const zipped = gzipSync(raw, { level: 6 });
    const file = `${String(this.chunks.length).padStart(8, '0')}.jsonl.gz`;
    writeNew(path.join(this.directory, file), zipped);
    this.chunks.push({ file, raw_bytes: raw.length, gzip_bytes: zipped.length, rows: this.pendingRows,
      raw_sha256: sha(raw), gzip_sha256: sha(zipped) });
    this.parts = []; this.pendingRows = 0; this.pendingBytes = 0;
  }
  finish(status = 'COMPLETE') {
    if (this.closed || this.poisoned || !['COMPLETE', 'ALGORITHMIC_FAILURE'].includes(status)) throw new Error('invalid archive closure');
    try {
      this.flush();
      const result = { ...this.started, status, evidence_rows: this.rows, evidence_bytes: this.bytes,
        events_sha256: this.digest.digest('hex'), max_buffered_raw_bytes: this.maxBufferedBytes, chunks: this.chunks };
      const bytes = Buffer.from(strictJson(result)+'\n');
      if (bytes.length > MAX_MANIFEST) throw new Error('manifest size bound exceeded');
      writeNew(path.join(this.directory, 'finished.json'), bytes); this.closed = true;
      return { ...result, manifest_sha256: sha(bytes), gzip_bytes: this.chunks.reduce((n,c) => n+c.gzip_bytes, 0) };
    } catch (error) { this.poisoned = true; throw error; }
  }
}

/** Supply a digest from the enclosing run manifest, not one learnt from the same file. */
export function* readChunkedEvents(directory, audit, { expectedManifestSha256 = undefined } = {}) {
  safeDirectory(directory);
  if (!HASH.test(expectedManifestSha256 ?? '')) throw new Error('expected manifest digest is required');
  const bytes = readRegular(path.join(directory, 'finished.json'), MAX_MANIFEST);
  if (sha(bytes) !== expectedManifestSha256) throw new Error('archive manifest digest mismatch');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const result = JSON.parse(text);
  if (strictJson(result)+'\n' !== text || result.schema_version !== 1
    || result.transport !== 'CANONICAL_JSONL_GZIP_CHUNKS_V1' || !['COMPLETE','ALGORITHMIC_FAILURE'].includes(result.status)
    || !['DEV','FIXTURE'].includes(result.metadata?.partition) || !HASH.test(result.metadata?.protocol_sha256 ?? '')
    || !Number.isSafeInteger(result.chunk_bytes) || result.chunk_bytes < 128 || result.chunk_bytes > CHUNK_BYTES
    || !Array.isArray(result.chunks) || result.chunks.length > MAX_CHUNKS
    || !Number.isSafeInteger(result.evidence_rows) || result.evidence_rows < 0
    || !Number.isSafeInteger(result.evidence_bytes) || result.evidence_bytes < 0 || !HASH.test(result.events_sha256)) throw new Error('invalid archive manifest');
  const startedBytes = readRegular(path.join(directory, 'started.json'), MAX_MANIFEST);
  const started = { schema_version: result.schema_version, transport: result.transport, metadata: result.metadata,
    chunk_bytes: result.chunk_bytes, gzip_level: 6, status: 'RUNNING' };
  if (startedBytes.toString('utf8') !== strictJson(started)+'\n') throw new Error('started/finished metadata mismatch');
  const allowed = new Set(['started.json','finished.json', ...result.chunks.map(c => c.file)]);
  if (allowed.size !== result.chunks.length + 2 || fs.readdirSync(directory).some(f => !allowed.has(f))) throw new Error('duplicate or unlisted archive member');
  let rawTotal=0; let rowTotal=0; let gzipTotal=0; const digest=createHash('sha256');
  for (const [i, c] of result.chunks.entries()) {
    if (c.file !== `${String(i).padStart(8,'0')}.jsonl.gz` || !Number.isSafeInteger(c.raw_bytes) || c.raw_bytes < 1 || c.raw_bytes > result.chunk_bytes
      || !Number.isSafeInteger(c.gzip_bytes) || c.gzip_bytes < 1 || c.gzip_bytes > CHUNK_BYTES + 2048
      || !Number.isSafeInteger(c.rows) || c.rows < 1 || !HASH.test(c.raw_sha256) || !HASH.test(c.gzip_sha256)) throw new Error('invalid chunk descriptor');
    const zip = readRegular(path.join(directory,c.file), CHUNK_BYTES+2048);
    if (zip.length !== c.gzip_bytes || sha(zip) !== c.gzip_sha256) throw new Error('compressed chunk mismatch');
    const raw = gunzipSync(zip, { maxOutputLength: result.chunk_bytes });
    if (raw.length !== c.raw_bytes || sha(raw) !== c.raw_sha256 || raw.at(-1) !== 10) throw new Error('uncompressed chunk mismatch');
    digest.update(raw); rawTotal += raw.length; gzipTotal += zip.length;
    let start=0; let rows=0;
    while (start < raw.length) {
      const end=raw.indexOf(10,start);
      const text=new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(start,end));
      const event=JSON.parse(text);
      if (strictJson(event) !== text) throw new Error('noncanonical or duplicate-key chunk record');
      rows++; yield event; start=end+1;
    }
    if (rows !== c.rows) throw new Error('chunk row count mismatch');
    rowTotal += rows;
  }
  const transcript= digest.digest('hex');
  if (rowTotal !== result.evidence_rows || rawTotal !== result.evidence_bytes || transcript !== result.events_sha256) throw new Error('archive totals mismatch');
  Object.assign(audit,{rows:rowTotal,bytes:rawTotal,gzip_bytes:gzipTotal,sha256:transcript,chunks:result.chunks.length,
    manifest_sha256:expectedManifestSha256,status:result.status,metadata:result.metadata,scientific_admission:false});
}
