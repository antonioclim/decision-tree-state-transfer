"""Numerical, pairing and admission checks; no confirmatory learner inputs."""
from pathlib import Path
import hashlib
import math
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'assets/code/confirmatory'))
import bootstrap_analysis as a

class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.kernel=a.NativeKernel()
    def fixture(self): return np.random.default_rng(733).uniform(-.3,.3,(4,8,3))
    def pivots(self): return np.linspace(-3,3,599).reshape(-1,1)*np.ones((1,3))
    def test_preparation_matches_hand_variance(self):
        x=self.fixture();c,m,se=a.prepare(x)
        np.testing.assert_allclose(m,x.mean(axis=(0,1)),atol=1e-16)
        np.testing.assert_allclose(se,np.sqrt(x.var(axis=1,ddof=1).sum(axis=0)/(4**2*8)),atol=1e-16)
        np.testing.assert_allclose(c.sum(axis=1),0,atol=1e-15)
    def test_exact_constant_strata(self):
        x=np.broadcast_to(np.array([-.15,.05,.17,.01])[:,None,None],(4,8,3))
        c,m,se=a.prepare(x); self.assertTrue((se==0).all());self.assertTrue((c==0).all())
    def test_native_reference_dense(self):
        c,_,_=a.prepare(self.fixture())
        np.testing.assert_allclose(self.kernel.pivots(c,101,32),a.reference_pivots(c,101,32),rtol=1e-12,atol=1e-12)
    def test_native_reference_sparse(self):
        x=np.zeros((2,5,3));x[0,0]=[.2,-.2,.4]; c,_,_=a.prepare(x)
        p=self.kernel.pivots(c,500,17);r=a.reference_pivots(c,500,17)
        np.testing.assert_array_equal(np.isinf(p),np.isinf(r))
        np.testing.assert_allclose(p[np.isfinite(p)],r[np.isfinite(r)],atol=2e-14,rtol=2e-14)
    def test_native_reference_zero(self):
        c=np.zeros((2,5,3));np.testing.assert_array_equal(self.kernel.pivots(c,99,0),np.zeros((99,3)))
    def test_pairing_preserves_anticorrelation(self):
        x=self.fixture();x[:,:,1]=-x[:,:,0];x[:,:,2]=2*x[:,:,0]
        c,_,_=a.prepare(x);t=self.kernel.pivots(c,99,11)
        np.testing.assert_allclose(t[:,1],-t[:,0],atol=1e-14)
        np.testing.assert_allclose(t[:,2],t[:,0],atol=1e-14)
    def test_hypothesis_permutation(self):
        c,_,_=a.prepare(self.fixture());t=self.kernel.pivots(c,99,11)
        np.testing.assert_array_equal(self.kernel.pivots(c[:,:,[2,0,1]],99,11),t[:,[2,0,1]])
    def test_replay_exact(self):
        c,_,_=a.prepare(self.fixture());np.testing.assert_array_equal(self.kernel.pivots(c,999,44),self.kernel.pivots(c,999,44))
    def test_different_seed_changes_pivots(self):
        c,_,_=a.prepare(self.fixture());self.assertFalse(np.array_equal(self.kernel.pivots(c,99,44),self.kernel.pivots(c,99,45)))
    def test_seed_formula(self):
        expected=int.from_bytes(hashlib.sha256(b'DT-P10B-BOOTSTRAP-v1|TEST|case').digest()[:8],'big')
        self.assertEqual(a.addressed_seed('TEST','case'),expected)
    def test_empty_namespace(self):
        with self.assertRaises(ValueError):a.addressed_seed('','case')
    def test_bad_namespace(self):
        with self.assertRaises(ValueError):a.addressed_seed(1,'case')
    def test_empty_case(self):
        with self.assertRaises(ValueError):a.addressed_seed('TEST','')
    def test_wrong_shape(self):
        with self.assertRaises(ValueError):a.prepare(np.zeros((14,20)))
    def test_missing_hypothesis(self):
        with self.assertRaises(ValueError):a.prepare(np.zeros((14,20,2)))
    def test_single_stream(self):
        with self.assertRaises(ValueError):a.prepare(np.zeros((14,1,3)))
    def test_out_of_range(self):
        with self.assertRaises(ValueError):a.prepare(np.full((2,2,3),1.001))
    def test_nan(self):
        x=self.fixture();x[0,0,0]=np.nan
        with self.assertRaises(ValueError):a.prepare(x)
    def test_infinite(self):
        with self.assertRaises(ValueError):a.prepare(np.full((2,2,3),np.inf))
    def test_bad_kernel_shape(self):
        with self.assertRaises(ValueError):self.kernel.pivots(np.zeros((2,3)),99,1)
    def test_bad_resamples(self):
        with self.assertRaises(ValueError):self.kernel.pivots(np.zeros((2,3,3)),0,1)
    def test_boolean_resamples(self):
        with self.assertRaises(ValueError):self.kernel.pivots(np.zeros((2,3,3)),True,1)
    def test_invalid_seed(self):
        with self.assertRaises(ValueError):self.kernel.pivots(np.zeros((2,3,3)),99,-1)
    def test_seed_overflow(self):
        with self.assertRaises(ValueError):self.kernel.pivots(np.zeros((2,3,3)),99,2**64)
    def test_existing_binary_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            a.NativeKernel(Path(d))
            with self.assertRaises(FileExistsError):a.NativeKernel(Path(d))
    def test_nonzero_native_status_fails(self):
        with patch.object(self.kernel,'function',return_value=3):
            with self.assertRaises(ArithmeticError):self.kernel.pivots(np.zeros((2,3,3)),99,1)
    def test_absolute_tail_count_and_rank(self):
        t=np.arange(9999.)[:,None]*np.ones((1,3)); r=a.summarise(np.zeros(3),np.full(3,1e-6),t,280)
        self.assertEqual(r['one_based_tail_rank'],166)
        np.testing.assert_allclose(r['upper'],np.full(3,.009833))
        np.testing.assert_array_equal(r['p'],np.ones(3))
    def test_infinite_pivots_not_dropped(self):
        t=np.zeros((599,3));t[:20]=np.inf
        r=a.summarise(np.full(3,.9),np.full(3,.01),t,280)
        np.testing.assert_array_equal(r['lower'],[-1]*3);np.testing.assert_array_equal(r['upper'],[1]*3)
        self.assertFalse(r['holm_reject'].any());np.testing.assert_array_equal(r['infinite_pivots'],[20]*3)
    def test_original_zero_variance_fallback(self):
        r=a.summarise(np.zeros(3),np.zeros(3),np.zeros((599,3)),280)
        radius=math.sqrt(2*math.log(120)/280)
        np.testing.assert_allclose(r['upper'],[radius]*3);np.testing.assert_array_equal(r['p'],[1]*3)
        self.assertTrue(r['zero_variance_fallback'].all())
    def test_ci_test_duality_inclusive(self):
        t=self.pivots()
        for m in np.linspace(-.4,.4,51):
            r=a.summarise(np.full(3,m),np.full(3,.1),t,280)
            outside=(r['lower']>0)|(r['upper']<0)
            np.testing.assert_array_equal(outside,r['p']<=.05/3)
    def test_sign_reversal(self):
        m=np.array([.1,-.07,.005]);s=np.full(3,.01);t=self.pivots()
        r=a.summarise(m,s,t,280);q=a.summarise(-m,s,-t,280)
        np.testing.assert_array_equal(r['p'],q['p']);np.testing.assert_allclose(r['lower'],-q['upper'])
    def test_holm_manual(self):
        t=np.zeros((599,3));t[:10,1]=1.;t[:50,2]=1.
        r=a.summarise(np.full(3,.1),np.full(3,.1),t,280)
        np.testing.assert_allclose(r['p'],[1/600,11/600,51/600])
        np.testing.assert_allclose(r['adjusted_p'],[3/600,22/600,51/600])
    def test_nan_pivot_rejected(self):
        t=self.pivots();t[0,0]=np.nan
        with self.assertRaises(ValueError):a.summarise(np.zeros(3),np.ones(3),t,280)
    def test_negative_se_rejected(self):
        with self.assertRaises(ValueError):a.summarise(np.zeros(3),-np.ones(3),self.pivots(),280)
    def test_bad_count_rejected(self):
        with self.assertRaises(ValueError):a.summarise(np.zeros(3),np.ones(3),self.pivots(),1)
    def test_insufficient_resamples_rejected(self):
        with self.assertRaises(ValueError):a.summarise(np.zeros(3),np.ones(3),np.zeros((10,3)),280)
    def test_invalid_alpha_rejected(self):
        with self.assertRaises(ValueError):a.summarise(np.zeros(3),np.ones(3),self.pivots(),280,alpha=0)
    def test_invalid_null_rejected(self):
        with self.assertRaises(ValueError):a.summarise(np.zeros(3),np.ones(3),self.pivots(),280,null=np.inf)
    def test_confirmatory_admission_blocked(self):
        with self.assertRaises(ValueError):a.infer_bootstrap(self.fixture(),namespace='X',case='Y',kernel=self.kernel,partition='CONF')
    def test_real_data_admission_blocked(self):
        with self.assertRaises(ValueError):a.infer_bootstrap(self.fixture(),namespace='X',case='Y',kernel=self.kernel,partition='REAL')
    def test_fixture_label_and_guard(self):
        r=a.infer_bootstrap(self.fixture(),namespace='X',case='Y',kernel=self.kernel,resamples=599)
        self.assertEqual(r['partition'],'FIXTURE');self.assertFalse(r['confirmation_authorised'])
    def test_tiny_variation_preserved(self):
        x=np.full((3,4,3),.5);x[:,0]+=.00000001
        _,_,s=a.prepare(x);self.assertTrue((s>0).all())

if __name__=='__main__': unittest.main()
