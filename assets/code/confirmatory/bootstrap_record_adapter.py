"""Connect the unchanged cell-denominator contract to the A2 candidate on fixtures.

This adapter does not admit raw event files or unlock confirmatory execution.
"""
from __future__ import annotations
from collections.abc import Iterable
import numpy as np
from analysis import aggregate_records, decision
from bootstrap_analysis import NativeKernel, infer_bootstrap


def analyse_records(records: Iterable[dict], scenarios: list[str], *, namespace: str,
                    case: str, kernel: NativeKernel, n_streams: int = 20,
                    optimiser_count: int = 3, checkpoints: tuple[int, ...] = (10000, 20000),
                    horizon: int = 2000, partition: str = 'FIXTURE', resamples: int = 9999) -> dict:
    """Aggregate each paired stream before resampling; preserve failed-parent slots."""
    if partition not in ('FIXTURE', 'DEV'):
        raise ValueError('CONF and REAL execution are not authorised')
    if any(type(v) is not int for v in (n_streams, optimiser_count, horizon)) or horizon < 1:
        raise ValueError('literal integer design dimensions are required')
    if not checkpoints or len(set(checkpoints)) != len(checkpoints) or any(type(c) is not int or c < 1 for c in checkpoints):
        raise ValueError('unique positive checkpoint indices are required')
    records = list(records)
    for record in records:
        if not isinstance(record, dict) or any(type(record.get(key)) is not int
                for key in ('realisation', 'optimiser', 'checkpoint', 'predictions')):
            raise ValueError('literal integer record keys and denominators are required')
        if type(record.get('loss')) not in (int, float):
            raise ValueError('loss must be a JSON number, not a boolean or substituted value')
    values = aggregate_records(records, scenarios, n_streams=n_streams,
                               optimiser_count=optimiser_count, checkpoints=checkpoints,
                               horizon=horizon, partition=partition)
    result = infer_bootstrap(values, namespace=namespace, case=case, kernel=kernel,
                             resamples=resamples, partition=partition)
    result = {key: value.tolist() if isinstance(value, np.ndarray) else value
              for key, value in result.items()}
    result.update({'independent_unit': 'scenario_stream',
                   'independent_streams': len(scenarios) * n_streams,
                   'nested_optimiser_count': optimiser_count, 'checkpoints': list(checkpoints),
                   'scenario_weight': 'equal',
                   'interval_decisions': [decision(lo, hi) for lo, hi in zip(result['lower'], result['upper'])],
                   'event_file_admission': False, 'execution_lock_satisfied': False})
    return result
