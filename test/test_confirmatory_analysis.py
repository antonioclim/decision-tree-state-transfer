"""Analytical fixtures; these do not use confirmatory stream values."""
import importlib.util
import math
from pathlib import Path
import unittest
import numpy as np

SPEC = importlib.util.spec_from_file_location("dt_analysis", Path(__file__).parents[1] / "assets/code/confirmatory/analysis.py")
a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)

class AnalysisTests(unittest.TestCase):
    def test_holm_reference(self):
        adjusted, reject = a.holm([0.04, 0.001, 0.02])
        np.testing.assert_allclose(adjusted, [0.04, 0.003, 0.04]); self.assertTrue(reject.all())
        np.testing.assert_allclose(a.holm([0.01, 0.03, 0.04])[0], [0.03, 0.06, 0.06])

    def test_holm_invalid(self):
        for bad in ([1], [0, 0, float('nan')], [-1, 0, 1], [2, 0, 0]):
            with self.assertRaises(ValueError): a.holm(bad)

    def test_hand_mean_variance_degrees(self):
        base = np.array([[0., .2], [-.2, .4]])
        x = np.repeat(base[..., None], 3, axis=2)
        r = a.infer_array(x)
        np.testing.assert_allclose(r['estimate'], [.1]*3)
        np.testing.assert_allclose(r['variance'], [.025]*3)
        expected_df = .025**2 / (.0025**2 + .0225**2)
        np.testing.assert_allclose(r['df'], [expected_df]*3)
        np.testing.assert_allclose(r['scenario_estimate'], [[.1]*3, [.1]*3])

    def test_sign_symmetry_and_equal_scenario_weight(self):
        x = np.arange(14*20*3).reshape(14,20,3)/2000 - .2
        r, opposite = a.infer_array(x), a.infer_array(-x)
        np.testing.assert_allclose(r['p'], opposite['p'])
        np.testing.assert_allclose(r['lower'], -opposite['upper'])
        np.testing.assert_allclose(r['estimate'], x.mean(axis=(0,1)))

    def test_zero_variance_is_not_infinite_significance(self):
        for c in (0, .01, -.01):
            r = a.infer_array(np.full((14,20,3), c))
            np.testing.assert_equal(r['p'], 1); np.testing.assert_equal(r['zero_variance'], True)
            np.testing.assert_allclose(r['upper'], c + math.sqrt(2*math.log(120)/280))
            self.assertTrue(np.isfinite(r['lower']).all())

    def test_all_constant_nonzero_uses_conservative_fallback(self):
        r = a.infer_array(np.full((14,20,3), .125))
        np.testing.assert_equal(r['p'], 1); self.assertFalse(r['holm_reject'].any())

    def test_bad_array_rejected(self):
        for x in (np.zeros((1,3)), np.full((2,3,3), np.nan), np.full((2,3,3), 1.01), np.zeros((2,1,3))):
            with self.assertRaises(ValueError): a.infer_array(x)

    def test_interval_decisions(self):
        self.assertEqual(a.decision(.006,.01), 'PRACTICALLY_BENEFICIAL')
        self.assertEqual(a.decision(-.01,-.006), 'PRACTICALLY_HARMFUL')
        self.assertEqual(a.decision(-.005,.005), 'PRACTICALLY_EQUIVALENT')
        self.assertEqual(a.decision(.005,.01), 'INCONCLUSIVE')
        self.assertEqual(a.decision(-.01,.01), 'INCONCLUSIVE')
        with self.assertRaises(ValueError): a.decision(1,0)

    def records(self):
        return [dict(partition='FIXTURE', scenario=g, realisation=r, optimiser=k, checkpoint=c, arm=arm,
                     predictions=2000, status='COMPLETE', loss=loss)
                for g in ['g1','g2'] for r in range(2) for k in range(3) for c in [10000,20000]
                for arm,loss in [('PERSIST',.1),('RESTART',.2),('CHAMPION',.15),('SUBTREE_REFIT',.25),('STRUCTURAL_SHAM',.2)]]

    def test_nested_aggregation(self):
        x = a.aggregate_records(self.records(), ['g1','g2'], n_streams=2)
        self.assertEqual(x.shape,(2,2,3)); np.testing.assert_allclose(x,np.broadcast_to([.1,.05,.05],x.shape))

    def test_missing_duplicate_infrastructure_corruption_rejected(self):
        variants = []
        r = self.records(); variants.append(r[:-1]); variants.append(r+[r[0]])
        for field,value in [('status','INVALIDATED'),('predictions',1999),('loss',np.nan),('partition','CONF'),('optimiser',4)]:
            r = self.records(); r[0][field] = value; variants.append(r)
        for r in variants:
            with self.assertRaises(ValueError): a.aggregate_records(r,['g1','g2'],n_streams=2)
        with self.assertRaises(ValueError): a.aggregate_records(self.records(),['g1','g2'],partition='CONF')

    def test_parent_unavailable_keeps_zero_contrasts(self):
        r = self.records()
        for e in r:
            if e['scenario']=='g1' and e['realisation']==0: e.update(status='PARENT_UNAVAILABLE',loss=1)
        x = a.aggregate_records(r,['g1','g2'],n_streams=2); np.testing.assert_equal(x[0,0],0)
        r[0]['loss']=.5
        with self.assertRaises(ValueError): a.aggregate_records(r,['g1','g2'],n_streams=2)

    def test_bootstrap_preserves_paired_clusters_and_replays(self):
        base=np.array([[0.,.1,.2,.3],[.1,.2,.3,.4]])
        x=np.stack([base,base, -base],axis=-1)
        r=a.cluster_bootstrap(x,resamples=1000); self.assertEqual(r,a.cluster_bootstrap(x,resamples=1000))
        intervals=np.array(r['interval']); np.testing.assert_allclose(intervals[:,0],intervals[:,1])
        np.testing.assert_allclose(intervals[:,0],-intervals[::-1,2])
        self.assertNotEqual(r['draws_sha256'],a.cluster_bootstrap(x,resamples=1000,seed_namespace='FIXTURE-OTHER')['draws_sha256'])

if __name__=='__main__': unittest.main()
