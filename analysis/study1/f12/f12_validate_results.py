from __future__ import annotations
import argparse,csv,json
from pathlib import Path

def rows(p): return list(csv.DictReader(p.read_text().splitlines(),delimiter='\t'))
def f(x): return float(x)
def pareto(points,axes):
    out=[]
    for a,pa in points.items():
        if not any(b!=a and all(points[b][x]<=pa[x]+1e-15 for x in axes) and any(points[b][x]<pa[x]-1e-15 for x in axes) for b in points): out.append(a)
    return sorted(out)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',type=Path,required=True);args=ap.parse_args();o=args.output
    d=json.loads((o/'F12_DECISION_ECONOMICS.json').read_text())
    if d['status']!='COMPLETE_F12_DECISION_ECONOMICS' or d['new_hypothesis_tests'] or d['money_conversion']:raise RuntimeError('scope firewall')
    state={r['arm']:r for r in rows(o/'INTERNAL_STATE_RESOURCE.tsv')}
    if set(state)!={'PERSIST','RESTART-CART','CHAMPION-RESEED'}:raise RuntimeError('state arms')
    h1=d['internal_state']['paired_other_minus_persist']['H1_RESOURCE_PAIR']
    if not (h1['loss']['estimate']>0 and h1['cpu']['estimate']>0 and h1['elapsed']['estimate']>0 and abs(h1['apw']['estimate'])<0.01):raise RuntimeError('H1 economics invariant')
    h2=d['internal_state']['paired_other_minus_persist']['H2_RESOURCE_PAIR']
    if h2['official_f11']['practical_classification']!='EQUIVALENT' or not (h2['cpu']['estimate']>0 and h2['loss']['ci95_percentile'][0]<=0<=h2['loss']['ci95_percentile'][1]):raise RuntimeError('H2 equivalence economics invariant')
    mat=d['material']
    if not (mat['official_h3']['estimate']>0 and mat['apw']['estimate']>0 and mat['cpu']['estimate']<0 and mat['elapsed']['estimate']<0 and mat['realised_cpu_dominance']):raise RuntimeError('H3 resource invariant')
    if abs(mat['apw_premium_per_avoided_error']-mat['apw']['estimate']/(mat['official_h3']['estimate']*2000))>1e-12:raise RuntimeError('H3 break-even formula')
    ctxrows=rows(o/'CONTEXTUAL_METHOD_SUMMARY.tsv'); p={r['method']:{'mean_loss':f(r['mean_loss']),'process_cpu_seconds':f(r['process_cpu_seconds']),'elapsed_seconds':f(r['elapsed_seconds']),'mean_peak_rss_mib':f(r['mean_peak_rss_mib']),'p95_prediction_latency_microseconds':f(r['p95_prediction_latency_microseconds'])} for r in ctxrows}
    expected={'cpu_loss':pareto(p,['mean_loss','process_cpu_seconds']),'elapsed_loss':pareto(p,['mean_loss','elapsed_seconds']),'mean_rss_loss':pareto(p,['mean_loss','mean_peak_rss_mib']),'p95_latency_loss':pareto(p,['mean_loss','p95_prediction_latency_microseconds']),'loss_cpu_rss':pareto(p,['mean_loss','process_cpu_seconds','mean_peak_rss_mib'])}
    if expected!=d['contextual']['raw_pareto']:raise RuntimeError('pareto mismatch')
    if d['contextual']['supported_cpu_frontier']!=['FROZEN_CART','HAT','SRP']:raise RuntimeError('supported frontier mismatch')
    br=rows(o/'CONTEXTUAL_BREAK_EVEN.tsv')
    if not any(r['more_expensive_method']=='ARF' and r['break_even_status']=='UNSTABLE_ACCURACY_INCREMENT' for r in br):raise RuntimeError('ARF instability not preserved')
    if not any(r['frontier']=='SUPPORTED_CPU_FRONTIER' and r['cheaper_method']=='HAT' and r['more_expensive_method']=='SRP' and r['break_even_status']=='STABLE' for r in br):raise RuntimeError('supported HAT-SRP transition missing')
    print(json.dumps({'status':'PASS_INDEPENDENT_F12_VALIDATION','methods':len(p),'state_arms':len(state),'supported':d['contextual']['supported_cpu_frontier']},sort_keys=True))
if __name__=='__main__':main()
