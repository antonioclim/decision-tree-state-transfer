from __future__ import annotations
import math
import unittest
import numpy as np
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "working" / "f11"))
import f11_stats as stats


class F11StatisticsTests(unittest.TestCase):
    def test_constants_and_finite_orders(self):
        self.assertEqual(stats.B, 9999)
        self.assertEqual(stats.CRITICAL_ONE_BASED, 9834)
        self.assertEqual(stats.PERCENTILE_LOWER_ONE_BASED, 250)
        self.assertEqual(stats.PERCENTILE_UPPER_ONE_BASED, 9750)
        self.assertEqual(stats.DELTA, 0.005)
        self.assertEqual(stats.PRIMARY_SEEDS, {"H1":1353558527596327882,"H2":11095830246438979893,"H3":14964784543515708419})

    def test_equal_scenario_mean_standard_error_formula(self):
        x=np.tile(np.array([0.,1.,2.,3.]),(stats.G,1))
        expected=math.sqrt(stats.G*np.var(x[0],ddof=1)/(stats.G*stats.G*4))
        self.assertTrue(math.isclose(stats.equal_scenario_mean_se(x),expected,rel_tol=0,abs_tol=1e-15))

    def test_ratio_se_zero_for_exact_constant_ratio(self):
        q=np.tile(np.array([.25,.5,.75,1.]),(stats.G,1));a=.2*q
        self.assertTrue(math.isclose(stats.equal_scenario_ratio_se(a,q,.2),0.,rel_tol=0,abs_tol=1e-15))

    def test_holm_fixed_family_stop_rule(self):
        r={"H1":{"p_unadjusted":.001,"ci":[.01,.02]},"H2":{"p_unadjusted":.06,"ci":[-.001,.001]},"H3":{"p_unadjusted":.024,"ci":[.006,.008]}}
        stats.apply_holm(r)
        self.assertTrue(r["H1"]["holm_reject_fwer_0_05"])
        self.assertTrue(r["H3"]["holm_reject_fwer_0_05"])
        self.assertFalse(r["H2"]["holm_reject_fwer_0_05"])
        self.assertTrue(math.isclose(r["H1"]["p_holm_adjusted"],.003))
        self.assertTrue(math.isclose(r["H3"]["p_holm_adjusted"],.048))
        self.assertTrue(math.isclose(r["H2"]["p_holm_adjusted"],.06))

    def test_practical_classification_uses_interval_position(self):
        self.assertEqual(stats.practical_classification([.0050001,.01]),"BENEFICIAL")
        self.assertEqual(stats.practical_classification([-.01,-.0050001]),"HARMFUL")
        self.assertEqual(stats.practical_classification([-.004,.004]),"EQUIVALENT")
        self.assertEqual(stats.practical_classification([-.006,.004]),"INCONCLUSIVE")

    def test_zero_variation_mechanism_column_is_not_estimated(self):
        b=stats.mechanism_solve(np.array([[4.,0.],[0.,0.]]),np.array([2.,0.]))
        self.assertTrue(math.isclose(b[0],.5))
        self.assertTrue(np.isnan(b[1]))

    def test_rank_deficiency_never_invents_mechanism_coefficients(self):
        b=stats.mechanism_solve(np.array([[1.,1.],[1.,1.]]),np.array([1.,1.]))
        self.assertTrue(np.isnan(b).all())


if __name__ == '__main__':
    unittest.main()
