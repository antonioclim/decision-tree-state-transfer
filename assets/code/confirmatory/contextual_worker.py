"""One trusted model process for the Phase 10N resource-supervision contract.

The worker receives one row at a time. It does not open source tapes. Stressors
consume real resources but are deliberately constructed software probes, not River.
This process boundary is not a sandbox for hostile code.
"""
from __future__ import annotations
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time

MAX_LINE = 16384

def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj

def decode(data):
    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise ValueError('duplicate key')
            out[k] = v
        return out
    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))

def stress(kind):
    if kind == 'CPU_BUSY':
        value = 1
        while True:
            value = (value * 1664525 + 1013904223) & 0xffffffff
    if kind == 'RSS_GROW':
        retained = []
        while True:
            block = bytearray(4 * 1024**2)
            # Touch every page; do not confuse address reservation with resident use.
            block[::4096] = b'x' * (len(block)//4096)
            retained.append(block)
            time.sleep(0.003)
    if kind == 'WALL_STALL':
        time.sleep(60)
    if kind == 'UNCLASSIFIED_ERROR':
        raise RuntimeError('deliberate unclassified worker exception')
    if kind == 'ABRUPT_EXIT':
        os._exit(7)
    if kind == 'OVERSIZED_REPLY':
        sys.stdout.buffer.write(b'x' * (MAX_LINE + 1) + b'\n')
        sys.stdout.buffer.flush()
        time.sleep(60)

def main():
    try:
        config = decode(sys.argv[1])
        if config['kind'] == 'RIVER':
            adapter = load('river_adapter_child', Path(__file__).with_name('river-context-v2.py'))
            model, metadata = adapter.build_model(config['method'], config['seed'])
        elif config['kind'] == 'REFERENCE':
            if config['method'] not in ('LAST_LABEL', 'PREFIX_MAJORITY'):
                raise ValueError('reference cannot impersonate River')
            model = None
            metadata = {'implementation': 'ELEMENTARY_PROCESS_REFERENCE_NOT_RIVER', 'method': config['method']}
        else:
            raise ValueError('unknown worker implementation')
        sys.stdout.buffer.write(encode({'kind': 'ready', 'pid': os.getpid(), 'model': metadata}))
        sys.stdout.buffer.flush()
        learned = 0
        counts = [0, 0]
        last = None
        sequence = 0
        while line := sys.stdin.buffer.readline(MAX_LINE+1):
            if len(line) > MAX_LINE or not line.endswith(b'\n'):
                raise ValueError('bounded canonical request required')
            request = decode(line)
            if set(request) != {'seq','stage','index','x','y'}:
                raise ValueError('request fields')
            sequence += 1
            if (type(request['seq']) is not int or request['seq'] != sequence
                    or type(request['index']) is not int or request['index'] != learned+1
                    or request['stage'] not in ('predict','learn')
                    or type(request['x']) is not dict or set(request['x']) != {f'x{i}' for i in range(8)}
                    or any(type(v) not in (int,float) or not math.isfinite(v) for v in request['x'].values())):
                raise ValueError('request identity or numeric input')
            stage = request['stage']
            if stage == 'predict' and request['y'] is not None:
                raise ValueError('prediction must not contain label')
            if stage == 'learn' and (type(request['y']) is not int or request['y'] not in (0,1)):
                raise ValueError('learning requires a binary label')
            trigger = config['stress']
            if trigger and trigger['index'] == request['index'] and trigger['stage'] == stage:
                stress(trigger['kind'])
            if stage == 'predict':
                prediction = model.predict_one(request['x']) if model is not None else (
                    last if config['method'] == 'LAST_LABEL' else int(counts[1] > counts[0]))
                if prediction is not None and (type(prediction) is not int or prediction not in (0,1)):
                    raise ValueError('unsupported prediction')
                result = prediction
            else:
                if model is not None:
                    model.learn_one(request['x'],request['y'])
                counts[request['y']] += 1
                last = request['y']
                learned += 1
                result = None
            sys.stdout.buffer.write(encode({'kind':'reply','seq':sequence,'result':result}))
            sys.stdout.buffer.flush()
        return 0
    except Exception as exc:
        # Arbitrary exceptions never assert that a resource limit was measured.
        try:
            sys.stdout.buffer.write(encode({'kind':'error','type':type(exc).__name__,'message':str(exc)[:1000]}))
            sys.stdout.buffer.flush()
        except OSError:
            pass
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
