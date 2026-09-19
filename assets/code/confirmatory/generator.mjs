import { keyFromAddress, uniformAt } from './random.mjs';

export const SCENARIOS = ['LOCAL_TREE', 'OBLIQUE'].flatMap((family) => [
  `${family}-STATIONARY-NONE`,
  ...['ABRUPT', 'GRADUAL', 'RECURRENT'].flatMap((regime) =>
    ['MILD', 'SEVERE'].map((severity) => `${family}-${regime}-${severity}`)),
]);

export function parseScenario(id) {
  if (!SCENARIOS.includes(id)) throw new TypeError(`unknown scenario: ${id}`);
  const [family, regime, severity] = id.split('-');
  return { id, family, regime, severity, magnitude: severity === 'MILD' ? 0.1 : severity === 'SEVERE' ? 0.25 : 0 };
}

export function cleanLabel(x, scenario, concept) {
  if (!Array.isArray(x) || x.length !== 8 || !x.every(Number.isFinite)) throw new TypeError('eight finite features required');
  if (![0, 1, 2].includes(concept)) throw new TypeError('concept must be A=0, B=1 or C=2');
  const s = typeof scenario === 'string' ? parseScenario(scenario) : scenario;
  if (s.family === 'LOCAL_TREE') {
    const a = concept >= 1 ? s.magnitude : 0;
    const b = concept >= 2 ? s.magnitude : 0;
    const z = x[0] < 0.5 ? x[1] - a : x[2] - b;
    return Number(z - Math.floor(z) < 0.5);
  }
  const angle = concept * Math.PI * s.magnitude;
  const u = (x[0] + x[1] + x[2] + x[3]) / 2;
  const v = (x[4] + x[5] + x[6] + x[7]) / 2;
  return Number(Math.cos(angle) * u + Math.sin(angle) * v >= 0);
}

export function conceptAt(scenario, t, mixture) {
  const s = typeof scenario === 'string' ? parseScenario(scenario) : scenario;
  if (!Number.isInteger(t) || t < 1 || t > 26000 || !Number.isFinite(mixture) || mixture < 0 || mixture >= 1) {
    throw new TypeError('invalid observation index or mixture variate');
  }
  if (s.regime === 'STATIONARY' || t <= 10000) return 0;
  if (s.regime === 'RECURRENT') return t <= 20000 ? 1 : 0;
  if (s.regime === 'ABRUPT') return t <= 20000 ? 1 : 2;
  if (t <= 12000) return mixture < (t - 10000) / 2000 ? 1 : 0;
  if (t <= 20000) return 1;
  if (t <= 22000) return mixture < (t - 20000) / 2000 ? 2 : 1;
  return 2;
}

/** Phase 10 deliberately refuses CONF values, including callers supplying a CONF key as DEV. */
export class DevelopmentStream {
  constructor({ partition = 'DEV', scenario, realisation, streamKey = null }) {
    if (partition !== 'DEV') throw new Error('CONF/REAL execution is closed in Phase 10');
    if (!Number.isInteger(realisation) || realisation < 0 || realisation > 2) throw new TypeError('DEV realisation must be 0..2');
    this.scenario = parseScenario(scenario);
    this.address = `DT-P9-v1|DEV|${scenario}|r=${String(realisation).padStart(2, '0')}`;
    this.key = keyFromAddress(this.address);
    if (streamKey !== null && streamKey !== this.key) throw new Error('DEV key does not match its declared address');
  }
  features(t) {
    if (!Number.isInteger(t) || t < 1 || t > 26000) throw new TypeError('observation index outside design');
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
  row(t) { const x = this.features(t); return { index: t, x, y: this.label(t, x) }; }
  window(end, length = 500) {
    if (!Number.isInteger(length) || length < 1 || end - length < 0) throw new TypeError('invalid revealed window');
    return Array.from({ length }, (_, i) => this.row(end - length + 1 + i));
  }
}
