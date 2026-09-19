/** Independent numerical reproduction; does not authorise or generate EXT data.
 * No imports from the Python estimator or production raw-evidence validator.
 * The coordinator separately admits raw records and verifies the draw schedules.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G=14, N=80, B=9999, DEN=4000, RANK=9750;
const hash = b => createHash('sha256').update(b).digest('hex');
const read = f => JSON.parse(fs.readFileSync(f,'utf8'));
const checkCount = (n, cap) => assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= cap);

export function extractCounts(counts) {
  assert.equal(counts.length,G);
  const x=[new Int32Array(G*N),new Int32Array(G*N)];
  let total=0;
  for(let s=0;s<G;s++){
    assert.equal(counts[s].length,N);
    for(let r=0;r<N;r++){
      const v=counts[s][r]; assert.equal(v.length,2);
      for(let c=0;c<2;c++){
        assert.equal(v[c].length,2);
        for(let h=0;h<2;h++){
          assert.equal(v[c][h].length,3);
          for(const n of v[c][h]) checkCount(n,h===0?500:2000);
        }
        for(let a=0;a<3;a++) checkCount(v[c][1][a]-v[c][0][a],1500);
      }
      const q=s*N+r;
      x[0][q]=(v[0][1][0]-v[0][1][1])+(v[1][1][0]-v[1][1][1]);
      x[1][q]=(v[0][1][1]-v[0][1][2])+(v[1][1][1]-v[1][1][2]);
      const direct=(v[0][1][0]-v[0][1][2])+(v[1][1][0]-v[1][1][2]);
      assert.equal(x[0][q]+x[1][q],direct);
      total+=direct;
    }
  }
  return {x,total:total/(G*N*DEN)};
}

function moments(x, tape=null, offset=0){
  let globalSum=0, varianceNumerator=0;
  for(let s=0;s<G;s++){
    let sum=0, square=0;
    for(let r=0;r<N;r++){
      const value=x[s*N+(tape===null?r:tape[offset+s*N+r])];
      sum+=value; square+=value*value;
    }
    globalSum+=sum;
    const centred=N*square-sum*sum;
    assert.ok(Number.isSafeInteger(centred) && centred>=0);
    varianceNumerator+=centred;
  }
  return [globalSum/(G*N*DEN), Math.sqrt(varianceNumerator/(G*G*N*N*(N-1)*DEN*DEN))];
}

function classification(lo,hi){
  if(lo>0.005) return 'BENEFICIAL';
  if(hi< -0.005) return 'HARMFUL';
  if(lo>= -0.005 && hi<=0.005) return 'EQUIVALENT';
  return 'INCONCLUSIVE';
}

function one(x,tape,seedString){
  const [theta,se]=moments(x);
  const means=[],ses=[],pivots=[];
  for(let b=0;b<B;b++){
    const [m,s]=moments(x,tape,b*G*N);
    means.push(m);ses.push(s);pivots.push(s>0?Math.abs((m-theta)/s):Infinity);
  }
  const sorted=pivots.slice().sort((a,b)=>a-b);
  const q=se===0?Infinity:sorted[RANK-1];
  const observed=se===0?null:Math.abs(theta/se);
  const exceeds=se===0?B:pivots.reduce((acc,t)=>acc+(t>=observed?1:0),0);
  const ci=se===0?[-1,1]:[Math.max(-1,theta-q*se),Math.min(1,theta+q*se)];
  const result={estimate:theta,se,t_observed_abs:observed,
    critical_abs_t:Number.isFinite(q)?q:'+Infinity',critical_rank_one_based:RANK,ci,
    p_unadjusted:(1+exceeds)/(B+1),exceedances:exceeds,
    degenerate_resamples:pivots.filter(t=>t===Infinity).length,
    observed_variance_zero:se===0,practical_classification:classification(...ci),
    seed_uint64_decimal:seedString,B};
  return {result,replicates:{theta_star:means,se_star:ses,abs_t_star:pivots.map(t=>Number.isFinite(t)?t:'+Infinity')}};
}

function cancellation(p){
  const a=p.J1.practical_classification,b=p.J2.practical_classification;
  if(a==='INCONCLUSIVE'||b==='INCONCLUSIVE')return 'UNRESOLVED_DECOMPOSITION';
  if(a==='EQUIVALENT'&&b==='EQUIVALENT')return 'COMPONENTWISE_EQUIVALENCE';
  if((a==='BENEFICIAL'&&b==='HARMFUL')||(b==='BENEFICIAL'&&a==='HARMFUL'))return 'CANCELLATION';
  if(a==='EQUIVALENT'||b==='EQUIVALENT')return 'ASYMMETRIC_COMPONENT_CONTRIBUTION';
  return 'CONCORDANT_NON_EQUIVALENT_INCREMENTS_DESCRIPTIVE';
}

function main(){
  const [inputFile,drawDirectory,outputFile]=process.argv.slice(2);
  assert.ok(inputFile&&drawDirectory&&outputFile,'usage: node reproduce.mjs INPUT_JSON DRAW_DIRECTORY OUTPUT_JSON');
  const inputBytes=fs.readFileSync(inputFile),input=JSON.parse(inputBytes);
  assert.ok(['ANALYTICAL_SOFTWARE_QUALIFICATION_ONLY','FULL_ADMITTED_EXT_COUNTS_AUDIT_REQUIRED'].includes(input.kind));
  const {x,total}=extractCounts(input.loss_counts);
  const seals=read(path.join(HERE,'DRAW_SCHEDULE_SEALS.json'));
  const protocol=read(path.join(HERE,'../03_SEALED_INPUTS/I05_STUDY2_PROTOCOL_LOCK.json'));
  const primary={},replicates={};
  const names=['J1_RESIDUAL_POPULATION','J2_CONTINUATION_STATE'];
  for(const [i,h] of ['J1','J2'].entries()){
    const tape=fs.readFileSync(path.join(drawDirectory,h+'.indices.u8'));
    assert.equal(tape.length,B*G*N);assert.equal(hash(tape),seals.draws[h].sha256);
    for(const n of tape) assert.ok(n<N);
    const sd=protocol.primary_inference.analysis_seeds[names[i]];
    assert.equal(hash(Buffer.from(sd.address)).slice(0,16),sd.hex16);
    assert.equal(BigInt('0x'+sd.hex16).toString(),sd.uint64_decimal);
    const result=one(x[i],tape,sd.uint64_decimal);
    primary[h]=result.result;replicates[h]=result.replicates;
  }
  const order=['J1','J2'].sort((a,b)=>primary[a].p_unadjusted-primary[b].p_unadjusted);
  let running=0,stopped=false;
  for(const [i,h] of order.entries()){
    const raw=primary[h].p_unadjusted;
    running=Math.min(1,Math.max(running,(2-i)*raw));
    const reject=!stopped&&raw<=0.05/(2-i);stopped=stopped||!reject;
    primary[h].p_holm_adjusted=running;primary[h].holm_reject_fwer_0_05=reject;
  }
  const value={kind:input.kind,input_sha256:hash(inputBytes),
    implementation:'independent Node integer moments and order statistics; shared sealed draw tapes',
    result:{method:'paired equal-scenario whole-stream symmetric absolute bootstrap-t',
      independent_units:G*N,checkpoints_are_independent:false,family:['J1','J2'],primary,
      j_sum_direct_point_estimate:total,j_sum_integer_closure:true,
      cancellation_diagnostic:cancellation(primary),scientific_phase_complete:false},replicates};
  fs.writeFileSync(outputFile,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'PASS_NUMERICAL_REPRODUCTION_COMPUTED_NOT_YET_COMPARED',kind:input.kind,output_sha256:hash(fs.readFileSync(outputFile))}));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}catch(e){console.error(e.stack);process.exitCode=2;}
}
