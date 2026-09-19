# F13 manuscript-facing tables

## Table 1. Primary confirmatory inference

| Hypothesis | Estimate (pp) | Simultaneous CI (pp) | Holm p | Practical class |
|---|---:|---:|---:|---|
| H1 | 0.6003 | [0.5536, 0.6471] | 0.0003 | BENEFICIAL |
| H2 | -0.0165 | [-0.0508, 0.0179] | 0.2504 | EQUIVALENT |
| H3 | 1.8945 | [1.8120, 1.9771] | 0.0003 | BENEFICIAL |

## Table 2. Internal state/resource summary

| Arm | Loss | APW | CPU s | Elapsed s | Mean RSS MiB | End-state MiB |
|---|---:|---:|---:|---:|---:|---:|
| PERSIST | 0.231807 | 65,312,519.995 | 6.521 | 6.555 | 349.734 | 2.828 |
| RESTART-CART | 0.237797 | 65,312,519.992 | 6.700 | 6.734 | 350.223 | 3.132 |
| CHAMPION-RESEED | 0.231622 | 65,312,519.995 | 6.585 | 6.619 | 350.453 | 2.970 |

## Table 3. Contextual comparator summary

| Method | Loss | CPU s | Mean RSS MiB | p95 latency µs | Frontier role |
|---|---:|---:|---:|---:|---|
| HAT | 0.187518 | 3.406 | 117.649 | 40.005 | supported CPU frontier |
| ARF | 0.186935 | 30.516 | 181.067 | 214.430 | Pareto-nondominated but unsupported |
| EFDT | 0.218623 | 7.514 | 117.758 | 23.431 | dominated on mean loss + CPU |
| SRP | 0.181882 | 78.232 | 233.400 | 298.607 | supported CPU frontier |
| FROZEN_CART | 0.283885 | 3.022 | 133.537 | 125.811 | supported CPU frontier |
| ROLLING_CART | 0.246443 | 6.804 | 134.330 | 132.281 | dominated on mean loss + CPU |
