from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path

SCHEDULE_SHA = "cb005bc52ca98255c834ccd04eabb14c6ece3ecf96a4e68e7a83f346485b3c93"
BRIDGE_SHA = "aca2abe9d241fbedcbde15ceb161f1d2cd23417e92c314fc60df7ff935bce73a"
METHODS = ("HAT", "ARF", "EFDT", "SRP", "FROZEN_CART", "ROLLING_CART")


def sha_bytes(b: bytes) -> str: return hashlib.sha256(b).hexdigest()
def sha_file(p: Path) -> str: return sha_bytes(p.read_bytes())
def canonical(o: dict) -> bytes: return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
def parse_tsv(p: Path): return list(csv.DictReader(p.read_text(encoding="utf-8").splitlines(), delimiter="\t"))

def seed(method: str, stream_key: str):
    if method == "EFDT": return None
    x = f"DT-C8E1-F09-v1|CONF|COMPARATOR|method={method}|stream={stream_key}"
    return int(hashlib.sha256(x.encode()).hexdigest()[:8], 16)

def order_key(method: str, stream_key: str) -> str:
    x = f"DT-C8E1-F09-v1|CONF|CONTEXTUAL-ORDER|stream={stream_key}|method={method}"
    return hashlib.sha256(x.encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--downloads", type=Path, required=True); ap.add_argument("--schedule", type=Path, required=True)
    ap.add_argument("--bridge", type=Path, required=True); ap.add_argument("--output", type=Path, required=True); args = ap.parse_args()
    if sha_file(args.schedule) != SCHEDULE_SHA or sha_file(args.bridge) != BRIDGE_SHA: raise RuntimeError("schedule/bridge digest mismatch")
    schedule, bridge = parse_tsv(args.schedule), parse_tsv(args.bridge)
    if len(schedule) != 4480 or len(bridge) != 280: raise RuntimeError("schedule/bridge cardinality mismatch")
    bmap = {x["source_key_hex"]: x for x in bridge}; expected = {(b["source_key_hex"], m) for b in bridge for m in METHODS}; records = {}
    for filename in args.downloads.rglob("cells/*.json"):
        r = json.loads(filename.read_text(encoding="utf-8")); claimed = r.pop("record_sha256", None); actual = sha_bytes(canonical(r)); r["record_sha256"] = claimed
        if claimed != actual: raise RuntimeError(f"cell self-hash mismatch: {filename}")
        key = (r.get("source_key_hex"), r.get("method"))
        if key not in expected or key in records: raise RuntimeError(f"unplanned or duplicate contextual cell {key}")
        b = bmap[key[0]]
        if r.get("partition") != "CONF" or r.get("role") != "CONTEXTUAL_PREDICTIVE_RESOURCE_BENCHMARK_ONLY" or r.get("h1_h2_h3_identification") is not False or r.get("scientific_interpretation_authorised") is not False:
            raise RuntimeError("contextual/H1-H3 firewall violation")
        if r.get("scenario_id") != b["scenario_id"] or r.get("realisation") != int(b["realisation"]): raise RuntimeError("cell/bridge identity mismatch")
        if r.get("source", {}).get("feature_sha256") != b["feature_sha256"] or r.get("source", {}).get("label_sha256") != b["label_sha256"]: raise RuntimeError("cell source digest mismatch")
        if r.get("seed_uint32") != seed(key[1], key[0]) or r.get("cell_order_key_sha256") != order_key(key[1], key[0]): raise RuntimeError("cell seed/order-key mismatch")
        status = r.get("status")
        if status == "COMPLETE":
            if r.get("prediction_calls") != 24000 or r.get("labels_consumed") != 26000 or r.get("prediction_latency", {}).get("count") != 24000: raise RuntimeError("complete cell denominator mismatch")
        elif status in ("ALGORITHMIC_FAILURE", "ALGORITHMIC_FAILURE_RESOURCE_LIMIT"):
            if r.get("loss_sum") != r.get("observed_loss_sum", 0) + (24000 - r.get("prediction_calls", 0)): raise RuntimeError("failure denominator mismatch")
        else: raise RuntimeError(f"infrastructure-invalid or unknown cell cannot enter aggregate: {status}")
        records[key] = r
    if set(records) != expected or len(records) != 1680: raise RuntimeError(f"contextual completeness failure: {len(records)}/1680")
    manifests = list(args.downloads.rglob("SHARD_MANIFEST.json")); failures = list(args.downloads.rglob("SHARD_FAILURE.json"))
    if failures or len(manifests) != 56: raise RuntimeError(f"shard evidence mismatch: manifests={len(manifests)} failures={len(failures)}")
    shards = set()
    for filename in manifests:
        m = json.loads(filename.read_text(encoding="utf-8"))
        if m.get("status") != "COMPLETE_CONTEXTUAL_SHARD" or m.get("cells") != 30 or m.get("streams") != 5 or m.get("source_bridge_sha256") != BRIDGE_SHA or m.get("schedule_sha256") != SCHEDULE_SHA:
            raise RuntimeError("invalid contextual shard manifest")
        shards.add(m["shard"])
    if shards != set(range(56)): raise RuntimeError("contextual shard set incomplete")
    out = args.output; out.mkdir(parents=True, exist_ok=True); ordered = sorted(records.values(), key=lambda r: (r["stream_ordinal"], r["cell_order_key_sha256"]))
    with (out / "CONTEXTUAL_CELLS.jsonl").open("w", encoding="utf-8", newline="\n") as fh:
        for r in ordered: fh.write(json.dumps(r, sort_keys=True, separators=(",", ":")) + "\n")
    fields = ["stream_ordinal", "scenario_id", "realisation", "source_key_hex", "method", "seed_uint32", "status", "prediction_calls", "update_or_fit_calls", "labels_consumed", "loss_sum", "mean_loss", "process_cpu_ns", "elapsed_ns", "peak_rss_bytes", "record_sha256"]
    with (out / "CONTEXTUAL_CELLS.tsv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, delimiter="\t", lineterminator="\n", extrasaction="ignore"); writer.writeheader(); writer.writerows(ordered)
    root = sha_bytes("".join(f"{r['stream_ordinal']}\t{r['source_key_hex']}\t{r['method']}\t{r['record_sha256']}\n" for r in ordered).encode())
    counts = {s: sum(r["status"] == s for r in ordered) for s in sorted({r["status"] for r in ordered})}
    manifest = {"schema_version": 1, "phase": "F10_CONTEXTUAL_COMPARATORS", "status": "COMPLETE_CONTEXTUAL_COMPARATOR_CAMPAIGN", "protocol_id": "DT-C8E1-F09-v1.0",
        "streams": 280, "methods": list(METHODS), "cells": 1680, "shards": 56, "schedule_sha256": SCHEDULE_SHA, "source_bridge_sha256": BRIDGE_SHA,
        "cell_record_root_sha256": root, "status_counts": counts, "contains_predictive_ranking_summary": False, "h1_h2_h3_identification": False,
        "scientific_interpretation_authorised": False, "f11_authorised": False}
    (out / "CONTEXTUAL_CAMPAIGN_MANIFEST.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / "SOURCE_DIGESTS_CONTEXTUAL.tsv").write_bytes(args.bridge.read_bytes()); (out / "EXPANDED_F09_CONF_SCHEDULE.tsv").write_bytes(args.schedule.read_bytes())
    print(json.dumps(manifest, sort_keys=True))

if __name__ == "__main__":
    main()
