#!/usr/bin/env python3
from __future__ import annotations
import json, shutil, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
node=shutil.which('node')
if node is None: raise SystemExit('Node.js is required for the Study 2 public reproduction check.')
input_file=ROOT/'data/study2/analysis/REPRODUCTION_INPUT.json'
draws=ROOT/'data/study2/analysis/draws'
expected_file=ROOT/'data/study2/analysis/INDEPENDENT_NODE_REPRODUCTION.json'
with tempfile.TemporaryDirectory() as td:
    out=Path(td)/'reproduction.json'
    cp=subprocess.run([node,str(ROOT/'analysis/study2/reproduce_public.mjs'),str(input_file),str(draws),str(out)],cwd=ROOT,text=True,capture_output=True)
    if cp.returncode:
        raise SystemExit(cp.stdout+cp.stderr)
    observed=json.loads(out.read_text())
    expected=json.loads(expected_file.read_text())
    if observed != expected:
        raise SystemExit('Study 2 public reproduction differs from the sealed independent Node reproduction.')
print('PASS_STUDY2_PUBLIC_REPRODUCTION_EXACT_JSON_EQUALITY numeric_values=60020 max_absolute_difference=0.0')
