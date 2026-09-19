from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
F08 = ROOT / "working" / "f08"
sys.path.insert(0, str(F08))

import f08_schedule

WORKER = F08 / "f08_cell_worker.py"
spec = importlib.util.spec_from_file_location("f08_cell_worker_test", WORKER)
worker = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(worker)


class F08DevPilotTests(unittest.TestCase):
    def test_frozen_schedule_has_exact_48_unique_cells_and_digest(self):
        contract = f08_schedule.load_spec()
        rows, text = f08_schedule.validate_schedule(contract)
        self.assertEqual(len(rows), 48)
        self.assertEqual(len({(r["scenario_id"], r["method"]) for r in rows}), 48)
        self.assertEqual(hashlib.sha256(text.encode("utf-8")).hexdigest(),
                         "46e4681b2312061290311b575557cc492057e18cd553229c24316d62371c3c96")
        self.assertEqual(rows[0]["scenario_id"], "OBLIQUE-ABRUPT-SEVERE")
        self.assertEqual(rows[0]["method"], "ROLLING_CART")
        self.assertEqual(rows[0]["seed_uint32"], 3153878847)

    def test_contract_is_dev_only_and_does_not_authorise_confirmation(self):
        contract = json.loads((F08 / "F08_EXECUTION_SPEC.json").read_text(encoding="utf-8"))
        self.assertEqual(contract["partition"], "DEV")
        self.assertFalse(contract["scientific_admission"])
        self.assertFalse(contract["confirmation_authorised"])
        self.assertFalse(contract["manuscript_update_authorised"])
        self.assertEqual(contract["pilot"]["expected_streams"], 8)
        self.assertEqual(contract["pilot"]["expected_cells"], 48)
        self.assertNotIn("PLASTIC", contract["pilot"]["methods"])

    def test_two_tape_source_refuses_label_before_matching_features(self):
        feature_text = (
            "index\tx0\tx1\tx2\tx3\tx4\tx5\tx6\tx7\n"
            "1\t0\t1\t2\t3\t4\t5\t6\t7\n"
            "2\t1\t2\t3\t4\t5\t6\t7\t8\n"
            "3\t2\t3\t4\t5\t6\t7\t8\t9\n"
        )
        label_text = "index\ty\n1\t0\n2\t1\n3\t0\n"
        with tempfile.TemporaryDirectory() as td:
            feature_path = Path(td) / "x.tsv"
            label_path = Path(td) / "y.tsv"
            feature_path.write_text(feature_text, encoding="utf-8")
            label_path.write_text(label_text, encoding="utf-8")
            source = worker.StrictTapeSource(feature_path, label_path, 3)
            with self.assertRaises(worker.SourceIntegrityInvalid):
                source.label(1)
            for expected_y in (0, 1, 0):
                index, x = source.features()
                self.assertEqual(len(x), 8)
                self.assertEqual(source.label(index), expected_y)
            source.finish()

    def test_source_rejects_unconsumed_label_and_trailing_rows(self):
        with tempfile.TemporaryDirectory() as td:
            feature_path = Path(td) / "x.tsv"
            label_path = Path(td) / "y.tsv"
            feature_path.write_text(
                "index\tx0\tx1\tx2\tx3\tx4\tx5\tx6\tx7\n1\t0\t0\t0\t0\t0\t0\t0\t0\n2\t0\t0\t0\t0\t0\t0\t0\t0\n",
                encoding="utf-8")
            label_path.write_text("index\ty\n1\t0\n2\t1\n", encoding="utf-8")
            source = worker.StrictTapeSource(feature_path, label_path, 1)
            source.features()
            with self.assertRaises(worker.SourceIntegrityInvalid):
                source.finish()
            source.close()

    def test_failure_scoring_preserves_full_denominator(self):
        loss_sum, mean = worker.penalised_failure(predictions=5, errors=2, total=10)
        self.assertEqual(loss_sum, 7)
        self.assertEqual(mean, 0.7)
        with self.assertRaises(RuntimeError):
            worker.penalised_failure(predictions=5, errors=6, total=10)

    def test_progress_mapping_retains_predictions_errors_and_labels(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "progress.bin"
            path.write_bytes(b"\x00" * worker.Progress.BYTES)
            progress = worker.Progress(path)
            progress.update(11, 3, 2011)
            progress.close()
            self.assertEqual(struct.unpack("<QQQ", path.read_bytes()), (11, 3, 2011))


if __name__ == "__main__":
    unittest.main()
