import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('river_prequential', ROOT/'assets/code/confirmatory/river_prequential.py')
rp = importlib.util.module_from_spec(spec); spec.loader.exec_module(rp)


def sha(x): return hashlib.sha256(x).hexdigest()
def encoded(x): return (json.dumps(x, separators=(',', ':'))+'\n').encode()


class FixtureModel:
    """Explicit software test double, not an approximation labelled as River."""
    def __init__(self, observer=None): self.learned = 0; self.predicted = 0; self.observer = observer
    def learn_one(self, x, y):
        assert list(x) == [f'x{i}' for i in range(8)]
        self.learned += 1
    def predict_one(self, x):
        if self.observer: self.observer()
        self.predicted += 1
        return 0


class SequentialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root/'source'; self.directory.mkdir()
        self.end = 2004
        features = b''.join(encoded({'index':i, 'bits':[struct.pack('>d', -0.0 if j == 0 else i/10000).hex() for j in range(8)]}) for i in range(1,self.end+1))
        labels = b''.join(encoded({'index':i, 'label':i%2}) for i in range(1,self.end+1))
        self.manifest = {'schema_version':1,'format':'DEV_SEPARATE_BINARY64_TAPES_V1',
          'plan':{'schema_version':1,'partition':'DEV','scenario':'LOCAL_TREE-STATIONARY-NONE','realisation':0,'end':self.end,'protocol_sha256':'a'*64},
          'stream_key':sha(b'DT-P9-v1|DEV|LOCAL_TREE-STATIONARY-NONE|r=00')[:16],
          'feature_count':8,'prefix_rows':2000,'files':[],'scientific_admission':False,'confirmation_authorised':False}
        for name, raw in [('features.jsonl.gz',features),('labels.jsonl.gz',labels)]:
            zipped=gzip.compress(raw,mtime=0);(self.directory/name).write_bytes(zipped)
            self.manifest['files'].append({'file':name,'rows':self.end,'raw_bytes':len(raw),'raw_sha256':sha(raw),'gzip_bytes':len(zipped),'gzip_sha256':sha(zipped)})
        self.anchor=self.save()
    def save(self):
        raw=encoded(self.manifest);(self.directory/'SOURCE.json').write_bytes(raw);return sha(raw)
    def source(self): return rp.SeparatedSource(self.directory,self.anchor)
    def rewrite(self,tape, mutate):
        d=self.manifest['files'][tape];raw=gzip.decompress((self.directory/d['file']).read_bytes());rows=[json.loads(x) for x in raw.splitlines()]
        mutate(rows);raw=b''.join(encoded(x) for x in rows);zipped=gzip.compress(raw,mtime=0);(self.directory/d['file']).write_bytes(zipped)
        d.update(raw_bytes=len(raw),raw_sha256=sha(raw),gzip_bytes=len(zipped),gzip_sha256=sha(zipped));self.anchor=self.save()
    def consume(self, source):
        for i in range(1,self.end+1): source.features();source.label(i)
        source.finish()
    def test_full_order_and_complete_transport(self):
        s=self.source(); self.consume(s); self.assertEqual(s.index,self.end)
    def test_binary64_signed_zero_preserved(self):
        i,x=self.source().features();self.assertEqual(i,1);self.assertEqual(struct.pack('>d',x['x0']).hex(),'8000000000000000')
    def test_label_before_features_rejected(self):
        with self.assertRaises(ValueError): self.source().label(1)
    def test_repeated_features_rejected(self):
        s=self.source();s.features()
        with self.assertRaises(ValueError): s.features()
    def test_wrong_label_index_rejected(self):
        s=self.source();s.features()
        with self.assertRaises(ValueError):s.label(2)
    def test_premature_finish_rejected(self):
        with self.assertRaises(ValueError):self.source().finish()
    def test_extra_feature_read_rejected(self):
        s=self.source();self.consume(s)
        with self.assertRaises(ValueError):s.features()
    def test_external_hash_required(self):
        with self.assertRaises(ValueError):rp.SeparatedSource(self.directory,'b'*64)
    def test_conf_refused(self):
        self.manifest['plan']['partition']='CONF';self.anchor=self.save()
        with self.assertRaises(ValueError):self.source()
    def test_false_key_refused(self):
        self.manifest['stream_key']='0'*16;self.anchor=self.save()
        with self.assertRaises(ValueError):self.source()
    def test_extra_member_refused(self):
        (self.directory/'extra').write_text('x')
        with self.assertRaises(ValueError):self.source()
    def test_link_refused(self):
        p=self.directory/'features.jsonl.gz';p.rename(self.root/'outside');p.symlink_to(self.root/'outside')
        with self.assertRaises(ValueError):self.source()
    def test_compressed_corruption_refused(self):
        p=self.directory/'features.jsonl.gz';p.write_bytes(p.read_bytes()+b'x')
        with self.assertRaises(ValueError):self.source()
    def test_raw_digest_failure_not_admitted(self):
        self.manifest['files'][0]['raw_sha256']='b'*64;self.anchor=self.save()
        with self.assertRaises(ValueError):self.consume(self.source())
    def test_missing_row_not_admitted(self):
        self.rewrite(1,lambda rows:rows.pop())
        with self.assertRaises((ValueError,StopIteration)):self.consume(self.source())
    def test_extra_row_not_admitted(self):
        self.rewrite(1,lambda rows:rows.append({'index':self.end+1,'label':0}))
        with self.assertRaises(ValueError):self.consume(self.source())
    def test_boolean_label_refused(self):
        self.rewrite(1,lambda rows:rows[0].update(label=True))
        s=self.source();s.features()
        with self.assertRaises(ValueError):s.label(1)
    def test_nonfinite_bits_refused(self):
        self.rewrite(0,lambda rows:rows[0]['bits'].__setitem__(0,'7ff0000000000000'))
        with self.assertRaises(ValueError):self.source().features()
    def test_label_field_on_feature_tape_refused(self):
        self.rewrite(0,lambda rows:rows[0].update(label=1))
        with self.assertRaises(ValueError):self.source().features()
    def test_duplicate_keys_and_nan_refused(self):
        for raw in [b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":Infinity}']:
            with self.assertRaises(ValueError):rp._json(raw)
    def test_fixture_model_never_acquires_river_scope(self):
        s=self.source();model=FixtureModel(lambda:self.assertEqual(s.index,2000+model.predicted))
        result=rp.evaluate_test_double(s,model,self.root/'eval')
        self.assertEqual(result['scope'],'SOFTWARE_FIXTURE_TEST_DOUBLE_NOT_RIVER')
        self.assertEqual(model.learned,2004);self.assertEqual(model.predicted,4);self.assertEqual(result['event_rows'],8)
        self.assertFalse(result['scientific_admission'])
        events=[json.loads(x) for x in gzip.decompress((self.root/'eval/events.jsonl.gz').read_bytes()).splitlines()]
        self.assertNotIn('label',events[0]);self.assertEqual(events[1]['kind'],'reveal')
    def test_failure_never_becomes_complete_receipt(self):
        class Broken(FixtureModel):
            def predict_one(self,x):raise RuntimeError('injected fixture exception')
        with self.assertRaises(RuntimeError):rp.evaluate_test_double(self.source(),Broken(),self.root/'fail')
        self.assertTrue((self.root/'fail/INTERRUPTED.json').exists());self.assertFalse((self.root/'fail/RESULT.json').exists())
    def test_invalid_prediction_rejected(self):
        class Wrong(FixtureModel):
            def predict_one(self,x):return True
        with self.assertRaises(ValueError):rp.evaluate_test_double(self.source(),Wrong(),self.root/'wrong')
    def test_constructor_metadata_failure_precedes_learning_and_completion(self):
        model=FixtureModel()
        with self.assertRaises(ValueError):
            rp._evaluate(self.source(),model,self.root/'bad-config',
                         'SOFTWARE_FIXTURE_TEST_DOUBLE_NOT_RIVER',{'bad':float('nan')})
        self.assertEqual(model.learned,0)
        self.assertFalse((self.root/'bad-config/RESULT.json').exists())
        self.assertFalse((self.root/'bad-config/events.jsonl.gz').exists())
        self.assertTrue((self.root/'bad-config/INTERRUPTED.json').exists())
    def test_constructor_metadata_is_anchored_before_model_calls(self):
        out=self.root/'config-first'
        class Inspect(FixtureModel):
            def learn_one(inner,x,y):
                self.assertTrue((out/'CONSTRUCTOR.json').is_file())
                self.assertFalse((out/'RESULT.json').exists())
                super().learn_one(x,y)
        result=rp._evaluate(self.source(),Inspect(),out,
                           'SOFTWARE_FIXTURE_TEST_DOUBLE_NOT_RIVER',{'fixture':'not River'})
        self.assertEqual(result['constructor_sha256'],hashlib.sha256((out/'CONSTRUCTOR.json').read_bytes()).hexdigest())
    def test_existing_output_not_overwritten(self):
        dest=self.root/'existing';dest.mkdir();(dest/'keep').write_text('same')
        with self.assertRaises(FileExistsError):rp.evaluate_test_double(self.source(),FixtureModel(),dest)
        self.assertEqual((dest/'keep').read_text(),'same')
    def test_river_wrapper_cannot_accept_a_wrong_version(self):
        with patch('importlib.metadata.version',return_value='999.0'):
            with self.assertRaises(RuntimeError):rp.evaluate_river(self.directory,self.anchor,'HAT',0,self.root/'river')
        self.assertFalse((self.root/'river').exists())
    def test_river_method_and_seed_enforced(self):
        for method,seed in [('OTHER',0),('HAT',True),('SRP',-1),('ARF',2**64)]:
            with self.assertRaises(ValueError):rp.evaluate_river(self.directory,self.anchor,method,seed,self.root/'river')

if __name__=='__main__':unittest.main()
