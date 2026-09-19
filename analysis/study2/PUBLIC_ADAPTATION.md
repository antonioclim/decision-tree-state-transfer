# Publication adaptation of the Study 2 analysis package

The qualified analysis source is retained with its frozen file hashes. The original package expected a sealed checkpoint directory and an unredacted protocol lock containing environment-specific acquisition paths. Those operational paths are deliberately not published.

`reproduce_public.mjs` is a narrowly scoped derivative of `reproduce_frozen.mjs`. It changes only protocol-file resolution and verifies that the publication-safe protocol derivative is cryptographically bound to the original immutable protocol SHA-256. The numerical algorithm, estimands, draw tapes, resampling counts, critical rank, Holm family and practical-equivalence margin are unchanged.

The campaign execution kit, launchers, consumed authorities and sealed-layout qualification tests are excluded from the public tree. The public reproducer operates only on the admitted analysis-ready counts and fixed draw tapes; it cannot generate or admit new scientific units.
