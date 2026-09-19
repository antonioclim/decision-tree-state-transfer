# State-transfer interventions in adaptive decision-tree populations under concept drift

This public companion repository accompanies the manuscript *State-Transfer Interventions in Adaptive Decision-Tree Populations under Concept Drift: Confirmatory Policy Effects, Ordered Decomposition and Resource Trade-offs*.

**Creators:** Andrei Toma and Antonio Clim, Bucharest University of Economic Studies.  
**Release:** v1.0.0 (19 September 2026).  
**Historical operations repository:** retained privately and not modified by this release.

## Scientific scope

The companion separates two locked experiments.

- **Study 1** evaluates complete state-transformation policies over 4,480 independent streams in 14 prespecified synthetic scenarios. The primary family contains H₁, H₂ and H₃.
- **Study 2** is a separate ordered-decomposition extension over 1,120 independent streams. Its fixed primary family contains J₁ and J₂. The derived contrast Jₛᵤₘ is descriptive and has no additional confirmatory p-value.
- **Decision economics** retains total APW, CPU time, elapsed time, prediction time, state size and provenance size as separate native resource axes. No monetary, energy or carbon conversion is asserted.

## Repository map

- `assets/code/confirmatory/` — qualified scientific engine source used by the locked programmes
- `assets/code/lib/` — shared algorithmic utilities
- `protocols/study1/` and `protocols/study2/` — prospective locks and implementation bindings
- `analysis/study1/` — Study 1 primary and decision-economics analysis code
- `analysis/study2/` — Study 2 inferential implementation and unit tests
- `analysis/decision_economics/` — I07 resource analysis and contracts
- `data/` — analysis-ready outputs, resource panels, final tables and figure source data
- `validation/` — public-tree integrity, privacy, licence and reproduction validators

## Reproduction boundaries

The source repository is intentionally smaller than the archival evidence deposit. Full raw Study 1 and Study 2 evidence is assigned to the separate Zenodo archive because it is too large and too granular for normal Git history. This tree contains the locked code, protocols, analysis-ready inputs and official outputs needed to inspect the implementation and reproduce the published summaries.

No operational cloud launcher, consumed authority, VM path, private handover, literature PDF or submission-facing document is included.

## Quick validation

```bash
python3 -B validation/validate_public_candidate.py
python3 -B validation/reproduce_study2_public.py
```

The static validator checks the release manifest, file modes, file-level licence resolution, machine-readable syntax and the absence of known credential or private-path patterns. The second command independently reproduces the complete Study 2 J₁–J₂ numerical object from the admitted count tensor and fixed draw tapes, then requires exact JSON equality with the sealed independent Node result. Neither command reruns a learner or contacts a cloud service.

## Citation and archival record

Use `CITATION.cff` for software citation metadata. The extended evidence archive is deposited separately on Zenodo and is related to the exact GitHub tag `v1.0.0`. The final DOI is added to the article's Data Availability Statement after Zenodo publication.

## Licence

This repository uses a file-level multi-licence. Original software, tests and validation utilities are distributed under **PolyForm Noncommercial 1.0.0**. Original protocols, documentation, manifests and generated scientific evidence are distributed under **CC BY-NC 4.0**. See `LICENSE-POLICY.md`, `NOTICE.md` and `licensing/licence-map.json`.
