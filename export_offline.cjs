#!/usr/bin/env node
'use strict';
// Builds a self-contained, read-only result view. Never calls an external service.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = x => JSON.stringify(x ?? null);
const embed = x => JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const relativeURL = x => x.split(path.sep).map(encodeURIComponent).join('/');
function moduleText(html, name) {
  const begin = `/* BEGIN ${name} */`, end = `/* END ${name} */`;
  const a = html.indexOf(begin), b = html.indexOf(end, a + begin.length);
  if (a < 0 || b < 0) throw new Error(`应用HTML缺少 ${name} 内联模块；请先重新assemble`);
  return html.slice(a + begin.length, b).trim();
}
function readCore(html) {
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, crypto: webcrypto });
  vm.runInContext(moduleText(html, 'core.js'), context, { filename: 'offline-core.js', timeout: 10000 });
  return context.PB;
}
function replaceOnce(text, needle, replacement) {
  if (text.split(needle).length !== 2) throw new Error(`应用代码结构已改变，离线保护未匹配：${needle.slice(0, 90)}`);
  return text.replace(needle, replacement);
}
function isFileWithin(root, relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(s=>s==='..'||s==='.'||s===''))return false;
  const target = path.resolve(root, relative), prefix = path.resolve(root) + path.sep;
  if (!target.startsWith(prefix)) return false;
  try { return fs.statSync(target).isFile() && fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep); } catch (_) { return false; }
}
function collectSources(batchDir, state) {
  const seen = new Set(), sources = [];
  const metadataPath=path.join(batchDir,'source_metadata.json');
  let metadata=null;
  if(isFileWithin(batchDir,'source_metadata.json')){
    metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8'));
    if(metadata?.schemaVersion!==1||!Array.isArray(metadata.sources))throw new Error('source_metadata.json格式无效');
  }
  for (const b of state.batches) for (const p of b.papers) {
    if (seen.has(p.id)) continue; seen.add(p.id);
    const source=metadata?.sources.find(s=>s.paperId===p.id);
    const preparation=metadata?.preparations?.find(s=>s.paperId===p.id);
    const preparedURL=key=>typeof preparation?.[key]==='string'&&isFileWithin(batchDir,preparation[key])?relativeURL(preparation[key]):null;
    const prepared={mineru:p.preparation?.method==='mineru',markdownURL:preparedURL('originalMarkdownAsset')||preparedURL('markdownAsset'),preparationURL:preparedURL('preparationAsset'),conversionMissing:preparation?.missingAssets,conversionWarning:preparation?.warning};
    const reviewAsset=path.join('assets','prepared',p.id,'review_text.txt'),reviewURL=isFileWithin(batchDir,reviewAsset)?relativeURL(reviewAsset):null;
    if(source){
      const sourceAsset=typeof source.sourceAsset==='string'&&isFileWithin(batchDir,source.sourceAsset)?source.sourceAsset:null;
      const textAsset=typeof source.textAsset==='string'&&isFileWithin(batchDir,source.textAsset)?source.textAsset:null;
      const sourcePath=typeof source.sourcePath==='string'&&source.sourcePath?source.sourcePath:null;
      const relativePath=typeof source.relativePath==='string'?source.relativePath:'';
      sources.push({...prepared,paperId:p.id,title:p.title,relative:sourceAsset,url:sourceAsset?relativeURL(sourceAsset):null,
        kind:sourceAsset&&/\.pdf$/i.test(sourceAsset)?'pdf':sourceAsset?'text':'metadata',
        textAsset,textURL:textAsset?relativeURL(textAsset):null,reviewURL,filename:String(source.filename||''),
        archiveTextMatchesImported:source.archiveTextMatchesImported,
        sourcePath,relativePath,origin:sourcePath?'local_path':'browser_upload',
        warnings:Array.isArray(source.warnings)?source.warnings.filter(x=>typeof x==='string'):[],
        sourceMissing:!sourceAsset,metadata:true});
      continue;
    }
    const relative = path.join('assets', 'prepared', p.id, 'source.pdf');
    if (isFileWithin(batchDir, relative)) sources.push({ paperId: p.id, title: p.title, relative, url: relativeURL(relative),reviewURL,kind:'pdf',metadata:false });
    else if(reviewURL||metadata?.missingPaperIds?.includes(p.id)||metadata?.missingSources?.some(s=>s.paperId===p.id))sources.push({...prepared,paperId:p.id,title:p.title,kind:'missing',reviewURL,sourceMissing:true,metadata:false});
  }
  return sources;
}
function inputDescription(batch){
  if(batch.protocol?.inputPreparationPolicy==='mineru_markdown_v1')return '本批PDF先由本机RTX5060 Ti上的MinerU转换为Markdown，再以冻结Markdown全文及字符索引评分；普通文本条目保持原文。原PDF和MD引用的图片未发送给评分模型，转换图片仅随离线包保留。索引页号为Markdown文本分段号，不代表原PDF物理页。转换版本、GPU、原PDF及MD哈希保留在批次和preparation.json中。';
  if(batch.protocol?.citationMode==='source_ids_v1')return (batch.protocol?.pdfInputs?.length?'本批发送PDF原件与冻结文本的原文定位索引；文本条目发送正文与索引。':'本批发送全文与冻结文本的原文定位索引，未发送PDF原件。')+'模型用原文编号定位，程序按原文哈希、字符偏移和物理页还原引文，不重写数学符号。source_catalog.json保存完整索引。定位成功不等于判断或科学结论已获独立验证。';
  if(batch.protocol?.pdfInputs?.length)return '本批使用PDF原件直读：file_url.url携带原始PDF的base64字节。请求记录中的paperbench-pdf:引用由同SHA-256源文件重建。提取/编辑文字仅用于本地引文核验，未作为PDF请求正文发送；缺少匹配引文的维度不进入评分汇总。API如何在服务端解析PDF不可由客户端验证。';
  const images=Array.isArray(batch.protocol?.mediaManifest)&&batch.protocol.mediaManifest.some(p=>Array.isArray(p.images)&&p.images.length);
  if(images||batch.protocol?.imagePolicy)return '本批协议记录了图像输入；实际图像覆盖范围以冻结协议、请求记录和随附资产为准。离线导出不补发或补造图像。';
  return '本批未记录图像输入协议。浏览器 PDF 入口只自动提取文字，不等同于全页图像评审；扫描件、数学符号与图表应结合原始文件人工核查。';
}
function readonlyApp(source, state) {
  let app = source;
  // All source-level access to browser storage uses an inert object in this snapshot,
  // including handlers which are hidden or not normally reachable from its interface.
  app = app.replace(/\blocalStorage\./g, 'PB_OFFLINE_STORAGE.');
  app = replaceOnce(app, "'<option value=\"\">新建批次</option>'", "''");
  const guards = [
    ['function persist(immediate = false) {', 'return;'],
    ['function saveConfig(showNotice = true) {', 'return state.config;'],
    ['async function connectLocalProfile(force=false) {', 'return false;'],
    ['function restoreGLMDefaults() {', 'return;'],
    ['function savePaperForm() {', "throw new Error('离线只读快照不允许修改论文。');"],
    ['async function startBatch(){', 'return;'],
    ['async function executeBatch(batch,key) {', 'return;'],
    ['async function loadDemo(){', 'return;'],
    ['async function importFiles(files) {', 'return;']
  ];
  for (const [signature, guard] of guards) app = replaceOnce(app, signature, signature + guard);
  // v2.1 file, API-route and report functions are optional for older appHTMLs.
  // Named entry guards also protect addEventListener callbacks, not just hidden
  // DOM on* properties. A changed signature is a build error when that function exists.
  for(const name of ['checkPDFInputs','workspacePost','configureLocalAPI','readWorkspacePaths','importWorkspaceFiles','pickWorkspaceInput','pickWorkspaceOutput','validateOutputPath','saveCurrentReport','collectDroppedFiles','withWorkspaceBusy','mergeWorkspaceFiles','uploadWorkspaceFiles','handleWorkspaceDrop','importBrowserTextFiles','recoverCurrentBatchLocally','prepareMineruPapers','cancelMineruPreparation','mineruPost']){
    const pattern=new RegExp('((?:async\\s+)?function\\s+'+name+'\\s*\\([^{}]*\\)\\s*\\{)','g');
    const matches=[...app.matchAll(pattern)];
    if(!matches.length){if(new RegExp('function\\s+'+name+'\\b').test(app))throw new Error('新离线入口保护未匹配：'+name);continue;}
    if(matches.length!==1)throw new Error('新离线入口不唯一：'+name);
    app=app.replace(pattern,signature=>signature+' return null;');
  }
  app = replaceOnce(app, "const a=e.target.closest('[data-action]')?.dataset.action;try{", "const a=e.target.closest('[data-action]')?.dataset.action;if(['demo','removeBatch'].includes(a)){notify('离线结果只读，不能添加或移除批次。');return;}try{");
  const init = `async function init() {
    bind();
    state=PB.validateArchive(PB_OFFLINE_ARCHIVE);
    state.config={...PB.DEFAULT_CONFIG,...state.config,apiKey:''};
    storageProtected=true;
    fillConfig();fillPaper();ready=true;
    changeBatch(state.currentBatchId||state.batches.at(-1)?.id||'');
    $('settings').hidden=true;
    $('storageStatus').textContent='离线只读结果 · 全部记录已内嵌 · 不联网、不读取或写入浏览器存储';
    if($('credentialStatus'))$('credentialStatus').textContent='离线阅读不需要API Key。';
    for(const id of ['mineruProgress','cancelMineruBtn','inputMode','checkSetupBtn','checkOutputBtn','reconnectWorkspaceBtn','recoveryBtn','demoBtn','importBtn','importFile','newPaper','deletePaper','savePaper','paperFiles','paperForm','saveConfigBtn','testBtn','glmPresetBtn','localProfileBtn','rememberKey','runBtn','resumeBtn','pauseBtn','apiMode','sendDoSample','inputPaths','recursiveInput','dropZone','folderFiles','pickInputFiles','pickInputFolder','readPathsBtn','outputPath','pickOutputFolder','autoSaveReport','saveReportBtn','workspaceStatus','inputStatus','outputStatus']) {
      const node=$(id);if(!node)continue;node.hidden=true;node.disabled=true;
      const block=event=>{event?.preventDefault?.();notify('离线结果只读；可查看、切换和导出现有记录。');};
      node.onclick=block;node.onchange=block;node.oninput=block;node.onsubmit=block;node.ondrop=block;node.ondragover=block;node.ondragenter=block;node.ondragleave=block;
    }
    return;`;
  app = replaceOnce(app, 'async function init() {', init);
  // The snapshot should describe the input actually used in this archive.
  app = app.replace('页面不把 PDF 二进制发送给模型，也不自动理解图片。', '本页仅展示已完成的归档，不重新发送任何材料。若协议记录 mediaManifest 或 imagePolicy，请以协议中的全页图像覆盖、实际请求和随附资产为准。');
  return app;
}
function makeTables(PB, state) {
  const summary = [['batch_id','batch_name','protocol_id','model','rank_descriptive','paper_id','title','review_schema_version','success_rounds','complete_five_dimension_rounds','planned_rounds','total_median_of_round_means',...PB.DIMS.flatMap(d => [d.id+'_median',d.id+'_sd',d.id+'_mad',d.id+'_n',d.id+'_min',d.id+'_max']),'criterion_statistics_json','format_warnings_json','review_warnings_json']];
  const scores = [['batch_id','protocol_id','model','paper_id','title','round','status','review_schema_version',...PB.DIMS.map(d => d.id),'round_mean_all_five','summary','limitations','dimensions_with_items_and_citations_json','analysis_json','revisions_json','format_warnings_json','review_warnings_json','request_response_refs_json','error','local_recovery_json','citation_repairs_json','validation_issues_json']];
  const usage = [['batch_id','paper_id','round','attempt_number','attempt_id','status','http_status','started_at','finished_at','duration_ms','model','system_fingerprint','finish_reason','prompt_tokens','completion_tokens','total_tokens','reasoning_tokens','request_path','response_path','payload_sha256','format_warnings_json','error']];
  for (const b of state.batches) {
    const data = b.papers.map(p => ({ p, s: PB.summarize(b,p.id) }));
    const full = b.config.repeats>=3 && b.runs.length === b.papers.length*b.config.repeats && b.runs.every(r => r.status === 'success') && data.every(x => x.s.completeRuns === b.config.repeats);
    const ordered = full ? [...data].sort((a,c) => c.s.total-a.s.total || a.p.id.localeCompare(c.p.id)) : data;
    for (const {p,s} of ordered) {
      const results = b.runs.filter(r => r.paperId === p.id && r.status === 'success').map(r => r.result);
      const versions = [...new Set(results.map(r => r.schemaVersion || 1))];
      summary.push([b.id,b.name,b.protocol.id,b.config.model,full?1+data.filter(x=>x.s.total>s.total+1e-9).length:'',p.id,p.title,versions.join('|'),s.successRuns,s.completeRuns,b.config.repeats,s.total,...PB.DIMS.flatMap(d=>{const z=s.dimensions[d.id];return[z.median,z.sd,z.mad,z.n,z.min,z.max];}),json(s.criteria||null),json(results.flatMap(r=>r.formatWarnings||[])),json(results.flatMap(r=>r.warnings||[]))]);
    }
    for (const r of b.runs) {
      const p=b.papers.find(p=>p.id===r.paperId), result=r.status==='success'?r.result:null;
      const ds=PB.DIMS.map(d=>result?.dimensions.find(x=>x.id===d.id)?.score??null);
      scores.push([b.id,b.protocol.id,b.config.model,r.paperId,p?.title,r.round,r.status,result?.schemaVersion||(result?1:''),...ds,ds.every(Number.isFinite)?PB.mean(ds):null,result?.summary,result?.limitations,json(result?.dimensions||null),json(result?.analysis||null),json(result?.revisions||null),json(result?.formatWarnings||[]),json(result?.warnings||[]),json(r.attempts.map(a=>({attemptId:a.id,requestPath:a.requestPath||null,responsePath:a.responsePath||null}))),r.error,json(r.localRecovery||null),json(result?.citationRepairs||[]),json(result?.validation?.issues||[])]);
      for (const [i,a] of r.attempts.entries()) usage.push([b.id,r.paperId,r.round,i+1,a.id,a.status,a.httpStatus,a.startedAt||a.startAt,a.finishedAt,a.durationMs,a.model,a.systemFingerprint,a.finishReason,a.usage?.prompt_tokens,a.usage?.completion_tokens,a.usage?.total_tokens,a.usage?.completion_tokens_details?.reasoning_tokens,a.requestPath,a.responsePath,a.payloadSha256,json(a.formatWarnings||(a.status==='success'?result?.formatWarnings:[])||[]),a.error]);
    }
  }
  return { 'summary.csv':PB.csv(summary), 'run_scores.csv':PB.csv(scores), 'usage.csv':PB.csv(usage) };
}
function exportOffline(batchDir, appPath = path.join(__dirname,'index.html')) {
  batchDir=path.resolve(batchDir);appPath=path.resolve(appPath);
  const html=fs.readFileSync(appPath,'utf8'), PB=readCore(html);
  const input=JSON.parse(fs.readFileSync(path.join(batchDir,'archive.json'),'utf8'));
  const state=PB.validateArchive(input);
  if(!state.batches.length)throw new Error('归档没有可展示的批次');
  if(!state.currentBatchId)state.currentBatchId=state.batches.at(-1).id;
  const snapshot=PB.exportArchive(state), selected=state.batches.find(b=>b.id===state.currentBatchId), sources=collectSources(batchDir,state);
  const planned=selected.papers.length*selected.config.repeats, success=selected.runs.filter(r=>r.status==='success').length;
  const valid=selected.papers.filter(p=>PB.summarize(selected,p.id).completeRuns===selected.config.repeats).length;
  const allReference=selected.papers.length>1&&selected.papers.every(p=>p.kind==='reference');
  const pdfCount=sources.filter(s=>s.kind==='pdf').length,inputMode=inputDescription(selected),lowN=selected.config.repeats<3;
  const sourceList=sources.map(s=>`<li><b>${esc(s.paperId)} · ${esc(s.title)}</b>${s.url?` · <a href="${esc(s.url)}">${s.kind==='pdf'?'原始 PDF':'原始文本文件'}</a>`:' · 原始文件未随包保存；来源缓存可能已失效，如需附件请在主程序重新导入后另存报告'}${s.markdownURL?` · <a href="${esc(s.markdownURL)}">MinerU 转换 Markdown</a>`:''}${s.preparationURL?` · <a href="${esc(s.preparationURL)}">转换来源记录</a>`:''}${s.conversionMissing?` · ${esc(s.conversionWarning)}`:''}${s.reviewURL?` · <a href="${esc(s.reviewURL)}">${selected.protocol?.citationMode==='source_ids_v1'?'本批原文索引来源文本':selected.protocol?.pdfInputs?.some(p=>p.paperId===s.paperId)?'本地引文核验文本（不随PDF发送）':'本批实际评审正文'}</a>`:''}${s.textURL?` · <a href="${esc(s.textURL)}">导入时提取全文</a>`:''}${s.metadata?`<p class="hint">${s.sourcePath?`本机读取路径：<code>${esc(s.sourcePath)}</code>`:`浏览器上传相对路径：<code>${esc(s.relativePath||s.filename||'未提供')}</code>；浏览器未提供原始绝对路径，本报告不推测。`}${s.archiveTextMatchesImported===false?(s.mineru?'<br>本批正文为原PDF的MinerU转换Markdown，源文件与MD哈希分别记录。':selected.protocol?.citationMode==='source_ids_v1'&&selected.protocol?.pdfInputs?.some(p=>p.paperId===s.paperId)?'<br>索引文字已编辑；本批发送原PDF及编辑后的文字索引，应核对二者差异。':selected.protocol?.pdfInputs?.some(p=>p.paperId===s.paperId)?'<br>本地核验文字已编辑；模型仍读取原始PDF，未发送编辑文字。':'<br>本批正文与导入时全文不同；原附件和提取全文仅是导入快照，实际评审内容以本批正文为准。'):''}${s.warnings.length?`<br>${s.warnings.map(esc).join('<br>')}`:''}</p>`:''}</li>`).join('');
  const recovered=selected.runs.filter(r=>r.localRecovery).length;
  const recoveryNotice=recovered?`<div class="callout">本地重解析恢复 ${recovered} 次结果：按原始响应规范化格式并保留合法评分；该恢复操作不调用模型。若另有补跑，其实际请求单独记入调用记录。原始失败尝试及恢复过程仍可在“评审理由与记录”查看。${isFileWithin(batchDir,'original_archive.json')?' <a href="original_archive.json">恢复前原始归档</a>':''}${isFileWithin(batchDir,'recovery-audit.json')?' · <a href="recovery-audit.json">恢复审计</a>':''}</div>`:'';
  const instructions=`<section class="card offline-materials"><h2>离线结果与原始材料</h2>${recoveryNotice}<p>${esc(selected.name)} · ${esc(selected.config.model)} · ${selected.papers.length} 篇 · ${success}/${planned} 次已解析；${valid}/${selected.papers.length} 篇全部五维及计划轮次有效。</p><p class="hint">本页是只读快照，全部评分与理由已内嵌。五个视图均可离线使用；原始响应、调用失败和格式兼容提示保留在归档。${allReference?'本批为多篇不同的对标论文，跨论文分差不是同一论文的版本改进。':''}</p><p class="hint">${esc(inputMode)}</p>${lowN?'<div class="callout amber">本批每篇少于 3 轮，仅用于检查输入、调用和报告链路；不提供描述性排名，也不足以判断评分稳定性或版本改善。</div>':''}<p><a href="archive.json" download>本包归档 JSON</a> · <a href="summary.csv" download>汇总 CSV</a> · <a href="run_scores.csv" download>逐轮评分与深评 CSV</a> · <a href="usage.csv" download>逐尝试用量 CSV</a> · <a href="execution_events.json">执行事件审计</a> · <a href="README.md">离线使用说明</a>${isFileWithin(batchDir,'source_metadata.json')?' · <a href="source_metadata.json">输入来源元数据</a>':''}</p>${sources.length?`<details><summary>实际随包保存的来源材料（${pdfCount} 份 PDF）</summary><ul>${sourceList}</ul></details>`:'<p class="hint">本目录未找到可链接的来源文件；已内嵌的论文文本与评审仍可查看，不据此声称原始 PDF 已随包保存。</p>'}</section>`;
  let app=readonlyApp(moduleText(html,'app.js'),snapshot);
  const oldApp=moduleText(html,'app.js');
  let output=replaceOnce(html,oldApp,app);
  const boot=`const PB_OFFLINE_ARCHIVE=${embed(snapshot)};
const PB_OFFLINE_STORAGE=Object.freeze({getItem:()=>null,setItem:()=>{},removeItem:()=>{},clear:()=>{}});
globalThis.fetch=()=>Promise.reject(new Error('离线只读结果禁止网络调用。'));
`;
  output=replaceOnce(output,'/* BEGIN core.js */',boot+'/* BEGIN core.js */');
  output=output.replace(/<title>[\s\S]*?<\/title>/,`<title>${esc(selected.name)} · ${esc(selected.config.model)} · 离线评审结果</title>`);
  const css=`\n/* Read-only snapshot controls. */\n.settings,.library,.workspace-intake,.input-panel,.output-panel,#recoveryBtn,#demoBtn,#importBtn,#importFile,#runBtn,#resumeBtn,#recoverLocalBtn,#pauseBtn,#batchName,#newPaper,#glmPresetBtn,#localProfileBtn,#apiMode,#sendDoSample,#inputPaths,#recursiveInput,#dropZone,#folderFiles,#pickInputFiles,#pickInputFolder,#readPathsBtn,#outputPath,#pickOutputFolder,#autoSaveReport,#saveReportBtn,#workspaceStatus,#inputStatus,#outputStatus,[data-action="removeBatch"],[data-action="demo"],label:has(#apiMode),label:has(#inputPaths),label:has(#recursiveInput),label:has(#outputPath),label:has(#autoSaveReport){display:none!important}.workspace{grid-template-columns:minmax(0,1fr)}.batch-controls{grid-template-columns:minmax(0,1fr)}.batch-controls label:has(#batchName){display:none}.offline-materials{margin:0 0 20px}.local-tag{font-size:0}.local-tag::after{content:'OFFLINE RESULTS';font-size:11px}\n`;
  output=replaceOnce(output,'</style>',css+'</style>');
  output=replaceOnce(output,'<main>','<main>'+instructions);
  const csp=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  output=replaceOnce(output,'<head>','<head>'+csp);
  fs.writeFileSync(path.join(batchDir,'index.html'),output,'utf8');
  for(const [name,value]of Object.entries(makeTables(PB,state)))fs.writeFileSync(path.join(batchDir,name),value,'utf8');
  fs.writeFileSync(path.join(batchDir,'execution_events.json'),JSON.stringify(state.batches.map(b=>({batchId:b.id,status:b.status,completionState:b.completionState||null,events:b.executionEvents||[]})),null,2),'utf8');
  const readme=`# 离线论文评审结果\n\n双击本目录的 **index.html** 即可阅读。无需联网、API Key 或本地服务器。请保持目录结构，以便打开相对路径下的材料。\n\n当前批次：${selected.name}\n\n- 模型：${selected.config.model}\n- 论文：${selected.papers.length} 篇；每篇计划 ${selected.config.repeats} 轮。\n- 已解析：${success}/${planned} 次；全部五维与计划轮次完整：${valid}/${selected.papers.length} 篇。调用结束与所有维度可评是不同状态。\n- 输入方式：${inputMode}\n${lowN?'\n**每篇少于3轮，仅检查输入、调用和报告链路；不提供描述性排名，不能判断稳定性或版本改善。**\n':''}\n## 文件\n\n- index.html：内嵌归档的只读工作台，保留评分总览、比较、理由与原始调用、稳定性复核、评分方法五个视图，以及雷达图与 JSON/CSV 导出。模型调用、本机配置/API路由连接、读取文件/拖拽/选择目录、保存报告和浏览器存储均关闭。隐藏修改按钮及文件事件也已禁用。\n- original_archive.json / recovery-audit.json：若存在，前者保留恢复前归档，后者分别记录本地重解析和可能的真实补跑请求；本地重解析不调用模型，补跑按实际调用数量审计。\n- archive.json：本包归档，导出器未修改。页面根据所用核心验证后展示结果；v1/MM历史结果保留原分与理由，不补造v2检查项。\n- summary.csv：每篇的维度中位数、SD、MAD、有效 n、总分有效轮数及检查项统计。仅每篇至少3轮且全批五维/轮次完整时给描述性名次，同分同名次；低轮数保留分数但不排名。\n- run_scores.csv：每轮五维分、完整五维均分、完整检查项与引用 JSON、主张审计、修订建议、format_warnings_json、validation_issues_json 和核验提示。包含失败/待运行槽位；null不当作0分。\n- execution_events.json：按批次保留执行策略切换、暂停、恢复和排空在途请求等审计事件。\n- usage.csv：每次尝试一行，保留状态、用量、文件引用与格式兼容提示；未报告用量留空，不推算费用。失败尝试若报告用量也保留。\n- requests/、responses/：若原批次包含，保留各次实际调用审计与原始响应；离线导出不重新调用模型，也不改写这些文件。图片请求可能采用asset://本地引用，需结合相应保存的图像与SHA-256重建载荷。\n- assets/prepared/：MinerU批次包含score.md（实际评分文本）、preparation.json（冻结转换来源）；mineru/下保留经哈希核验的完整转换输出、Markdown相对图片及日志。图片未发送给文本评分模型。会话缓存失效时明确列为缺失，score.md仍可阅读。若已存在，可包含原文、图像和PDF。页面只链接实际存在且位于报告目录内的来源文件，本次找到 ${pdfCount} 份PDF；不猜测或下载缺失PDF。\n- source_catalog.json：v2.3索引模式生成，记录本批冻结文本哈希、编号、精确原文、页码与字符范围。编号只证明来源定位，不独立证明模型结论。\n- source_metadata.json：若存在，记录本机原路径或浏览器上传相对路径、来源哈希、提取全文路径及警告。浏览器上传的sourcePath为null，不能还原原始绝对路径。文本文件的source.txt保留原始字节；paper_text.txt记录导入时提取文本，review_text.txt记录本批冻结的文本输入；PDF索引模式下为发送给模型的索引来源文本，PDF原件另行发送。如果archiveTextMatchesImported为false，原附件仅是导入快照，不能当作本批实际正文。missingPaperIds/missingSources记录来源缓存失效的附件；归档和评分仍保留，如需恢复附件请在主程序重新导入后另存报告。\n\n## 如何读分数\n\n总分是每轮完整五维均分的跨轮中位数，不一定等于表格中五个维度中位数的平均数。SD为样本标准差，MAD为距中位数绝对偏差的中位数；各维有效n可不同。v2检查项等级为0–4，其波动单位与1–10维度分不同。格式兼容提示与原始回复一并保留，文字匹配只验证引文出现，不验证研究真实性。\n\n不同论文之间的比较仅作描述，不能解释为同一论文的版本改进或显著排名。新量表须经独立真实复测后才能讨论是否提高了区分能力或稳定性。\n\n## 再次导出\n\n使用 Node.js：\n\n\`\`\`text\nnode export_offline.cjs <batchdir> [appHTML]\n\`\`\`\n\n导出器生成本页、三个CSV、执行事件、本说明及原文引文索引；不修改原始归档、请求、响应或评分程序。分享前确认愿意分享原文与模型评语；离线阅读不需要任何密钥。\n`;
  if(selected.protocol?.citationMode==='source_ids_v1')fs.writeFileSync(path.join(batchDir,'source_catalog.json'),JSON.stringify({version:PB.SOURCE_CATALOG_VERSION,papers:selected.papers.map(p=>({paperId:p.id,sourceTextHash:p.hash,entries:PB.buildSourceCatalog(p.text)}))},null,2),'utf8');
  fs.writeFileSync(path.join(batchDir,'README.md'),readme,'utf8');
  return {output:batchDir,batchId:selected.id,model:selected.config.model,papers:selected.papers.length,plannedCalls:planned,successfulCalls:success,fullyScoredPapers:valid,pdfLinks:pdfCount,sourceRecords:sources.length,inputMode,lowRepeatCount:lowN,htmlBytes:Buffer.byteLength(output)};
}
module.exports={exportOffline,readCore,moduleText,readonlyApp,makeTables,collectSources,inputDescription};
if(require.main===module){try{if(!process.argv[2])throw new Error('用法：node export_offline.cjs <batchdir> [appHTML]');console.log(JSON.stringify(exportOffline(process.argv[2],process.argv[3])));}catch(error){console.error(error.message);process.exitCode=1;}}
