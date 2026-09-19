# Primary inference: source authority and numerical implementation

## 1. Authority and timing

The controlling sources are the unchanged I05 JSON protocol, seed schedule, analysis plan and failure policy, together with the I06A receipt and qualified source tree. The pre-outcome resolution in this directory fixes execution details that were not fully explicit in I05: the bounded-integer random-number call sequence, finite-bootstrap quantile convention, degenerate-variance handling and serialisation of infinite pivots. It records zero EXT outcomes at the time of resolution.

The resolution follows the archived F11 numerical conventions where applicable. F11 is a methodological precedent, not a new quantitative source for Study 2. Its three-member hypothesis family is not imported: I05 fixes the present family at J1 and J2. No sample size, arm, estimand, source seed, checkpoint, horizon or practical-equivalence band is changed. The original qualified engine is not edited.

## 2. Sampling unit and estimator

Let g index the 14 scenarios, i the 80 independently scheduled stream realisations per scenario, c the two checkpoints and h the primary 2,000-observation horizon. For each arm, its loss is the integer error count divided by 2,000, including the frozen penalties for valid algorithmic failure or unavailable treatment. Checkpoints are paired observations within a stream, not additional independent sampling units.

For J1, define A[g,i] as the sum over the two checkpoints of the CHAMPION-RESEED error count minus the POPULATION-RESEED error count. For J2, substitute POPULATION-RESEED minus PERSIST. The stream contrast is A[g,i]/4,000. The estimator is the equal-weight mean of the 14 scenario means. The direct champion-minus-persist numerator must equal the sum of the J1 and J2 numerators exactly, before division.

For a scenario with n=80 streams, let S[g] be the sum of its integer numerators and Q[g] their sum of squares. With G=14 and D=4,000:

    theta = sum_g S[g] / (G n D)
    SE^2 = sum_g {n Q[g] - S[g]^2} / {G^2 n^2 (n-1) D^2}

The sufficient statistics are calculated as bounded integers before conversion to floating point. This avoids cancellation-driven positive or negative variance in constant strata. Between-scenario heterogeneity is not substituted for within-scenario sampling variance.

## 3. Resampling and multiplicity

Within each scenario, resample 80 whole streams with replacement, preserving both checkpoints and all arm pairings. Use 9,999 replicates for each hypothesis with its separately locked analysis seed. The absolute centred studentised pivot is abs((theta_star-theta)/SE_star).

The two-sided unadjusted p-value is (1 + the number of bootstrap absolute pivots at least as large as abs(theta/SE))/(9,999+1). The fixed two-hypothesis family receives step-down Holm adjustment at familywise alpha 0.05, with stable J1-then-J2 tie handling. No family is selected or reduced after outcomes.

Simultaneous intervals use the 0.975 quantile of each absolute bootstrap-t distribution, providing the protocol's Bonferroni construction for two members. The declared finite-replicate convention takes one-based order statistic ceil((9,999+1)*0.975)=9,750 without interpolation. Symmetric intervals are clipped to the mathematical contrast range [-1,1].

The delta=0.005 band is unchanged. An interval strictly above delta is BENEFICIAL; one strictly below minus delta is HARMFUL; one entirely inside the closed band is EQUIVALENT. All other cases are INCONCLUSIVE. Failure to reject zero is not itself equivalence.

## 4. Degeneracy and failure preservation

Observed zero within-scenario standard error gives p=1, interval [-1,1] and INCONCLUSIVE. It is not turned into certainty or practical equivalence. A bootstrap replicate with zero standard error receives an infinite absolute pivot and remains among the 9,999 replicates. No redraw, omission or denominator adjustment is permitted. Infinite pivots are serialised as the explicit string `+Infinity`; JSON NaN and non-standard infinite number literals are rejected.

The strict raw verifier preserves legitimate engine failure records. This includes construction failure before an arm session exists, for which a null failure offset can be valid when the original status and full loss penalty agree. Treatment unavailability and future-prediction failure retain their planned denominator and appropriate loss-one penalties. A filesystem, controller or otherwise unclassified execution error is quarantined, not relabelled as a learner failure.

## 5. Reproducible draws and numerical reproduction

Each locked seed is parsed from its full decimal string and checked against its hexadecimal representation and seed address. The values must not pass through an inexact JavaScript Number conversion. NumPy 2.3.5 uses Generator(PCG64(seed)) with high-exclusive integers from zero to 79, dtype int64, shape (batch,14,80) and batches of 250, with the final shorter batch.

The resulting C-order uint8 index tapes contain 11,198,880 entries per hypothesis. Their SHA-256 digests are frozen in `DRAW_SCHEDULE_SEALS.json` and must match on every host. An index identifies a within-scenario stream position; it contains no experimental feature, label or outcome. NumPy's own compatibility documentation makes clear that reproducibility is not established by a seed alone: the call sequence, arguments, build and environment matter. Accordingly, the package checks actual tapes and records the runtime rather than relying only on a package version claim.

The separately written Node program checks tape digests and computes all moments, bootstrap replicates, pivots, rank-based intervals, plus-one p-values, Holm adjustments and classifications without importing the Python statistical kernel. It shares the specified tape, raw count tensor and methodological specification. Agreement therefore qualifies independent arithmetic implementation, not an independently generated study or a wholly independent software supply chain.

## 6. Reporting boundaries

Scenario, family, checkpoint and embedded-horizon secondary outputs are descriptive point summaries. Additional secondary confidence intervals, tests or multiplicity decisions have not been silently invented. The primary J1/J2 analyser is ready; that fact must not be represented as execution of all conceivable secondary analyses.

All resource metrics retain their acquisition scope. Process-lifetime high-water RSS is collected while arms run sequentially within a worker; it is not an isolated peak for each arm. Accumulated prediction time does not identify latency quantiles. Missing end-state measurements are explicitly missing rather than zero. Descriptive resource contrasts omit an arm-specific causal RSS comparison and do not convert APW, time or bytes into money.

## 7. Technical documentation consulted

The following official documentation was used to check implementation semantics. These are software documentation pages, not research articles; no DOI is assigned here.

| Source | Relevant implementation fact | Verified URL |
|---|---|---|
| NumPy Developers. (n.d.). *Compatibility policy* (NumPy 2.3 documentation). | Call shape, arguments, build and environment are part of the random-stream compatibility conditions. | https://numpy.org/doc/2.3/reference/random/compatibility.html |
| NumPy Developers. (n.d.). *Permuted congruential generator (64-bit, PCG64)* (NumPy 2.3 documentation). | Integer seed processing and the PCG64 bit-generator interface. | https://numpy.org/doc/2.3/reference/random/bit_generators/pcg64.html |
| NumPy Developers. (n.d.). *numpy.random.Generator.integers* (NumPy 2.3 documentation). | Integer dtype, array shape and high-exclusive sampling semantics. | https://numpy.org/doc/2.3/reference/random/generated/numpy.random.Generator.integers.html |

Retrieved 12 September 2026. The retained I04/I05 texts and F11 numerical source are in `08_NEW_EVIDENCE/specification_sources`. They remain project evidence, not independently peer-reviewed validation of this implementation.
