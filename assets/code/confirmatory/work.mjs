export const COMPONENTS = Object.freeze([
  'sample_predicate_test', 'label_count_update', 'threshold_sort_comparison',
  'node_record_write', 'rng_variate', 'candidate_score_accumulation', 'selection_comparison',
]);

export class BudgetExhausted extends Error {
  constructor(axis) { super(`${axis} adaptation allowance exhausted`); this.name = 'BudgetExhausted'; this.axis = axis; }
}

/** Debit before executing a primitive. Results live in scratch until a complete round commits. */
export class WorkLedger {
  constructor({ cap = Number.MAX_SAFE_INTEGER, cpuCapNs = null, cpuClock = null, rssLimit = 2048 * 1024 ** 2 } = {}) {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new TypeError('APW cap must be a non-negative safe integer');
    if (cpuCapNs !== null && (!Number.isSafeInteger(cpuCapNs) || cpuCapNs < 0)) throw new TypeError('invalid CPU cap');
    this.cap = cap; this.cpuCapNs = cpuCapNs; this.rssLimit = rssLimit;
    this.counts = Object.fromEntries(COMPONENTS.map((key) => [key, 0]));
    this.total = 0; this.candidateEvaluations = 0; this.nodeExampleVisits = 0;
    this.rejectedOperators = 0; this.classDeficientScores = 0;
    this.started = process.hrtime.bigint(); this.cpuStart = process.cpuUsage();
    this.cpuClock = cpuClock ?? (() => { const c = process.cpuUsage(this.cpuStart); return (c.user + c.system) * 1000; });
    this.cpuOvershootNs = 0;
  }
  charge(component, amount = 1) {
    if (!Object.hasOwn(this.counts, component) || !Number.isSafeInteger(amount) || amount < 0) {
      throw new TypeError('invalid work component or amount');
    }
    if (this.total > this.cap - amount) throw new BudgetExhausted('APW');
    this.counts[component] += amount; this.total += amount;
  }
  boundary() {
    if (process.memoryUsage.rss() > this.rssLimit) throw new BudgetExhausted('RSS');
    if (this.cpuCapNs !== null) {
      const used = this.cpuClock();
      if (used >= this.cpuCapNs) {
        this.cpuOvershootNs = Math.max(this.cpuOvershootNs, used - this.cpuCapNs);
        throw new BudgetExhausted('CPU');
      }
    }
  }
  report() {
    const cpuUsed = this.cpuClock();
    return {
      apw_components: { ...this.counts }, adaptation_apw_total: this.total,
      budget_cap: this.cap, unspent_APW: this.cap - this.total,
      candidate_evaluations: this.candidateEvaluations, node_example_visits: this.nodeExampleVisits,
      rejected_operators: this.rejectedOperators, class_deficient_scores: this.classDeficientScores,
      elapsed_ns: Number(process.hrtime.bigint() - this.started), process_cpu_ns: cpuUsed,
      cpu_cap_ns: this.cpuCapNs, cpu_overshoot_ns: this.cpuCapNs === null ? 0 : Math.max(this.cpuOvershootNs, cpuUsed - this.cpuCapNs, 0),
      peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    };
  }
}
