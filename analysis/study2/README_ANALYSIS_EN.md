# I06B primary analysis and pre-outcome numerical qualification

## Status

This directory supplies the previously missing executable J1/J2 primary analysis. It does **not** contain Study 2 results. The checkpoint remains before EXT materialisation: zero of 1,120 scheduled stream realisations have been executed. Arithmetic fixtures in the qualification evidence are explicitly labelled software tests, not generated streams, independent experimental observations or evidence for either estimand.

`analyse.py` is the evidence-admission entry point. `statistics_core.py` and `reproduce.mjs` are numerical kernels. Passing arbitrary arrays to a kernel cannot create scientific admission. A successful computation receipt also leaves the final I06B scientific audit open.

## Files and responsibilities

| File | Responsibility |
|---|---|
| `NUMERICAL_IMPLEMENTATION_RESOLUTION.json` | Explicit pre-outcome resolution of implementation details not fully specified in I05. It is not a replacement protocol. |
| `DRAW_SCHEDULE_SEALS.json` | Exact index-tape digests for the two locked 64-bit primary-analysis seeds. No feature, label or experimental outcome is contained in the tapes. |
| `statistics_core.py` | Integer-count contrasts, whole-stream stratified bootstrap-t, simultaneous intervals, plus-one p-values, fixed-family Holm adjustment and practical classifications. |
| `reproduce.mjs` | Separately implemented Node arithmetic using the same sealed resampling indices. It does not import the Python statistical implementation. |
| `qualify_analysis.py` | Full-shape, explicitly non-evidential arithmetic fixtures, numerical comparisons and negative checks. |
| `reporting.py` | Canonical raw loss-count extraction, secondary point summaries and measurement-scoped resource reporting. |
| `analyse.py` | Pre-outcome analysis binding, complete-campaign admission and create-only production analysis. |
| `tests/` | Statistical, reporting, input-validation and admission-boundary unit tests. |

## Entry points

First install the specified analysis dependency in the execution environment:

```bash
python3 -m pip install -r "$CHECKPOINT/06_ANALYSIS/requirements-analysis.txt"
```

The full order, including fresh source qualification and DEV admission, is in `04_EXECUTION_KIT/README_EXECUTION_EN.md`. The analysis-specific steps are:

```bash
python3 "$CHECKPOINT/06_ANALYSIS/analyse.py" qualify --repo "$REPO" --run-root "$RUN_ROOT"
python3 "$CHECKPOINT/06_ANALYSIS/analyse.py" verify-binding --repo "$REPO" --run-root "$RUN_ROOT"
# Only after all 1,120 units have passed verify-complete:
python3 "$CHECKPOINT/06_ANALYSIS/analyse.py" run --repo "$REPO" --run-root "$RUN_ROOT" --output "$ANALYSIS_OUT"
```

Analysis qualification must precede every EXT attempt. A nonempty `attempts`, `admitted` or `locks` directory prevents a new pre-outcome binding. The controller checks the binding before and after each value-producing worker. Changes to the analysis code, numerical resolution, draw seals, qualified engine admission or controller invalidate the binding.

The production analyser rejects missing cardinality or duplicate indices before opening outcomes. It then revalidates every admitted record, source identity, canonical path and evidence hash. Outputs are create-only. It regenerates the sealed index tapes, calculates primary inference, reproduces the calculation in Node and rechecks the entire campaign before writing `ANALYSIS_COMPUTATION_RECEIPT.json`.

## Qualification is not a completed study

The three arithmetic fixtures have the same tensor dimensions as the planned count input solely to exercise the estimator and all 9,999 replicates. They cover non-degenerate cancellation, observed zero within-stratum variance and bootstrap variance degeneracy. No fabricated raw EXT records, source manifests or complete-campaign admissions are used to qualify the scientific success path.

Each implementation is compared for both hypotheses, all replicate estimates, standard errors and absolute pivots, the critical order statistic, exceedance counts, p-values, classifications and Holm decisions. Numeric comparisons use the declared tolerance; counts, p-values and categorical results must match exactly. Common index tapes are a shared dependency. This is an independent implementation check, not an independent investigator, independent PRNG implementation or independent experimental replication.

## Output and reporting limits

Primary inference is fully implemented, but is not executed on actual Study 2 observations in this checkpoint. Secondary scenario, family, checkpoint and embedded-horizon outputs are point summaries only; they are not additional members of the primary family and have no new significance labels. The two policy increments are order-specific. They do not identify pure diversity effects, pure history effects, Shapley values or causal mediation.

APW, process CPU, elapsed time, accumulated prediction time, process-lifetime RSS, state bytes and provenance bytes retain distinct units and measurement scopes. Missing measurements are not replaced by zero. A full-target summary is withheld when its required observations are missing. Resource outputs are descriptive; decision economics is not performed here.

The actual EXT success path, concurrent campaign, restart/retry path and final inference from genuine EXT records remain unexecuted. The final adversarial I06B scientific audit is required even if a future numerical comparison passes.
