import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { binaryMetricsFromPairs } from './binary-metrics.mjs';

const OPEN_WRITERS = new Set();
const RING_BUFFERS = new Set();
const EVIDENCE_STORES = new Set();

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function temporarySibling(filename) {
  return `${filename}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
}

/** @param {number} descriptor @param {string} text */
function writeComplete(descriptor, text) {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw new Error('CSV write made invalid or zero progress');
    }
    offset += written;
  }
}

/**
 * A fixed-capacity FIFO with Array-like read methods used by the streaming
 * experiments. Pushing beyond the capacity discards the oldest value.
 *
 * @template T
 */
export class RingBuffer {
  /**
   * @param {number} capacity
   * @param {Iterable<T>} [initialValues]
   */
  constructor(capacity, initialValues = []) {
    requirePositiveInteger(capacity, 'capacity');
    this.capacity = capacity;
    /** @type {(T | undefined)[]} */
    this.buffer = new Array(capacity);
    this.start = 0;
    this.count = 0;
    this.totalPushed = 0;
    this.maxObservedLength = 0;
    RING_BUFFERS.add(this);
    for (const value of initialValues) this.push(value);
  }

  get length() {
    return this.count;
  }

  /** @param {T} value */
  push(value) {
    if (this.count < this.capacity) {
      this.buffer[(this.start + this.count) % this.capacity] = value;
      this.count += 1;
    } else {
      this.buffer[this.start] = value;
      this.start = (this.start + 1) % this.capacity;
    }
    this.totalPushed += 1;
    this.maxObservedLength = Math.max(this.maxObservedLength, this.count);
    return this.count;
  }

  /** @param {number} index */
  at(index) {
    if (!Number.isInteger(index)) return undefined;
    const normalised = index < 0 ? this.count + index : index;
    if (normalised < 0 || normalised >= this.count) return undefined;
    return this.buffer[(this.start + normalised) % this.capacity];
  }

  /** @param {number} [start] @param {number} [end] */
  slice(start = 0, end = this.count) {
    return this.toArray().slice(start, end);
  }

  toArray() {
    /** @type {T[]} */
    const values = [];
    for (let index = 0; index < this.count; index += 1) {
      values.push(this.at(index));
    }
    return values;
  }

  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]();
  }

  /** @template U @param {(value: T, index: number, array: T[]) => U} callback */
  map(callback) {
    const values = this.toArray();
    return values.map(callback);
  }

  /** @param {(value: T, index: number, array: T[]) => boolean} callback */
  filter(callback) {
    const values = this.toArray();
    return values.filter(callback);
  }

  /** @param {(value: T, index: number, array: T[]) => boolean} callback */
  some(callback) {
    const values = this.toArray();
    return values.some(callback);
  }

  /** @param {(value: T, index: number, array: T[]) => void} callback */
  forEach(callback) {
    const values = this.toArray();
    values.forEach(callback);
  }

  diagnostics() {
    return {
      capacity: this.capacity,
      retainedLength: this.count,
      totalPushed: this.totalPushed,
      maxObservedLength: this.maxObservedLength,
    };
  }
}

export class OnlineBinaryConfusion {
  constructor() {
    this.c00 = 0;
    this.c01 = 0;
    this.c10 = 0;
    this.c11 = 0;
  }

  /** @param {0 | 1} actual @param {0 | 1} predicted */
  update(actual, predicted) {
    if ((actual !== 0 && actual !== 1) || (predicted !== 0 && predicted !== 1)) {
      throw new TypeError('actual and predicted values must be binary');
    }
    if (actual === 0 && predicted === 0) this.c00 += 1;
    else if (actual === 0) this.c01 += 1;
    else if (predicted === 0) this.c10 += 1;
    else this.c11 += 1;
  }

  snapshot() {
    const count = this.c00 + this.c01 + this.c10 + this.c11;
    const support0 = this.c00 + this.c01;
    const support1 = this.c10 + this.c11;
    const recall0 = support0 === 0 ? null : this.c00 / support0;
    const recall1 = support1 === 0 ? null : this.c11 / support1;
    return {
      count,
      accuracy: count === 0 ? null : (this.c00 + this.c11) / count,
      balancedAccuracy: recall0 === null || recall1 === null
        ? null
        : (recall0 + recall1) / 2,
      recall0,
      recall1,
      c00: this.c00,
      c01: this.c01,
      c10: this.c10,
      c11: this.c11,
    };
  }
}

/**
 * Incremental CSV writer that promotes a complete sibling file with one rename.
 * The temporary file is removed if the process exits before commit.
 */
export class AtomicCsvWriter {
  /** @param {string} filename */
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.tempFilename = temporarySibling(this.filename);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.fileDescriptor = fs.openSync(this.tempFilename, 'wx', 0o600);
    /** @type {string[] | null} */
    this.keys = null;
    this.rowCount = 0;
    this.committed = false;
    OPEN_WRITERS.add(this);
  }

  /** @param {Record<string, unknown>} row */
  append(row) {
    if (this.committed || this.fileDescriptor === null) {
      throw new Error('cannot append to a committed or aborted CSV writer');
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('CSV rows must be plain objects');
    }
    const rowKeys = Object.keys(row);
    if (this.keys === null) {
      if (rowKeys.length === 0) throw new TypeError('CSV rows must contain at least one field');
    } else if (
      rowKeys.length !== this.keys.length
      || rowKeys.some((key, index) => key !== this.keys[index])
    ) {
      throw new Error('CSV row keys or key order differ from the first row');
    }
    const keys = this.keys ?? rowKeys;
    const header = this.keys === null ? `${keys.map(csvEscape).join(',')}\n` : '';
    const line = `${keys.map((key) => csvEscape(row[key])).join(',')}\n`;
    try {
      writeComplete(this.fileDescriptor, header + line);
    } catch (error) {
      this.abort();
      throw error;
    }
    this.keys = keys;
    this.rowCount += 1;
    return this.rowCount;
  }

  commit() {
    if (this.committed) return;
    if (this.fileDescriptor === null) throw new Error('cannot commit an aborted CSV writer');
    if (this.rowCount === 0) throw new Error('refusing to publish an empty CSV file');
    fs.fsyncSync(this.fileDescriptor);
    fs.closeSync(this.fileDescriptor);
    this.fileDescriptor = null;
    try {
      fs.renameSync(this.tempFilename, this.filename);
    } catch (error) {
      fs.rmSync(this.tempFilename, { force: true });
      throw error;
    }
    this.committed = true;
    OPEN_WRITERS.delete(this);
  }

  abort() {
    if (this.fileDescriptor !== null) {
      try {
        fs.closeSync(this.fileDescriptor);
      } catch {
        // Cleanup must not mask the original failure.
      }
      this.fileDescriptor = null;
    }
    try {
      fs.rmSync(this.tempFilename, { force: true });
    } catch {
      // Cleanup must not mask the original failure.
    }
    OPEN_WRITERS.delete(this);
  }

  diagnostics() {
    return {
      filename: path.basename(this.filename),
      rowCount: this.rowCount,
      committed: this.committed,
    };
  }
}

/** @param {string} filename @param {string | Buffer} content */
export function atomicWriteFile(filename, content) {
  const resolved = path.resolve(filename);
  const temporary = temporarySibling(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Cleanup must not mask the write failure.
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  try {
    fs.renameSync(temporary, resolved);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** @param {string} filename @param {Record<string, unknown>[]} rows */
export function writeCsvAtomic(filename, rows) {
  const writer = new AtomicCsvWriter(filename);
  try {
    for (const row of rows) writer.append(row);
    writer.commit();
  } catch (error) {
    writer.abort();
    throw error;
  }
}

/** @param {string} filename @param {unknown} value */
export function writeJsonAtomic(filename, value) {
  atomicWriteFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function legacyMetricNames(metrics) {
  return {
    accuracy: metrics.accuracy,
    balancedAccuracy: metrics.balancedAccuracy,
    recallDown: metrics.recall0,
    recallUp: metrics.recall1,
    c00: metrics.c00,
    c01: metrics.c01,
    c10: metrics.c10,
    c11: metrics.c11,
  };
}

/**
 * Persist prediction rows incrementally while retaining only a bounded recent
 * window and online confusion matrices in memory.
 */
export class StreamingPredictionEvidence {
  /**
   * @param {{
   *   filename: string,
   *   modelKeys: string[],
   *   recentCapacity: number,
   *   totalRecords: number,
   *   segmentCount?: number,
   * }} options
   */
  constructor({
    filename,
    modelKeys,
    recentCapacity,
    totalRecords,
    segmentCount = 10,
  }) {
    if (!Array.isArray(modelKeys) || modelKeys.length === 0) {
      throw new TypeError('modelKeys must be a non-empty array');
    }
    if (new Set(modelKeys).size !== modelKeys.length) {
      throw new TypeError('modelKeys must be unique');
    }
    requirePositiveInteger(recentCapacity, 'recentCapacity');
    requirePositiveInteger(totalRecords, 'totalRecords');
    requirePositiveInteger(segmentCount, 'segmentCount');
    if (segmentCount > totalRecords) {
      throw new TypeError('segmentCount cannot exceed totalRecords');
    }

    this.filename = filename;
    this.modelKeys = [...modelKeys];
    this.totalRecords = totalRecords;
    this.segmentCount = segmentCount;
    this.writer = new AtomicCsvWriter(filename);
    this.recent = new RingBuffer(recentCapacity);
    this.count = 0;
    this.committed = false;
    this.cumulative = new Map(modelKeys.map((key) => [key, new OnlineBinaryConfusion()]));
    this.segments = Array.from({ length: segmentCount }, (_, segmentIndex) => ({
      segment: segmentIndex + 1,
      start: Math.floor((segmentIndex * totalRecords) / segmentCount),
      end: Math.floor(((segmentIndex + 1) * totalRecords) / segmentCount),
      dateStart: null,
      dateEnd: null,
      metrics: new Map(modelKeys.map((key) => [key, new OnlineBinaryConfusion()])),
    }));
    this.currentSegmentIndex = 0;
    EVIDENCE_STORES.add(this);
  }

  /** @param {Record<string, unknown>} record */
  append(record) {
    if (this.count >= this.totalRecords) {
      throw new Error(`received more than the declared ${this.totalRecords} prediction rows`);
    }
    if (record.actual !== 0 && record.actual !== 1) {
      throw new TypeError('prediction evidence requires a binary actual field');
    }
    for (const key of this.modelKeys) {
      if (record[key] !== 0 && record[key] !== 1) {
        throw new TypeError(`prediction evidence field ${key} must be binary`);
      }
    }

    this.writer.append(record);
    this.recent.push(record);
    for (const key of this.modelKeys) {
      this.cumulative.get(key).update(
        /** @type {0 | 1} */ (record.actual),
        /** @type {0 | 1} */ (record[key]),
      );
    }

    while (
      this.currentSegmentIndex < this.segments.length - 1
      && this.count >= this.segments[this.currentSegmentIndex].end
    ) {
      this.currentSegmentIndex += 1;
    }
    const segment = this.segments[this.currentSegmentIndex];
    if (segment.dateStart === null) segment.dateStart = record.date;
    segment.dateEnd = record.date;
    for (const key of this.modelKeys) {
      segment.metrics.get(key).update(
        /** @type {0 | 1} */ (record.actual),
        /** @type {0 | 1} */ (record[key]),
      );
    }

    this.count += 1;
    return this.count;
  }

  get length() {
    return this.count;
  }

  /** @param {string} key */
  metrics(key) {
    const accumulator = this.cumulative.get(key);
    if (!accumulator) throw new TypeError(`unknown model key ${key}`);
    return legacyMetricNames(accumulator.snapshot());
  }

  /** @param {string} key @param {number} count */
  recentMetrics(key, count) {
    if (!this.modelKeys.includes(key)) throw new TypeError(`unknown model key ${key}`);
    requirePositiveInteger(count, 'count');
    if (count > this.recent.capacity) {
      throw new RangeError(
        `requested ${count} recent rows, but the retained capacity is ${this.recent.capacity}`,
      );
    }
    const values = this.recent.slice(-count);
    return legacyMetricNames(binaryMetricsFromPairs(
      values.map((record) => ({ y: record.actual, p: record[key] })),
    ));
  }

  /** @param {Array<[string, string]>} models */
  segmentRows(models) {
    if (this.count !== this.totalRecords) {
      throw new Error('segment metrics are final only after all declared records are appended');
    }
    return this.segments.map((segment) => {
      const row = {
        segment: segment.segment,
        stream_start: segment.start + 1,
        stream_end: segment.end,
        date_start: segment.dateStart,
        date_end: segment.dateEnd,
      };
      for (const [, key] of models) {
        const metrics = segment.metrics.get(key);
        if (!metrics) throw new TypeError(`unknown model key ${key}`);
        const snapshot = metrics.snapshot();
        row[`${key}_accuracy`] = snapshot.accuracy;
        row[`${key}_balanced_accuracy`] = snapshot.balancedAccuracy;
      }
      return row;
    });
  }

  commit() {
    if (this.count !== this.totalRecords) {
      throw new Error(`prediction evidence contains ${this.count} rows; expected ${this.totalRecords}`);
    }
    this.writer.commit();
    this.committed = true;
  }

  abort() {
    this.writer.abort();
  }

  diagnostics() {
    return {
      filename: path.basename(this.filename),
      processedRecords: this.count,
      expectedRecords: this.totalRecords,
      inMemoryPredictionRecords: this.recent.length,
      recentCapacity: this.recent.capacity,
      committed: this.committed,
      outputSha256: this.committed && fs.existsSync(this.filename)
        ? createHash('sha256').update(fs.readFileSync(this.filename)).digest('hex')
        : null,
    };
  }
}

export function runtimeDiagnostics() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ringBuffers: [...RING_BUFFERS].map((buffer) => buffer.diagnostics()),
    evidenceStores: [...EVIDENCE_STORES].map((store) => store.diagnostics()),
    csvWriters: [...OPEN_WRITERS].map((writer) => writer.diagnostics()),
  };
}

export function writeRuntimeDiagnosticsFromEnvironment() {
  const filename = process.env.DT_RUNTIME_DIAGNOSTICS;
  if (!filename) return;
  writeJsonAtomic(filename, runtimeDiagnostics());
}

process.once('exit', () => {
  for (const writer of [...OPEN_WRITERS]) writer.abort();
});
