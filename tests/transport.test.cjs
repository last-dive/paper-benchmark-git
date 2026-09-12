'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

function environment(fetchImpl, timerMode = 'fastRetry') {
  const waits = [];
  const context = vm.createContext({
    URL, AbortController, TextEncoder, Uint8Array, Uint32Array, DataView, crypto: webcrypto,
    fetch: fetchImpl || (async () => { throw new Error('Unexpected request'); }),
    setTimeout(fn, ms) {
      waits.push(ms);
      const actual = timerMode === 'fastAll' ? Math.min(ms, 3) : ms < 120000 ? Math.min(ms, 3) : ms;
      return setTimeout(fn, actual);
    },
    clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'transport.js'), 'utf8'), context);
  return { context, PB: context.PB, waits };
}
const sampleText = 'The reported baseline error was 10 percent. A repeated controlled experiment provided the complete measurements and uncertainty intervals.';
function paper(id = 'paper-a') { return { id, title: 'LOCAL SECRET TITLE ' + id, group: 'LOCAL SECRET GROUP', version: 'PRIVATE VERSION', kind: 'reference', change: 'evidence', text: sampleText + ' Study identifier ' + id + '.' }; }
function config(extra = {}) { return { endpoint: 'https://mock.invalid/v1', model: 'mock-model', apiKey: 'SECRET-API-KEY-TEST', repeats: 3, concurrency: 2, retries: 0, timeout: 120, ...extra }; }
const {makeV2Review}=require('./v2_fixture.cjs');
function review(PB, score = 7) { return makeV2Review(sampleText,{level:score>=8?4:score>=7?3:2,quote:'The reported baseline error was 10 percent.'}); }

function response(PB, { score = 7, status = 200, raw, finish = 'stop', headers = {} } = {}) {
  const body = raw === undefined ? JSON.stringify({ model: 'mock-model-snapshot', system_fingerprint: 'fp_test', usage: { prompt_tokens: 120, completion_tokens: 300, total_tokens: 420 }, choices: [{ finish_reason: finish, message: { role: 'assistant', content: JSON.stringify(review(PB, score)) } }] }) : raw;
  return { status, ok: status >= 200 && status < 300, headers: { get: k => headers[k.toLowerCase()] || null }, text: async () => body };
}
function jsonClone(x) { return JSON.parse(JSON.stringify(x)); }

// These tests never use a live network, account, or API key.
test('GLM defaults, reasoning parameters and strict v2 response schema are frozen in each new protocol', async () => {
  const {PB,context}=environment();
  const defaults=PB.validateConfig({});
  assert.equal(defaults.model,'glm-5.3-flash');assert.equal(defaults.topP,0.95);assert.equal(defaults.maxTokens,32768);
  assert.equal(defaults.thinking,'disabled');assert.equal(defaults.reasoningEffort,'omit');assert.equal(defaults.doSample,true);
  const b=await PB.createBatch([paper()],config(),'v2');
  assert.equal(b.protocol.reviewSchemaVersion,2);
  const changed=await PB.createBatch([paper()],config({reasoningEffort:'high'}),'different');
  assert.notEqual(b.protocol.id,changed.protocol.id);
  context.fetch=async(_,options)=>{
    const body=JSON.parse(options.body);
    assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.reasoning_effort,undefined);assert.equal(body.do_sample,true);
    return response(PB,{raw:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({dimensions:[]})}}]})});
  };
  await PB.runBatch(b,'test');
  assert.equal(b.status,'complete');assert.equal(b.completionState,'with_issues');assert.equal(b.runs[0].attempts[0].errorCode,'review_parse');assert.equal(b.runs[0].attempts.length,1);
});
test('local session token goes only to matching loopback endpoint and never enters an archive',async()=>{
  const {PB,context}=environment();const token='a'.repeat(64),endpoint='http://127.0.0.1:8787/v1/chat/completions';
  PB.setLocalProfile({endpoint,token});
  const b=await PB.createBatch([paper()],config({endpoint}),'local');
  context.fetch=async(_,options)=>{assert.equal(options.headers['X-Paperbench-Token'],token);return response(PB);};
  await PB.runBatch(b,'');assert.ok(!JSON.stringify(b).includes(token));
  const remote=await PB.createBatch([paper()],config(),'remote');
  context.fetch=async(_,options)=>{assert.equal(options.headers['X-Paperbench-Token'],undefined);return response(PB);};
  await PB.runBatch(remote,'');
  assert.throws(()=>PB.setLocalProfile({endpoint:'https://example.org/v1',token}),/本机/);
});
test('configuration normalizes compatible endpoints, validates ranges, rejects embedded credentials', () => {
  const { PB } = environment();
  assert.equal(PB.validateConfig(config()).endpoint, 'https://mock.invalid/v1/chat/completions');
  assert.equal(PB.validateConfig(config({ endpoint: 'https://mock.invalid/' })).endpoint, 'https://mock.invalid/v1/chat/completions');
  assert.equal(PB.validateConfig(config({ endpoint: 'http://localhost:8000/api/v1/chat/completions/' })).endpoint, 'http://localhost:8000/api/v1/chat/completions');
  assert.equal(PB.validateConfig(config({ endpoint: 'https://mock.invalid/v1?api-version=2025-01-01' })).endpoint, 'https://mock.invalid/v1/chat/completions?api-version=2025-01-01');
  assert.throws(() => PB.validateConfig(config({ endpoint: 'https://mock.invalid/v1?api_key=secret' })), /密钥/);
  assert.throws(() => PB.validateConfig(config({ endpoint: 'https://u:p@mock.invalid/v1' })), /密钥/);
  assert.throws(() => PB.validateConfig(config({ repeats: 0 })), /重复轮数/);
  assert.throws(() => PB.validateConfig(config({ responseJson: 'false' })), /JSON/);
  assert.throws(() => PB.validateConfig(config({ concurrency: 9 })), /并发/);
  assert.throws(() => PB.validateConfig(config({ topP: 0 })), /Top P/);
  assert.equal(PB.validateConfig(config({ seed: 0 })).seed, 0);
});

test('batch snapshots detach and freeze inputs; rubric identity excludes repeats, papers, API key and scheduling', async () => {
  const { PB } = environment();
  const source = paper(), cfg = config();
  const batch = await PB.createBatch([source], cfg, '测试批次');
  const comparison = await PB.createBatch([paper('other')], config({ repeats: 5, concurrency: 1, apiKey: 'ANOTHER-KEY' }), '另批次');
  assert.equal(batch.protocol.id, comparison.protocol.id);
  assert.notEqual(batch.protocol.snapshotHash, comparison.protocol.snapshotHash);
  assert.equal(batch.protocol.id.length, 64);
  assert.equal(batch.papers[0].hash.length, 64);
  assert.equal(batch.runs.length, 3);
  assert.ok(Object.isFrozen(batch.config)); assert.ok(Object.isFrozen(batch.papers[0])); assert.ok(Object.isFrozen(batch.protocol.roundOrders));
  assert.ok(!Object.isFrozen(cfg)); assert.ok(!Object.isFrozen(source));
  source.text = 'changed'; cfg.model = 'changed';
  assert.equal(batch.config.model, 'mock-model'); assert.match(batch.papers[0].text, /baseline/);
  assert.ok(!JSON.stringify(batch).includes('SECRET-API-KEY-TEST'));
  const changed = await PB.createBatch([paper()], config({ temperature: 0.7 }), '改变温度');
  assert.notEqual(changed.protocol.id, batch.protocol.id);
  await assert.rejects(PB.createBatch([paper('same'), paper('same')], config()), /重复/);
  await assert.rejects(PB.createBatch([{ ...paper(), text: ' ' }], config()), /不能为空/);
  await assert.rejects(PB.createBatch([{ ...paper(), text: 'x'.repeat(1001) }], config({ maxChars: 1000 })), /未截断/);
});

test('independent requests exclude metadata, use paired round seeds and bounded concurrency with round barriers', async () => {
  const env = environment(); const { PB, context } = env;
  const batch = await PB.createBatch([paper('a'), paper('b'), paper('c')], config({ seed: 42 }), '并发');
  let inFlight = 0, maximum = 0;
  const completed = [], requests = [];
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body), round = body.seed - 41;
    const prior = completed.filter(x => x === round - 1).length;
    if (round > 1) assert.equal(prior, 3, '下一轮必须等待上一轮所有论文结束');
    assert.equal(url, 'https://mock.invalid/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer SECRET-API-KEY-TEST');
    assert.equal(body.messages.length, 2);
    assert.ok(!options.body.includes('LOCAL SECRET')); assert.ok(!options.body.includes('PRIVATE VERSION'));
    assert.match(body.messages[1].content, /不可信数据/);
    assert.equal(body.response_format.type, 'json_object');
    inFlight++; maximum = Math.max(maximum, inFlight); requests.push(body);
    await new Promise(resolve => setTimeout(resolve, body.messages[1].content.includes('identifier a.') ? 9 : 2));
    inFlight--; completed.push(round);
    return response(PB);
  };
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  assert.equal(maximum, 2); assert.equal(requests.length, 9); assert.equal(batch.status, 'complete');
  assert.ok(batch.runs.every(r => r.status === 'success' && r.attempts.length === 1));
  assert.equal(PB.summarize(batch, 'a').successRuns, 3);
  for (const run of batch.runs) {
    const attempt = run.attempts[0];
    assert.equal(attempt.usage.total_tokens, 420); assert.equal(attempt.systemFingerprint, 'fp_test');
    assert.equal(attempt.model, 'mock-model-snapshot'); assert.ok(attempt.responseBody.includes('choices'));
    assert.equal(attempt.request.seed, run.round + 41);
  }
  const snapshot = JSON.stringify(batch.runs);
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  assert.equal(requests.length, 9, '成功运行不得重复计费'); assert.equal(JSON.stringify(batch.runs), snapshot);
});

test('retains HTTP and parsing failures and usage; exponential retry returns first valid result', async () => {
  const env = environment(); const { PB, context, waits } = env;
  const batch = await PB.createBatch([paper()], config({ retries: 2, concurrency: 1 }), '重试');
  let calls = 0;
  context.fetch = async () => {
    calls++;
    if (calls === 1) return response(PB, { status: 429, raw: JSON.stringify({ error: { message: 'rate limited' }, usage: { total_tokens: 4 } }), headers: { 'retry-after': '2' } });
    if (calls === 2) return response(PB, {status:503, raw:JSON.stringify({usage:{total_tokens:5},error:{message:'temporary unavailable'}})});
    return response(PB, { score: 6 });
  };
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  const attempts = batch.runs[0].attempts;
  assert.equal(calls, 5); assert.equal(attempts.length, 3);
  assert.equal(attempts[0].httpStatus, 429); assert.match(attempts[0].responseBody, /rate limited/); assert.equal(attempts[0].usage.total_tokens, 4);
  assert.equal(attempts[1].errorCode, 'http'); assert.equal(attempts[1].usage.total_tokens, 5);
  assert.equal(attempts[2].status, 'success'); assert.equal(batch.runs[0].result.dimensions[0].score, 5.5);
  assert.ok(attempts[0].retryDelayMs >= 2000); assert.ok(attempts[1].retryDelayMs >= 2000); assert.ok(waits.some(ms => ms >= 2000 && ms < 120000));
});

test('truncated results affect only their slot and are not billed again after export/import resume', async () => {
  const { PB, context } = environment();
  const batch = await PB.createBatch([paper()], config({ concurrency: 1 }), '截断');
  let calls = 0;
  context.fetch = async () => response(PB, { finish: ++calls === 1 ? 'length' : 'stop', score: 9 });
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  assert.equal(calls,3);assert.equal(batch.status, 'complete');assert.equal(batch.completionState,'with_issues'); assert.equal(batch.runs[0].status, 'error');
  assert.equal(batch.runs[0].attempts[0].errorCode, 'truncated'); assert.equal(batch.runs[0].result, undefined);
  const state = { schemaVersion: 1, config: config(), papers: [paper()], batches: [batch], currentBatchId: batch.id };
  const imported = PB.validateArchive(PB.exportArchive(state));
  const resumed = imported.batches[0], successful = JSON.stringify(resumed.runs.slice(1));
  context.fetch = async () => { calls++; return response(PB, { score: 6 }); };
  await PB.runBatch(resumed, 'SECRET-API-KEY-TEST');
  assert.equal(calls, 3); assert.equal(resumed.runs[0].attempts.length, 1); assert.equal(resumed.runs[0].result,undefined);
  assert.equal(resumed.runs.filter(r=>r.status==='success').length,2);assert.equal(JSON.stringify(resumed.runs.slice(1)),successful);
});

test('401 stops the queue without automatic retries and credentials in echoed errors are redacted', async () => {
  const { PB, context } = environment();
  const batch = await PB.createBatch([paper('a'), paper('b')], config({ concurrency: 1, retries: 3 }), '认证');
  let calls = 0;
  context.fetch = async () => { calls++; return response(PB, { status: 401, raw: '{"error":{"message":"bad SECRET-API-KEY-TEST"}}' }); };
  await assert.rejects(PB.runBatch(batch, 'SECRET-API-KEY-TEST'), /HTTP 401/);
  assert.equal(calls, 1); assert.equal(batch.status, 'paused'); assert.equal(batch.runs[0].attempts.length, 1);
  assert.ok(!JSON.stringify(batch).includes('SECRET-API-KEY-TEST')); assert.match(batch.runs[0].attempts[0].responseBody, /API_KEY_REDACTED/);
  context.fetch = async () => { calls++; return response(PB); };
  await PB.runBatch(batch, 'replacement-key');
  assert.equal(batch.status, 'complete'); assert.equal(calls, 7); assert.equal(batch.runs[0].attempts.length, 2);
});

test('cancellation stops in-flight request and resume preserves successful results and all attempts', async () => {
  const { PB, context } = environment();
  const batch = await PB.createBatch([paper()], config({ concurrency: 1 }), '暂停');
  const control = new AbortController();
  let calls = 0, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  context.fetch = async (_, options) => {
    if (++calls === 1) return response(PB, { score: 8 });
    notifyStarted();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const running = PB.runBatch(batch, 'SECRET-API-KEY-TEST', { signal: control.signal });
  await started;
  await assert.rejects(PB.runBatch(batch, 'SECRET-API-KEY-TEST'), /已经在运行/);
  control.abort(); await running;
  assert.equal(batch.status, 'paused'); assert.equal(batch.runs[0].status, 'success'); assert.equal(batch.runs[1].status, 'pending');
  assert.equal(batch.runs[1].attempts[0].status, 'cancelled');
  const first = JSON.stringify(batch.runs[0]);
  context.fetch = async () => { calls++; return response(PB, { score: 6 }); };
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  assert.equal(calls, 4); assert.equal(JSON.stringify(batch.runs[0]), first); assert.equal(batch.runs[1].attempts.length, 2);
});

test('backoff can be cancelled before a retry starts', async () => {
  const { PB, context } = environment();
  const batch = await PB.createBatch([paper()], config({ retries: 2, concurrency: 1 }), '取消退避');
  const control = new AbortController(); let calls = 0;
  context.fetch = async () => { calls++; return response(PB, { status: 503, raw: 'Temporarily unavailable' }); };
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST', { signal: control.signal, onUpdate: (_, event) => { if (event.type === 'retry') control.abort(); } });
  assert.equal(calls, 1); assert.equal(batch.status, 'paused'); assert.equal(batch.runs[0].attempts[0].status, 'error');
  assert.match(batch.runs[0].attempts[0].responseBody, /Temporarily/);
});

test('timeout is recorded even when a broken fetch implementation ignores abort', async () => {
  const { PB, context } = environment(null, 'fastAll');
  const batch = await PB.createBatch([paper()], config({ timeout: 1, concurrency: 1 }), '超时');
  let calls = 0; context.fetch = () => { calls++; return new Promise(() => {}); };
  await assert.rejects(PB.runBatch(batch, 'SECRET-API-KEY-TEST'),/连续3次/);
  assert.equal(calls, 3); assert.ok(batch.runs.every(r => r.status === 'error' && r.attempts[0].errorCode === 'timeout'));
});

test('snapshot corruption is rejected before any request; connection test contains no papers and can disable JSON mode', async () => {
  const { PB, context } = environment();
  const batch = jsonClone(await PB.createBatch([paper()], config(), '校验'));
  batch.papers[0].text += ' Changed.';
  let calls = 0;
  context.fetch = async (_, options) => {
    calls++; const body = JSON.parse(options.body);
    assert.ok(!('response_format' in body)); assert.ok(!('seed' in body)); assert.ok(!options.body.includes('paper_text'));
    assert.ok(body.max_tokens <= 128); return response(PB);
  };
  await assert.rejects(PB.runBatch(batch, 'SECRET-API-KEY-TEST'), /快照校验/); assert.equal(calls, 0);
  const result = await PB.testConnection(config({ responseJson: false }));
  assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(result.usage.total_tokens, 420);
});

test('native network errors with a code are retried while HTTP 400 errors are retained without retries', async () => {
  const { PB, context } = environment();
  const batch = await PB.createBatch([paper()], config({ retries: 1, concurrency: 1 }), '网络');
  let calls = 0;
  context.fetch = async () => {
    if (++calls === 1) { const err = new Error('Connection reset'); err.code = 'ECONNRESET'; throw err; }
    return response(PB);
  };
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  assert.equal(calls, 4); assert.equal(batch.runs[0].attempts[0].errorCode, 'network');
  assert.deepEqual(jsonClone(batch.runs[0].attempts[0].request), jsonClone(batch.runs[0].attempts[1].request), '重试必须维持完全相同的评分参数与 seed');
  const invalid = await PB.createBatch([paper()], config({ retries: 3, concurrency: 1 }), '参数');
  calls = 0;
  context.fetch = async () => { calls++; return response(PB, { status: 400, raw: '{"error":{"message":"unsupported parameter max_tokens"}}' }); };
  await assert.rejects(PB.runBatch(invalid, 'SECRET-API-KEY-TEST'),/全局参数/);
  assert.equal(calls, 1); assert.equal(invalid.runs[0].status,'error');assert.equal(invalid.runs[0].attempts.length,1);assert.equal(invalid.runs.filter(r=>r.status==='pending').length,2);
  assert.match(invalid.runs[0].attempts[0].responseBody, /unsupported parameter/);
});

test('restoring an interrupted session retains uncertainty and strips echoed secrets from response metadata', async () => {
  const { PB, context } = environment();
  const batch = jsonClone(await PB.createBatch([paper()], config({ concurrency: 1 }), '恢复会话'));
  batch.runs[0].status = 'running';
  batch.runs[0].attempts.push({ id: 'interrupted-attempt', status: 'running', responseBody: '', httpStatus: null, request: { model: 'mock-model' } });
  context.fetch = async () => {
    const res = response(PB);
    const envelope = JSON.parse(await res.text());
    envelope.model = 'model-SECRET-API-KEY-TEST';
    envelope.usage.provider_detail = 'SECRET-API-KEY-TEST';
    return response(PB, { raw: JSON.stringify(envelope) });
  };
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  assert.equal(batch.runs[0].attempts[0].status, 'interrupted');
  assert.match(batch.runs[0].attempts[0].error, /费用可能已产生/);
  assert.equal(batch.runs[0].attempts.length, 2);
  assert.ok(!JSON.stringify(batch).includes('SECRET-API-KEY-TEST'));
});

test('malformed provider usage cannot invalidate persisted work and Unicode-escaped API keys are redacted', async () => {
  const { PB, context } = environment();
  const batch = await PB.createBatch([paper()], config({ concurrency: 1 }), '异常元数据');
  context.fetch = async () => {
    const envelope = JSON.parse(await response(PB).text());
    envelope.model = 'mock-SECRET-API-KEY-TEST';
    envelope.usage = { total_tokens: '420', prompt_tokens: null, completion_tokens: 300 };
    const raw = JSON.stringify(envelope).replaceAll('SECRET-API-KEY-TEST', 'SECRET\\u002dAPI\\u002dKEY\\u002dTEST');
    return response(PB, { raw });
  };
  await PB.runBatch(batch, 'SECRET-API-KEY-TEST');
  const attempt = batch.runs[0].attempts[0];
  assert.equal(attempt.status, 'success'); assert.equal(attempt.usage.total_tokens, undefined);
  assert.equal(attempt.usage.completion_tokens, 300); assert.equal(attempt.metadataWarnings.length, 2);
  assert.ok(attempt.apiKeyRedacted); assert.ok(!JSON.stringify(batch).includes('SECRET-API-KEY-TEST'));
  assert.ok(!attempt.responseBody.includes('SECRET\\u002d'));
  const restored = PB.validateArchive({ schemaVersion: 1, config: config(), papers: [paper()], batches: [batch], currentBatchId: batch.id });
  assert.equal(restored.batches[0].runs[0].status, 'success');
});


test('custom local route preserves upstream protocol, omits provider fields and never archives session credentials',async()=>{
 const {PB,context}=environment();const upstream='https://custom.example/v1/chat/completions',endpoint='http://127.0.0.1:8787/v1/chat/completions',token='a'.repeat(64),routeId='b'.repeat(48);
 PB.setLocalRoute({upstream,endpoint,token,routeId});
 const c=config({endpoint:upstream,repeats:1,thinking:'omit',reasoningEffort:'omit',sendDoSample:false});
 const b=await PB.createBatch([paper()],c,'one round');
 let calls=0;context.fetch=async(url,options)=>{calls++;assert.equal(url,endpoint);assert.equal(options.headers['X-Paperbench-Token'],token);assert.equal(options.headers['X-Paperbench-Route'],routeId);assert.equal(options.headers.Authorization,undefined);const body=JSON.parse(options.body);for(const field of ['thinking','reasoning_effort','do_sample'])assert.ok(!Object.hasOwn(body,field));return response(PB);};
 await PB.runBatch(b,c.apiKey);assert.equal(calls,1);assert.equal(b.config.endpoint,upstream);assert.equal(b.protocol.config.endpoint,upstream);
 const summary=PB.summarize(b,b.papers[0].id);assert.equal(summary.dimensions.rigor.n,1);assert.equal(summary.dimensions.rigor.sd,null);
 const archive=PB.exportArchive({schemaVersion:1,config:c,papers:b.papers,batches:[b],currentBatchId:b.id});
 for(const secret of [token,routeId,c.apiKey])assert.ok(!JSON.stringify(archive).includes(secret));assert.equal(PB.validateArchive(archive).batches[0].config.repeats,1);
 const other=await PB.createBatch([paper()],{...c,sendDoSample:true},'provider option');assert.notEqual(other.protocol.id,b.protocol.id);
 PB.setLocalRoute(null);context.fetch=async(url,options)=>{assert.equal(url,upstream);assert.equal(options.headers['X-Paperbench-Route'],undefined);assert.equal(options.headers.Authorization,'Bearer '+c.apiKey);return response(PB);};await PB.runBatch(other,c.apiKey);
 assert.throws(()=>PB.setLocalRoute({upstream,endpoint:'https://remote.example/v1',token,routeId}),/本机/);
 assert.throws(()=>PB.validateConfig({...c,sendDoSample:'false'}),/sendDoSample/);
});

test('native PDF requests use frozen originals and explicit source-index text',async()=>{
 let body;const {PB}=environment(async(url,opts)=>{body=JSON.parse(opts.body);return response(PB);});
 PB.setLocalRoute({upstream:'https://mock.invalid/v1/chat/completions',endpoint:'http://127.0.0.1:8787/v1/chat/completions',routeId:'c'.repeat(48),token:'b'.repeat(64)});
 const p={...paper(),pdf:{sha256:'a'.repeat(64),size:192403}},cfg=config({repeats:1,inputMode:'pdf'});
 const batch=await PB.createBatch([p],cfg,'native PDF');await PB.runBatch(batch,cfg.apiKey);
 assert.ok(body);assert.equal(body.messages[1].content[0].file_url.url,'paperbench-pdf:'+'a'.repeat(64));assert.ok(JSON.stringify(body).includes(sampleText));assert.ok(JSON.stringify(body).includes('source_catalog'));assert.equal(batch.protocol.sourceCatalogVersion,PB.SOURCE_CATALOG_VERSION);assert.equal(batch.protocol.pdfInputs[0].sha256,p.pdf.sha256);
 const archive=PB.exportArchive({schemaVersion:1,config:cfg,papers:[p],batches:[batch],currentBatchId:batch.id});assert.deepEqual(JSON.parse(JSON.stringify(archive.batches[0].papers[0].pdf)),p.pdf);assert.ok(!JSON.stringify(archive).includes('data:application/pdf;base64,'));
});

test('empty PDF source catalog is rejected before model calls',async()=>{
 const {PB}=environment(async()=>{throw Error('Must not call model');});
 const p={...paper(),text:'',pdf:{sha256:'d'.repeat(64),size:100}};
 await assert.rejects(PB.createBatch([p],config({inputMode:'pdf',repeats:1}),'scan'),/原文索引/);
 await assert.rejects(PB.createBatch([p],config({inputMode:'text'}),'text'),/正文不能为空/);
});

test('review parse, truncation, context-limit and partial-score problems are isolated while other in-flight and queued reviews finish',async()=>{
 const {PB,context}=environment();const batch=await PB.createBatch(Array.from({length:6},(_,i)=>paper('isolate-'+i)),config({repeats:2,concurrency:3,retries:3}),'局部失败隔离');
 let calls=0,aborted=0;
 context.fetch=async(_,options)=>{
  const n=calls++;options.signal.addEventListener('abort',()=>aborted++);
  if(n===0){await new Promise(resolve=>setTimeout(resolve,15));return response(PB);}
  if(n===1)return response(PB,{raw:JSON.stringify({choices:[{finish_reason:'stop',message:{content:'not JSON'}}]})});
  if(n===2)return response(PB,{finish:'length'});
  if(n===3)return response(PB,{status:400,raw:JSON.stringify({error:{code:'context_length_exceeded',message:'maximum context length exceeded for this document'}})});
  if(n===4){const partial=review(PB);Object.assign(partial.dimensions[0].items[0],{status:'unavailable',level:null,evidenceIndices:[],missing:'当前论文缺少这一部分可评价材料。'});return response(PB,{raw:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(partial)}}]})});}
  return response(PB);
 };
 await PB.runBatch(batch,'SECRET-API-KEY-TEST');
 assert.equal(calls,12);assert.equal(aborted,0);assert.equal(batch.status,'complete');assert.equal(batch.completionState,'with_issues');assert.ok(batch.runs.every(r=>r.attempts.length===1));
 assert.equal(batch.runs.filter(r=>r.status==='error').length,3);assert.equal(batch.runs.filter(r=>r.status==='success').length,9);assert.equal(batch.runs.filter(r=>r.result?.dimensions.some(d=>d.score===null)).length,1);
 assert.deepEqual(jsonClone(batch.runs.filter(r=>r.status==='error').map(r=>r.attempts[0].errorCode).sort()),['context_limit','review_parse','truncated']);
 assert.ok(batch.runs.filter(r=>r.status==='error').every(r=>r.attempts[0].retryable===false));
 const snapshot=JSON.stringify(batch.runs);await PB.runBatch(batch,'SECRET-API-KEY-TEST');assert.equal(calls,12);assert.equal(JSON.stringify(batch.runs),snapshot,'completed content failures must not be silently re-run');
});

test('authentication pauses stop new work but drain existing requests without discarding their results',async()=>{
 const {PB,context}=environment(),batch=await PB.createBatch(Array.from({length:6},(_,i)=>paper('auth-'+i)),config({repeats:1,concurrency:3,retries:2}),'鉴权排空');
 let calls=0,aborted=0,release,started;const allStarted=new Promise(r=>started=r),pending=new Promise(r=>release=r);
 context.fetch=async(_,options)=>{const n=++calls;options.signal.addEventListener('abort',()=>aborted++);if(n===3)started();if(n===1)return response(PB,{status:401,raw:'{"error":{"message":"invalid key"}}'});await pending;return response(PB);};
 const events=[];const running=PB.runBatch(batch,'SECRET-API-KEY-TEST',{onUpdate:(_,event)=>events.push(event.type)});const rejected=assert.rejects(running,/HTTP 401/);await allStarted;await new Promise(r=>setTimeout(r,5));
 assert.equal(calls,3);assert.equal(aborted,0);assert.equal(batch.status,'running');assert.equal(batch.draining,true);assert.match(batch.pauseReason,/HTTP 401/);assert.ok(events.includes('draining'));release();await rejected;assert.equal(batch.draining,undefined);
 assert.equal(calls,3);assert.equal(aborted,0);assert.equal(batch.status,'paused');assert.equal(batch.runs.filter(r=>r.status==='success').length,2);assert.equal(batch.runs.filter(r=>r.status==='error').length,1);assert.equal(batch.runs.filter(r=>r.status==='pending').length,3);
 assert.ok(batch.executionEvents.some(e=>e.type==='system-pause'));
});

test('only consecutive systemic failures trigger the three-failure circuit breaker; partial reviews reset the streak',async()=>{
 const {PB,context}=environment(),batch=await PB.createBatch([paper()],config({repeats:6,concurrency:1,retries:0}),'系统失败阈值');let calls=0;
 context.fetch=async()=>{const n=++calls;if(n===3){const partial=review(PB);Object.assign(partial.dimensions[0].items[0],{status:'unavailable',level:null,evidenceIndices:[],missing:'当前论文缺少可评价材料。'});return response(PB,{raw:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(partial)}}]})});}return response(PB,{status:429,raw:'{"error":{"message":"rate limited"}}'});};
 await assert.rejects(PB.runBatch(batch,'SECRET-API-KEY-TEST'),/连续3次网络/);
 assert.equal(calls,6);assert.equal(batch.status,'paused');assert.equal(batch.runs[2].status,'success');assert.equal(batch.runs[2].result.dimensions[0].score,null);assert.equal(batch.executionEvents.filter(e=>e.type==='system-pause').length,1);
});

test('legacy schedule adopts failure isolation without changing its prompt, request or protocol hash; cancelled slots resume once with retries zero',async()=>{
 const {PB,context}=environment();const batch=jsonClone(await PB.createBatch([paper()],config({repeats:2,retries:0,concurrency:1}),'旧调度安全恢复'));
 // Reproduce a pre-policy protocol with its original valid checksums.
 delete batch.protocol.executionPolicy;delete batch.protocol.validationPolicy;
 const canon=value=>Array.isArray(value)?'['+value.map(canon).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canon(value[k])).join(',')+'}':JSON.stringify(value);
 const answer={};for(const key of ['endpoint','model','temperature','topP','maxTokens','seed','responseJson','paperType','anchors','thinking','reasoningEffort','doSample','sendDoSample','inputMode'])if(Object.hasOwn(batch.protocol.config,key))answer[key]=batch.protocol.config[key];
 const rubric={version:batch.protocol.version,method:batch.protocol.method,systemPrompt:batch.protocol.systemPrompt,config:answer,requestTemplate:batch.protocol.requestTemplate,seedPolicy:batch.protocol.seedPolicy,retryPolicy:batch.protocol.retryPolicy};
 for(const key of ['reviewSchemaVersion','rubricVersion','citationMode','sourceCatalogVersion','itemCitationMode'])if(Object.hasOwn(batch.protocol,key))rubric[key]=batch.protocol[key];
 batch.protocol.id=await PB.hashText(canon(rubric));delete batch.protocol.snapshotHash;batch.protocol.snapshotHash=await PB.hashText(canon(batch.protocol));
 const protocol=JSON.stringify(batch.protocol);batch.status='paused';batch.runs[0].status='pending';batch.runs[0].attempts=[{id:'cancelled-old',status:'cancelled',httpStatus:null,responseBody:'',errorCode:'cancelled',error:'前一会话取消'}];
 let calls=0;context.fetch=async(_,options)=>{calls++;assert.equal(JSON.parse(options.body).messages[0].content,batch.protocol.systemPrompt);return response(PB);};
 await PB.runBatch(batch,'SECRET-API-KEY-TEST');assert.equal(calls,2);assert.equal(batch.status,'complete');assert.equal(batch.completionState,'full');assert.equal(JSON.stringify(batch.protocol),protocol);assert.equal(batch.runs[0].attempts.length,2);assert.equal(batch.runs[0].attempts[0].status,'cancelled');
 assert.equal(batch.executionEvents[0].protocolPolicy,'legacy_global_pause');assert.match(batch.executionEvents[0].message,/原协议/);
 await PB.runBatch(batch,'SECRET-API-KEY-TEST');assert.equal(calls,2);
});

test('resume never replays completed responses or old parser failures incorrectly marked retryable',async()=>{
 const {PB,context}=environment();const batch=await PB.createBatch([paper()],config({repeats:3,retries:0,concurrency:1}),'历史失败分类');
 batch.status='paused';
 batch.runs[0].status='pending';batch.runs[0].attempts=[{id:'cancelled-empty',status:'cancelled',httpStatus:null,responseBody:''}];
 batch.runs[1].status='pending';batch.runs[1].attempts=[{id:'cancelled-complete',status:'cancelled',httpStatus:200,finishReason:'stop',responseBody:await response(PB).text()}];
 batch.runs[2].status='error';batch.runs[2].error='旧解析失败';batch.runs[2].attempts=[{id:'old-review-fail',status:'error',errorCode:'review_parse',retryable:true,httpStatus:200,finishReason:'stop',responseBody:'old archived response'}];
 let calls=0;context.fetch=async()=>{calls++;return response(PB);};await PB.runBatch(batch,'test');
 assert.equal(calls,1);assert.equal(batch.runs[0].status,'success');assert.equal(batch.runs[0].attempts.length,2);
 assert.equal(batch.runs[1].status,'error');assert.match(batch.runs[1].error,/本地恢复/);assert.equal(batch.runs[1].attempts.length,1);
 assert.equal(batch.runs[2].status,'error');assert.equal(batch.runs[2].attempts.length,1);assert.equal(batch.completionState,'with_issues');
});

test('local content failures neither increment nor clear the systemic-failure streak',async()=>{
 const {PB,context}=environment(),batch=await PB.createBatch([paper()],config({repeats:6,retries:0,concurrency:1}),'系统计数与内容故障分离');let calls=0;
 context.fetch=async()=>{calls++;return calls%2===0?response(PB,{finish:'length'}):response(PB,{status:429,raw:'{"error":{"message":"rate limited"}}'});};
 await assert.rejects(PB.runBatch(batch,'test'),/连续3次网络/);
 assert.equal(calls,5);assert.equal(batch.runs.filter(r=>r.attempts[0]?.errorScope==='system').length,3);assert.equal(batch.runs.filter(r=>r.attempts[0]?.errorScope==='review').length,2);assert.equal(batch.runs[5].status,'pending');
});

test('unsupported PDF input stops after one request and blocks every remaining slot on resume without changing the frozen settings',async()=>{
 const {PB,context}=environment();let calls=0;
 PB.setLocalRoute({upstream:'https://mock.invalid/v1/chat/completions',endpoint:'http://127.0.0.1:8787/v1/chat/completions',routeId:'c'.repeat(48),token:'b'.repeat(64)});
 const papers=Array.from({length:4},(_,i)=>({...paper('pdf-'+i),pdf:{sha256:String(i+1).repeat(64),size:1200}}));
 const batch=await PB.createBatch(papers,config({inputMode:'pdf',repeats:1,concurrency:1,retries:3}),'不支持PDF的接口');
 const frozen=JSON.stringify({config:batch.config,protocol:batch.protocol});
 context.fetch=async()=>{calls++;return response(PB,{status:400,raw:JSON.stringify({error:{code:'unsupported_input_format',message:'This API only accepts text input.',upstream_status:400},proxyDiagnostics:{bodyTruncated:true,bytesRead:100000,mediaEchoRedacted:true,bodyPreview:'unsupported file_url'}})});};
 await assert.rejects(PB.runBatch(batch,'test'),/原始 PDF.*兼容配置.*新建批次/);
 assert.equal(calls,1);assert.equal(batch.status,'paused');assert.equal(batch.runs.filter(r=>r.status==='pending').length,3);
 const failed=batch.runs.find(r=>r.status==='error'),attempt=failed.attempts[0];
 assert.equal(attempt.errorCode,'unsupported_input_format');assert.equal(attempt.errorScope,'global');assert.equal(attempt.retryable,false);assert.equal(attempt.upstreamStatus,400);assert.equal(attempt.proxyDiagnostics.bodyTruncated,true);
 const oldRuns=JSON.stringify(batch.runs);await assert.rejects(PB.runBatch(batch,'test'),/旧批次不会继续发送/);
 assert.equal(calls,1);assert.equal(JSON.stringify(batch.runs),oldRuns);assert.equal(JSON.stringify({config:batch.config,protocol:batch.protocol}),frozen);
 assert.ok(!batch.pauseReason.includes('提取文本'));
 context.fetch=async(_,options)=>{calls++;assert.equal(JSON.parse(options.body).messages[1].content[0].type,'file_url');return response(PB);};
 const compatibleBatch=await PB.createBatch(papers,config({inputMode:'pdf',repeats:1,concurrency:1}),'服务兼容原始PDF后的新批次');
 await PB.runBatch(compatibleBatch,'test');assert.equal(calls,5);assert.equal(compatibleBatch.completionState,'full');
});

test('direct SGLang and structured Pydantic file validation errors are global format failures, with base64 echoes removed from diagnostic records',async()=>{
 const examples=[
  {object:'error',message:"25 validation errors for ChatCompletionRequest\nbody.messages.1.content.str\n Input should be a valid string [type=string_type, input_value=[{'type': 'file_url', 'file_url': {'url': 'data:application/pdf;base64,"+'QUFB'.repeat(20000)+"'}, 'paper': 'maximum context length exceeded'}], input_type=list]",type:'BadRequestError',code:400},
  {detail:[{type:'literal_error',loc:['body','messages',1,'content',0,'type'],msg:"Input should be 'text' or 'image_url'",input:{type:'file_url',file_url:{url:'data:application/pdf;base64,JVBERi0xLjQ='},paper:'maximum context length exceeded'}}]}
 ];
 for(const envelope of examples){
  const {PB,context}=environment();let calls=0;const batch=await PB.createBatch([paper('a'),paper('b')],config({repeats:1,concurrency:1,retries:3}),'直接格式错误');
  context.fetch=async()=>{calls++;return response(PB,{status:422,raw:JSON.stringify(envelope)});};
  await assert.rejects(PB.runBatch(batch,'test'),/不支持.*PDF/);
  const attempt=batch.runs[0].attempts[0];assert.equal(calls,1);assert.equal(attempt.errorCode,'unsupported_input_format');assert.equal(attempt.mediaEchoRedacted,true);
  assert.ok(!attempt.responseBody.includes('data:application/pdf;base64,'));assert.ok(attempt.responseBody.includes('[MEDIA_DATA_URL_REDACTED]'));assert.ok(attempt.error.length<1800);assert.ok(!attempt.error.includes('maximum context'));
 }
});

test('historical unnormalized HTTP 400 file_url rejection blocks pending papers before any request while preserving the original attempt',async()=>{
 const {PB,context}=environment();let calls=0;context.fetch=async()=>{calls++;return response(PB);};
 const batch=await PB.createBatch([paper('a'),paper('b'),paper('c'),paper('d')],config({repeats:1,concurrency:1}),'旧版PDF失败');
 const raw=JSON.stringify({object:'error',message:"25 validation errors for ChatCompletionRequest\nmessages.1.content.str\nInput should be a valid string [type=string_type, input_value=[{'type':'file_url','file_url':{'url':'data:application/pdf;base64,"+'QUFB'.repeat(1600000)+"'}}], input_type=list]",type:'BadRequestError',code:400});
 batch.status='paused';batch.runs[0].status='error';batch.runs[0].attempts=[{id:'original-sglang-failure',status:'error',errorCode:'http',retryable:false,httpStatus:400,responseBody:raw,error:'HTTP 400'}];
 const oldAttempt=JSON.stringify(batch.runs[0].attempts),oldProtocol=JSON.stringify(batch.protocol);
 await assert.rejects(PB.runBatch(batch,'test'),/新建批次/);
 assert.equal(calls,0);assert.equal(batch.runs.filter(r=>r.status==='pending').length,3);assert.equal(JSON.stringify(batch.runs[0].attempts),oldAttempt);assert.equal(JSON.stringify(batch.protocol),oldProtocol);assert.ok(batch.pauseReason.length<1800);
 assert.equal(batch.executionEvents.at(-1).attemptId,'original-sglang-failure');
});

test('oversized upstream responses are never retried or resumed, including normalized error envelopes returned with HTTP 200',async()=>{
 for(const status of [200,502]){
  const {PB,context}=environment();let calls=0;
  const batch=await PB.createBatch([paper('a'),paper('b')],config({repeats:1,concurrency:1,retries:3}),'响应超大');
  context.fetch=async()=>{calls++;return response(PB,{status,raw:JSON.stringify({error:{code:'upstream_response_too_large',message:'Response exceeded the allowed byte limit.',upstream_status:200},proxyDiagnostics:{bodyTruncated:true,bytesRead:12582913,bodyPreview:'{"choices":['}})});};
  await assert.rejects(PB.runBatch(batch,'test'),/响应超过.*大小限制/);
  const attempt=batch.runs[0].attempts[0];assert.equal(calls,1);assert.equal(attempt.errorCode,'upstream_response_too_large');assert.equal(attempt.retryable,false);assert.equal(attempt.errorScope,'global');assert.equal(attempt.upstreamStatus,200);assert.equal(attempt.proxyDiagnostics.bytesRead,12582913);
  await assert.rejects(PB.runBatch(batch,'test'),/新建批次/);assert.equal(calls,1);assert.equal(batch.runs[1].attempts.length,0);
 }
});

test('unsupported file input stops new work while concurrent requests drain without cancellation',async()=>{
 const {PB,context}=environment(),batch=await PB.createBatch(Array.from({length:4},(_,i)=>paper('format-'+i)),config({repeats:1,concurrency:3,retries:3}),'格式错误排空');
 let calls=0,aborted=0,release,started;const allStarted=new Promise(r=>started=r),pending=new Promise(r=>release=r);
 context.fetch=async(_,options)=>{const n=++calls;options.signal.addEventListener('abort',()=>aborted++);if(n===3)started();if(n===1)return response(PB,{status:400,raw:'{"error":{"message":"Unsupported input format: file_url"}}'});await pending;return response(PB);};
 const running=PB.runBatch(batch,'test');const rejected=assert.rejects(running,/不支持.*PDF/);await allStarted;await new Promise(r=>setTimeout(r,5));
 assert.equal(calls,3);assert.equal(aborted,0);assert.equal(batch.status,'running');assert.equal(batch.draining,true);assert.match(batch.pauseReason,/新建批次/);
 release();await rejected;assert.equal(batch.status,'paused');assert.equal(batch.draining,undefined);assert.equal(calls,3);assert.equal(aborted,0);assert.equal(batch.runs.filter(r=>r.status==='success').length,2);assert.equal(batch.runs.filter(r=>r.status==='pending').length,1);
});

test('explicit context errors remain local and error-payload sanitization never changes a valid model response',async()=>{
 const {PB,context}=environment(),batch=await PB.createBatch([paper()],config({repeats:2,concurrency:1}),'错误字段判别');let calls=0,successfulRaw;
 context.fetch=async()=>{
  if(++calls===1)return response(PB,{status:400,raw:JSON.stringify({error:{code:'context_length_exceeded',message:'maximum context length exceeded',input:{content:[{type:'file_url'}],paper:'file_url is unsupported'}}})});
  const valid=review(PB);valid.summary+=' Literal diagnostic marker data:text/plain;base64,QUFB';successfulRaw=JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(valid)}}]});return response(PB,{raw:successfulRaw});
 };
 await PB.runBatch(batch,'test');assert.equal(calls,2);assert.equal(batch.status,'complete');assert.equal(batch.runs[0].attempts[0].errorCode,'context_limit');assert.equal(batch.runs[1].status,'success');assert.equal(batch.runs[1].attempts[0].responseBody,successfulRaw);assert.equal(batch.runs[1].attempts[0].mediaEchoRedacted,undefined);
});
