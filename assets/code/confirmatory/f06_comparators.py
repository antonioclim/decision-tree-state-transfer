"""F06 comparator adapters for the redesigned decision-tree drift study.

This module defines a fail-closed integration surface. It does not authorise a DEV
pilot or CONF execution and it deliberately does not reuse the historical River
0.22.0 R06 profiles.
"""
from __future__ import annotations

from dataclasses import dataclass
import importlib
import importlib.metadata
from typing import Any, Callable, Protocol

RIVER_VERSION = "0.26.1"
SKLEARN_VERSION = "1.9.0"
RIVER_METHODS = ("HAT", "ARF", "EFDT", "SRP")
CART_METHODS = ("FROZEN_CART", "ROLLING_CART")
F02_CAUSAL_TREATMENTS = (
    "PERSIST", "RESTART-CART", "CHAMPION-RESEED",
    "MATERIAL-REPLACE", "STRUCTURAL-SHAM",
)


class ComparatorConfigurationError(ValueError):
    pass


class ComparatorDependencyError(RuntimeError):
    pass


class StrictSource(Protocol):
    end: int

    def features(self) -> tuple[int, dict[str, float]]: ...
    def label(self, index: int) -> int: ...
    def finish(self) -> None: ...


@dataclass(frozen=True)
class EvaluationSummary:
    method: str
    warmup_rows: int
    prediction_calls: int
    learn_calls: int
    loss_sum: int
    mean_loss: float
    scientific_admission: bool = False
    confirmation_authorised: bool = False


def _require_exact_distribution(distribution: str, expected: str) -> str:
    try:
        actual = importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError as exc:
        raise ComparatorDependencyError(
            f"required distribution unavailable: {distribution}=={expected}"
        ) from exc
    if actual != expected:
        raise ComparatorDependencyError(
            f"distribution mismatch: required {distribution}=={expected}, observed {actual}"
        )
    return actual


def _require_seed(seed: int | None, method: str) -> int:
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ComparatorConfigurationError(
            f"{method} requires a predeclared unsigned 32-bit seed"
        )
    return seed


def build_river(method: str, seed: int | None = None) -> tuple[Any, dict[str, Any]]:
    """Construct exact River 0.26.1 comparator profiles.

    Scientifically material defaults are supplied explicitly. Exact package-version
    locking prevents future River defaults from silently changing the comparator.
    EFDT has no stochastic seed parameter in River 0.26.1 and therefore requires
    ``seed=None``. HAT, ARF and SRP require a scheduled seed.
    """
    if method not in RIVER_METHODS:
        raise ComparatorConfigurationError(f"unsupported River comparator: {method}")
    version = _require_exact_distribution("river", RIVER_VERSION)
    if method == "HAT":
        tree = importlib.import_module("river.tree")
        s = _require_seed(seed, method)
        model = tree.HoeffdingAdaptiveTreeClassifier(
            grace_period=200,
            max_depth=None,
            split_criterion="info_gain",
            delta=1e-7,
            tau=0.05,
            leaf_prediction="nba",
            nb_threshold=0,
            nominal_attributes=None,
            splitter=None,
            bootstrap_sampling=True,
            drift_window_threshold=300,
            drift_detector=None,
            switch_significance=0.05,
            binary_split=False,
            min_branch_fraction=0.01,
            max_share_to_split=0.99,
            max_size=100.0,
            memory_estimate_period=1_000_000,
            stop_mem_management=False,
            remove_poor_attrs=False,
            merit_preprune=True,
            seed=s,
        )
        profile = {"seed": s, "profile": "RIVER_0_26_1_REFERENCE_DEFAULTS_EXPLICIT"}
    elif method == "ARF":
        s = _require_seed(seed, method)
        forest = importlib.import_module("river.forest")
        model = forest.ARFClassifier(
            n_models=10,
            max_features="sqrt",
            lambda_value=6,
            metric=None,
            disable_weighted_vote=False,
            drift_detector=None,
            warning_detector=None,
            grace_period=50,
            max_depth=None,
            split_criterion="info_gain",
            delta=0.01,
            tau=0.05,
            leaf_prediction="nba",
            nb_threshold=0,
            nominal_attributes=None,
            splitter=None,
            binary_split=False,
            min_branch_fraction=0.01,
            max_share_to_split=0.99,
            max_size=100.0,
            memory_estimate_period=2_000_000,
            stop_mem_management=False,
            remove_poor_attrs=False,
            merit_preprune=True,
            seed=s,
        )
        profile = {"seed": s, "profile": "RIVER_0_26_1_REFERENCE_DEFAULTS_EXPLICIT"}
    elif method == "EFDT":
        tree = importlib.import_module("river.tree")
        if seed is not None:
            raise ComparatorConfigurationError("EFDT in River 0.26.1 has no seed parameter")
        model = tree.ExtremelyFastDecisionTreeClassifier(
            grace_period=200,
            max_depth=None,
            min_samples_reevaluate=20,
            split_criterion="info_gain",
            delta=1e-7,
            tau=0.05,
            leaf_prediction="nba",
            nb_threshold=0,
            nominal_attributes=None,
            splitter=None,
            binary_split=False,
            min_branch_fraction=0.01,
            max_share_to_split=0.99,
            max_size=100.0,
            memory_estimate_period=1_000_000,
            stop_mem_management=False,
            remove_poor_attrs=False,
            merit_preprune=True,
        )
        profile = {"seed": None, "profile": "RIVER_0_26_1_REFERENCE_DEFAULTS_EXPLICIT"}
    else:
        s = _require_seed(seed, method)
        ensemble = importlib.import_module("river.ensemble")
        model = ensemble.SRPClassifier(
            model=None,
            n_models=10,
            subspace_size=0.6,
            training_method="patches",
            lam=6,
            drift_detector=None,
            warning_detector=None,
            disable_detector="off",
            disable_weighted_vote=False,
            seed=s,
            metric=None,
        )
        profile = {"seed": s, "profile": "RIVER_0_26_1_REFERENCE_DEFAULTS_EXPLICIT"}

    return model, {
        "method": method,
        "library": "river",
        "version": version,
        **profile,
        "scientific_admission": False,
        "confirmation_authorised": False,
    }


def build_cart(random_state: int) -> tuple[Any, dict[str, Any]]:
    """Construct the standard scikit-learn 1.9.0 CART classifier.

    Window length and refit cadence are not chosen here. F07 must set those
    prospectively for ROLLING_CART before F09 freezes CONF.
    """
    s = _require_seed(random_state, "CART")
    version = _require_exact_distribution("scikit-learn", SKLEARN_VERSION)
    tree = importlib.import_module("sklearn.tree")
    model = tree.DecisionTreeClassifier(
        criterion="gini",
        splitter="best",
        max_depth=None,
        min_samples_split=2,
        min_samples_leaf=1,
        min_weight_fraction_leaf=0.0,
        max_features=None,
        random_state=s,
        max_leaf_nodes=None,
        min_impurity_decrease=0.0,
        class_weight=None,
        ccp_alpha=0.0,
        monotonic_cst=None,
    )
    return model, {
        "method": "CART",
        "library": "scikit-learn",
        "version": version,
        "seed": s,
        "profile": "SKLEARN_1_9_0_REFERENCE_DEFAULTS_EXPLICIT",
        "scientific_admission": False,
        "confirmation_authorised": False,
    }


def evaluate_streaming(source: StrictSource, model: Any, *, method: str, warmup_rows: int) -> EvaluationSummary:
    """Strict test-then-train loop for HAT/ARF/EFDT/SRP-like learners.

    The source API keeps each label unavailable until the corresponding feature
    request. During the scored horizon prediction occurs before label reveal and
    learning occurs only after reveal. Missing predictions count as 0-1 errors.
    Runtime failures are intentionally not swallowed or replaced by another model.
    """
    if method not in RIVER_METHODS:
        raise ComparatorConfigurationError("streaming evaluator accepts only declared River methods")
    if type(warmup_rows) is not int or not 1 <= warmup_rows < source.end:
        raise ComparatorConfigurationError("warmup_rows must lie inside the source extent")
    losses: list[int] = []
    learns = 0
    predictions = 0
    for expected in range(1, source.end + 1):
        index, x = source.features()
        if index != expected:
            raise ComparatorConfigurationError("source order changed")
        if index <= warmup_rows:
            y = source.label(index)
            model.learn_one(x, y)
            learns += 1
            continue
        prediction = model.predict_one(x)
        predictions += 1
        y = source.label(index)
        losses.append(int(prediction is None or prediction != y))
        model.learn_one(x, y)
        learns += 1
    source.finish()
    return EvaluationSummary(
        method=method,
        warmup_rows=warmup_rows,
        prediction_calls=predictions,
        learn_calls=learns,
        loss_sum=sum(losses),
        mean_loss=sum(losses) / len(losses),
    )


def evaluate_cart(
    source: StrictSource,
    *,
    method: str,
    random_state: int,
    warmup_rows: int,
    rolling_window: int | None = None,
    refit_every: int | None = None,
    estimator_factory: Callable[[int], Any] | None = None,
) -> EvaluationSummary:
    """Strict frozen/rolling CART control with refits only after score and reveal.

    The optional estimator factory exists for dependency-free order tests. Scientific
    runs must omit it so that the exact scikit-learn builder is used.
    """
    if method not in CART_METHODS:
        raise ComparatorConfigurationError("unsupported CART control")
    if type(warmup_rows) is not int or not 2 <= warmup_rows < source.end:
        raise ComparatorConfigurationError("invalid CART warm-up")
    if method == "ROLLING_CART":
        if type(rolling_window) is not int or rolling_window < 2:
            raise ComparatorConfigurationError("ROLLING_CART requires predeclared rolling_window")
        if type(refit_every) is not int or refit_every < 1:
            raise ComparatorConfigurationError("ROLLING_CART requires predeclared refit_every")
    elif rolling_window is not None or refit_every is not None:
        raise ComparatorConfigurationError("FROZEN_CART does not accept rolling controls")

    factory = estimator_factory
    if factory is None:
        factory = lambda s: build_cart(s)[0]

    xs: list[list[float]] = []
    ys: list[int] = []
    ordered_keys: tuple[str, ...] | None = None
    model = None
    losses: list[int] = []
    fit_calls = 0
    predictions = 0

    for expected in range(1, source.end + 1):
        index, x = source.features()
        if index != expected:
            raise ComparatorConfigurationError("source order changed")
        keys = tuple(sorted(x))
        if ordered_keys is None:
            ordered_keys = keys
        elif keys != ordered_keys:
            raise ComparatorConfigurationError("feature schema changed")
        row = [x[k] for k in ordered_keys]

        if index <= warmup_rows:
            y = source.label(index)
            xs.append(row)
            ys.append(y)
            if index == warmup_rows:
                model = factory(random_state)
                model.fit(xs, ys)
                fit_calls += 1
            continue

        if model is None:
            raise ComparatorConfigurationError("CART was not fitted on the warm-up")
        prediction = model.predict([row])[0]
        predictions += 1
        y = source.label(index)
        losses.append(int(prediction != y))
        xs.append(row)
        ys.append(y)

        # The scored row is now revealed and may enter the next fit. Never refit
        # before scoring the row that triggered the cadence boundary.
        if method == "ROLLING_CART" and (index - warmup_rows) % refit_every == 0:
            model = factory(random_state)
            model.fit(xs[-rolling_window:], ys[-rolling_window:])
            fit_calls += 1

    source.finish()
    # fit_calls is encoded in learn_calls because batch refit is the control's update event.
    return EvaluationSummary(
        method=method,
        warmup_rows=warmup_rows,
        prediction_calls=predictions,
        learn_calls=fit_calls,
        loss_sum=sum(losses),
        mean_loss=sum(losses) / len(losses),
    )
