"""Integration uses constructed loss fixtures, not decision-tree experiment results."""
import json
from pathlib import Path
import sys
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'assets/code/confirmatory'))
from bootstrap_analysis import NativeKernel, infer_bootstrap
from bootstrap_record_adapter import analyse_records
from analysis import aggregate_records

class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.kernel=NativeKernel()
    def records(self):
        records=[]
        for g in ['g1','g2']:
            for r in range(4):
                for k in range(3):
                    for cp in [10000,20000]:
                        for arm,loss in [('PERSIST',.10),('RESTART',.11+.01*r),('CHAMPION',.20-.01*r),('SUBTREE_REFIT',.18+.01*r),('STRUCTURAL_SHAM',.2)]:
                            records.append(dict(partition='FIXTURE',scenario=g,realisation=r,optimiser=k,checkpoint=cp,arm=arm,predictions=2000,status='COMPLETE',loss=loss))
        return records
    def run_adapter(self,records=None,**kwargs):
        return analyse_records(self.records() if records is None else records,['g1','g2'],namespace='ADAPTER-FIXTURE',case='fixed',kernel=self.kernel,n_streams=4,resamples=599,**kwargs)
    def test_direct_and_aggregated_inference_match(self):
        values=aggregate_records(self.records(),['g1','g2'],n_streams=4)
        direct=infer_bootstrap(values,namespace='ADAPTER-FIXTURE',case='fixed',kernel=self.kernel,resamples=599)
        result=self.run_adapter()
        for key in ['estimate','se','p','adjusted_p','lower','upper']:
            np.testing.assert_array_equal(result[key],direct[key])
    def test_nested_seeds_are_not_extra_independent_units(self):
        result=self.run_adapter();self.assertEqual(result['independent_streams'],8)
        self.assertEqual(result['nested_optimiser_count'],3)
    def test_every_unavailable_parent_cell_remains(self):
        records=self.records()
        for r in records:
            if r['scenario']=='g1' and r['realisation']==0:r.update(status='PARENT_UNAVAILABLE',loss=1)
        result=self.run_adapter(records);self.assertEqual(result['independent_streams'],8)
        values=aggregate_records(records,['g1','g2'],n_streams=4);np.testing.assert_array_equal(values[0,0],0)
    def test_json_result_is_finite_and_not_execution_admission(self):
        result=self.run_adapter();json.dumps(result,allow_nan=False)
        self.assertFalse(result['event_file_admission']);self.assertFalse(result['execution_lock_satisfied'])
    def test_missing_cell_rejected(self):
        with self.assertRaises(ValueError):self.run_adapter(self.records()[:-1])
    def test_duplicate_cell_rejected(self):
        records=self.records()
        with self.assertRaises(ValueError):self.run_adapter(records+[records[0]])
    def test_conf_rejected_before_aggregation(self):
        with self.assertRaises(ValueError):self.run_adapter(partition='CONF')
    def test_invalidated_run_not_converted_to_loss_one(self):
        records=self.records();records[0]['status']='INVALIDATED'
        with self.assertRaises(ValueError):self.run_adapter(records)
    def test_wrong_horizon_rejected(self):
        records=self.records();records[0]['predictions']=1999
        with self.assertRaises(ValueError):self.run_adapter(records)
    def test_boolean_dimensions_rejected(self):
        with self.assertRaises(ValueError):self.run_adapter(horizon=True)
    def test_duplicate_checkpoint_rejected(self):
        with self.assertRaises(ValueError):self.run_adapter(checkpoints=(10000,10000))
    def test_boolean_stream_key_rejected(self):
        records=self.records();records[0]['realisation']=False
        with self.assertRaises(ValueError):self.run_adapter(records)
    def test_boolean_loss_rejected(self):
        records=self.records();records[0]['loss']=True
        with self.assertRaises(ValueError):self.run_adapter(records)
    def test_full_planned_cluster_shape_without_confirmation_values(self):
        scenarios=[f'FIXTURE-{g}' for g in range(14)];records=[]
        values=np.empty((14,20,3))
        for g,scenario in enumerate(scenarios):
            for r in range(20):
                values[g,r]=[(r-10)/1024,(g-7)/1024,(r-g)/1024]
                losses=[.5,.5+values[g,r,0],.5+values[g,r,1],.5+values[g,r,2],.5]
                for optimiser in range(3):
                    for checkpoint in (10000,20000):
                        for arm,loss in zip(('PERSIST','RESTART','CHAMPION','SUBTREE_REFIT','STRUCTURAL_SHAM'),losses):
                            records.append(dict(partition='FIXTURE',scenario=scenario,realisation=r,optimiser=optimiser,
                                checkpoint=checkpoint,arm=arm,predictions=2000,status='COMPLETE',loss=float(loss)))
        result=analyse_records(records,scenarios,namespace='FULL-DESIGN-FIXTURE',case='1',kernel=self.kernel)
        self.assertEqual(len(records),8400);self.assertEqual(result['independent_streams'],280)
        direct=infer_bootstrap(values,namespace='FULL-DESIGN-FIXTURE',case='1',kernel=self.kernel)
        np.testing.assert_array_equal(result['estimate'],direct['estimate']);np.testing.assert_array_equal(result['p'],direct['p'])

    def test_constant_zero_is_inconclusive(self):
        records=self.records()
        for r in records:r['loss']=.1
        result=self.run_adapter(records);self.assertEqual(result['interval_decisions'],['INCONCLUSIVE']*3)

if __name__=='__main__':unittest.main()
