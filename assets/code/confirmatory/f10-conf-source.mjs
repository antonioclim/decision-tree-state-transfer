import { cleanLabel, conceptAt, parseScenario, SCENARIOS } from './generator.mjs';
import { keyFromAddress, uniformAt } from './random.mjs';

export const F10_CONF_NAMESPACE = 'DT-C8E1-F09-v1';
export const F10_CONF_REALISATIONS_PER_SCENARIO = 320;

export function confSourceAddress(scenario, realisation) {
  if (!SCENARIOS.includes(scenario)) throw new TypeError(`unknown CONF scenario: ${scenario}`);
  if (!Number.isInteger(realisation) || realisation < 0 || realisation >= F10_CONF_REALISATIONS_PER_SCENARIO) {
    throw new TypeError('CONF realisation must be 0..319');
  }
  return `${F10_CONF_NAMESPACE}|CONF|SOURCE|scenario=${scenario}|r=${String(realisation).padStart(3, '0')}`;
}

/**
 * F09-locked CONF stream. Distributional semantics intentionally reuse the
 * Phase-9 scenario functions, while the source address/key namespace is
 * disjoint from every DEV source namespace.
 */
export class ConfirmatoryStream {
  constructor({ scenario, realisation, streamKey = null }) {
    this.scenario = parseScenario(scenario);
    this.realisation = realisation;
    this.address = confSourceAddress(scenario, realisation);
    this.key = keyFromAddress(this.address);
    if (streamKey !== null && streamKey !== this.key) throw new Error('CONF key does not match the F09-locked source address');
  }

  features(t) {
    if (!Number.isInteger(t) || t < 1 || t > 26000) throw new TypeError('observation index outside CONF design');
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

  row(t) {
    const x = this.features(t);
    return { index: t, x, y: this.label(t, x) };
  }

  window(end, length = 500) {
    if (!Number.isInteger(length) || length < 1 || end - length < 0 || end > 26000) throw new TypeError('invalid CONF revealed window');
    return Array.from({ length }, (_, i) => this.row(end - length + 1 + i));
  }
}
