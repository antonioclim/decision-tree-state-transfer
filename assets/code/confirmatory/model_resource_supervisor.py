"""Linux parent-observed resource limits for a fixed, trusted model worker.

CPU covers the observed owned tree after the ready handshake, including IPC.
RSS is the sampled sum from smaps_rollup. Neither limit is hard/pre-emptive, whole-host,
or a comparative evolutionary update budget. Wall timeouts and unknown exits
invalidate attempts; only a parent-observed crossing raises RESOURCE_LIMIT.
"""
from __future__ import annotations
import gzip
import importlib.util
import json
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

_SPEC = importlib.util.spec_from_file_location('resource_lifecycle', Path(__file__).with_name('contextual_lifecycle.py'))
life = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(life)
_OWN_SPEC = importlib.util.spec_from_file_location('model_process_ownership', Path(__file__).with_name('process_ownership.py'))
ownership = importlib.util.module_from_spec(_OWN_SPEC)
_OWN_SPEC.loader.exec_module(ownership)
MAX_REPLY = 16384
CONFIG_FIELDS = {'kind','method','seed','stress'}
POLICY_FIELDS = {'cpu_ns','rss_bytes','poll_ms','request_wall_ms','startup_wall_ms'}
STRESSES = ('CPU_BUSY','RSS_GROW','WALL_STALL','UNCLASSIFIED_ERROR','ABRUPT_EXIT','OVERSIZED_REPLY')

class SupervisorIntegrityError(RuntimeError):
    """Not eligible for all-loss-one imputation."""

class ProcessObservationEnded(SupervisorIntegrityError):
    """A procfs record disappeared; a checked pidfd must confirm descendant exit."""

class MeasuredResourceFailure(life.DeclaredModelFailure):
    def __init__(self, evidence):
        self.evidence = evidence
        super().__init__('RESOURCE_LIMIT')

def validate(config, policy):
    if type(config) is not dict or set(config) != CONFIG_FIELDS:
        raise ValueError('exact worker configuration required')
    if type(policy) is not dict or set(policy) != POLICY_FIELDS:
        raise ValueError('exact resource policy required')
    if config['kind'] not in ('REFERENCE','RIVER','R06_DIAGNOSTIC'):
        raise ValueError('unknown worker kind')
    allowed = {'REFERENCE':('LAST_LABEL','PREFIX_MAJORITY'),
               'RIVER':('HAT','ARF','SRP','SRP_NATIVE_022'),
               'R06_DIAGNOSTIC':('LAST_LABEL','PREFIX_MAJORITY','FROZEN_CART','ROLLING_CART')}[config['kind']]
    if config['method'] not in allowed or type(config['seed']) is not int or not 0 <= config['seed'] < 2**64:
        raise ValueError('invalid model identity')
    stress = config['stress']
    if stress is not None:
        if (config['kind'] != 'REFERENCE' or type(stress) is not dict
                or set(stress) != {'kind','index','stage'} or stress['kind'] not in STRESSES
                or type(stress['index']) is not int or not 1 <= stress['index'] <= 26000
                or stress['stage'] not in ('predict','learn')
                or stress['stage']=='predict' and stress['index']<=2000):
            raise ValueError('controlled stressors cannot be River')
    limits = {'cpu_ns':(1_000_000,3_600_000_000_000),'rss_bytes':(8*1024**2,2*1024**3),
              'poll_ms':(1,100),'request_wall_ms':(100,60000),'startup_wall_ms':(100,60000)}
    for k,(low,high) in limits.items():
        if type(policy[k]) is not int or not low <= policy[k] <= high:
            raise ValueError('invalid exact resource bound: '+k)
    return life.bridge._json(life.canonical(config)), life.bridge._json(life.canonical(policy))

def parse_proc(stat_text, smaps_text, hz):
    """Parse fields by their documented positions; comm may contain parentheses."""
    if type(hz) is not int or hz <= 0:
        raise ValueError('positive kernel clock rate required')
    end = stat_text.rfind(')')
    if end < 0:
        raise SupervisorIntegrityError('invalid process stat')
    fields = stat_text[end+1:].split()
    try:
        ticks = int(fields[11])+int(fields[12])
        birth = int(fields[19])
        state = fields[0]
    except (IndexError,ValueError) as exc:
        raise SupervisorIntegrityError('truncated process stat') from exc
    rss = [x.split() for x in smaps_text.splitlines() if x.startswith('Rss:')]
    if len(rss)!=1 or len(rss[0])!=3 or rss[0][2]!='kB':
        raise SupervisorIntegrityError('missing or ambiguous smaps RSS')
    try:
        memory = int(rss[0][1])*1024
    except ValueError as exc:
        raise SupervisorIntegrityError('invalid RSS') from exc
    if ticks < 0 or birth < 0 or memory <= 0 or state in ('Z','X'):
        raise SupervisorIntegrityError('process unavailable or invalid counters')
    return {'cpu_ticks':ticks,'start_ticks':birth,'rss_bytes':memory}

def read_process(pid, hz, *, proc_visible=False):
    try:
        if not proc_visible:
            pid = ownership.proc_pid_for_local(pid)
        root=Path('/proc')/str(pid)
        stat_text=(root/'stat').read_text()
        if stat_text.rsplit(')',1)[1].split()[0] in ('Z','X'):
            raise ProcessObservationEnded('kernel process record is exited')
        smaps=(root/'smaps_rollup').read_text()
        parsed=parse_proc(stat_text,smaps,hz)
        # Prevent accepting a replaced process identity between the two reads.
        birth2=(root/'stat').read_text().rsplit(')',1)[1].split()[19]
        if int(birth2)!=parsed['start_ticks']:
            raise SupervisorIntegrityError('process identity changed during sample')
        return parsed
    except (FileNotFoundError,ProcessLookupError) as exc:
        raise ProcessObservationEnded('kernel process record disappeared') from exc
    except (OSError,ValueError,IndexError) as exc:
        raise SupervisorIntegrityError('kernel process sample unavailable') from exc

def reason_for(sample,policy):
    if sample['cpu_ns'] >= policy['cpu_ns']:
        return 'CPU_LIMIT'
    if sample['rss_bytes'] >= policy['rss_bytes']:
        return 'RSS_LIMIT'
    return None


CPU_SCOPE = ('sampled owned-tree cumulative CPU since ready including IPC and reaped children; '
             'ancestor-first sampled lower bound, monotone observed maximum at kernel tick resolution; '
             'not evolutionary update allowance')
MEASUREMENT_SOURCE = 'parent reads namespace-mapped Linux proc stat, smaps_rollup and child rusage'


def constructor_identity(config, policy, metadata, *, worker_sha256=None, runtime=None, legacy=False):
    result = {'worker': config, 'model': metadata, 'resource_policy': policy,
              'worker_source_sha256': worker_sha256 or life.sha(Path(__file__).with_name('contextual_worker.py').read_bytes()),
              'CPU_scope': CPU_SCOPE, 'measurement_source': MEASUREMENT_SOURCE,
              'not_hostile_code_sandbox': True}
    if legacy:
        result.update(CPU_scope='child cumulative since ready including IPC; not evolutionary update allowance',
                      measurement_source='parent reads Linux proc stat and smaps_rollup')
    if runtime is not None:
        result['admitted_runtime_sha256'] = runtime
    return result

class ObservedProcessModel:
    """A persistent row-wise worker; no user-supplied runner or success callback."""
    def __init__(self, config, policy, output, *, admitted_runtime=None, capability_probe=False, diagnostic_runtime=None,
                 trajectory_profile='R06_2500'):
        self.config,self.policy=validate(config,policy)
        if trajectory_profile not in ('R06_2500', 'R08A_DEV_22000'):
            raise ValueError('unsupported trajectory profile')
        if trajectory_profile == 'R08A_DEV_22000' and (capability_probe or self.config['stress'] is not None
                or self.config['kind'] not in ('RIVER', 'R06_DIAGNOSTIC')
                or self.config['kind'] == 'RIVER' and admitted_runtime is None):
            raise ValueError('R08A requires a genuine admitted DEV worker, never a capability or stress fixture')
        if sys.platform!='linux':
            raise SupervisorIntegrityError('Linux procfs measurement required')
        if admitted_runtime is not None and (self.config['kind'] != 'RIVER' or type(admitted_runtime) is not dict
                or set(admitted_runtime) != {'path', 'sha256'}):
            raise ValueError('exact admitted River runtime identity required')
        if self.config['method'] == 'SRP_NATIVE_022' and admitted_runtime is None:
            raise ValueError('native SRP requires the versioned admitted runtime')
        if type(capability_probe) is not bool or capability_probe and admitted_runtime is None:
            raise ValueError('capability probe requires an admitted River runtime')
        if (self.config['kind']=='R06_DIAGNOSTIC') != (diagnostic_runtime is not None):
            raise ValueError('diagnostic worker requires an explicit pinned Node runtime')
        if diagnostic_runtime is not None:
            if (type(diagnostic_runtime) is not dict or set(diagnostic_runtime)!={'node_path','node_sha256','worker_sha256'}
                    or admitted_runtime is not None):
                raise ValueError('exact Node diagnostic runtime identity required')
            node=Path(diagnostic_runtime['node_path'])
            diagnostic_worker=Path(__file__).with_name('r06_diagnostic_worker.mjs')
            if (not node.is_absolute() or not node.is_file()
                    or life.sha(node.read_bytes())!=diagnostic_runtime['node_sha256']
                    or life.sha(diagnostic_worker.read_bytes())!=diagnostic_runtime['worker_sha256']):
                raise ValueError('pinned diagnostic executable or source differs')
        self.output=Path(output)
        self.hz=int(os.sysconf('SC_CLK_TCK'))
        self.seq=0;self.learned=0;self.predicted=0;self.failed=False;self.trip=None;self.closed=False
        self.samples=0;self.last_ticks=0;self.raw_bytes=0;self.rows=0
        self.digest=life.hashlib.sha256()
        self.proc=None;self.selector=None;self.buffer=bytearray()
        self.raw=None;self.tape=None;self.err=None;self.owner=None
        self.runtime_module=None;self.prepared_runtime=None;self.runtime_receipt=None
        self.cleanup_receipt=None;self.status='STARTUP_INVALIDATED'
        worker=Path(__file__).with_name('contextual_worker.py')
        self.worker_sha256=life.sha(worker.read_bytes())
        try:
            self.owner=ownership.Ownership()
            self.reaped_baseline=ownership.reaped_ticks(self.hz)
            self.output.mkdir(exist_ok=False)
            self.raw=(self.output/'resources.jsonl.gz').open('xb')
            self.tape=gzip.GzipFile(filename='',fileobj=self.raw,mode='wb',mtime=0)
            self.err=(self.output/'worker.stderr').open('xb')
            command=[sys.executable,'-I','-B',str(worker),life.canonical(self.config).decode()]
            environment=None
            if admitted_runtime is not None:
                spec=importlib.util.spec_from_file_location('admitted_worker_runtime',Path(__file__).with_name('r06_runtime.py'))
                self.runtime_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.runtime_module)
                self.prepared_runtime=self.runtime_module.prepare_worker(admitted_runtime['path'],admitted_runtime['sha256'],self.config,self.output,
                    capability_probe=capability_probe, trajectory_profile=trajectory_profile)
                command=self.prepared_runtime['command'];environment=self.prepared_runtime['env']
                self.worker_sha256=life.sha(Path(command[4]).read_bytes())
            elif diagnostic_runtime is not None:
                command=[str(node),str(diagnostic_worker),life.canonical({**self.config,'seed':str(self.config['seed'])}).decode()]
                if trajectory_profile == 'R08A_DEV_22000':
                    command.append('--r08a-dev-22000')
                self.worker_sha256=diagnostic_runtime['worker_sha256']
                environment={key:value for key,value in os.environ.items() if key not in ('NODE_OPTIONS','NODE_PATH')}
            self.proc=subprocess.Popen(command, env=environment,
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.err,bufsize=0,start_new_session=True)
            self.owner.attach(self.proc)
            os.set_blocking(self.proc.stdout.fileno(),False)
            self.selector=selectors.DefaultSelector()
            self.selector.register(self.proc.stdout,selectors.EVENT_READ)
            ready=self._read_reply(self.policy['startup_wall_ms'],None)
            if set(ready)!= {'kind','pid','model'} or ready['kind']!='ready' or ready['pid']!=self.proc.pid:
                raise SupervisorIntegrityError('worker did not complete genuine construction')
            self.initial=self._tree_sample()
            self.last_ticks=self.initial['cpu_ticks']
            self.constructor=constructor_identity(self.config,self.policy,ready['model'],worker_sha256=self.worker_sha256,
                runtime=None if admitted_runtime is None else admitted_runtime['sha256'])
            if diagnostic_runtime is not None:
                self.constructor.update(diagnostic_runtime=diagnostic_runtime,
                    node_environment_policy='NODE_OPTIONS_AND_NODE_PATH_REMOVED_FROM_INHERITED_ENVIRONMENT')
            self._emit({'kind':'start','schema_version':2,'pid':self.proc.pid,'hz':self.hz,
                        'initial':self.initial,'config':self.config,'policy':self.policy,
                        'worker_source_sha256':self.worker_sha256,
                        'owner_namespace_pids':self.owner.ids})
        except BaseException:
            self.close('STARTUP_INVALIDATED')
            raise

    def _tree_sample(self):
        """Read reaped totals, then ancestors before descendants: no wait double count.

        Discovery is for identity/ordering only. CPU counters are re-read in this
        order. A child already included in an ancestor's waited-child counter
        cannot also have a matching later stat. Vanished descendants contribute
        no new term; the next sample observes their parent's retained CPU.
        """
        try:
            owned=self.owner.discover()
            root=self.owner.handles[0]
            if root['proc_pid'] not in owned or owned[root['proc_pid']]['start_ticks'] != root['start_ticks']:
                raise SupervisorIntegrityError('worker no longer has its checked procfs identity')
            if owned[root['proc_pid']]['state'] in ('Z','X'):
                raise SupervisorIntegrityError('worker exited before resource sampling')
            reaped=ownership.reaped_ticks(self.hz)-self.reaped_baseline
            def depth(pid):
                seen=set();count=0
                while pid in owned:
                    if pid in seen:raise SupervisorIntegrityError('cyclic owned process ancestry')
                    seen.add(pid);pid=owned[pid]['parent'];count+=1
                return count
            processes=[]
            for pid, identity in sorted(owned.items(),key=lambda pair:(depth(pair[0]),pair[0])):
                try:
                    info=ownership.stat_info((Path('/proc')/str(pid)/'stat').read_text())
                except (FileNotFoundError,ProcessLookupError):
                    if pid==root['proc_pid']:raise SupervisorIntegrityError('worker disappeared during sample')
                    continue
                if info['start_ticks']!=identity['start_ticks']:
                    raise SupervisorIntegrityError('owned PID changed during ordered sample')
                if pid==root['proc_pid'] and info['state'] in ('Z','X'):
                    raise SupervisorIntegrityError('worker exited during ordered resource sample')
                handle=next((item for item in self.owner.handles if item['proc_pid']==pid and item['start_ticks']==info['start_ticks']),None)
                if handle is None:
                    raise SupervisorIntegrityError('owned process has no checked pidfd')
                rss=0
                if info['state'] not in ('Z','X'):
                    try:
                        measured=read_process(pid,self.hz,proc_visible=True)
                        if measured['start_ticks'] != info['start_ticks']:
                            raise SupervisorIntegrityError('owned process identity changed during sample')
                        rss=measured['rss_bytes']
                    except ProcessObservationEnded:
                        # smaps may disappear a few scheduling instants before
                        # pidfd readiness. Confirm this exact descendant's exit;
                        # permission/counter errors never enter this branch.
                        if pid==root['proc_pid'] or handle['fd'] is not None and not self.owner.exited(handle['fd'],self.policy['poll_ms']):
                            raise
                        info['state']='X'
                processes.append({**info,'proc_pid':pid,'namespace_pid':handle['namespace_pid'],'rss_bytes':rss})
            observed=reaped+sum(item['cpu_ticks'] for item in processes)
            return {'cpu_ticks':max(self.last_ticks,observed),'observed_cpu_ticks':observed,
                    'reaped_cpu_ticks':reaped,'start_ticks':root['start_ticks'],
                    'rss_bytes':sum(item['rss_bytes'] for item in processes),'processes':processes}
        except (OSError,ValueError,IndexError) as exc:
            raise SupervisorIntegrityError('owned process-tree sample unavailable') from exc

    def _emit(self,event):
        data=life.canonical(event)
        if len(data)>65536 or self.raw_bytes+len(data)>256*1024**2:
            raise SupervisorIntegrityError('resource transcript bound exceeded')
        if self.tape.write(data)!=len(data):
            raise OSError('short resource transcript write')
        self.digest.update(data);self.raw_bytes+=len(data);self.rows+=1

    def _sample(self, phase, request):
        value=self._tree_sample()
        if value['start_ticks']!=self.initial['start_ticks'] or value['cpu_ticks']<self.last_ticks:
            raise SupervisorIntegrityError('worker identity or cumulative CPU regressed')
        self.last_ticks=value['cpu_ticks']
        value.update(kind='sample',phase=phase,seq=request['seq'],index=request['index'],stage=request['stage'],
                     cpu_ns=(value['cpu_ticks']-self.initial['cpu_ticks'])*1_000_000_000//self.hz)
        self.samples+=1
        self._emit(value)
        reason=reason_for(value,self.policy)
        if reason is not None:
            self.trip={'kind':'trip','reason':reason,'seq':request['seq'],'index':request['index'],
                       'stage':request['stage'],'sample_number':self.samples,'sample':value}
            self._emit(self.trip)
            self.failed=True
            # Record the crossing before terminating/reaping; arbitrary exits alone do not imply it.
            self.close('MEASURED_RESOURCE_TRIP')
            raise MeasuredResourceFailure(self.trip)
        return value

    def _read_reply(self,wall_ms,request):
        deadline=time.monotonic()+wall_ms/1000
        while True:
            if b'\n' in self.buffer:
                row,tail=self.buffer.split(b'\n',1)
                self.buffer=bytearray(tail)
                if self.buffer or len(row)+1>MAX_REPLY:
                    raise SupervisorIntegrityError('unsolicited or oversized worker reply')
                try:
                    result=life.bridge._json(row+b'\n')
                except (ValueError,UnicodeError) as exc:
                    raise SupervisorIntegrityError('malformed worker reply') from exc
                if type(result) is not dict or result.get('kind')=='error':
                    raise SupervisorIntegrityError('worker exception: '+str(result)[:1200])
                return result
            if len(self.buffer)>=MAX_REPLY:
                raise SupervisorIntegrityError('worker reply exceeds byte bound')
            remaining=deadline-time.monotonic()
            if remaining <= 0:
                raise SupervisorIntegrityError('request wall watchdog expired without a measured resource crossing')
            events=self.selector.select(min(self.policy['poll_ms']/1000,remaining))
            if events:
                block=os.read(self.proc.stdout.fileno(),MAX_REPLY+1-len(self.buffer))
                if not block:
                    raise SupervisorIntegrityError('worker exited without a valid reply')
                self.buffer.extend(block)
            elif self.proc.poll() is not None:
                raise SupervisorIntegrityError('unexpected worker exit')
            if request is not None and not b'\n' in self.buffer:
                self._sample('waiting',request)

    def _call(self,stage,x,y):
        if self.closed or self.failed:
            raise SupervisorIntegrityError('model call after terminal closure')
        if type(x) is not dict or set(x)!={f'x{i}' for i in range(8)} or any(
                type(v) not in (int,float) or not math.isfinite(v) for v in x.values()):
            raise ValueError('eight finite input features required')
        if stage=='learn' and (type(y) is not int or y not in (0,1)):
            raise ValueError('binary label required')
        self.seq+=1
        request={'seq':self.seq,'stage':stage,'index':self.learned+1,'x':x,'y':y}
        encoded=life.canonical(request)
        if len(encoded)>4096:
            raise ValueError('request exceeds atomic pipe-write bound')
        try:
            self._emit({'kind':'call','seq':self.seq,'stage':stage,'index':request['index'],
                        'request_sha256':life.sha(encoded)})
            self._sample('before',request)
            if os.write(self.proc.stdin.fileno(),encoded)!=len(encoded):
                raise SupervisorIntegrityError('short IPC request')
            result=self._read_reply(self.policy['request_wall_ms'],request)
            self._sample('after',request)
            if set(result)!={'kind','seq','result'} or result['kind']!='reply' or type(result['seq']) is not int or result['seq']!=self.seq:
                raise SupervisorIntegrityError('reply identity differs')
            prediction=result['result']
            if stage=='learn' and prediction is not None or stage=='predict' and (
                    prediction is not None and (type(prediction) is not int or prediction not in (0,1))):
                raise SupervisorIntegrityError('invalid model result')
            self._emit({'kind':'reply','seq':self.seq,'result':prediction})
            if stage=='learn':
                self.learned+=1
            else:
                self.predicted+=1
            return prediction
        except MeasuredResourceFailure:
            raise
        except BaseException:
            self.close('INTEGRITY_INTERRUPTED')
            raise

    def predict_one(self,x):
        return self._call('predict',x,None)

    def learn_one(self,x,y):
        self._call('learn',x,y)

    def close(self,status='CLEAN_SHUTDOWN'):
        if self.closed:
            return
        requested_status=status
        self.closed=True
        close_error=None
        try:
            if self.proc is not None:
                if status=='CLEAN_SHUTDOWN' and self.proc.stdin:
                    self.proc.stdin.close()
                    try:
                        self.proc.wait(timeout=max(1,self.policy['startup_wall_ms']/1000))
                    except subprocess.TimeoutExpired:
                        status='INTEGRITY_INTERRUPTED'
                self.cleanup_receipt=self.owner.cleanup()
                if (not self.cleanup_receipt['cleanup_verified'] or self.cleanup_receipt['errors']
                        or status=='CLEAN_SHUTDOWN' and (self.proc.returncode!=0 or self.cleanup_receipt['signals_sent'])):
                    status='INTEGRITY_INTERRUPTED'
                if self.prepared_runtime is not None:
                    try:
                        self.runtime_receipt=self.runtime_module.finish_worker(self.prepared_runtime,
                            allow_incomplete=status!='CLEAN_SHUTDOWN')
                        if status=='CLEAN_SHUTDOWN' and (
                                self.runtime_receipt['worker']['learn_calls']!=self.learned
                                or self.runtime_receipt['worker']['prediction_calls']!=self.predicted):
                            raise SupervisorIntegrityError('runtime terminal counts differ from parent-observed IPC')
                    except BaseException as error:
                        status='INTEGRITY_INTERRUPTED';close_error=error
                self._emit({'kind':'closed','status':status,'returncode':self.proc.returncode,'calls':self.seq,
                            'cleanup':self.cleanup_receipt})
                for pipe in (self.proc.stdin,self.proc.stdout):
                    if pipe and not pipe.closed: pipe.close()
            elif self.owner is not None:
                self.owner.restore()
            self.status=status
        except BaseException as error:
            self.status='INTEGRITY_INTERRUPTED'
            close_error=error
        finally:
            if self.owner is not None and not self.owner.restored:
                try:
                    self.cleanup_receipt=self.owner.cleanup() if self.proc is not None else None
                    if self.proc is None:self.owner.restore()
                except BaseException as error:
                    self.status='INTEGRITY_INTERRUPTED';close_error=error
            if self.proc is not None:
                for pipe in (self.proc.stdin,self.proc.stdout):
                    if pipe and not pipe.closed:
                        try:pipe.close()
                        except BaseException as error:
                            self.status='INTEGRITY_INTERRUPTED';close_error=error
            if self.selector: self.selector.close()
            for handle in (self.tape,self.raw,self.err):
                if handle is not None:
                    try:handle.close()
                    except BaseException as error:
                        self.status='INTEGRITY_INTERRUPTED';close_error=error
        if self.status=='INTEGRITY_INTERRUPTED':
            # Callers may be unwinding an earlier exception. The outer publication
            # gate checks this status and cannot publish COMPLETE.
            self.failed=True
        if close_error is not None:
            raise SupervisorIntegrityError('worker closure or evidence storage invalidated') from close_error
        if requested_status=='MEASURED_RESOURCE_TRIP' and self.status!='MEASURED_RESOURCE_TRIP':
            raise SupervisorIntegrityError('resource crossing did not establish admissible cleanup')

    def receipt(self):
        if not self.closed or self.status not in ('CLEAN_SHUTDOWN','MEASURED_RESOURCE_TRIP'):
            raise SupervisorIntegrityError('worker has not closed in an admissible state')
        zipped=(self.output/'resources.jsonl.gz').read_bytes()
        return {'schema_version':2,'status':self.status,'resource_rows':self.rows,'resource_raw_bytes':self.raw_bytes,
                'resource_raw_sha256':self.digest.hexdigest(),'resource_gzip_sha256':life.sha(zipped),
                'resource_gzip_bytes':len(zipped),'sample_count':self.samples,'trip':self.trip,
                'worker_returncode':self.proc.returncode,'calls':self.seq,'timing_authenticated':False,
                'hard_memory_or_CPU_limit':False,'whole_process_tree_accounted':True,
                'cleanup':self.cleanup_receipt,'runtime':self.runtime_receipt,
                'worker_source_sha256':self.worker_sha256}


def resource_events(data,audit):
    import io
    count=0;size=0;digest=life.hashlib.sha256()
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        while row:=stream.readline(65537):
            count+=1;size+=len(row)
            if len(row)>65536 or not row.endswith(b'\n') or count>500000 or size>256*1024**2:
                raise ValueError('resource transcript extent exceeded')
            event=life.bridge._json(row)
            if life.canonical(event)!=row:
                raise ValueError('noncanonical resource transcript')
            digest.update(row)
            yield event
    audit.update(event_rows=count,raw_bytes=size,raw_sha256=digest.hexdigest())

def _audit_resources_v1(directory, config, policy, receipt, *, normalise_events=None, worker_sha256=None):
    """Independent transcript arithmetic, not independent kernel measurement."""
    config,policy=validate(config,policy)
    receipt_fields={'status','resource_rows','resource_raw_bytes','resource_raw_sha256','resource_gzip_sha256',
                    'resource_gzip_bytes','sample_count','trip','worker_returncode','calls','timing_authenticated',
                    'hard_memory_or_CPU_limit','whole_process_tree_accounted'}
    if (type(receipt) is not dict or set(receipt)!=receipt_fields
            or any(receipt[k] is not False for k in ('timing_authenticated','hard_memory_or_CPU_limit','whole_process_tree_accounted'))
            or any(type(receipt[k]) is not int or not 0<=receipt[k]<2**63 for k in
                   ('resource_rows','resource_raw_bytes','resource_gzip_bytes','sample_count','calls'))
            or any(type(receipt[k]) is not str or not life.bridge.HASH.fullmatch(receipt[k])
                   for k in ('resource_raw_sha256','resource_gzip_sha256'))):
        raise ValueError('invalid resource receipt fields or unsupported assurance')
    path=Path(directory)/'resources.jsonl.gz'
    data=life.bridge._regular(path,64*1024**2)
    if life.sha(data)!=receipt['resource_gzip_sha256'] or len(data)!=receipt['resource_gzip_bytes']:
        raise ValueError('resource archive anchor differs')
    audit={}
    iterator=resource_events(data,audit)
    if normalise_events is not None:
        iterator=normalise_events(iterator)
    head=next(iterator,None)
    if (head is None or set(head)!= {'kind','schema_version','pid','hz','initial','config','policy','worker_source_sha256'}
            or head['kind']!='start' or head['schema_version']!=1 or head['config']!=config or head['policy']!=policy
            or type(head['hz']) is not int or head['hz']<=0
            or head['worker_source_sha256']!=(worker_sha256 or life.sha(Path(__file__).with_name('contextual_worker.py').read_bytes()))):
        raise ValueError('resource start identity')
    initial=head['initial']
    if (type(head['schema_version']) is not int or type(head['pid']) is not int or head['pid']<=0
            or type(initial) is not dict or set(initial)!={'cpu_ticks','start_ticks','rss_bytes'}
            or any(type(initial[k]) is not int or not 0<=initial[k]<2**63 for k in initial)
            or initial['rss_bytes']==0):
        raise ValueError('invalid kernel identity or baseline')
    ticks=initial['cpu_ticks'];samples=0;seq=0;active=None;last=None;trip=None;closed=None
    for event in iterator:
        kind=event.get('kind')
        if closed is not None:
            raise ValueError('events after resource closure')
        if kind=='call':
            if active is not None or trip is not None or set(event)!= {'kind','seq','stage','index','request_sha256'}:
                raise ValueError('invalid call chronology')
            if type(event['seq']) is not int or event['seq']!=seq+1 or type(event['index']) is not int or not 1<=event['index']<=26000 or event['stage'] not in ('learn','predict') or not life.bridge.HASH.fullmatch(event['request_sha256']):
                raise ValueError('invalid call fields')
            seq+=1;active=event;last=None
        elif kind=='sample':
            if (active is None or trip is not None or set(event)!= {'kind','phase','seq','index','stage','cpu_ns','cpu_ticks','start_ticks','rss_bytes'}
                    or any(event[k]!=active[k] for k in ('seq','index','stage'))
                    or event['phase'] not in ('before','waiting','after')
                    or any(type(event[k]) is not int or event[k]<0 for k in ('cpu_ns','cpu_ticks','start_ticks','rss_bytes'))
                    or event['rss_bytes']==0 or event['start_ticks']!=initial['start_ticks'] or event['cpu_ticks']<ticks
                    or event['cpu_ns']!=(event['cpu_ticks']-initial['cpu_ticks'])*1_000_000_000//head['hz']):
                raise ValueError('invalid measured sample')
            if last is None and event['phase']!='before' or last is not None and (event['phase']=='before' or last['phase']=='after' or reason_for(last,policy)):
                raise ValueError('invalid sample chronology')
            ticks=event['cpu_ticks'];samples+=1;last=event
        elif kind=='trip':
            if (trip is not None or last is None or set(event)!= {'kind','reason','seq','index','stage','sample_number','sample'}
                    or event['sample']!=last or event['sample_number']!=samples
                    or any(event[k]!=active[k] for k in ('seq','index','stage'))
                    or reason_for(last,policy) is None or event['reason']!=reason_for(last,policy)):
                raise ValueError('unsupported resource failure')
            trip=event
        elif kind=='reply':
            if active is None or trip is not None or last is None or last['phase']!='after' or reason_for(last,policy) or event.get('seq')!=seq or set(event)!= {'kind','seq','result'}:
                raise ValueError('reply after unsupported stop or without sample')
            val=event['result']
            if active['stage']=='learn' and val is not None or active['stage']=='predict' and val is not None and (type(val) is not int or val not in (0,1)):
                raise ValueError('invalid reply value')
            active=None
        elif kind=='closed':
            expected='MEASURED_RESOURCE_TRIP' if trip else 'CLEAN_SHUTDOWN'
            if (set(event)!= {'kind','status','returncode','calls'} or event['status']!=expected
                    or type(event['returncode']) is not int or type(event['calls']) is not int or event['calls']!=seq
                    or trip is None and (active is not None or event['returncode']!=0)
                    or trip is not None and event['returncode'] not in (-signal.SIGTERM,-signal.SIGKILL)):
                raise ValueError('invalid closure')
            closed=event
        else:
            raise ValueError('unexpected resource event')
    if closed is None or trip!=receipt['trip'] or samples!=receipt['sample_count'] or seq!=receipt['calls']:
        raise ValueError('resource summary mismatch')
    for name,expected in [('resource_rows',audit['event_rows']),('resource_raw_bytes',audit['raw_bytes']),('resource_raw_sha256',audit['raw_sha256'])]:
        if receipt[name]!=expected:raise ValueError('resource count/hash mismatch')
    if receipt['status']!=closed['status'] or receipt['worker_returncode']!=closed['returncode']:
        raise ValueError('false resource final status')
    return {'status':'PASS_RESOURCE_TRANSCRIPT_ARITHMETIC','samples':samples,'calls':seq,'trip':trip,
            'independent_clock_authentication':False}


def audit_resources(directory, config, policy, receipt):
    """Check schema-1 history or schema-2 namespace/tree arithmetic explicitly."""
    if type(receipt) is not dict or 'schema_version' not in receipt:
        return _audit_resources_v1(directory,config,policy,receipt)
    extra={'schema_version','cleanup','runtime','worker_source_sha256'}
    old_fields={'status','resource_rows','resource_raw_bytes','resource_raw_sha256','resource_gzip_sha256',
                'resource_gzip_bytes','sample_count','trip','worker_returncode','calls','timing_authenticated',
                'hard_memory_or_CPU_limit','whole_process_tree_accounted'}
    if (set(receipt)!=old_fields|extra or type(receipt['schema_version']) is not int or receipt['schema_version']!=2
            or receipt['whole_process_tree_accounted'] is not True or type(receipt['worker_returncode']) is not int):
        raise ValueError('unsupported current resource receipt')
    possible=[Path(__file__).with_name(name) for name in
              ('contextual_worker.py','r06_locked_worker.py','r06_diagnostic_worker.mjs')]
    permitted={life.sha(path.read_bytes()) for path in possible if path.is_file()}
    if receipt['worker_source_sha256'] not in permitted:
        raise ValueError('resource worker source differs')
    if receipt['runtime'] is not None:
        runtime=receipt['runtime']
        if (type(runtime) is not dict or runtime.get('scientific_admission') is not False
                or runtime.get('confirmation_authorised') is not False
                or type(runtime.get('worker_final_imports_verified')) is not bool
                or receipt['status']=='CLEAN_SHUTDOWN' and runtime['worker_final_imports_verified'] is not True):
            raise ValueError('unsupported runtime assurance')
    cleanup=receipt['cleanup']
    cleanup_fields={'cleanup_verified','survivors','known_live_namespace_pids','signals_sent','errors','signal_interface'}
    if (type(cleanup) is not dict or set(cleanup)!=cleanup_fields or cleanup['cleanup_verified'] is not True
            or cleanup['survivors']!=[] or cleanup['known_live_namespace_pids']!=[] or cleanup['errors']!=[]
            or cleanup['signal_interface']!='PIDFD' or type(cleanup['signals_sent']) is not list
            or receipt['status']=='CLEAN_SHUTDOWN' and cleanup['signals_sent']):
        raise ValueError('owned cleanup was not verified')
    for item in cleanup['signals_sent']:
        if (type(item) is not dict or set(item)!={'proc_pid','namespace_pid','start_ticks'}
                or any(type(value) is not int or value<=0 for value in item.values())):
            raise ValueError('invalid signal ownership identity')
    prior_ticks=None
    root_start=None
    root_pid=None
    root_proc_pid=None
    process_history={}

    def check_sample(value, initial=False):
        nonlocal prior_ticks,root_start,root_pid,root_proc_pid
        added={'observed_cpu_ticks','reaped_cpu_ticks','processes'}
        required={'cpu_ticks','start_ticks','rss_bytes'}|added
        if not initial:required|={'kind','phase','seq','index','stage','cpu_ns'}
        if type(value) is not dict or set(value)!=required:
            raise ValueError('invalid owned-tree sample fields')
        if any(type(value[k]) is not int or value[k]<0 for k in ('cpu_ticks','observed_cpu_ticks','reaped_cpu_ticks','start_ticks','rss_bytes')):
            raise ValueError('invalid owned-tree sample counter')
        if not initial and any(type(value[key]) is not int or value[key]<=0 for key in ('seq','index')):
            raise ValueError('invalid exact sample address')
        if type(value['processes']) is not list or not value['processes']:
            raise ValueError('missing owned process measurements')
        identities=set();proc_pids=set();namespace_pids=set();found_root=False
        positions={item.get('proc_pid'):index for index,item in enumerate(value['processes']) if type(item) is dict}
        for item in value['processes']:
            if (type(item) is not dict or set(item)!={'parent','start_ticks','cpu_ticks','state','proc_pid','namespace_pid','rss_bytes'}
                    or any(type(item[k]) is not int or not 0<=item[k]<2**63 for k in item if k!='state')
                    or item['proc_pid']<=0 or item['namespace_pid']<=0 or item['start_ticks']<=0
                    or type(item['state']) is not str or len(item['state'])!=1
                    or item['state'] in ('Z','X') and item['rss_bytes']!=0
                    or item['state'] not in ('Z','X') and item['rss_bytes']<=0):
                raise ValueError('invalid owned process row')
            identity=(item['proc_pid'],item['start_ticks'])
            if identity in identities or item['proc_pid'] in proc_pids or item['namespace_pid'] in namespace_pids:
                raise ValueError('duplicate concurrent process identity')
            if item['parent'] in positions and positions[item['parent']]>=positions[item['proc_pid']]:
                raise ValueError('resource processes are not in ancestor-first order')
            if item['cpu_ticks']<process_history.get(identity,0):
                raise ValueError('owned process cumulative CPU regressed')
            process_history[identity]=item['cpu_ticks']
            identities.add(identity);proc_pids.add(item['proc_pid']);namespace_pids.add(item['namespace_pid'])
            if item['namespace_pid']==root_pid and item['start_ticks']==root_start and item['state'] not in ('Z','X'):
                if root_proc_pid is None:root_proc_pid=item['proc_pid']
                elif root_proc_pid!=item['proc_pid']:raise ValueError('worker procfs identity changed')
                found_root=True
        raw=value['reaped_cpu_ticks']+sum(item['cpu_ticks'] for item in value['processes'])
        expected=raw if prior_ticks is None else max(prior_ticks,raw)
        if (not found_root or value['observed_cpu_ticks']!=raw or value['cpu_ticks']!=expected
                or value['rss_bytes']!=sum(item['rss_bytes'] for item in value['processes'])):
            raise ValueError('owned CPU/RSS arithmetic or worker identity differs')
        prior_ticks=expected
        return {key:item for key,item in value.items() if key not in added}

    original_trip=None
    original_sample=None
    def normalised(iterator):
        nonlocal root_start,root_pid,original_trip,original_sample
        for event in iterator:
            kind=event.get('kind')
            if kind=='start':
                if (set(event)!={'kind','schema_version','pid','hz','initial','config','policy','worker_source_sha256','owner_namespace_pids'}
                        or type(event['schema_version']) is not int or event['schema_version']!=2
                        or type(event['owner_namespace_pids']) is not list or not event['owner_namespace_pids']
                        or any(type(pid) is not int or pid<=0 for pid in event['owner_namespace_pids'])
                        or type(event['initial']) is not dict
                        or life.canonical(event['config'])!=life.canonical(config)
                        or life.canonical(event['policy'])!=life.canonical(policy)):
                    raise ValueError('invalid namespace-aware start')
                root_pid=event['pid'];root_start=event['initial'].get('start_ticks')
                converted={key:value for key,value in event.items() if key!='owner_namespace_pids'}
                converted.update(schema_version=1,initial=check_sample(event['initial'],True))
                yield converted
            elif kind=='sample':
                original_sample=event
                yield check_sample(event)
            elif kind=='trip':
                if any(type(event.get(key)) is not int or event[key]<=0 for key in ('seq','index','sample_number')):
                    raise ValueError('invalid exact trip address')
                if life.canonical(event.get('sample'))!=life.canonical(original_sample):
                    raise ValueError('full tree crossing differs from measured sample')
                original_trip=event
                # A trip repeats the preceding sample; do not advance the running maximum twice.
                sample={key:value for key,value in event['sample'].items()
                        if key not in {'observed_cpu_ticks','reaped_cpu_ticks','processes'}}
                yield {**event,'sample':sample}
            elif kind=='closed':
                if life.canonical(event.get('cleanup'))!=life.canonical(cleanup):
                    raise ValueError('resource cleanup transcript differs')
                yield {key:value for key,value in event.items() if key!='cleanup'}
            elif kind=='reply':
                if type(event.get('seq')) is not int or event['seq']<=0:
                    raise ValueError('invalid exact reply address')
                yield event
            else:
                yield event
    old={key:value for key,value in receipt.items() if key in old_fields}
    old['whole_process_tree_accounted']=False
    if old['trip'] is not None:
        old['trip']={**old['trip'],'sample':{key:value for key,value in old['trip']['sample'].items()
                    if key not in {'observed_cpu_ticks','reaped_cpu_ticks','processes'}}}
    result=_audit_resources_v1(directory,config,policy,old,normalise_events=normalised,
                              worker_sha256=receipt['worker_source_sha256'])
    if life.canonical(original_trip)!=life.canonical(receipt['trip']):
        raise ValueError('full measured trip differs')
    result.update(resource_schema_version=2,whole_process_tree_accounted=True,
                  cleanup_verified=True,trip=original_trip)
    return result
