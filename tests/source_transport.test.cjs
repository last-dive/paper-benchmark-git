'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { makeV2Review } = require('./v2_fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const TEXT = 'The first physical page records a complete synthetic source paragraph, with V̇ ≤ 0 and a 90◦ angle kept exactly for software verification.\fThe second page provides another independent paragraph of synthetic text. These are software fixtures, not real research findings.';
const paper = () => ({ id:'paper-source',title:'Synthetic source review',group:'',version:'test',kind:'draft',change:'other',text:TEXT });
function env() {
  const context = vm.createContext({ URL, AbortController, TextEncoder, Uint8Array, Uint32Array, DataView, crypto:webcrypto, setTimeout, clearTimeout, fetch:async()=>{throw new Error('Unexpected network request');} });
  for (const file of ['core.js','transport.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context);
  return { context, PB:context.PB };
}
const config = extra => ({ inputMode:'text',endpoint:'https://source-test.invalid/v1',model:'mock-source-model',repeats:1,concurrency:1,retries:0,timeout:120,...extra });
function review(PB, text=TEXT) {
  const result=makeV2Review(text),source=PB.buildSourceCatalog(text)[0];
  for(const dimension of result.dimensions)dimension.evidence=[{sourceId:source.id}];
  return result;
}
function response(result) {
  return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({model:'mock-source-model',usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200},choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};
}
const state = (PB,batch) => PB.exportArchive({schemaVersion:1,config:batch.config,papers:batch.papers,batches:[batch],currentBatchId:batch.id});

test('source-indexed request sends deterministic exact text and source hash under the frozen catalog version',async()=>{
  const {PB,context}=env();
  const batch=await PB.createBatch([paper()],config(),'source request');
  assert.equal(batch.protocol.citationMode,'source_ids_v1');
  assert.equal(batch.protocol.sourceCatalogVersion,PB.SOURCE_CATALOG_VERSION);
  let calls=0;
  context.fetch=async(_,options)=>{
    calls++;
    const body=JSON.parse(options.body),content=body.messages[1].content;
    assert.equal(body.messages.length,2);
    assert.ok(content.includes(batch.papers[0].hash));
    assert.ok(content.includes(PB.SOURCE_CATALOG_VERSION));
    assert.ok(content.includes('source_catalog'));
    for(const entry of PB.buildSourceCatalog(TEXT)){
      assert.ok(content.includes(JSON.stringify(entry.quote)));
      assert.ok(content.includes(`"sourceId":"${entry.id}"`));
    }
    return response(review(PB));
  };
  await PB.runBatch(batch,'mock-secret');
  assert.equal(calls,1);
  assert.equal(batch.status,'complete');
  assert.ok(batch.runs[0].result.dimensions.every(d=>d.score===7.75));
  assert.ok(!JSON.stringify(state(PB,batch)).includes('mock-secret'));
});

test('archive round trip preserves indexed evidence, exact locations, original attempts and ancillary warnings',async()=>{
  const {PB,context}=env();
  const batch=await PB.createBatch([paper()],config(),'source round trip');
  const raw=review(PB);raw.revisions[0].priority=4;
  context.fetch=async()=>response(raw);
  await PB.runBatch(batch,'mock-secret');
  const initial=plain(batch.runs[0].result),attempts=plain(batch.runs[0].attempts);
  const imported=PB.validateArchive(state(PB,batch));
  assert.deepEqual(plain(imported.batches[0].runs[0].result),initial);
  assert.deepEqual(plain(imported.batches[0].runs[0].attempts),attempts);
  assert.deepEqual(plain(PB.validateArchive(PB.exportArchive(imported)).batches[0].runs[0].result),initial);
  let resumedCalls=0;context.fetch=async()=>{resumedCalls++;throw new Error('Completed batch must not call API');};
  await PB.runBatch(imported.batches[0],'mock-secret');
  assert.equal(resumedCalls,0);
});

test('archive import restores canonical source text and computed scores instead of trusting stored display fields',async()=>{
  const {PB,context}=env();
  const batch=await PB.createBatch([paper()],config(),'tampered display');
  context.fetch=async()=>response(review(PB));await PB.runBatch(batch,'mock-secret');
  const archived=state(PB,batch),dim=archived.batches[0].runs[0].result.dimensions[0];
  dim.score=10;dim.rawScore=10;dim.evidence[0].quote='Fabricated replacement for genuine source text.';dim.evidence[0].sourceStart=99999;dim.evidence[0].location='Invented page 999';
  const parsed=PB.validateArchive(archived).batches[0].runs[0].result.dimensions[0];
  const source=PB.buildSourceCatalog(TEXT)[0];
  assert.equal(parsed.score,7.75);assert.equal(parsed.evidence[0].quote,source.quote);assert.equal(parsed.evidence[0].sourceStart,source.start);
  assert.notEqual(parsed.evidence[0].location,'Invented page 999');
});

test('archive import rejects nonexistent source IDs even when stored quote and score appear valid',async()=>{
  const {PB,context}=env();const batch=await PB.createBatch([paper()],config(),'bad source ID');
  context.fetch=async()=>response(review(PB));await PB.runBatch(batch,'mock-secret');
  const archived=state(PB,batch);archived.batches[0].runs[0].result.dimensions[0].evidence[0].sourceId='Q99999';
  assert.throws(()=>PB.validateArchive(archived),/sourceId/);
});

test('changed source text, its hash, PDF identity, or the citation protocol stops execution before any model request',async()=>{
  const {PB,context}=env();
  const batch=await PB.createBatch([paper()],config(),'tampered snapshot');
  let requests=0;context.fetch=async()=>{requests++;return response(review(PB));};
  const mutations=[
    b=>b.papers[0].text+=' modified',
    b=>b.papers[0].hash='0'.repeat(64),
    async b=>{b.papers[0].text+=' modified';b.papers[0].hash=await PB.hashText(b.papers[0].text);},
    b=>b.protocol.citationMode='source_ids_v2',
    b=>b.protocol.sourceCatalogVersion='PB-SOURCES-99.0',
    b=>b.papers[0].pdf={sha256:'1'.repeat(64),size:100},
  ];
  for(const mutate of mutations){const changed=plain(batch);await mutate(changed);await assert.rejects(PB.runBatch(changed,'mock-secret'));}
  assert.equal(requests,0);
});

test('new mode cannot silently replace the frozen schema or accept missing source material before batch creation',async()=>{
  const {PB,context}=env();let calls=0;context.fetch=async()=>{calls++;throw new Error('Unexpected request');};
  await assert.rejects(PB.createBatch([{...paper(),text:'',pdf:{sha256:'1'.repeat(64),size:100}}],config({inputMode:'pdf'}),'missing text'),/索引/);
  const batch=await PB.createBatch([paper()],config(),'schema isolation');
  const changed=plain(batch);changed.protocol.reviewSchemaVersion=1;
  await assert.rejects(PB.runBatch(changed,'mock-secret'));
  assert.equal(calls,0);
});

test('archive round trip retains invalid auxiliary fields as warnings and never turns bad refs into matched evidence',async()=>{
  const {PB,context}=env();const batch=await PB.createBatch([paper()],config(),'auxiliary audit');
  const raw=review(PB);
  raw.analysis.centralClaims[0].verdict='uncertain';
  raw.analysis.centralClaims[0].evidenceRefs=[{dimensionId:'evidence',evidenceIndex:99}];
  raw.analysis.strongestSupport.evidenceRefs='wrong-array';
  raw.revisions[0].priority=4;
  context.fetch=async()=>response(raw);await PB.runBatch(batch,'mock-secret');
  const original=plain(batch.runs[0].result);
  assert.ok(original.dimensions.every(d=>d.score===7.75));
  assert.equal(original.analysis.centralClaims[0].matchedEvidenceCount,0);
  assert.equal(original.analysis.strongestSupport.matchedEvidenceCount,0);
  assert.equal(original.metadataWarnings.length,4);
  const imported=PB.validateArchive(state(PB,batch));
  assert.deepEqual(plain(imported.batches[0].runs[0].result),original);
  assert.deepEqual(plain(PB.validateArchive(PB.exportArchive(imported)).batches[0].runs[0].result),original);
});

test('indexed archive import refuses modified source text before rebuilding supposedly exact source quotations',async()=>{
  const {PB,context}=env();const batch=await PB.createBatch([paper()],config(),'source hash audit');
  context.fetch=async()=>response(review(PB));await PB.runBatch(batch,'mock-secret');
  const archived=state(PB,batch);archived.batches[0].papers[0].text='Changed source that must not be substituted into an old claim. '+TEXT;
  assert.throws(()=>PB.validateArchive(archived));
});

test('a correctly hashed future catalog version cannot run under the current catalog algorithm',async()=>{
  const {PB,context}=env();const originalVersion=PB.SOURCE_CATALOG_VERSION;
  PB.SOURCE_CATALOG_VERSION='PB-SOURCES-99.0';
  const future=await PB.createBatch([paper()],config(),'future catalog');
  PB.SOURCE_CATALOG_VERSION=originalVersion;
  let calls=0;context.fetch=async()=>{calls++;return response(review(PB));};
  await assert.rejects(PB.runBatch(future,'mock-secret'));
  assert.equal(calls,0);
});

async function preparedPaper(PB) {
  const p=paper();
  p.text='# MinerU document\n\nThis complete Markdown is the exact converted document; equations $a=b$ and table content are retained for local verification.';
  p.preparation={method:'mineru',conversionId:'conversion_test_01',pdfSha256:'a'.repeat(64),markdownSha256:await PB.hashText(p.text),markdownPath:'/tmp/mineru/source/hybrid_auto/source.md',conversionDir:'/tmp/mineru',version:'3.4.5',gpu:{name:'NVIDIA GeForce RTX 5060 Ti',index:0},assets:[{relativePath:'source.md',bytes:1}]};
  return p;
}
test('MinerU batch freezes exact Markdown provenance, sends text only, and preserves it through archive resume',async()=>{
  const {PB,context}=env(),p=await preparedPaper(PB),b=await PB.createBatch([p],config(),'MinerU verification');
  assert.equal(b.protocol.inputPreparationPolicy,'mineru_markdown_v1');assert.ok(!b.papers[0].pdf);assert.ok(!b.papers[0].preparation.assets);
  assert.equal(b.papers[0].hash,p.preparation.markdownSha256);assert.ok(Object.isFrozen(b.papers[0].preparation));
  const loaded=PB.validateArchive(state(PB,b)).batches[0];assert.deepEqual(plain(loaded.papers[0].preparation),plain(b.papers[0].preparation));
  let calls=0;context.fetch=async(_,options)=>{calls++;const request=JSON.parse(options.body);assert.equal(typeof request.messages[1].content,'string');assert.ok(!JSON.stringify(request).includes('file_url'));assert.ok(request.messages[1].content.includes(JSON.stringify(p.text).slice(1,-1)));return response(review(PB,p.text));};
  await PB.runBatch(loaded,'test-only');assert.equal(calls,1);assert.equal(loaded.runs[0].status,'success');
});
test('MinerU changed MD, original PDF mixing, and metadata tampering are rejected before requests',async()=>{
  const {PB,context}=env(),p=await preparedPaper(PB);let calls=0;context.fetch=async()=>{calls++;throw Error('must not call');};
  await assert.rejects(PB.createBatch([{...p,text:p.text+'edited'}],config(),'bad'),/哈希/);
  await assert.rejects(PB.createBatch([{...p,pdf:{sha256:'a'.repeat(64),size:30}}],config({inputMode:'pdf'}),'bad'),/MinerU/);
  const b=plain(await PB.createBatch([p],config(),'valid'));
  b.papers[0].preparation.version='changed';await assert.rejects(PB.runBatch(b,'test-only'),/MinerU来源/);
  const raw=state(PB,await PB.createBatch([p],config(),'valid'));raw.batches[0].papers[0].preparation.markdownSha256='b'.repeat(64);
  assert.throws(()=>PB.validateArchive(raw),/Markdown哈希/);assert.equal(calls,0);
});
