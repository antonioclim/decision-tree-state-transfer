import importlib.util
from pathlib import Path
import unittest
SPEC=importlib.util.spec_from_file_location('f02a',Path(__file__).parents[1]/'assets/code/confirmatory/f02-dev-assembler.py')
a=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(a)
class T(unittest.TestCase):
  def records(self,eligible=True):
    out=[]
    for treatment,loss in [('PERSIST',.10),('RESTART-CART',.15),('CHAMPION-RESEED',.12)]:
      out.append(dict(schema_version=1,partition='DEV',kind='state',scenario='s',realisation=0,optimiser=0,checkpoint=10000,treatment=treatment,status='COMPLETE',predictions=2000,loss=loss,resource={}))
    for treatment,loss in [('MATERIAL-REPLACE',.18),('STRUCTURAL-SHAM',.12)]:
      out.append(dict(schema_version=1,partition='DEV',kind='material',scenario='s',realisation=0,optimiser=0,checkpoint=10000,treatment=treatment,status='COMPLETE' if eligible else 'NO_ELIGIBLE_SITE',eligible=eligible,predictions=2000,loss=loss if eligible else .10,resource={}))
    return out
  def test_conditional_and_policy_estimands_are_separate(self):
    r=a.assemble(self.records(True))['units'][0];self.assertAlmostEqual(r['H1'][0],.05);self.assertAlmostEqual(r['H2'][0],.02);self.assertAlmostEqual(r['H3_conditional'][0],.06);self.assertAlmostEqual(r['H3_policy'][0],.06)
    z=a.assemble(self.records(False))['units'][0];self.assertEqual(z['H3_conditional'],[]);self.assertEqual(z['H3_policy'],[0.0]);self.assertEqual(z['material_eligible'],0)
  def test_algorithmic_and_treatment_unavailable_state_losses_are_not_dropped(self):
    r=self.records();
    for x in r:
      if x['kind']=='state' and x['treatment']=='PERSIST':x.update(status='TREATMENT_UNAVAILABLE',loss=1)
      if x['kind']=='state' and x['treatment']=='CHAMPION-RESEED':x.update(status='TREATMENT_UNAVAILABLE',loss=1)
    z=a.assemble(r)['units'][0];self.assertAlmostEqual(z['H1'][0],-.85);self.assertEqual(z['H2'][0],0.0)
  def test_parent_unavailable_material_pair_is_retained_as_policy_zero(self):
    r=self.records(False)
    for x in r:
      if x['kind']=='material':x.update(status='PARENT_UNAVAILABLE',loss=1)
    z=a.assemble(r)['units'][0];self.assertEqual(z['H3_conditional'],[]);self.assertEqual(z['H3_policy'],[0.0])
  def test_duplicate_and_conf_are_rejected(self):
    r=self.records();
    with self.assertRaises(ValueError):a.assemble(r+[r[0]])
    r[0]['partition']='CONF'
    with self.assertRaises(ValueError):a.assemble(r)
  def test_incomplete_state_pair_is_rejected(self):
    r=[x for x in self.records() if not (x['kind']=='state' and x['treatment']=='CHAMPION-RESEED')]
    with self.assertRaises(ValueError):a.assemble(r)
  def test_incomplete_material_pair_is_rejected(self):
    r=[x for x in self.records() if not (x['kind']=='material' and x['treatment']=='STRUCTURAL-SHAM')]
    with self.assertRaises(ValueError):a.assemble(r)
  def test_paired_horizon_mismatch_is_rejected(self):
    r=self.records();r[1]['predictions']=1999
    with self.assertRaises(ValueError):a.assemble(r)
  def test_ineligible_nonzero_material_contrast_is_rejected(self):
    r=self.records(False)
    for x in r:
      if x['treatment']=='MATERIAL-REPLACE':x['loss']=.11
    with self.assertRaises(ValueError):a.assemble(r)
if __name__=='__main__':unittest.main()
