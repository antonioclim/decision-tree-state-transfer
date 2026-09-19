// Stratified paired bootstrap-t kernel. No stream generator or outcome selection.
// All H1/H2/H3 coordinates use the same sampled stream index within each stratum.
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace {
std::uint64_t next_word(std::uint64_t& state) {
    state += UINT64_C(0x9e3779b97f4a7c15);
    std::uint64_t z = state;
    z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
    return z ^ (z >> 31);
}
std::uint64_t index(std::uint64_t& state, std::uint64_t n) {
    const std::uint64_t threshold = (std::uint64_t(0) - n) % n;
    std::uint64_t word;
    do { word = next_word(state); } while (word < threshold);
    return word % n;
}
}

extern "C" int paired_bootstrap_t(const double* centred, std::size_t groups,
    std::size_t n, std::size_t resamples, std::uint64_t seed, double* out) {
    if (!centred || !out || groups == 0 || n < 2 || resamples == 0) return 1;
    for (std::size_t j=0; j < groups*n*3; ++j)
        if (!std::isfinite(centred[j])) return 2;
    std::uint64_t state = seed;
    const double denominator = double(groups) * double(groups) * double(n) * double(n-1);
    for (std::size_t b=0; b < resamples; ++b) {
        double total[3] = {0, 0, 0};
        double residual_ss[3] = {0, 0, 0};
        for (std::size_t g=0; g < groups; ++g) {
            double sums[3] = {0, 0, 0};
            double squares[3] = {0, 0, 0};
            double lo[3] = {INFINITY, INFINITY, INFINITY};
            double hi[3] = {-INFINITY, -INFINITY, -INFINITY};
            for (std::size_t i=0; i < n; ++i) {
                const double* row = centred + (g*n + index(state, n))*3;
                for (std::size_t h=0; h < 3; ++h) {
                    const double x = row[h]; sums[h] += x; squares[h] += x*x;
                    if (x < lo[h]) lo[h] = x;
                    if (x > hi[h]) hi[h] = x;
                }
            }
            for (std::size_t h=0; h < 3; ++h) {
                total[h] += sums[h];
                if (lo[h] != hi[h]) {
                    const double ss = squares[h] - sums[h]*sums[h]/double(n);
                    if (!(ss > 0)) return 3; // Numerical failure is not a zero-variance fixture.
                    residual_ss[h] += ss;
                }
            }
        }
        for (std::size_t h=0; h < 3; ++h) {
            const double delta = total[h]/(double(groups)*double(n));
            const double se = std::sqrt(residual_ss[h]/denominator);
            out[b*3+h] = se > 0 ? delta/se
                : (delta == 0 ? 0 : std::copysign(std::numeric_limits<double>::infinity(), delta));
        }
    }
    return 0;
}
