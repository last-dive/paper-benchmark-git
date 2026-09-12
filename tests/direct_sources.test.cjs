'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./core.js');
require('./transport.js');
const PB = globalThis.PB;
const { makeV2Review } = require('./v2_fixture.cjs');
const MODE = { expectedVersion:2, citationMode:'source_ids_v1' };
const TEXT = Array.from({length:7},(_,index)=>`Physical page ${index+1}: This is distinct synthetic evidence paragraph number ${index+1}. The source exists only to verify software citation references and audit records. No scientific finding or performance claim is implied by this fixture.`).join('\f');
const catalog = () => PB.buildSourceCatalog(TEXT);
const ids = () => catalog().map(entry=>entry.id);
const clone = value => JSON.parse(JSON.stringify(value));
function directReview() {
  const input = makeV2Review(TEXT), sourceIds = ids();
  for(const d of input.dimensions){
    delete d.evidence;
    for(const [index,item] of d.items.entries()){
      delete item.evidenceIndices;
      item.sourceIds=index===1?[sourceIds[1],sourceIds[0]]:[sourceIds[index]];
    }
  }
  for(const point of [...input.analysis.centralClaims,input.analysis.strongestSupport,input.analysis.strongestChallenge]){
    delete point.evidenceRefs;point.sourceIds=[sourceIds[1]];
  }
  return input;
}
function legacyReview() {
  const input=makeV2Review(TEXT),sourceIds=ids();
  for(const d of input.dimensions)d.evidence=[{sourceId:sourceIds[0]}];
  return input;
}
function legacyOmittedSource() {
  const input=legacyReview(),d=input.dimensions.find(d=>d.id==='fairness');
  const missing=ids()[1];
  d.items[2].evidenceIndices=[d.evidence.length];
  d.items[2].basis=`Synthetic local citation is explicitly identified (${missing}); this sentence only audits source-reference recovery.`;
  return input;
}
const fullScores = parsed => parsed.dimensions.map(d=>d.score);

test('per-item direct source IDs derive stable dimension evidence order and indices without changing the score formula',()=>{
  const input=directReview();
  input.dimensions[1].items[0].level=1;
  const before=clone(input),parsed=PB.parseReview(input,TEXT,MODE),sourceIds=ids();
  assert.deepEqual(input,before,'derivation must not mutate the raw model response');
  assert.deepEqual(fullScores(parsed),[7.75,6,7.75,7.75,7.75]);
  for(const d of parsed.dimensions){
    assert.deepEqual(d.evidence.map(e=>e.sourceId),sourceIds.slice(0,4));
    assert.deepEqual(d.items.map(item=>item.sourceIds),[[sourceIds[0]],[sourceIds[1],sourceIds[0]],[sourceIds[2]],[sourceIds[3]]]);
    assert.deepEqual(d.items.map(item=>item.evidenceIndices),[[0],[1,0],[2],[3]]);
    for(const evidence of d.evidence){
      const entry=catalog().find(entry=>entry.id===evidence.sourceId);
      assert.equal(evidence.quote,TEXT.slice(entry.start,entry.end));
      assert.equal(evidence.sourceStart,entry.start);assert.equal(evidence.sourceEnd,entry.end);
      assert.equal(evidence.matchedMethod,'source_id_exact');
    }
  }
  assert.deepEqual(PB.parseReview(parsed,TEXT,MODE),parsed);
});

test('unavailable direct-source items stay unavailable and never receive invented evidence or a zero grade',()=>{
  const input=directReview();Object.assign(input.dimensions[0].items[0],{status:'unavailable',level:null,sourceIds:[],missing:'The synthetic fixture explicitly lacks the source required by this criterion.'});
  const parsed=PB.parseReview(input,TEXT,MODE),item=parsed.dimensions[0].items[0];
  assert.deepEqual(item.sourceIds,[]);assert.deepEqual(item.evidenceIndices,[]);
  assert.equal(item.effectiveLevel,null);assert.equal(parsed.dimensions[0].score,null);
  assert.equal(parsed.dimensions[0].completeness.assessedItems,3);
});

test('direct-source fields reject missing, duplicate, excessive and unknown IDs without legacy-index rescue',()=>{
  const invalid=[undefined,null,ids()[0],[],[ids()[0],ids()[0]],['Q99999'],['q00001'],[' Q00001 '],ids().slice(0,6)];
  for(const value of invalid){
    const input=directReview(),item=input.dimensions[0].items[0];
    if(value===undefined)delete item.sourceIds;else item.sourceIds=value;
    assert.throws(()=>PB.parseReview(input,TEXT,MODE),/sourceId|sourceIds|引文|索引|依据/);
  }
  const input=directReview();input.dimensions[0].evidence=[{sourceId:ids()[0]}];
  input.dimensions[0].items[0].sourceIds=['Q99999'];input.dimensions[0].items[0].evidenceIndices=[0];
  assert.throws(()=>PB.parseReview(input,TEXT,MODE));
});

test('direct auxiliary references resolve exact sources, while unknown auxiliary IDs stay warnings and never counted matched',()=>{
  const input=directReview();
  input.analysis.centralClaims[0].sourceIds=[ids()[1],'Q99999'];
  input.analysis.strongestSupport.sourceIds=['Q99999'];
  const parsed=PB.parseReview(input,TEXT,MODE),claim=parsed.analysis.centralClaims[0],support=parsed.analysis.strongestSupport;
  assert.deepEqual(fullScores(parsed),[7.75,7.75,7.75,7.75,7.75]);
  assert.deepEqual(claim.evidenceRefs,[]);
  assert.equal(claim.sourceEvidence.length,1);assert.equal(claim.sourceEvidence[0].sourceId,ids()[1]);
  assert.equal(claim.sourceEvidence[0].quote,catalog()[1].quote);assert.equal(claim.matchedEvidenceCount,1);
  assert.deepEqual(support.sourceEvidence,[]);assert.equal(support.matchedEvidenceCount,0);assert.equal(support.citationStatus,'unverified');
  assert.ok(parsed.metadataWarnings.length>=2);
  assert.deepEqual(PB.parseReview(parsed,TEXT,MODE),parsed);
});

test('one omitted legacy source is restored only from the same item explicit unique valid source ID with audit repair preserved',()=>{
  const input=legacyOmittedSource(),before=clone(input),parsed=PB.parseReview(input,TEXT,MODE);
  const d=parsed.dimensions.find(d=>d.id==='fairness'),sourceId=ids()[1];
  assert.deepEqual(input,before,'parser must not mutate the raw model response');
  assert.deepEqual(fullScores(parsed),[7.75,7.75,7.75,7.75,7.75]);
  assert.deepEqual(d.evidence.map(e=>e.sourceId),[ids()[0],sourceId]);
  assert.equal(d.items[2].level,before.dimensions[3].items[2].level);
  assert.equal(d.items[2].basis,before.dimensions[3].items[2].basis);
  assert.deepEqual(d.items[2].evidenceIndices,[1]);
  assert.deepEqual(parsed.citationRepairs,[{dimensionId:'fairness',itemId:'resources',sourceId,originalEvidenceIndices:[1],operation:'append_explicit_basis_source'}]);
  assert.deepEqual(PB.parseReview(parsed,TEXT,MODE),parsed);
});

test('legacy recovery rejects ambiguous, absent, unrelated and non-tail evidence references rather than guessing an index',()=>{
  const mutations=[
    (input,d,item)=>item.basis='No explicit source identifier is supplied in this synthetic explanation.',
    (input,d,item)=>item.basis=`Two explicit alternatives (${ids()[1]}) and (${ids()[2]}) cannot identify one omitted source.`,
    (input,d,item)=>item.basis='The only named source (Q99999) does not exist in the frozen source catalog.',
    (input,d,item)=>item.basis=`The only named source (${ids()[0]}) is already in this dimension and cannot fill its missing tail.`,
    (input,d,item)=>item.evidenceIndices=[d.evidence.length+1],
    (input,d,item)=>item.evidenceIndices=[0,d.evidence.length],
    (input,d,item)=>item.evidenceIndices=[d.evidence.length,d.evidence.length],
    (input,d,item)=>{d.items[1].evidenceIndices=[d.evidence.length];d.items[1].basis=`Another malformed item explicitly names (${ids()[2]}).`;},
    (input,d,item)=>{const other=input.dimensions[1];other.items[0].evidenceIndices=[other.evidence.length];other.items[0].basis=`A second dimension independently omits source (${ids()[2]}).`;},
  ];
  for(const mutate of mutations){const input=legacyOmittedSource(),d=input.dimensions[3],item=d.items[2];mutate(input,d,item);assert.throws(()=>PB.parseReview(input,TEXT,MODE),/sourceId|引文|索引/);}
  const wrongMode=legacyOmittedSource();assert.throws(()=>PB.parseReviewV2(wrongMode,TEXT));
});

function paper(){return {id:'direct-paper',title:'Synthetic direct-source fixture',group:'',version:'test',kind:'draft',change:'other',text:TEXT};}
const cfg={inputMode:'text',endpoint:'https://direct-sources.invalid/v1',model:'mock-source-model',repeats:1,concurrency:1,retries:0,timeout:120};
function response(review){return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({model:'mock-source-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(review)}}]})};}
function archive(batch){return PB.exportArchive({schemaVersion:1,config:batch.config,papers:batch.papers,batches:[batch],currentBatchId:batch.id});}

test('direct-source and narrowly recovered legacy results each survive two complete archive import/export cycles',async()=>{
  const originalFetch=globalThis.fetch;
  try{
    for(const raw of [directReview(),legacyOmittedSource()]){
      const batch=await PB.createBatch([paper()],cfg,'source archive cycle');
      globalThis.fetch=async()=>response(raw);await PB.runBatch(batch,'test-secret');
      const result=clone(batch.runs[0].result),attempts=clone(batch.runs[0].attempts);
      let current=PB.validateArchive(archive(batch));
      for(let n=0;n<2;n++){
        assert.deepEqual(current.batches[0].runs[0].result,result);
        assert.deepEqual(current.batches[0].runs[0].attempts,attempts);
        current=PB.validateArchive(PB.exportArchive(current));
      }
    }
  }finally{globalThis.fetch=originalFetch;}
});


test('each item may cite up to five sources even when their dimension union exceeds the old five-entry cap',()=>{
  const input=directReview();
  for(const [index,item]of input.dimensions[0].items.entries())item.sourceIds=ids().slice(index,index+4);
  const parsed=PB.parseReview(input,TEXT,MODE),d=parsed.dimensions[0];
  assert.equal(d.evidence.length,7);assert.deepEqual(d.evidence.map(e=>e.sourceId),ids());
  assert.ok(d.items.every(item=>item.evidenceIndices.length===4));assert.equal(d.score,7.75);
  assert.deepEqual(PB.parseReview(parsed,TEXT,MODE),parsed);
});

async function recordedFailure(raw=legacyOmittedSource(),finish='stop'){
  const batch=await PB.createBatch([paper()],cfg,'Synthetic previously failed response');
  batch.status='paused';batch.pauseReason='Synthetic legacy parser rejected a single missing source-list entry.';
  const attempt={id:'synthetic-original-attempt',status:'error',httpStatus:200,finishReason:finish,errorCode:'review_parse',error:'Synthetic original evidence index invalid',retryable:false,durationMs:1234,
    request:{model:'mock-source-model',messages:[]},usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300},
    responseBody:JSON.stringify({model:'mock-source-model',usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300},choices:[{finish_reason:finish,message:{content:JSON.stringify(raw)}}]})};
  Object.assign(batch.runs[0],{status:'error',error:attempt.error,attempts:[attempt]});
  return batch;
}

test('local recovery reparses one intact failed response with no network request or changes to the original attempt',async()=>{
  const batch=await recordedFailure(),attempts=clone(batch.runs[0].attempts),originalFetch=globalThis.fetch;
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Local recovery must never call an API');};
  try{
    assert.deepEqual(PB.recoverBatchLocally(batch),{recovered:1,remainingFailed:0});
    assert.equal(calls,0);assert.equal(batch.status,'complete');assert.equal(batch.runs[0].status,'success');
    assert.deepEqual(batch.runs[0].attempts,attempts);
    assert.equal(batch.runs[0].attempts[0].status,'error','original transport/parser attempt remains an error in the audit');
    assert.equal(batch.runs[0].localRecovery.operation,'reparse_existing_response');
    assert.equal(batch.runs[0].localRecovery.sourceAttemptId,attempts[0].id);
    assert.equal(batch.runs[0].localRecovery.originalError,attempts[0].error);
    assert.equal(batch.runs[0].result.citationRepairs.length,1);
    const first=clone(batch);
    assert.deepEqual(PB.recoverBatchLocally(batch),{recovered:0,remainingFailed:0});
    assert.deepEqual(batch,first);
    let current=PB.validateArchive(archive(batch));
    for(let i=0;i<2;i++){
      assert.deepEqual(current.batches[0].runs[0].attempts,attempts);
      assert.deepEqual(current.batches[0].runs[0].localRecovery,batch.runs[0].localRecovery);
      assert.deepEqual(current.batches[0].runs[0].result,batch.runs[0].result);
      current=PB.validateArchive(PB.exportArchive(current));
    }
  }finally{globalThis.fetch=originalFetch;}
});

test('imported locally recovered grades are recomputed from the preserved response, not forged normalized grades',async()=>{
  const batch=await recordedFailure();PB.recoverBatchLocally(batch);
  const original=clone(batch.runs[0].result),stored=archive(batch);
  const result=stored.batches[0].runs[0].result;
  result.dimensions[0].items[0].level=4;result.dimensions[0].score=10;result.dimensions[0].rawScore=10;
  result.summary='A forged replacement summary must not override the preserved model response.';
  const imported=PB.validateArchive(stored);
  assert.deepEqual(imported.batches[0].runs[0].result,original);
  const forged=archive(batch);forged.batches[0].runs[0].localRecovery.sourceAttemptId='nonexistent-original-attempt';
  assert.throws(()=>PB.validateArchive(forged),/恢复/);
});

test('truncated, ambiguous or unresolved failed responses remain unchanged under local recovery',async()=>{
  const noId=legacyOmittedSource();noId.dimensions[3].items[2].basis='No explicit source identifier exists in this synthetic statement.';
  const unknown=legacyOmittedSource();unknown.dimensions[3].items[2].basis='The nonexistent source (Q99999) cannot be reconstructed.';
  for(const [raw,finish]of [[legacyOmittedSource(),'length'],[noId,'stop'],[unknown,'stop']]){
    const batch=await recordedFailure(raw,finish),before=clone(batch);
    assert.deepEqual(PB.recoverBatchLocally(batch),{recovered:0,remainingFailed:1});
    assert.deepEqual(batch,before);assert.equal(batch.runs[0].result,undefined);
  }
  const inconsistent=await recordedFailure(legacyOmittedSource(),'length');inconsistent.runs[0].attempts[0].finishReason='stop';
  const before=clone(inconsistent);
  assert.deepEqual(PB.recoverBatchLocally(inconsistent),{recovered:0,remainingFailed:1});
  assert.deepEqual(inconsistent,before);
});

test('model or fingerprint drift from a locally recovered original error attempt still blocks formal comparison labels',async()=>{
  for(const field of ['model','systemFingerprint']){
    const batch=await PB.createBatch([paper(),{...paper(),id:'comparison-paper',title:'Second synthetic source fixture'}],{...cfg,repeats:3},'Recovered identity audit');
    for(const run of batch.runs){
      run.status='success';run.result=PB.parseReview(directReview(),TEXT,MODE);
      run.attempts=[{id:run.id+'-accepted',status:'success',model:'stable-model',systemFingerprint:'stable-fingerprint'}];
    }
    const recoveredRun=batch.runs[0],attempt={id:'recovered-original-identity',status:'error',httpStatus:200,finishReason:'stop',error:'Synthetic previous source-list omission',model:'stable-model',systemFingerprint:'stable-fingerprint',
      responseBody:JSON.stringify({model:'stable-model',system_fingerprint:'stable-fingerprint',choices:[{finish_reason:'stop',message:{content:JSON.stringify(legacyOmittedSource())}}]})};
    attempt[field]=field==='model'?'different-model':'different-fingerprint';
    const envelope=JSON.parse(attempt.responseBody);envelope.model=attempt.model;envelope.system_fingerprint=attempt.systemFingerprint;attempt.responseBody=JSON.stringify(envelope);
    recoveredRun.status='error';recoveredRun.error=attempt.error;delete recoveredRun.result;recoveredRun.attempts=[attempt];batch.status='paused';
    assert.deepEqual(PB.recoverBatchLocally(batch),{recovered:1,remainingFailed:0});
    assert.equal(attempt.status,'error');
    const rows=PB.compare(batch,'direct-paper');assert.equal(rows.length,5);
    for(const row of rows){
      assert.equal(row.complete,true);assert.equal(row.drift,true);assert.equal(row.label,'服务端漂移，需重评');
      assert.equal((field==='model'?row.driftModels:row.driftFingerprints).length,2);
    }
    const noRecovery=clone(batch);delete noRecovery.runs[0].localRecovery;
    for(const run of noRecovery.runs)run.attempts.unshift({status:'error',model:'unrelated-failed-model',systemFingerprint:'unrelated-failed-fingerprint'});
    assert.ok(PB.compare(noRecovery,'direct-paper').every(row=>row.drift===false),'Unaccepted error attempts, including missing IDs, do not authorize identity statistics');
  }
});
