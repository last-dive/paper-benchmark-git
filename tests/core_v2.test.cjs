'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
require('./core.js');const PB=globalThis.PB;
const {makeV2Review,TEXT}=require('./v2_fixture.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function makeArchive(result=PB.parseReviewV2(makeV2Review(),TEXT)) {
  const paper={id:'p1',title:'测试材料',group:'',version:'v2',kind:'draft',change:'other',text:TEXT};
  const b={id:'b1',name:'v2测试',createdAt:'2026-09-08T00:00:00Z',status:'paused',config:{repeats:3,paperType:'theory',thinking:'enabled',reasoningEffort:'low',doSample:true},papers:[paper],protocol:{id:'PB2-test',reviewSchemaVersion:2,rubricVersion:PB.RUBRIC_VERSION,systemPrompt:PB.makeSystemPrompt('theory')},runs:[{id:'r1',paperId:'p1',round:1,status:'success',attempts:[],result}]};
  return {schemaVersion:1,config:clone(b.config),papers:[paper],batches:[b],currentBatchId:'b1'};
}
function legacy(){return {dimensions:PB.DIMS.map(d=>({id:d.id,score:7,evidence:[{quote:TEXT.slice(0,25),location:'第一段'}],reason:'该研究在第一段报告了可复核的流程，仍存在报告范围局限。',improvement:'完善可见证据的学术说明和局限报告。'})),summary:'原版固定直接评分结果，仅用于兼容性测试。',limitations:'没有核实研究事实真伪。'};}
test('twenty unique fixed criteria expose five behavioral anchors and deterministic full range',()=>{
  assert.equal(PB.REVIEW_SCHEMA_VERSION,2);assert.equal(PB.RUBRIC_VERSION,'PB-RUBRIC-2.0');
  for(const d of PB.DIMS){assert.equal(PB.CRITERIA[d.id].length,4);for(const c of PB.CRITERIA[d.id])assert.deepEqual(Object.keys(c.anchors),['0','1','2','3','4']);}
  for(const [level,score]of [[0,1],[1,3.25],[2,5.5],[3,7.75],[4,10]]){
    const r=PB.parseReviewV2(makeV2Review(TEXT,{level}),TEXT);assert.ok(r.dimensions.every(d=>d.score===score));
  }
  const prompt=PB.makeSystemPrompt('theory');assert.match(prompt,/不强制要求实物实验或数值仿真/);assert.match(prompt,/不进行分数拉伸/);assert.match(prompt,/不设计新武器/);
});
test('fixed caps apply to concrete low-grade items and record uncapped formula',()=>{
  for(const [low,cap,raw]of [[0,4,7.75],[1,6,8.3125],[2,8,8.875]]){
    const input=makeV2Review(TEXT,{level:4,levels:{rigor:[low,4,4,4]}});input.dimensions[1].score=10;
    const d=PB.parseReviewV2(input,TEXT).dimensions[1];assert.equal(d.rawScore,raw);assert.equal(d.scoreCap,cap);assert.equal(d.score,cap);assert.deepEqual(d.capReasons,[{itemId:'assumptions',level:low,cap}]);
  }
});
test('unavailable material never becomes zero or an average over surviving items',()=>{
  const input=makeV2Review(TEXT,{level:4});const i=input.dimensions[0].items[0];i.level=null;i.status='unavailable';i.missing='原输入缺少可读的问题定义段落。';i.evidenceIndices=[];
  const d=PB.parseReviewV2(input,TEXT).dimensions[0];assert.equal(d.score,null);assert.equal(d.rawScore,null);assert.equal(d.items[0].effectiveLevel,null);assert.equal(d.completeness.assessedItems,3);
  i.level=0;assert.throws(()=>PB.parseReviewV2(input,TEXT),/不可见必须为null/);
});
test('each item needs its own matched referenced evidence; another item cannot rescue it',()=>{
  const input=makeV2Review(TEXT,{level:4}),d=input.dimensions[0];d.evidence.push({quote:'完全不存在于原材料中的连续测试引文',location:'不可见段落'});d.items[0].evidenceIndices=[1];
  const r=PB.parseReviewV2(input,TEXT),out=r.dimensions[0];assert.equal(out.score,null);assert.equal(out.items[0].level,4);assert.equal(out.items[0].effectiveLevel,null);assert.deepEqual(out.completeness.unmatchedItems,['problem']);assert.ok(r.warnings.some(w=>w.includes('contribution.problem')));
  d.items[0].evidenceIndices=[0,1];assert.equal(PB.parseReviewV2(input,TEXT).dimensions[0].score,10);
});
test('discrete levels, exact IDs, item count and zero-based references are validated',()=>{
  for(const mutate of [r=>r.dimensions[0].items.pop(),r=>r.dimensions[0].items[0].level=2.5,r=>r.dimensions[0].items[0].level='3',r=>r.dimensions[0].items[0].id='novelty',r=>r.dimensions[0].items[0].evidenceIndices=[1],r=>r.dimensions[0].items[0].evidenceIndices=[],r=>r.dimensions[0].items[0].evidenceIndices=[0,0]]){
    const r=makeV2Review();mutate(r);assert.throws(()=>PB.parseReviewV2(r,TEXT));
  }
});
test('claim audit, strongest evidence and prioritized revision are mandatory and referenced',()=>{
  for(const mutate of [r=>delete r.analysis,r=>r.analysis.centralClaims=[],r=>delete r.analysis.strongestChallenge,r=>r.analysis.centralClaims[0].evidenceRefs[0].evidenceIndex=99,r=>r.revisions=[],r=>r.revisions[0].claimIds=['C99']]){
    const r=makeV2Review();mutate(r);assert.throws(()=>PB.parseReviewV2(r,TEXT));
  }
  const r=PB.parseReviewV2(makeV2Review(),TEXT);assert.equal(r.analysis.centralClaims[0].citationStatus,'matched_text_only');assert.equal(r.analysis.strongestChallenge.citationStatus,'unverified');
});
test('expectedVersion prevents silent downgrade while default parser retains legacy scores',()=>{
  const old=legacy();assert.equal(PB.parseReview(old,TEXT).dimensions[0].score,7);
  assert.throws(()=>PB.parseReview(old,TEXT,{expectedVersion:2}),/版本不符/);
  assert.throws(()=>PB.parseReviewV2(old,TEXT),/降级/);
  assert.throws(()=>PB.parseReview({...old,schemaVersion:99},TEXT),/schemaVersion/);
  assert.throws(()=>PB.parseReview(makeV2Review(),TEXT,{expectedVersion:1}),/混用/);
});
test('v2 normalized reparse and archive round-trip preserve all analysis and computed results',()=>{
  const input=makeV2Review(TEXT,{level:4,levels:{rigor:[1,4,4,4]}}),r=PB.parseReviewV2(input,TEXT);
  assert.deepEqual(PB.parseReviewV2(r,TEXT),r);
  const state=PB.validateArchive(makeArchive(r)),exported=PB.exportArchive(state),restored=PB.validateArchive(exported);
  assert.deepEqual(restored.batches[0].runs[0].result,r);
  const tampered=clone(r);tampered.dimensions[1].score=10;tampered.dimensions[1].items[0].effectiveLevel=4;tampered.dimensions[1].scoreCap=10;
  assert.equal(PB.parseReviewV2(tampered,TEXT).dimensions[1].score,6);
});
test('mixed v1/v2 batches and protocol mismatches cannot be imported or summarized',()=>{
  const state=makeArchive(),b=state.batches[0];b.runs.push({...clone(b.runs[0]),id:'r2',round:2,result:legacy()});
  assert.throws(()=>PB.validateArchive(state),/不能混用/);assert.throws(()=>PB.summarize(b,'p1'),/不能混用/);
  const wrong=makeArchive(legacy());assert.throws(()=>PB.validateArchive(wrong),/协议版本不符/);
});
test('thinking configuration is validated while legacy missing fields remain unchanged',()=>{
  for(const [field,value]of [['thinking','enabled'],['reasoningEffort','low'],['doSample',false]]){const a=makeArchive();a.config[field]=value;assert.equal(PB.validateArchive(a).config[field],value);}
  for(const [field,value]of [['thinking',true],['reasoningEffort','medium'],['doSample','true']]){const a=makeArchive();a.config[field]=value;assert.throws(()=>PB.validateArchive(a));}
  const a=makeArchive();for(const x of ['thinking','reasoningEffort','doSample']){delete a.config[x];delete a.batches[0].config[x];}assert.equal(PB.validateArchive(a).config.thinking,undefined);
});
test('legacy real multimodal run01 and run02 remain importable without score changes',()=>{
  const base='/home/xx/chatgpt/codex/paper_benchmark_live/';
  for(const dir of ['2026-09-08__glm-5.3-flash__TAES10__multimodal__R05__run01','2026-09-08__glm-5.3-flash__TAES10__multimodal_low__R05__run02']){
    const file=base+dir+'/archive.json';if(!fs.existsSync(file))continue;
    const raw=JSON.parse(fs.readFileSync(file,'utf8')),clean=PB.validateArchive(raw);
    for(const b of raw.batches)for(const r of b.runs.filter(r=>r.status==='success')){const out=clean.batches.find(x=>x.id===b.id).runs.find(x=>x.id===r.id);assert.deepEqual(out.result.dimensions.map(d=>d.score),r.result.dimensions.map(d=>d.score));}
  }
});
test('v2 criterion repetition summaries are separate from dimension-score statistics',()=>{
  const a=makeArchive(),b=a.batches[0];b.runs=[2,3,4].map((level,i)=>({id:`r${i}`,paperId:'p1',round:i+1,status:'success',attempts:[],result:PB.parseReviewV2(makeV2Review(TEXT,{level}),TEXT)}));
  const s=PB.summarize(b,'p1');assert.equal(s.criteria.rigor.assumptions.sd,1);assert.equal(s.criteria.rigor.assumptions.n,3);assert.equal(s.dimensions.rigor.sd,2.25);assert.equal(s.stability.flaggedDimensions.length,5);
  assert.deepEqual(s.criteria.rigor.assumptions.levelCounts,{'0':0,'1':0,'2':1,'3':1,'4':1});
});
test('v2 removes only one or two extra closing delimiters after a complete strict object',()=>{
  const text=JSON.stringify(makeV2Review()),expected=PB.parseReviewV2(text,TEXT);
  for(const suffix of ['}',']','}}',']}', '} ]\n',' \n}\n \t]\r\n']){
    const raw=text+suffix,parsed=PB.parseReviewV2(raw,TEXT);
    assert.deepEqual(parsed.dimensions,expected.dimensions);
    assert.equal(parsed.normalization.removedCloserCount,(suffix.match(/[}\]]/g)||[]).length);
    assert.equal(raw.slice(0,parsed.normalization.normalizedLength)+parsed.normalization.removedSuffix,raw);
    assert.equal(parsed.formatWarnings.length,1);assert.ok(parsed.warnings.includes(parsed.formatWarnings[0]));
    assert.deepEqual(PB.parseReviewV2(parsed,TEXT),parsed);
    assert.deepEqual(PB.validateArchive(PB.exportArchive(PB.validateArchive(makeArchive(parsed)))).batches[0].runs[0].result,parsed);
  }
  assert.equal(expected.normalization,null);assert.deepEqual(expected.formatWarnings,[]);
});
test('format compatibility rejects trailing prose, another value, code and internal JSON defects; legacy stays strict',()=>{
  const raw=JSON.stringify(makeV2Review());
  for(const suffix of ['}}}',']]]',' trailing','{}',' null',';alert(1)','}\nsecond','},','} // comment'])assert.throws(()=>PB.parseReviewV2(raw+suffix,TEXT),/严格JSON/);
  assert.throws(()=>PB.parseReviewV2('```json\n'+raw+'\n```',TEXT),/严格JSON/);
  assert.throws(()=>PB.parseReviewV2(raw.replace('"schemaVersion":2','"schemaVersion":2,')+'}',TEXT),/严格JSON/);
  const wrong=makeV2Review();wrong.dimensions[0].items[0].level='3';
  assert.throws(()=>PB.parseReviewV2(JSON.stringify(wrong)+'}',TEXT),/level/);
  assert.throws(()=>PB.parseReview(JSON.stringify(legacy())+'}',TEXT),/严格JSON/);
  assert.throws(()=>PB.parseReview(JSON.stringify({...legacy(),schemaVersion:1})+']',TEXT),/严格JSON/);
});
test('three-character counterEvidence is accepted but still requires explicit scope in the prompt',()=>{
  const r=makeV2Review();r.analysis.centralClaims[0].counterEvidence='未发现';
  assert.equal(PB.parseReviewV2(r,TEXT).analysis.centralClaims[0].counterEvidence,'未发现');
  r.analysis.centralClaims[0].counterEvidence='没有';assert.throws(()=>PB.parseReviewV2(r,TEXT),/反证审查/);
  assert.match(PB.makeSystemPrompt('theory'),/注明所审查材料和主张范围/);
  assert.match(PB.makeSystemPrompt(),/20–120字符/);assert.match(PB.makeSystemPrompt(),/不能为凑匹配引用无关正文/);
});
test('v2 word-break matching handles join and retained hyphens in source or quote with original text preserved',()=>{
  const cases=[
    ['A complete inter-\nception argument is available.','complete interception argument'],
    ['A complete time-\r\nvarying argument is available.','complete time-varying argument'],
    ['A complete interception argument is available.','complete inter-\nception argument'],
    ['A complete time-varying argument is available.','complete time-\nvarying argument'],
    ['A complete inter-\r\nception argument is available.','complete inter-\nception argument'],
  ];
  for(const [source,quote]of cases){
    const r=makeV2Review(source,{quote}),parsed=PB.parseReviewV2(r,source),e=parsed.dimensions[0].evidence[0];
    assert.equal(e.quote,quote);assert.equal(e.matched,true);assert.ok(e.matchedMethod);
    assert.deepEqual(PB.parseReviewV2(parsed,source),parsed);
    if(!source.replace(/\s+/g,' ').includes(quote.replace(/\s+/g,' ')))assert.match(e.matchedMethod,/linebreak_hyphen/);
  }
});
test('v2 matching does not remove inline hyphens, change math symbols or turn v1 matches permissive',()=>{
  for(const [source,quote]of [
    ['The time-varying argument is valid.','timevarying argument'],
    ['The inter- ception argument is valid.','interception argument'],
    ['The α-\nβ expression is valid.','αβ expression'],
    ['The x-\ny expression is valid.','xy expression'],
    ['The inter−\nception argument is valid.','interception argument'],
    ['The value ≤ 0 appears here.','value = 0 appears'],
  ]){
    const parsed=PB.parseReviewV2(makeV2Review(source,{quote}),source);
    assert.equal(parsed.dimensions[0].evidence[0].matched,false);assert.equal(parsed.dimensions[0].score,null);
  }
  const old=legacy();old.dimensions.forEach(d=>d.evidence=[{quote:'complete interception argument',location:'paragraph'}]);
  const out=PB.parseReview(old,'A complete inter-\nception argument is available.');assert.equal(out.dimensions[0].score,null);assert.equal(out.dimensions[0].evidence[0].matched,false);
});

test('three-character alternativeExplanations matches counterEvidence without relaxing structure or scoring',()=>{
  const r=makeV2Review();r.analysis.centralClaims[0].alternativeExplanations='未发现';
  const out=PB.parseReviewV2(r,TEXT);assert.equal(out.analysis.centralClaims[0].alternativeExplanations,'未发现');assert.equal(out.dimensions[0].score,7.75);
  assert.equal(PB.REVIEW_PARSER_VERSION,'PB-PARSER-2.4');
  r.analysis.centralClaims[0].alternativeExplanations='没有';assert.throws(()=>PB.parseReviewV2(r,TEXT),/替代解释审查/);
  assert.match(PB.makeSystemPrompt(),/所审查材料和主张范围以及该判断的依据/);
});
