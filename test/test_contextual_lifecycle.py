"""Failure-state and integrity fixtures. No dummy model is labelled as River."""
import copy
import gzip
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
cl = load('lifecycle_under_test', ROOT/'assets/code/confirmatory/contextual_lifecycle.py')
fixture = load('source_fixture_helper', ROOT/'test/test_river_prequential.py')


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.helper = fixture.SequentialTests(); self.helper.setUp()
        self.addCleanup(self.helper.doCleanups)
        self.root = self.helper.root
        self.source_dir = self.helper.directory
        self.plan = dict(schema_version=1, partition='DEV', scope=cl.REFERENCE, method='LAST_LABEL',
                         seed=0, end=2004, protocol_sha256='a'*64, fault=None, failure_policy=cl.POLICY)
        self.out = self.root/'attempt'

    def run_case(self, stage=None, index=None, method='LAST_LABEL'):
        self.plan['method'] = method
        self.plan['fault'] = None if stage is None else dict(stage=stage, index=index, reason='RESOURCE_LIMIT')
        result = cl.record_run(self.source_dir, self.helper.anchor, self.plan, self.out)
        self.anchor = cl.sha((self.out/'RESULT.json').read_bytes())
        return result

    def verify(self):
        return cl.verify_run(self.source_dir, self.helper.anchor, self.plan, self.out, self.anchor)

    def events(self):
        return [json.loads(x) for x in gzip.decompress((self.out/'events.jsonl.gz').read_bytes()).splitlines()]

    def alter(self, mutate=None, change_result=None):
        result = json.loads((self.out/'RESULT.json').read_bytes())
        if mutate is not None:
            records = self.events(); mutate(records)
            raw = b''.join(cl.canonical(x) for x in records); zipped = gzip.compress(raw, mtime=0)
            (self.out/'events.jsonl.gz').write_bytes(zipped)
            result.update(event_rows=len(records), raw_bytes=len(raw), raw_sha256=cl.sha(raw),
                          gzip_bytes=len(zipped), gzip_sha256=cl.sha(zipped))
        if change_result is not None: change_result(result)
        (self.out/'RESULT.json').write_bytes(cl.canonical(result))
        self.anchor = cl.sha((self.out/'RESULT.json').read_bytes())

    def test_success_has_full_denominator(self):
        r=self.run_case(); v=self.verify()
        self.assertEqual(r['completion']['counts']['prediction_slots'],4)
        self.assertEqual(r['completion']['counts']['learn_calls_completed'],2004)
        self.assertEqual(r['completion']['counts']['failure_imputed_slots'],0)
        self.assertEqual(v['completion']['status'],'COMPLETE');self.assertFalse(v['real_River_evaluation'])

    def test_majority_reference_native_replay(self):
        self.run_case(method='PREFIX_MAJORITY');self.assertEqual(self.verify()['completion']['counts']['prediction_slots'],4)

    def test_prefix_failure_retains_all_predictions(self):
        r=self.run_case('learn',1000);self.verify();c=r['completion']['counts']
        self.assertEqual(c['failure_imputed_slots'],4);self.assertEqual(c['prediction_calls_attempted'],0)
        self.assertEqual(c['learn_calls_attempted'],1000);self.assertEqual(c['learn_calls_completed'],999)

    def test_predict_failure_retains_current_and_future_slots(self):
        r=self.run_case('predict',2001);self.verify();c=r['completion']['counts']
        self.assertEqual(c['failure_imputed_slots'],4);self.assertEqual(c['learn_calls_attempted'],2000)
        self.assertEqual(c['prediction_calls_attempted'],1)

    def test_learning_failure_preserves_observed_loss_but_imputes_current(self):
        self.helper.rewrite(1,lambda rows:[x.update(label=0) for x in rows])
        self.run_case('learn',2001);self.verify()
        first=next(x for x in self.events() if x['kind']=='score')
        self.assertEqual(first,dict(kind='score',index=2001,observed_loss=0,effective_loss=1,failure_imputed=True))

    def test_last_learning_failure_changes_one_slot_only(self):
        r=self.run_case('learn',2004);self.verify()
        self.assertEqual(r['completion']['counts']['failure_imputed_slots'],1)
        self.assertEqual(r['completion']['counts']['learn_calls_completed'],2003)

    def test_middle_failure_has_exact_suffix(self):
        r=self.run_case('predict',2003);self.verify()
        self.assertEqual(r['completion']['counts']['failure_imputed_slots'],2)

    def test_numerical_declared_failure_is_typed_and_retained(self):
        self.plan['fault']=dict(stage='learn',index=1000,reason='NUMERICAL_FAILURE')
        r=cl.record_run(self.source_dir,self.helper.anchor,self.plan,self.out)
        self.assertEqual(r['completion']['first_failure']['reason'],'NUMERICAL_FAILURE')

    def internal(self,model,constructor=None):
        source=cl.bridge.SeparatedSource(self.source_dir,self.helper.anchor)
        return cl._record(source,model,{'fixture':True} if constructor is None else constructor,self.plan,self.out)

    def test_no_calls_after_declared_terminal_failure(self):
        class Broken:
            def __init__(s):s.calls=0
            def learn_one(s,x,y):
                s.calls+=1
                if s.calls>10:raise AssertionError('model accessed after terminal failure')
                if s.calls==10:raise cl.DeclaredModelFailure('RESOURCE_LIMIT')
            def predict_one(s,x):raise AssertionError('predict after terminal failure')
        model=Broken();r=self.internal(model)
        self.assertEqual(model.calls,10);self.assertEqual(r['completion']['counts']['failure_imputed_slots'],4)

    def test_unexpected_exception_is_not_algorithmic_failure(self):
        class Bad(fixture.FixtureModel):
            def predict_one(self,x):raise RuntimeError('implementation defect')
        with self.assertRaises(RuntimeError):self.internal(Bad())
        self.assertTrue((self.out/'INTERRUPTED.json').exists());self.assertFalse((self.out/'RESULT.json').exists())

    def test_memory_error_is_not_silently_classified(self):
        class Bad(fixture.FixtureModel):
            def predict_one(self,x):raise MemoryError('no measured supervisor receipt')
        with self.assertRaises(MemoryError):self.internal(Bad())
        self.assertFalse((self.out/'RESULT.json').exists())

    def test_boolean_prediction_invalidates_attempt(self):
        class Bad(fixture.FixtureModel):
            def predict_one(self,x):return True
        with self.assertRaises(ValueError):self.internal(Bad())
        self.assertFalse((self.out/'RESULT.json').exists())

    def test_none_prediction_is_loss_one_without_terminal_failure(self):
        class Abstain(fixture.FixtureModel):
            def predict_one(self,x):return None
        r=self.internal(Abstain());c=r['completion']['counts']
        self.assertEqual(c['null_prediction_slots'],4);self.assertEqual(c['failure_imputed_slots'],0)
        self.assertEqual(r['status'],'COMPLETE')

    def test_source_eof_corruption_still_blocks_after_model_failure(self):
        self.helper.manifest['files'][1]['raw_sha256']='b'*64;self.helper.anchor=self.helper.save()
        with self.assertRaises(ValueError):self.run_case('learn',1000)
        self.assertFalse((self.out/'RESULT.json').exists())

    def test_source_error_does_not_become_model_failure(self):
        model=fixture.FixtureModel();s=cl.bridge.SeparatedSource(self.source_dir,self.helper.anchor)
        with patch.object(s,'label',side_effect=cl.DeclaredModelFailure('RESOURCE_LIMIT')):
            with self.assertRaises(cl.DeclaredModelFailure):cl._record(s,model,{},self.plan,self.out)
        self.assertFalse((self.out/'RESULT.json').exists())

    def test_label_is_not_revealed_before_prediction(self):
        s=cl.bridge.SeparatedSource(self.source_dir,self.helper.anchor)
        class Inspect(fixture.FixtureModel):
            def predict_one(inner,x):
                self.assertEqual(s.index,inner.learned);self.assertEqual(s.pending,inner.learned+1)
                return super().predict_one(x)
        cl._record(s,Inspect(),{},self.plan,self.out)

    def test_constructor_encoding_precedes_calls(self):
        model=fixture.FixtureModel()
        with self.assertRaises(ValueError):self.internal(model,{'nan':float('nan')})
        self.assertEqual(model.learned,0);self.assertFalse(self.out.exists())

    def test_event_write_failure_never_publishes_result(self):
        with patch.object(cl.gzip.GzipFile,'write',side_effect=OSError('injected storage fault')):
            with self.assertRaises(OSError):self.run_case()
        self.assertFalse((self.out/'RESULT.json').exists());self.assertTrue((self.out/'INTERRUPTED.json').exists())

    def test_short_write_never_publishes_result(self):
        with patch.object(cl.gzip.GzipFile,'write',return_value=0):
            with self.assertRaises(OSError):self.run_case()
        self.assertFalse((self.out/'RESULT.json').exists())

    def test_result_write_close_failure_never_publishes_complete_name(self):
        original=cl._write_new
        def fail(path,data):
            original(path,data)
            if path.name=='.RESULT.pending':raise OSError('simulated close failure after bytes')
        with patch.object(cl,'_write_new',side_effect=fail):
            with self.assertRaises(OSError):self.run_case()
        self.assertFalse((self.out/'RESULT.json').exists())
        self.assertTrue((self.out/'.RESULT.pending').exists())

    def test_interrupted_publication_not_admitted(self):
        original=Path.unlink
        def fail(path,*args,**kwargs):
            if path.name=='.RESULT.pending':raise OSError('simulated unlink failure')
            return original(path,*args,**kwargs)
        with patch.object(Path,'unlink',fail):
            with self.assertRaises(OSError):self.run_case()
        self.anchor=cl.sha((self.out/'RESULT.json').read_bytes())
        with self.assertRaises(ValueError):self.verify()

    def test_existing_output_is_not_overwritten(self):
        self.run_case();raw=(self.out/'RESULT.json').read_bytes()
        with self.assertRaises(FileExistsError):cl.record_run(self.source_dir,self.helper.anchor,self.plan,self.out)
        self.assertEqual((self.out/'RESULT.json').read_bytes(),raw)

    def test_rehashed_loss_tampering_rejected(self):
        self.run_case();self.alter(lambda r:next(x for x in r if x['kind']=='score').update(effective_loss=2))
        with self.assertRaises(ValueError):self.verify()

    def test_rehashed_label_tampering_rejected(self):
        self.run_case();self.alter(lambda r:next(x for x in r if x['kind']=='reveal').update(label=0))
        with self.assertRaises(ValueError):self.verify()

    def test_imputation_cannot_be_removed(self):
        self.run_case('learn',1000);self.alter(lambda r:next(x for x in r if x['kind']=='score').update(failure_imputed=False))
        with self.assertRaises(ValueError):self.verify()

    def test_success_after_terminal_failure_rejected(self):
        self.run_case('predict',2001);self.alter(lambda r:next(x for x in r if x['kind']=='update').update(outcome='COMPLETED'))
        with self.assertRaises(ValueError):self.verify()

    def test_failed_prediction_cannot_be_nonnull(self):
        self.run_case('predict',2001);self.alter(lambda r:next(x for x in r if x['kind']=='prediction').update(prediction=0))
        with self.assertRaises(ValueError):self.verify()

    def test_fault_reason_tampering_rejected(self):
        self.run_case('learn',1000);self.alter(lambda r:next(x for x in r if x['kind']=='model_failure').update(reason='NUMERICAL_FAILURE'))
        with self.assertRaises(ValueError):self.verify()

    def test_missing_event_rejected(self):
        self.run_case();self.alter(lambda r:r.pop(2001))
        with self.assertRaises(ValueError):self.verify()

    def test_duplicate_event_rejected(self):
        self.run_case();self.alter(lambda r:r.insert(2001,copy.deepcopy(r[2001])))
        with self.assertRaises(ValueError):self.verify()

    def test_surplus_event_rejected(self):
        self.run_case();self.alter(lambda r:r.append(dict(kind='extra')))
        with self.assertRaises(ValueError):self.verify()

    def test_completion_count_boolean_rejected(self):
        self.run_case();self.alter(change_result=lambda r:r['completion']['counts'].update(prediction_slots=True))
        with self.assertRaises(ValueError):self.verify()

    def test_raw_summary_lie_rejected(self):
        self.run_case();self.alter(change_result=lambda r:r.update(raw_sha256='0'*64))
        with self.assertRaises(ValueError):self.verify()

    def test_false_complete_status_rejected(self):
        self.run_case('learn',1000);self.alter(change_result=lambda r:r.update(status='COMPLETE'))
        with self.assertRaises(ValueError):self.verify()

    def test_premature_scientific_admission_rejected(self):
        self.run_case();self.alter(change_result=lambda r:r.update(scientific_admission=True))
        with self.assertRaises(ValueError):self.verify()

    def test_extra_attempt_member_rejected(self):
        self.run_case();(self.out/'unknown').write_text('x')
        with self.assertRaises(ValueError):self.verify()

    def test_symlink_result_rejected(self):
        self.run_case();p=self.out/'RESULT.json';p.rename(self.root/'outside');p.symlink_to(self.root/'outside')
        with self.assertRaises(ValueError):self.verify()

    def test_hardlink_result_rejected(self):
        self.run_case();os.link(self.out/'RESULT.json',self.root/'outside')
        with self.assertRaises(ValueError):self.verify()

    def test_external_anchor_rejected(self):
        self.run_case();self.anchor='b'*64
        with self.assertRaises(ValueError):self.verify()

    def test_constructor_substitution_rejected(self):
        self.run_case();(self.out/'CONSTRUCTOR.json').write_bytes(cl.canonical({'fake':'constructor'}))
        with self.assertRaises(ValueError):self.verify()

    def test_plan_substitution_rejected(self):
        self.run_case();p=copy.deepcopy(self.plan);p['seed']=1;(self.out/'PLAN.json').write_bytes(cl.canonical(p))
        with self.assertRaises(ValueError):self.verify()

    def test_negative_timing_rejected(self):
        self.run_case();self.alter(change_result=lambda r:r.update(elapsed_ns=-1))
        with self.assertRaises(ValueError):self.verify()

    def test_plausible_timing_change_is_not_authenticated(self):
        self.run_case();self.alter(change_result=lambda r:r.update(elapsed_ns=123456,process_cpu_ns=2345))
        self.assertFalse(self.verify()['timing_authenticated'])

    def test_truncated_gzip_not_admitted(self):
        self.run_case();p=self.out/'events.jsonl.gz';p.write_bytes(p.read_bytes()[:-4])
        self.alter(change_result=lambda r:r.update(gzip_bytes=p.stat().st_size,gzip_sha256=cl.sha(p.read_bytes())))
        with self.assertRaises((EOFError,ValueError)):self.verify()

    def test_duplicate_json_key_rejected(self):
        with self.assertRaises(ValueError):list(cl._archived_events(gzip.compress(b'{"x":1,"x":2}\n'),100,{}))

    def test_conf_plan_refused(self):
        self.plan['partition']='CONF'
        with self.assertRaises(ValueError):cl.validate_plan(self.plan)

    def test_river_method_cannot_be_fixture_label(self):
        self.plan['method']='HAT'
        with self.assertRaises(ValueError):cl.validate_plan(self.plan)

    def test_fault_in_actual_river_plan_refused(self):
        self.plan.update(scope=cl.RIVER,method='HAT',fault=dict(stage='learn',index=1000,reason='RESOURCE_LIMIT'))
        with self.assertRaises(ValueError):cl.validate_plan(self.plan)

    def test_missing_river_is_not_imputed_and_precedes_source_read(self):
        self.plan.update(scope=cl.RIVER,method='HAT')
        with patch('importlib.metadata.version',side_effect=importlib.metadata.PackageNotFoundError('river')):
            with patch.object(cl.bridge,'SeparatedSource',side_effect=AssertionError('source read')):
                with self.assertRaises(importlib.metadata.PackageNotFoundError):cl.record_run(self.source_dir,self.helper.anchor,self.plan,self.out)
        self.assertFalse(self.out.exists())

    def test_wrong_version_is_not_imputed(self):
        self.plan.update(scope=cl.RIVER,method='ARF')
        with patch('importlib.metadata.version',return_value='0.99.0'):
            with self.assertRaises(RuntimeError):cl.record_run(self.source_dir,self.helper.anchor,self.plan,self.out)
        self.assertFalse(self.out.exists())

    def test_strict_fault_and_plan_fields(self):
        for change in [dict(seed=True),dict(end=True),dict(scope='unknown'),dict(protocol_sha256=None),
                       dict(fault=dict(stage='predict',index=1000,reason='RESOURCE_LIMIT')),
                       dict(fault=dict(stage='learn',index=True,reason='RESOURCE_LIMIT')),
                       dict(fault=dict(stage='learn',index=2001,reason='IMPORT_ERROR'))]:
            with self.subTest(change=change),self.assertRaises(ValueError):cl.validate_plan({**self.plan,**change})

    def test_declared_failure_rejects_unknown_reason(self):
        with self.assertRaises(ValueError):cl.DeclaredModelFailure('ValueError')

    def test_protocol_anchor_required(self):
        self.plan['protocol_sha256']='b'*64
        with self.assertRaises(ValueError):self.run_case()
        self.assertFalse((self.out/'RESULT.json').exists())

    def test_end_must_match_source(self):
        self.plan['end']=2003
        with self.assertRaises(ValueError):self.run_case()
        self.assertFalse((self.out/'RESULT.json').exists())


if __name__=='__main__':unittest.main()
