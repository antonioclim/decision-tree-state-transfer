# F06 Hostile Comparator-Fairness Audit

## Verdict

**PASS WITH EXPLICIT F07 RUNTIME GATES.** The comparator architecture is scientifically defensible for progression to F07 because it separates causal identification from external benchmarking, removes the obsolete River 0.22.0 profiles from the redesigned baseline surface without deleting their historical evidence and refuses to manufacture approximations of unavailable nearest-neighbour methods. No comparator result has been generated in F06 and no CONF execution has been authorised.

## 1. Benchmark/estimand conflation

A reviewer could correctly reject an argument of the form “PERSIST beats HAT/ARF, therefore persistence is causally useful”. HAT and ARF differ simultaneously in representation, update rule, optimisation, drift detection and resource use. They cannot identify the counterfactual value of retained fitted state. The same applies to PLASTIC, EFDT and SRP. The only admissible estimands for the retained-state and inherited-material questions remain the paired F02 interventions under their declared controls. External comparators answer a different question: whether the proposed decision-support mechanism occupies a credible predictive/resource region relative to serious streaming alternatives.

**Disposition:** comparator IDs and F02 treatment IDs are separate namespaces in code and contract. Manuscript prose must preserve the distinction.

## 2. Historical River evidence is not the redesigned benchmark

The repository already contains a historical R06 adapter fixed to River 0.22.0. Its HAT, ARF and SRP profiles impose `max_depth=8` and majority-class leaves in configurations that were useful for the earlier evidence programme. They are not neutral 2026 reference implementations. Reusing them would expose the article to a straightforward baseline-engineering criticism.

**Disposition:** the historical adapter is preserved unchanged for provenance. F06 introduces a separate adapter fixed to River 0.26.1 and explicitly supplies the scientifically material reference defaults for HAT, ARF, EFDT and SRP. No old result is re-labelled.

## 3. Comparator set

### Required streaming baselines

- **HAT** is the single-tree drift-adaptive reference baseline.
- **ARF** is the strong drift-adaptive ensemble baseline with per-tree warning/drift handling.
- **EFDT** is the structural split-revision baseline and direct antecedent to PLASTIC.
- **SRP** prevents the benchmark from degenerating into an evolutionary learner compared only with individual trees.

### Contextual controls

- **FROZEN-CART** is a deliberately non-adaptive batch-tree control fitted only to admissible past data.
- **ROLLING-CART** is a retraining control that may refit only after the current row has been predicted, scored and revealed. Window size and refit cadence are adaptation-policy choices, not innocuous library defaults, so F07 must choose them prospectively.

### Nearest-neighbour method

**PLASTIC is scientifically important enough that its omission would need justification.** The official Java repository exists and the official CapyMOA-PLASTIC repository states that it contains a Python version plus the paper's experiment scripts. The Python route requires a MOA JAR built from the PLASTIC repository. The inspected Python snapshot also declares permissive package dependency names rather than a fully frozen transitive environment. Therefore F06 does not call this runtime qualified. The only acceptable future routes are the official Java/MOA implementation or the official CapyMOA bridge pinned to verified upstream commits. A home-grown “PLASTIC-like” implementation is prohibited.

The Java repository carries GPL-3.0 licence text. It must not be copied into the project's differently licensed clean publication code and then silently relicensed. Executing an independently built upstream artefact provides a cleaner provenance boundary. F17 must revisit redistribution details before publication.

### Literature-only comparators

**iLEAD** is too recent and relevant to ignore in related work, but its August 2026 article states that the CART+GP code is available upon reasonable request. Without that code, an experimental “iLEAD” reconstruction would be an unverifiable straw-man. **CEVOT** remains foundational prior art but no canonical runnable implementation was qualified here. **BTAD** remains a repair/retraining analogue, not an admitted numeric comparator. These exclusions narrow empirical claims rather than weaken integrity.

## 4. Hyperparameter fairness

F06 does not tune one baseline on the scored horizon while leaving others at defaults. River methods use the exact River 0.26.1 reference defaults, made explicit in the constructor and combined with a predeclared seed where the class is stochastic. This is a reference-profile benchmark, not an optimisation contest. If F07 later introduces tuning, it must use a symmetric DEV-only tuning protocol, a common information budget and a freeze before CONF. Post-hoc per-method tuning on CONF is prohibited.

For CART, constructor defaults are fixed but ROLLING-CART window/cadence remain prospectively open because they determine the adaptation policy itself. They must be selected in F07 and frozen in F09.

## 5. Data-order and leakage fairness

Every scored observation follows `features -> predict -> reveal label -> score -> update`. The current label cannot be used for prediction or a rolling CART refit. Targeted dependency-free tests exercise this order and verify that ROLLING-CART refits only after reveal. Source integrity, scenario, realisation and horizon must match across methods. Any future external-runtime bridge that cannot guarantee this order is inadmissible.

## 6. Resource fairness

Equalising abstract evolutionary work units across HAT, ARF, SRP, CART and PLASTIC would be pseudo-fairness because the work units do not denote the same computation. F06 therefore preserves APW matching only where it identifies the internal F02 intervention contrast. External methods run natively under one hardware/process policy and report realised CPU time, elapsed time, peak RSS, prediction latency, update/fit counts and algorithm-specific size/member counts. F12 may construct loss-resource Pareto and break-even analyses without fabricating monetary costs.

“Same compute budget” may only be claimed for contrasts where a genuinely comparable budget has been imposed and verified.

## 7. Failure fairness

Package absence, version mismatch and source-integrity failure are infrastructure invalidity, not poor predictive performance. The adapter fails closed and never substitutes another algorithm. Algorithmic failure after a valid start is different: it must remain visible in the planned cell rather than being dropped. F07 must freeze the exact joint loss/failure treatment before F09 so that failure handling cannot be selected after outcomes are known.

## 8. Remaining gates before any confirmatory claim

F07 must qualify the actual River 0.26.1 and scikit-learn 1.9.0 runtime, freeze the CART rolling policy, determine whether official PLASTIC can be built and driven under identical stream timing, freeze thread/process/resource measurement and run only a bounded DEV pilot. F09 then freezes the immutable CONF protocol. Until that point, this phase is comparator integration architecture, not comparative evidence.

## Final hostile judgement

The benchmark surface is materially stronger than the inherited repository state. The strongest decision is not adding more algorithms; it is refusing three common but fatal shortcuts: treating old River 0.22.0 profiles as contemporary baselines, presenting approximate reimplementations as named SOTA systems and using external benchmark differences as causal evidence about retained state. Those shortcuts would have made the manuscript easy to attack. F06 closes them.
