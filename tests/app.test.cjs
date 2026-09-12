'use strict';
/* Lightweight DOM integration checks. This is not a browser/layout test. No network is used. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { makeV2Review, TEXT: FIXTURE_TEXT } = require('./v2_fixture.cjs');
const load = name => fs.readFileSync(path.join(__dirname, name), 'utf8');

async function appEnvironment(savedEntries = [], options = {}) {
  const nodes = new Map(), downloads = [], blobURLs = new Map(), storage = new Map(savedEntries), errors = [], timerHandles = new Set();
  let nextBlob = 0, networkCalls = 0; const clipboardTexts=[];
  const classList = () => ({ toggle() {}, add() {}, remove() {} });
  function element(tag = 'div', id = '', attributes = '') {
    let value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '', html = '';
    const node = { tagName: tag.toUpperCase(), id, disabled: false, hidden: /\bhidden\b/.test(attributes), checked: /\bchecked\b/.test(attributes), dataset: {}, style: {}, className: '', classList: classList(), textContent: '', files: [], listeners: {},
      get value() { return value; }, set value(x) { value = String(x); },
      get innerHTML() { return html; }, set innerHTML(x) { html = String(x); parseIds(html); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      focus() {}, append() {}, remove() {},
      click() { if (this.tagName === 'A') downloads.push({ name: this.download, blob: blobURLs.get(this.href) }); else return this.onclick?.({ target: this }); },
      closest(selector) { const match = selector.match(/^\[data-([a-z]+)\]$/); return match && this.dataset[match[1]] !== undefined ? this : null; }
    };
    const tab = attributes.match(/\bdata-tab="([^"]*)"/)?.[1]; if (tab) node.dataset.tab = tab;
    if (id) nodes.set(id, node);
    return node;
  }
  function parseIds(html) {
    for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) element(match[1], match[3], match[2]);
  }
  const template = load('template.html'); parseIds(template);
  const tabs = [...template.matchAll(/<button\b([^>]*data-tab="[^"]+"[^>]*)>/gi)].map(m => element('button', '', m[1]));
  const containers = { '.tabs': element('nav'), '.results-area': element('section') };
  const document = {
    getElementById: id => nodes.get(id) || null,
    querySelector: selector => containers[selector] || null,
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return tabs;
      if (selector === '.tab-panel') return ['overview', 'compare', 'audit', 'history', 'method'].map(id => nodes.get(id));
      if (selector.startsWith('.library ')) return [...nodes.values()].filter(n => ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(n.tagName));
      return [];
    },
    createElement: tag => element(tag), body: element('body')
  };
  class LocalURL extends URL {
    static createObjectURL(blob) { const url = 'blob:test/' + nextBlob++; blobURLs.set(url, blob); return url; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    URL: LocalURL, AbortController, TextEncoder, Uint8Array, Uint32Array, DataView, crypto: webcrypto, Blob, structuredClone, document, btoa: s=>Buffer.from(s,'binary').toString('base64'),
    navigator: { clipboard: { writeText: async text => {clipboardTexts.push(text);} } },
    window: { addEventListener() {} }, location:options.location,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(String(key), String(value)), removeItem: key => storage.delete(key) },
    fetch: async (...args) => { networkCalls++; if(options.fetch)return options.fetch(...args);throw new Error('Live network is forbidden in this test'); },
    setTimeout(fn, ms) { const handle = setTimeout(() => { timerHandles.delete(handle); try { fn(); } catch (error) { errors.push(error); } }, options.keepRequestTimeouts&&ms>1000?ms:Math.min(ms, 5)); timerHandles.add(handle); return handle; },
    clearTimeout(handle) { timerHandles.delete(handle); clearTimeout(handle); }
  });
  for (const file of ['core.js', 'transport.js', 'app.js']) vm.runInContext(load(file), context, { filename: file });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 8)); assert.equal(errors.length, 0, errors.map(e => e.stack).join('\n')); };
  await flush();
  // Legacy UI cases explicitly exercise text mode; native PDF cases opt in.
  if(!options.nativePDF && nodes.has('inputMode'))nodes.get('inputMode').value='text';
  assert.ok(!nodes.get('notice').textContent.startsWith('启动异常'), nodes.get('notice').textContent);
  const switchTab = tab => containers['.tabs'].onclick({ target: tabs.find(t => t.dataset.tab === tab) });
  const action = async name => containers['.results-area'].listeners.click({ target: { closest: () => ({ dataset: { action: name } }) } });
  const archive = async () => { nodes.get('exportJSON').onclick(); const last = downloads.at(-1); assert.ok(last && last.name.endsWith('.json'), nodes.get('notice').textContent); return JSON.parse(await last.blob.text()); };
  return { nodes, downloads, storage, context, clipboardTexts, change: (id,value) => { const node=nodes.get(id);node.value=value;containers['.results-area'].listeners.change({target:node}); }, PB: context.PB, flush, switchTab, action, archive, networkCount: () => networkCalls, dispose: () => { for (const handle of timerHandles) clearTimeout(handle); } };
}

function mockCompletion(PB, quote, options = {}) {
  const result = makeV2Review(quote, options); if(options.mutate)options.mutate(result);
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'mock-model-version', system_fingerprint: 'fp_test', usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) };
}

test('UI initialization, short-text local demo, all result tabs and JSON/CSV exports work without network', async () => {
  const app = await appEnvironment();
  try {
    assert.equal(app.nodes.get('model').value, app.PB.DEFAULT_CONFIG.model);
    assert.equal(app.nodes.get('repeats').value, String(app.PB.DEFAULT_CONFIG.repeats));
    await app.nodes.get('demoBtn').onclick();
    await app.flush();
    assert.match(app.nodes.get('batchBadge').textContent, /模拟/);
    for (const tab of ['overview', 'compare', 'audit', 'history', 'method']) {
      app.switchTab(tab); assert.ok(app.nodes.get(tab).innerHTML.length > 100, tab);
    }
    assert.match(app.nodes.get('compare').innerHTML, /模拟评审理由/);
    assert.match(app.nodes.get('overview').innerHTML, /<svg/);
    const archive = await app.archive();
    assert.equal(archive.batches.length, 1); assert.equal(archive.batches[0].demo, true); assert.equal(archive.batches[0].runs.length, 60);
    assert.ok(archive.batches[0].papers.every(p => p.text.length < 1000));
    assert.ok(archive.batches[0].runs.every(r => r.status === 'success'));
    await app.action('summaryCSV');
    const summary = await app.downloads.at(-1).blob.text();
    assert.match(summary, /total_median_of_round_means/);
    assert.ok(!summary.startsWith('\uFEFF\uFEFF'), 'CSV 不应包含双 BOM');
    app.nodes.get('exportCSV').onclick();
    const rawCSV = await app.downloads.at(-1).blob.text();
    assert.match(rawCSV, /response_raw/); assert.match(rawCSV, /synthetic-not-a-model/);
    assert.equal(app.networkCount(), 0);
  } finally { app.dispose(); }
});

test('UI scoring, escaping, reload and archive import preserve hashes and exclude the unsaved API key', async () => {
  const app = await appEnvironment(); let restored;
  try {
    const key = 'MOCK-API-KEY-DO-NOT-PERSIST';
    app.nodes.get('apiKey').value = key;
    app.nodes.get('endpoint').value = 'https://mock.invalid/v1';
    app.nodes.get('model').value = 'mock-model'; app.nodes.get('repeats').value = '3';
    app.nodes.get('rememberKey').checked = false; app.nodes.get('saveConfigBtn').onclick();
    const quote = '本研究在固定数据划分下进行重复实验，并报告各条件下的误差。';
    app.nodes.get('paperTitle').value = '<img src=x onerror=alert(1)>';
    app.nodes.get('paperVersion').value = 'v1'; app.nodes.get('paperGroup').value = '测试系列';
    app.nodes.get('paperText').value = quote + '\n本研究完整说明样本来源、理论假设与基线配置。补充表格列出了全部重复结果，结论仅限当前测试条件。';
    app.nodes.get('paperForm').onsubmit({ preventDefault() {} });
    let calls = 0;
    app.context.fetch = async (_, options) => { calls++; assert.equal(options.headers.Authorization, 'Bearer ' + key); assert.ok(!options.body.includes('<img src=x')); return mockCompletion(app.PB, quote); };
    await app.nodes.get('runBtn').onclick(); await app.flush();
    assert.equal(calls, 3); assert.match(app.nodes.get('overview').innerHTML, /&lt;img/); assert.ok(!app.nodes.get('overview').innerHTML.includes('<img src=x'));
    const archive = await app.archive();
    assert.ok(archive.batches[0].runs.every(r => r.status === 'success'));
    assert.ok(!JSON.stringify(archive).includes(key)); assert.ok(!JSON.stringify([...app.storage]).includes(key));
    assert.equal(archive.batches[0].papers[0].hash, await app.PB.hashText(archive.papers[0].text));
    restored = await appEnvironment([...app.storage]);
    const reloaded = await restored.archive();
    assert.equal(reloaded.batches.length, 1); assert.equal(reloaded.batches[0].protocol.snapshotHash, archive.batches[0].protocol.snapshotHash);
    assert.equal(restored.nodes.get('apiKey').value, '');
    // Re-check imported protocol hashes through the real scheduler; successful calls must never re-run.
    await restored.PB.runBatch(reloaded.batches[0], '');
    assert.equal(restored.networkCount(), 0);
    const serialized = JSON.stringify(archive);
    const input = restored.nodes.get('importFile'); input.files = [{ size: serialized.length, text: async () => serialized }];
    await input.onchange({ target: input });
    assert.match(restored.nodes.get('notice').textContent, /合并导入 0 个/);
  } finally { app.dispose(); restored?.dispose(); }
});

test('PDF placeholder can persist and reload while scoring rejects its empty text', async () => {
  const app = await appEnvironment(); let restored;
  try {
    const input = app.nodes.get('paperFiles'); input.files = [{ name: 'pending-paper.pdf', type: 'application/pdf', size: 100 }];
    await input.onchange({ target: input }); await app.flush();
    assert.match(app.nodes.get('paperList').innerHTML, /正文为空/);
    const archive = await app.archive();
    assert.equal(archive.papers.length, 1); assert.equal(archive.papers[0].text, '');
    restored = await appEnvironment([...app.storage]);
    assert.match(restored.nodes.get('paperList').innerHTML, /pending-paper/);
    await restored.nodes.get('runBtn').onclick();
    assert.match(restored.nodes.get('notice').textContent, /正文为空/);
    assert.equal(restored.networkCount(), 0);
  } finally { app.dispose(); restored?.dispose(); }
});

test('invalid saved records are protected from automatic overwrite and remain downloadable for recovery', async () => {
  for (const original of [JSON.stringify({ schemaVersion: 99, mustKeep: 'recovery-only-record' }), '{"schemaVersion":1,"batches":[BROKEN']) {
    const app = await appEnvironment([['paperbench-state-v1', original]]);
    try {
      assert.equal(app.storage.get('paperbench-state-v1'), original, '启动不能覆盖未加载的原始记录');
      assert.equal(app.nodes.get('recoveryBtn').hidden, false);
      app.nodes.get('recoveryBtn').onclick();
      const recovery = await app.downloads.at(-1).blob.text();
      if (original.includes('[BROKEN')) assert.equal(recovery, original);
      else assert.equal(JSON.stringify(JSON.parse(recovery)), original);
      app.nodes.get('saveConfigBtn').onclick(); await app.flush();
      assert.equal(app.storage.get('paperbench-state-v1'), original, '后续自动保存也必须尊重恢复保护');
    } finally { app.dispose(); }
  }
});

test('rapid repeated start clicks create only one billable batch', async () => {
  const app = await appEnvironment();
  try {
    app.nodes.get('endpoint').value = 'https://mock.invalid/v1'; app.nodes.get('model').value = 'mock-model';
    app.nodes.get('repeats').value = '3'; app.nodes.get('apiKey').value = 'DUPLICATE-START-TEST-KEY';
    const quote = '本研究通过固定基线和相同数据划分测试方法，并报告重复实验结果。';
    app.nodes.get('paperTitle').value = '并发点击回归'; app.nodes.get('paperText').value = quote;
    app.nodes.get('paperForm').onsubmit({ preventDefault() {} });
    let calls = 0;
    app.context.fetch = async () => { calls++; return mockCompletion(app.PB, quote); };
    const first = app.nodes.get('runBtn').onclick();
    const second = app.nodes.get('runBtn').onclick();
    await Promise.all([first, second]); await app.flush();
    const archive = await app.archive();
    assert.equal(archive.batches.length, 1); assert.equal(calls, 3);
    assert.equal(archive.batches[0].runs.length, 3);
  } finally { app.dispose(); }
});

async function addPaper(app, title, text = FIXTURE_TEXT) {
  app.nodes.get('newPaper').onclick();
  app.nodes.get('paperTitle').value = title;
  app.nodes.get('paperText').value = text;
  app.nodes.get('paperForm').onsubmit({ preventDefault() {} });
}
async function importArchive(app, value) {
  const serialized=JSON.stringify(value), node=app.nodes.get('importFile');
  node.files=[{size:serialized.length,text:async()=>serialized}];
  await node.onchange({target:node}); await app.flush();
}
async function syntheticArchive(app, { legacy = false, levels = [3,3,2], incomplete = false } = {}) {
  const papers=levels.map((_,i)=>({id:'p'+(i+1),title:'合成论文'+(i+1),group:'',version:'测试',kind:'reference',change:'other',text:FIXTURE_TEXT}));
  const batch=await app.PB.createBatch(papers,{...app.PB.DEFAULT_CONFIG,repeats:3,apiKey:''},'无网络测试归档');
  if(legacy)batch.protocol={id:'legacy-mm-protocol',systemPrompt:'历史多模态评分协议：直接给分并要求引用原文。',version:'PB-MM-1.0'};
  for(const r of batch.runs){
    const i=papers.findIndex(p=>p.id===r.paperId);
    let result=makeV2Review(FIXTURE_TEXT,{level:levels[i]});
    if(legacy)result={dimensions:app.PB.DIMS.map(d=>({id:d.id,score:6.25,evidence:[{quote:FIXTURE_TEXT,location:'旧论文全文'}],reason:'这是保留的历史直接评分理由，评分结论需要按当时固定协议理解和核查。',improvement:'请保留历史原始记录及其对应的论文正文证据。'})),summary:'这是历史结果，保持原始分数并按原协议解释。',limitations:'未进行外部真实性与实验复现核验。'};
    if(incomplete&&i===levels.length-1&&r.round===3){r.status='pending';continue;}
    r.status='success';r.result=app.PB.parseReview(JSON.stringify(result),FIXTURE_TEXT);r.attempts=[];
  }
  batch.status=incomplete?'paused':'complete';
  return {schemaVersion:1,config:{...app.PB.DEFAULT_CONFIG,apiKey:''},papers,batches:[batch],currentBatchId:batch.id};
}

test('v2 deep review renders claim audit, four checks, cap calculation, both arguments and revisions; exports and copied notes preserve them', async () => {
  const app=await appEnvironment();
  try {
    app.nodes.get('endpoint').value='https://mock.invalid/v1';app.nodes.get('model').value='mock-model';app.nodes.get('repeats').value='3';
    await addPaper(app,'深评检查');
    app.context.fetch=async()=>mockCompletion(app.PB,FIXTURE_TEXT,{levels:{rigor:[0,4,4,4]},mutate:z=>{z.analysis.strongestSupport.text+=' <img src=x onerror=alert(1)>';z.analysis.centralClaims[0].claim+=' <script>alert(1)</script>';}});
    await app.nodes.get('runBtn').onclick();await app.flush();
    const overview=app.nodes.get('overview').innerHTML;
    assert.ok(overview.indexOf('最强支持论证')<overview.indexOf('五维评分总表'),'positive/negative reasoning must be visible before the score table');
    assert.ok(overview.indexOf('最强反对论证')<overview.indexOf('五维评分总表'));
    app.switchTab('audit');const html=app.nodes.get('audit').innerHTML;
    assert.match(html,/中心主张审计/);assert.match(html,/替代解释/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>'));assert.match(html,/四项检查与本地计分/);
    assert.match(html,/等级 0 \/ 4/);assert.match(html,/上限触发/);assert.match(html,/固定上限 4\.00/);
    assert.match(html,/按优先级修订与核查/);assert.match(html,/P1/);assert.match(html,/citation|文字已匹配|原文已匹配/);
    assert.equal((html.match(/class="check-item"/g)||[]).length,60,'three rounds each contain 20 checks');
    await app.action('copyReasons');
    assert.match(app.clipboardTexts.at(-1),/中心主张审计/);assert.match(app.clipboardTexts.at(-1),/四项检查/);assert.match(app.clipboardTexts.at(-1),/修订优先级/);
    const archive=await app.archive();assert.equal(archive.batches[0].runs[0].result.schemaVersion,2);
    assert.equal(archive.batches[0].runs[0].result.dimensions.find(d=>d.id==='rigor').score,4);
    app.nodes.get('exportCSV').onclick();const csv=await app.downloads.at(-1).blob.text();
    assert.match(csv,/analysis_json/);assert.match(csv,/checks_json/);assert.match(csv,/revisions_json/);
  } finally {app.dispose();}
});

test('null check makes its dimension and round total unavailable; other dimensions retain their own n and no rank is assigned', async () => {
  const app=await appEnvironment();
  try {
    app.nodes.get('endpoint').value='https://mock.invalid/v1';app.nodes.get('model').value='mock-model';app.nodes.get('repeats').value='3';
    await addPaper(app,'缺失材料检查');let calls=0;
    app.context.fetch=async()=>{
      const result=makeV2Review(FIXTURE_TEXT);calls++;
      if(calls===1){const item=result.dimensions.find(d=>d.id==='rigor').items[0];Object.assign(item,{level:null,status:'unavailable',missing:'输入没有提供判断本项所需的假设材料，无法负责任分档。',evidenceIndices:[]});}
      return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};
    };
    await app.nodes.get('runBtn').onclick();await app.flush();
    const archive=await app.archive(), b=archive.batches[0], summary=app.PB.summarize(b,b.papers[0].id);
    assert.equal(calls,3,'one unscorable dimension must not stop other planned reviews');assert.equal(b.status,'complete');assert.equal(b.completionState,'with_issues');
    assert.equal(summary.completeRuns,2);assert.equal(summary.dimensions.rigor.n,2);assert.equal(summary.dimensions.evidence.n,3);
    const html=app.nodes.get('overview').innerHTML;
    assert.match(html,/总分 n=2/);assert.match(html,/n=3/);assert.match(html,/n=2/);assert.match(html,/暂估/);assert.match(html,/待全批完成/);
    app.switchTab('audit');assert.match(app.nodes.get('audit').innerHTML,/四项未全部可评，本维总分留空/);
    await app.action('summaryCSV');assert.match(await app.downloads.at(-1).blob.text(),/rigor_n/);
  } finally {app.dispose();}
});

test('legacy v1/MM archive remains browsable with unchanged scores, no fabricated checks, and no automatic endpoint replacement', async () => {
  const source=await appEnvironment();let restored;
  try {
    const old=await syntheticArchive(source,{legacy:true,levels:[3],incomplete:true});
    old.config.endpoint='https://existing-provider.invalid/v1';old.config.model='existing-old-model';
    restored=await appEnvironment([['paperbench-state-v1',JSON.stringify(old)]]);
    assert.equal(restored.nodes.get('endpoint').value,'https://existing-provider.invalid/v1');assert.equal(restored.nodes.get('model').value,'existing-old-model');
    restored.switchTab('audit');const html=restored.nodes.get('audit').innerHTML;
    assert.match(html,/历史 v1 直接评分结果/);assert.match(html,/6\.25 \/ 10/);assert.ok(!html.includes('class="check-item"'));
    assert.equal(restored.nodes.get('resumeBtn').hidden,true,'legacy protocol cannot be resumed through v2 scoring');
    const exported=await restored.archive();const valid=exported.batches[0].runs.filter(r=>r.status==='success');
    assert.ok(valid.every(r=>r.result.dimensions.every(d=>d.score===6.25&&!d.items)));
    assert.equal(exported.batches[0].protocol.id,'legacy-mm-protocol');assert.equal(restored.networkCount(),0);
  } finally {source.dispose();restored?.dispose();}
});

test('full batches use competition ranks for exact ties; incomplete batches keep input order and have no rank', async () => {
  const app=await appEnvironment();
  try {
    const complete=await syntheticArchive(app);await importArchive(app,complete);
    const html=app.nodes.get('overview').innerHTML;
    assert.equal((html.match(/class="rank">01</g)||[]).length,2);assert.match(html,/class="rank">03</);
    await app.action('summaryCSV');let csv=await app.downloads.at(-1).blob.text();
    const lines=csv.trim().split(/\r?\n/).slice(1);assert.equal(lines[0].split(',')[0],'"1"');assert.equal(lines[1].split(',')[0],'"1"');assert.equal(lines[2].split(',')[0],'"3"');
    const partial=await syntheticArchive(app,{levels:[2,4,3],incomplete:true});await importArchive(app,partial);
    const partialHTML=app.nodes.get('overview').innerHTML;
    assert.equal((partialHTML.match(/class="rank">待全批完成</g)||[]).length,3);
    await app.action('summaryCSV');csv=await app.downloads.at(-1).blob.text();
    assert.ok(csv.trim().split(/\r?\n/).slice(1).every(line=>line.startsWith('"",')));
    assert.match(partialHTML,/检查项的跨轮等级波动/);assert.match(partialHTML,/单位不同/);assert.match(partialHTML,/论文间中位分范围/);assert.match(partialHTML,/典型 SD/);assert.match(partialHTML,/不等于排序显著/);
    assert.equal(app.networkCount(),0);
  } finally {app.dispose();}
});

test('GLM preset updates only working settings, preserves typed key and historical protocol, and round-trips new generation fields', async () => {
  const app=await appEnvironment();let restored;
  try {
    const old=await syntheticArchive(app,{legacy:true,levels:[3]});await importArchive(app,old);
    const before=JSON.stringify((await app.archive()).batches[0]);
    app.nodes.get('endpoint').value='https://custom.invalid/v1';app.nodes.get('model').value='custom-model';
    app.nodes.get('thinking').value='omit';app.nodes.get('reasoningEffort').value='omit';app.nodes.get('doSample').checked=false;
    app.nodes.get('apiKey').value='TYPED-PRESET-TEST-KEY';app.nodes.get('saveConfigBtn').onclick();
    assert.equal((await app.archive()).config.doSample,false);
    app.nodes.get('glmPresetBtn').onclick();await app.flush();
    for(const id of ['endpoint','model','thinking','reasoningEffort'])assert.equal(app.nodes.get(id).value,String(app.PB.DEFAULT_CONFIG[id]));
    assert.equal(app.nodes.get('doSample').checked,app.PB.DEFAULT_CONFIG.doSample);
    assert.equal(app.nodes.get('apiKey').value,'TYPED-PRESET-TEST-KEY');
    assert.equal(JSON.stringify((await app.archive()).batches[0]),before);
    assert.ok(!JSON.stringify([...app.storage]).includes('TYPED-PRESET-TEST-KEY'));
        restored=await appEnvironment([...app.storage]);
    assert.equal(restored.nodes.get('thinking').value,app.PB.DEFAULT_CONFIG.thinking);assert.equal(restored.nodes.get('doSample').checked,true);
    assert.equal(app.networkCount(),0);
  } finally {app.dispose();restored?.dispose();}
});

test('local default profile configures same-origin proxy without storing service credential or session token',async()=>{
 const endpoint='http://127.0.0.1:8787/v1/chat/completions',token='b'.repeat(64);
 const app=await appEnvironment([],{location:{protocol:'http:',hostname:'127.0.0.1',href:'http://127.0.0.1:8787/'},fetch:async url=>{assert.equal(url,'http://127.0.0.1:8787/local-config');return{ok:true,json:async()=>({endpoint,token,credentialReady:true,config:{model:'glm-5.3-flash',endpoint}})};}});
 try{
  assert.equal(app.networkCount(),1);assert.equal(app.nodes.get('endpoint').value,app.PB.DEFAULT_CONFIG.endpoint);assert.equal(app.nodes.get('apiKey').value,'');
  assert.match(app.nodes.get('credentialStatus').textContent,/默认GLM凭据由本机服务保管/);
  app.nodes.get('glmPresetBtn').onclick();await app.flush();
  assert.equal(app.nodes.get('endpoint').value,app.PB.DEFAULT_CONFIG.endpoint);assert.equal(app.nodes.get('apiKey').value,'');
  assert.match(app.nodes.get('credentialStatus').textContent,/默认GLM凭据由本机服务保管/);
  app.nodes.get('endpoint').value='https://custom.invalid/v1';app.nodes.get('saveConfigBtn').onclick();
  assert.match(app.nodes.get('credentialStatus').textContent,/自定义API仅使用你显式填写的Key/);
  const archive=await app.archive();assert.ok(!JSON.stringify(archive).includes(token));assert.ok(!JSON.stringify([...app.storage]).includes(token));
 }finally{app.dispose();}
});

function localWorkspaceMock(options={}) {
 const origin='http://127.0.0.1:8787',token='b'.repeat(64),routeId='c'.repeat(48),calls=[];
 const official='https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';let source=0,reports=0;
 const ok=value=>({status:200,ok:true,json:async()=>value,text:async()=>JSON.stringify(value)});
 const fetch=async(url,request={})=>{
  const pathname=new URL(url).pathname,body=request.body?JSON.parse(request.body):null;calls.push({pathname,body,headers:request.headers});
  if(pathname==='/local-config')return ok({endpoint:origin+'/v1/chat/completions',upstream:official,token,credentialReady:options.credentialReady!==false,config:{endpoint:official,model:'glm-5.3-flash'},workspace:{enabled:true,defaultInputPath:'/real/input',defaultOutputPath:'/real/output',pdfTextAvailable:true,nativePickerAvailable:true,maxFileBytes:33554432,maxFiles:100}});
  assert.equal(request.headers['X-Paperbench-Token'],token,'all workspace POSTs and scoring routes require session token');
  if(options.handle){const special=await options.handle(pathname,body,request);if(special)return special;}
  if(pathname==='/local-api/configure')return ok({endpoint:body.useDefault?official:(body.endpoint.endsWith('/chat/completions')?body.endpoint:body.endpoint.replace(/\/$/,'')+'/chat/completions'),routeId});
  if(pathname==='/local-files/read')return ok({files:body.paths.map(p=>{const sourcePath=p.startsWith('file://')?decodeURIComponent(new URL(p).pathname):p;return{sourceId:'source-'+(++source),filename:sourcePath.split('/').at(-1),title:'服务提取论文',text:FIXTURE_TEXT,sourcePath,relativePath:sourcePath.split('/').at(-1),sha256:'sha-'+sourcePath,pages:2,warnings:['PDF公式须人工核查']};}),errors:[]});
  if(pathname==='/local-files/upload')return ok({files:body.files.map(f=>({sourceId:'source-'+(++source),filename:f.name,title:f.name,text:FIXTURE_TEXT,sourcePath:null,relativePath:f.relativePath,sha256:'sha-'+f.base64,pages:2,warnings:['以提取文本评分']})),errors:[]});
  if(pathname==='/local-files/pick')return ok({paths:body.kind==='output'?['/picked/output']:['/picked/paper.pdf'],cancelled:false});
  if(pathname==='/local-output/validate')return ok({path:body.path,exists:true,writable:true});
  if(pathname==='/local-reports/save'){reports++;return ok({path:'/real/output/run-'+reports,indexPath:'/real/output/run-'+reports+'/index.html',indexUrl:'/local-reports/view/report-capability-'+reports+'/index.html',files:['index.html','archive.json']});}
  if(pathname==='/v1/chat/completions'){assert.equal(request.headers['X-Paperbench-Route'],routeId);const result=makeV2Review(FIXTURE_TEXT);return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({model:body.model,usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300},choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};}
  throw Error('Unexpected mock path '+pathname);
 };
 return {fetch,calls,token,routeId,origin,options:{location:{protocol:'http:',hostname:'127.0.0.1',href:origin+'/',origin},fetch}};
}
function browserFile(name,text='PDF mock bytes',relativePath='') {const bytes=Uint8Array.from(Buffer.from(text));return{name,size:bytes.length,webkitRelativePath:relativePath,type:name.endsWith('.pdf')?'application/pdf':'text/plain',arrayBuffer:async()=>bytes.buffer,text:async()=>text};}

test('workspace without default credentials still imports real paths/PDF text, deduplicates, and persists only non-secret path preferences',async()=>{
 const service=localWorkspaceMock({credentialReady:false});const app=await appEnvironment([],service.options);let restored;
 try{
  assert.equal(app.nodes.get('inputPaths').value,'/real/input');assert.equal(app.nodes.get('outputPath').value,'/real/output');assert.equal(app.nodes.get('autoSaveReport').checked,true);assert.equal(app.nodes.get('readPathsBtn').disabled,false);
  app.nodes.get('inputPaths').value='/real/input/a.pdf';await app.nodes.get('readPathsBtn').onclick();await app.flush();
  const first=await app.archive();assert.equal(first.papers.length,1);assert.equal(first.papers[0].text,FIXTURE_TEXT);assert.match(app.nodes.get('paperList').innerHTML,/PDF纯文本输入/);assert.match(app.nodes.get('paperList').innerHTML,/\/real\/input\/a.pdf/);
  await app.nodes.get('readPathsBtn').onclick();assert.equal((await app.archive()).papers.length,1);assert.match(app.nodes.get('inputStatus').textContent,/已刷新附件缓存/);
  app.nodes.get('outputPath').value='/custom/reports';app.nodes.get('outputPath').oninput();app.nodes.get('autoSaveReport').checked=false;app.nodes.get('autoSaveReport').onchange();
  const prefs=JSON.parse(app.storage.get('paperbench-workspace-v21'));assert.equal(prefs.outputPath,'/custom/reports');assert.equal(prefs.autoSaveReport,false);assert.equal(Object.keys(prefs.sourceRefs).length,1);
  const archived=JSON.stringify(await app.archive());assert.ok(!archived.includes('source-1'));assert.ok(!archived.includes('/custom/reports'));assert.ok(!JSON.stringify([...app.storage]).includes(service.token));
  restored=await appEnvironment([...app.storage],service.options);assert.equal(restored.nodes.get('outputPath').value,'/custom/reports');assert.equal(restored.nodes.get('autoSaveReport').checked,false);
 }finally{app.dispose();restored?.dispose();}
});

test('drop snapshots DataTransfer entries synchronously and drains every directory readEntries batch without inventing absolute paths',async()=>{
 const service=localWorkspaceMock();const app=await appEnvironment([],service.options);
 try{
  let valid=true,entryReads=0,reads=0;const fileEntry=name=>({name,isFile:true,file:resolve=>resolve(browserFile(name,name))});const chunks=[[fileEntry('first.pdf')],[fileEntry('second.txt')],[]];
  const entry={name:'selected-folder',isDirectory:true,createReader:()=>({readEntries:resolve=>{reads++;resolve(chunks.shift());}})};
  const dt={items:[{webkitGetAsEntry:()=>{assert.equal(valid,true);entryReads++;return entry;}}],files:[],getData:()=>{assert.equal(valid,true);return '';}};
  app.nodes.get('dropZone').ondrop({preventDefault(){},dataTransfer:dt});valid=false;
  assert.equal(entryReads,1);await app.flush();assert.equal(reads,3);
  const upload=service.calls.find(x=>x.pathname==='/local-files/upload');assert.equal(upload.body.files.length,2);assert.equal(upload.body.files[0].relativePath,'selected-folder/first.pdf');assert.ok(upload.body.files.every(x=>!('sourcePath'in x)&&!x.relativePath.startsWith('/')));
  const archive=await app.archive();assert.equal(archive.papers.length,2);assert.match(app.nodes.get('paperList').innerHTML,/浏览器相对路径/);assert.match(app.nodes.get('paperList').innerHTML,/原绝对路径不可得/);
  assert.equal(service.calls.filter(x=>x.pathname==='/local-files/read').length,0);
 }finally{app.dispose();}
});

test('file URI drop uses authorized path reader; uploaded sources remain snapshots when edited',async()=>{
 const service=localWorkspaceMock();const app=await appEnvironment([],service.options);
 try{
  app.nodes.get('dropZone').ondrop({preventDefault(){},dataTransfer:{items:[],files:[],getData:()=> 'file:///real/input/actual%20paper.pdf'}});await app.flush();
  const read=service.calls.find(x=>x.pathname==='/local-files/read');assert.deepEqual(read.body.paths,['file:///real/input/actual%20paper.pdf']);assert.ok(!service.calls.some(x=>x.pathname==='/local-files/upload'));
  app.nodes.get('paperText').value=FIXTURE_TEXT+'\n增加了一句用户自己的说明。';app.nodes.get('paperForm').onsubmit({preventDefault(){}});assert.match(app.nodes.get('paperList').innerHTML,/正文已编辑，源文件仍为导入时快照/);
  await app.nodes.get('pickOutputFolder').onclick();assert.equal(app.nodes.get('outputPath').value,'/picked/output');
 }finally{app.dispose();}
});

test('default local route preflights output, freezes real endpoint, blocks busy input and saves a separate offline report at one round',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),pause=new Promise(r=>release=r);
 const service=localWorkspaceMock({handle:async pathname=>{if(pathname==='/v1/chat/completions'){entered();await pause;}}});const app=await appEnvironment([],service.options);
 try{
  await addPaper(app,'链路检查');app.nodes.get('repeats').value='1';app.nodes.get('repeats').oninput();
  const running=app.nodes.get('runBtn').onclick();await started;
  assert.equal(app.nodes.get('outputPath').disabled,true);assert.equal(app.nodes.get('folderFiles').disabled,true);assert.equal(app.nodes.get('apiKey').disabled,true);
  let touched=false;app.nodes.get('dropZone').ondrop({preventDefault(){},dataTransfer:{items:[{webkitGetAsEntry:()=>{touched=true;throw Error('must not read busy drop');}}]}});assert.equal(touched,false);
  release();await running;await app.flush();
  const configure=service.calls.find(x=>x.pathname==='/local-api/configure');assert.equal(configure.body.useDefault,true);assert.equal(configure.body.apiKey,'');
  assert.ok(service.calls.findIndex(x=>x.pathname==='/local-output/validate')<service.calls.findIndex(x=>x.pathname==='/v1/chat/completions'));
  const archive=await app.archive();assert.equal(archive.batches[0].config.endpoint,app.PB.DEFAULT_CONFIG.endpoint);assert.equal(archive.batches[0].runs.length,1);assert.equal(archive.batches[0].runs[0].status,'success');
  assert.match(app.nodes.get('overview').innerHTML,/仅链路检查/);assert.match(app.nodes.get('outputStatus').innerHTML,/\/real\/output\/run-1/);assert.match(app.nodes.get('outputStatus').innerHTML,/打开已保存的离线报告/);
  const serialized=JSON.stringify(archive);assert.ok(!serialized.includes(service.token));assert.ok(!serialized.includes(service.routeId));assert.ok(!JSON.stringify([...app.storage]).includes('report-capability'));
 }finally{release?.();app.dispose();}
});

test('custom API uses only its explicit key and preserves selected model parameters; keys are never persisted',async()=>{
 const service=localWorkspaceMock();const app=await appEnvironment([],service.options);
 try{
  app.nodes.get('apiMode').value='custom';app.nodes.get('apiMode').onchange();assert.equal(app.nodes.get('apiKey').disabled,false);
  app.nodes.get('endpoint').value='https://custom.invalid/v1';app.nodes.get('model').value='own-model';app.nodes.get('apiKey').value='CUSTOM-SESSION-ONLY';app.nodes.get('rememberKey').checked=true;
  app.nodes.get('autoSaveReport').checked=false;app.nodes.get('autoSaveReport').onchange();app.nodes.get('repeats').value='1';
  await addPaper(app,'自定义接口');await app.nodes.get('runBtn').onclick();await app.flush();
  const route=service.calls.find(x=>x.pathname==='/local-api/configure');assert.equal(route.body.useDefault,false);assert.equal(route.body.apiKey,'CUSTOM-SESSION-ONLY');assert.match(route.body.endpoint,/custom.invalid/);
  const scoring=service.calls.find(x=>x.pathname==='/v1/chat/completions');assert.equal(scoring.body.model,'own-model');assert.equal(scoring.body.thinking.type,app.nodes.get('thinking').value);assert.equal(scoring.body.do_sample,true);
  assert.ok(!JSON.stringify([...app.storage]).includes('CUSTOM-SESSION-ONLY'));assert.ok(!JSON.stringify(await app.archive()).includes('CUSTOM-SESSION-ONLY'));assert.ok(!service.calls.some(x=>x.pathname==='/local-reports/save'));
 }finally{app.dispose();}
});

test('invalid output blocks scoring; report save failure can be retried without model calls',async()=>{
 let writable=false,failSave=true;const service=localWorkspaceMock({handle:async(pathname)=>{if(pathname==='/local-output/validate'&&!writable)return{ok:false,status:400,json:async()=>({error:'输出目录不可写'})};if(pathname==='/local-reports/save'&&failSave)return{ok:false,status:500,json:async()=>({error:'临时导出故障'})};}});const app=await appEnvironment([],service.options);
 try{
  await addPaper(app,'输出重试检查');app.nodes.get('repeats').value='1';await app.nodes.get('runBtn').onclick();assert.equal(service.calls.filter(x=>x.pathname==='/v1/chat/completions').length,0);assert.match(app.nodes.get('notice').textContent,/输出目录不可写/);assert.equal((await app.archive()).batches.length,0);
  writable=true;await app.nodes.get('runBtn').onclick();await app.flush();assert.equal(service.calls.filter(x=>x.pathname==='/v1/chat/completions').length,1);assert.match(app.nodes.get('outputStatus').textContent,/无需重跑评分/);
  failSave=false;await app.nodes.get('saveReportBtn').onclick();await app.flush();assert.equal(service.calls.filter(x=>x.pathname==='/v1/chat/completions').length,1);assert.match(app.nodes.get('outputStatus').innerHTML,/报告已完整保存/);assert.equal((await app.archive()).batches.length,1);
 }finally{app.dispose();}
});


test('resuming a paused batch refuses a different current API endpoint before route creation or any model/file POST',async()=>{
 const service=localWorkspaceMock();const app=await appEnvironment([],service.options);
 try{
  const paused=await syntheticArchive(app,{levels:[3],incomplete:true});await importArchive(app,paused);
  app.nodes.get('apiMode').value='custom';app.nodes.get('apiMode').onchange();app.nodes.get('endpoint').value='https://other-provider.invalid/v1';app.nodes.get('apiKey').value='OTHER-PROVIDER-KEY';app.nodes.get('saveConfigBtn').onclick();
  const callsBefore=service.calls.length;await app.nodes.get('resumeBtn').onclick();await app.flush();
  assert.equal(service.calls.length,callsBefore,'endpoint mismatch must not configure a route, preflight output, or invoke a model');
  assert.match(app.nodes.get('notice').textContent,/当前接口与该历史批次的真实接口不一致/);
  const exported=await app.archive();assert.equal(exported.batches[0].runs.filter(r=>r.status==='pending').length,1);assert.ok(!JSON.stringify(exported).includes('OTHER-PROVIDER-KEY'));
 }finally{app.dispose();}
});


test('reimporting identical source bytes refreshes attachment refs for the original paper and old batch without replacing edited text',async()=>{
 let reads=0,changed=false;
 const service=localWorkspaceMock({handle:async(pathname,body)=>{if(pathname==='/local-files/read')return{ok:true,status:200,json:async()=>({files:[{sourceId:'refreshed-source-'+(++reads),filename:'paper.pdf',title:'原始论文',text:FIXTURE_TEXT,sourcePath:body.paths[0],relativePath:'paper.pdf',sha256:changed?'different-file-hash':'original-file-hash',pages:2,warnings:[]}],errors:[]})};}});
 const app=await appEnvironment([],service.options);
 try{
  app.nodes.get('inputPaths').value='/real/input/paper.pdf';await app.nodes.get('readPathsBtn').onclick();
  const original=(await app.archive()).papers[0];app.nodes.get('autoSaveReport').checked=false;app.nodes.get('autoSaveReport').onchange();app.nodes.get('repeats').value='1';await app.nodes.get('runBtn').onclick();
  app.nodes.get('paperText').value=FIXTURE_TEXT+'\n用户编辑，必须保留。';app.nodes.get('paperForm').onsubmit({preventDefault(){}});
  await app.nodes.get('readPathsBtn').onclick();assert.match(app.nodes.get('inputStatus').textContent,/已刷新附件缓存/);
  let archive=await app.archive();assert.equal(archive.papers.length,1);assert.equal(archive.papers[0].id,original.id);assert.match(archive.papers[0].text,/用户编辑，必须保留/);assert.equal(archive.batches[0].papers[0].text,FIXTURE_TEXT);
  let prefs=JSON.parse(app.storage.get('paperbench-workspace-v21'));assert.equal(prefs.sourceRefs[original.id],'refreshed-source-2');assert.equal(prefs.sourceMetadata[original.id].sourceId,'refreshed-source-2');assert.equal(prefs.sourceMetadata[original.id].textWasEdited,true);
  changed=true;await app.nodes.get('readPathsBtn').onclick();assert.match(app.nodes.get('inputStatus').textContent,/文件哈希与已有来源不同/);prefs=JSON.parse(app.storage.get('paperbench-workspace-v21'));assert.equal(prefs.sourceRefs[original.id],'refreshed-source-2');
  await app.nodes.get('saveReportBtn').onclick();const saved=service.calls.find(x=>x.pathname==='/local-reports/save');assert.equal(saved.body.sourceRefs[original.id],'refreshed-source-2');assert.equal(saved.body.archive.batches[0].papers[0].id,original.id);assert.equal(saved.body.archive.batches[0].papers[0].text,FIXTURE_TEXT);assert.equal(service.calls.filter(x=>x.pathname==='/v1/chat/completions').length,1);
 }finally{app.dispose();}
});


test('standalone source provenance hashes actual file bytes and clears legacy remembered credentials',async()=>{
 const app=await appEnvironment([['paperbench-key-v1','LEGACY-SECRET']]);
 try{
  assert.equal(app.nodes.get('apiKey').value,'');assert.ok(!app.storage.has('paperbench-key-v1'));
  const file=browserFile('raw.pdf','actual PDF bytes','relative/raw.pdf');await app.nodes.get('paperFiles').onchange({target:{files:[file],value:'chosen'}});
  const p=(await app.archive()).papers[0],prefs=JSON.parse(app.storage.get('paperbench-workspace-v21'));
  assert.equal(prefs.sourceMetadata[p.id].fileSha256,require('node:crypto').createHash('sha256').update('actual PDF bytes').digest('hex'));assert.equal(prefs.sourceMetadata[p.id].sourcePath,null);assert.equal(p.text,'');
 }finally{app.dispose();}
});


test('repeat input previews call counts immediately without saving configuration or changing frozen batch counts',async()=>{
 const app=await appEnvironment();
 try{
  await addPaper(app,'预览论文一');await addPaper(app,'预览论文二');
  const before=await app.archive();assert.equal(before.config.repeats,5);assert.match(app.nodes.get('progressText').textContent,/计划 10 次评分/);
  app.nodes.get('repeats').value='1';app.nodes.get('repeats').oninput();
  assert.match(app.nodes.get('configSummary').textContent,/1 轮 \/ 篇（未保存预览）/);assert.match(app.nodes.get('progressText').textContent,/计划 2 次评分/);assert.match(app.nodes.get('lowRepeatHint').textContent,/仅用于链路检查/);assert.equal((await app.archive()).config.repeats,5);
  app.nodes.get('repeats').value='';app.nodes.get('repeats').oninput();assert.match(app.nodes.get('progressText').textContent,/预计调用数待定/);assert.match(app.nodes.get('configSummary').textContent,/轮数待校正/);
  const historic=await syntheticArchive(app,{levels:[3]});await importArchive(app,historic);const frozen=JSON.stringify((await app.archive()).batches[0]);
  app.nodes.get('repeats').value='2';app.nodes.get('repeats').oninput();assert.match(app.nodes.get('configSummary').textContent,/2 轮 \/ 篇/);assert.match(app.nodes.get('progressText').textContent,/五维完整 3 \/ 3 次/);assert.match(app.nodes.get('batchMeta').innerHTML,/3 轮/);
  const after=await app.archive();assert.equal(after.config.repeats,5);assert.equal(JSON.stringify(after.batches[0]),frozen);assert.equal(app.networkCount(),0);
 }finally{app.dispose();}
});

const encodingFailure=()=>Object.assign(new Error('A URI supplied to the API was malformed, or the resulting Data URL has exceeded the URL length limitations for Data URLs.'),{name:'EncodingError'});
const dropFiles=(app,dataTransfer)=>app.nodes.get('dropZone').ondrop({preventDefault(){},dataTransfer});

test('direct File snapshot bypasses broken file entry API and optional URI metadata without duplicates',async()=>{
 const service=localWorkspaceMock(),app=await appEnvironment([],service.options);
 try{
  const file=browserFile('中文 空格 % #.pdf','PDF bytes');let readable=true,entryFileCalls=0;
  dropFiles(app,{items:[{getAsFile(){assert.equal(readable,true);return file;},webkitGetAsEntry:()=>({isFile:true,name:file.name,file(ok,bad){entryFileCalls++;bad(encodingFailure());}})}],files:[file],getData(){throw encodingFailure();}});readable=false;
  await app.flush();assert.equal(entryFileCalls,0);assert.equal((await app.archive()).papers.length,1);
  const upload=service.calls.find(x=>x.pathname==='/local-files/upload');assert.equal(upload.body.files.length,1);assert.equal(upload.body.files[0].name,file.name);assert.equal(Buffer.from(upload.body.files[0].base64,'base64').toString(),'PDF bytes');
 }finally{app.dispose();}
});

test('synchronous entry failures fall back to FileList and release busy state',async()=>{
 const service=localWorkspaceMock(),app=await appEnvironment([],service.options);
 try{
  dropFiles(app,{items:[{getAsFile(){throw encodingFailure();},webkitGetAsEntry(){throw encodingFailure();}}],files:[browserFile('recover.txt','recover')],getData:()=>''});await app.flush();
  assert.equal((await app.archive()).papers.length,1);assert.match(app.nodes.get('inputStatus').textContent,/失败 0 项/);assert.equal(app.nodes.get('readPathsBtn').disabled,false);
 }finally{app.dispose();}
});

test('directory EncodingError preserves readable siblings and reports precise failed relative path',async()=>{
 const service=localWorkspaceMock(),app=await appEnvironment([],service.options);
 try{
  let n=0;const dir={name:'目录',isDirectory:true,createReader:()=>({readEntries(ok){ok(n++?[]:[{name:'bad.pdf',isFile:true,file(ok,bad){bad(encodingFailure());}},{name:'good.pdf',isFile:true,file(ok){ok(browserFile('good.pdf','good'));}}]);}})};
  dropFiles(app,{items:[{getAsFile:()=>null,webkitGetAsEntry:()=>dir}],files:[],getData:()=>''});await app.flush();
  assert.equal((await app.archive()).papers.length,1);assert.match(app.nodes.get('inputStatus').textContent,/目录\/bad.pdf/);assert.match(app.nodes.get('inputStatus').textContent,/EncodingError/);assert.match(app.nodes.get('inputStatus').textContent,/选择文件/);assert.match(app.nodes.get('inputStatus').textContent,/失败 1 项/);
 }finally{app.dispose();}
});

test('unreadable bytes do not abort other uploads; all failed entries do not issue upload or model requests',async()=>{
 const service=localWorkspaceMock(),app=await appEnvironment([],service.options);
 try{
  const bad={name:'unreadable.pdf',size:12,arrayBuffer:async()=>{throw encodingFailure();}};
  dropFiles(app,{items:[],files:[bad,browserFile('valid.txt','good')],getData:()=>''});await app.flush();assert.equal((await app.archive()).papers.length,1);assert.match(app.nodes.get('inputStatus').textContent,/失败 1 项/);
  const calls=service.calls.length;dropFiles(app,{items:[],files:[bad],getData:()=>''});await app.flush();assert.equal(service.calls.length,calls);assert.match(app.nodes.get('inputStatus').textContent,/unreadable.pdf/);assert.equal(app.nodes.get('readPathsBtn').disabled,false);
 }finally{app.dispose();}
});

test('multi-megabyte binary file travels losslessly in POST body without a Data URL',async()=>{
 const bytes=Buffer.alloc(4*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const service=localWorkspaceMock({handle:async(pathname,body)=>{
  if(pathname!=='/local-files/upload')return;
  assert.equal(body.files.length,1);assert.ok(!body.files[0].base64.startsWith('data:'));assert.deepEqual(Buffer.from(body.files[0].base64,'base64'),bytes);
  const value={files:[{filename:'large.pdf',text:FIXTURE_TEXT,sha256:'large-hash',sourceId:'large-id',relativePath:'large.pdf'}],errors:[]};return {ok:true,json:async()=>value};
 }}),app=await appEnvironment([],service.options);
 try{dropFiles(app,{items:[],files:[{name:'large.pdf',size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)}],getData:()=>''});await app.flush();assert.equal((await app.archive()).papers.length,1);assert.equal(service.calls.filter(x=>x.pathname==='/local-files/upload').length,1);}
 finally{app.dispose();}
});

test('standalone text drag also bypasses broken entry API and retains per-file read errors',async()=>{
 const app=await appEnvironment();try{
  const good=browserFile('good.txt','browser text'),bad={name:'bad.txt',size:1,text:async()=>{throw encodingFailure();}};
  dropFiles(app,{items:[{getAsFile:()=>good,webkitGetAsEntry(){throw encodingFailure();}},{getAsFile:()=>bad,webkitGetAsEntry(){throw encodingFailure();}}],files:[good,bad],getData:()=>''});await app.flush();assert.equal((await app.archive()).papers.length,1);assert.match(app.nodes.get('inputStatus').textContent,/bad.txt/);assert.equal(app.networkCount(),0);
 }finally{app.dispose();}
});

test('ten standalone PDFs show 0/10 ready, allow output draft editing, and name all blockers before any API call',async()=>{
 const app=await appEnvironment();try{
 const input=app.nodes.get('paperFiles');input.files=Array.from({length:10},(_,i)=>browserFile(`paper-${i}.pdf`,`bytes-${i}`));await input.onchange({target:input});await app.flush();
 assert.match(app.nodes.get('stepInput').textContent,/已登记 10 篇，输入就绪 0 篇/);assert.match(app.nodes.get('inputStatus').textContent,/输入就绪 0\/10/);assert.equal(app.nodes.get('serviceGuide').hidden,false);assert.equal(app.nodes.get('outputPath').disabled,false);
 app.nodes.get('outputPath').value='/new/中文 输出';app.nodes.get('outputPath').oninput();assert.equal(JSON.parse(app.storage.get('paperbench-workspace-v21')).outputPath,'/new/中文 输出');
 await app.nodes.get('checkOutputBtn').onclick();assert.match(app.nodes.get('workflowStatus').textContent,/需要本机服务/);await app.nodes.get('runBtn').onclick();assert.match(app.nodes.get('notice').textContent,/10\/10 篇正文为空/);assert.match(app.nodes.get('notice').textContent,/paper-9/);assert.equal(app.networkCount(),0);assert.equal((await app.archive()).batches.length,0);
 }finally{app.dispose();}
});

test('reconnecting then reimporting ten identical PDFs repairs empty originals even across path modes and starts one complete batch',async()=>{
 let online=false;const service=localWorkspaceMock({handle:async(pathname,body)=>{
 if(pathname!=='/local-files/upload')return;const files=await Promise.all(body.files.map(async f=>({sourceId:'repaired-'+f.name,filename:f.name,sourcePath:'/actual/'+f.name,relativePath:'new/'+f.name,text:FIXTURE_TEXT,sha256:Buffer.from(await webcrypto.subtle.digest('SHA-256',Buffer.from(f.base64,'base64'))).toString('hex')})));return{ok:true,json:async()=>({files,errors:[]})};
 }});const app=await appEnvironment([],{...service.options,fetch:async(...args)=>{if(!online)throw Error('offline');return service.fetch(...args);}});
 try{
 const input=app.nodes.get('paperFiles');input.files=Array.from({length:10},(_,i)=>browserFile(`recover-${i}.pdf`,`unique-${i}`));await input.onchange({target:input});await app.flush();const ids=(await app.archive()).papers.map(p=>p.id);
 online=true;app.nodes.get('repeats').value='1';await app.nodes.get('reconnectWorkspaceBtn').onclick();assert.equal(app.nodes.get('repeats').value,'1');assert.equal(app.nodes.get('serviceGuide').hidden,true);
 input.files=Array.from({length:10},(_,i)=>browserFile(`recover-${i}.pdf`,`unique-${i}`));await input.onchange({target:input});await app.flush();const repaired=await app.archive();assert.deepEqual(repaired.papers.map(p=>p.id),ids);assert.ok(repaired.papers.every(p=>p.text===FIXTURE_TEXT));assert.match(app.nodes.get('stepInput').textContent,/10\/10/);assert.equal(app.nodes.get('outputPath').disabled,false);
 app.nodes.get('outputPath').value='/chosen/report';app.nodes.get('outputPath').oninput();await app.nodes.get('checkSetupBtn').onclick();assert.match(app.nodes.get('workflowStatus').textContent,/设置检查就绪/);assert.equal(service.calls.filter(c=>c.pathname==='/v1/chat/completions').length,0);
 await app.nodes.get('runBtn').onclick();await app.flush();const after=await app.archive();assert.equal(after.batches.length,1);assert.equal(after.batches[0].papers.length,10);assert.equal(after.batches[0].runs.filter(r=>r.status==='success').length,10);assert.equal(service.calls.filter(c=>c.pathname==='/v1/chat/completions').length,10);
 }finally{app.dispose();}
});

test('local scanned PDF remains blocked with exact title before route creation, alongside valid papers',async()=>{
 const service=localWorkspaceMock({handle:async(pathname)=>{if(pathname==='/local-files/upload')return{ok:true,json:async()=>({files:[{filename:'scan.pdf',title:'扫描论文',text:'',sourceId:'scan',sha256:'scan'},{filename:'valid.txt',title:'有效论文',text:FIXTURE_TEXT,sourceId:'valid',sha256:'valid'}],errors:[]})};}}),app=await appEnvironment([],service.options);
 try{const input=app.nodes.get('paperFiles');input.files=[browserFile('scan.pdf')];await input.onchange({target:input});await app.nodes.get('runBtn').onclick();assert.match(app.nodes.get('notice').textContent,/1\/2 篇正文为空：扫描论文/);assert.ok(!service.calls.some(c=>c.pathname==='/local-api/configure'||c.pathname==='/v1/chat/completions'));assert.equal(app.nodes.get('outputPath').disabled,false);assert.match(app.nodes.get('stepInput').textContent,/输入就绪 1 篇/);}finally{app.dispose();}
});

test('output and configuration completion invalidates immediately on edits; setup checks never call a model',async()=>{
 const service=localWorkspaceMock(),app=await appEnvironment([],service.options);try{
 app.nodes.get('inputPaths').value='/real/paper.txt';await app.nodes.get('readPathsBtn').onclick();await app.nodes.get('checkSetupBtn').onclick();assert.match(app.nodes.get('stepConfig').textContent,/已完成/);assert.match(app.nodes.get('stepOutput').textContent,/已完成/);
 app.nodes.get('outputPath').value='/another';app.nodes.get('outputPath').oninput();assert.match(app.nodes.get('stepOutput').textContent,/待完成/);await app.nodes.get('checkOutputBtn').onclick();assert.match(app.nodes.get('outputStatus').textContent,/第3步完成/);
 app.nodes.get('temperature').value='1';app.nodes.get('settings').oninput();assert.match(app.nodes.get('stepConfig').textContent,/待完成/);assert.ok(!service.calls.some(c=>c.pathname==='/v1/chat/completions'));assert.equal(app.nodes.get('outputPath').disabled,false);
 }finally{app.dispose();}
});

test('native PDF preflight requires a quote index before any API call; reimported text repairs readiness',async()=>{
 let importedText='';const digest='f'.repeat(64);const service=localWorkspaceMock({handle:async(path,body)=>{
 if(path==='/local-files/upload')return{ok:true,json:async()=>({files:[{filename:'scan.pdf',title:'原PDF',text:importedText,sourceId:'pdf-source',sha256:digest,bytes:123,relativePath:'scan.pdf'}],errors:[]})};
 if(path==='/local-files/pdf-check'){assert.deepEqual(body.hashes,[digest]);return{ok:true,json:async()=>({available:true})};}
 }});const app=await appEnvironment([],{...service.options,nativePDF:true});try{
 const input=app.nodes.get('paperFiles');input.files=[browserFile('scan.pdf')];await input.onchange({target:input});
 assert.match(app.nodes.get('stepInput').textContent,/输入就绪 0 篇/);app.nodes.get('repeats').value='1';await app.nodes.get('runBtn').onclick();await app.flush();
 assert.match(app.nodes.get('notice').textContent,/PDF原件已就绪，但引文定位索引为空/);assert.ok(!service.calls.some(c=>c.pathname==='/v1/chat/completions'||c.pathname==='/local-api/configure'));
 importedText=FIXTURE_TEXT;input.files=[browserFile('scan.pdf')];await input.onchange({target:input});assert.match(app.nodes.get('stepInput').textContent,/1\/1/);
 await app.nodes.get('runBtn').onclick();await app.flush();const api=service.calls.find(c=>c.pathname==='/v1/chat/completions');assert.ok(api);assert.equal(api.body.messages[1].content[0].file_url.url,'paperbench-pdf:'+digest);assert.ok(JSON.stringify(api.body).includes(FIXTURE_TEXT));
 const archive=await app.archive();assert.equal(archive.batches[0].papers[0].pdf.sha256,digest);assert.equal(archive.batches[0].papers[0].text,FIXTURE_TEXT);assert.ok(service.calls.findIndex(c=>c.pathname==='/local-files/pdf-check')<service.calls.findIndex(c=>c.pathname==='/local-api/configure'));
 assert.ok(!service.calls.some(c=>c.pathname.startsWith('/local-mineru/')),'cloud upstream must not be mistaken for the loopback gateway');
 }finally{app.dispose();}
});

function mineruWorkspaceMock(options={}){
 const digest='a'.repeat(64),markdown='# MinerU converted original\n\n'+FIXTURE_TEXT+'\n\n![Figure](images/figure.jpg)',sha=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 const ok=value=>({status:200,ok:true,json:async()=>value,text:async()=>JSON.stringify(value)});
 let pdfs=[],polls=0,cancelled=false,startRequestId='',createdJobs=0,startDrop=false,cancelDrop=false;
 const service=localWorkspaceMock({handle:async(path,body)=>{
  if(path==='/local-files/upload')return ok({files:body.files.map((f,i)=>({filename:f.name,title:f.name,text:options.emptyOriginal?'':FIXTURE_TEXT,sourceId:'mineru-source-'+i,sha256:digest,bytes:123,relativePath:f.name})),errors:[]});
  if(path==='/local-files/pdf-check')return ok({available:true});
  if(path==='/local-output/validate'&&options.outputFail)return{status:400,ok:false,json:async()=>({error:'输出目录不可写'})};
  if(path==='/local-mineru/start'){
   assert.match(body.requestId,/^[A-Za-z0-9_-]{8,100}$/);if(!startRequestId){startRequestId=body.requestId;createdJobs++;pdfs=body.papers;}else assert.equal(body.requestId,startRequestId,'a lost start response must reuse its original idempotency key');
   if(options.startDisconnected)throw TypeError('start response lost after job creation');
   if(options.lostStart&&!startDrop){startDrop=true;throw TypeError('start response lost after job creation');}
   return ok({requestId:startRequestId,jobId:'mineru-job-123',status:'running',total:pdfs.length,completed:0});
  }
  if(path==='/local-mineru/cancel'){assert.equal(body.jobId,'mineru-job-123');if(options.lostCancel&&!cancelDrop){cancelDrop=true;throw TypeError('cancel connection lost');}cancelled=true;return ok({jobId:body.jobId,status:'cancelled'});}
  if(path==='/local-mineru/status'){
   assert.equal(body.jobId,'mineru-job-123');polls++;if(options.statusDisconnected)throw TypeError('status connection lost');
   const status=cancelled?'cancelled':options.hold||polls===1?'running':options.failure?'failed':'complete';
   return ok({jobId:body.jobId,status,total:pdfs.length,completed:status==='complete'?pdfs.length:0,current:{paperId:pdfs[0].paperId,title:pdfs[0].title,index:1},message:options.failure?'GPU memory unavailable':'GPU processing',items:status==='complete'?pdfs.map(p=>({paperId:p.paperId,text:options.emptyMarkdown?'':markdown,provenance:{method:'mineru',pdfSha256:p.sha256,markdownSha256:sha(options.emptyMarkdown?'':markdown),markdownPath:'/real/output/conversion-123/'+p.paperId+'/paper.md',conversionDir:'/real/output/conversion-123',conversionId:'conversion-123',version:'3.1.9',gpu:{name:'Mock GPU'}}})):[]});
  }
 }});
 return {...service,markdown,digest,getPolls:()=>polls,getCreatedJobs:()=>createdJobs};
}
async function configureMineruApp(app,endpoint='http://127.0.0.1:30000/v1'){
 app.nodes.get('endpoint').value=endpoint;app.nodes.get('model').value='local-qwen';app.nodes.get('repeats').value='1';app.nodes.get('inputMode').value='pdf';
 app.nodes.get('apiMode').value='custom';app.nodes.get('apiMode').onchange();app.nodes.get('saveConfigBtn').onclick();
 app.nodes.get('autoSaveReport').checked=false;app.nodes.get('autoSaveReport').onchange();
 const input=app.nodes.get('paperFiles');input.files=[browserFile('original.pdf')];await input.onchange({target:input});
}

test('local API converts original PDF using MinerU before scoring, preserves user inputs and keeps mixed text direct',async()=>{
 const service=mineruWorkspaceMock(),app=await appEnvironment([],{...service.options,nativePDF:true});
 try{
  await configureMineruApp(app);const originalId=(await app.archive()).papers[0].id;
  app.nodes.get('paperText').value='User edited preview must not replace the original PDF conversion.';app.nodes.get('paperForm').onsubmit({preventDefault(){}});
  await addPaper(app,'plain text',FIXTURE_TEXT);await app.nodes.get('runBtn').onclick();
  const start=service.calls.find(c=>c.pathname==='/local-mineru/start'),batch=(await app.archive()).batches[0];
  assert.equal(start.body.outputPath,'/real/output');assert.deepEqual(start.body.papers.map(p=>p.paperId),[originalId]);
  assert.ok(service.calls.findIndex(c=>c.pathname==='/local-output/validate')<service.calls.findIndex(c=>c.pathname==='/local-mineru/start'));
  const lastStatus=service.calls.findLastIndex(c=>c.pathname==='/local-mineru/status'),firstModel=service.calls.findIndex(c=>c.pathname==='/v1/chat/completions');assert.ok(lastStatus<firstModel);assert.equal(service.getPolls(),2);
  const prepared=batch.papers.find(p=>p.id===originalId);assert.equal(prepared.text,service.markdown);assert.equal(prepared.pdf,undefined);assert.equal(prepared.preparation.method,'mineru');assert.equal(prepared.preparation.conversionId,'conversion-123');assert.equal(prepared.preparation.pdfSha256,service.digest);assert.equal(batch.config.inputMode,'text');
  const archive=await app.archive();assert.equal(archive.config.inputMode,'pdf');assert.equal(app.nodes.get('inputMode').value,'pdf');assert.match(archive.papers.find(p=>p.id===originalId).text,/User edited/);assert.equal(batch.papers.find(p=>p.id!==originalId).text,FIXTURE_TEXT);assert.equal(batch.papers.find(p=>p.id!==originalId).preparation,undefined);
  for(const call of service.calls.filter(c=>c.pathname==='/v1/chat/completions')){assert.equal(typeof call.body.messages[1].content,'string');assert.ok(!JSON.stringify(call.body).includes('file_url'));assert.ok(!JSON.stringify(call.body).includes('User edited preview'));}
  assert.match(app.nodes.get('batchMeta').innerHTML,/Markdown.*图片链接/);assert.match(app.nodes.get('batchMeta').innerHTML,/索引页号不代表原PDF页码/);assert.ok(!service.calls.some(c=>c.pathname==='/local-reports/save'));
  assert.equal(JSON.parse(app.storage.get('paperbench-workspace-v21')).sourceRefs[originalId],'mineru-source-0');
 }finally{app.dispose();}
});

test('saved localhost and IPv6 local APIs prepare empty PDF text via MinerU even when the old text option is selected',async()=>{
 for(const endpoint of ['http://localhost:30000/v1','http://[::1]:30000/v1']){
  const service=mineruWorkspaceMock({emptyOriginal:true}),app=await appEnvironment([],{...service.options,nativePDF:true});
  try{
   await configureMineruApp(app,endpoint);app.nodes.get('inputMode').value='text';app.nodes.get('saveConfigBtn').onclick();
   assert.match(app.nodes.get('stepInput').textContent,/1\/1/);assert.match(app.nodes.get('paperList').innerHTML,/MinerU/);
   await app.nodes.get('runBtn').onclick();const archive=await app.archive();assert.equal(archive.batches.length,1);assert.equal(archive.batches[0].papers[0].text,service.markdown);assert.equal(archive.papers[0].text,'');assert.ok(service.calls.some(c=>c.pathname==='/v1/chat/completions'));
  }finally{app.dispose();}
 }
});

test('MinerU failure, empty Markdown and invalid output paths never fall back to editor text or start a scoring batch',async()=>{
 for(const options of [{failure:true},{emptyMarkdown:true},{outputFail:true}]){
  const service=mineruWorkspaceMock(options),app=await appEnvironment([],{...service.options,nativePDF:true});
  try{
   await configureMineruApp(app);await app.nodes.get('runBtn').onclick();
   assert.match(app.nodes.get('notice').textContent,/MinerU 转换失败|Markdown 为空|输出目录不可写/);assert.equal(app.nodes.get('runBtn').disabled,false);assert.equal(app.nodes.get('outputPath').disabled,false);
   assert.equal((await app.archive()).batches.length,0);assert.ok(!service.calls.some(c=>c.pathname==='/v1/chat/completions'||c.pathname==='/local-api/configure'));
   if(options.outputFail)assert.ok(!service.calls.some(c=>c.pathname==='/local-mineru/start'));
  }finally{app.dispose();}
 }
});

test('MinerU conversion locks configuration and duplicate starts, displays GPU progress and supports explicit cancellation without scoring',async()=>{
 const service=mineruWorkspaceMock({hold:true}),app=await appEnvironment([],{...service.options,nativePDF:true});
 try{
  await configureMineruApp(app);const started=app.nodes.get('runBtn').onclick();
  await app.flush();assert.equal(app.nodes.get('runBtn').disabled,true);assert.equal(app.nodes.get('endpoint').disabled,true);assert.equal(app.nodes.get('outputPath').disabled,true);assert.equal(app.nodes.get('cancelMineruBtn').disabled,false);
  assert.match(app.nodes.get('mineruProgressText').textContent,/GPU.*MinerU.*第 1 篇：original.pdf/);assert.ok(!app.nodes.get('mineruProgressText').textContent.includes('[object Object]'));
  await app.nodes.get('runBtn').onclick();assert.equal(service.calls.filter(c=>c.pathname==='/local-mineru/start').length,1);
  await app.nodes.get('cancelMineruBtn').onclick();await started;assert.equal(service.calls.filter(c=>c.pathname==='/local-mineru/cancel').length,1);assert.ok(!service.calls.some(c=>c.pathname==='/v1/chat/completions'));assert.match(app.nodes.get('notice').textContent,/转换已取消/);assert.equal((await app.archive()).batches.length,0);assert.equal(app.nodes.get('runBtn').disabled,false);assert.equal(app.nodes.get('endpoint').disabled,false);
 }finally{app.dispose();}
});

test('a restored MinerU batch resumes from its frozen Markdown without reconversion or replacing current PDF defaults',async()=>{
 const service=mineruWorkspaceMock(),app=await appEnvironment([],{...service.options,nativePDF:true});let restored;
 try{
  await configureMineruApp(app);await app.nodes.get('runBtn').onclick();const archive=await app.archive(),batch=archive.batches[0];
  batch.status='paused';delete batch.finishedAt;delete batch.completionState;for(const run of batch.runs){run.status='pending';run.attempts=[];delete run.result;}
  const protocol=JSON.stringify(batch.protocol),saved=[...app.storage].filter(([key])=>key!=='paperbench-state-v1');saved.push(['paperbench-state-v1',JSON.stringify(archive)]);
  const restoredService=mineruWorkspaceMock({failure:true});restored=await appEnvironment(saved,{...restoredService.options,nativePDF:true});
  await restored.nodes.get('resumeBtn').onclick();
  assert.ok(!restoredService.calls.some(c=>c.pathname.startsWith('/local-mineru/')));assert.equal(restoredService.calls.filter(c=>c.pathname==='/v1/chat/completions').length,1,restored.nodes.get('notice').textContent);
  const result=(await restored.archive()).batches[0];assert.equal(JSON.stringify(result.protocol),protocol);assert.equal(result.papers[0].text,service.markdown);assert.equal(result.completionState,'full');assert.equal(restored.nodes.get('inputMode').value,'pdf');
 }finally{app.dispose();restored?.dispose();}
});

test('lost MinerU status and cancellation responses keep the UI locked until the same backend job confirms termination',async()=>{
 const options={hold:true,statusDisconnected:true,lostCancel:true},service=mineruWorkspaceMock(options),app=await appEnvironment([],{...service.options,nativePDF:true});
 try{
  await configureMineruApp(app);const running=app.nodes.get('runBtn').onclick();await app.flush();
  assert.match(app.nodes.get('mineruProgressText').textContent,/状态连接中断.*后台 GPU 任务可能仍在运行/);assert.equal(app.nodes.get('runBtn').disabled,true);assert.equal(app.nodes.get('outputPath').disabled,true);
  await app.nodes.get('runBtn').onclick();await app.nodes.get('cancelMineruBtn').onclick();await app.flush();
  assert.equal(app.nodes.get('runBtn').disabled,true);assert.equal(service.getCreatedJobs(),1);assert.ok(!service.calls.some(c=>c.pathname==='/v1/chat/completions'));
  options.statusDisconnected=false;await running;
  assert.match(app.nodes.get('notice').textContent,/转换已取消/);assert.equal(app.nodes.get('runBtn').disabled,false);assert.equal(service.getCreatedJobs(),1);assert.ok(service.calls.filter(c=>c.pathname==='/local-mineru/cancel').length>=2);
 }finally{options.statusDisconnected=false;options.hold=false;app.dispose();}
});

test('a lost MinerU start response retries one idempotent request and preserves cancellation before a job ID arrives',async()=>{
 const options={startDisconnected:true,hold:true},service=mineruWorkspaceMock(options),app=await appEnvironment([],{...service.options,nativePDF:true});
 try{
  await configureMineruApp(app);const running=app.nodes.get('runBtn').onclick();await app.flush();
  assert.match(app.nodes.get('mineruProgressText').textContent,/状态连接中断.*后台 GPU 任务可能仍在运行/);assert.equal(app.nodes.get('runBtn').disabled,true);assert.equal(service.getCreatedJobs(),1);
  await app.nodes.get('cancelMineruBtn').onclick();assert.equal(app.nodes.get('runBtn').disabled,true);options.startDisconnected=false;await running;
  const starts=service.calls.filter(c=>c.pathname==='/local-mineru/start');assert.ok(starts.length>=2);assert.equal(new Set(starts.map(c=>c.body.requestId)).size,1);assert.equal(service.getCreatedJobs(),1);assert.equal(service.calls.filter(c=>c.pathname==='/local-mineru/cancel').length,1);assert.ok(!service.calls.some(c=>c.pathname==='/v1/chat/completions'));assert.match(app.nodes.get('notice').textContent,/转换已取消/);assert.equal(app.nodes.get('runBtn').disabled,false);
 }finally{options.startDisconnected=false;options.hold=false;app.dispose();}
});

test('a single lost MinerU start response completes one conversion and one scoring request',async()=>{
 const service=mineruWorkspaceMock({lostStart:true}),app=await appEnvironment([],{...service.options,nativePDF:true});
 try{await configureMineruApp(app);await app.nodes.get('runBtn').onclick();assert.equal(service.getCreatedJobs(),1);assert.equal(service.calls.filter(c=>c.pathname==='/local-mineru/start').length,2);assert.equal(service.calls.filter(c=>c.pathname==='/v1/chat/completions').length,1);assert.equal((await app.archive()).batches.length,1);}finally{app.dispose();}
});

test('progress separates complete scores, partial parsed responses, errors and pending work; a paused reason stays visible across tabs',async()=>{
 const app=await appEnvironment();try{
  const archive=await syntheticArchive(app),batch=archive.batches[0];
  for(const r of batch.runs){r.status='pending';delete r.result;}
  batch.runs[0].status='success';batch.runs[0].result=app.PB.parseReview(makeV2Review(FIXTURE_TEXT),FIXTURE_TEXT);
  const partial=makeV2Review(FIXTURE_TEXT);partial.dimensions[0].evidence[0].quote='This quoted sentence does not occur anywhere in the paper source.';
  batch.runs[1].status='success';batch.runs[1].result=app.PB.parseReview(partial,FIXTURE_TEXT);
  batch.runs[2].status='error';batch.runs[2].error='输出因 Token 上限截断';
  batch.status='paused';batch.pauseReason='测试暂停原因：引用需要核查';
  await importArchive(app,archive);
  assert.match(app.nodes.get('progressText').textContent,/五维完整 1 \/ 9 次 · 已解析但不完整 1 次 · 失败 1 次 · 0 次调用中 · 待运行 6 次/);
  assert.match(app.nodes.get('overview').innerHTML,/五维完整评分<\/span><strong>1<\/strong>/);
  assert.match(app.nodes.get('overview').innerHTML,/已解析 2 次 · 其中 1 次不完整/);
  assert.ok(!app.nodes.get('overview').innerHTML.includes('有效调用'));
  assert.equal(app.nodes.get('batchStatusDetail').hidden,false);
  assert.match(app.nodes.get('batchStatusDetail').textContent,/引用需要核查/);
  assert.match(app.nodes.get('batchStatusDetail').textContent,/继续等待不会推进/);
  app.switchTab('audit');assert.match(app.nodes.get('batchStatusDetail').textContent,/引用需要核查/);
  app.change('auditPaper',batch.runs[0].paperId);assert.match(app.nodes.get('audit').innerHTML,/五维完整/);
  app.change('auditPaper',batch.runs[1].paperId);assert.match(app.nodes.get('audit').innerHTML,/可计分 4\/5 维/);
  assert.match(app.nodes.get('stepRun').textContent,/已暂停/);
 }finally{app.dispose();}
});

test('automatic report save labels a finished queue with partial scores as ended with issues rather than paused',async()=>{
 const service=localWorkspaceMock({handle:async(path)=>{
  if(path!=='/v1/chat/completions')return;
  const result=makeV2Review(FIXTURE_TEXT);result.dimensions[0].evidence[0].quote='This unsupported quotation was not copied from the paper.';
  return{ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};
 }}),app=await appEnvironment([],service.options);let restored;
 try{
  await addPaper(app,'部分维度测试');app.nodes.get('repeats').value='3';await app.nodes.get('runBtn').onclick();await app.flush();
  const archive=await app.archive(),batch=archive.batches[0];
  assert.equal(service.calls.filter(c=>c.pathname==='/v1/chat/completions').length,3);
  assert.equal(batch.status,'complete');assert.equal(batch.completionState,'with_issues');assert.ok(!batch.pauseReason);
  assert.match(app.nodes.get('outputStatus').innerHTML,/报告已完整保存/);
  assert.match(app.nodes.get('progressText').textContent,/五维完整 0 \/ 3 次 · 已解析但不完整 3 次/);
  assert.equal(app.nodes.get('progressBar').style.width,'100%','queue progress finishes while complete-score counts remain explicit');
  assert.match(app.nodes.get('batchStatusDetail').textContent,/已结束 · 有待处理结果/);
  assert.match(app.nodes.get('batchStatusDetail').textContent,/本批队列已运行结束，并非暂停/);
  assert.match(app.nodes.get('stepRun').textContent,/已结束 · 有待处理结果/);assert.match(app.nodes.get('stepRun').textContent,/报告已保存/);
  restored=await appEnvironment([...app.storage],service.options);
  assert.match(restored.nodes.get('batchStatusDetail').textContent,/已结束 · 有待处理结果/,'reload must retain the issue completion state');
 }finally{app.dispose();restored?.dispose();}
});

test('old protocols keep viewable results but cannot resume even through a forced click',async()=>{
 const app=await appEnvironment();try{
  const archive=await syntheticArchive(app,{levels:[3],incomplete:true});archive.batches[0].protocol={...archive.batches[0].protocol};delete archive.batches[0].protocol.citationMode;
  await importArchive(app,archive);
  assert.equal(app.nodes.get('resumeBtn').hidden,true);assert.match(app.nodes.get('batchStatusDetail').textContent,/旧评审协议，只读保留原结果/);
  const before=app.networkCount();await app.nodes.get('resumeBtn').onclick();await app.flush();
  assert.equal(app.networkCount(),before);assert.match(app.nodes.get('notice').textContent,/请开始新批次/);
  assert.match(app.nodes.get('overview').innerHTML,/五维完整评分<\/span><strong>2<\/strong>/);
 }finally{app.dispose();}
});

test('out-of-range revision priority is presented as ungraded metadata while complete scores remain visible',async()=>{
 const app=await appEnvironment();try{
  await addPaper(app,'优先级附加信息测试');app.nodes.get('endpoint').value='https://mock.invalid/v1';app.nodes.get('model').value='mock-model';app.nodes.get('repeats').value='1';
  app.context.fetch=async()=>mockCompletion(app.PB,FIXTURE_TEXT,{mutate:z=>{z.revisions[0].priority=4;}});
  await app.nodes.get('runBtn').onclick();await app.flush();app.switchTab('audit');
  assert.match(app.nodes.get('audit').innerHTML,/未分级（原值 4）/);
  assert.ok(!app.nodes.get('audit').innerHTML.includes('Pnull'));
  assert.match(app.nodes.get('progressText').textContent,/五维完整 1 \/ 1 次/);
 }finally{app.dispose();}
});

test('a fresh workspace never claims a saved report before any batch or report exists',async()=>{
 const service=localWorkspaceMock(),app=await appEnvironment([],service.options);try{
  assert.equal((await app.archive()).batches.length,0);
  assert.match(app.nodes.get('stepRun').textContent,/待开始/);
  assert.ok(!app.nodes.get('stepRun').textContent.includes('已保存'));
  assert.equal(app.nodes.get('saveReportBtn').disabled,true);
  await app.nodes.get('checkOutputBtn').onclick();await app.flush();
  assert.match(app.nodes.get('stepRun').textContent,/待开始/,'checking the output directory does not save a report');
  assert.ok(!service.calls.some(c=>c.pathname==='/local-reports/save'));
 }finally{app.dispose();}
});

async function failedCitationArchive(app,{legacy=false}={}) {
 const text=FIXTURE_TEXT+'\fA second source paragraph explicitly records limitations, data boundaries and validation conditions. <b>Source text</b>';
 const paper={id:'repair-paper',title:'本地引用恢复测试',text,version:'原始版',group:'',kind:'draft',change:'other'};
 const batch=await app.PB.createBatch([paper],{...app.PB.DEFAULT_CONFIG,inputMode:'text',repeats:1,apiKey:''},'保留原始失败的恢复测试');
 const review=makeV2Review(FIXTURE_TEXT),dim=review.dimensions[0];
 dim.evidence=[{sourceId:'Q00001'}];dim.items[0].evidenceIndices=[1];dim.items[0].basis+=' 原文依据 (Q00002)。';
 review.analysis.centralClaims[0].sourceIds=['Q00002'];review.analysis.centralClaims[0].evidenceRefs=[];
 review.analysis.strongestSupport.sourceIds=['Q00001','Q00002'];review.analysis.strongestSupport.evidenceRefs=[];
 review.analysis.strongestChallenge.sourceIds=['Q00002'];review.analysis.strongestChallenge.evidenceRefs=[];
 const run=batch.runs[0];run.status='error';run.error='评分 JSON 校验失败：检查项引用索引无效';
 run.attempts=[{id:'original-failed-attempt',status:'error',startedAt:new Date().toISOString(),durationMs:9000,httpStatus:200,finishReason:'stop',error:run.error,responseBody:JSON.stringify({usage:{prompt_tokens:200,completion_tokens:100,total_tokens:300},choices:[{finish_reason:'stop',message:{content:JSON.stringify(review)}}]}),usage:{prompt_tokens:200,completion_tokens:100,total_tokens:300}}];
 batch.status='paused';batch.pauseReason=run.error;
 if(legacy){batch.protocol={...batch.protocol};delete batch.protocol.citationMode;}
 return{schemaVersion:1,config:{...app.PB.DEFAULT_CONFIG,apiKey:''},papers:[paper],batches:[batch],currentBatchId:batch.id};
}

test('local recovery repairs archived failures without network or new attempts, preserves protocol and invalidates the saved-report badge',async()=>{
 const service=localWorkspaceMock(),app=await appEnvironment([],service.options);let restored;
 try{
  const archive=await failedCitationArchive(app),before=JSON.stringify(archive.batches[0].runs[0].attempts),protocol=JSON.stringify(archive.batches[0].protocol);
  await importArchive(app,archive);await app.nodes.get('saveReportBtn').onclick();await app.flush();
  assert.match(app.nodes.get('stepRun').textContent,/当前进度报告已保存/);
  app.nodes.get('temperature').value='1.1';const calls=service.calls.length;
  assert.equal(app.nodes.get('recoverLocalBtn').hidden,false);app.nodes.get('recoverLocalBtn').onclick();await app.flush();
  assert.equal(service.calls.length,calls,'local recovery must not POST to model, report saver or profile');
  assert.equal(app.nodes.get('temperature').value,'1.1','local recovery preserves selected model settings');
  const recovered=await app.archive(),batch=recovered.batches[0],run=batch.runs[0];
  assert.equal(run.status,'success');assert.equal(run.result.dimensions.filter(d=>Number.isFinite(d.score)).length,5);
  assert.equal(JSON.stringify(run.attempts),before);assert.equal(JSON.stringify(batch.protocol),protocol);
  assert.equal(run.localRecovery.sourceAttemptId,'original-failed-attempt');assert.equal(run.localRecovery.operation,'reparse_existing_response');
  assert.equal(run.result.citationRepairs.length,1);assert.equal(run.result.citationRepairs[0].sourceId,'Q00002');
  assert.match(app.nodes.get('progressText').textContent,/五维完整 1 \/ 1 次/);
  assert.ok(!app.nodes.get('stepRun').textContent.includes('报告已保存'));
  assert.match(app.nodes.get('outputStatus').textContent,/恢复前的快照/);
  app.switchTab('audit');const audit=app.nodes.get('audit').innerHTML;
  assert.match(audit,/原始失败记录（已本地恢复）/);assert.match(audit,/本地恢复成功 · 未新增模型请求/);
  assert.match(audit,/原文编号恢复引用 · 1 项/);assert.match(audit,/原始索引 \[1\]（零基） → Q00002/);assert.match(audit,/物理页 2/);
  assert.match(audit,/原文定位 2 段 · Q00001、Q00002/);assert.match(audit,/&lt;b&gt;Source text&lt;\/b&gt;/);assert.ok(!audit.includes('<b>Source text</b>'));
  await app.action('copyReasons');assert.match(app.clipboardTexts.at(-1),/原文编号恢复引用/);assert.match(app.clipboardTexts.at(-1),/原文定位 2 段/);
  app.nodes.get('exportCSV').onclick();const csv=await app.downloads.at(-1).blob.text();assert.match(csv,/local_recovery_json/);assert.match(csv,/reparse_existing_response/);assert.match(csv,/original-failed-attempt/);
  restored=await appEnvironment([...app.storage],service.options);restored.switchTab('audit');assert.match(restored.nodes.get('audit').innerHTML,/本地恢复成功/);
 }finally{app.dispose();restored?.dispose();}
});

test('local recovery is disabled while running and rejected for old reference protocols without network',async()=>{
 const app=await appEnvironment();try{
  const archive=await failedCitationArchive(app,{legacy:true});await importArchive(app,archive);
  assert.equal(app.nodes.get('recoverLocalBtn').hidden,true);const calls=app.networkCount();app.nodes.get('recoverLocalBtn').onclick();assert.equal(app.networkCount(),calls);assert.match(app.nodes.get('notice').textContent,/不能本地恢复引用/);
 }finally{app.dispose();}
 let release,entered;const start=new Promise(r=>entered=r),pause=new Promise(r=>release=r);
 const service=localWorkspaceMock({handle:async path=>{if(path==='/v1/chat/completions'){entered();await pause;}}}),busy=await appEnvironment([],service.options);
 try{
  await addPaper(busy,'调用进行中保护');busy.nodes.get('repeats').value='1';const run=busy.nodes.get('runBtn').onclick();await start;
  assert.equal(busy.nodes.get('recoverLocalBtn').disabled,true);const calls=service.calls.length;
  busy.nodes.get('recoverLocalBtn').onclick();assert.equal(service.calls.length,calls);release();await run;
 }finally{release?.();busy.dispose();}
});

function directSourceReview(text=FIXTURE_TEXT) {
 const review=makeV2Review(text);
 for(const d of review.dimensions){delete d.evidence;for(const item of d.items){delete item.evidenceIndices;item.sourceIds=['Q00001'];}}
 for(const section of [...review.analysis.centralClaims,review.analysis.strongestSupport,review.analysis.strongestChallenge]){delete section.evidenceRefs;section.sourceIds=['Q00001'];}
 return review;
}

test('field-isolated invalid item shows its exact data error while other dimensions and queued reviews remain available',async()=>{
 const app=await appEnvironment();try{
  await addPaper(app,'逐项隔离测试');app.nodes.get('endpoint').value='https://mock.invalid/v1';app.nodes.get('model').value='mock-model';app.nodes.get('repeats').value='2';let calls=0;
  app.context.fetch=async()=>{const review=directSourceReview();if(++calls===1)review.dimensions[1].items[0].level='invalid <script>value</script>';return{ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(review)}}]})};};
  await app.nodes.get('runBtn').onclick();await app.flush();
  const batch=(await app.archive()).batches[0];assert.equal(calls,2);assert.equal(batch.status,'complete');assert.equal(batch.completionState,'with_issues');
  assert.equal(batch.runs[0].result.dimensions.filter(d=>Number.isFinite(d.score)).length,4);
  assert.match(app.nodes.get('progressText').textContent,/五维完整 1 \/ 2 次 · 已解析但不完整 1 次/);
  assert.match(app.nodes.get('batchBadge').textContent,/已结束 · 有待处理结果/);
  app.switchTab('audit');const html=app.nodes.get('audit').innerHTML;
  assert.match(html,/部分结果 · 可计分 4\/5 维/);assert.match(html,/响应字段待处理/);assert.match(html,/rigor.assumptions.level/);assert.match(html,/invalid_level/);
  assert.match(html,/这是返回数据问题，不代表论文证据不足/);assert.match(html,/等级 3 \/ 4/);assert.match(html,/&lt;script&gt;value&lt;\/script&gt;/);assert.ok(!html.includes('<script>value</script>'));
  await app.action('copyReasons');assert.match(app.clipboardTexts.at(-1),/响应字段待处理，未计分/);assert.match(app.clipboardTexts.at(-1),/invalid_level|rigor.assumptions.level/);
 }finally{app.dispose();}
});

test('six valid sources and harmless extra placeholders retain complete scores and expose normalization audit',async()=>{
 const text=Array.from({length:6},(_,i)=>`Source paragraph ${i+1}: this exact paragraph records the study conditions and visible reported evidence.`).join('\f');
 const app=await appEnvironment();try{
  await addPaper(app,'六条原文与占位项',text);app.nodes.get('endpoint').value='https://mock.invalid/v1';app.nodes.get('model').value='mock-model';app.nodes.get('repeats').value='1';
  const review=directSourceReview(text),all=app.PB.buildSourceCatalog(text).map(e=>e.id);assert.equal(all.length,6);
  review.dimensions[0].items[0].sourceIds=all;review.dimensions[0].items.push({id:'',level:null,sourceIds:[]});review.dimensions[1].items[0].sourceIds=' Q00001 ';
  app.context.fetch=async()=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(review)}}]})});
  await app.nodes.get('runBtn').onclick();await app.flush();app.switchTab('audit');const html=app.nodes.get('audit').innerHTML;
  assert.equal((await app.archive()).batches[0].runs[0].result.dimensions.filter(d=>Number.isFinite(d.score)).length,5);
  assert.equal(app.nodes.get('batchBadge').textContent,'已完成');assert.match(html,/规范化与附加信息警告/);assert.match(html,/expanded_sources/);assert.match(html,/extra_item/);assert.match(html,/single_source_array/);assert.match(html,/Q00006/);assert.match(html,/查看校验前的原始模型对象/);
 }finally{app.dispose();}
});

test('draining a global failure keeps busy controls and in-flight completion before the final paused state',async()=>{
 let release,entered,calls=0;const active=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 const app=await appEnvironment([],{keepRequestTimeouts:true});try{
  await addPaper(app,'在途论文一');await addPaper(app,'在途论文二');app.nodes.get('endpoint').value='https://mock.invalid/v1';app.nodes.get('model').value='mock-model';app.nodes.get('repeats').value='1';app.nodes.get('concurrency').value='2';
  app.context.fetch=async()=>{calls++;if(calls===1){await active;return{ok:false,status:401,headers:{get:()=>null},text:async()=>JSON.stringify({error:{message:'test credential failure'}})};}entered();await wait;return mockCompletion(app.PB,FIXTURE_TEXT);};
  const execution=app.nodes.get('runBtn').onclick();await active;await app.flush();
  assert.match(app.nodes.get('batchBadge').textContent,/已停止新请求 · 等待在途结果/);assert.match(app.nodes.get('batchStatusDetail').textContent,/1 次请求仍在运行/);assert.equal(app.nodes.get('runBtn').disabled,true);assert.match(app.nodes.get('stepRun').textContent,/已停止新请求/);
  release();await execution;await app.flush();const batch=(await app.archive()).batches[0];
  assert.equal(batch.status,'paused');assert.equal(batch.runs.filter(r=>r.status==='success').length,1);assert.match(app.nodes.get('batchStatusDetail').textContent,/当前没有请求在运行/);assert.match(app.nodes.get('executionAudit').innerHTML,/执行与调度事件/);assert.match(app.nodes.get('executionAudit').innerHTML,/system-pause/);
 }finally{release?.();app.dispose();}
});

test('local recovery can restore only part of a failed review and reports exact full versus partial counts without network',async()=>{
 const app=await appEnvironment();try{
  const archive=await failedCitationArchive(app),review=directSourceReview(archive.papers[0].text);review.dimensions[0].items[0].sourceIds=['Q99999'];
  archive.batches[0].runs[0].attempts[0].responseBody=JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(review)}}]});
  await importArchive(app,archive);const before=app.networkCount();app.nodes.get('recoverLocalBtn').onclick();await app.flush();
  assert.equal(app.networkCount(),before);assert.match(app.nodes.get('notice').textContent,/0 次恢复五维完整，1 次恢复部分结果/);
  const batch=(await app.archive()).batches[0];assert.equal(batch.runs[0].status,'success');assert.equal(batch.runs[0].result.dimensions.filter(d=>Number.isFinite(d.score)).length,4);
  assert.match(app.nodes.get('outputStatus').textContent,/0 次完整评分、1 次部分结果/);assert.match(app.nodes.get('batchBadge').textContent,/已结束 · 有待处理结果/);
  app.switchTab('audit');assert.match(app.nodes.get('audit').innerHTML,/本地恢复部分结果 · 未新增模型请求/);assert.match(app.nodes.get('audit').innerHTML,/当前可计分 4\/5 维/);assert.ok(!app.nodes.get('audit').innerHTML.includes('恢复完整五维结果'));
 }finally{app.dispose();}
});
