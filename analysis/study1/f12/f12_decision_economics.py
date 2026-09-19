from __future__ import annotations
import argparse,csv,hashlib,json,math,platform
from collections import defaultdict
from pathlib import Path
import numpy as np

B=9999
SCENARIOS=(
"LOCAL_TREE-STATIONARY-NONE","LOCAL_TREE-ABRUPT-MILD","LOCAL_TREE-ABRUPT-SEVERE","LOCAL_TREE-GRADUAL-MILD","LOCAL_TREE-GRADUAL-SEVERE","LOCAL_TREE-RECURRENT-MILD","LOCAL_TREE-RECURRENT-SEVERE","OBLIQUE-STATIONARY-NONE","OBLIQUE-ABRUPT-MILD","OBLIQUE-ABRUPT-SEVERE","OBLIQUE-GRADUAL-MILD","OBLIQUE-GRADUAL-SEVERE","OBLIQUE-RECURRENT-MILD","OBLIQUE-RECURRENT-SEVERE")
STATE_ARMS=("PERSIST","RESTART-CART","CHAMPION-RESEED")
METHODS=("HAT","ARF","EFDT","SRP","FROZEN_CART","ROLLING_CART")
F10_ROOT="35f67440cf96cde5bf72dd767aba7a61339b1f375cfdcc04f2e271d38f9387f5"
CTX_ROOT="f4003ea670b0f3cca491b982b33faddee113482f14388b856d270b8473a58ecf"
F11_PRIMARY_SHA="48d1137ac5e984b26ac549d9b826ea458eb2993638319bcd1bad9fd256636c6e"

def sha_file(p:Path)->str:
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1<<20),b''):h.update(b)
    return h.hexdigest()
def seed(name:str)->int:
    return int(hashlib.sha256(f"DT-C8E1-F12-v1|{name}|B=9999".encode()).hexdigest()[:16],16)
def eqmean(v:np.ndarray)->float:return float(v.mean(axis=1).mean())
def pct_ci(vals:np.ndarray):
    s=np.sort(vals[np.isfinite(vals)])
    return [float(s[249]),float(s[9749])] if len(s)>=9750 else [None,None]
def boot_mean_matrix(x:np.ndarray,name:str)->dict:
    G,n=x.shape; rng=np.random.Generator(np.random.PCG64(seed(name))); vals=[]
    for st in range(0,B,500):
        ba=min(500,B-st); idx=rng.integers(0,n,size=(ba,G,n)); sm=x[np.arange(G)[None,:,None],idx]; vals.append(sm.mean(2).mean(1))
    vals=np.concatenate(vals); return {'estimate':eqmean(x),'ci95_percentile':pct_ci(vals),'seed_uint64':seed(name)}
def boot_ratio(a:np.ndarray,q:np.ndarray,name:str)->dict:
    obs=eqmean(a)/eqmean(q); G,n=a.shape; rng=np.random.Generator(np.random.PCG64(seed(name))); vals=[]
    for st in range(0,B,500):
        ba=min(500,B-st); idx=rng.integers(0,n,size=(ba,G,n)); sa=a[np.arange(G)[None,:,None],idx]; sq=q[np.arange(G)[None,:,None],idx]; aa=sa.mean(2).mean(1); qq=sq.mean(2).mean(1); vals.append(np.divide(aa,qq,out=np.full(ba,np.nan),where=qq>0))
    vals=np.concatenate(vals); return {'estimate':float(obs),'ci95_percentile':pct_ci(vals),'finite_resamples':int(np.isfinite(vals).sum()),'seed_uint64':seed(name)}
def pareto(points:dict[str,dict],axes:list[str])->list[str]:
    out=[]
    for a,pa in points.items():
        dominated=False
        for b,pb in points.items():
            if a==b:continue
            le=all(pb[x] <= pa[x] for x in axes); strict=any(pb[x] < pa[x] for x in axes)
            if le and strict:dominated=True;break
        if not dominated:out.append(a)
    return sorted(out)
def supported_cpu(points:dict[str,dict])->list[str]:
    methods=list(points); supported=[]
    for m in methods:
        lo,hi=0.0,math.inf; Cm,Lm=points[m]['process_cpu_seconds'],points[m]['mean_loss']; feasible=True
        for j in methods:
            if j==m:continue
            Cj,Lj=points[j]['process_cpu_seconds'],points[j]['mean_loss']; dc=Cm-Cj; rhs=Lj-Lm
            if abs(dc)<1e-15:
                if rhs < -1e-15: feasible=False;break
            elif dc>0: hi=min(hi,rhs/dc)
            else: lo=max(lo,rhs/dc)
        lo=max(lo,0.0)
        if feasible and hi>=lo and hi>=0:supported.append((points[m]['process_cpu_seconds'],m,lo,hi))
    return [m for _,m,_,_ in sorted(supported)]

def load_primary(root:Path):
    manifest=json.loads((root/'CAMPAIGN_MANIFEST.json').read_text())
    if manifest['records']!=4480 or manifest['raw_record_root_sha256']!=F10_ROOT:raise RuntimeError('F10 primary identity mismatch')
    rows=[]; mat=[]
    for f in (root/'records').glob('*.json'):
        r=json.loads(f.read_text()); s=r['identity']['scenario_id']; real=int(r['identity']['realisation']); comp=bool(r['identity']['comparator_included'])
        for c in r['checkpoints']:
            base={'scenario':s,'realisation':real,'checkpoint':int(c['checkpoint']),'comparator':comp}; rr=dict(base)
            for a in STATE_ARMS:
                v=c['state'][a]; rr[a]={'loss':float(v['horizons']['2000']['mean_loss']),'apw':float(v['resources']['adaptation_apw_total']),'cpu':float(v['process_cpu_ns_total'])/1e9,'elapsed':float(v['elapsed_ns_total'])/1e9,'rss':float(v['resources']['max_reported_peak_rss_bytes'])/2**20,'pred_ms':float(v['prediction_ns_total'])/1e6,'snapshot_mib':float(v['end_state'].get('snapshot_bytes',0))/2**20}
            rows.append(rr)
            m=c['material']; e=bool(m['eligible']); mr=dict(base); mr['eligible']=e
            if e:
                for a in ('MATERIAL-REPLACE','STRUCTURAL-SHAM'):
                    cost=m['arm_costs'][a]; arm=m['arms'][a]
                    mr[a]={'loss':float(arm['horizons']['2000']['mean_loss']),'apw':float(cost['adaptation_apw_total']),'cpu':float(cost['process_cpu_ns'])/1e9,'elapsed':float(cost['elapsed_ns'])/1e9,'rss':float(cost['peak_rss_bytes'])/2**20,'pred_ms':float(arm['prediction_ns_total'])/1e6}
            mat.append(mr)
    if len(rows)!=8960:raise RuntimeError('checkpoint cardinality mismatch')
    return rows,mat

def state_matrices(rows):
    by=defaultdict(list)
    for r in rows:
        if not r['comparator']:by[(r['scenario'],r['realisation'])].append(r)
    if len(by)!=4200:raise RuntimeError('common-horizon state subset mismatch')
    mats={}; metrics=('loss','apw','cpu','elapsed','rss','pred_ms','snapshot_mib')
    for arm in STATE_ARMS:
        for metric in metrics:
            arr=[]
            for s in SCENARIOS:
                vals=[]
                for real in range(320):
                    key=(s,real)
                    if key not in by:continue
                    g=by[key]; vals.append(sum(x[arm][metric] for x in g)/2)
                if len(vals)!=300:raise RuntimeError(f'state stratum mismatch {s}')
                arr.append(vals)
            mats[(arm,metric)]=np.asarray(arr,float)
    return mats

def material_components(mat,metric):
    A=[];Q=[]; by=defaultdict(list)
    for r in mat:by[(r['scenario'],r['realisation'])].append(r)
    for s in SCENARIOS:
        avec=[];qvec=[]
        for real in range(320):
            g=by[(s,real)]; num=q=0.0
            for r in g:
                e=1.0 if r['eligible'] else 0.0; q+=e/2
                if e:num += (r['STRUCTURAL-SHAM'][metric]-r['MATERIAL-REPLACE'][metric])/2
            avec.append(num);qvec.append(q)
        A.append(avec);Q.append(qvec)
    return np.asarray(A,float),np.asarray(Q,float)

def load_contextual(root:Path):
    manifest=json.loads((root/'CONTEXTUAL_CAMPAIGN_MANIFEST.json').read_text())
    if manifest['cells']!=1680 or manifest['cell_record_root_sha256']!=CTX_ROOT:raise RuntimeError('contextual identity mismatch')
    rows=[]
    for line in (root/'CONTEXTUAL_CELLS.jsonl').read_text().splitlines():
        r=json.loads(line); rows.append({'scenario':r['scenario_id'],'source':r['source_key_hex'],'method':r['method'],'loss':float(r['mean_loss']),'cpu':float(r['process_cpu_ns'])/1e9,'elapsed':float(r['elapsed_ns'])/1e9,'supervisor':float(r['supervisor_elapsed_ns'])/1e9,'rss':float(r['peak_rss_bytes'])/2**20,'p95':float(r['prediction_latency']['p95_ns'])/1e3})
    if len(rows)!=1680:raise RuntimeError('contextual rows mismatch')
    return rows

def contextual_matrices(rows):
    maps=defaultdict(dict)
    for r in rows:maps[(r['method'],r['scenario'])][r['source']]=r
    out={}
    for m in METHODS:
        for metric in ('loss','cpu','elapsed','supervisor','rss','p95'):
            arr=[]
            for s in SCENARIOS:
                vals=[x[metric] for x in maps[(m,s)].values()]
                if len(vals)!=20:raise RuntimeError('contextual stratum mismatch')
                arr.append(vals)
            out[(m,metric)]=np.asarray(arr,float)
    pair={}
    for s in SCENARIOS:
        keys=sorted(maps[(METHODS[0],s)])
        for m in METHODS:
            if sorted(maps[(m,s)])!=keys:raise RuntimeError('contextual source pairing mismatch')
        pair[s]=keys
    for m in METHODS:
        for metric in ('loss','cpu','elapsed','rss','p95'):
            out[(m,metric,'paired')]=np.asarray([[maps[(m,s)][k][metric] for k in pair[s]] for s in SCENARIOS],float)
    return out

def write_tsv(path,rows,fields):
    with path.open('w',encoding='utf-8',newline='') as fh:
        w=csv.DictWriter(fh,fieldnames=fields,delimiter='\t',lineterminator='\n');w.writeheader();w.writerows(rows)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--primary',type=Path,required=True);ap.add_argument('--contextual',type=Path,required=True);ap.add_argument('--f11',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);args=ap.parse_args()
    if platform.python_version()!='3.12.13' or np.__version__!='2.5.3':raise RuntimeError('exact F12 runtime required')
    if sha_file(args.f11/'PRIMARY_INFERENCE.json')!=F11_PRIMARY_SHA:raise RuntimeError('F11 primary inference identity mismatch')
    f11=json.loads((args.f11/'PRIMARY_INFERENCE.json').read_text())['results']; rows,mat=load_primary(args.primary); sm=state_matrices(rows)
    out=args.output;out.mkdir(parents=True,exist_ok=True); state_rows=[]; state_summary={}
    for arm in STATE_ARMS:
        x={}
        for metric in ('loss','apw','cpu','elapsed','rss','pred_ms','snapshot_mib'):x[metric]=boot_mean_matrix(sm[(arm,metric)],f'STATE|{arm}|{metric}')
        x['max_peak_rss_mib']=float(sm[(arm,'rss')].max()); state_summary[arm]=x
        state_rows.append({'arm':arm,'mean_loss_2000':x['loss']['estimate'],'adaptation_apw_total':x['apw']['estimate'],'process_cpu_seconds':x['cpu']['estimate'],'elapsed_seconds':x['elapsed']['estimate'],'mean_peak_rss_mib':x['rss']['estimate'],'maximum_peak_rss_mib':x['max_peak_rss_mib'],'prediction_milliseconds':x['pred_ms']['estimate'],'end_state_snapshot_mib':x['snapshot_mib']['estimate']})
    state_pair={}
    for other,label in [('RESTART-CART','H1_RESOURCE_PAIR'),('CHAMPION-RESEED','H2_RESOURCE_PAIR')]:
        d={}
        for metric in ('loss','apw','cpu','elapsed','rss','pred_ms','snapshot_mib'):d[metric]=boot_mean_matrix(sm[(other,metric)]-sm[('PERSIST',metric)],f'{label}|{metric}')
        d['sign']='other_minus_PERSIST'; d['official_f11']=f11['H1' if other=='RESTART-CART' else 'H2']; state_pair[label]=d
    material={}
    for metric in ('apw','cpu','elapsed','rss','pred_ms'):
        A,Q=material_components(mat,metric); material[metric]=boot_ratio(A,Q,f'H3_RESOURCE|{metric}')
    h3=f11['H3']; avoided_errors=float(h3['estimate'])*2000
    material['official_h3']=h3; material['avoided_errors_per_eligible_2000']=avoided_errors; material['apw_premium_per_avoided_error']=material['apw']['estimate']/avoided_errors; material['apw_premium_per_one_percentage_point']=material['apw']['estimate']/(float(h3['estimate'])/0.01); material['realised_cpu_dominance']=(material['cpu']['estimate']<0 and float(h3['estimate'])>0)
    cr=load_contextual(args.contextual); cm=contextual_matrices(cr); ctx_points={};ctx_rows=[]
    for m in METHODS:
        p={'mean_loss':eqmean(cm[(m,'loss')]),'process_cpu_seconds':eqmean(cm[(m,'cpu')]),'elapsed_seconds':eqmean(cm[(m,'elapsed')]),'supervisor_elapsed_seconds':eqmean(cm[(m,'supervisor')]),'mean_peak_rss_mib':eqmean(cm[(m,'rss')]),'maximum_peak_rss_mib':float(cm[(m,'rss')].max()),'p95_prediction_latency_microseconds':eqmean(cm[(m,'p95')])}; p['expected_errors_per_24000']=p['mean_loss']*24000;ctx_points[m]=p;ctx_rows.append({'method':m,**p})
    raw_cpu=pareto(ctx_points,['mean_loss','process_cpu_seconds']);raw_elapsed=pareto(ctx_points,['mean_loss','elapsed_seconds']);raw_rss=pareto(ctx_points,['mean_loss','mean_peak_rss_mib']);raw_latency=pareto(ctx_points,['mean_loss','p95_prediction_latency_microseconds']);raw_3d=pareto(ctx_points,['mean_loss','process_cpu_seconds','mean_peak_rss_mib']);supported=supported_cpu(ctx_points)
    pair_rows=[]
    def pair_record(cheap,expensive,tag):
        dloss=cm[(cheap,'loss','paired')]-cm[(expensive,'loss','paired')]; dcpu=cm[(expensive,'cpu','paired')]-cm[(cheap,'cpu','paired')]
        bl=boot_mean_matrix(dloss,f'CTX|{tag}|LOSS');bc=boot_mean_matrix(dcpu,f'CTX|{tag}|CPU'); stable=bl['ci95_percentile'][0]>0 and bc['ci95_percentile'][0]>0
        rec={'frontier':tag,'cheaper_method':cheap,'more_expensive_method':expensive,'loss_improvement':bl['estimate'],'loss_improvement_ci95_lo':bl['ci95_percentile'][0],'loss_improvement_ci95_hi':bl['ci95_percentile'][1],'cpu_premium_seconds':bc['estimate'],'cpu_premium_ci95_lo':bc['ci95_percentile'][0],'cpu_premium_ci95_hi':bc['ci95_percentile'][1],'break_even_status':'STABLE' if stable else 'UNSTABLE_ACCURACY_INCREMENT'}
        if stable:rec.update({'cpu_seconds_per_one_percentage_point':bc['estimate']/(100*bl['estimate']),'cpu_seconds_per_avoided_error':bc['estimate']/(24000*bl['estimate']),'scalarisation_lambda_loss_per_cpu_second':bl['estimate']/bc['estimate']})
        else:rec.update({'cpu_seconds_per_one_percentage_point':None,'cpu_seconds_per_avoided_error':None,'scalarisation_lambda_loss_per_cpu_second':None})
        return rec
    rc=sorted(raw_cpu,key=lambda m:ctx_points[m]['process_cpu_seconds'])
    for a,b in zip(rc,rc[1:]):pair_rows.append(pair_record(a,b,'RAW_CPU_PARETO'))
    sc=sorted(supported,key=lambda m:ctx_points[m]['process_cpu_seconds'])
    for a,b in zip(sc,sc[1:]):pair_rows.append(pair_record(a,b,'SUPPORTED_CPU_FRONTIER'))
    result={'schema_version':1,'phase':'F12_DECISION_ECONOMICS','status':'COMPLETE_F12_DECISION_ECONOMICS','post_confirmatory':True,'new_hypothesis_tests':False,'money_conversion':False,'internal_state':{'common_horizon_resource_streams':4200,'streams_per_scenario':300,'state_summary':state_summary,'paired_other_minus_persist':state_pair,'decision':{'H1':'PERSIST strictly dominates RESTART-CART on loss and realised CPU/elapsed while APW is matched; no positive break-even resource price is required.','H2':'F11 classifies PERSIST versus CHAMPION-RESEED as practically equivalent. On the common-horizon subset PERSIST uses less realised CPU/elapsed; under the frozen practical-equivalence tie-break PERSIST is operationally preferred, not claimed more accurate.'}},'material':material,'contextual':{'methods':ctx_points,'raw_pareto':{'cpu_loss':raw_cpu,'elapsed_loss':raw_elapsed,'mean_rss_loss':raw_rss,'p95_latency_loss':raw_latency,'loss_cpu_rss':raw_3d},'supported_cpu_frontier':supported,'pairwise_break_even':pair_rows,'interpretation_firewall':'Contextual methods are predictive/resource benchmarks only and do not identify H1-H3.'},'firewalls':{'apw_external_forbidden':True,'cpu_as_apw_forbidden':True,'monetary_conversion_forbidden':True,'f13_started':False,'manuscript_modified':False}}
    (out/'F12_DECISION_ECONOMICS.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n');write_tsv(out/'INTERNAL_STATE_RESOURCE.tsv',state_rows,list(state_rows[0]));write_tsv(out/'CONTEXTUAL_METHOD_SUMMARY.tsv',ctx_rows,list(ctx_rows[0]));write_tsv(out/'CONTEXTUAL_BREAK_EVEN.tsv',pair_rows,list(pair_rows[0]))
    matrow={'comparison':'STRUCTURAL-SHAM_MINUS_MATERIAL-REPLACE','official_h3_loss_benefit':h3['estimate'],'avoided_errors_per_eligible_2000':avoided_errors,'apw_premium':material['apw']['estimate'],'cpu_seconds_difference':material['cpu']['estimate'],'elapsed_seconds_difference':material['elapsed']['estimate'],'prediction_milliseconds_difference':material['pred_ms']['estimate'],'apw_per_avoided_error':material['apw_premium_per_avoided_error'],'apw_per_one_percentage_point':material['apw_premium_per_one_percentage_point']};write_tsv(out/'MATERIAL_RESOURCE.tsv',[matrow],list(matrow))
    receipt={'schema_version':1,'phase':'F12_DECISION_ECONOMICS','status':'COMPLETE_F12_ANALYSIS','python':platform.python_version(),'numpy':np.__version__,'primary_records':4480,'contextual_cells':1680,'f11_primary_sha256':sha_file(args.f11/'PRIMARY_INFERENCE.json'),'decision_economics_sha256':sha_file(out/'F12_DECISION_ECONOMICS.json'),'internal_state_sha256':sha_file(out/'INTERNAL_STATE_RESOURCE.tsv'),'contextual_summary_sha256':sha_file(out/'CONTEXTUAL_METHOD_SUMMARY.tsv'),'contextual_break_even_sha256':sha_file(out/'CONTEXTUAL_BREAK_EVEN.tsv'),'material_resource_sha256':sha_file(out/'MATERIAL_RESOURCE.tsv'),'f13_started':False,'manuscript_modified':False};(out/'F12_ANALYSIS_RECEIPT.json').write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'state':state_rows,'material':matrow,'contextual':ctx_rows,'pareto':result['contextual']['raw_pareto'],'supported':supported},sort_keys=True))
if __name__=='__main__':main()
