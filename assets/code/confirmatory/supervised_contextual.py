"""Source-bound DEV lifecycle with externally observed process resource cutoffs.

The resource tape is produced by the supervising parent, not the model.
Conditional replay checks its arithmetic and the fixed source/model computation;
it does not independently remeasure the clock or natural failure frequency.
"""
from __future__ import annotations
import argparse
import gzip
import importlib.util
import json
import os
from pathlib import Path
import sys

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

sup=load('supervised_resource_contract',Path(__file__).with_name('model_resource_supervisor.py'))
life=sup.life

def same_json(actual, expected):
    """JSON identity preserves booleans, integers and floating-point numbers."""
    return life.canonical(actual) == life.canonical(expected)

def normalise(plan,config,policy):
    plan=life.validate_plan(plan);config,policy=sup.validate(config,policy)
    if plan['fault'] is not None or plan['method']!=config['method'] or plan['seed']!=config['seed']:
        raise ValueError('no synthetic exception injection; matching model identity required')
    expected=life.REFERENCE if config['kind']=='REFERENCE' else life.RIVER
    if plan['scope']!=expected:
        raise ValueError('model implementation and scope differ')
    if config['stress'] is not None and config['stress']['index']>plan['end']:
        raise ValueError('stress address outside source')
    return plan,config,policy

def _publish(path,obj):
    data=life.canonical(obj);pending=path.with_name('.'+path.name+'.pending')
    life._write_new(pending,data)
    os.link(pending,path);pending.unlink()

def record_supervised(directory,source_sha256,plan,config,policy,output):
    plan,config,policy=normalise(plan,config,policy)
    output=Path(output);output.mkdir(exist_ok=False)
    model=None
    try:
        # Genuine construction/availability precedes even creation of a source reader.
        model=sup.ObservedProcessModel(config,policy,output/'SUPERVISOR')
        source=life.bridge.SeparatedSource(Path(directory),source_sha256)
        result=life._record(source,model,model.constructor,plan,output/'RUN')
        model.close()
        resources=model.receipt()
        audit=sup.audit_resources(output/'SUPERVISOR',config,policy,resources)
        constructor=life.sha((output/'RUN/CONSTRUCTOR.json').read_bytes())
        receipt={'schema_version':1,'status':'VERIFIED_PROCESS_OBSERVATION_NOT_SCIENTIFIC_ADMISSION',
                 'plan':plan,'worker_config':config,'resource_policy':policy,'source_sha256':source_sha256,
                 'run_result_sha256':life.sha((output/'RUN/RESULT.json').read_bytes()),
                 'constructor_sha256':constructor,'resources':resources,
                 'supervisor_stderr_sha256':life.sha((output/'SUPERVISOR/worker.stderr').read_bytes()),
                 'actual_River_execution':config['kind']=='RIVER',
                 'controlled_workload':config['stress'] is not None,
                 'scientific_admission':False,'confirmation_authorised':False}
        _publish(output/'RESULT.json',receipt)
        return receipt
    except BaseException as exc:
        if model is not None:model.close('INTEGRITY_INTERRUPTED')
        try:life._write_new(output/'INTERRUPTED.json',life.canonical(
            {'status':'INTERRUPTED_NOT_ADMITTED','error_type':type(exc).__name__,'message':str(exc)[:1500],
             'scientific_admission':False,'confirmation_authorised':False}))
        except OSError:pass
        raise

class BoundaryReplayModel:
    """Reproduce the pre-failure model and stop at the externally verified address."""
    def __init__(self,model,trip):
        self.model=model;self.trip=trip;self.learned=0
    def boundary(self,stage):
        if self.trip and self.trip['index']==self.learned+1 and self.trip['stage']==stage:
            raise life.DeclaredModelFailure('RESOURCE_LIMIT')
    def predict_one(self,x):
        self.boundary('predict');return self.model.predict_one(x)
    def learn_one(self,x,y):
        self.boundary('learn');self.model.learn_one(x,y);self.learned+=1

def verify_supervised(directory,source_sha256,plan,config,policy,output,anchor):
    plan,config,policy=normalise(plan,config,policy)
    output=Path(output)
    expected={'RESULT.json','RUN','SUPERVISOR'}
    if not output.is_dir() or output.is_symlink() or {x.name for x in output.iterdir()}!=expected:
        raise ValueError('outer inventory or interrupted attempt')
    for sub,files in [('RUN',{'RESULT.json','events.jsonl.gz','PLAN.json','CONSTRUCTOR.json'}),
                      ('SUPERVISOR',{'resources.jsonl.gz','worker.stderr'})]:
        d=output/sub
        if d.is_symlink() or not d.is_dir() or {x.name for x in d.iterdir()}!=files:
            raise ValueError('nested inventory differs')
    filepaths=[p for p in output.rglob('*') if p.is_file()]
    before={str(p.relative_to(output)):life.sha(life.bridge._regular(p,64*1024**2)) for p in filepaths}
    raw=life.bridge._regular(output/'RESULT.json',1024**2)
    if not life.bridge.HASH.fullmatch(anchor or '') or life.sha(raw)!=anchor:
        raise ValueError('external receipt anchor differs')
    receipt=life.bridge._json(raw)
    fields={'schema_version','status','plan','worker_config','resource_policy','source_sha256','run_result_sha256',
            'constructor_sha256','resources','supervisor_stderr_sha256','actual_River_execution',
            'controlled_workload','scientific_admission','confirmation_authorised'}
    if (set(receipt)!=fields or type(receipt['schema_version']) is not int or receipt['schema_version']!=1
            or receipt['status']!='VERIFIED_PROCESS_OBSERVATION_NOT_SCIENTIFIC_ADMISSION'
            or not same_json(receipt['plan'],plan) or not same_json(receipt['worker_config'],config)
            or not same_json(receipt['resource_policy'],policy)
            or receipt['source_sha256']!=source_sha256
            or receipt['scientific_admission'] is not False or receipt['confirmation_authorised'] is not False
            or receipt['actual_River_execution'] is not (config['kind']=='RIVER')
            or receipt['controlled_workload'] is not (config['stress'] is not None)):
        raise ValueError('outer identity or premature admission')
    if before['RUN/RESULT.json']!=receipt['run_result_sha256'] or before['SUPERVISOR/worker.stderr']!=receipt['supervisor_stderr_sha256']:
        raise ValueError('child receipt binding')
    ar=sup.audit_resources(output/'SUPERVISOR',config,policy,receipt['resources'])
    if config['kind']=='REFERENCE':
        model=life.ReferenceModel(config['method'],None)
        metadata={'implementation':'ELEMENTARY_PROCESS_REFERENCE_NOT_RIVER','method':config['method']}
    else:
        adapter=load('real_adapter_verify',Path(__file__).with_name('river-context-v2.py'))
        model,metadata=adapter.build_model(config['method'],config['seed'])
    constructor=sup.constructor_identity(config,policy,metadata,legacy='schema_version' not in receipt['resources'])
    if (life.canonical(constructor)!=(output/'RUN/CONSTRUCTOR.json').read_bytes()
            or life.sha(life.canonical(constructor))!=receipt['constructor_sha256']
            or (output/'RUN/PLAN.json').read_bytes()!=life.canonical(plan)):
        raise ValueError('constructor or plan binding')
    replay=BoundaryReplayModel(model,ar['trip'])
    source=life.bridge.SeparatedSource(Path(directory),source_sha256)
    events_blob=life.bridge._regular(output/'RUN/events.jsonl.gz',life.MAX_GZIP)
    audit={}
    stored=life._archived_events(events_blob,life.MAX_RAW,audit)
    resource_audit={}
    tape=sup.resource_events((output/'SUPERVISOR/resources.jsonl.gz').read_bytes(),resource_audit)
    # Extract request digests and successful replies so a rehashed forged address
    # cannot bypass the computation/source check.
    calls=[e for e in tape if e['kind'] in ('call','reply')]
    request_events=iter(calls)
    class CheckedReplay:
        def __init__(self):self.learned=0;self.seq=0
        def call(self,stage,x,y):
            self.seq+=1
            req={'seq':self.seq,'stage':stage,'index':self.learned+1,'x':x,'y':y}
            got=next(request_events,None)
            wanted={'kind':'call','seq':self.seq,'stage':stage,'index':self.learned+1,
                    'request_sha256':life.sha(life.canonical(req))}
            if not same_json(got,wanted):raise ValueError('source-bound request differs')
            if stage=='predict':value=replay.predict_one(x)
            else:replay.learn_one(x,y);value=None
            reply=next(request_events,None)
            if not same_json(reply,{'kind':'reply','seq':self.seq,'result':value}):
                raise ValueError('source-bound IPC reply differs')
            if stage=='learn':self.learned+=1
            return value
        def predict_one(self,x):return self.call('predict',x,None)
        def learn_one(self,x,y):self.call('learn',x,y)
    complete=None
    for expected_event in life._events(source,CheckedReplay(),plan,receipt['constructor_sha256']):
        actual=next(stored,None)
        if not same_json(actual,expected_event):raise ValueError('source-bound failure lifecycle differs')
        if actual['kind']=='complete':complete=actual
    if next(stored,None) is not None or next(request_events,None) is not None:
        raise ValueError('extra runtime or worker records')
    rr=life.bridge._json((output/'RUN/RESULT.json').read_bytes())
    rr_fields={'schema_version','status','plan','source_sha256','constructor_sha256','completion','event_rows',
               'raw_bytes','raw_sha256','gzip_bytes','gzip_sha256','process_cpu_ns','elapsed_ns',
               'scientific_admission','confirmation_authorised'}
    if (set(rr)!=rr_fields or type(rr['schema_version']) is not int or rr['schema_version']!=1
            or any(type(rr[k]) is not int or not 0<=rr[k]<2**63 for k in
                   ('event_rows','raw_bytes','gzip_bytes','process_cpu_ns','elapsed_ns'))):
        raise ValueError('runtime exact field contract')
    if (not same_json(rr['completion'],complete) or rr['status']!=complete['status'] or not same_json(rr['plan'],plan)
            or rr['source_sha256']!=source_sha256 or rr['constructor_sha256']!=receipt['constructor_sha256']
            or rr['gzip_sha256']!=life.sha(events_blob) or rr['gzip_bytes']!=len(events_blob)
            or any(not same_json(rr[k],v) for k,v in audit.items())
            or rr['scientific_admission'] is not False or rr['confirmation_authorised'] is not False):
        raise ValueError('runtime totals or failure summary differs')
    after={str(p.relative_to(output)):life.sha(life.bridge._regular(p,64*1024**2)) for p in output.rglob('*') if p.is_file()}
    if before!=after:raise ValueError('attempt changed during verification')
    return {'status':'PASS_SOURCE_AND_MEASURED_CUTOFF_CONDITIONAL_REPLAY','receipt_sha256':anchor,
            'completion':complete,'resource_audit':ar,'event_rows':audit['event_rows'],
            'source_replayed':True,'clock_independently_authenticated':False,
            'new_resource_measurement':False,'scientific_admission':False,'confirmation_authorised':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--source-sha256',required=True)
    parser.add_argument('--spec',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--verify-sha256')
    args=parser.parse_args()
    spec=life.bridge._json(args.spec.read_bytes())
    try:
        func=verify_supervised if args.verify_sha256 else record_supervised
        values=[args.source,args.source_sha256,spec['plan'],spec['worker'],spec['policy'],args.output]
        if args.verify_sha256:values.append(args.verify_sha256)
        result=func(*values)
        print(json.dumps(result,allow_nan=False));return 0
    except Exception as exc:
        print(json.dumps({'status':'BLOCKED_OR_INTERRUPTED_NOT_ADMITTED','error_type':type(exc).__name__,
                          'message':str(exc),'confirmation_authorised':False}));return 2

if __name__=='__main__':raise SystemExit(main())
