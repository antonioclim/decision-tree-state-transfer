import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { ChunkedEvidenceWriter, readChunkedEvents } from '../assets/code/confirmatory/chunked-evidence.mjs';
import { strictJson } from '../assets/code/confirmatory/evidence.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const meta={partition:'FIXTURE',attempt_id:'A',run_id:'R',protocol_sha256:'a'.repeat(64)};
function fresh(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'chunk-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return path.join(base,'archive');}
function make(t){const dir=fresh(t);const w=new ChunkedEvidenceWriter(dir,meta,{chunkBytes:128});const events=Array.from({length:8},(_,i)=>({i,text:'a'.repeat(28)}));events.forEach(e=>w.append(e));const result=w.finish();return {dir,w,result,events};}
function editManifest(dir,fn){const p=path.join(dir,'finished.json');const m=JSON.parse(fs.readFileSync(p));fn(m);const b=strictJson(m)+'\n';fs.writeFileSync(p,b);return sha(b);}
function read(dir,hash){const audit={};const events=[...readChunkedEvents(dir,audit,{expectedManifestSha256:hash})];return {events,audit};}
test('chunk transport is byte-reversible with an independently calculated transcript',t=>{const {dir,result,events}=make(t);const v=read(dir,result.manifest_sha256);assert.deepEqual(v.events,events);assert.equal(v.audit.sha256,sha(events.map(e=>strictJson(e)+'\n').join('')));assert.ok(result.chunks.length>1);assert.ok(result.max_buffered_raw_bytes<=128);assert.equal(v.audit.scientific_admission,false);});
test('empty completed archive has an exact empty transcript',t=>{const dir=fresh(t);const w=new ChunkedEvidenceWriter(dir,meta);const r=w.finish();assert.deepEqual(read(dir,r.manifest_sha256).events,[]);});
test('CONF and malformed metadata are rejected before directory creation',t=>{const dir=fresh(t);assert.throws(()=>new ChunkedEvidenceWriter(dir,{...meta,partition:'CONF'}));assert.throws(()=>new ChunkedEvidenceWriter(dir,{...meta,protocol_sha256:'x'}));assert.equal(fs.existsSync(dir),false);});
test('chunk bounds are hard schema limits',t=>{for(const chunkBytes of [0,127,1048577,NaN])assert.throws(()=>new ChunkedEvidenceWriter(fresh(t),meta,{chunkBytes}));});
test('existing attempt cannot be overwritten',t=>{const {dir}=make(t);assert.throws(()=>new ChunkedEvidenceWriter(dir,meta));});
test('oversize or non-JSON records poison completion',t=>{for(const event of [{x:'x'.repeat(300)},{x:NaN}]){const w=new ChunkedEvidenceWriter(fresh(t),meta,{chunkBytes:128});assert.throws(()=>w.append(event));assert.throws(()=>w.finish());}});
test('append and repeated closure are rejected after completion',t=>{const {w}=make(t);assert.throws(()=>w.append({x:1}));assert.throws(()=>w.finish());});
test('unclosed archive is never accepted',t=>{const dir=fresh(t);new ChunkedEvidenceWriter(dir,meta).append({x:1});assert.throws(()=>read(dir,'a'.repeat(64)));});
test('expected digest cannot be omitted or learnt silently',t=>{const {dir}=make(t);assert.throws(()=>read(dir));assert.throws(()=>read(dir,'b'.repeat(64)));});
for(const [name,mutate] of [
 ['chunk traversal',m=>{m.chunks[0].file='../escape';}],['duplicate chunk',m=>{m.chunks.push(m.chunks[0]);}],
 ['raw bound',m=>{m.chunks[0].raw_bytes=1048577;}],['raw digest',m=>{m.chunks[0].raw_sha256='f'.repeat(64);}],
 ['compressed bytes',m=>{m.chunks[0].gzip_bytes++;}],['chunk rows',m=>{m.chunks[0].rows++;}],
 ['global rows',m=>{m.evidence_rows++;}],['global bytes',m=>{m.evidence_bytes++;}],
 ['invalid closure',m=>{m.status='RUNNING';}],['non-DEV partition',m=>{m.metadata.partition='CONF';}],
 ['started metadata',m=>{m.metadata.attempt_id='OTHER';}],['oversize chunk setting',m=>{m.chunk_bytes=2**30;}],
])test(`reject rehashed corruption: ${name}`,t=>{const {dir}=make(t);const h=editManifest(dir,mutate);assert.throws(()=>read(dir,h));});
test('extra unlisted file is rejected',t=>{const {dir,result}=make(t);fs.writeFileSync(path.join(dir,'extra'),'x');assert.throws(()=>read(dir,result.manifest_sha256));});
test('compressed corruption cannot be covered by an unchanged root',t=>{const {dir,result}=make(t);fs.appendFileSync(path.join(dir,result.chunks[0].file),'x');assert.throws(()=>read(dir,result.manifest_sha256));});
test('symlink member is rejected even when the target bytes match',t=>{const {dir,result}=make(t);const p=path.join(dir,result.chunks[0].file);const target=dir+'.bin';fs.renameSync(p,target);fs.symlinkSync(target,p);assert.throws(()=>read(dir,result.manifest_sha256));});
test('rehashed duplicate JSON keys inside a chunk are rejected',t=>{const {dir}=make(t);const raw=Buffer.from('{"x":1,"x":2}\n');const zip=gzipSync(raw);const p=path.join(dir,'finished.json');const m=JSON.parse(fs.readFileSync(p));for(const c of m.chunks)fs.unlinkSync(path.join(dir,c.file));fs.writeFileSync(path.join(dir,'00000000.jsonl.gz'),zip);const h=editManifest(dir,n=>{n.chunks=[{file:'00000000.jsonl.gz',raw_bytes:raw.length,gzip_bytes:zip.length,raw_sha256:sha(raw),gzip_sha256:sha(zip),rows:1}];n.evidence_rows=1;n.evidence_bytes=raw.length;n.events_sha256=sha(raw);});assert.throws(()=>read(dir,h));});
