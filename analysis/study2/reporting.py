"""Loss-count extraction and explicitly scoped descriptive resource summaries."""
from __future__ import annotations
import math
from typing import Any
import numpy as np
from statistics_core import ARMS, G, N, protocol, require, validate_counts

METRICS={
 'adaptation_apw_total':('resources','adaptation_apw_total'),
 'construction_apw_total':('resources','construction_apw_total'),
 'arm_process_cpu_ns':('process_cpu_ns_total',),
 'arm_elapsed_ns':('elapsed_ns_total',),
 'prediction_time_ns_total':('prediction_ns_total',),
 'reported_process_lifetime_peak_rss_bytes':('resources','max_reported_peak_rss_bytes'),
 'state_snapshot_bytes':('end_state','snapshot_bytes'),
 'provenance_event_bytes':('provenance','event_bytes'),
 'provenance_event_count':('provenance','event_count'),
}


def extract_loss_counts(records: list[dict]) -> np.ndarray:
    require(len(records)==G*N,'complete campaign required for extraction')
    scenario_ids=protocol()['scenario_ids'];seen=set()
    a=np.empty((G,N,2,2,3),dtype=np.int64)
    for record in records:
        require(record['partition']=='EXT' and record['identity']['partition']=='EXT','non-EXT record rejected')
        require(record['protocol_id']=='DT-I05-NST-v1.0','protocol mismatch in loss extraction')
        identity=record['identity'];scenario=identity['scenario_id'];r=identity['realisation']
        require(scenario in scenario_ids and type(r) is int and 0<=r<N,'invalid stream identity')
        pair=(scenario,r);require(pair not in seen,'duplicate extraction identity');seen.add(pair)
        g=scenario_ids.index(scenario)
        require([c['checkpoint'] for c in record['checkpoints']]==[10000,20000],'checkpoint pairing violated')
        for ci,cp in enumerate(record['checkpoints']):
            require(set(cp['state'])==set(ARMS),'arm set changed')
            for ai,arm in enumerate(ARMS):
                for hi,h in enumerate((500,2000)):
                    value=cp['state'][arm]['horizons'][str(h)]
                    n=value['loss_sum'];require(type(n) is int and 0<=n<=h,'invalid loss numerator')
                    require(value['predictions']==h and value['mean_loss']==n/h,'loss denominator/arithmetic mismatch')
                    a[g,r,ci,hi,ai]=n
    return validate_counts(a)


def extract_metric(obj: dict, keys: tuple[str,...]):
    value: Any=obj
    for key in keys:
        if not isinstance(value,dict) or key not in value:return None
        value=value[key]
    if value is None:return None
    require(type(value) in (int,float) and math.isfinite(value) and value>=0,'invalid resource measurement')
    return float(value)


def cluster_summary(values: dict[str,list[float|None]]) -> dict:
    observed={s:[v for v in rows if v is not None] for s,rows in values.items()}
    complete=all(len(v)==N for v in observed.values())
    means={s:math.fsum(v)/len(v) if v else None for s,v in observed.items()}
    available=math.fsum(means.values())/G if all(v is not None for v in means.values()) else None
    return {'scheduled_streams':G*N,'observed_streams':sum(map(len,observed.values())),
            'complete_target_coverage':complete,'equal_scenario_full_target_mean':available if complete else None,
            'available_case_equal_scenario_mean_not_full_target':available if not complete else None,
            'observed_streams_by_scenario':{s:len(v) for s,v in observed.items()},'scenario_means':means}


def resource_summary(records: list[dict]) -> dict:
    require(len(records)==G*N,'partial resource aggregation is forbidden')
    scenarios=protocol()['scenario_ids'];results={};failures={}
    for metric,keys in METRICS.items():
        by_arm={a:{s:[None]*N for s in scenarios} for a in ARMS}
        for record in records:
            s=record['identity']['scenario_id'];r=record['identity']['realisation']
            for arm in ARMS:
                vals=[]
                for c in record['checkpoints']:
                    obj=c['state'][arm]
                    v=extract_metric(obj,keys)
                    if metric=='state_snapshot_bytes' and not obj['end_state']['state_available']:v=None
                    vals.append(v)
                by_arm[arm][s][r]=math.fsum(vals)/2 if all(v is not None for v in vals) else None
        comparisons={}
        if metric!='reported_process_lifetime_peak_rss_bytes':
            for name,left,right in [('J1_policy_resource_increment',ARMS[0],ARMS[1]),('J2_policy_resource_increment',ARMS[1],ARMS[2])]:
                paired={s:[None if x is None or y is None else x-y for x,y in zip(by_arm[left][s],by_arm[right][s])] for s in scenarios}
                comparisons[name]=cluster_summary(paired)
        results[metric]={'arm_cluster_summaries':{a:cluster_summary(v) for a,v in by_arm.items()},
                         'paired_stream_difference_summaries':comparisons,
                         'causal_arm_specific_rss_comparison_permitted':False if metric=='reported_process_lifetime_peak_rss_bytes' else None}
    for arm in ARMS:
        table={}
        for record in records:
            for c in record['checkpoints']:
                status=c['state'][arm]['status'];table[status]=table.get(status,0)+1
        failures[arm]=table
    return {'status':'DESCRIPTIVE_SCOPED_RESOURCE_SUMMARIES_NOT_DECISION_ECONOMICS',
            'checkpoint_values_averaged_within_stream':True,'units_are_stream_clusters':True,
            'metrics':results,'checkpoint_arm_status_counts':failures,
            'limits':['Reported RSS is a shared-process lifetime high-water report, not an isolated arm-specific peak.',
                      'Prediction time is a total, not a latency distribution; no latency percentile is invented.',
                      'Construction and adaptation APW fields are not silently summed; their scopes remain distinct.',
                      'No missing state/provenance measurement is silently replaced by zero or given a full-target mean.',
                      'No currency conversion, resource-budget optimisation or I07 conclusion is performed.',
                      'Source materialisation CPU and elapsed measurements are not separately available; parent reports remain in raw records.']}
