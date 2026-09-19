"""Software boundary tests; real distribution and algorithm probes are separate."""
import importlib.util
import json
from pathlib import Path
import random
import stat
import tempfile
import unittest
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[1] / 'assets/code/confirmatory'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker = load('r06_worker_software_test', 'r06_locked_worker.py')
adapter = load('r06_adapter_software_test', 'r06_river_adapter.py')


class RowBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.x = {f'x{i}': (i - 4) / 8 for i in range(8)}

    def row(self, stage='learn', index=1, sequence=1):
        return {'seq': sequence, 'stage': stage, 'index': index, 'x': self.x.copy(),
                'y': None if stage == 'predict' else 0}

    def test_prefix_learn_requires_no_prediction(self):
        worker.row_request(self.row(), 1, 0, None)

    def test_production_prefix_prediction_is_refused(self):
        with self.assertRaises(ValueError):
            worker.row_request(self.row('predict'), 1, 0, None)

    def test_capability_predict_and_learn_pair(self):
        prediction = self.row('predict')
        worker.row_request(prediction, 1, 0, None, prefix_rows=0, end=1)
        worker.row_request(self.row(sequence=2), 2, 0, worker.canonical(self.x), prefix_rows=0, end=1)

    def test_capability_cannot_grow_into_an_unplanned_stream(self):
        with self.assertRaises(ValueError):
            worker.row_request(self.row('predict', index=2, sequence=3), 3, 1, None, prefix_rows=0, end=1)

    def test_scored_learning_without_prediction_is_refused(self):
        with self.assertRaises(ValueError):
            worker.row_request(self.row(index=2001), 1, 2000, None)

    def test_scored_learning_accepts_same_features(self):
        worker.row_request(self.row(index=2001), 1, 2000, worker.canonical(self.x))

    def test_scored_learning_rejects_changed_features(self):
        row = self.row(index=2001)
        row['x']['x2'] += 0.5
        with self.assertRaises(ValueError):
            worker.row_request(row, 1, 2000, worker.canonical(self.x))

    def test_second_prediction_for_same_row_is_refused(self):
        with self.assertRaises(ValueError):
            worker.row_request(self.row('predict', index=2001), 1, 2000, worker.canonical(self.x))

    def test_label_in_prediction_is_refused(self):
        row = self.row('predict', index=2001)
        row['y'] = 0
        with self.assertRaises(ValueError):
            worker.row_request(row, 1, 2000, None)

    def test_boolean_index_sequence_label_and_feature_are_refused(self):
        for field in ('seq', 'index', 'y', 'x'):
            with self.subTest(field=field), self.assertRaises(ValueError):
                row = self.row()
                if field == 'x':
                    row['x']['x0'] = True
                else:
                    row[field] = True
                worker.row_request(row, 1, 0, None)

    def test_nonfinite_feature_is_refused(self):
        for value in (float('nan'), float('inf'), -float('inf')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                row = self.row()
                row['x']['x0'] = value
                worker.row_request(row, 1, 0, None)

    def test_row_outside_frozen_end_is_refused(self):
        with self.assertRaises(ValueError):
            worker.row_request(self.row('predict', index=2501), 1, 2500, None)

    def test_duplicate_json_fields_are_refused(self):
        with self.assertRaises(ValueError):
            worker.decode(b'{"seed":1,"seed":2}')

    def test_nonfinite_json_tokens_are_refused(self):
        for value in ('NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.decode(('{"x":' + value + '}').encode())


class SnapshotTests(unittest.TestCase):
    def test_nonstring_metric_labels_keep_types(self):
        value = adapter.snapshot({0: {None: 1.0}, 1: {False: 0.0}})
        self.assertEqual(value, {'mapping_items': [[0, {'mapping_items': [[None, 1.0]]}],
                                                  [1, {'mapping_items': [[False, 0.0]]}]]})

    def test_random_state_identity_is_read_only(self):
        random_a, random_b = random.Random(7), random.Random(7)
        observed = adapter.snapshot(random_a)
        self.assertEqual(observed, adapter.snapshot(random_b))
        self.assertEqual(random_a.random(), random_b.random())
        self.assertNotEqual(observed, adapter.snapshot(random_a))

    def test_snapshot_rejects_cycles(self):
        value = []
        value.append(value)
        with self.assertRaises(ValueError):
            adapter.snapshot(value)

    def test_seed_type_validation_precedes_import(self):
        for seed in (True, -1, 2**64, '7', 7.0):
            with self.subTest(seed=seed), self.assertRaises(ValueError):
                adapter.build_model('HAT', seed, {})

    def test_unknown_profile_validation_precedes_import(self):
        with self.assertRaises(ValueError):
            adapter.build_model('RENAMED_FIXTURE', 0, {})

    def test_lazy_audit_rejects_a_later_unbound_row(self):
        with self.assertRaises(ValueError):
            adapter.lazy_members(None, 'HAT', {'stage': 'learn', 'index': 2})


class ExplicitDirectoryTests(unittest.TestCase):
    """Constructed wheels test ZIP semantics only; they are never River evidence."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.helpers = load('r06_directory_fixture_helpers', ROOT.parents[2] / 'test/test_distribution_set.py')
        self.descriptor = self.helpers.wheel(self.root)
        self.path = self.root / self.descriptor['file']

    def add_directory(self, name='alpha/', data=b'', *, mode=stat.S_IFDIR | 0o755):
        item = zipfile.ZipInfo(name)
        item.external_attr = (mode << 16) | 0x10
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(self.path, 'a') as archive:
                archive.writestr(item, data)
        self.descriptor = self.helpers.descriptor(self.path)

    def inspect(self, enabled=True):
        return self.helpers.d.inspect_distribution(self.path, self.descriptor, allow_directory_entries=enabled)

    def test_explicit_zero_byte_directory_has_no_record_row(self):
        self.add_directory()
        result = self.inspect()
        self.assertEqual(result['verified_directory_entries'], 1)
        self.assertEqual(result['verified_payload_files'], 4)

    def test_legacy_profile_keeps_directory_rejection(self):
        self.add_directory()
        with self.assertRaises(ValueError):
            self.inspect(False)

    def test_nonzero_directory_is_refused(self):
        self.add_directory(data=b'not a directory payload')
        with self.assertRaises(ValueError):
            self.inspect()

    def test_directory_with_regular_file_mode_is_refused(self):
        self.add_directory(mode=stat.S_IFREG | 0o644)
        with self.assertRaises(ValueError):
            self.inspect()

    def test_duplicate_directory_is_refused(self):
        self.add_directory()
        self.add_directory()
        with self.assertRaises(ValueError):
            self.inspect()

    def test_escaping_directory_is_refused(self):
        self.add_directory('../escape/')
        with self.assertRaises(ValueError):
            self.inspect()

    def test_file_directory_collision_is_refused(self):
        self.add_directory('alpha/__init__.py/')
        with self.assertRaises(ValueError):
            self.inspect()

    def test_declared_empty_directory_survives_manifest_and_site_check(self):
        self.add_directory('alpha/empty/')
        self.inspect()
        staging = load('r06_directory_staging_test', 'locked_runtime.py')
        lock = {'scope': self.helpers.d.R06_SCOPE, 'artifacts': [self.descriptor]}
        mapping = staging.expected_site(self.root, lock)
        self.assertEqual(mapping['alpha/empty']['kind'], 'directory')
        site = self.root / 'site'
        site.mkdir()
        with zipfile.ZipFile(self.path) as archive:
            for item in archive.infolist():
                destination = site / item.filename
                if item.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(archive.read(item))
        self.assertEqual(staging.verify_site(site, mapping)['files'], 4)
        (site / 'alpha/empty').rmdir()
        with self.assertRaises(ValueError):
            staging.verify_site(site, mapping)


if __name__ == '__main__':
    unittest.main()
