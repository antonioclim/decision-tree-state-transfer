import math
import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'assets/code/confirmatory'))
from bounded_precision import hoeffding_radius, sparse_no_event_probability, sparse_bootstrap_zero_variance_probability

class TestBoundedReference(unittest.TestCase):
    def test_equal_weights_closed_form(self):
        self.assertAlmostEqual(hoeffding_radius([20]*14),math.sqrt(2*math.log(120)/280))
    def test_unequal_design(self):
        self.assertAlmostEqual(hoeffding_radius([10,100],[.25,.75]),math.sqrt(2*math.log(120)*(.25**2/10+.75**2/100)))
    def test_sample_size_scaling(self):
        self.assertAlmostEqual(hoeffding_radius([80]*14),hoeffding_radius([20]*14)/2)
    def test_known_support_scaling(self):
        self.assertAlmostEqual(hoeffding_radius([20]*14,support=(0,1)),hoeffding_radius([20]*14)/2)
    def test_monotone_family(self):
        self.assertGreater(hoeffding_radius([20]*14),hoeffding_radius([20]*14,hypotheses=1))
    def test_bad_counts(self):
        for v in [[],[True],[1.5],[0],[-1]]:
            with self.subTest(v=v),self.assertRaises(ValueError):hoeffding_radius(v)
    def test_bad_weights(self):
        for v in [[1],[.3,.3],[-1,2],[True,False],[float('nan'),1]]:
            with self.subTest(v=v),self.assertRaises(ValueError):hoeffding_radius([20,20],v)
    def test_bad_alpha(self):
        for v in [True,0,1,float('nan'),'0.05']:
            with self.subTest(v=v),self.assertRaises(ValueError):hoeffding_radius([20],alpha=v)
    def test_bad_hypotheses(self):
        for v in [True,0,-1,1.5]:
            with self.subTest(v=v),self.assertRaises(ValueError):hoeffding_radius([20],hypotheses=v)
    def test_bad_support(self):
        for v in [(1,1),(1,0),(0,float('inf')),(False,1),(0,)]:
            with self.subTest(v=v),self.assertRaises(ValueError):hoeffding_radius([20],support=v)
    def test_zero_mass_exact_enumeration(self):
        x=np.array([[0,1],[0,0]])
        self.assertEqual(sparse_bootstrap_zero_variance_probability(x),.5)
        self.assertEqual(sparse_bootstrap_zero_variance_probability([[0,0],[1,1]]),1)
    def test_observed_no_event(self):
        self.assertAlmostEqual(sparse_no_event_probability(280),.99**280)
    def test_invalid_sparse(self):
        for x in [[[0]],[[float('nan'),0]],[1,2]]:
            with self.subTest(x=x),self.assertRaises(ValueError):sparse_bootstrap_zero_variance_probability(x)
        with self.assertRaises(ValueError):sparse_no_event_probability(0)

if __name__=='__main__':unittest.main()
