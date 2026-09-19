import { roleRandom } from './random.mjs';
import { BudgetExhausted, WorkLedger } from './work.mjs';
import { TreeFactory, candidateThresholds, crossover, fitCart, mutate, nodeCount, predict,
  randomTree, validateTree, exportTree, importTree } from './trees.mjs';

/** @typedef {{populationSize:number, cartDescendants:number, featureCount:number,
 * replacementFraction:number, elitism:number, tournamentSize:number, maxInitialDepth:number,
 * maxTreeDepth:number, crossoverRate:number, mutationRate:number, complexityPenalty:number,
 * thresholdsPerFeature:number, cartMaxDepth:number, cartMinLeaf:number, cartMinGain:number}} LearnerConfig */
/** @type {Readonly<LearnerConfig>} */
export const CONFIG = Object.freeze({
  populationSize: 150, cartDescendants: 110, featureCount: 8, replacementFraction: 0.2,
  elitism: 5, tournamentSize: 7, maxInitialDepth: 4, maxTreeDepth: 8,
  crossoverRate: 0.8, mutationRate: 0.8, complexityPenalty: 0.00025,
  thresholdsPerFeature: 32, cartMaxDepth: 8, cartMinLeaf: 10, cartMinGain: 1e-12,
});
export const ARMS = Object.freeze(['PERSIST', 'RESTART', 'CHAMPION', 'NO_CROSSOVER', 'NO_MUTATION', 'RANDOM_RESTART', 'TEMPLATE_REFIT']);

export function scorePopulation(population, rows, config, ledger) {
  const scored = population.map((individual) => {
    ledger.boundary();
    let n0 = 0; let n1 = 0; let correct0 = 0; let correct1 = 0;
    for (const row of rows) {
      const prediction = predict(individual.tree, row.x, ledger);
      ledger.charge('label_count_update'); ledger.charge('candidate_score_accumulation');
      if (row.y === 0) { n0++; correct0 += Number(prediction === 0); }
      else { n1++; correct1 += Number(prediction === 1); }
    }
    ledger.candidateEvaluations++;
    const deficient = n0 === 0 || n1 === 0;
    if (deficient) ledger.classDeficientScores++;
    const accuracy = (correct0 + correct1) / rows.length;
    const balanced = deficient ? accuracy : 0.5 * (correct0 / n0 + correct1 / n1);
    return { individual, fitness: balanced - config.complexityPenalty * nodeCount(individual.tree), accuracy, deficient };
  });
  scored.sort((a, b) => {
    ledger.charge('selection_comparison');
    return b.fitness - a.fitness || a.individual.ordinal - b.individual.ordinal;
  });
  return scored;
}

function individual(tree, ordinal, factory, parents = []) {
  return { tree, ordinal, id: factory.id('individual'), parents: [...parents] };
}
function tournament(scored, rng, config, ledger) {
  let best = null;
  for (let k = 0; k < config.tournamentSize; k++) {
    const candidate = rng.choice(scored); ledger.charge('selection_comparison');
    if (best === null || candidate.fitness > best.fitness) best = candidate;
  }
  return best.individual;
}

export function coldPopulation({ rows, thresholds, key, checkpoint, arm, factory, config = CONFIG, champion = null, nextOrdinal = 0 }) {
  const population = [];
  let base;
  if (arm !== 'RANDOM_RESTART') {
    if (arm === 'CHAMPION' && champion === null) throw new Error('champion treatment requires a valid deployed champion');
    const tree = arm === 'CHAMPION' ? factory.copy(champion.tree)
      : fitCart(rows, factory, { featureCount: config.featureCount, maxDepth: config.cartMaxDepth,
        minLeaf: config.cartMinLeaf, minGain: config.cartMinGain });
    base = individual(tree, nextOrdinal++, factory, champion && arm === 'CHAMPION' ? [champion.id] : []);
    population.push(base);
    for (let i = 0; i < config.cartDescendants; i++) {
      factory.ledger.boundary();
      const rng = roleRandom(key, `init|c=${checkpoint}|arm=${arm}|descendant=${i}`, checkpoint, factory.ledger);
      let child = factory.copy(base.tree);
      const attempts = 1 + Number(rng.uniform() < 0.35);
      for (let m = 0; m < attempts; m++) child = mutate(child, thresholds, rng, factory, config.maxTreeDepth).tree;
      population.push(individual(child, nextOrdinal++, factory, [base.id]));
    }
  }
  while (population.length < config.populationSize) {
    factory.ledger.boundary();
    const rng = roleRandom(key, `init|c=${checkpoint}|arm=${arm}|random=${population.length}`, checkpoint, factory.ledger);
    population.push(individual(randomTree(thresholds, rng, factory, 0, config.maxInitialDepth), nextOrdinal++, factory));
  }
  if (population.length !== config.populationSize) throw new Error('incorrect cold population size');
  return { population, nextOrdinal };
}

export function makeConfig(overrides = {}) {
  /** @type {LearnerConfig} */
  const config = { ...CONFIG, ...overrides };
  for (const name of Object.keys(overrides)) if (!Object.hasOwn(CONFIG, name)) throw new TypeError(`unknown configuration: ${name}`);
  for (const name of ['populationSize', 'featureCount', 'tournamentSize', 'thresholdsPerFeature', 'cartMinLeaf']) {
    if (!Number.isInteger(config[name]) || config[name] < 1) throw new TypeError(`invalid ${name}`);
  }
  for (const name of ['cartDescendants', 'elitism', 'maxInitialDepth', 'maxTreeDepth', 'cartMaxDepth']) {
    if (!Number.isInteger(config[name]) || config[name] < 0) throw new TypeError(`invalid ${name}`);
  }
  if (config.cartDescendants >= config.populationSize || config.elitism >= config.populationSize
    || config.maxInitialDepth > config.maxTreeDepth || config.cartMaxDepth > config.maxTreeDepth) throw new TypeError('inconsistent learner dimensions');
  for (const name of ['crossoverRate', 'mutationRate', 'replacementFraction']) {
    if (!Number.isFinite(config[name]) || config[name] < 0 || config[name] > 1) throw new TypeError(`invalid ${name}`);
  }
  if (config.replacementFraction === 0 || Math.floor(config.populationSize * config.replacementFraction) > config.populationSize - config.elitism
    || !Number.isFinite(config.complexityPenalty) || config.complexityPenalty < 0 || !Number.isFinite(config.cartMinGain) || config.cartMinGain < 0) throw new TypeError('invalid selection or penalty');
  return Object.freeze(config);
}

/** No stream reader or future data are accessible from this learner. */
export class EvolutionLearner {
  constructor({ key, config = {}, provenancePrefix = 'learner', emit = null }) {
    if (!/^[a-f0-9]{16}$/.test(key)) throw new TypeError('invalid optimiser key');
    this.key = key; this.config = makeConfig(config); this.provenancePrefix = provenancePrefix; this.emit = emit;
    this.population = []; this.champion = null; this.nextOrdinal = 0; this.completedUpdates = 0;
    this.scoredThrough = null; this.failed = false; this.treatmentApplied = false;
    this.lastUpdate = null; this.eventSerial = 0; this.snapshotSchemaVersion = 2;
  }
  initialise(rows, checkpoint = 2000, options = {}) {
    if (this.population.length !== 0 || this.failed) throw new Error('initialisation requires an empty learner');
    return this.update(rows, { ...options, checkpoint, arm: 'RESTART', initialOnly: true });
  }
  /** @param {Array<{index:number, x:number[], y:number}>} rows
   * @param {{checkpoint?:number, arm?:string, cap?:number, cpuCapNs?:number,
   * budgetTag?:string, contextCheckpoint?:number, initialOnly?:boolean,
   * ledgerFactory?:((options:{cap:number,cpuCapNs:number|null},context:{checkpoint:number,arm:string,initialOnly:boolean})=>WorkLedger)|null}} options */
  update(rows, { checkpoint, arm = 'PERSIST', cap = Number.MAX_SAFE_INTEGER, cpuCapNs = null,
    budgetTag = 'common', contextCheckpoint = 0, initialOnly = false, ledgerFactory = null } = {}) {
    if (!ARMS.includes(arm) || !Number.isSafeInteger(checkpoint) || checkpoint < 1) throw new TypeError('invalid update request');
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500 || rows.at(-1).index !== checkpoint) throw new Error('invalid revealed window');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.index !== checkpoint - rows.length + 1 + i || !Array.isArray(row.x) || row.x.length !== this.config.featureCount
        || !row.x.every(Number.isFinite) || ![0, 1].includes(row.y)) throw new Error('non-chronological or invalid learner input');
    }
    if (this.failed) throw new Error('failed learner cannot resume as a fresh successful attempt');
    if (!initialOnly && cap === Number.MAX_SAFE_INTEGER && cpuCapNs === null) throw new Error('adaptive update requires a finite explicit allowance');
    if (ledgerFactory !== null && typeof ledgerFactory !== 'function') throw new TypeError('invalid ledger factory');
    const ledger = ledgerFactory === null ? new WorkLedger({ cap, cpuCapNs })
      : ledgerFactory({ cap, cpuCapNs }, { checkpoint, arm, initialOnly });
    if (!(ledger instanceof WorkLedger) || ledger.cap !== cap || ledger.cpuCapNs !== cpuCapNs
      || ledger.total !== 0) throw new TypeError('ledger factory changed the declared allowance or initial work');
    const factory = new TreeFactory({ ledger, prefix: `${this.provenancePrefix}:u${++this.eventSerial}`,
      update: this.completedUpdates + 1, emit: this.emit });
    const cold = ['RESTART', 'CHAMPION', 'RANDOM_RESTART'].includes(arm);
    let committed = false; let rounds = 0; let discarded = false; let exhaustedAxis = null;
    try {
      ledger.boundary();
      const thresholds = candidateThresholds(rows, this.config.featureCount, this.config.thresholdsPerFeature, ledger);
      let population; let nextOrdinal = this.nextOrdinal;
      if (cold) {
        ({ population, nextOrdinal } = coldPopulation({ rows, thresholds, key: this.key, checkpoint, arm,
          factory, config: this.config, champion: this.champion, nextOrdinal }));
      } else if (arm === 'TEMPLATE_REFIT') {
        population = this.population.map((old) => individual(fitCart(rows, factory, {
          featureCount: this.config.featureCount, maxDepth: this.config.maxTreeDepth, maxNodes: nodeCount(old.tree),
          minLeaf: this.config.cartMinLeaf, minGain: this.config.cartMinGain, tieAction: 0,
          template: old.tree, thresholds }), nextOrdinal++, factory, [old.id]));
      } else population = this.population;
      if (population.length !== this.config.populationSize) throw new Error('no valid population for retention');
      const initialScores = scorePopulation(population, rows, this.config, ledger);
      ledger.boundary();
      this.commit(population, initialScores, nextOrdinal, checkpoint, factory); committed = true;
      if (!initialOnly) {
        for (let round = 0; ; round++) {
          ledger.boundary();
          const scored = scorePopulation(this.population, rows, this.config, ledger);
          const replaceCount = Math.max(1, Math.floor(this.config.populationSize * this.config.replacementFraction));
          const next = scored.slice(0, this.config.populationSize - replaceCount).map((s) => s.individual);
          let ordinal = this.nextOrdinal;
          for (let i = 0; next.length < this.config.populationSize; i++) {
            ledger.boundary();
            const prefix = `operators|fork=${contextCheckpoint}|budget=${budgetTag}|round=${round}|offspring=${i}`;
            const tr = roleRandom(this.key, `${prefix}|tournament`, checkpoint, ledger);
            const cr = roleRandom(this.key, `${prefix}|crossover`, checkpoint, ledger);
            const mr = roleRandom(this.key, `${prefix}|mutation`, checkpoint, ledger);
            const a = tournament(scored, tr, this.config, ledger); let b = null;
            let tree = factory.copy(a.tree);
            if (arm !== 'NO_CROSSOVER' && cr.uniform() < this.config.crossoverRate) {
              b = tournament(scored, tr, this.config, ledger); tree = crossover(a.tree, b.tree, cr, factory, this.config.maxTreeDepth).tree;
            }
            if (arm !== 'NO_MUTATION' && mr.uniform() < this.config.mutationRate) tree = mutate(tree, thresholds, mr, factory, this.config.maxTreeDepth).tree;
            next.push(individual(tree, ordinal++, factory, b ? [a.id, b.id] : [a.id]));
          }
          const rescored = scorePopulation(next, rows, this.config, ledger);
          ledger.boundary();
          this.commit(next, rescored, ordinal, checkpoint, factory); rounds++;
        }
      }
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      discarded = true; exhaustedAxis = error.axis;
      if ((cold && !committed) || error.axis === 'RSS') {
        this.population = []; this.champion = null; this.scoredThrough = null; this.failed = true;
      }
    }
    // This counter records completed mandatory stages, including a stage whose
    // deployed state was subsequently lost to terminal RSS exhaustion.
    if (committed) this.completedUpdates++;
    this.snapshotSchemaVersion = 2;
    const report = { ...ledger.report(), completed_rounds: rounds, mandatory_stage_committed: committed,
      partial_scratch_discarded: discarded, exhausted_axis: exhaustedAxis, initialisation_failed: this.failed,
      population_size: this.population.length, scored_through: this.scoredThrough,
      checkpoint, arm, provenance_records: factory.eventCount, provenance_ns: factory.provenanceNs };
    this.lastUpdate = report; return report;
  }
  commit(population, scores, nextOrdinal, checkpoint, factory) {
    for (const ind of population) factory.realise(ind.tree, ind.id);
    this.population = population; this.champion = scores[0].individual; this.nextOrdinal = nextOrdinal;
    this.scoredThrough = checkpoint;
  }
  predict(x, online = null) {
    if (this.failed || this.champion === null) return null;
    if (!Array.isArray(x) || x.length !== this.config.featureCount || !x.every(Number.isFinite)) throw new TypeError('invalid prediction features');
    return predict(this.champion.tree, x, null, online);
  }
  snapshot() {
    return { schema_version: this.snapshotSchemaVersion, key: this.key, config: { ...this.config }, nextOrdinal: this.nextOrdinal,
      completedUpdates: this.completedUpdates, scoredThrough: this.scoredThrough, failed: this.failed,
      treatmentApplied: this.treatmentApplied, eventSerial: this.eventSerial,
      championOrdinal: this.champion?.ordinal ?? null,
      population: this.population.map((p) => ({ ...p, tree: exportTree(p.tree) })) };
  }
  static restore(snapshot, { provenancePrefix = 'restored', emit = null } = {}) {
    if (!snapshot || ![1, 2].includes(snapshot.schema_version) || !Array.isArray(snapshot.population)
      || typeof snapshot.failed !== 'boolean' || typeof snapshot.treatmentApplied !== 'boolean'
      || !['nextOrdinal', 'completedUpdates', 'eventSerial'].every((k) => Number.isSafeInteger(snapshot[k]) && snapshot[k] >= 0)
      || (snapshot.scoredThrough !== null && (!Number.isSafeInteger(snapshot.scoredThrough) || snapshot.scoredThrough < 1))
      || (snapshot.schema_version === 2 && snapshot.failed && snapshot.scoredThrough !== null)) throw new Error('unsupported or malformed snapshot');
    const l = new EvolutionLearner({ key: snapshot.key, config: snapshot.config, provenancePrefix, emit });
    l.population = snapshot.population.map((p) => {
      if (!p || !Number.isSafeInteger(p.ordinal) || p.ordinal < 0 || p.ordinal >= snapshot.nextOrdinal
        || typeof p.id !== 'string' || !p.id || !Array.isArray(p.parents) || !p.parents.every((id) => typeof id === 'string')) throw new Error('invalid individual snapshot');
      return { ...p, parents: [...p.parents], tree: importTree(p.tree) };
    });
    l.champion = l.population.find((p) => p.ordinal === snapshot.championOrdinal) ?? null;
    for (const p of l.population) validateTree(p.tree, { featureCount: l.config.featureCount, maxDepth: l.config.maxTreeDepth, requireRealised: true });
    if ((!snapshot.failed && (l.population.length !== l.config.populationSize || l.champion === null))
      || (snapshot.failed && (l.population.length !== 0 || snapshot.championOrdinal !== null))
      || new Set(l.population.map((p) => p.ordinal)).size !== l.population.length
      || new Set(l.population.map((p) => p.id)).size !== l.population.length) throw new Error('incomplete or duplicate snapshot population');
    for (const name of ['nextOrdinal', 'completedUpdates', 'scoredThrough', 'failed', 'treatmentApplied', 'eventSerial']) l[name] = snapshot[name];
    // Historical snapshots retain their declared interpretation until a new
    // update runs. Restoring a v1 record does not certify it as a v2 snapshot.
    l.snapshotSchemaVersion = snapshot.schema_version;
    return l;
  }
}
