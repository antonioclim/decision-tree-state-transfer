# I05 — Locked analysis plan for Study 2

## Primary family

- **J1:** CHAMPION-RESEED minus POPULATION-RESEED loss.
- **J2:** POPULATION-RESEED minus PERSIST loss.

Positive signs favour retaining the added state component.

## Estimator

For each independent stream, average the two checkpoint-specific arm contrasts. Then compute the equal-weight mean of scenario-specific stream means.

## Bootstrap

Resample whole streams with replacement within each scenario. All arms and checkpoints remain paired. Use `B=9,999`. Compute studentised absolute pivots. Report plus-one p-values. Apply Holm to the fixed family of two and Bonferroni simultaneous intervals.

## Practical classification

Use `delta=0.005` without modification. Equivalence requires the entire simultaneous interval within `[-0.005,+0.005]`.

## Cancellation diagnostic

- J1 and J2 both equivalent: componentwise equivalence;
- opposite beneficial/harmful classifications: cancellation;
- one non-equivalent and the other equivalent: asymmetric component contribution;
- any inconclusive classification: unresolved decomposition.

This diagnostic is descriptive of the two locked order-specific increments and is not a Shapley decomposition.

## Secondary family

Family and checkpoint interactions are prespecified secondary. They do not enter the primary Holm family and do not redefine the target mixture.
