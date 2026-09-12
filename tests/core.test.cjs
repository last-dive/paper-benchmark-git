const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
require('./core.js');
const PB = globalThis.PB;
const TEXT = '第1节：本研究给出了算法完整流程。第2节：我们在三个边界条件下验证误差，并使用相同输入和计算预算进行比较。';
function review(scores = [6,6,6,6,6]) {
  return { dimensions:PB.DIMS.map((d,i) => ({ id:d.id, score:scores[i], evidence:[{ quote:'本研究给出了算法完整流程', location:'第1节' }], reason:'第1节给出了完整流程，但仍缺少初始化参数与失效条件的明确说明。', improvement:'补充算法初始化参数和失效条件的具体界定。' })), summary:'论文明确了算法流程，但复现细节仍需要补充。', limitations:'只能核对输入文本，不能验证外部实验真实性。' };
}
function paper(id) { return { id, title:id, group:'same', version:id, kind:'draft', change:'other', text:TEXT }; }
function batch(base, target, repeats = base.length, extra = false) {
  const b = { id:'batch1', name:'test', createdAt:'2026-09-07T00:00:00Z', status:'complete', config:{ repeats, paperType:'engineering' }, papers:[paper('base'),paper('target')], protocol:{ id:'PB1', systemPrompt:'固定评分协议' }, runs:[] };
  if (extra) b.papers.push(paper('missing'));
  for (const [id, values] of [['base',base],['target',target]]) values.forEach((v, i) => b.runs.push({ id:`${id}-${i+1}`, paperId:id, round:i+1, status:'success', result:review(Array.isArray(v)?v:[v,v,v,v,v]), attempts:[] }));
  return b;
}
function archive(b = batch([6,6,6],[7,7,7])) { return { schemaVersion:1, config:{ repeats:3, paperType:'engineering', apiKey:'sk-secret-example-123' }, papers:b.papers, batches:[b], currentBatchId:b.id }; }
test('fixed five-dimensional rubric and type-specific evidence with stable anchors', () => {
  assert.deepEqual(PB.DIMS.map(d=>d.id), ['contribution','rigor','evidence','fairness','claims']);
  for (const type of Object.keys(PB.TYPES)) {
    const prompt = PB.makeSystemPrompt(type, '固定的文本示例');
    for (const d of PB.DIMS) { assert.ok(prompt.includes(d.id)); for (const anchor of [1,3,5,7,9,10]) assert.ok(d.anchors[anchor]); }
    assert.ok(prompt.includes('固定的文本示例'));
  }
  assert.match(PB.makeSystemPrompt('theory'), /不强制要求实物实验/);
  assert.throws(()=>PB.makeSystemPrompt('bad'), /类型/);
});
test('strict JSON, five unique IDs, range, and substantive reason validation', () => {
  const valid = review();
  assert.equal(PB.parseReview(JSON.stringify(valid), TEXT).dimensions[0].score, 6);
  assert.throws(()=>PB.parseReview('```json\n'+JSON.stringify(valid)+'\n```',TEXT), /严格JSON/);
  for (const value of ['8',0,11,NaN,Infinity,undefined]) { const r=review(); r.dimensions[0].score=value; assert.throws(()=>PB.parseReview(r,TEXT), /分数/); }
  const duplicate=review(); duplicate.dimensions[0].id='rigor'; assert.throws(()=>PB.parseReview(duplicate,TEXT), /重复/);
  const missing=review(); missing.dimensions.pop(); assert.throws(()=>PB.parseReview(missing,TEXT), /五个/);
  const generic=review(); generic.dimensions[0].reason='非常好'; assert.throws(()=>PB.parseReview(generic,TEXT), /理由/);
});
test('unmatched quotes are visible and unscored; reported score retained; normalization handles line wraps', () => {
  const r=review(); r.dimensions[0].evidence[0].quote='输入论文并不存在这一段原文';
  const parsed=PB.parseReview(r,TEXT);
  assert.equal(parsed.dimensions[0].score,null); assert.equal(parsed.dimensions[0].reportedScore,6);
  assert.equal(parsed.dimensions[0].evidence[0].matched,false); assert.ok(parsed.warnings.length>=2);
  const partial=review(); partial.dimensions[0].evidence.push({quote:'完全不存在的另一条证据内容',location:'第9节'});
  assert.equal(PB.parseReview(partial,TEXT).dimensions[0].score,6);
  const wrapped=review(); wrapped.dimensions[0].evidence[0].quote='Algorithm X is complete';
  assert.equal(PB.parseReview(wrapped,'Algorithm\n X is complete').dimensions[0].score,6);
  const nullable=review(); nullable.dimensions[0].score=null; nullable.dimensions[0].evidence=[];
  assert.equal(PB.parseReview(nullable,TEXT).dimensions[0].score,null);
});
test('descriptive statistics use sample SD and unscaled MAD without inventing one-sample variance', () => {
  assert.equal(PB.median([]),null); assert.equal(PB.mean([null,2,4]),3); assert.equal(PB.median([9,2,4,1]),3);
  assert.equal(PB.sd([5]),null); assert.equal(PB.sd([1,2,3]),1); assert.equal(PB.mad([1,2,3]),1);
  assert.equal(PB.sd([6,6,6]),0);
});
test('total is median of complete per-round means; incomplete rounds excluded only from total', () => {
  const b=batch([[1,9,9,9,9],[9,1,9,9,9],[9,9,1,9,9]],[6,6,6]);
  let summary=PB.summarize(b,'base');
  assert.equal(summary.total,7.4); assert.equal(summary.dimensions.contribution.median,9);
  b.runs[0].result.dimensions[0].score=null;
  summary=PB.summarize(b,'base'); assert.equal(summary.completeRuns,2); assert.equal(summary.successRuns,3); assert.equal(summary.dimensions.contribution.n,2);
});
test('comparison delta is median of scheduled round differences, not difference of medians', () => {
  const rows=PB.compare(batch([1,9,9],[2,3,10]),'base');
  assert.equal(rows[0].delta,1); assert.deepEqual(rows[0].diffs,[1,-6,1]);
  assert.equal(rows[0].label,'方向倾向（证据不足）'); assert.deepEqual(rows[0].ci,[-9,9]);
});
test('exact threshold sign test counts ties and non-supports conservatively and doubles directional choice', () => {
  const b=batch(Array(8).fill(6),Array(8).fill(8));
  let row=PB.compare(b,'base')[0]; assert.equal(row.p,2/256); assert.equal(row.pAdjusted,10/256); assert.equal(row.label,'显著改进'); assert.deepEqual(row.ci,[2,2]); assert.equal(row.zeroVariance,true);
  row=PB.compare(batch(Array(8).fill(8),Array(8).fill(6)),'base')[0]; assert.equal(row.label,'显著退步');
  row=PB.compare(batch(Array(8).fill(6.6),Array(8).fill(7.1)),'base')[0]; assert.equal(row.p,1); assert.equal(row.aboveThreshold,0); assert.equal(row.label,'阈值内/方向不稳');
  row=PB.compare(batch(Array(8).fill(6),[8,8,8,8,8,8,6.5,6.5]),'base')[0]; assert.equal(row.p,2*(28+8+1)/256); assert.equal(row.n,8);
});
test('Holm family includes all targets and all dimensions, even missing ones; incomplete plans never significant', () => {
  let row=PB.compare(batch(Array(8).fill(6),Array(8).fill(8),8,true),'base')[0];
  assert.equal(row.familySize,10); assert.equal(row.pAdjusted,20/256); assert.equal(row.label,'复评未完成'); assert.deepEqual(row.ci,[-9,9]);
  row=PB.compare(batch(Array(8).fill(6),Array(8).fill(8),9),'base')[0]; assert.equal(row.complete,false); assert.equal(row.label,'复评未完成');
  const b=batch([6,6,6],[8,8,8]); b.runs.filter(r=>r.paperId==='target').forEach(r=>r.result.dimensions[0].score=null);
  row=PB.compare(b,'base')[0]; assert.equal(row.n,0); assert.equal(row.delta,null); assert.equal(row.p,1); assert.equal(row.label,'无有效样本');
});
test('a paused batch or failures anywhere in the planned family block all significant labels', () => {
  for(const status of ['running','paused','ready']) {
    const b=batch(Array(12).fill(6),Array(12).fill(8)); b.status=status;
    const row=PB.compare(b,'base')[0]; assert.equal(row.n,12); assert.equal(row.complete,false); assert.equal(row.label,'复评未完成');
  }
  const b=batch(Array(12).fill(6),Array(12).fill(8),12,true);
  for(let i=1;i<=12;i++) b.runs.push({id:'missing-'+i,paperId:'missing',round:i,status:i===12?'error':'success',result:review(),attempts:[]});
  let row=PB.compare(b,'base')[0]; assert.ok(row.pAdjusted<.05); assert.equal(row.n,12); assert.equal(row.label,'复评未完成');
  b.runs.at(-1).status='success'; row=PB.compare(b,'base')[0]; assert.equal(row.label,'显著改进');
});
test('known successful backend model or fingerprint drift blocks formal inference, while failed attempts do not', () => {
  for(const key of ['model','systemFingerprint']) {
    const b=batch(Array(12).fill(6),Array(12).fill(8));
    b.runs.forEach(r=>r.attempts=[{status:'success',model:'same-model',systemFingerprint:'same-fingerprint'}]);
    b.runs.at(-1).attempts[0][key]='changed-value';
    let row=PB.compare(b,'base')[0]; assert.ok(row.pAdjusted<.05); assert.equal(row.complete,true); assert.equal(row.drift,true); assert.equal(row.label,'服务端漂移，需重评');
    b.runs.at(-1).attempts[0][key]=key==='model'?'same-model':'same-fingerprint';
    b.runs.at(-1).attempts.unshift({status:'error',model:'failed-other-model',systemFingerprint:'failed-other-fingerprint'});
    row=PB.compare(b,'base')[0]; assert.equal(row.drift,false); assert.equal(row.label,'显著改进');
  }
});
test('order statistic CI covers nominal family confidence and never excludes range at tiny n', () => {
  function choose(n,k) { let x=1; for(let i=1;i<=k;i++) x=x*(n-i+1)/i; return x; }
  for(let n=3;n<=30;n++) {
    const vals=Array.from({length:n},(_,i)=>1+8*i/(n-1));
    const row=PB.compare(batch(Array(n).fill(1),vals),'base')[0];
    if(n<=7) assert.deepEqual(row.ci,[-9,9]);
    assert.ok(row.ci[0] <= row.delta && row.ci[1]>=row.delta);
    if(row.ci[0]>-9) {
      const k=vals.findIndex(v=>Math.abs(v-1-row.ci[0])<1e-10)+1;
      let lowerTail=0; for(let j=0;j<k;j++) lowerTail+=choose(n,j)/2**n;
      assert.ok(1-2*lowerTail >= 0.99-1e-12);
      assert.ok(1-2*(lowerTail+choose(n,k)/2**n) < 0.99);
    }
  }
});
test('CSV prevents spreadsheet formula injection while preserving numeric negative deltas', () => {
  const result=PB.csv([['=HYPERLINK("https://bad")',' +cmd','@evil','plain,comma','quote"test',-1.5,null]]);
  assert.ok(result.startsWith('\uFEFF')); assert.ok(result.includes('"\'=HYPERLINK')); assert.ok(result.includes('"\' +cmd"')); assert.ok(result.includes('"\'@evil"')); assert.ok(result.includes('"-1.5"')); assert.ok(result.includes('"quote""test"'));
});
test('SHA256 agrees with known implementation including Unicode and padding boundaries', async () => {
  const context=vm.createContext({TextEncoder});
  vm.runInContext(fs.readFileSync(require.resolve('./core.js'),'utf8'),context);
  for(const input of ['', 'abc','论文原文🧪', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)]) {
    assert.equal(await PB.hashText(input),crypto.createHash('sha256').update(input).digest('hex'));
    assert.equal(await context.PB.hashText(input),crypto.createHash('sha256').update(input).digest('hex'));
  }
});
test('archive import validates references, IDs, rounds, scores and replausibilizes quote matches', () => {
  const good=archive(); const valid=PB.validateArchive(good); assert.equal(valid.config.apiKey,undefined); assert.equal(valid.batches[0].runs[0].result.dimensions[0].evidence[0].matched,true);
  for(const mutate of [
    a=>a.batches[0].runs[0].paperId='unknown',
    a=>a.batches[0].runs[0].round=50,
    a=>a.batches[0].runs[0].result.dimensions[0].score=99,
    a=>a.batches[0].runs[0].result=null,
    a=>a.batches[0].runs[1].id=a.batches[0].runs[0].id,
    a=>a.batches[0].runs[1].round=a.batches[0].runs[0].round,
    a=>a.batches[0].papers[1].id=a.batches[0].papers[0].id,
    a=>a.config.repeats=31,
    a=>a.currentBatchId='missing',
    a=>a.papers[0].text='x'.repeat(2000001),
  ]) { const a=structuredClone(good); mutate(a); assert.throws(()=>PB.validateArchive(a)); }
  const fake=structuredClone(good); fake.batches[0].runs[0].result.dimensions[0].evidence[0].quote='完全伪造而且没有出现在原文的引文'; fake.batches[0].runs[0].result.dimensions[0].evidence[0].matched=true;
  assert.equal(PB.validateArchive(fake).batches[0].runs[0].result.dimensions[0].score,null);
});
test('archive restore pauses interrupted runs; export scrubs keys and recomputes untrusted derived numbers', () => {
  const a=archive(); a.batches[0].status='running'; a.batches[0].runs[0].status='running';
  const restored=PB.validateArchive(a); assert.equal(restored.batches[0].status,'paused'); assert.equal(restored.batches[0].runs[0].status,'pending');
  a.batches[0].runs[0].attempts.push({request:{headers:{Authorization:'Bearer '+a.config.apiKey}, api_key:a.config.apiKey}, rawResponse:'server echoed '+a.config.apiKey});
  a.derived={fake:99}; const exported=PB.exportArchive(a), json=JSON.stringify(exported);
  assert.ok(!json.includes(a.config.apiKey)); assert.equal(exported.config.apiKey,undefined); assert.equal(exported.derived.fake,undefined); assert.ok(exported.derived.batches[0].summaries.base); assert.equal(exported.batches[0].runs[0].result.dimensions[0].evidence[0].quote,'本研究给出了算法完整流程');
  assert.doesNotThrow(()=>PB.validateArchive(exported));
});
test('library PDF placeholders and empty batch selection restore, while empty batch snapshots are rejected', () => {
  for(const text of ['', ' \n\t ']) {
    const a={schemaVersion:1,config:{repeats:5},papers:[{...paper('pdf'),text}],batches:[],currentBatchId:''};
    const result=PB.validateArchive(a); assert.equal(result.currentBatchId,null); assert.equal(result.papers[0].text,text);
    const b=archive(); b.batches[0].papers[0].text=text; assert.throws(()=>PB.validateArchive(b), /论文文本/);
  }
  assert.doesNotThrow(()=>PB.validateArchive({schemaVersion:1,config:{},papers:[],batches:[],currentBatchId:''}));
});
