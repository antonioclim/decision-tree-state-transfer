import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { strictJson } from './evidence.mjs';
import { EvolutionLearner } from './learner.mjs';
import { floatBits } from './trees.mjs';

const digest = (x) => createHash('sha256').update(strictJson(x)).digest('hex');
function identifier(x) { return typeof x === 'string' && x.length > 0 && x.length <= 512; }
function witness(x) { return x && Number.isSafeInteger(x.update) && x.update >= 0 && identifier(x.individual) && identifier(x.root_record); }
function equal(a,b) { return strictJson(a) === strictJson(b); }

/** File-backed audit index. Not an independent attestation of the experimental source. */
export class DiskProvenanceIndex {
  constructor(filename) {
    const fd=fs.openSync(filename,'wx');fs.closeSync(fd);this.filename=filename;
    this.db=new DatabaseSync(filename,{allowExtension:false});
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192;
      PRAGMA mmap_size=0; PRAGMA temp_store=FILE;
      CREATE TABLE ids(id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE tokens(token TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE edges(id TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE nodes(id TEXT PRIMARY KEY, payload TEXT NOT NULL, material TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE witnesses(id TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID; BEGIN IMMEDIATE;`);
    this.q={};
    for(const [name,sql] of Object.entries({
      id:'INSERT INTO ids VALUES (?)',token:'INSERT INTO tokens VALUES (?)',
      edge:'SELECT payload FROM edges WHERE id=?',node:'SELECT payload,material FROM nodes WHERE id=?',
      witness:'SELECT payload FROM witnesses WHERE id=?',
      addEdge:'INSERT INTO edges VALUES (?,?)',addNode:'INSERT INTO nodes VALUES (?,?,?)',addWitness:'INSERT INTO witnesses VALUES (?,?)'})) this.q[name]=this.db.prepare(sql);
    this.events=0;this.counts={node_records:0,edge_records:0,realised_witnesses:0};this.closed=false;this.poisoned=false;
  }
  getNode(id) { const row=this.q.node.get(id);return row ? {...row,payload:JSON.parse(row.payload)} : null; }
  getEdge(id) { const row=this.q.edge.get(id);return row ? JSON.parse(row.payload) : null; }
  getWitness(id) { const row=this.q.witness.get(id);return row ? JSON.parse(row.payload) : null; }
  append(e) {
    if(this.closed || this.poisoned)throw new Error('index is closed or poisoned');
    try { this.add(e);this.events++;if(this.events%5000===0)this.db.exec('COMMIT; BEGIN IMMEDIATE;'); }
    catch(error){this.poisoned=true;throw error;}
  }
  add(e) {
    strictJson(e);
    if(e.kind==='realised-connected-subtree') {
      if(!identifier(e.record)||!witness(e.witness)||e.witness.root_record!==e.record||!this.getNode(e.record))throw new Error('invalid realised witness');
      this.q.addWitness.run(e.record,strictJson(e.witness));this.counts.realised_witnesses++;return;
    }
    if(!['node','edge'].includes(e.kind)||!identifier(e.id)||!identifier(e.token)||(e.source!==null&&!identifier(e.source)))throw new Error('invalid provenance identity');
    this.q.id.run(e.id);
    if(e.source===null)this.q.token.run(e.token);
    if(e.kind==='edge') {
      if(!identifier(e.parent_token)||!identifier(e.child_token)||!['left','right'].includes(e.slot))throw new Error('invalid edge endpoints');
      if(e.source!==null) {
        const old=this.getEdge(e.source);
        if(!old||['token','parent_token','child_token','slot'].some(k=>old[k]!==e[k]))throw new Error('invalid edge copy');
      }
      this.q.addEdge.run(e.id,strictJson(e));this.counts.edge_records++;return;
    }
    if(!Number.isSafeInteger(e.birth_update)||e.birth_update<0||!identifier(e.operation)||!Array.isArray(e.literal)
      || !['leaf','split'].includes(e.literal[0])||(e.witness!==null&&!witness(e.witness)))throw new Error('invalid node metadata');
    let material;
    if(e.literal[0]==='leaf') {
      if(e.literal.length!==2||![0,1].includes(e.literal[1]))throw new Error('invalid leaf literal');
      material=digest(['leaf',e.token]);
    } else {
      if(e.literal.length!==4||!Number.isSafeInteger(e.literal[1])||e.literal[1]<0||e.literal[3]!=='<'
        ||! /^[a-f0-9]{16}$/.test(e.literal[2])||!Number.isFinite(Buffer.from(e.literal[2],'hex').readDoubleBE()))throw new Error('invalid split literal');
      const child=[];
      for(const slot of ['left','right']) {
        const embed=e[`${slot}_edge`];const edge=embed&&this.getEdge(embed.id);const node=this.getNode(e[`${slot}_record`]);
        if(!edge||!node||edge.parent_token!==e.token||edge.child_token!==node.payload.token||edge.slot!==slot
          ||['id','token','source','parent_token','child_token','slot'].some(k=>edge[k]!==embed[k]))throw new Error('invalid canonical adjacency');
        child.push(edge.token,node.material);
      }
      material=digest(['split',e.token,...child]);
    }
    if(e.source!==null) {
      const old=this.getNode(e.source);
      if(!old||old.payload.token!==e.token||old.payload.birth_update!==e.birth_update||!equal(old.payload.literal,e.literal))throw new Error('invalid literal copy');
    } else if(e.witness!==null)throw new Error('new node cannot claim an inherited witness');
    if(e.witness!==null) {
      const oldWitness=this.getWitness(e.witness.root_record);const old=this.getNode(e.witness.root_record);
      if(!oldWitness||!old||!equal(oldWitness,e.witness)||old.material!==material)throw new Error('forged connected witness');
    }
    this.q.addNode.run(e.id,strictJson(e),material);this.counts.node_records++;
  }
  verifySnapshot(snapshot) {
    if(this.closed||this.poisoned)throw new Error('unusable provenance index');
    const learner=EvolutionLearner.restore(snapshot);let nodes=0;
    const visit=(tree,depth=0)=> {
      if(depth>learner.config.maxTreeDepth)throw new Error('snapshot depth violation');
      const record=this.getNode(tree._p.id);
      if(!record)throw new Error('snapshot references absent node');const e=record.payload;
      for(const key of ['id','token','source','birth_update','operation'])if(tree._p[key]!==e[key])throw new Error('snapshot metadata differs from recorded origin');
      const expectedWitness=this.getWitness(e.id)??e.witness;
      if(!equal(tree._p.witness,expectedWitness))throw new Error('snapshot witness differs from trace');
      const literal=tree.type==='leaf'?['leaf',tree.action]:['split',tree.feature,floatBits(tree.threshold),'<'];
      if(!equal(e.literal,literal))throw new Error('snapshot literal differs from trace');
      if(tree.type==='split')for(const slot of ['left','right']) {
        if(tree[slot]._p.id!==e[`${slot}_record`]||!equal(tree._p[`${slot}_edge`],e[`${slot}_edge`]))throw new Error('snapshot topology differs from trace');
        visit(tree[slot],depth+1);
      }
      nodes++;
    };
    for(const item of learner.population)visit(item.tree);
    return {snapshot_sha256:digest(snapshot),population_size:learner.population.length,checked_node_occurrences:nodes,scientific_admission:false};
  }
  finish() {
    if(this.closed||this.poisoned)throw new Error('invalid index closure');
    this.db.exec('COMMIT');const integrity=this.db.prepare('PRAGMA integrity_check').get().integrity_check;
    if(integrity!=='ok') { this.poisoned=true;throw new Error('SQLite integrity failure'); }
    const result={...this.counts,events:this.events,database_bytes:fs.statSync(this.filename).size,
      sqlite_version:this.db.prepare('SELECT sqlite_version() AS version').get().version,integrity_check:integrity,
      cache_size_kib:8192,mmap_size:0,temp_store:'FILE',scientific_admission:false};
    this.db.close();this.closed=true;return result;
  }
  close() { if(!this.closed){this.db.close();this.closed=true;} }
}
