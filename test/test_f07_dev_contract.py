from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest

REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "assets/code/confirmatory/f07_dev_contract.py"
spec = importlib.util.spec_from_file_location("f07_dev_contract", MODULE_PATH)
f07 = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(f07)


class F07DesignTests(unittest.TestCase):
    def test_phase9_stream_identity_is_preserved(self):
        self.assertEqual(f07.stream_key("LOCAL_TREE-STATIONARY-NONE", 0), "9463861a45169367")
        self.assertEqual(f07.stream_key("OBLIQUE-RECURRENT-SEVERE", 2), "7c3ee68794483ee8")

    def test_seed_namespaces_are_method_specific_and_32_bit(self):
        sk = f07.stream_key("LOCAL_TREE-ABRUPT-SEVERE", 0)
        values = [f07.comparator_seed(m, sk) for m in ("HAT","ARF","SRP","FROZEN_CART","ROLLING_CART","PLASTIC")]
        self.assertEqual(len(values), len(set(values)))
        self.assertTrue(all(type(v) is int and 0 <= v < 2**32 for v in values))
        self.assertIsNone(f07.comparator_seed("EFDT", sk))

    def test_complete_seed_freeze_and_digest(self):
        result = f07.validate(REPO / "working/f07/DEV_DESIGN.json", REPO / "working/f07/COMPARATOR_SEED_FREEZE.json")
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["seed_rows"], 294)
        self.assertEqual(result["seeded_rows"], 252)
        self.assertEqual(result["canonical_tsv_sha256"], "0f67dc8d8b711773405128b8c4ecc4cb5a3adb7fa5c112bacb90235bc29bb1db")

    def test_rolling_cart_not_tuned(self):
        d = json.loads((REPO / "working/f07/DEV_DESIGN.json").read_text())
        self.assertEqual(d["rolling_cart"]["window_rows"], 2000)
        self.assertEqual(d["rolling_cart"]["refit_every_revealed_labels"], 100)
        self.assertFalse(d["rolling_cart"]["hyperparameter_search"])
        self.assertFalse(d["rolling_cart"]["sensitivity_grid_in_primary"])

    def test_failure_policy_is_operational_and_fail_closed(self):
        d = json.loads((REPO / "working/f07/DEV_DESIGN.json").read_text())
        f = d["failure_policy"]
        self.assertIn("loss=1", f["algorithm_failure_after_valid_start"])
        self.assertFalse(f["silent_retry"])
        self.assertFalse(f["fallback_model"])
        self.assertFalse(f["exclude_failed_cell_from_mean"])

    def test_pilot_is_outcome_independent_and_covers_both_families(self):
        d = json.loads((REPO / "working/f07/DEV_DESIGN.json").read_text())
        p = d["f08_pilot"]
        self.assertEqual(p["realisation"], 0)
        self.assertEqual(len(p["scenario_ids"]), 8)
        self.assertTrue(any(x.startswith("LOCAL_TREE-") for x in p["scenario_ids"]))
        self.assertTrue(any(x.startswith("OBLIQUE-") for x in p["scenario_ids"]))
        self.assertIn("no model or comparator tuning", p["outcome_use"])


if __name__ == "__main__":
    unittest.main()
