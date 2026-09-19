from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
import unittest

MODULE = Path(__file__).parents[1] / "assets" / "code" / "confirmatory" / "f06_comparators.py"
spec = importlib.util.spec_from_file_location("f06_comparators", MODULE)
f06 = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = f06
spec.loader.exec_module(f06)


class StrictFixtureSource:
    def __init__(self, rows):
        self.rows = rows
        self.end = len(rows)
        self.i = 0
        self.pending = None
        self.log = []

    def features(self):
        if self.pending is not None:
            raise AssertionError("label not consumed")
        self.pending = self.i
        index = self.i + 1
        self.log.append(("features", index))
        return index, dict(self.rows[self.i][0])

    def label(self, index):
        if self.pending != index - 1:
            raise AssertionError("label requested before matching features")
        self.log.append(("label", index))
        y = self.rows[self.pending][1]
        self.i += 1
        self.pending = None
        return y

    def finish(self):
        if self.i != self.end or self.pending is not None:
            raise AssertionError("source not fully consumed")
        self.log.append(("finish", self.end))


class OnlineSpy:
    def __init__(self, source):
        self.source = source
        self.learned = 0
        self.predicted = 0

    def predict_one(self, x):
        index = self.source.i + 1
        assert self.source.log[-1] == ("features", index)
        self.predicted += 1
        return 0

    def learn_one(self, x, y):
        index = self.source.i
        assert self.source.log[-1] == ("label", index)
        self.learned += 1


class CartSpy:
    def __init__(self, registry):
        self.registry = registry
        self.fit_history = []
        registry.append(self)

    def fit(self, xs, ys):
        self.fit_history.append((len(xs), tuple(ys)))
        return self

    def predict(self, rows):
        return [0]


class F06ComparatorTests(unittest.TestCase):
    def test_namespaces_do_not_conflate_benchmark_with_causal_treatments(self):
        self.assertTrue(set(f06.RIVER_METHODS).isdisjoint(f06.F02_CAUSAL_TREATMENTS))
        self.assertTrue(set(f06.CART_METHODS).isdisjoint(f06.F02_CAUSAL_TREATMENTS))

    def test_dependency_check_is_fail_closed(self):
        with self.assertRaises(f06.ComparatorDependencyError):
            f06._require_exact_distribution("definitely-not-an-installed-f06-package", "1.0")

    def test_seed_contract_rejects_invalid_values(self):
        for value in (None, -1, 2**32, True, 1.5, "7"):
            with self.assertRaises(f06.ComparatorConfigurationError):
                f06._require_seed(value, "TEST")
        self.assertEqual(f06._require_seed(7, "TEST"), 7)

    def test_streaming_order_is_predict_score_reveal_then_update(self):
        rows = [({"x0": float(i), "x1": 0.0}, i % 2) for i in range(1, 7)]
        source = StrictFixtureSource(rows)
        model = OnlineSpy(source)
        result = f06.evaluate_streaming(source, model, method="HAT", warmup_rows=2)
        self.assertEqual(result.prediction_calls, 4)
        self.assertEqual(result.learn_calls, 6)
        self.assertFalse(result.scientific_admission)
        for index in range(3, 7):
            fpos = source.log.index(("features", index))
            lpos = source.log.index(("label", index))
            self.assertLess(fpos, lpos)

    def test_missing_stream_prediction_counts_as_error(self):
        class Missing(OnlineSpy):
            def predict_one(self, x):
                super().predict_one(x)
                return None
        source = StrictFixtureSource([({"x": float(i)}, i % 2) for i in range(5)])
        result = f06.evaluate_streaming(source, Missing(source), method="ARF", warmup_rows=2)
        self.assertEqual(result.loss_sum, 3)
        self.assertEqual(result.mean_loss, 1.0)

    def test_frozen_cart_fits_once_and_never_sees_future_before_prediction(self):
        registry = []
        factory = lambda seed: CartSpy(registry)
        source = StrictFixtureSource([({"x0": float(i)}, i % 2) for i in range(1, 8)])
        result = f06.evaluate_cart(source, method="FROZEN_CART", random_state=3,
                                   warmup_rows=3, estimator_factory=factory)
        self.assertEqual(result.learn_calls, 1)
        self.assertEqual(result.prediction_calls, 4)
        self.assertEqual(registry[0].fit_history[0][0], 3)

    def test_rolling_cart_refits_only_after_reveal_and_respects_window(self):
        registry = []
        factory = lambda seed: CartSpy(registry)
        source = StrictFixtureSource([({"x0": float(i)}, i % 2) for i in range(1, 10)])
        result = f06.evaluate_cart(source, method="ROLLING_CART", random_state=3,
                                   warmup_rows=3, rolling_window=4, refit_every=2,
                                   estimator_factory=factory)
        self.assertEqual(result.learn_calls, 4)
        self.assertEqual([m.fit_history[0][0] for m in registry], [3, 4, 4, 4])
        self.assertEqual(result.prediction_calls, 6)

    def test_cart_window_and_cadence_are_mandatory_not_guessed(self):
        source = StrictFixtureSource([({"x": float(i)}, i % 2) for i in range(4)])
        with self.assertRaises(f06.ComparatorConfigurationError):
            f06.evaluate_cart(source, method="ROLLING_CART", random_state=1, warmup_rows=2,
                              estimator_factory=lambda seed: CartSpy([]))


if __name__ == "__main__":
    unittest.main()
