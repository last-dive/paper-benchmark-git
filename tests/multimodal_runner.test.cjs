'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const R = require('./multimodal_runner.cjs');
const { makeV2Review } = require('./v2_fixture.cjs');
// Exercise current source modules without rebuilding or mutating production index.html.
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-v2-test-modules-'));
process.on('exit', () => fs.rmSync(moduleDir, { recursive: true, force: true }));
const HTML = path.join(moduleDir, 'test_modules.html');
fs.writeFileSync(HTML, ['core.js','transport.js'].map(name => `/* BEGIN ${name} */\n${fs.readFileSync(path.join(__dirname,name),'utf8')}\n/* END ${name} */`).join('\n'));
const { PB, coreImplementationSha256 } = R.loadPB(HTML);
const TEXT = 'A reproducible theorem establishes explicit assumptions and boundary conditions. The proof is provided in Section 2. Numerical evidence remains limited.';
const review = () => makeV2Review(TEXT, { level:3, researchType:'theory' });
const response = (content = JSON.stringify(review()), status = 200, extra = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify({ model: R.MODEL, choices: [{ finish_reason: 'stop', message: { content, reasoning_content: '完整模型推理内容保留。' } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, ...extra }) });
async function fixture(t, count = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-v2-runner-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prepared = path.join(dir, 'prepared'), output = path.join(dir, 'output');
  fs.mkdirSync(prepared, { recursive: true });
  const papers = [];
  for (let i = 1; i <= count; i++) {
    const id = 'p' + String(i).padStart(2, '0');
    fs.mkdirSync(path.join(prepared, id));
    fs.writeFileSync(path.join(prepared, id, 'full_text.txt'), TEXT);
    const imagePaths = [];
    for (let page = 1; page <= 3; page++) {
      const rel = id + '/page-' + String(page).padStart(3,'0') + '.jpg';
      fs.writeFileSync(path.join(prepared,rel), Buffer.from([255,216,255,224,i,page,255,217]));
      imagePaths.push(rel);
    }
    papers.push({ id, title:id, textPath:id+'/full_text.txt', textSha256:R.sha(TEXT), pdfSha256:R.sha('pdf'+id), pages:3, imagePaths });
  }
  R.atomic(path.join(prepared, 'manifest.json'), { papers, extractionMethod: 'fixture UTF-8', renderingMethod: 'fixture JPEG bytes' });
  const inspected = R.inspectPrepared(prepared);
  const { state, frozen } = await R.createState(PB, inspected, { repeats: 3, concurrency: 2 }, coreImplementationSha256);
  fs.mkdirSync(output); fs.cpSync(prepared, path.join(output, 'assets/prepared'), { recursive: true });
  return { output, prepared, inspected, state, frozen };
}
const run = (fx, options = {}) => R.runSchedule({ PB, ...fx, key: 'test-secret-do-not-store', log: () => {}, sleep: async () => {}, ...options });
test('full-page multimodal request, payload hash, offline references and raw reasoning survive archive import', async t => {
  const fx = await fixture(t, 1); let sent;
  await run(fx, { limitRuns: 1, fetchImpl: async (url, opts) => { assert.equal(url, R.ENDPOINT); sent = opts; return response(); } });
  const b = fx.state.batches[0];
  assert.equal(b.status, 'paused');
  assert.equal(b.runs.filter(r => r.status === 'success').length, 1);
  const a = b.runs.find(r => r.status === 'success').attempts[0];
  assert.equal(a.payloadSha256, R.sha(sent.body));
  const body = JSON.parse(sent.body);
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  const im = body.messages[1].content.filter(x=>x.type==='image_url'); assert.equal(im.length,3);
  const paper = b.papers.find(p=>p.id===b.runs.find(r=>r.status==='success').paperId);
  const media = fx.frozen.media.find(m=>m.id===paper.id);
  im.forEach((x,i)=>{assert.equal(x.image_url.detail,'high');assert.deepEqual(Buffer.from(x.image_url.url.split(',')[1],'base64'),fs.readFileSync(path.join(fx.output,media.images[i].asset)));});
  assert.equal(a.imageCount,3);
  assert.equal(body.thinking.type,'enabled');assert.equal(body.reasoning_effort,'low');assert.equal(body.do_sample,true);
  assert.equal(body.temperature,.2);assert.equal(body.top_p,.95);assert.equal(body.max_tokens,16384);
  assert.equal(b.protocol.reviewSchemaVersion,2);assert.equal(b.protocol.rubricVersion,'PB-RUBRIC-2.0');
  assert.match(body.messages[0].content,/PB-RUBRIC-2.0/);
  assert.match(a.request.messages[1].content[1].image_url.url, /^asset:\/\/assets\/prepared\//);
  assert.match(a.responseBody, /reasoning_content/);
  const rawArchive = fs.readFileSync(path.join(fx.output, 'archive.json'), 'utf8');
  assert.ok(!rawArchive.includes('data:image/jpeg;base64,'));
  assert.ok(!rawArchive.includes('test-secret-do-not-store'));
  const validated = PB.validateArchive(rawArchive);
  assert.equal(PB.summarize(validated.batches[0], 'p01').total, 7.75);
  assert.equal(validated.batches[0].runs.find(r=>r.status==='success').result.schemaVersion,2);
  await assert.rejects(PB.runBatch(b, 'not-used'), /协议校验失败/);
});
test('parse failure retries exact payload once; first valid result accepted', async t => {
  const fx = await fixture(t, 1); const bodies = [];
  await run(fx, { limitRuns: 1, fetchImpl: async (_, o) => { bodies.push(o.body); return response(bodies.length === 1 ? 'not json' : JSON.stringify(review())); } });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  const r = fx.state.batches[0].runs[0]; assert.equal(r.attempts[0].status, 'error'); assert.equal(r.attempts[1].status, 'success');
});
test('unmatched quote becomes null with audit warning and does not trigger selective retries', async t => {
  const fx = await fixture(t, 1); let calls = 0;
  const obj = review(); obj.dimensions[0].evidence[0].quote = 'This quote never appears in the actual paper.';
  await run(fx, { limitRuns: 1, fetchImpl: async () => { calls++; return response(JSON.stringify(obj)); } });
  assert.equal(calls, 1); const result = fx.state.batches[0].runs[0].result;
  assert.equal(result.dimensions[0].score, null); assert.equal(result.dimensions[0].items[0].level,3); assert.equal(result.dimensions[0].items[0].effectiveLevel,null); assert.equal(result.dimensions[0].completeness.assessedItems,0);
});
test('429 and length errors have bounded three attempts with raw responses', async t => {
  for (const kind of ['429', 'length']) {
    const fx = await fixture(t, 1); let calls = 0;
    await run(fx, { limitRuns: 1, fetchImpl: async () => { calls++; return kind === '429' ? response('', 429, { error: { message: 'rate limited' } }) : response('', 200, { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }); } });
    assert.equal(calls, 3); assert.equal(fx.state.batches[0].runs[0].status, 'error');
    assert.equal(fs.readdirSync(path.join(fx.output, 'responses')).length, 3);
  }
});
test('401 pauses queue without retry and redacts credential reflected in server error', async t => {
  const fx = await fixture(t, 3); let calls = 0;
  const result = await run(fx, { fetchImpl: async () => { calls++; return response('', 401, { error: { message: 'invalid test-secret-do-not-store' } }); } });
  assert.ok(calls <= 2); assert.equal(fx.state.batches[0].status, 'paused'); assert.ok(result.fatal);
  const archive = fs.readFileSync(path.join(fx.output, 'archive.json'), 'utf8');
  assert.ok(!archive.includes('test-secret-do-not-store')); assert.match(archive, /REDACTED/);
});
test('concurrency stays bounded and each round finishes before next starts', async t => {
  const fx = await fixture(t, 3); let inflight = 0, peak = 0; const batch = fx.state.batches[0];
  await run(fx, { fetchImpl: async () => {
    inflight++; peak = Math.max(peak, inflight);
    const active = batch.runs.filter(r => r.status === 'running');
    for (const r of active) for (const prev of batch.runs.filter(q => q.round < r.round)) assert.equal(prev.status, 'success');
    await new Promise(r => setTimeout(r, 5)); inflight--; return response();
  } });
  assert.equal(peak, 2); assert.equal(batch.status, 'complete'); assert.equal(batch.runs.filter(r => r.status === 'success').length, 9);
});
test('resume validates frozen protocol/assets and never repeats successful slots', async t => {
  const fx = await fixture(t, 2); let calls = 0;
  await run(fx, { limitRuns: 1, fetchImpl: async () => { calls++; return response(); } });
  const raw = JSON.parse(fs.readFileSync(path.join(fx.output, 'archive.json'), 'utf8'));
  const state = R.validateResume(PB, raw, fx.frozen, fx.inspected, coreImplementationSha256, { workers: 5 });
  await run({ ...fx, state }, { workers: 5, fetchImpl: async () => { calls++; return response(); } });
  assert.equal(calls, 6); assert.equal(state.batches[0].status, 'complete');
  const executionEvents = JSON.parse(fs.readFileSync(path.join(fx.output, 'execution_events.json'), 'utf8')).events;
  assert.equal(executionEvents.length, 4); assert.equal(executionEvents[2].workers, 5); assert.equal(executionEvents[2].successCount, 1); assert.equal(executionEvents[3].successCount, 6);
  assert.throws(() => R.validateResume(PB, raw, fx.frozen, fx.inspected, coreImplementationSha256, { concurrency: 3 }), /不可更改/);
  const bad = JSON.parse(JSON.stringify(raw)); bad.batches[0].protocol.parameters.temperature = 0.9;
  assert.throws(() => R.validateResume(PB, bad, fx.frozen, fx.inspected, coreImplementationSha256, {}), /已被修改/);
  const media = JSON.parse(JSON.stringify(fx.inspected)); media.papers[0].images[0].sha256 = 'a'.repeat(64);
  assert.throws(() => R.validateResume(PB, raw, fx.frozen, media, coreImplementationSha256, {}), /发生变化/);
});
test('SIGINT-like abort keeps interrupted attempt and pending run for resume', async t => {
  const fx = await fixture(t, 1), controller = new AbortController();
  await run(fx, { signal: controller.signal, fetchImpl: async (_, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    setTimeout(() => controller.abort(), 5);
  }) });
  const r = fx.state.batches[0].runs[0]; assert.equal(r.status, 'pending'); assert.equal(r.attempts[0].status, 'cancelled'); assert.equal(fx.state.batches[0].status, 'paused');
});

test('Unicode-escaped credential reflection is removed from decoded envelope and raw response before disk writes', async t => {
  const fx = await fixture(t, 1);
  const key = 'test-secret-do-not-store';
  const escapedKey = [...key].map(ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const received = JSON.stringify({ error: { message: 'invalid ' + key, nested: { secretEcho: key } } }).split(key).join(escapedKey);
  await run(fx, { fetchImpl: async () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => received }) });
  const a = fx.state.batches[0].runs[0].attempts[0];
  assert.equal(a.apiKeyRedacted, true);
  assert.ok(!a.responseBody.includes(key));
  const stored = JSON.parse(fs.readFileSync(path.join(fx.output, a.responsePath), 'utf8'));
  assert.ok(!JSON.stringify(stored).includes(key));
  assert.match(stored.response.error.message, /REDACTED/);
  assert.match(stored.response.error.nested.secretEcho, /REDACTED/);
  assert.ok(!fs.readFileSync(path.join(fx.output, 'archive.json'), 'utf8').includes(key));
});

test('runtime workers override reaches five while preserving frozen config, protocol, payloads and round barriers', async t => {
  const fx = await fixture(t, 6), batch = fx.state.batches[0];
  const originalConfig = JSON.stringify(fx.frozen), originalProtocol = JSON.stringify(batch.protocol);
  const expectedBodies = new Map(batch.papers.map(p => [p.id, JSON.stringify(R.buildRequest(batch, p, fx.frozen.media.find(m => m.id === p.id), fx.output, true))]));
  let inflight = 0, peak = 0, calls = 0;
  await run(fx, { workers: 5, fetchImpl: async (_, options) => {
    calls++; inflight++; peak = Math.max(peak, inflight);
    assert.ok([...expectedBodies.values()].includes(options.body), 'runtime workers must not change any transmitted body');
    for (const active of batch.runs.filter(r => r.status === 'running')) for (const previous of batch.runs.filter(r => r.round < active.round)) assert.equal(previous.status, 'success');
    await new Promise(resolve => setTimeout(resolve, 8)); inflight--; return response();
  } });
  assert.equal(peak, 5); assert.equal(calls, 18); assert.equal(batch.config.concurrency, 2);
  assert.equal(JSON.stringify(fx.frozen), originalConfig); assert.equal(JSON.stringify(batch.protocol), originalProtocol);
  const events = JSON.parse(fs.readFileSync(path.join(fx.output, 'execution_events.json'), 'utf8')).events;
  assert.equal(events.length, 2); assert.equal(events[0].phase, 'started'); assert.equal(events[1].phase, 'finished');
  assert.equal(events[0].workers, 5); assert.equal(events[0].plannedConcurrency, 2);
  assert.equal(events[0].successCount, 0); assert.equal(events[1].successCount, 18);
  assert.equal(events[1].status, 'complete'); assert.equal(events[1].protocolId, batch.protocol.id);
  assert.equal(events[0].executionId, events[1].executionId);
  assert.equal(R.parseArgs(['--resume', '--workers', '5']).workers, 5);
  assert.throws(() => R.parseArgs(['--workers', '9']), /1–8/);
});

test('legacy review downgrade is rejected and retried with identical frozen v2 request', async t => {
  const fx=await fixture(t,1),bodies=[];
  const old={dimensions:review().dimensions.map(d=>({id:d.id,score:7,evidence:d.evidence,reason:d.reason,improvement:d.improvement})),summary:'原版直接评分模拟回复，用于严格降级测试。',limitations:'未核实研究事实。'};
  await run(fx,{limitRuns:1,fetchImpl:async(_,opts)=>{bodies.push(opts.body);return response(JSON.stringify(bodies.length===1?old:review()));}});
  const slot=fx.state.batches[0].runs[0];
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
  assert.equal(slot.attempts[0].errorCode,'review_parse');assert.match(slot.attempts[0].error,/版本不符/);
  assert.equal(slot.status,'success');assert.equal(slot.result.schemaVersion,2);
});

test('v2 missing criterion is rejected, but a valid low score is never selected away', async t => {
  const fx=await fixture(t,1);let calls=0;const broken=review();broken.dimensions[0].items.pop();
  const validLow=makeV2Review(TEXT,{level:1,researchType:'theory'});
  await run(fx,{limitRuns:1,fetchImpl:async()=>{calls++;return response(JSON.stringify(calls===1?broken:validLow));}});
  const slot=fx.state.batches[0].runs[0];assert.equal(calls,2);assert.match(slot.attempts[0].error,/四个检查项/);
  assert.equal(slot.result.dimensions[0].score,3.25);assert.equal(slot.attempts[1].status,'success');
});

test('limited closing-delimiter compatibility preserves raw content and one visible normalization warning', async t => {
  const fx=await fixture(t,1);let calls=0;const content=JSON.stringify(review())+'}\n';
  await run(fx,{limitRuns:1,fetchImpl:async()=>{calls++;return response(content);}});
  assert.equal(calls,1);const slot=fx.state.batches[0].runs[0];
  assert.equal(JSON.parse(slot.attempts[0].responseBody).choices[0].message.content,content);
  assert.equal(slot.result.normalization.removedCloserCount,1);assert.equal(slot.result.formatWarnings.length,1);
  assert.equal(slot.result.warnings.filter(w=>w===slot.result.formatWarnings[0]).length,1);
  const saved=PB.validateArchive(fs.readFileSync(path.join(fx.output,'archive.json'),'utf8'));
  const restored=PB.validateArchive(PB.exportArchive(saved)).batches[0].runs[0].result;
  assert.equal(restored.formatWarnings.length,1);assert.equal(restored.warnings.filter(w=>w===restored.formatWarnings[0]).length,1);
  assert.equal(restored.dimensions[0].evidence[0].matchedMethod,'nfkc_whitespace');
});

test('a changed frozen page image is rejected before any model request', async t => {
  const fx=await fixture(t,1),image=fx.frozen.media[0].images[1];let calls=0;
  fs.appendFileSync(path.join(fx.output,image.asset),Buffer.from([0]));
  await assert.rejects(run(fx,{limitRuns:1,fetchImpl:async()=>{calls++;return response();}}),/图像hash变更/);
  assert.equal(calls,0);
});
