#!/usr/bin/env python3
"""Qualify before EXT; compute J1/J2 only after full raw-evidence admission."""
from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
sys.path.insert(0,str(PACKAGE/'04_EXECUTION_KIT/tools'))
from lifecycle import ProcessScope, ExecutionStopped, run_capture, check_running, exclusive_controller
from gates import CLAIM, TREE, GateError, exact_cardinality, gate, load
from execute import require_qualification, verify_all, write_new
from preoutcome_binding import analysis_pins, require_analysis_binding
from statistics_core import (AnalysisError, HYPOTHESES, draw_tape, primary_analysis,
                             require, runtime, secondary_points, sha, validate_draws)
from qualify_analysis import compare, qualify
from reporting import extract_loss_counts, resource_summary


def pre_outcome_qualification(args):
    require_qualification(args)
    # A new numerical freeze after any value-producing attempt is not admitted.
    for directory in ('attempts','admitted','locks'):
        root=args.run_root/directory
        require(not root.exists() or not any(root.iterdir()),'EXT attempt metadata exists; a new pre-outcome binding is forbidden')
    pins=analysis_pins()
    result=qualify(args.run_root/'analysis-qualification')
    require(analysis_pins()==pins,'analysis changed during qualification')
    require_qualification(args)
    receipt=args.run_root/'analysis-qualification/NUMERICAL_QUALIFICATION_RECEIPT.json'
    value={'status':'PASS_ANALYSIS_BOUND_BEFORE_EXT','tree':TREE,'preflight':CLAIM,
           'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'ext_values_existed_at_binding':False,'analysis_files':pins,
           'engine_admission_sha256':sha((args.run_root/'qualification/ADMISSION.json').read_bytes()),
           'numerical_qualification_receipt_sha256':sha(receipt.read_bytes()),
           'runtime':result['runtime'],'qualification_kind':result['kind']}
    check_running()
    write_new(args.run_root/'ANALYSIS_PREOUTCOME_ADMISSION.json',value)
    print('PASS_ANALYSIS_BOUND_BEFORE_EXT; no EXT outcome generated')


def membership_before_outcomes(root: Path):
    require(not root.is_symlink(),'run-root symlink not admitted')
    directory=root/'admitted'
    require(not directory.is_symlink(),'admission-directory symlink not admitted')
    files=sorted(directory.glob('*.json'))
    require(len(files)==1120,'STOP_I06_NO_VALID_INTERPRETATION: 1120 admitted units are required before outcomes are opened')
    envelopes=[load(p) for p in files]
    exact_cardinality([v['index'] for v in envelopes])
    require(len(list(directory.iterdir()))==1120,'unexpected admission-directory members')
    return envelopes


def require_bound_runtime(args):
    observed=runtime()
    recorded=load(args.run_root/'ANALYSIS_PREOUTCOME_ADMISSION.json')
    require(recorded['runtime']==observed,'analysis runtime differs from the pre-outcome binding')
    return observed


def scientific_analysis(args):
    membership_before_outcomes(args.run_root)
    require_qualification(args)
    require_bound_runtime(args)
    binding=require_analysis_binding(args)
    complete_path=args.run_root/'COMPLETE_RAW_EVIDENCE.json'
    recorded_complete=load(complete_path)
    complete,paths=verify_all(args,publish=False)
    require(recorded_complete==complete,'complete-raw receipt is stale or substituted')
    # Re-read the bytes used for analysis and bind them to the same raw roots.
    # The complete gate has finished before the first contrast is formed.
    records=[]
    for item in paths:
        data=item['path'].read_bytes()
        require(sha(data)==item['sha256'],'raw record changed after validation')
        records.append(load(item['path']))
        require(sha(item['path'].read_bytes())==item['sha256'],'raw record changed during JSON read')
    counts=extract_loss_counts(records)
    require(not args.output.exists(),'analysis output is create-only; never overwrite an analysis')
    args.output.mkdir(parents=True)
    try:
        tapes={h:draw_tape(h) for h in HYPOTHESES}
        draws=args.output/'draws';draws.mkdir()
        for h,data in tapes.items():
            validate_draws(data,h)
            (draws/(h+'.indices.u8')).write_bytes(data)
        inp={'kind':'FULL_ADMITTED_EXT_COUNTS_AUDIT_REQUIRED',
             'protocol_id':'DT-I05-NST-v1.0','evidence_root_sha256':complete['evidence_root_sha256'],
             'analysis_preoutcome_binding_sha256':binding,'loss_counts':counts.tolist()}
        write_new(args.output/'REPRODUCTION_INPUT.json',inp)
        result,replicates=primary_analysis(counts,tapes)
        write_new(args.output/'PRIMARY_INFERENCE.json',result)
        write_new(args.output/'BOOTSTRAP_REPLICATES.json',replicates)
        command=['node',str(HERE/'reproduce.mjs'),str(args.output/'REPRODUCTION_INPUT.json'),str(draws),str(args.output/'INDEPENDENT_NODE_REPRODUCTION.json')]
        proc=run_capture(command,capture_output=True,timeout=300)
        (args.output/'INDEPENDENT_NODE_EXECUTION.log').write_bytes(proc.stdout+proc.stderr)
        require(proc.returncode==0,'independent inference reproduction failed')
        independent=load(args.output/'INDEPENDENT_NODE_REPRODUCTION.json')
        require(independent['kind']==inp['kind'] and independent['input_sha256']==sha((args.output/'REPRODUCTION_INPUT.json').read_bytes()),'independent input binding differs')
        comparison=compare({'result':result,'replicates':replicates},
                           {'result':independent['result'],'replicates':independent['replicates']})
        write_new(args.output/'INDEPENDENT_COMPARISON.json',comparison)
        write_new(args.output/'SECONDARY_POINT_SUMMARIES.json',secondary_points(counts))
        write_new(args.output/'RESOURCE_SUMMARIES.json',resource_summary(records))
        # The input universe, every admitted file and the implementation remain
        # bound before the computation receipt is published.
        again,_=verify_all(args,publish=False)
        require(again==complete,'raw campaign changed during inference')
        require(require_analysis_binding(args)==binding,'pre-outcome binding changed during inference')
        evidence={str(p.relative_to(args.output)):sha(p.read_bytes()) for p in args.output.rglob('*') if p.is_file()}
        check_running()
        write_new(args.output/'ANALYSIS_COMPUTATION_RECEIPT.json',{
            'status':'PASS_PRIMARY_COMPUTATION_AND_NUMERICAL_REPRODUCTION_AUDIT_REQUIRED',
            'scientific_phase_complete':False,'independent_units':1120,'protocol_id':'DT-I05-NST-v1.0',
            'evidence_root_sha256':complete['evidence_root_sha256'],
            'analysis_preoutcome_binding_sha256':binding,'runtime':runtime(),'files':evidence,
            'secondary_inference_scope':'Point summaries only; no unregistered secondary p-values',
            'remaining_gate':'Final I06B adversarial scientific audit and explicit phase closeout before I07.'})
        print('PASS_PRIMARY_COMPUTATION_AND_NUMERICAL_REPRODUCTION_AUDIT_REQUIRED')
    except BaseException as exc:
        write_new(args.output/'ANALYSIS_QUARANTINE.json',{'status':'ANALYSIS_NOT_ADMITTED','reason':str(exc),'scientific_phase_complete':False})
        raise


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('command',choices=['qualify','run','verify-binding'])
    ap.add_argument('--repo',type=Path,required=True)
    ap.add_argument('--run-root',type=Path,required=True)
    ap.add_argument('--output',type=Path)
    a=ap.parse_args();a.repo=a.repo.resolve();a.run_root=a.run_root.absolute()
    require(not a.run_root.is_relative_to(a.repo),'run root must be outside the qualified source')
    with exclusive_controller(a.run_root):
        if a.command=='qualify':pre_outcome_qualification(a)
        elif a.command=='verify-binding':
            require_qualification(a);require_bound_runtime(a)
            print(require_analysis_binding(a))
        else:
            require(a.output is not None,'--output required for scientific analysis')
            a.output=a.output.absolute()
            require(not a.output.is_relative_to(a.repo),'analysis output cannot modify qualified source')
            require(not a.output.is_relative_to(a.run_root/'attempts') and not a.output.is_relative_to(a.run_root/'admitted'),'analysis output cannot modify raw evidence')
            scientific_analysis(a)

if __name__=='__main__':
    try:
        with ProcessScope(grace_seconds=5) as scope:
            main()
            scope.check()
    except (ExecutionStopped,AnalysisError,GateError,FileNotFoundError,FileExistsError,KeyError,ValueError) as exc:
        print('STOP_I06_NO_VALID_INTERPRETATION: '+str(exc),file=sys.stderr);raise SystemExit(2)
