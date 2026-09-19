# I05 — POPULATION-RESEED composer specification

## Scientific object

`POPULATION-RESEED` is the `CR` cell in the natural dependency chain `C ≤ CR ≤ CRO`. It is not a raw snapshot edit. It is a deterministic transformation from a verified parent snapshot to a fresh learner whose **predictive population semantics** are preserved but whose **continuation metadata** are reset.

## Semantic state retained

1. champion tree hash and prediction function;
2. multiset of all population tree hashes, including multiplicity;
3. model configuration;
4. checkpoint and revealed window;
5. source-tape identity.

## State reset

1. optimiser base key/context;
2. individual IDs;
3. ordinals and tie-breaking order;
4. parent links;
5. `nextOrdinal`;
6. `completedUpdates`;
7. `eventSerial`;
8. inherited provenance IDs;
9. treatment and update receipts;
10. any cached fitness or selection history.

## Canonical ordering

The champion receives canonical rank zero. Remaining trees are ordered by semantic tree digest, then by duplicate rank derived from the sorted multiset. The rule must not inspect future data or outcomes. The ordering is part of the intervention and therefore part of the estimand.

## Fresh randomness

CHAMPION-RESEED and POPULATION-RESEED use reset optimiser keys derived from their locked source and treatment addresses. PERSIST retains the continuation context. Randomness is addressed; no shared sequential cursor is allowed.

## Proof obligations before EXT values

- exact champion digest conservation;
- exact population tree-digest multiset conservation;
- zero inherited ID/counter/parent-link leakage;
- duplicate-safe deterministic reconstruction;
- referentially closed provenance;
- equal declared APW envelope;
- charged construction work;
- differential replay on DEV;
- metamorphic permutation tests;
- fail-closed treatment unavailability.

Failure of any obligation stops I06 before EXT source materialisation.
