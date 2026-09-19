"""Cross-language qualification on labelled arithmetic fixtures, never EXT."""
from __future__ import annotations

import argparse
import datetime
import json
import math
import re
from pathlib import Path
import subprocess
import sys
from typing import Any

import numpy as np
from statistics_core import (AnalysisError, B, G, N, HYPOTHESES, draw_tape, primary_analysis,
                             require, runtime, sha, validate_counts, validate_draws)
HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'04_EXECUTION_KIT/tools'))
from lifecycle import ProcessScope, ExecutionStopped, run_capture, check_running
KIND = 'ANALYTICAL_SOFTWARE_QUALIFICATION_ONLY'


def write_new(path: Path, value: Any) -> str:
    data = (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()
    with path.open('xb') as f:
        f.write(data)
    return sha(data)


def compare(a: Any, b: Any, name: str = 'root', receipt: dict | None = None):
    if receipt is None:
        receipt = {'numeric_values_compared': 0, 'exact_discrete_values_compared': 0,
                   'max_absolute_numeric_difference': 0.0}
    if isinstance(a, dict):
        require(isinstance(b, dict) and set(a) == set(b), 'reproduction key mismatch: ' + name)
        for k in a:
            compare(a[k], b[k], name+'.'+k, receipt)
    elif isinstance(a, list):
        require(isinstance(b, list) and len(a) == len(b), 'reproduction length mismatch: '+name)
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f'{name}[{i}]', receipt)
    elif isinstance(a, bool) or a is None or isinstance(a, str):
        require(type(a) == type(b) and a == b, 'reproduction discrete mismatch: '+name)
        receipt['exact_discrete_values_compared'] += 1
    elif isinstance(a, (int, float)):
        require(type(b) in (int, float), 'reproduction type mismatch: '+name)
        require(math.isfinite(a) and math.isfinite(b), 'non-finite unencoded value: '+name)
        exact = any(token in name for token in ('p_unadjusted', 'p_holm', 'exceedances', 'degenerate_resamples', 'rank_one_based'))
        require(a == b if exact else math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-12), 'reproduction numeric mismatch: '+name)
        receipt['numeric_values_compared'] += 1
        receipt['max_absolute_numeric_difference'] = max(receipt['max_absolute_numeric_difference'], abs(a-b))
    else:
        raise AnalysisError('unsupported comparison type: '+name)
    return receipt


def fixture(name: str) -> np.ndarray:
    a = np.full((G, N, 2, 2, 3), 0, dtype=np.int64)
    for g in range(G):
        for r in range(N):
            for c in range(2):
                if name == 'nondegenerate_cancellation':
                    base = 400 + g*3 + (r*7+c*5)%30
                    v = np.array([base+60+(r%11)-5, base, base+60+((r*3+c)%13)-6])
                elif name == 'stratum_constant_zero_variance':
                    v = np.array([440+g, 400+g, 430+g])
                elif name == 'sparse_degenerate_resamples':
                    v = np.array([400+int(g==0 and r==0),400,400-int(g==1 and r==1)])
                else:
                    raise AnalysisError('unknown qualification fixture')
                a[g,r,c,1] = v
                a[g,r,c,0] = v//4
    return validate_counts(a)


def qualify(output: Path) -> dict:
    require(not output.exists(), 'qualification output must be create-only')
    output.mkdir(parents=True)
    env = runtime()
    run = run_capture([sys.executable, '-m', 'unittest', 'discover', '-s', str(HERE/'tests'), '-v'],
                         capture_output=True, timeout=120)
    logs = run.stdout + run.stderr
    (output/'UNIT_TESTS.log').write_bytes(logs)
    require(run.returncode == 0, 'analysis unit tests failed; inspect UNIT_TESTS.log')
    match = re.search(rb'Ran (\d+) tests? in', logs)
    require(match is not None and int(match.group(1)) > 0, 'no analysis tests ran')
    tapes = {h: draw_tape(h) for h in HYPOTHESES}
    draws = output/'draws'; draws.mkdir()
    for h, data in tapes.items():
        validate_draws(data,h)
        (draws/(h+'.indices.u8')).write_bytes(data)
    results=[]
    for name in ['nondegenerate_cancellation','stratum_constant_zero_variance','sparse_degenerate_resamples']:
        case=output/name;case.mkdir()
        a=fixture(name)
        inp={'kind':KIND,'fixture_id':name,'features_or_labels_generated':False,
             'study2_evidence':False,'loss_counts':a.tolist()}
        write_new(case/'INPUT.json',inp)
        value,replicates=primary_analysis(a,tapes)
        python_value={'kind':KIND,'result':value,'replicates':replicates}
        write_new(case/'PYTHON_NUMERICS.json',python_value)
        proc=run_capture(['node',str(HERE/'reproduce.mjs'),str(case/'INPUT.json'),str(draws),str(case/'NODE_NUMERICS.json')],
                            capture_output=True, timeout=120)
        (case/'NODE_EXECUTION.log').write_bytes(proc.stdout+proc.stderr)
        require(proc.returncode==0,'independent implementation failed: '+name)
        node=json.loads((case/'NODE_NUMERICS.json').read_text())
        require(node['kind']==KIND,'qualification marker lost')
        comparison=compare({'result':value,'replicates':replicates},
                           {'result':node['result'],'replicates':node['replicates']})
        if name=='nondegenerate_cancellation':
            require(value['cancellation_diagnostic']=='CANCELLATION','known-sign fixture failed')
        elif name=='stratum_constant_zero_variance':
            require(all(v['ci']==[-1.0,1.0] and v['p_unadjusted']==1 for v in value['primary'].values()),'degenerate observed variance not conservative')
        else:
            require(all(v['degenerate_resamples']>0 and v['ci']==[-1.0,1.0] for v in value['primary'].values()),'degenerate resamples silently removed')
        item={'fixture_id':name,'status':'PASS_TWO_IMPLEMENTATIONS_AGREE','kind':KIND,
              'bootstrap_draws_per_primary':B,'primaries':2,**comparison,
              'files':{p.name:sha(p.read_bytes()) for p in case.iterdir() if p.is_file()}}
        write_new(case/'COMPARISON.json',item);results.append(item)
    # A corrupted independent result must not pass comparison.
    checks=0
    try:
        compare({'p_unadjusted':.0001},{'p_unadjusted':.0002})
        raise RuntimeError('tampered p-value accepted')
    except AnalysisError: checks+=1
    try:
        bad=bytearray(tapes['J1']);bad[0]=(bad[0]+1)%80;validate_draws(bytes(bad),'J1')
        raise RuntimeError('tampered draw schedule accepted')
    except AnalysisError: checks+=1
    # No conversion of the arithmetic fixture into a raw EXT record is provided.
    result={'schema_version':1,'status':'PASS_PREOUTCOME_NUMERICAL_QUALIFICATION',
            'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'runtime':env,'unit_tests_passed':int(match.group(1)),
            'full_shape_fixtures':len(results),'bootstrap_replicates_per_primary':B,
            'primary_bootstrap_runs':len(results)*2,'additional_tamper_checks_passed':checks,
            'kind':KIND,'ext_sources_or_outcomes_generated':False,
            'scientific_inference_on_study2_performed':False,'results':results,
            'draw_files':{h:{'sha256':sha(t),'bytes':len(t)} for h,t in tapes.items()},
            'limitation':'Independent arithmetic implementations use a common pre-outcome sealed index schedule; not an external investigator replication.'}
    check_running()
    write_new(output/'NUMERICAL_QUALIFICATION_RECEIPT.json',result)
    return result


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args()
    result=qualify(args.output.resolve())
    print(json.dumps({k:v for k,v in result.items() if k not in ('results',)},indent=2))

if __name__=='__main__':
    try:
        with ProcessScope(grace_seconds=5) as scope:
            main()
            scope.check()
    except (ExecutionStopped,AnalysisError,FileExistsError,FileNotFoundError) as exc:
        print('STOP_ANALYSIS_QUALIFICATION: '+str(exc),file=sys.stderr);raise SystemExit(2)
