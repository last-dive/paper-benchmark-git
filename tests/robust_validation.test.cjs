'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
require('./core.js');require('./transport.js');const PB=globalThis.PB;
const {makeV2Review}=require('./v2_fixture.cjs');
const MODE={expectedVersion:2,citationMode:'source_ids_v1',validationPolicy:'field_isolation_v1'};
const STRICT={expectedVersion:2,citationMode:'source_ids_v1'};
const TEXT=Array.from({length:270},(_,n)=>`Synthetic physical page ${n+1}. This distinct source paragraph exists solely to verify software validation and citation handling. It does not assert research findings, measurements, or engineering performance.`).join('\f');
const sourceIds=()=>PB.buildSourceCatalog(TEXT).map(x=>x.id);
const clone=x=>JSON.parse(JSON.stringify(x));
function review(){
  const input=makeV2Review(TEXT),ids=sourceIds();
  for(const d of input.dimensions){delete d.evidence;for(const [n,item]of d.items.entries()){delete item.evidenceIndices;item.sourceIds=[ids[n]];}}
  for(const x of [...input.analysis.centralClaims,input.analysis.strongestSupport,input.analysis.strongestChallenge]){delete x.evidenceRefs;x.sourceIds=[ids[0]];}
  return input;
}
const parse=input=>PB.parseReview(input,TEXT,MODE);
const grades=result=>result.dimensions.map(d=>d.score);
function assertAudit(result){assert.equal(result.validation.policy,'field_isolation_v1');assert.ok(Array.isArray(result.validation.issues));for(const issue of result.validation.issues){assert.ok(['warning','error'].includes(issue.severity));assert.equal(typeof issue.path,'string');assert.equal(typeof issue.code,'string');assert.equal(typeof issue.message,'string');}}
function invalid(result,dimensionId,itemId,reportedLevel){
  const dim=result.dimensions.find(d=>d.id===dimensionId),item=dim.items.find(i=>i.id===itemId);
  assert.equal(dim.score,null);assert.equal(item.status,'invalid');assert.equal(item.level,null);assert.equal(item.effectiveLevel,null);assert.equal(item.scorable,false);
  if(arguments.length===4)assert.deepEqual(item.reportedLevel,reportedLevel);
  assert.ok(item.validationIssues.length>0);
  assert.ok(result.validation.invalidItems.some(i=>i.dimensionId===dimensionId&&i.itemId===itemId));
  return item;
}

test('the real failure structure is losslessly normalized: six valid sources plus five empty non-rubric placeholders',()=>{
  const raw=review();raw.dimensions[1].items[1].sourceIds=sourceIds().slice(0,6);
  for(const d of raw.dimensions)d.items.push({id:'reason_placeholder',level:null,status:'unavailable',basis:'',missing:'',sourceIds:[]});
  const before=clone(raw),parsed=parse(raw);
  assert.deepEqual(raw,before);assert.deepEqual(parsed.validation.rawReview,before);assertAudit(parsed);
  assert.deepEqual(grades(parsed),[7.75,7.75,7.75,7.75,7.75]);
  assert.ok(parsed.dimensions.every(d=>d.items.length===4));
  assert.deepEqual(parsed.dimensions[1].items[1].sourceIds,sourceIds().slice(0,6));
  assert.equal(parsed.validation.invalidItems.length,0);
  assert.ok(parsed.validation.issues.filter(i=>i.severity==='warning').length>=6);
  assert.deepEqual(PB.parseReview(parsed,TEXT,STRICT),parsed);
  assert.throws(()=>PB.parseReview(raw,TEXT,STRICT));
});

test('source shorthand, outer whitespace and duplicate IDs normalize with audit while preserving the evidence set',()=>{
  const raw=review(),ids=sourceIds();raw.dimensions[0].items[0].sourceIds=ids[0];
  raw.dimensions[0].items[1].sourceIds=[` ${ids[1]} `,ids[1],ids[2]];
  const parsed=parse(raw);assertAudit(parsed);
  assert.deepEqual(parsed.dimensions[0].items[0].sourceIds,[ids[0]]);
  assert.deepEqual(parsed.dimensions[0].items[1].sourceIds,[ids[1],ids[2]]);
  assert.deepEqual(grades(parsed),[7.75,7.75,7.75,7.75,7.75]);assert.ok(parsed.validation.issues.length>=2);
  assert.deepEqual(parsed.validation.rawReview,raw);
});

test('the hard resource bound preserves up to 64 valid sources per item and a 256-source dimension union without truncation',()=>{
  const raw=review(),ids=sourceIds();for(const [n,item]of raw.dimensions[0].items.entries())item.sourceIds=ids.slice(n*64,(n+1)*64);
  const parsed=parse(raw),dimension=parsed.dimensions[0];assert.equal(dimension.score,7.75);assert.equal(dimension.evidence.length,256);
  assert.deepEqual(dimension.evidence.map(e=>e.sourceId),ids.slice(0,256));
  for(const [n,item]of dimension.items.entries())assert.deepEqual(item.sourceIds,ids.slice(n*64,(n+1)*64));
  const excessive=review();excessive.dimensions[0].items[0].sourceIds=ids.slice(0,65);
  const bounded=parse(excessive);invalid(bounded,'contribution','problem',3);assert.equal(bounded.dimensions[1].score,7.75);
});

test('nonempty unknown extra rubric items are retained in raw audit but never enter the twenty fixed criterion grades',()=>{
  const raw=review();raw.dimensions[0].items.push({id:'invented_overall_metric',level:4,status:'assessable',basis:'This extra synthetic metric is outside the fixed rubric.',missing:'',sourceIds:[sourceIds()[4]]});
  const parsed=parse(raw);assert.equal(parsed.dimensions[0].items.length,4);assert.deepEqual(grades(parsed),[7.75,7.75,7.75,7.75,7.75]);
  assert.ok(parsed.validation.rawReview.dimensions[0].items.some(i=>i.id==='invented_overall_metric'));
  assert.ok(parsed.validation.issues.some(i=>i.severity==='warning'));assert.equal(parsed.validation.invalidItems.length,0);
});

test('identical duplicate known items collapse with audit; conflicting duplicates invalidate only their criterion',()=>{
  const duplicate=review();duplicate.dimensions[0].items.push(clone(duplicate.dimensions[0].items[0]));
  const merged=parse(duplicate);assert.deepEqual(grades(merged),[7.75,7.75,7.75,7.75,7.75]);assert.ok(merged.validation.issues.some(i=>i.severity==='warning'));
  const conflict=review(),second=clone(conflict.dimensions[0].items[0]);second.level=4;conflict.dimensions[0].items.push(second);
  const parsed=parse(conflict);invalid(parsed,'contribution','problem');
  assert.equal(parsed.dimensions[0].items.filter(i=>i.scorable).length,3);assert.ok(parsed.dimensions.slice(1).every(d=>d.score===7.75));
  assert.equal(parsed.validation.rawReview.dimensions[0].items.length,5);
});

test('a missing known criterion becomes explicitly invalid and cannot be replaced by an unknown extra item',()=>{
  const raw=review();raw.dimensions[0].items.shift();raw.dimensions[0].items.push({id:'problem_misspelled',level:4,status:'assessable',basis:'An unknown label cannot substitute for the missing required criterion.',missing:'',sourceIds:[sourceIds()[0]]});
  const parsed=parse(raw);invalid(parsed,'contribution','problem');assert.equal(parsed.dimensions[0].items.length,4);
  assert.ok(parsed.dimensions.slice(1).every(d=>d.score===7.75));assert.equal(parsed.validation.invalidItems.length,1);
});

test('multiple primary errors are collected in one result without changing reported levels or fabricating source support',()=>{
  const raw=review();raw.dimensions[0].items[0].level=5;
  raw.dimensions[1].items[0].sourceIds=['Q99999'];raw.dimensions[2].items[0].sourceIds=[];
  raw.dimensions[3].items[0].basis='';
  const parsed=parse(raw);assertAudit(parsed);
  invalid(parsed,'contribution','problem',5);invalid(parsed,'rigor','assumptions',3);invalid(parsed,'evidence','central_support',3);invalid(parsed,'fairness','relevance',3);
  assert.equal(parsed.validation.invalidItems.length,4);assert.ok(parsed.validation.issues.filter(i=>i.severity==='error').length>=4);
  assert.deepEqual(grades(parsed),[null,null,null,null,7.75]);assert.deepEqual(parsed.validation.rawReview,raw);
  assert.equal(parsed.dimensions.flatMap(d=>d.items).filter(i=>i.scorable).length,16);
});

test('missing dimension prose gets a visible missing-content placeholder and warning without suppressing valid criterion grades',()=>{
  const raw=review();delete raw.dimensions[0].reason;delete raw.dimensions[1].improvement;
  const parsed=parse(raw);assert.deepEqual(grades(parsed),[7.75,7.75,7.75,7.75,7.75]);
  assert.match(parsed.dimensions[0].reason,/未提供|未返回|缺失|不可用/);assert.match(parsed.dimensions[1].improvement,/未提供|未返回|缺失|不可用/);
  assert.ok(parsed.validation.issues.filter(i=>i.severity==='warning').length>=2);assert.equal(parsed.validation.invalidItems.length,0);
});

async function batchWithResult(raw){
  const paper={id:'robust-paper',title:'Synthetic robust validation',group:'',version:'test',kind:'draft',change:'other',text:TEXT};
  const batch=await PB.createBatch([paper],{inputMode:'text',endpoint:'https://robust-test.invalid/v1',model:'mock-source-model',repeats:1,concurrency:1,retries:0,timeout:120},'Robust archive fixture');
  batch.runs[0].status='success';batch.runs[0].result=parse(raw);batch.status=grades(batch.runs[0].result).every(s=>s!==null)?'complete':'paused';
  return batch;
}
const archive=batch=>PB.exportArchive({schemaVersion:1,config:batch.config,papers:batch.papers,batches:[batch],currentBatchId:batch.id});

test('two archive cycles revalidate raw review, retain all diagnostics, and ignore forged normalized grades and item source IDs',async()=>{
  const raw=review();raw.dimensions[0].items[0].sourceIds=['Q99999'];raw.dimensions[1].items.push({id:'reason_placeholder',level:null,status:'unavailable',basis:'',missing:'',sourceIds:[]});
  const batch=await batchWithResult(raw),expected=clone(batch.runs[0].result);let stored=archive(batch);
  for(let i=0;i<2;i++){
    const imported=PB.validateArchive(stored);assert.deepEqual(imported.batches[0].runs[0].result,expected);stored=PB.exportArchive(imported);
  }
  const item=stored.batches[0].runs[0].result.dimensions[0].items[0];item.level=4;item.effectiveLevel=4;item.status='assessable';item.scorable=true;item.sourceIds=[sourceIds()[0]];
  stored.batches[0].runs[0].result.dimensions[0].score=10;stored.batches[0].runs[0].result.validation.issues=[];
  const restored=PB.validateArchive(stored).batches[0].runs[0].result;
  assert.deepEqual(restored,expected);invalid(restored,'contribution','problem',3);
});

test('new field-isolation policy is explicit while old strict mode still rejects the same structural and grading errors',()=>{
  for(const mutate of [r=>r.dimensions[0].items[0].sourceIds=sourceIds().slice(0,6),r=>r.dimensions[0].items[0].level=5,r=>r.dimensions[0].items.push(clone(r.dimensions[0].items[0]))]){
    const raw=review();mutate(raw);assert.throws(()=>PB.parseReview(raw,TEXT,STRICT));assert.doesNotThrow(()=>parse(raw));
  }
});

test('an oversized item container cannot hide a conflicting tail entry while its first four items are scored',()=>{
  const raw=review(),d=raw.dimensions[0];
  for(let n=0;n<252;n++)d.items.push({id:'extra_'+n,level:null,status:'unavailable',basis:'',missing:'',sourceIds:[]});
  const conflict=clone(d.items[0]);conflict.level=4;d.items.push(conflict);
  assert.equal(d.items.length,257);
  const parsed=parse(raw);
  for(const criterion of PB.CRITERIA.contribution)invalid(parsed,'contribution',criterion.id);
  assert.ok(parsed.dimensions.slice(1).every(dim=>dim.score===7.75));
  assert.equal(parsed.validation.rawReview.dimensions[0].items.length,257);
});

test('an oversized dimension container is never prefix-truncated into an apparently complete scored review',()=>{
  const raw=review();for(let n=0;n<59;n++)raw.dimensions.push({id:'extra_dimension_'+n,items:[]});
  const conflict=clone(raw.dimensions[0]);conflict.items[0].level=4;raw.dimensions.push(conflict);
  assert.equal(raw.dimensions.length,65);
  const parsed=parse(raw);assert.deepEqual(grades(parsed),[null,null,null,null,null]);
  assert.equal(parsed.validation.invalidItems.length,20);
  assert.ok(parsed.dimensions.every(d=>d.items.every(i=>i.status==='invalid'&&i.scorable===false)));
  assert.equal(parsed.validation.rawReview.dimensions.length,65);
  assert.ok(parsed.validation.issues.some(i=>i.severity==='error'&&i.path==='dimensions'));
});

test('ID-only duplicate dimensions and criteria are ignored only beside substantive entries and retained in exact audit',()=>{
  const raw=review();raw.dimensions.push({id:'fairness'});raw.dimensions[0].items.unshift({id:'problem'});
  const original=clone(raw),parsed=parse(raw);
  assert.deepEqual(grades(parsed),[7.75,7.75,7.75,7.75,7.75]);assert.equal(parsed.validation.invalidItems.length,0);
  assert.deepEqual(raw,original);assert.deepEqual(parsed.validation.rawReview,original);
  const warnings=parsed.validation.issues.filter(i=>i.code==='empty_duplicate');assert.equal(warnings.length,2);
  assert.ok(warnings.every(i=>i.severity==='warning'));
  assert.deepEqual(warnings.find(i=>i.path==='fairness').original,{id:'fairness'});
  assert.deepEqual(warnings.find(i=>i.path==='contribution.problem').original,{id:'problem'});
  assert.deepEqual(PB.parseReview(parsed,TEXT,STRICT),parsed);
});

test('ID-only records cannot stand in for a missing substantive dimension or criterion',()=>{
  const raw=review();raw.dimensions=raw.dimensions.filter(d=>d.id!=='fairness');raw.dimensions.push({id:'fairness'},{id:'fairness'});
  raw.dimensions[0].items=raw.dimensions[0].items.filter(i=>i.id!=='problem');raw.dimensions[0].items.push({id:'problem'},{id:'problem'});
  const parsed=parse(raw);invalid(parsed,'contribution','problem');
  for(const criterion of PB.CRITERIA.fairness)invalid(parsed,'fairness',criterion.id);
  assert.deepEqual(grades(parsed),[null,7.75,7.75,null,7.75]);
  assert.ok(!parsed.validation.issues.some(i=>i.code==='empty_duplicate'),'Without substantive data, no empty duplicate is treated as successfully resolved');
});

test('ID-only duplicate normalization does not conceal actual conflicts or objects with additional empty fields',()=>{
  const raw=review(),conflict=clone(raw.dimensions[0].items[0]);conflict.level=4;
  raw.dimensions[0].items.push({id:'problem'},conflict);
  raw.dimensions.push({id:'fairness'},{id:'fairness',reason:''});
  const parsed=parse(raw);invalid(parsed,'contribution','problem');for(const criterion of PB.CRITERIA.fairness)invalid(parsed,'fairness',criterion.id);
  assert.deepEqual(grades(parsed),[null,7.75,7.75,null,7.75]);
  assert.equal(parsed.validation.issues.filter(i=>i.code==='empty_duplicate').length,2);
  assert.equal(parsed.validation.issues.filter(i=>i.code==='conflicting_duplicate').length,2);
});
