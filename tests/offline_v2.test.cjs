'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {exportOffline,readCore,collectSources}=require('./export_offline.cjs');
const {makeV2Review,TEXT}=require('./v2_fixture.cjs');
const load=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
function assembled(){return load('template.html').replace('/* INLINE_STYLE */',load('style.css')).replace('// INLINE_SCRIPT',['core.js','transport.js','app.js'].map(name=>`/* BEGIN ${name} */\n${load(name)}\n/* END ${name} */`).join('\n;\n'));}
async function fixture(t,{legacy=false,partial=false,repeats=3}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paperbench-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const html=assembled(),appPath=path.join(dir,'source-app.html');fs.writeFileSync(appPath,html);
 const context=vm.createContext({URL,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,crypto:webcrypto,AbortController,setTimeout,clearTimeout});
 for(const name of ['core.js','transport.js'])vm.runInContext(load(name),context);
 const PB=context.PB, ps=Array.from({length:3},(_,i)=>({id:'p0'+(i+1),title:'离线论文 '+(i+1),group:'',version:'历史测试',kind:'reference',change:'other',text:TEXT}));
 const batch=await PB.createBatch(ps,{...PB.DEFAULT_CONFIG,model:'fixture-custom-model',repeats},'三篇自定义模型测试');
 if(legacy)batch.protocol={id:'historical-mm-snapshot',systemPrompt:'旧版多模态输入及直接评分规则；离线原分保持。',version:'PB-MM-1.0',imagePolicy:{coverage:'all pages'}};
 for(const run of batch.runs){
  if(partial&&run.paperId==='p03'&&run.round===3)continue;
  const response=legacy?{dimensions:PB.DIMS.map(d=>({id:d.id,score:6.25,evidence:[{quote:TEXT,location:'全文第一段'}],reason:'历史模型依据这段完整材料给出直接分数，需要结合当时量表解释理由。',improvement:'保留此历史结果并核查论文证据与对应的适用范围。'})),summary:'历史评语完整保存，不补造新评分依据。',limitations:'未进行外部事实核查与独立实验复现。'}:makeV2Review(TEXT,{level:3});
  if(!legacy)response.analysis.strongestSupport.text+=' <img src=x onerror=alert(1)>';
  let raw=JSON.stringify(response);
  // Preserve a real format-compatibility condition when the final parser supports it.
  if(!legacy&&run.paperId==='p01'&&run.round===1&&PB.REVIEW_PARSER_VERSION)raw+='}';
  run.result=PB.parseReview(raw,TEXT,{citationMode:batch.protocol.citationMode});run.status='success';run.attempts=[{id:run.id+'-a1',status:'success',startedAt:'2026-09-08T00:00:00Z',finishedAt:'2026-09-08T00:00:01Z',durationMs:1000,httpStatus:200,model:'fixture-custom-model',usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},request:{messages:[]},requestPath:'requests/'+run.paperId+'.request.json',responsePath:'responses/'+run.paperId+'.response.json',responseBody:JSON.stringify({choices:[{message:{content:raw}}]})}];
 }
 batch.status=partial?'paused':'complete';
 const archive=PB.exportArchive({schemaVersion:1,config:{...PB.DEFAULT_CONFIG,model:'fixture-custom-model',repeats,apiKey:'private-test-key-do-not-export'},papers:ps,batches:[batch],currentBatchId:batch.id});
 const rawArchive=JSON.stringify(archive,null,2);fs.writeFileSync(path.join(dir,'archive.json'),rawArchive);
 fs.mkdirSync(path.join(dir,'assets/prepared/p01'),{recursive:true});fs.writeFileSync(path.join(dir,'assets/prepared/p01/source.pdf'),'%PDF-1.4\n%%EOF\n');
 fs.mkdirSync(path.join(dir,'requests'));fs.writeFileSync(path.join(dir,'requests/keep.request.json'),'unchanged-audit');
 return {dir,appPath,PB,archive,rawArchive};
}
async function offlineEnvironment(html){
 const nodes=new Map(),downloads=[],blobs=new Map(),errors=[],timers=new Set(),events={};let networkCalls=0,storageAccesses=0,dbAccesses=0,blobIndex=0;
 function element(tag='div',id='',attrs=''){
  let val=attrs.match(/\bvalue="([^"]*)"/)?.[1]||'',inner='';
  const node={tagName:tag.toUpperCase(),id,hidden:/\bhidden\b/.test(attrs),disabled:false,checked:/\bchecked\b/.test(attrs),dataset:{},style:{},textContent:'',className:'',setAttribute(name,value){this[name]=String(value);},getAttribute(name){return this[name];},classList:{toggle(){},add(){},remove(){}},files:[],listeners:{},get value(){return val;},set value(v){val=String(v);},get innerHTML(){return inner;},set innerHTML(v){inner=String(v);parseIds(inner);},addEventListener(type,fn){this.listeners[type]=fn;},focus(){},append(){},remove(){},click(){if(this.tagName==='A')downloads.push({name:this.download,blob:blobs.get(this.href)});else return this.onclick?.({target:this});},closest(selector){const m=selector.match(/^\[data-([a-z]+)\]$/);return m&&this.dataset[m[1]]!==undefined?this:null;}};
  const tab=attrs.match(/\bdata-tab="([^"]*)"/)?.[1];if(tab)node.dataset.tab=tab;if(id)nodes.set(id,node);return node;
 }
 function parseIds(text){for(const m of text.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi))element(m[1],m[3],m[2]);}
 parseIds(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));
 const tabs=[...html.matchAll(/<button\b([^>]*data-tab="[^"]+"[^>]*)>/gi)].map(m=>element('button','',m[1]));
 const containers={'.tabs':element('nav'),'.results-area':element('section')};
 const document={getElementById:id=>nodes.get(id)||null,querySelector:sel=>containers[sel]||null,querySelectorAll:sel=>sel==='[data-tab]'?tabs:sel==='.tab-panel'?['overview','compare','audit','history','method'].map(id=>nodes.get(id)):sel.startsWith('.library ')?[...nodes.values()].filter(n=>['INPUT','SELECT','TEXTAREA','BUTTON'].includes(n.tagName)):[],createElement:tag=>element(tag),body:element('body')};
 class LocalURL extends URL{static createObjectURL(b){const url='blob:offline/'+blobIndex++;blobs.set(url,b);return url;}static revokeObjectURL(){}}
 const context=vm.createContext({URL:LocalURL,AbortController,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,crypto:webcrypto,Blob,structuredClone,document,navigator:{clipboard:{writeText:async()=>{}}},window:{addEventListener:(name,fn)=>{events[name]=fn;}},location:{protocol:'http:',hostname:'127.0.0.1',origin:'http://127.0.0.1:8877',href:'http://127.0.0.1:8877/reports/test/index.html'},fetch:async()=>{networkCalls++;throw Error('network forbidden');},localStorage:{getItem(){storageAccesses++;throw Error('storage read forbidden');},setItem(){storageAccesses++;throw Error('storage write forbidden');},removeItem(){storageAccesses++;throw Error('storage removal forbidden');}},indexedDB:{open(){dbAccesses++;throw Error('database forbidden');}},setTimeout(fn,ms){const h=setTimeout(()=>{timers.delete(h);try{fn();}catch(e){errors.push(e);}},Math.min(ms,5));timers.add(h);return h;},clearTimeout(h){timers.delete(h);clearTimeout(h);}});
 const inline=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];assert.ok(inline.length);
 for(const m of inline)vm.runInContext(m[1],context,{filename:'exported-offline.html',timeout:10000});
 const flush=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,8));assert.equal(errors.length,0,errors.map(e=>e.stack).join('\n'));};await flush();
 assert.ok(!nodes.get('notice').textContent.startsWith('启动异常'),nodes.get('notice').textContent);
 return {nodes,context,downloads,events,flush,tabs:()=>tabs,tab:name=>containers['.tabs'].onclick({target:tabs.find(t=>t.dataset.tab===name)}),action:async name=>containers['.results-area'].listeners.click({target:{closest:()=>({dataset:{action:name}})}}),counts:()=>({networkCalls,storageAccesses,dbAccesses}),dispose:()=>{for(const h of timers)clearTimeout(h);}};
}
test('v2 exporter is self-contained, escapes model text, preserves all five tabs and deep review, exports actual tables and existing PDF links only',async t=>{
 const f=await fixture(t);const out=exportOffline(f.dir,f.appPath);assert.equal(out.papers,3);assert.equal(out.model,'fixture-custom-model');assert.equal(out.pdfLinks,1);
 const html=fs.readFileSync(path.join(f.dir,'index.html'),'utf8');assert.ok(!/<script[^>]+src=/.test(html));assert.match(html,/connect-src 'none'/);assert.match(html,/assets\/prepared\/p01\/source\.pdf/);assert.ok(!html.includes('assets/prepared/p02/source.pdf'));
 assert.equal(fs.readFileSync(path.join(f.dir,'archive.json'),'utf8'),f.rawArchive);assert.equal(fs.readFileSync(path.join(f.dir,'requests/keep.request.json'),'utf8'),'unchanged-audit');
 const app=await offlineEnvironment(html);t.after(()=>app.dispose());
 assert.match(app.nodes.get('storageStatus').textContent,/不联网/);assert.equal(app.tabs().length,5);
 for(const tab of ['overview','compare','audit','history','method']){app.tab(tab);assert.ok(app.nodes.get(tab).innerHTML.length>100);}
 app.tab('audit');const audit=app.nodes.get('audit').innerHTML;assert.match(audit,/中心主张审计/);assert.match(audit,/四项检查/);assert.match(audit,/按优先级修订/);assert.match(audit,/&lt;img/);assert.ok(!audit.includes('<img src=x'));
 app.tab('overview');assert.match(app.nodes.get('overview').innerHTML,/<svg/);assert.ok(!app.nodes.get('batchSelect').innerHTML.includes('新建批次'));
 await app.action('summaryCSV');assert.match(await app.downloads.at(-1).blob.text(),/total_median_of_round_means/);
 app.nodes.get('exportJSON').onclick();const exported=JSON.parse(await app.downloads.at(-1).blob.text());assert.equal(exported.batches[0].runs[0].result.schemaVersion,2);
 for(const r of exported.batches[0].runs){const original=f.archive.batches[0].runs.find(x=>x.id===r.id).result;assert.equal(JSON.stringify(r.result.formatWarnings),JSON.stringify(original.formatWarnings),'normalized format warnings must survive every import/export');assert.equal(JSON.stringify(r.result.normalization),JSON.stringify(original.normalization),'format-normalization provenance must be idempotent');assert.equal(JSON.stringify(r.result.dimensions),JSON.stringify(original.dimensions),'read-only import must not change derived grades/scores/citations');}
 const importedAgain=app.context.PB.validateArchive(exported);assert.equal(JSON.stringify(importedAgain.batches[0].runs.map(r=>r.result)),JSON.stringify(exported.batches[0].runs.map(r=>r.result)),'normalized v2 results must be fully import-idempotent');
 for(const file of ['summary.csv','run_scores.csv','usage.csv'])assert.match(fs.readFileSync(path.join(f.dir,file),'utf8'),/format_warnings_json/);
 assert.match(fs.readFileSync(path.join(f.dir,'run_scores.csv'),'utf8'),/dimensions_with_items_and_citations_json/);
 const originalWarnings=f.archive.batches[0].runs.flatMap(r=>r.result?.formatWarnings||[]);if(originalWarnings.length)assert.match(fs.readFileSync(path.join(f.dir,'run_scores.csv'),'utf8'),/格式兼容/);
 assert.deepEqual(app.counts(),{networkCalls:0,storageAccesses:0,dbAccesses:0});
});
test('hidden mutation handlers, delegated demo/removal and beforeunload cannot modify data or touch browser storage/network',async t=>{
 const f=await fixture(t);exportOffline(f.dir,f.appPath);const app=await offlineEnvironment(fs.readFileSync(path.join(f.dir,'index.html'),'utf8'));t.after(()=>app.dispose());
 app.nodes.get('exportJSON').onclick();const before=JSON.parse(await app.downloads.at(-1).blob.text());
 const controls=['inputMode','localProfileBtn','glmPresetBtn','saveConfigBtn','runBtn','resumeBtn','testBtn','demoBtn','newPaper','deletePaper','rememberKey','importFile','paperFiles','paperForm','apiMode','sendDoSample','inputPaths','recursiveInput','dropZone','folderFiles','pickInputFiles','pickInputFolder','readPathsBtn','outputPath','pickOutputFolder','autoSaveReport','checkSetupBtn','checkOutputBtn','reconnectWorkspaceBtn','saveReportBtn'];
 let sourceReads=0;
 for(const id of controls){
  const node=app.nodes.get(id);assert.ok(node,'required v2.1 control '+id);assert.equal(node.hidden,true,id+' hidden');assert.equal(node.disabled,true,id+' disabled');
  node.value=id==='apiMode'?'custom':'/must-not-be-read';node.checked=!node.checked;
  const file={name:'must-not-read.pdf',arrayBuffer:async()=>{sourceReads++;throw Error('file read forbidden');},text:async()=>{sourceReads++;throw Error('file read forbidden');}};node.files=[file];
  const event={target:node,preventDefault(){},stopPropagation(){},dataTransfer:{files:[file],items:[],getData(){sourceReads++;return 'file:///must-not-be-read';}}};
  for(const field of ['onclick','onchange','oninput','onsubmit','ondrop','ondragover','ondragenter','ondragleave'])if(node[field])await node[field](event);
  for(const callback of Object.values(node.listeners))await callback(event);
 }
 assert.equal(sourceReads,0,'read-only file and drag callbacks cannot inspect source data');
 await app.action('demo');await app.action('removeBatch');app.events.beforeunload?.({preventDefault(){}});await app.flush();
 app.nodes.get('exportJSON').onclick();const after=JSON.parse(await app.downloads.at(-1).blob.text());
 for(const field of ['config','papers','batches','currentBatchId'])assert.equal(JSON.stringify(after[field]),JSON.stringify(before[field]),'no read-only mutation of '+field);assert.deepEqual(app.counts(),{networkCalls:0,storageAccesses:0,dbAccesses:0});
 await assert.rejects(app.context.fetch('/local-config'),/禁止网络调用/);assert.equal(app.counts().networkCalls,0);
});
test('old multimodal archive remains readable without v2 fabrication; incomplete exported tables retain nulls and omit ranks',async t=>{
 const f=await fixture(t,{legacy:true,partial:true});const out=exportOffline(f.dir,f.appPath);assert.equal(out.successfulCalls,8);assert.equal(out.plannedCalls,9);
 const app=await offlineEnvironment(fs.readFileSync(path.join(f.dir,'index.html'),'utf8'));t.after(()=>app.dispose());
 app.tab('audit');assert.match(app.nodes.get('audit').innerHTML,/历史 v1 直接评分结果/);assert.match(app.nodes.get('audit').innerHTML,/6\.25 \/ 10/);assert.ok(!app.nodes.get('audit').innerHTML.includes('class="check-item"'));
 app.nodes.get('exportJSON').onclick();const exported=JSON.parse(await app.downloads.at(-1).blob.text());assert.ok(exported.batches[0].runs.filter(r=>r.status==='success').every(r=>r.result.dimensions.every(d=>d.score===6.25&&!d.items)));
 const summary=fs.readFileSync(path.join(f.dir,'summary.csv'),'utf8');assert.ok(summary.trim().split(/\r?\n/).slice(1).every(line=>line.split(',')[4]==='""'));
 assert.match(fs.readFileSync(path.join(f.dir,'run_scores.csv'),'utf8'),/pending/);assert.match(fs.readFileSync(path.join(f.dir,'README.md'),'utf8'),/已解析：8\/9/);
 assert.deepEqual(app.counts(),{networkCalls:0,storageAccesses:0,dbAccesses:0});
});

test('local text-only report links actual PDF/text and current review snapshots without inventing an upload absolute path',async t=>{
 const f=await fixture(t);const write=(name,text)=>{fs.mkdirSync(path.dirname(path.join(f.dir,name)),{recursive:true});fs.writeFileSync(path.join(f.dir,name),text);};
 for(const id of ['p01','p02','p03'])write(`assets/prepared/${id}/review_text.txt`,TEXT);
 write('assets/prepared/p01/paper_text.txt',TEXT);write('assets/prepared/p02/source.txt','original bytes\n');write('assets/prepared/p02/paper_text.txt','original extracted text\n');
 const metadata={schemaVersion:1,sources:[{paperId:'p01',filename:'paper.pdf',sourcePath:'/home/research/paper.pdf',relativePath:'paper.pdf',sourceAsset:'assets/prepared/p01/source.pdf',textAsset:'assets/prepared/p01/paper_text.txt',archiveTextMatchesImported:true,warnings:[]},{paperId:'p02',filename:'notes.md',sourcePath:null,relativePath:'folder/<notes>&".md',sourceAsset:'assets/prepared/p02/source.txt',textAsset:'assets/prepared/p02/paper_text.txt',archiveTextMatchesImported:false,warnings:['抽取警告 <script>bad()</script>']}],missingPaperIds:['p03'],missingSources:[{paperId:'p03',sourceId:'expired-source',reason:'source_cache_unavailable'}]};
 write('source_metadata.json',JSON.stringify(metadata));const result=exportOffline(f.dir,f.appPath);assert.equal(result.pdfLinks,1);assert.equal(result.sourceRecords,3);assert.match(result.inputMode,/原文定位索引/);
 const html=loadOutput(f.dir,'index.html'),readme=loadOutput(f.dir,'README.md');
 assert.match(html,/原文定位索引/);assert.match(html,/folder\/&lt;notes&gt;&amp;&quot;\.md/);assert.match(html,/浏览器未提供原始绝对路径/);assert.match(html,/本批正文与导入时全文不同/);assert.match(html,/来源缓存可能已失效/);assert.match(html,/抽取警告 &lt;script&gt;bad\(\)&lt;\/script&gt;/);
 assert.ok(!html.includes('private-test-key-do-not-export'));
 const materials=html.match(/<section class="card offline-materials">([\s\S]*?)<\/section>/)[1];
 const hrefs=[...materials.matchAll(/href="([^"]+)"/g)].map(m=>decodeURIComponent(m[1].replace(/&amp;/g,'&')));
 for(const href of hrefs){assert.ok(!path.isAbsolute(href),href);assert.ok(fs.statSync(path.resolve(f.dir,href)).isFile(),href);}
 assert.ok(hrefs.includes('assets/prepared/p01/source.pdf'));assert.ok(hrefs.includes('assets/prepared/p02/source.txt'));assert.ok(hrefs.includes('assets/prepared/p03/review_text.txt'));assert.ok(!hrefs.includes('assets/prepared/p03/source.pdf'));
 assert.match(readme,/sourcePath为null/);assert.match(readme,/review_text\.txt记录本批冻结的文本输入/);assert.match(readme,/重新导入后另存报告/);
 const app=await offlineEnvironment(html);t.after(()=>app.dispose());for(const tab of ['overview','compare','audit','history','method'])app.tab(tab);assert.deepEqual(app.counts(),{networkCalls:0,storageAccesses:0,dbAccesses:0});
});
function loadOutput(dir,name){return fs.readFileSync(path.join(dir,name),'utf8');}
test('source links reject traversal, absolute locations, nonexistent files and symlinks outside report',async t=>{
 const f=await fixture(t),outside=path.join(path.dirname(f.dir),path.basename(f.dir)+'-outside.txt');fs.writeFileSync(outside,'outside');t.after(()=>fs.rmSync(outside,{force:true}));
 fs.symlinkSync(outside,path.join(f.dir,'outside-link.txt'));
 const sources=[{paperId:'p01',sourceAsset:path.join(f.dir,'assets/prepared/p01/source.pdf'),textAsset:'../'+path.basename(outside)},{paperId:'p02',sourceAsset:'outside-link.txt',textAsset:'assets/no-such.txt'},{paperId:'p03',sourceAsset:'../'+path.basename(outside),textAsset:'assets/prepared/../prepared/p01/source.pdf'}];
 fs.writeFileSync(path.join(f.dir,'source_metadata.json'),JSON.stringify({schemaVersion:1,sources}));
 const found=collectSources(f.dir,f.archive);assert.equal(found.length,3);assert.ok(found.every(s=>s.url===null&&s.textURL===null&&s.sourceMissing));
 exportOffline(f.dir,f.appPath);const materials=loadOutput(f.dir,'index.html').match(/<section class="card offline-materials">([\s\S]*?)<\/section>/)[1];assert.ok(!materials.includes('outside-link'));assert.ok(!materials.includes(path.basename(outside)));assert.ok(!materials.includes('href="/'));
});
for(const repeats of [1,2])test(`low-n ${repeats}-round report retains every score and deep field but no rank or stability conclusion`,async t=>{
 const f=await fixture(t,{repeats});const result=exportOffline(f.dir,f.appPath);assert.equal(result.lowRepeatCount,true);assert.equal(result.successfulCalls,3*repeats);
 const html=loadOutput(f.dir,'index.html'),summary=loadOutput(f.dir,'summary.csv'),scores=loadOutput(f.dir,'run_scores.csv');
 assert.match(html,/少于 3 轮/);assert.match(loadOutput(f.dir,'README.md'),/少于3轮，仅检查/);assert.ok(summary.trim().split(/\r?\n/).slice(1).every(line=>line.split(',')[4]==='""'));assert.match(scores,/dimensions_with_items_and_citations_json/);assert.equal(scores.trim().split(/\r?\n/).length,1+3*repeats);
 const app=await offlineEnvironment(html);t.after(()=>app.dispose());app.tab('overview');assert.match(app.nodes.get('overview').innerHTML,/仅链路检查/);assert.ok(!/class="rank">0[123]/.test(app.nodes.get('overview').innerHTML));app.tab('compare');assert.ok(!/class="label">显著(?:改进|退步)/.test(app.nodes.get('compare').innerHTML));
 app.nodes.get('exportJSON').onclick();const exported=JSON.parse(await app.downloads.at(-1).blob.text());for(const run of exported.batches[0].runs){const original=f.archive.batches[0].runs.find(r=>r.id===run.id);assert.equal(JSON.stringify(run.result),JSON.stringify(original.result));}
 await app.action('summaryCSV');const liveSummary=await app.downloads.at(-1).blob.text();assert.ok(liveSummary.trim().split(/\r?\n/).slice(1).every(line=>line.split(',')[0]==='""'));assert.deepEqual(app.counts(),{networkCalls:0,storageAccesses:0,dbAccesses:0});
});
