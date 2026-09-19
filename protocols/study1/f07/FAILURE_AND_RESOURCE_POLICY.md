# F07 — Development failure and resource policy

**Status:** prospectively frozen for F08 development execution only  
**CONF:** not authorised  
**Primary purpose:** prevent selective reruns, silent fallbacks and favourable missing-data handling.

## Failure classes

`ENVIRONMENT_INVALID` means that the declared runtime, distribution version or required upstream identity is absent or different. It produces no scientific record. The environment must be repaired or versioned before rerunning.

`INFRASTRUCTURE_INVALID` means that immutable source identity, tape integrity, process supervision or evidence persistence is not trustworthy. It blocks scientific use of the affected run.

`ALGORITHMIC_FAILURE` begins only after a cell has passed environment and source admission and the comparator itself crashes, raises an algorithm-level exception or becomes unable to issue a prediction/update. The failure point is retained. Every remaining scheduled prediction slot in the declared horizon receives 0–1 loss 1. A separate failure indicator and time-to-failure are retained.

`ALGORITHMIC_FAILURE_RESOURCE_LIMIT` is the same operational class when the admitted comparator exceeds the prospectively declared 2048 MiB process RSS ceiling. It is not silently converted into infrastructure failure merely because the result is unfavourable.

## No favourable deletion

Failed algorithmic cells remain in the planned denominator. There is no complete-case primary mean that drops failed methods. Available-only summaries may be reported only as explicitly descriptive diagnostics alongside the operational estimand.

No silent retry, fallback implementation, package substitution, seed replacement, horizon shortening or post-outcome timeout is allowed.

## Timeout

F07 deliberately does **not** choose a scientific wall-clock timeout. A method that is merely slow is not a failure. F08 may measure runtime and determine whether a prospectively justified execution-safety timeout is needed for later phases, but it cannot set a threshold by looking for a value that preferentially preserves or removes a comparator.

## Process policy

One scored cell executes at a time in a fresh process. Python BLAS/OpenMP thread-count variables are set to one. JVM comparators use one active processor, SerialGC, UTF-8 and UTC. The source may benefit from ordinary operating-system page cache; run order is therefore retained and no claim of perfect cold-cache equality is permitted.

Resource measures are implementation-level realised costs. They must not be relabelled as APW, FLOPs or hardware-independent algorithmic complexity.

## F02 firewall

Nothing in this policy changes the APW-matched F02 causal interventions. External comparator failures, CPU times or predictive rankings do not identify H1–H3.
