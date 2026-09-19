import importlib.util,pathlib,unittest
import numpy as np
P=pathlib.Path(__file__).resolve().parents[1]/'working'/'f12'/'f12_decision_economics.py'
spec=importlib.util.spec_from_file_location('f12',P);f12=importlib.util.module_from_spec(spec);spec.loader.exec_module(f12)
class F12Tests(unittest.TestCase):
    def test_pareto(self):
        p={'A':{'loss':1,'cpu':1},'B':{'loss':2,'cpu':2},'C':{'loss':0.5,'cpu':3}}
        self.assertEqual(f12.pareto(p,['loss','cpu']),['A','C'])
    def test_supported_frontier_excludes_nonconvex_middle(self):
        p={'cheap':{'mean_loss':0.30,'process_cpu_seconds':1},'mid':{'mean_loss':0.20,'process_cpu_seconds':10},'badmid':{'mean_loss':0.199,'process_cpu_seconds':20},'best':{'mean_loss':0.18,'process_cpu_seconds':30}}
        self.assertEqual(f12.supported_cpu(p),['cheap','mid','best'])
    def test_equal_scenario_mean(self):
        self.assertAlmostEqual(f12.eqmean(np.asarray([[1.,3.],[2.,4.]])),2.5)
    def test_seed_deterministic_distinct(self):
        self.assertEqual(f12.seed('X'),f12.seed('X'));self.assertNotEqual(f12.seed('X'),f12.seed('Y'))
    def test_percentile_order(self):
        self.assertEqual(f12.pct_ci(np.arange(9999,dtype=float)),[249.0,9749.0])
if __name__=='__main__':unittest.main()
