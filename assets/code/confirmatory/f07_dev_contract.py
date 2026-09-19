"""F07 prospective DEV-design validator and canonical seed generator.

This module validates design identities only. It never generates stream values and
never authorises confirmation execution.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

SCENARIOS = (
    "LOCAL_TREE-STATIONARY-NONE", "LOCAL_TREE-ABRUPT-MILD", "LOCAL_TREE-ABRUPT-SEVERE",
    "LOCAL_TREE-GRADUAL-MILD", "LOCAL_TREE-GRADUAL-SEVERE", "LOCAL_TREE-RECURRENT-MILD",
    "LOCAL_TREE-RECURRENT-SEVERE", "OBLIQUE-STATIONARY-NONE", "OBLIQUE-ABRUPT-MILD",
    "OBLIQUE-ABRUPT-SEVERE", "OBLIQUE-GRADUAL-MILD", "OBLIQUE-GRADUAL-SEVERE",
    "OBLIQUE-RECURRENT-MILD", "OBLIQUE-RECURRENT-SEVERE",
)
METHODS = ("HAT", "ARF", "EFDT", "SRP", "FROZEN_CART", "ROLLING_CART", "PLASTIC")
SEEDED = frozenset({"HAT", "ARF", "SRP", "FROZEN_CART", "ROLLING_CART", "PLASTIC"})
PILOT = (
    "LOCAL_TREE-STATIONARY-NONE", "OBLIQUE-STATIONARY-NONE",
    "LOCAL_TREE-ABRUPT-SEVERE", "OBLIQUE-ABRUPT-SEVERE",
    "LOCAL_TREE-GRADUAL-MILD", "OBLIQUE-GRADUAL-MILD",
    "LOCAL_TREE-RECURRENT-SEVERE", "OBLIQUE-RECURRENT-SEVERE",
)
HEADER = (
    "scenario_id\trealisation\tstream_key_hex\tmethod\tseed_applied\t"
    "seed_hex\tseed_uint32\taddress_sha256\n"
)


def stream_key(scenario: str, realisation: int) -> str:
    if scenario not in SCENARIOS or type(realisation) is not int or not 0 <= realisation < 3:
        raise ValueError("F07 DEV scenario and realisation required")
    address = f"DT-P9-v1|DEV|{scenario}|r={realisation:02d}"
    return hashlib.sha256(address.encode("utf-8")).hexdigest()[:16]


def comparator_seed(method: str, source_key: str) -> int | None:
    if method not in METHODS:
        raise ValueError("unknown F07 comparator")
    if len(source_key) != 16 or any(c not in "0123456789abcdef" for c in source_key):
        raise ValueError("canonical stream key required")
    if method == "EFDT":
        return None
    address = f"DT-P9-v1|DEV|COMPARATOR|{method}|stream={source_key}"
    return int(hashlib.sha256(address.encode("utf-8")).hexdigest()[:8], 16)


def canonical_seed_tsv() -> bytes:
    lines = [HEADER]
    for scenario in SCENARIOS:
        for realisation in range(3):
            sk = stream_key(scenario, realisation)
            for method in METHODS:
                address = f"DT-P9-v1|DEV|COMPARATOR|{method}|stream={sk}"
                digest = hashlib.sha256(address.encode("utf-8")).hexdigest()
                seed = comparator_seed(method, sk)
                if seed is None:
                    fields = (scenario, str(realisation), sk, method, "false", "", "", digest)
                else:
                    fields = (scenario, str(realisation), sk, method, "true", f"{seed:08x}", str(seed), digest)
                lines.append("\t".join(fields) + "\n")
    return "".join(lines).encode("utf-8")


def validate(design_path: Path, freeze_path: Path) -> dict:
    design = json.loads(Path(design_path).read_text())
    freeze = json.loads(Path(freeze_path).read_text())
    if design["phase"] != "F07_DEV_DESIGN" or design["status"] != "DESIGN_FROZEN_NO_DEV_RESULTS":
        raise ValueError("F07 design state differs")
    if design["confirmation_authorised"] is not False or design["scientific_admission"] is not False:
        raise ValueError("F07 cannot authorise CONF or scientific results")
    if design["source_binding"]["scenario_count"] != 14 or design["source_binding"]["realisations_per_scenario"] != 3:
        raise ValueError("DEV source matrix differs from Phase 9")
    rolling = design["rolling_cart"]
    if rolling["window_rows"] != 2000 or rolling["refit_every_revealed_labels"] != 100:
        raise ValueError("ROLLING_CART prospective freeze differs")
    if rolling["hyperparameter_search"] is not False or rolling["sensitivity_grid_in_primary"] is not False:
        raise ValueError("primary CART tuning is prohibited")
    if tuple(design["f08_pilot"]["scenario_ids"]) != PILOT or design["f08_pilot"]["realisation"] != 0:
        raise ValueError("pilot subset differs")
    fp = design["failure_policy"]
    if fp["silent_retry"] is not False or fp["fallback_model"] is not False or fp["exclude_failed_cell_from_mean"] is not False:
        raise ValueError("fail-closed policy weakened")
    if "loss=1" not in fp["algorithm_failure_after_valid_start"]:
        raise ValueError("post-failure operational loss rule missing")
    if design["python_runtime"]["python"] != "3.12.13" or design["python_runtime"]["river"] != "0.26.1" or design["python_runtime"]["scikit_learn"] != "1.9.0":
        raise ValueError("Python comparator runtime differs")
    if design["process_and_threads"]["parallel_scored_cells"] != 1:
        raise ValueError("scored comparator cells must be serial")
    if freeze["phase9_stream_schedule_sha256"] != "3e38cc71403537dd4112e2cf683ef5715f8073f6":
        raise ValueError("Phase 9 seed-schedule anchor differs")
    data = canonical_seed_tsv()
    digest = hashlib.sha256(data).hexdigest()
    if digest != freeze["canonical_tsv_sha256"]:
        raise ValueError("canonical comparator schedule digest differs")
    if freeze["rows"] != 294 or freeze["seeded_rows"] != 252 or freeze["source_streams"] != 42:
        raise ValueError("comparator schedule cardinality differs")
    values = []
    for scenario in SCENARIOS:
        for r in range(3):
            sk = stream_key(scenario, r)
            for method in SEEDED:
                values.append(comparator_seed(method, sk))
    if len(values) != len(set(values)):
        raise ValueError("comparator seed collision")
    return {"status": "PASS", "scenario_realisations": 42, "seed_rows": 294,
            "seeded_rows": 252, "canonical_tsv_sha256": digest,
            "pilot_scenario_realisations": len(PILOT), "confirmation_authorised": False}


if __name__ == "__main__":
    here = Path(__file__).resolve()
    repo = here.parents[3]
    result = validate(repo / "working/f07/DEV_DESIGN.json", repo / "working/f07/COMPARATOR_SEED_FREEZE.json")
    print(json.dumps(result, sort_keys=True))
