/** Observed safe-boundary CPU/RSS decisions and conditional replay.
 * Reusing a recorded clock is not a second measurement or independent timing
 * authentication. The default sampler always reads this process, not wall time.
 */
import { WorkLedger, BudgetExhausted } from './work.mjs';
import { strictJson } from './evidence.mjs';

function same(a, b) { return strictJson(a) === strictJson(b); }
function natural(value) { return Number.isSafeInteger(value) && value >= 0; }
function measured(ledger) {
  const c = process.cpuUsage(ledger.cpuStart);
  return { cpu_ns: (c.user + c.system) * 1000, rss_bytes: process.memoryUsage.rss() };
}

class ObservedLedger extends WorkLedger {
  constructor(options, observe) {
    super(options); this.observe = observe;
    this.cpuClock = () => this.observe('report').cpu_ns;
  }
  boundary() {
    const sample = this.observe('boundary');
    if (sample.rss_bytes > this.rssLimit) throw new BudgetExhausted('RSS');
    if (this.cpuCapNs !== null && sample.cpu_ns >= this.cpuCapNs) {
      this.cpuOvershootNs = Math.max(this.cpuOvershootNs, sample.cpu_ns - this.cpuCapNs);
      throw new BudgetExhausted('CPU');
    }
  }
}

export class CpuClockTape {
  /** A custom sampler is for explicitly labelled FIXTURE recording only. */
  constructor({ mode, emit = null, iterator = null, fixtureSampler = null, scope = 'DEV_CHECK' }) {
    if (!['record', 'replay'].includes(mode) || !['DEV_CHECK', 'FIXTURE'].includes(scope)
      || (mode === 'record' && (typeof emit !== 'function' || iterator !== null))
      || (mode === 'replay' && (!iterator || typeof iterator.next !== 'function' || emit !== null || fixtureSampler !== null))
      || (fixtureSampler !== null && (scope !== 'FIXTURE' || typeof fixtureSampler !== 'function'))) {
      throw new TypeError('invalid CPU tape mode, source or fixture sampler');
    }
    this.mode = mode; this.emit = emit; this.iterator = iterator; this.sampler = fixtureSampler ?? measured;
    this.ledgers = 0; this.samples = 0; this.boundaries = 0; this.reports = 0; this.lastClosed = true;
    this.maxRss = 0; this.maxBoundaryGap = 0; this.closed = false;
  }
  makeLedger(options, context) {
    if (this.closed || !this.lastClosed || !context || !Number.isSafeInteger(context.checkpoint)
      || context.checkpoint < 1 || typeof context.arm !== 'string' || typeof context.initialOnly !== 'boolean') {
      throw new Error('unclosed clock ledger or invalid update identity');
    }
    let ledger; let index = 0; let previousCpu = 0; let reportSeen = false;
    const ordinal = ++this.ledgers; this.lastClosed = false;
    const observe = phase => {
      if (this.closed || reportSeen || !['boundary', 'report'].includes(phase)) throw new Error('clock access after report or closure');
      const anchor = { kind: 'CPU_RSS_OBSERVATION_V1', ledger_index: ordinal, sample_index: ++index,
        checkpoint: context.checkpoint, arm: context.arm, initial_only: context.initialOnly,
        phase, apw_cap: ledger.cap, cpu_cap_ns: ledger.cpuCapNs, rss_limit_bytes: ledger.rssLimit,
        adaptation_apw_total: ledger.total, apw_components: { ...ledger.counts } };
      let sample;
      if (this.mode === 'record') {
        sample = this.sampler(ledger, anchor);
        if (!sample || Object.keys(sample).sort().join('|') !== 'cpu_ns|rss_bytes') throw new Error('invalid measured CPU/RSS fields');
      } else {
        const next = this.iterator.next(); if (next.done) throw new Error('clock transcript ended before update');
        const { cpu_ns, rss_bytes, ...observedAnchor } = next.value;
        if (!same(anchor, observedAnchor)) throw new Error('clock sample is not bound to this update and work prefix');
        sample = { cpu_ns, rss_bytes };
      }
      if (!natural(sample.cpu_ns) || !natural(sample.rss_bytes) || sample.cpu_ns < previousCpu) {
        throw new Error('invalid or decreasing measured CPU/RSS sample');
      }
      this.maxBoundaryGap = Math.max(this.maxBoundaryGap, sample.cpu_ns - previousCpu);
      previousCpu = sample.cpu_ns; this.maxRss = Math.max(this.maxRss, sample.rss_bytes); this.samples++;
      if (phase === 'boundary') this.boundaries++;
      else { this.reports++; reportSeen = true; this.lastClosed = true; }
      if (this.mode === 'record') this.emit({ ...anchor, ...sample });
      return sample;
    };
    ledger = new ObservedLedger(options, observe);
    return ledger;
  }
  finish() {
    if (this.closed || !this.lastClosed || this.reports !== this.ledgers) throw new Error('incomplete or already closed CPU transcript');
    if (this.mode === 'replay' && !this.iterator.next().done) throw new Error('surplus CPU transcript');
    this.closed = true;
    return { ledgers: this.ledgers, samples: this.samples, boundary_samples: this.boundaries,
      report_samples: this.reports, maximum_observed_rss_bytes: this.maxRss,
      maximum_cpu_increment_between_samples_ns: this.maxBoundaryGap,
      timing_authenticated: false, recorded_observations_reused_in_replay: true };
  }
}
