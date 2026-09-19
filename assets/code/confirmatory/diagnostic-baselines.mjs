import { WorkLedger } from './work.mjs';
import { TreeFactory, fitCart, predict } from './trees.mjs';

/** Common numeric diagnostic baselines. Contextual learners are not equal-APW controls. */
export class DiagnosticBaseline {
  constructor(id, prefix, { featureCount = 8 } = {}) {
    if (!['FROZEN_CART', 'ROLLING_CART', 'LAST_LABEL', 'PREFIX_MAJORITY'].includes(id)
      || !Array.isArray(prefix) || prefix.length !== 2000) throw new TypeError('a diagnostic baseline requires its full 2000-row prefix');
    this.id = id; this.featureCount = featureCount; this.lastIndex = 2000; this.pending = null;
    this.window = []; this.counts = [0, 0]; this.lastLabel = null; this.tree = null; this.trainingCosts = [];
    for (const r of prefix) {
      if (r.index !== this.window.length + 1 || ![0, 1].includes(r.y) || !Array.isArray(r.x)
        || r.x.length !== featureCount || !r.x.every(Number.isFinite)) throw new Error('invalid diagnostic initial prefix');
      this.window.push(structuredClone(r)); this.counts[r.y]++; this.lastLabel = r.y;
    }
    if (id === 'FROZEN_CART' || id === 'ROLLING_CART') this.fit(id === 'FROZEN_CART' ? this.window : this.window.slice(-500));
    this.window = this.window.slice(-500);
  }
  fit(rows) {
    const ledger = new WorkLedger(); const factory = new TreeFactory({ ledger, prefix: `baseline:${this.id}:${this.lastIndex}` });
    this.tree = fitCart(rows, factory, { featureCount: this.featureCount, maxDepth: 8, minLeaf: 10, minGain: 1e-12 });
    this.trainingCosts.push({ ...ledger.report(), role: 'CONTEXTUAL_NOT_MATCHED_TO_EVOLUTIONARY_APW' });
  }
  predictInput(payload) {
    if (!payload || Object.keys(payload).sort().join(',') !== 'index,x') throw new Error('features and index only');
    const { index, x } = payload;
    if (this.pending || index !== this.lastIndex + 1 || !Array.isArray(x) || x.length !== this.featureCount || !x.every(Number.isFinite)) throw new Error('invalid diagnostic prediction order');
    this.pending = { index, x: [...x] };
    if (this.id === 'LAST_LABEL') return this.lastLabel;
    if (this.id === 'PREFIX_MAJORITY') return Number(this.counts[1] > this.counts[0]);
    return predict(this.tree, x);
  }
  reveal(label) {
    if (!this.pending || ![0, 1].includes(label)) throw new Error('diagnostic label requires a prior prediction');
    const row = { ...this.pending, y: label }; this.counts[label]++; this.lastLabel = label;
    this.window.push(row); if (this.window.length > 500) this.window.shift(); this.lastIndex = row.index; this.pending = null;
    if (this.id === 'ROLLING_CART' && this.lastIndex % 100 === 0) this.fit(this.window);
  }
}

/** Prefix-only transformation specification; no full-stream fitting or scaling. */
export class PrefixEncoder {
  constructor(prefix, { numeric, categorical }) {
    if (!Array.isArray(prefix) || prefix.length !== 2000 || !Array.isArray(numeric) || !Array.isArray(categorical)
      || new Set([...numeric, ...categorical]).size !== numeric.length + categorical.length
      || [...numeric, ...categorical].some((s) => typeof s !== 'string' || !s)) throw new TypeError('invalid prefix/schema');
    const missing = (v) => v === null || v === undefined;
    this.numeric = numeric.map((name) => {
      const values = prefix.map((r) => r[name]).filter((v) => !missing(v));
      if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('numeric field has unparsed invalid data');
      values.sort((a, b) => a - b); const mid = Math.floor(values.length / 2);
      let median = values.length === 0 ? 0 : values[mid];
      if (values.length > 0 && values.length % 2 === 0) {
        const low = values[mid - 1]; const high = values[mid]; const sum = low + high;
        // Summing first preserves subnormal midpoints. Split the terms only when
        // their finite inputs overflow the sum, where halving cannot underflow.
        median = Number.isFinite(sum) ? sum / 2 : low / 2 + high / 2;
      }
      return { name, median };
    });
    this.categorical = categorical.map((name) => {
      const values = prefix.map((r) => r[name]).filter((v) => !missing(v));
      if (values.some((v) => typeof v !== 'string')) throw new Error('categorical values must be parsed strings or missing');
      return { name, vocabulary: [...new Set(values)].sort() };
    });
    this.featureCount = 2 * this.numeric.length + this.categorical.reduce((n, c) => n + c.vocabulary.length + 2, 0);
  }
  transform(row) {
    const x = [];
    for (const { name, median } of this.numeric) {
      const value = row[name]; const absent = value === null || value === undefined;
      if (!absent && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('invalid future numeric value');
      x.push(absent ? median : value, Number(absent));
    }
    for (const { name, vocabulary } of this.categorical) {
      const value = row[name]; const absent = value === null || value === undefined;
      if (!absent && typeof value !== 'string') throw new Error('invalid future category');
      const encoded = Array(vocabulary.length + 2).fill(0); const index = vocabulary.indexOf(value);
      encoded[absent ? vocabulary.length + 1 : index < 0 ? vocabulary.length : index] = 1; x.push(...encoded);
    }
    return x;
  }
  specification() { return { schema_version: 1, numeric: structuredClone(this.numeric), categorical: structuredClone(this.categorical), feature_count: this.featureCount, fitted_prefix_n: 2000 }; }
}
