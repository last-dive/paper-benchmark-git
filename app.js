(() => {
'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (x, digits = 2) => typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : '—';
const signed = x => typeof x === 'number' && Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(2)}` : '—';
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const time = x => x ? new Date(x).toLocaleString('zh-CN', {hour12:false}) : '—';
const colors = ['#087e8b','#d26b34','#5263b3','#ae467b','#648422','#687888'];
const configIds = ['inputMode','endpoint','model','apiKey','temperature','topP','maxTokens','seed','responseJson','thinking','reasoningEffort','doSample','sendDoSample','timeout','retries','concurrency','repeats','maxChars','paperType','anchors'];
const booleanIds = new Set(['responseJson','doSample','sendDoSample']);
const numericIds = new Set(['temperature','topP','maxTokens','timeout','retries','concurrency','repeats','maxChars']);
const defaultState = () => ({schemaVersion:1,config:{...PB.DEFAULT_CONFIG},papers:[],batches:[],currentBatchId:''});
let state = defaultState(), editingId = null, activeTab = 'overview', running = false, controller = null, db = null;
let baselineId = '', radarIds = new Set(), auditPaperId = '', reasonTarget = '', reasonRound = 1, overviewPaperId = '', overviewRound = 1;
let threshold = .5, historyBatchId = '', saveTimer, renderTimer, saveChain = Promise.resolve(), ready = false;
let dirtyPaper = false, testController = null, storageProtected = false, recoveryData = null, creating = false, pendingRemoval = null;
let localProfileEndpoint = '', workspaceSession = null, workspaceBusy = false, reportSaving = false, lastSavedReport = null, workspaceModeSaved = false, preparedRoute = null;
let confirmedConfig='', validatedOutput='', mineruPreparation=null;
let workspacePreferences = {apiMode:'default',inputPaths:'',outputPath:'',autoSaveReport:true,recursiveInput:true,sourceRefs:{},sourceMetadata:{}};
const offlineSnapshot = () => typeof PB_OFFLINE_ARCHIVE !== 'undefined';
const inputBusy = () => running || creating || workspaceBusy || reportSaving || !!testController;
function saveWorkspacePreferences() {
  if(offlineSnapshot() || storageProtected)return;
  try{localStorage.setItem('paperbench-workspace-v21',JSON.stringify(workspacePreferences));}catch(error){notify('路径设置暂未保存：'+error.message,true);}
}
function loadWorkspacePreferences() {
  if(offlineSnapshot())return;
  try{const raw=localStorage.getItem('paperbench-workspace-v21');if(raw){const saved=JSON.parse(raw);for(const key of ['inputPaths','outputPath'])if(typeof saved[key]==='string')workspacePreferences[key]=saved[key];for(const key of ['autoSaveReport','recursiveInput'])if(typeof saved[key]==='boolean')workspacePreferences[key]=saved[key];if(['default','custom'].includes(saved.apiMode)){workspacePreferences.apiMode=saved.apiMode;workspaceModeSaved=true;}for(const key of ['sourceRefs','sourceMetadata'])if(saved[key]&&typeof saved[key]==='object'&&!Array.isArray(saved[key]))workspacePreferences[key]=saved[key];}}
  catch(error){notify('本机路径偏好无法读取，使用当前默认值：'+error.message,true);}
}
function fillWorkspaceControls() {
  if($('apiMode'))$('apiMode').value=workspacePreferences.apiMode;
  if($('inputPaths'))$('inputPaths').value=workspacePreferences.inputPaths;
  if($('outputPath'))$('outputPath').value=workspacePreferences.outputPath;
  if($('recursiveInput'))$('recursiveInput').checked=workspacePreferences.recursiveInput;
  if($('autoSaveReport'))$('autoSaveReport').checked=!!workspaceSession&&workspacePreferences.autoSaveReport;
  updateWorkspaceControls();
}
function configSignature(){try{return JSON.stringify(readConfig());}catch{return '';}}
function pdfDescriptor(p){const m=workspacePreferences.sourceMetadata[p.id];return m?.isPdf&&/^[a-f0-9]{64}$/.test(m.fileSha256)&&Number.isInteger(m.bytes)&&m.bytes>0?{sha256:m.fileSha256,size:m.bytes}:null;}
function localMineruAPI(config=state.config){try{return workspacePreferences.apiMode==='custom'&&['127.0.0.1','localhost','::1'].includes(new URL(config.endpoint).hostname.replace(/^\[|\]$/g,''));}catch{return false;}}
function mineruPDF(p){return localMineruAPI()&&workspacePreferences.sourceMetadata[p.id]?.isPdf;}
function directPDF(p){return $('inputMode')?.value==='pdf'&&!!workspaceSession&&!!pdfDescriptor(p);}
function missingBodies(){return state.papers.filter(p=>mineruPDF(p)?(!workspaceSession||!pdfDescriptor(p)):$('inputMode')?.value==='pdf'&&workspacePreferences.sourceMetadata[p.id]?.isPdf?(!directPDF(p)||!p.text.trim()):(typeof p.text!=='string'||!p.text.trim()));}
function reviewPapers(){return state.papers.map(p=>{if(mineruPDF(p)){if(!workspaceSession||!pdfDescriptor(p))throw new Error('MinerU 转换需要已导入的 PDF 原件，请连接本机服务并重新导入 '+p.title);return {...p,pdf:pdfDescriptor(p)};}if($('inputMode')?.value==='pdf'&&workspacePreferences.sourceMetadata[p.id]?.isPdf&&!directPDF(p))throw new Error('PDF直读需要原件：请连接本机服务并重新导入 '+p.title+'；不会静默改成文本发送。');return directPDF(p)?{...p,pdf:pdfDescriptor(p)}:{...p};});}
async function checkPDFInputs(papers){if(offlineSnapshot())return;const hashes=[...new Set(papers.filter(p=>p.pdf).map(p=>p.pdf.sha256))];if(!hashes.length)return;if(!workspaceSession)throw new Error('PDF直读需本机服务；请重新导入原PDF。');await workspacePost('/local-files/pdf-check',{hashes});}
function assertPaperReadiness(){
 if(!state.papers.length)throw new Error('第 2 步未完成：请添加论文并读取正文。');
 const mineruMissing=state.papers.filter(p=>mineruPDF(p)&&(!workspaceSession||!pdfDescriptor(p)));
 if(mineruMissing.length)throw new Error('第2步未完成：MinerU 转换需要 PDF 原件，请连接本机服务并重新导入：'+mineruMissing.map(p=>p.title).join('、'));
 const missing=missingBodies(), pdfMissing=missing.filter(p=>$('inputMode')?.value==='pdf'&&workspacePreferences.sourceMetadata[p.id]?.isPdf&&!directPDF(p));
 if(pdfMissing.length)throw new Error('第2步未完成：请连接本机服务并重新导入PDF原件：'+pdfMissing.map(p=>p.title).join('、')+'；不会静默改用文本。');
 const emptyIndex=missing.filter(p=>directPDF(p)&&!p.text.trim());
 if(emptyIndex.length)throw new Error('第2步未完成：PDF原件已就绪，但引文定位索引为空：'+emptyIndex.map(p=>p.title).join('、')+'。请重新提取正文，或核对OCR/粘贴的原文后保存；此时不会调用模型。');
 if(missing.length)throw new Error(`第 2 步未完成：${missing.length}/${state.papers.length} 篇正文为空：${missing.map(p=>p.title||'未命名论文').join('、')}。${workspaceSession?'请重新选择原PDF以提取正文；扫描件需OCR或粘贴全文。':'请先按顶部指引启动本机服务，再重新导入PDF；登记文件名不等于读取正文。'}`);
}
function renderWorkflow(){
 if(offlineSnapshot()||!$('workflowStatus'))return;
 const missing=missingBodies(), total=state.papers.length, sig=configSignature();
 const local=!!workspaceSession, output=$('outputPath').value.trim();
 const configOK=!!sig&&sig===confirmedConfig;
 const credentialOK=local&&workspacePreferences.apiMode==='default'?workspaceSession.credentialReady:true;
 const bodyOK=total>0&&!missing.length, outputOK=local&&!!output&&validatedOutput===output;
 $('stepConfig').textContent=configOK&&credentialOK?'✓ 已完成 · 参数已保存（不等于连接测试通过）':'待完成 · 保存参数'+(!credentialOK?'；默认密钥尚未配置':'');
 $('stepInput').textContent=bodyOK?`✓ 已完成 · ${total}/${total} 篇输入就绪（PDF原件或文本）`:`待完成 · 已登记 ${total} 篇，输入就绪 ${total-missing.length} 篇`;
 $('stepOutput').textContent=outputOK?'✓ 已完成 · 输出目录已检查':local?'待完成 · 填写目录并点击“检查并保存路径”':'待完成 · 路径可先填写；需启动本机服务才能写报告';
 const batch=currentBatch(), saved=!!batch&&!!lastSavedReport&&lastSavedReport.batchId===batch.id;
 $('stepRun').textContent=mineruPreparation&&creating&&!running?mineruStatusText():batch?.draining?`已停止新请求 · 等待在途结果 · ${batchPauseReason(batch)}`:batch?.status==='paused'?`${batchProgress(batch).inflight?'正在暂停 · 等待已发出请求返回':'已暂停'} · ${batchPauseReason(batch)}${saved?' · 当前进度报告已保存':''}`:batch?.status==='complete'?`${batchCompletionLabel(batch)} · 五维完整 ${batchProgress(batch).complete}/${batchProgress(batch).total}${saved?' · 报告已保存':' · 请核对报告保存状态'}`:running?'正在评分 · 页面会自动更新，无需刷新':saved?'当前进度报告已保存 · 见下方报告入口':'待开始 · 检查设置后开始新批次';
 $('workflowStatus').textContent=inputBusy()?'正在处理当前操作，请稍候…':missing.length?`第 2 步需要处理：${missing.map(p=>p.title).join('、')} 尚无正文。请重新导入原PDF或粘贴全文。`:configOK&&credentialOK&&bodyOK&&outputOK?'设置检查就绪，可以开始新批次。': '按 1 → 2 → 3 → 4 操作；“已登记”只代表文件条目存在，原件或文本输入全部就绪才能评分。';
 for(const [id,ok] of [['stepConfig',configOK&&credentialOK],['stepInput',bodyOK],['stepOutput',outputOK]])$(id).className=ok?'step-complete':'step-pending';
 $('serviceGuide').hidden=local;
 $('checkSetupBtn').disabled=inputBusy()||!ready;
 $('checkOutputBtn').disabled=inputBusy()||!ready;
 $('reconnectWorkspaceBtn').disabled=inputBusy()||!ready;
}
async function checkSetup(){
 if(offlineSnapshot())return;
 return withWorkspaceBusy(async()=>{if(dirtyPaper)savePaperForm();saveConfig(false);assertPaperReadiness();await checkPDFInputs(reviewPapers());if(workspaceSession&&workspacePreferences.apiMode==='default'&&!workspaceSession.credentialReady)throw new Error('第 1 步：本机默认密钥未配置；请配置默认密钥或使用自定义 API。');await validateOutputPath();notify(`设置检查完成：${state.papers.length} 篇正文就绪，参数已保存，输出路径可写。可以开始新批次；本次检查未调用模型。`);});
}
function repeatPreview() {const value=Number($('repeats').value);return Number.isInteger(value)&&value>=1&&value<=30?value:null;}
function updateWorkspaceControls() {
  const busy=inputBusy()||!ready, local=!!workspaceSession;
  for(const id of ['apiMode','folderFiles','paperFiles','inputPaths','recursiveInput','pickInputFiles','pickInputFolder','readPathsBtn','pickOutputFolder','autoSaveReport'])if($(id))$(id).disabled=busy||(!local&&['inputPaths','pickInputFiles','pickInputFolder','readPathsBtn','pickOutputFolder','autoSaveReport'].includes(id));
  if($('outputPath'))$('outputPath').disabled=busy;
  if($('apiKey'))$('apiKey').disabled=busy||(local&&workspacePreferences.apiMode==='default');if($('rememberKey')){$('rememberKey').disabled=true;$('rememberKey').checked=false;}
  if($('saveReportBtn'))$('saveReportBtn').disabled=busy||!local||!currentBatch();
  if($('dropZone')){$('dropZone').setAttribute?.('aria-disabled',String(busy));$('dropZone').classList.toggle('is-busy',busy);}
  if($('workspaceStatus'))$('workspaceStatus').textContent=local?'本机文件与报告服务已连接；文件路径由服务读取，密钥与会话标识不写入归档。':'浏览器模式：可导入文本；自动提取PDF、读取绝对路径和写入报告目录需要从 start_local.py 地址打开。';
  if($('autoSaveReport')&&!local)$('autoSaveReport').checked=false;
  if($('lowRepeatHint')){const repeats=repeatPreview();$('lowRepeatHint').textContent=repeats===null?'请将每篇复评轮数设为1–30之间的整数。':repeats<3?'1–2 轮仅用于链路检查和初步阅读；不报告排名或稳定性结论。':'建议结合有效轮数、SD、MAD和原文理由解释分差。';}
  renderWorkflow();
}
async function workspacePost(route,body,signal) {
  if(offlineSnapshot())return;
  if(!workspaceSession)throw new Error('请先运行 start_local.py，并从显示的本机地址打开页面。');
  const response=await fetch(new URL(route,workspaceSession.origin).toString(),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Paperbench-Token':workspaceSession.token},body:JSON.stringify(body),...(signal?{signal}:{})});
  let result;try{result=await response.json();}catch{throw new Error('本机服务没有返回有效JSON。');}
  if(!response.ok){const error=new Error(typeof result.error==='string'?result.error:result.error?.message||result.message||`本机请求失败 HTTP ${response.status}`);error.httpStatus=response.status;throw error;}
  return result;
}
async function configureLocalAPI(config) {
  if(offlineSnapshot())return config;
  if(!workspaceSession)return config;
  const official=PB.validateConfig({...PB.DEFAULT_CONFIG,apiKey:''}).endpoint;
  const useDefault=workspacePreferences.apiMode==='default'&&config.endpoint===official;
  const route=await workspacePost('/local-api/configure',{endpoint:config.endpoint,apiKey:useDefault?'':config.apiKey||'',useDefault});
  if(!route||typeof route.routeId!=='string'||typeof route.endpoint!=='string')throw new Error('本机模型路由响应无效。');
  PB.setLocalRoute({upstream:route.endpoint,endpoint:workspaceSession.endpoint,routeId:route.routeId,token:workspaceSession.token});preparedRoute={upstream:route.endpoint,key:config.apiKey||'',mode:workspacePreferences.apiMode};
  return {...config,endpoint:route.endpoint};
}
async function withWorkspaceBusy(work) {
  if(offlineSnapshot())return;
  if(inputBusy())throw new Error('当前任务正在运行，请等待结束后再修改输入或输出。');
  workspaceBusy=true;renderBatchHeader();
  try{return await work();}finally{workspaceBusy=false;renderBatchHeader();}
}
function sourceDescription(p) {
  const meta=workspacePreferences.sourceMetadata[p.id];if(!meta)return '';
  const source=meta.sourcePath?meta.sourcePath:`浏览器相对路径：${meta.relativePath||meta.filename||p.title}（原绝对路径不可得）`;
  return source+(meta.isPdf?(mineruPDF(p)?' · 本地 API：GPU / MinerU 将原始 PDF 转成 Markdown 后评分；编辑框文字不参与此次转换':directPDF(p)?' · PDF原件 + 引文定位索引；编辑框文字用于索引和本地核验':' · PDF纯文本输入，公式与扫描识别需核查'):'')+(meta.textWasEdited?' · 正文已编辑，源文件仍为导入时快照':' · 源文件为导入时快照');
}
async function mergeWorkspaceFiles(result) {
  if(offlineSnapshot())return;
  const imported=[],refreshed=[],skipped=[],errors=(result.errors||[]).map(x=>`${x.path||x.filename||'文件'}：${x.message||x.error||'读取失败'}`);
  for(const f of result.files||[]){
    if(typeof f.text!=='string'||f.text.length>2000000){skipped.push(`${f.filename}：正文无效或超过200万字符`);continue;}
    const sourcePath=typeof f.sourcePath==='string'&&f.sourcePath.startsWith('/')?f.sourcePath:null;
    const relativePath=f.relativePath||f.filename||'导入文件';
    const sameSource=Object.entries(workspacePreferences.sourceMetadata).filter(([id,m])=>state.papers.some(p=>p.id===id)&&(sourcePath?m.sourcePath===sourcePath:!m.sourcePath&&m.relativePath===relativePath));
    const emptyMatches=Object.entries(workspacePreferences.sourceMetadata).filter(([id,m])=>f.sha256&&m.fileSha256===f.sha256&&!m.textWasEdited&&state.papers.some(p=>p.id===id&&!p.text.trim()));
    const identical=sameSource.find(([,m])=>typeof f.sha256==='string'&&f.sha256.length>0&&m.fileSha256===f.sha256)||(emptyMatches.length===1?emptyMatches[0]:null);
    if(identical&&f.sourceId){const [id,meta]=identical;workspacePreferences.sourceRefs[id]=f.sourceId;meta.sourceId=f.sourceId;if(f.bytes)meta.bytes=f.bytes;const old=state.papers.find(p=>p.id===id);if(old&&!old.text.trim()&&f.text.trim()&&!meta.textWasEdited){old.text=f.text;Object.assign(meta,{sourcePath,relativePath,importedTextHash:await PB.hashText(f.text),pages:f.pages||null,warnings:f.warnings||[]});if(editingId===id)fillPaper(id);refreshed.push(`${relativePath}：空正文已补全，可参与新批次评分`);}refreshed.push(`${sourcePath||relativePath}：已刷新附件缓存，保留原论文ID、正文和历史评分`);continue;}
    if(sameSource.length){skipped.push(`${sourcePath||relativePath}：重复来源已跳过；${identical?'服务未返回附件缓存ID':'文件哈希与已有来源不同，未替换旧附件'}（需作为新版本导入时先移除库中旧条目，历史批次仍保留原快照）`);continue;}
    if(state.papers.length>=30){skipped.push(`${f.filename}：论文库已达30篇`);continue;}
    const p={id:uid(),title:f.title||String(f.filename||'未命名论文').replace(/\.[^.]+$/,''),version:'',group:'',kind:'draft',change:'other',text:f.text};
    state.papers.push(p);imported.push(p.id);
    if(f.sourceId)workspacePreferences.sourceRefs[p.id]=f.sourceId;
    workspacePreferences.sourceMetadata[p.id]={sourceId:f.sourceId||null,sourcePath,relativePath,filename:f.filename||relativePath,fileSha256:f.sha256||null,bytes:f.bytes||null,importedTextHash:await PB.hashText(f.text),pages:f.pages||null,isPdf:/\.pdf$/i.test(f.filename||relativePath),warnings:f.warnings||[],textWasEdited:false};
  }
  saveWorkspacePreferences();if(imported.length)fillPaper(imported[0]);renderAll();persist();
  const message=`导入 ${imported.length} 篇；刷新附件缓存 ${refreshed.length} 项；跳过 ${skipped.length} 项，失败 ${errors.length} 项。`+(refreshed.length?'\n'+refreshed.join('\n'):'')+(skipped.length?'\n'+skipped.join('\n'):'')+(errors.length?'\n'+errors.join('\n'):'');
  const readiness=`\n输入就绪 ${state.papers.length-missingBodies().length}/${state.papers.length} 篇。`+(missingBodies().length?'第2步尚未完成：空正文条目需在本机服务重新导入原PDF，或粘贴全文。':'第2步完成：原件或文本输入已就绪。');if($('inputStatus'))$('inputStatus').textContent=message+readiness;notify(message+readiness,!!errors.length||!!missingBodies().length);renderWorkflow();
  return {imported,refreshed,skipped,errors};
}
async function readWorkspacePaths(paths) {
  if(offlineSnapshot())return;
  return withWorkspaceBusy(async()=>{if(dirtyPaper)savePaperForm();const chosen=paths||$('inputPaths').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(!chosen.length)throw new Error('请填写至少一个绝对文件或目录路径，每行一个。');workspacePreferences.inputPaths=chosen.join('\n');workspacePreferences.recursiveInput=$('recursiveInput').checked;saveWorkspacePreferences();return mergeWorkspaceFiles(await workspacePost('/local-files/read',{paths:[...new Set(chosen)],recursive:workspacePreferences.recursiveInput}));});
}
function bytesToBase64(buffer) {const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
async function uploadWorkspaceFiles(files) {
  if(offlineSnapshot())return;
  const serialized=[],unsupported=[...(files.errors||[])];let totalBytes=0;const maximum=workspaceSession?.workspace?.maxFileBytes||33554432;if(files.length>100)throw new Error('一次最多导入100个文件。');
  for(const item of files){const file=item.file||item;const relativePath=item.relativePath||file.webkitRelativePath||file.name;if(!/\.(pdf|txt|md|text)$/i.test(file.name)){unsupported.push({path:relativePath,message:'不支持的格式，未上传'});continue;}if(file.size>maximum)throw new Error(`${relativePath} 超过本机单文件${Math.round(maximum/1048576)}MiB限制。`);totalBytes+=file.size||0;if(totalBytes>128*1024*1024)throw new Error('本次上传超过128MiB，请分批导入。');try{const buffer=await file.arrayBuffer();serialized.push({name:file.name,relativePath,base64:bytesToBase64(buffer)});}catch(error){unsupported.push({path:relativePath,message:fileReadMessage(error)});}}
  if(!serialized.length)return mergeWorkspaceFiles({files:[],errors:unsupported.length?unsupported:[{path:'输入文件',message:'没有可导入的PDF、TXT或Markdown文件。'}]});
  const result=await workspacePost('/local-files/upload',{files:serialized});result.errors=[...(result.errors||[]),...unsupported];return mergeWorkspaceFiles(result);
}
async function importWorkspaceFiles(files) {
  if(offlineSnapshot())return;
  return withWorkspaceBusy(async()=>{if(dirtyPaper)savePaperForm();return uploadWorkspaceFiles(files);});
}
function fileReadMessage(error) {
  if(error?.name==='EncodingError'||/URI.*malformed|Data URL|URL length/i.test(error?.message||''))return '浏览器文件条目读取失败（EncodingError / URI）；请改用“选择文件/目录”，或在本机绝对路径框输入原路径后点击“读取路径”。这条浏览器错误不能单独证明文件超过大小限制。';
  return (error?.message||String(error))+'；可改用“选择文件/目录”或本机绝对路径读取。';
}
function snapshotDrop(dataTransfer) {
  // Capture File objects while the drag data store is still readable. Directory
  // entries are needed for recursion only, not as the primary file reader.
  const entries=[],files=[],errors=[];
  for(const item of Array.from(dataTransfer?.items||[])){
    let entry=null,file=null,entryError=null;
    try{file=item.getAsFile?.();}catch(error){entryError=error;}
    try{entry=item.webkitGetAsEntry?.()||item.getAsEntry?.();}catch(error){entryError=error;}
    if(entry?.isDirectory)entries.push(entry);
    else if(file)files.push(file);
    else if(entry)entries.push(entry);
    else if(entryError)errors.push({path:'拖拽条目',message:fileReadMessage(entryError)});
  }
  if(!entries.length&&!files.length){files.push(...Array.from(dataTransfer?.files||[]));if(files.length)errors.length=0;}
  let uris=[];try{uris=String(dataTransfer?.getData?.('text/uri-list')||'').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#')&&/^file:\/\//i.test(s));}catch{/* File objects do not depend on optional URI metadata. */}
  return {entries,files,uris,errors};
}
async function collectDroppedFiles(snapshot) {
  if(offlineSnapshot())return [];
  const files=snapshot.files.map(file=>({file,relativePath:file.webkitRelativePath||file.name}));files.errors=[...(snapshot.errors||[])];let visited=0;if(files.length>100)throw new Error('拖拽文件超过100个，请缩小范围或分批导入。');
  async function visit(entry,parent=''){
    if(++visited>10000)throw new Error('目录扫描超过10000项，请缩小目录范围。');
    const relativePath=parent+entry.name;
    if(entry.isFile){if(files.length>=100)throw new Error('目录文件超过100个，请缩小范围或分批导入。');let file;try{file=await new Promise((resolve,reject)=>entry.file(resolve,reject));}catch(error){files.errors.push({path:relativePath,message:fileReadMessage(error)});return;}files.push({file,relativePath});}
    else if(entry.isDirectory){let reader;try{reader=entry.createReader();}catch(error){files.errors.push({path:relativePath,message:fileReadMessage(error)});return;}while(true){let children;try{children=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));}catch(error){files.errors.push({path:relativePath,message:fileReadMessage(error)});return;}if(!children.length)break;for(const child of children){if(child.isDirectory&&!workspacePreferences.recursiveInput)continue;await visit(child,relativePath+'/');}}}
  }
  for(const entry of snapshot.entries)await visit(entry);
  return files;
}
async function handleWorkspaceDrop(snapshot) {
  if(offlineSnapshot())return;
  return withWorkspaceBusy(async()=>{
    if(dirtyPaper)savePaperForm();
    if(snapshot.uris.length&&workspaceSession)return mergeWorkspaceFiles(await workspacePost('/local-files/read',{paths:[...new Set(snapshot.uris)],recursive:workspacePreferences.recursiveInput}));
    const files=await collectDroppedFiles(snapshot);
    if(!files.length)return mergeWorkspaceFiles({files:[],errors:files.errors.length?files.errors:[{path:'拖拽输入',message:'未取得可读取文件。请使用“选择文件/目录”或本机绝对路径读取；不导入 data: 链接。'}]});
    const realPaths=files.map(x=>x.file.path).filter(x=>typeof x==='string'&&x.startsWith('/'));
    if(realPaths.length===files.length&&workspaceSession){const result=await workspacePost('/local-files/read',{paths:[...new Set(realPaths)],recursive:workspacePreferences.recursiveInput});result.errors=[...(result.errors||[]),...files.errors];return mergeWorkspaceFiles(result);}
    if(workspaceSession)return uploadWorkspaceFiles(files);
    return importBrowserTextFiles(files);
  });
}
async function pickWorkspaceInput(kind) {
  if(offlineSnapshot())return;
  return withWorkspaceBusy(async()=>{const result=await workspacePost('/local-files/pick',{kind});if(result.cancelled)return;if(!result.paths?.length)return;workspacePreferences.inputPaths=result.paths.join('\n');$('inputPaths').value=workspacePreferences.inputPaths;saveWorkspacePreferences();if(dirtyPaper)savePaperForm();return mergeWorkspaceFiles(await workspacePost('/local-files/read',{paths:result.paths,recursive:workspacePreferences.recursiveInput}));});
}
async function pickWorkspaceOutput() {
  if(offlineSnapshot())return;
  return withWorkspaceBusy(async()=>{const result=await workspacePost('/local-files/pick',{kind:'output'});if(result.cancelled||!result.paths?.length)return;workspacePreferences.outputPath=result.paths[0];$('outputPath').value=result.paths[0];saveWorkspacePreferences();});
}
async function validateOutputPath() {
  if(offlineSnapshot())return;
  if(!workspaceSession)throw new Error('第 3 步未完成：输出路径已保留，但写入报告需要本机服务。请按顶部指引启动 start_local.py 并打开本机地址。');
  validatedOutput='';const target=$('outputPath').value.trim();if(!target)throw new Error('请先填写报告输出目录的绝对路径。');
  const result=await workspacePost('/local-output/validate',{path:target});if(!result.writable)throw new Error('输出目录不可写。');
  workspacePreferences.outputPath=result.path;$('outputPath').value=result.path;saveWorkspacePreferences();validatedOutput=result.path;renderWorkflow();return result.path;
}
async function saveCurrentReport(batch=currentBatch(),automatic=false) {
  if(offlineSnapshot())return;
  if(reportSaving)return;
  if(!automatic&&inputBusy())throw new Error('请等待当前任务结束后再保存报告。');
  if(!batch)throw new Error('当前没有可保存的批次。');
  if(!workspaceSession)throw new Error('保存到本机目录需要从 start_local.py 打开。');
  reportSaving=true;renderBatchHeader();
  try{const outputPath=await validateOutputPath();const archive=PB.exportArchive({schemaVersion:1,config:{...batch.config,apiKey:''},papers:batch.papers,batches:[batch],currentBatchId:batch.id});const sourceRefs=Object.fromEntries(batch.papers.filter(p=>workspacePreferences.sourceRefs[p.id]).map(p=>[p.id,workspacePreferences.sourceRefs[p.id]]));const saved=await workspacePost('/local-reports/save',{outputPath,archive,sourceRefs});if(typeof saved.path!=='string'||!saved.path.startsWith('/')||typeof saved.indexPath!=='string'||!saved.indexPath.startsWith('/')||typeof saved.indexUrl!=='string')throw new Error('报告保存响应缺少真实绝对路径或入口。');const indexURL=new URL(saved.indexUrl,workspaceSession.origin);if(indexURL.origin!==new URL(workspaceSession.origin).origin)throw new Error('报告链接不属于当前本机服务。');lastSavedReport={batchId:batch.id,path:saved.path,indexPath:saved.indexPath,indexUrl:indexURL.toString()};$('outputStatus').innerHTML=`报告已完整保存到 <code>${esc(saved.path)}</code><br>入口：<code>${esc(saved.indexPath)}</code><br><a href="${esc(indexURL.toString())}" target="_blank" rel="noopener">打开已保存的离线报告</a>`;notify(batch.status==='paused'?`当前进度报告已保存，可离线翻阅。批次仍已暂停：${batchPauseReason(batch)}`:batchHasIssues(batch)?'当前结果报告已保存，可离线翻阅；批次已结束，有待处理结果。':'报告已保存，可离线翻阅。',batch.status==='paused'||batchHasIssues(batch));return saved;}
  catch(error){$('outputStatus').textContent='评分结果仍保留。报告保存失败：'+error.message+'。修正路径后点击“保存当前批报告”重试，无需重跑评分。';notify($('outputStatus').textContent,true);return null;}
  finally{reportSaving=false;renderBatchHeader();}
}

const currentBatch = () => state.batches.find(b => b.id === state.currentBatchId);
const paperName = p => `${p.title}${p.version ? ' · ' + p.version : ''}`;
const statusName = s => ({pending:'待运行',running:'调用中',success:'响应已解析',partial:'部分结果',error:'失败',paused:'已暂停',complete:'已完成',ready:'就绪'}[s] || s);
const hasParsedResult = run => ['success','partial'].includes(run?.status) && !!run.result;
function scoredDimensions(run) {
  if(!hasParsedResult(run))return 0;
  return PB.DIMS.filter(d=>{const score=run.result.dimensions?.find(x=>x.id===d.id)?.score;return typeof score==='number'&&Number.isFinite(score);}).length;
}
function batchProgress(batch) {
  const counts={total:batch?batch.papers.length*batch.config.repeats:0,complete:0,partial:0,parsed:0,failed:0,inflight:0,pending:0};
  for(const run of batch?.runs||[]){if(hasParsedResult(run)){counts.parsed++;counts[scoredDimensions(run)===PB.DIMS.length?'complete':'partial']++;}else if(run.status==='error')counts.failed++;else if(run.status==='running')counts.inflight++;else counts.pending++;}
  return counts;
}
function batchHasIssues(batch) {const c=batchProgress(batch);return batch?.completionState==='with_issues'||c.partial>0||c.failed>0;}
function batchCompletionLabel(batch) {return batchHasIssues(batch)?'已结束 · 有待处理结果':'已完成';}
function batchPauseReason(batch) {
  if(batch?.pauseReason)return String(batch.pauseReason);
  const failed=[...(batch?.runs||[])].reverse().find(r=>r.status==='error'&&r.error);
  if(failed)return failed.error;
  if(batchProgress(batch).partial)return '已有响应解析成功，但部分维度未达到可计分条件，请查看评审理由与记录。';
  return '本批次处于暂停状态，已有记录保留。';
}
function runStatusName(run) {
  if(!hasParsedResult(run))return statusName(run?.status);
  const n=scoredDimensions(run);return n===PB.DIMS.length?'五维完整':`部分结果 · 可计分 ${n}/${PB.DIMS.length} 维`;
}
function executionEventsHTML(batch) {
  const events=Array.isArray(batch?.executionEvents)?batch.executionEvents:[];
  if(!events.length)return '';
  return `<details class="raw"><summary>执行与调度事件 · ${events.length} 条</summary><p class="hint">记录实际调度变更与全局事件；以下是执行审计，不改动本批冻结的模型参数和评分协议。</p>${events.map((event,i)=>`<details><summary>事件 ${i+1} · ${esc(event.type||event.event||'调度记录')}${event.at||event.timestamp?' · '+esc(time(event.at||event.timestamp)):''}</summary><pre>${esc(JSON.stringify(event,null,2))}</pre></details>`).join('')}</details>`;
}
function notify(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = false; }
function storageLabel(message, error = false) { $('storageStatus').textContent = message; $('storageStatus').style.color = error ? 'var(--bad)' : ''; }
function safeState() { const config = {...state.config}; delete config.apiKey; return {...state,config}; }
function openDB() { return new Promise((resolve,reject) => { const req = indexedDB.open('paperbench-v1',1); req.onupgradeneeded = () => req.result.createObjectStore('workspace'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); req.onblocked = () => reject(new Error('浏览器数据库被其他窗口占用')); }); }
function dbGet() { return new Promise((resolve,reject) => { const r = db.transaction('workspace','readonly').objectStore('workspace').get('state'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
function dbPut(data) { return new Promise((resolve,reject) => { const tx = db.transaction('workspace','readwrite'); tx.objectStore('workspace').put(data,'state'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('写入被中断')); }); }
function persist(immediate = false) {
  if(storageProtected){storageLabel('原有记录未能加载，已保护原存储。当前改动仅在内存；先导出未加载记录，再导入有效备份以恢复自动保存。',true);return;}
  clearTimeout(saveTimer);
  const work = () => { const snapshot = structuredClone(safeState()); saveChain = saveChain.catch(() => {}).then(async () => {
    try { if (db) await dbPut(snapshot); else localStorage.setItem('paperbench-state-v1',JSON.stringify(snapshot)); storageLabel(`已保存到本机 ${db ? 'IndexedDB' : 'localStorage'} · ${time(new Date().toISOString())} · 建议定期导出 JSON 备份`); }
    catch (e) { storageLabel('自动保存失败：' + e.message + '。当前内存数据仍在，请立即导出 JSON，关闭页面会丢失未保存记录。',true); }
  }); };
  if (immediate) work(); else saveTimer = setTimeout(work,180);
}
function readConfig() {
  const c = {};
  for (const id of configIds) { const el = $(id); if (!el) { c[id] = state.config[id] ?? PB.DEFAULT_CONFIG[id]; continue; } c[id] = booleanIds.has(id) ? el.checked : id === 'seed' ? (el.value.trim() === '' ? null : Number(el.value)) : numericIds.has(id) ? Number(el.value) : el.value.trim(); }
  return PB.validateConfig(c);
}
function fillConfig() { for (const id of configIds) { const el = $(id); if (!el) continue; if (booleanIds.has(id)) el.checked = !!state.config[id]; else el.value = state.config[id] ?? PB.DEFAULT_CONFIG[id] ?? ''; } updateConfigSummary(); }
function updateConfigSummary() {
 const repeats=repeatPreview();
 $('configSummary').textContent=`${state.config.model||'未设模型'} · ${PB.TYPES[state.config.paperType]||state.config.paperType} · ${repeats===null?'轮数待校正':repeats+' 轮 / 篇'}${repeats!==state.config.repeats?'（未保存预览）':''}`;
 if($('credentialStatus'))$('credentialStatus').textContent=workspaceSession?(workspacePreferences.apiMode==='default'?(workspaceSession.credentialReady?'默认GLM凭据由本机服务保管；网页Key在默认模式不生效，切换自定义模式才会使用。评分快照保留真实接口地址。':'本机文件与报告工具可用；默认GLM凭据未就绪，可配置自定义API。'):'自定义API仅使用你显式填写的Key，不借用默认GLM密钥。'):'可填写真实API地址、模型与Key；本机文件工具需启动本机服务。';
 updateWorkspaceControls();
}
async function connectLocalProfile(force=false) {
 if(offlineSnapshot())return false;
 const loc=globalThis.location;
 if(!loc||!['http:','https:'].includes(loc.protocol)||!['127.0.0.1','localhost','[::1]'].includes(loc.hostname)){if(force)notify('请运行 start_local.py 并打开它显示的本机地址。',true);return false;}
 try{const origin=loc.origin||new URL(loc.href).origin;const response=await fetch(new URL('/local-config',origin).toString(),{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('本机配置服务未就绪');const profile=await response.json();const endpoint=new URL('/v1/chat/completions',origin).toString();if(profile.endpoint!==endpoint||!/^([a-f0-9]{64})$/.test(profile.token||''))throw new Error('本机服务地址或会话无效');
   workspaceSession={origin,endpoint,token:profile.token,credentialReady:!!profile.credentialReady,workspace:profile.workspace||{enabled:false}};localProfileEndpoint=endpoint;preparedRoute=null;
   if(!workspacePreferences.inputPaths)workspacePreferences.inputPaths=profile.workspace?.defaultInputPath||'';if(!workspacePreferences.outputPath)workspacePreferences.outputPath=profile.workspace?.defaultOutputPath||'';
   if(force){workspacePreferences.apiMode='default';state.config={...PB.DEFAULT_CONFIG,apiKey:''};$('rememberKey').checked=false;localStorage.removeItem('paperbench-key-v1');}
   else if(state.config.endpoint===endpoint)state.config={...state.config,endpoint:profile.upstream||PB.DEFAULT_CONFIG.endpoint};
   fillConfig();fillWorkspaceControls();saveWorkspacePreferences();if(force){saveConfig(false);notify('已接入本机默认GLM及文件工具；归档保留真实API地址。');}return true;
 }catch(error){workspaceSession=null;updateConfigSummary();if(force)notify(error.message,true);return false;}
}
function saveConfig(showNotice = true) {
  const c = readConfig(); if(c.endpoint!==PB.validateConfig({...PB.DEFAULT_CONFIG,apiKey:''}).endpoint){workspacePreferences.apiMode='custom';if($('apiMode'))$('apiMode').value='custom';} state.config = c; let persisted = true;
  try { const saved = {...c}; delete saved.apiKey; localStorage.setItem('paperbench-config-v1',JSON.stringify(saved)); localStorage.removeItem('paperbench-key-v1');$('rememberKey').checked=false; }
  catch(e) { persisted = false; notify('配置仅在当前页面保存：' + e.message,true); }
  confirmedConfig=configSignature();saveWorkspacePreferences(); updateConfigSummary(); persist(); if (showNotice && persisted) notify('配置已保存。新批次会冻结此协议；历史批次不受修改影响。'); return c;
}
function restoreGLMDefaults() {
  if (running || creating) return;
  const apiKey = $('apiKey').value;
  workspacePreferences.apiMode='default';saveWorkspacePreferences();
  state.config = { ...PB.DEFAULT_CONFIG, apiKey };
  if($('apiMode'))$('apiMode').value='default';
  fillConfig();
  saveConfig(false); renderAll();
  notify('已恢复 GLM 真实默认接口与深评参数；当前输入 Key 保留，但本机默认模式仍用服务端凭据，网页 Key 仅在自定义模式生效。仅用于随后新建的批次；历史批次的协议与分数保持原样。');
}
function renderPapers() {
  $('paperCount').textContent = state.papers.length;
  $('paperList').innerHTML = state.papers.length ? state.papers.map((p,i) => `<button class="paper-item ${editingId === p.id ? 'active' : ''}" data-paper="${esc(p.id)}"><span class="number">${String(i+1).padStart(2,'0')}</span><span><strong>${esc(p.title)}</strong><small class="${p.text.trim() ? '' : 'pending'}">${esc(p.version || '未标版本')} · ${p.kind === 'reference' ? '对标' : '待评'} · ${mineruPDF(p)?(pdfDescriptor(p)?'PDF原件就绪 · 新批次先由 GPU / MinerU 转换':'⚠ PDF原件未就绪'):directPDF(p)?(p.text.trim()?'PDF原件就绪 · '+p.text.length.toLocaleString()+' 字符用于引文索引与核验':'PDF原件就绪 · ⚠ 引文定位索引为空 · 不可开始评分'):p.text.trim() ? p.text.length.toLocaleString() + ' 字符' : '⚠ 正文为空 · 不可开始评分'}</small>${sourceDescription(p)?`<small>${esc(sourceDescription(p))}</small>`:''}</span></button>`).join('') : '<p class="hint">还没有论文。上传文本文件，或在下方粘贴全文。</p>';
}
function fillPaper(id = null) {
  editingId = id; const p = state.papers.find(x => x.id === id) || {};
  $('paperTitle').value = p.title || ''; $('paperVersion').value = p.version || ''; $('paperGroup').value = p.group || ''; $('paperKind').value = p.kind || 'draft'; $('paperChange').value = p.change || 'other'; $('paperText').value = p.text || ''; $('deletePaper').disabled = !id || running; dirtyPaper = false; updateTextHint(); if(p.id&&workspacePreferences.sourceMetadata[p.id])$('inputWarning').textContent=sourceDescription(p)+'。'+(workspacePreferences.sourceMetadata[p.id].warnings||[]).join('；'); renderPapers();
}
function updateTextHint() { const t = $('paperText').value; $('charCount').textContent = `${t.length.toLocaleString()} 字符`; $('inputWarning').textContent = t && t.length < 1500 ? '文本较短：请确认这是完整论文，摘要级输入不足以支持完整评分。' : '请检查公式、实验表格、图注和结论是否完整。元数据不发送给模型。'; }
function savePaperForm() {
  if ($('paperText').value.length > 2000000) throw new Error('论文正文超过200万字符，请整理后再保存。');
  const title = $('paperTitle').value.trim(); if (!title) throw new Error('请填写论文标题。');
  const p = {id:editingId || uid(), title, version:$('paperVersion').value.trim(),group:$('paperGroup').value.trim(),kind:$('paperKind').value,change:$('paperChange').value,text:$('paperText').value};
  const i = state.papers.findIndex(x => x.id === p.id); if(i>=0&&workspacePreferences.sourceMetadata[p.id]&&state.papers[i].text!==p.text){workspacePreferences.sourceMetadata[p.id].textWasEdited=true;saveWorkspacePreferences();} if (i < 0) { if (state.papers.length >= 30) throw new Error('一个论文库最多 30 篇，请导出并移除旧条目。'); state.papers.push(p); } else state.papers[i] = p;
  editingId = p.id; dirtyPaper = false; renderPapers(); $('deletePaper').disabled = false; persist(); return p;
}
function changeBatch(id) {
  state.currentBatchId = id; pendingRemoval=null; const b = currentBatch(); baselineId = b?.papers[0]?.id || ''; radarIds = new Set((b?.papers || []).slice(0,Math.min(4,b?.papers?.length || 0)).map(p => p.id)); auditPaperId = baselineId; overviewPaperId = baselineId; overviewRound = 1; reasonTarget = b?.papers[1]?.id || baselineId; reasonRound = 1; renderAll(); persist();
}
function renderBatchHeader() {
  const busy=inputBusy(), preview=repeatPreview();
  const b = currentBatch(); $('batchSelect').innerHTML = '<option value="">新建批次</option>' + [...state.batches].reverse().map(x => `<option value="${esc(x.id)}">${x.demo ? '[模拟] ' : ''}${esc(x.name)} · ${esc(time(x.createdAt))}</option>`).join(''); $('batchSelect').value = state.currentBatchId;
  const counts=batchProgress(b), legacy=b&&!b.demo&&b.protocol.citationMode!=='source_ids_v1';
  $('batchBadge').textContent = mineruPreparation&&creating&&!running?'MinerU · 准备评分材料':b ? (b.demo ? '模拟演示 · 非真实评审' : b.draining?'已停止新请求 · 等待在途结果':b.status==='complete'?batchCompletionLabel(b):b.status==='paused'&&counts.inflight?'正在暂停':statusName(b.status)) : '尚未评分'; $('batchBadge').className = 'pill' + (b?.demo ? ' demo' : '');
  $('progressBar').style.width = `${counts.total ? (counts.complete+counts.partial+counts.failed)/counts.total*100 : 0}%`;
  $('progressText').textContent = b ? `五维完整 ${counts.complete} / ${counts.total} 次 · 已解析但不完整 ${counts.partial} 次 · 失败 ${counts.failed} 次 · ${counts.inflight} 次调用中 · 待运行 ${counts.pending} 次` : `当前论文库 ${state.papers.length} 篇；${preview===null?'请先填写有效复评轮数，预计调用数待定。':`将完整发送到所配接口，计划 ${state.papers.length * preview} 次评分（${preview} 轮 / 篇，不含重试）。`}`;
  if($('batchStatusDetail')){
    let message='',tone='';
    if(b?.draining){message=`已停止新请求 · 等待在途结果：${batchPauseReason(b)}\n当前 ${counts.inflight} 次请求仍在运行，返回结果会保留；等待结束后才进入暂停状态。`;tone='paused';}
    else if(b?.status==='paused'){message=`${counts.inflight?'正在暂停':'已暂停'}：${batchPauseReason(b)}\n${counts.inflight?`等待 ${counts.inflight} 次已发出请求返回；不再启动后续请求，返回结果仍会保留。`:'当前没有请求在运行，继续等待不会推进。请查看“评审理由与记录”中的具体原因。'}`;tone='paused';}
    else if(b&&running&&b.status!=='complete'){message=counts.inflight?`正在请求模型：${counts.inflight} 次调用中。结果返回后自动更新；请保持页面打开。`:'正在安排后续请求，页面会自动更新。';}
    else if(b?.status==='complete'){message=`${batchCompletionLabel(b)}：${counts.complete}/${counts.total} 次五维完整，${counts.partial} 次部分结果，${counts.failed} 次失败。${batchHasIssues(b)?'本批队列已运行结束，并非暂停。合法检查项与维度结果已保留；请展开评审记录查看待处理项。':'本批计划评分已全部返回五维结果。'}报告保存状态见第3步。`;tone=batchHasIssues(b)?'issues':'';}
    else if(b)message='当前没有请求在运行。检查配置和历史记录后，可开始新批次。';
    if(legacy){message+=(message?'\n':'')+'此批次使用旧评审协议，只读保留原结果；请开始新批次使用 v2.4 引文定位协议，不能继续消耗旧协议的调用。';tone='paused';}
    $('batchStatusDetail').hidden=!message;$('batchStatusDetail').textContent=message;$('batchStatusDetail').className='batch-status-detail'+(tone?' '+tone:'');
  }
  $('batchMeta').innerHTML = b ? `批次快照 · ${esc(b.config.model)} · ${esc(PB.TYPES[b.config.paperType] || b.config.paperType)} · ${b.config.repeats} 轮 · 协议 <code>${esc(b.protocol.id?.slice(0,16))}</code> · ${esc(time(b.createdAt))}<br>${b.protocol.reviewSchemaVersion===2?'v2 深评 · 四项检查、本地计分 · 尚需真实复测验证稳定性':'历史协议 · 依原量表保留结果，不补造新检查项'}${b.demo ? '<br><b>以下分数由本地合成，仅用于演示操作，不证明模型评分有效。</b>' : ''}` : '修改论文或参数后，请开始新批次。已有结果保留在历史批次中。';
  if($('executionAudit'))$('executionAudit').innerHTML=executionEventsHTML(b);
  if(b?.papers.some(p=>p.preparation?.method==='mineru'))$('batchMeta').innerHTML+='<details><summary>本批输入：原始 PDF → MinerU Markdown → 文本评审</summary><p>评分使用已冻结的 Markdown。图片链接仅作为文本发送，模型未读取链接对应图片；这不是视觉直读。引用按 Markdown 字符位置核验，索引页号不代表原PDF页码。原始 PDF、Markdown 和转换资源随报告保留供离线核验。</p>'+b.papers.filter(p=>p.preparation?.method==='mineru').map(p=>`<p>${esc(p.title)}<br><code>${esc(p.preparation.markdownPath)}</code></p>`).join('')+'</details>';
  $('runBtn').disabled = busy || !ready; $('pauseBtn').hidden = !running; $('resumeBtn').hidden = !b || b.demo || legacy || running || (PB.REVIEW_SCHEMA_VERSION===2 && b.protocol.reviewSchemaVersion!==2) || !b.runs.some(r => r.status !== 'success'); $('batchSelect').disabled = busy; $('batchName').disabled=busy;
  $('resumeBtn').disabled=busy||!ready;
  if($('recoverLocalBtn')){$('recoverLocalBtn').hidden=!b||b.demo||legacy||!b.runs.some(r=>r.status==='error'||(hasParsedResult(r)&&scoredDimensions(r)<PB.DIMS.length));$('recoverLocalBtn').disabled=busy||!ready||offlineSnapshot();}
  for (const el of document.querySelectorAll('.library input,.library select,.library textarea,.library button,.settings input,.settings select,.settings textarea,.settings button')) el.disabled = busy || !ready;
  if($('mineruProgress')){$('mineruProgress').hidden=!mineruPreparation;$('mineruProgressText').textContent=mineruStatusText();$('cancelMineruBtn').hidden=!creating||!mineruPreparation||['complete','failed','cancelled'].includes(mineruPreparation.status);$('cancelMineruBtn').disabled=!creating||!mineruPreparation||!!mineruPreparation.cancelRequested;}
  $('deletePaper').disabled = busy || !editingId; $('demoBtn').disabled = busy || !ready; $('importBtn').disabled = busy || !ready; updateWorkspaceControls();
}
function empty() { return '<div class="card empty"><div class="empty-mark" aria-hidden="true">◎</div><h2>从一轮可复核的评审开始</h2><p>添加论文、配置模型后开始评分。你会看到五维得分、评分波动、具体证据，以及每个版本相对基准的变化。</p><button data-action="demo">先看模拟演示</button><p class="hint">演示不联网，也不调用模型。</p></div>'; }
function summaries(b) { return b.papers.map(p => ({p,s:PB.summarize(b,p.id)})); }
function completeComparisonSet(b, data = summaries(b)) {
  const planned = b.papers.length * b.config.repeats;
  return b.config.repeats>=3 && planned > 0 && b.runs.length === planned && b.runs.every(r => r.status === 'success') && data.every(x => x.s.completeRuns === b.config.repeats);
}
function orderedSummaries(b) {
  const data = summaries(b), ranked = completeComparisonSet(b, data);
  return { data: ranked ? [...data].sort((a,c) => (c.s.total ?? -Infinity) - (a.s.total ?? -Infinity) || String(a.p.id).localeCompare(String(c.p.id))) : data, ranked };
}
function descriptiveRank(data, total) { return 1 + data.filter(x => x.s.total > total + 1e-9).length; }
function usage(b) { let total = 0, known = 0, attempts = 0; for (const r of b.runs) for (const a of r.attempts || []) { attempts++; if (typeof a.usage?.total_tokens === 'number') { total += a.usage.total_tokens; known++; } } return {total,known,attempts}; }
function radarSVG(b,ids) {
  const entries = summaries(b).filter(x => ids.has(x.p.id));
  const cx=250,cy=215,r=146; const pt=(i,score)=>{const a=-Math.PI/2+i*Math.PI*2/5; return [cx+Math.cos(a)*r*score/10,cy+Math.sin(a)*r*score/10];};
  const poly=score=>PB.DIMS.map((_,i)=>pt(i,score).join(',')).join(' ');
  return `<svg class="radar" viewBox="0 0 500 425" role="img" aria-label="五维评分雷达图，中心为零，外环为十分；精确数据见得分表"><title>五维评分雷达图</title>${[2,4,6,8,10].map(s=>`<polygon points="${poly(s)}" fill="${s===10?'#f8fafc':'none'}" stroke="#d9e3ec" stroke-width="1"/>`).reverse().join('')}${PB.DIMS.map((d,i)=>{const [x,y]=pt(i,10),[lx,ly]=pt(i,12.4);return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#d9e3ec"/><text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle">${esc(d.short || d.name)}</text>`;}).join('')}${[2,4,6,8,10].map(s=>`<text class="tick" x="258" y="${cy-r*s/10+4}">${s}</text>`).join('')}${entries.map(({p,s})=>{const values=PB.DIMS.map(d=>s.dimensions[d.id]?.median);if(values.some(x=>typeof x!=='number'))return '';const c=colors[entries.findIndex(x=>x.p.id===p.id)%colors.length];return `<polygon points="${values.map((v,i)=>pt(i,v).join(',')).join(' ')}" fill="${c}" fill-opacity="0.07" stroke="${c}" stroke-width="2.3"> <title>${esc(paperName(p))}</title></polygon>${values.map((v,i)=>{const [x,y]=pt(i,v);return `<circle cx="${x}" cy="${y}" r="3" fill="${c}"><title>${esc(paperName(p))} · ${esc(PB.DIMS[i].name)} ${num(v)}</title></circle>`;}).join('')}`;}).join('')}</svg>`;
}
function renderOverview() {
  const b=currentBatch(); if(!b){$('overview').innerHTML=empty();return;}
  const data=summaries(b), u=usage(b), counts=batchProgress(b);
  const sds=data.flatMap(({s})=>PB.DIMS.map(d=>s.dimensions[d.id]?.sd)).filter(x=>typeof x==='number');
  const {data:sorted,ranked}=orderedSummaries(b);
  $('overview').innerHTML=`<div class="stats-strip"><div class="stat"><span>参与论文</span><strong>${b.papers.length}</strong><em>篇</em></div><div class="stat"><span>五维完整评分</span><strong>${counts.complete}</strong><em>/ ${counts.total}</em><small>已解析 ${counts.parsed} 次 · 其中 ${counts.partial} 次不完整</small></div><div class="stat"><span>最大单维标准差</span><strong>${sds.length?num(Math.max(...sds)):'—'}</strong><em>分</em></div><div class="stat"><span>已报告 token · 所有尝试</span><strong>${u.known?u.total.toLocaleString():'—'}</strong><em>${u.known}/${u.attempts} 次有用量记录</em></div></div>
  ${overviewReviewHTML(b)}
  <div class="card"><div class="section-head"><div><h2>五维评分总表</h2><p class="hint">五维分为逐维中位数；总分为每轮五维均分的中位数，满分 10。全批全部计划轮次的五维完整后才给出描述性名次；同分同名次，分差不代表统计显著。</p></div><button data-action="summaryCSV">导出总表</button></div><div class="table-wrap"><table><thead><tr><th>排序 / 论文</th>${PB.DIMS.map(d=>`<th class="numeric">${esc(d.short||d.name)}</th>`).join('')}<th class="numeric">总分 / 10</th><th>完整轮数</th></tr></thead><tbody>${sorted.map(({p,s},i)=>{const complete=s.completeRuns===b.config.repeats;return `<tr><td class="paper-cell"><span class="rank">${ranked?String(descriptiveRank(data,s.total)).padStart(2,'0'):(b.config.repeats<3?'仅链路检查':'待全批完成')}</span> <b>${esc(p.title)}</b><small>${esc(p.version||'未标版本')} · ${p.kind==='reference'?'对标文献':'待评版本'}${p.group?' · '+esc(p.group):''}</small></td>${PB.DIMS.map(d=>{const z=s.dimensions[d.id];return `<td class="numeric">${num(z?.median)}<small>SD ${num(z?.sd)} · MAD ${num(z?.mad)} · n=${z?.n||0}</small></td>`;}).join('')}<td class="numeric score">${num(s.total)}${!complete?'<small>暂估</small>':''}<small>总分 n=${s.completeRuns}</small></td><td>${s.completeRuns}/${b.config.repeats}<small>${s.successRuns} 次已解析</small></td></tr>`;}).join('')}</tbody></table></div><p class="hint">分差小于波动幅度时，请结合版本对比区间和原文理由。缺少有效引文的维度记为“不可评”，不以零分填补。</p></div>
  <div class="card"><h2>五维轮廓</h2><div class="radar-layout">${radarSVG(b,radarIds)}<div class="legend">${b.papers.map((p,i)=>`<label><input type="checkbox" data-radar="${esc(p.id)}" ${radarIds.has(p.id)?'checked':''}><span class="dot" style="background:${radarIds.has(p.id)?colors[data.filter(x=>radarIds.has(x.p.id)).findIndex(x=>x.p.id===p.id)%colors.length]:'#becbd7'}"></span><span>${esc(paperName(p))}</span><small>${num(PB.summarize(b,p.id).total)}</small></label>`).join('')}<p class="hint">最多叠加 6 篇。缺失任一维度的论文暂不绘制；面积不参与计分。</p></div></div></div>
  ${discriminationHTML(b,data)}
  ${criteriaStabilityHTML(b,data)}
  <div class="card"><h2>同一论文的评分波动</h2><p class="hint">每格依次为 MAD / 极差，SD 见上表。MAD 为距中位数的绝对偏差中位数。零波动也可能来自模型确定性或量表分辨率，不能据此证明评分准确。</p><div class="table-wrap"><table><thead><tr><th>论文</th>${PB.DIMS.map(d=>`<th>${esc(d.short||d.name)}</th>`).join('')}</tr></thead><tbody>${data.map(({p,s})=>`<tr><td class="paper-cell">${esc(paperName(p))}</td>${PB.DIMS.map(d=>{const x=s.dimensions[d.id];return `<td>${num(x?.mad)} / ${x?.n?num(x.max-x.min):'—'}<small>${num(x?.min)}–${num(x?.max)}</small></td>`;}).join('')}</tr>`).join('')}</tbody></table></div></div>`;
}
function options(papers,selected) {return papers.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(paperName(p))}</option>`).join('');}
function evidenceRefsHTML(refs, result, prefix) {
  if (!Array.isArray(refs) || !refs.length) return '<span class="hint">未列出可定位引文；请结合说明判断此处是否可核查。</span>';
  return refs.map(ref => {
    const d = result.dimensions.find(x => x.id === ref.dimensionId), q = d?.evidence?.[ref.evidenceIndex];
    return `<a href="#${esc(`${prefix}-${ref.dimensionId}-${ref.evidenceIndex}`)}">${esc(PB.DIMS.find(x => x.id === ref.dimensionId)?.short || ref.dimensionId)}引文 ${Number(ref.evidenceIndex) + 1}</a> <span class="hint">${q?.matched === true ? '文字已匹配' : '文字未核验'}</span>`;
  }).join(' · ');
}
function analysisEvidenceHTML(section,result,prefix,suffix='') {
  const sources=Array.isArray(section?.sourceEvidence)?section.sourceEvidence:[];
  if(sources.length)return `<details class="raw source-paragraphs"><summary>原文定位 ${sources.length} 段 · ${sources.map(e=>esc(e.sourceId)).join('、')}</summary>${sources.map(e=>`<blockquote class="quote" id="${esc(prefix+suffix+'-'+e.sourceId)}"><b>${esc(e.sourceId)}</b> · ${esc(e.quote)}<span class="source">${esc(e.location||`物理页 ${e.sourcePage} · 字符 ${e.sourceStart}–${e.sourceEnd}`)} · ${e.matched===true?'引用已定位（不代表论断已证实）':'原文未核验'}</span></blockquote>`).join('')}</details>`;
  return `<p>${evidenceRefsHTML(section?.evidenceRefs,result,prefix)}</p>`;
}
function citationRepairText(repair,result) {
  const dimension=PB.DIMS.find(d=>d.id===repair.dimensionId),item=PB.CRITERIA?.[repair.dimensionId]?.find(c=>c.id===repair.itemId),source=result.dimensions?.find(d=>d.id===repair.dimensionId)?.evidence?.find(e=>e.sourceId===repair.sourceId);
  return `${dimension?.name||repair.dimensionId} / ${item?.name||repair.itemId}：原始索引 ${JSON.stringify(repair.originalEvidenceIndices)}（零基） → ${repair.sourceId}${source?'；'+(source.location||`物理页 ${source.sourcePage} · 字符 ${source.sourceStart}–${source.sourceEnd}`):''}。按分档依据明确写出的原文编号恢复引用，等级保持原值。`;
}
function recoveryAuditHTML(run,result) {
  const recovered=run.localRecovery,repairs=Array.isArray(result.citationRepairs)?result.citationRepairs:[];
  if(!recovered&&!repairs.length)return '';
  return `<section class="callout"><h3>${recovered?scoredDimensions(run)===PB.DIMS.length?'本地恢复成功 · 未新增模型请求':'本地恢复部分结果 · 未新增模型请求':'原文编号恢复引用'}</h3>${recovered?`<p>使用已保存的响应重新解析，当前可计分 ${scoredDimensions(run)}/${PB.DIMS.length} 维。原始调用、失败原因和 token 用量保持原样。</p><p class="hint">${esc(time(recovered.recoveredAt))} · ${esc(recovered.parserVersion)} · 原调用 ${esc(recovered.sourceAttemptId)}</p><details class="raw"><summary>查看原始失败及本地恢复审计</summary><p>${esc(recovered.originalError)}</p><pre>${esc(JSON.stringify(recovered,null,2))}</pre></details>`:''}${repairs.length?`<h4>原文编号恢复引用 · ${repairs.length} 项</h4><ul>${repairs.map(repair=>`<li>${esc(citationRepairText(repair,result))}</li>`).join('')}</ul><p class="hint">此处仅恢复已在依据中明确给出的引用关系，没有重新调用模型，也没有增加评分依据或改动模型等级。</p>`:''}</section>`;
}
function validationHTML(result) {
  const issues=Array.isArray(result.validation?.issues)?result.validation.issues:[],errors=issues.filter(x=>x.severity==='error'),warnings=issues.filter(x=>x.severity!=='error');
  const formats=Array.isArray(result.formatWarnings)?result.formatWarnings:[];
  if(!issues.length&&!formats.length&&!result.normalization)return '';
  const list=(rows,label)=>rows.length?`<h4>${label} · ${rows.length} 项</h4><ul>${rows.map(x=>`<li><b>${esc(x.path||'响应')}</b>：${esc(x.message)}${x.code?` <code>${esc(x.code)}</code>`:''}${Object.hasOwn(x,'original')?`<details><summary>查看该字段原值</summary><pre>${esc(JSON.stringify(x.original,null,2))}</pre></details>`:''}</li>`).join('')}</ul>`:'';
  return `<section class="callout ${errors.length?'amber':''} validation-review"><h3>返回内容校验 · ${errors.length?'有待处理字段':'规范化与格式提示'}</h3><p>字段校验问题表示模型响应数据需要处理，不表示论文材料不可见或论文质量低。受影响的检查项不计分，其他合法检查项与维度结果保留。</p>${list(errors,'待处理错误')}${list(warnings,'规范化与附加信息警告')}${formats.length?`<h4>JSON 格式规范化</h4><p>${formats.map(esc).join('<br>')}</p>`:''}${result.normalization?`<details><summary>查看已执行的格式规范化记录</summary><pre>${esc(JSON.stringify(result.normalization,null,2))}</pre></details>`:''}${result.validation?.rawReview?`<details class="raw"><summary>查看校验前的原始模型对象</summary><p class="hint">未知项目、重复项和原始字段值仅供审计，不额外参与评分。</p><pre>${esc(JSON.stringify(result.validation.rawReview,null,2))}</pre></details>`:''}</section>`;
}
function claimVerdict(claim) {
  if(claim.reportedVerdict!=null)return '未识别判定（原值 '+claim.reportedVerdict+'）';
  return ({supported:'有可见支撑',partial:'支撑有限',unsupported:'可见证据不足',unassessable:'材料不足，无法判断'})[claim.verdict]||claim.verdict;
}
function analysisHTML(result, prefix) {
  const a = result.analysis; if (!a) return '';
  return `<section class="claim-audit"><h3>中心主张审计</h3><p class="hint">研究类型：${esc(PB.TYPES[a.researchType] || (a.researchType === 'mixed' ? '混合型' : a.researchType))}。${esc(a.typeRationale)}</p>${(a.centralClaims || []).map(c => `<article class="claim-item"><h4>${esc(c.id)} · ${esc(c.claim)}</h4><p><b>声明范围：</b>${esc(c.scope)}</p><p><b>可见支撑：</b>${esc(c.supportAssessment)}</p><p><b>反对证据或限制：</b>${esc(c.counterEvidence)}</p><p><b>替代解释：</b>${esc(c.alternativeExplanations)}</p><p><b>模型审查判断：</b>${esc(claimVerdict(c))}。</p>${analysisEvidenceHTML(c,result,prefix,'-claim-'+c.id)}</article>`).join('')}<div class="assessment-grid">${[['strongestSupport','最强支持论证'],['strongestChallenge','最强反对论证 / 限制']].map(([key,label]) => `<article class="reason-block"><h3>${label}</h3><p>${esc(a[key]?.text)}</p>${analysisEvidenceHTML(a[key],result,prefix,'-'+key)}</article>`).join('')}</div><p class="hint">审查边界：${esc(a.verificationLimits)}。引文匹配仅验证文字出现，主张是否得到逻辑支持仍需人工核查。</p></section>`;
}
function checklistHTML(d) {
  if (!Array.isArray(d.items)) return '';
  const valid = d.items.filter(x => typeof x.effectiveLevel === 'number').length;
  const caps = (d.capReasons || []).map(c => `${PB.CRITERIA?.[d.id]?.find(x => x.id === c.itemId)?.name || c.itemId}等级${c.level} → 上限${c.cap}`).join('；');
  return `<section class="checklist"><h4>四项检查与本地计分</h4><p class="hint">有效 ${valid}/4 项。等级 0–4 按固定行为锚点判断；字段错误、材料不可见和引文未核验分别记录，不填零、不按剩余项求均分。</p>${d.items.map(item => {
    const criterion = PB.CRITERIA?.[d.id]?.find(x => x.id === item.id);
    const anchor = typeof item.level === 'number' ? criterion?.anchors?.[item.level] : null;
    const invalid=item.status==='invalid',itemIssues=Array.isArray(item.validationIssues)?item.validationIssues:[];
    return `<article class="check-item"><div><h4>${esc(item.name || criterion?.name || item.id)}</h4>${invalid?`<p class="error-text">响应字段待处理，本项未计分${item.reportedLevel!=null?'；模型原报等级 '+esc(JSON.stringify(item.reportedLevel)):''}。这是返回数据问题，不代表论文证据不足。</p>${itemIssues.length?`<ul class="error-text">${itemIssues.map(x=>`<li>${esc(x.path||item.id)}：${esc(x.message||x)}</li>`).join('')}</ul>`: ''}`:item.effectiveLevel == null && typeof item.level === 'number' ? `<p class="error-text">模型原报等级 ${item.level}；所引文字核验未通过，本项不进入计分。</p>` : ''}<p><b>${invalid?'校验说明':'分档依据'}：</b>${esc(item.basis)}</p>${anchor ? `<p class="hint">该档锚点：${esc(anchor)}</p>` : ''}<p class="hint">引用本维第 ${(item.evidenceIndices || []).map(i => i + 1).join('、') || '—'} 条；已匹配 ${(item.matchedEvidenceIndices || []).map(i => i + 1).join('、') || '—'}。${item.status === 'unavailable' ? '模型标记材料不可见。' : ''}</p>${item.missing ? `<p><b>${invalid?'返回数据问题':'尚缺内容'}：</b>${esc(item.missing)}</p>` : ''}</div><span class="check-status ${item.effectiveLevel==null?'na':item.effectiveLevel>=3?'pass':item.effectiveLevel>=2?'partial':'fail'}">${invalid?'字段待处理':typeof item.effectiveLevel === 'number' ? `等级 ${item.effectiveLevel} / 4` : '不可评'}</span></article>`;
  }).join('')}<p class="score-calculation"><b>计分依据：</b>${valid === 4 ? `1 + 9 × 四项等级均值 ÷ 4 = ${num(d.rawScore, 4)}；固定上限 ${num(d.scoreCap)}；最终 min(原始分, 上限) = ${num(d.score, 4)}。` : '四项未全部可评，本维总分留空。'}${caps ? `<br>上限触发：${esc(caps)}。` : ''}</p></section>`;
}
function revisionPriority(revision) { return [1,2,3].includes(revision.priority)?`P${revision.priority}`:`未分级${revision.reportedPriority!=null?'（原值 '+revision.reportedPriority+'）':''}`; }
function revisionsHTML(result) {
  if (!Array.isArray(result.revisions) || !result.revisions.length) return '';
  return `<section class="review-priorities"><h3>按优先级修订与核查</h3>${result.metadataWarnings?.length?`<p class="callout amber">附加信息核验提示：${result.metadataWarnings.map(w=>esc(w.message)).join('；')}。原始值保留在归档中。</p>`:''}<ol>${[...result.revisions].sort((a,b) => (a.priority??Infinity) - (b.priority??Infinity)).map(r => `<li><p><b>${esc(revisionPriority(r))} · ${esc(r.action)}</b></p><p>${esc(r.rationale)}</p><p class="hint">${r.dimensionId?'对应'+esc(PB.DIMS.find(x => x.id === r.dimensionId)?.name || r.dimensionId):'未分配维度'}${r.claimIds?.length ? ' · 主张 ' + r.claimIds.map(esc).join('、') : ''}。优先级是模型建议，不保证修订后分数提升。</p></li>`).join('')}</ol></section>`;
}
function reasonHTML(run,paper,{dimId=null}={}) {
  if(!hasParsedResult(run)) return `<p class="hint">该轮暂无可展示的评审结果。${run?.error?esc(run.error):''}</p>`;
  const z = run.result, prefix = `${activeTab}-${run.id || `${paper.id}-${run.round}`}-quote`;
  return `<div class="review-depth"><p class="review-summary">${esc(z.summary)}</p>${z.schemaVersion === 2 ? '<p class="hint">v2 深评：模型逐项审查，程序依据固定等级与上限计算分数；未经过真实复测不能宣称稳定性或区分能力提升。</p>' : '<p class="hint">历史 v1 直接评分结果：按原协议保留分数和理由；未补造 v2 检查项，也不与新协议分数合并。</p>'}${z.warnings?.length?`<div class="callout amber">${z.warnings.map(esc).join('<br>')}</div>`:''}${validationHTML(z)}${recoveryAuditHTML(run,z)}${analysisHTML(z,prefix)}${z.dimensions.filter(d=>!dimId||d.id===dimId).map(d=>`<section class="reason"><strong><span>${esc(PB.DIMS.find(x=>x.id===d.id)?.name||d.id)}</span><span>${num(d.score)} / 10</span></strong>${d.reportedScore!=null&&d.score==null?`<p class="error-text">模型原报 ${num(d.reportedScore)}，因无可匹配引文记为不可评。</p>`:''}<p>${esc(d.reason)}</p>${checklistHTML(d)}<h4>本维原文证据</h4>${(d.evidence||[]).map((e,i)=>`<blockquote class="quote" id="${esc(`${prefix}-${d.id}-${i}`)}"><b>引文 ${i+1}</b> · ${esc(e.quote)}<span class="source">${esc(e.location)}${e.sourceId?' · '+esc(e.sourceId):''} · ${e.matched===false?'⚠ 原文未匹配':e.sourceId?'引用已定位（不代表论断已证实）':'原文已匹配（不代表论断已证实）'}</span></blockquote>`).join('')}<p class="recommendation">建议：${esc(d.improvement)}</p></section>`).join('')}${revisionsHTML(z)}<p class="hint">评审局限：${esc(z.limitations)}</p></div>`;
}
function overviewReviewHTML(b) {
  if (!b.papers.some(p => p.id === overviewPaperId)) overviewPaperId = b.papers[0]?.id || '';
  const paper = b.papers.find(p => p.id === overviewPaperId);
  const run = b.runs.find(r => r.paperId === overviewPaperId && r.round === overviewRound);
  return `<section class="card review-first"><div class="section-head"><div><h2>先读主张与论证</h2><p class="hint">查看固定论文与轮次的完整理由；默认第 1 轮，不自动挑选分数最高或最有利的一轮。</p></div></div><div class="toolbar"><label>论文<select id="overviewPaper">${options(b.papers,overviewPaperId)}</select></label><label class="narrow">轮次<select id="overviewRound">${Array.from({length:b.config.repeats},(_,i)=>`<option value="${i+1}" ${i+1===overviewRound?'selected':''}>第 ${i+1} 轮</option>`).join('')}</select></label></div>${run?.result ? `<p class="review-summary">${esc(run.result.summary)}</p>${run.result.analysis?`<div class="assessment-grid"><article class="reason-block"><h3>最强支持论证</h3><p>${esc(run.result.analysis.strongestSupport?.text)}</p></article><article class="reason-block"><h3>最强反对论证 / 限制</h3><p>${esc(run.result.analysis.strongestChallenge?.text)}</p></article></div>`:''}<details class="deep-review-details"><summary>展开本轮全部主张、支持与反对理由、检查项和修订优先级</summary>${reasonHTML(run,paper)}</details>` : reasonHTML(run,paper)}</section>`;
}
function discriminationHTML(b,data) {
  const full = data.filter(x => x.s.completeRuns === b.config.repeats);
  return `<section class="card"><h2>描述性区分度与重复波动</h2><p class="hint">只纳入全部五维与计划轮次完整的 ${full.length}/${b.papers.length} 篇。论文间中位分范围描述这组材料的分散程度；典型 SD 为各篇样本标准差的中位数。两者对照不等于排序显著，也不能证明新协议更稳定。</p><div class="table-wrap"><table><thead><tr><th>维度</th><th>完整论文数</th><th>论文间中位分范围</th><th>典型 SD</th></tr></thead><tbody>${PB.DIMS.map(d=>{const medians=full.map(x=>x.s.dimensions[d.id].median),sds=full.map(x=>x.s.dimensions[d.id].sd).filter(Number.isFinite);return `<tr><td>${esc(d.name)}</td><td>${full.length}</td><td>${medians.length>1?num(Math.max(...medians)-Math.min(...medians)):'—'}</td><td>${num(PB.median(sds))}</td></tr>`;}).join('')}</tbody></table></div></section>`;
}

function criteriaStabilityHTML(b,data) {
  const entry=data.find(x=>x.p.id===overviewPaperId);
  if(!entry?.s.criteria)return '';
  return `<section class="card"><h2>检查项的跨轮等级波动</h2><p class="hint">当前论文：${esc(paperName(entry.p))}，与上方“先读主张与论证”选择一致。以下是 0–4 级检查项的重复分档；这些 SD/MAD 与五维 1–10 分的 SD/MAD 单位不同，不直接相除或比较。</p><details><summary>查看 20 个检查项的有效轮数、等级中位数与波动</summary><div class="table-wrap"><table class="checklist-table"><thead><tr><th>维度 / 检查项</th><th>等级中位数 / 4</th><th>SD</th><th>MAD</th><th>有效 n</th><th>材料不可见轮</th><th>引文未匹配轮</th></tr></thead><tbody>${PB.DIMS.map(d=>(PB.CRITERIA?.[d.id]||[]).map(item=>{const z=entry.s.criteria[d.id]?.[item.id];return `<tr><td>${esc(d.short)} · ${esc(item.name)}</td><td>${num(z?.median)}</td><td>${num(z?.sd)}</td><td>${num(z?.mad)}</td><td>${z?.n||0}</td><td>${z?.unavailableRuns||0}</td><td>${z?.unmatchedRuns||0}</td></tr>`;}).join('')).join('')}</tbody></table></div></details></section>`;
}
function renderCompare() {
  const b=currentBatch();if(!b){$('compare').innerHTML=empty();return;}
  if(!b.papers.some(p=>p.id===baselineId))baselineId=b.papers[0].id;
  const base=b.papers.find(p=>p.id===baselineId), targets=b.papers.filter(p=>p.id!==baselineId);
  if(!targets.some(p=>p.id===reasonTarget))reasonTarget=targets[0]?.id||'';
  const rows=PB.compare(b,baselineId,{threshold,alpha:.05}), k=targets.length*5;
  const changes={structure:'结构整理通常先反映在贡献清晰度、主张–证据一致性。压缩篇幅若删掉关键条件，也可能降低严谨性。',style:'语言风格通常先反映在贡献清晰度。仅改善措辞不应自动抬高方法或证据得分。',evidence:'方法 / 证据增强主要观察方法严谨性、证据充分性、对比公平性及主张–证据一致性。',other:'请将分差与真实修改内容逐项核对；维度变化只能作为修订线索。'};
  $('compare').innerHTML=`<div class="card"><div class="toolbar"><label>基准版本<select id="baselineSelect">${options(b.papers,baselineId)}</select></label><label class="narrow">实质差异阈值（分）<input id="effectThreshold" type="number" min="0" max="3" step="0.1" value="${threshold}"></label></div><h2>相对 ${esc(paperName(base))} 的变化</h2><div class="callout">Δ = 同轮“目标 − 基准”分差的中位数，与两个中位分数相减可能不同。区间为 95% 家族覆盖的保守中位数区间；Holm 校正涵盖本批全部 ${k} 个比较。阈值是实际意义标准，不是已测得的噪声底。</div><div class="callout amber">“显著”仅指固定模型与协议下的条件性信号，假设轮次近似独立。小样本、失败或不可评维度会限制判断；不能证明论文质量已客观提升。请预先确定轮数与阈值，不反复尝试直到显著。</div>${!targets.length?'<p class="hint">此批次只有一篇论文。添加其他版本后创建新批次即可对比。</p>':targets.map(p=>`<div class="comparison-title"><h3>${esc(paperName(p))}</h3><span class="pill">${p.kind==='reference'?'对标文献':esc(p.group||'待评版本')}</span></div><p class="hint">${esc(changes[p.change]||changes.other)}${p.group!==base.group?' 不同系列的比较用于领域定位，请检查任务、数据与论文类型是否可比。':''}</p><div class="table-wrap"><table><thead><tr>${PB.DIMS.map(d=>`<th>${esc(d.short||d.name)}</th>`).join('')}</tr></thead><tbody><tr>${PB.DIMS.map(d=>{const x=rows.find(z=>z.paperId===p.id&&z.dimId===d.id);if(!x)return '<td>—</td>';return `<td class="delta-cell"><span class="${x.delta>threshold?'delta-up':x.delta < -threshold?'delta-down':''}">${signed(x.delta)}</span><span class="ci">区间 [${num(x.ci?.[0])}, ${num(x.ci?.[1])}]</span><span class="label">${esc(x.label)}</span><span class="ci">n=${x.n} · pₕ=${x.pAdjusted>0&&x.pAdjusted<.0001?'&lt;0.0001':num(x.pAdjusted,4)}</span></td>`;}).join('')}</tr></tbody></table></div>`).join('')}</div>${targets.length?`<div class="card"><h2>把评审理由放在一起读</h2><div class="toolbar"><label>对比版本<select id="reasonTarget">${options(targets,reasonTarget)}</select></label><label class="narrow">轮次<select id="reasonRound">${Array.from({length:b.config.repeats},(_,i)=>`<option value="${i+1}" ${i+1===reasonRound?'selected':''}>第 ${i+1} 轮</option>`).join('')}</select></label><button data-action="copyComparison">复制本轮理由</button></div><div class="reason-grid"><article class="reason-block"><h3>基准 · ${esc(paperName(base))}</h3>${reasonHTML(b.runs.find(r=>r.paperId===baselineId&&r.round===reasonRound),base)}</article><article class="reason-block"><h3>目标 · ${esc(paperName(b.papers.find(p=>p.id===reasonTarget)))}</h3>${reasonHTML(b.runs.find(r=>r.paperId===reasonTarget&&r.round===reasonRound),b.papers.find(p=>p.id===reasonTarget))}</article></div></div>`:''}`;
}
function renderAudit() {
  const b=currentBatch();if(!b){$('audit').innerHTML=empty();return;} if(!b.papers.some(p=>p.id===auditPaperId))auditPaperId=b.papers[0].id;const p=b.papers.find(x=>x.id===auditPaperId);
  $('audit').innerHTML=`<div class="card"><div class="toolbar"><label>论文<select id="auditPaper">${options(b.papers,auditPaperId)}</select></label><button data-action="copyReasons">复制全部有效理由</button></div><p class="hint">每轮都保留。展开原始调用可检查请求、响应、解析错误、token 与服务端指纹。重试仅取首个有效结果。</p>${b.runs.filter(r=>r.paperId===auditPaperId).sort((a,c)=>a.round-c.round).map((r,i)=>`<details class="run-detail" ${i===0?'open':''}><summary><b>第 ${r.round} 轮 · ${esc(runStatusName(r))}</b><span class="muted">${r.attempts?.length||0} 次尝试</span></summary>${r.error||r.localRecovery?.originalError?`<p class="${r.localRecovery?'hint':'error-text'}">${r.localRecovery?'原始失败记录（已本地恢复）：':''}${esc(r.localRecovery?.originalError||r.error)}</p>`:''}${reasonHTML(r,p)}<details class="raw"><summary>查看本轮 ${r.attempts?.length||0} 次原始调用</summary>${(r.attempts||[]).map((a,j)=>`<h3>尝试 ${j+1} · ${esc(a.status||'')} · HTTP ${esc(a.httpStatus??'—')}</h3><p class="hint">${esc(time(a.startedAt||a.startAt))} · ${a.durationMs==null?'—':num(a.durationMs/1000,1)} 秒 · token ${esc(a.usage?.total_tokens??'未报告')} · 模型 ${esc(a.model||'未报告')} · 指纹 ${esc(a.systemFingerprint||'未报告')}</p>${a.error?`<p class="error-text">${esc(a.error)}</p>`:''}<details><summary>请求 JSON（不含鉴权）</summary><pre>${esc(JSON.stringify(a.request,null,2))}</pre></details><details><summary>原始响应</summary><pre>${esc(typeof a.responseBody==='string'?a.responseBody:JSON.stringify(a.responseBody,null,2))}</pre></details>`).join('')}</details></details>`).join('')}<details class="raw"><summary>查看此批次论文快照及 SHA-256</summary><p><code>${esc(p.hash||'—')}</code></p><pre>${esc(p.text)}</pre></details></div>`;
}
function renderHistory() {
  const b=currentBatch();if(!b){$('history').innerHTML=empty();return;}
  const other=state.batches.filter(x=>x.id!==b.id&&!!x.demo===!!b.demo); if(!other.some(x=>x.id===historyBatchId))historyBatchId=other.at(-1)?.id||'';const old=other.find(x=>x.id===historyBatchId);
  const sameProtocol=old&&old.protocol.id===b.protocol.id, matched=old?b.papers.map(p=>({p,previous:old.papers.find(x=>x.hash&&x.hash===p.hash)})).filter(x=>x.previous):[];
  $('history').innerHTML=`<div class="card"><div class="section-head"><h2>同一文本的跨批次复跑</h2><button data-action="removeBatch" class="danger" ${running?'disabled':''}>${pendingRemoval===b.id?'确认已保存，移除此批':'下载此批归档'}</button></div><p class="hint">按论文全文 SHA-256 匹配；只将相同协议、相同文本、同为真实或同为模拟的批次用于稳定性诊断。跨批次差值是漂移描述，不进行“版本改进”检验。</p><div class="toolbar"><label>对照历史批次<select id="historyBatch"><option value="">选择批次</option>${other.map(x=>`<option value="${esc(x.id)}" ${x.id===historyBatchId?'selected':''}>${esc(x.name)} · ${esc(time(x.createdAt))}</option>`).join('')}</select></label></div>${!old?'<div class="callout">将相同文本与相同配置重新评审一次，即可观察跨批次漂移。模拟数据不会与真实批次混合。</div>':!sameProtocol?'<div class="callout amber">两个批次协议不同，不能归因于评分随机波动。请使用相同模型、接口、量表和生成参数重新评审。</div>':!matched.length?'<div class="callout">没有全文哈希一致的论文，不能按同版本复跑进行比较。</div>':`<div class="table-wrap"><table><thead><tr><th>同一文本</th>${PB.DIMS.map(d=>`<th>${esc(d.short||d.name)}</th>`).join('')}<th>完整轮数</th></tr></thead><tbody>${matched.map(({p,previous})=>{const cur=PB.summarize(b,p.id),prev=PB.summarize(old,previous.id);return `<tr><td class="paper-cell">${esc(paperName(p))}<small><code>${esc(p.hash.slice(0,12))}</code></small></td>${PB.DIMS.map(d=>{const a=cur.dimensions[d.id]?.median,z=prev.dimensions[d.id]?.median;return `<td>${typeof a==='number'&&typeof z==='number'?signed(a-z):'—'}<small>${num(z)} → ${num(a)}</small></td>`;}).join('')}<td>${prev.completeRuns}/${old.config.repeats} → ${cur.completeRuns}/${b.config.repeats}</td></tr>`;}).join('')}</tbody></table></div><p class="hint">正值表示当前批次分数更高。若同文本反复出现超过实际阈值的移动，优先核查服务端模型/指纹、输入完整性及量表，而不是把漂移当改进。</p>`}</div><div class="card"><h2>批次与服务端记录</h2><div class="table-wrap"><table><thead><tr><th>批次</th><th>模型 / 指纹</th><th>完整文本</th><th>成功 / 计划</th></tr></thead><tbody>${[...state.batches].reverse().map(x=>{const as=x.runs.flatMap(r=>r.attempts||[]),models=[...new Set(as.map(a=>a.model).filter(Boolean))],fps=[...new Set(as.map(a=>a.systemFingerprint).filter(Boolean))];return `<tr><td class="paper-cell">${x.demo?'[模拟] ':''}${esc(x.name)}<small>${esc(time(x.createdAt))}</small></td><td>${esc(models.join(', ')||x.config.model)}<small>${esc(fps.join(', ')||'指纹未报告')}</small></td><td>${x.papers.length} 篇</td><td>${x.runs.filter(r=>r.status==='success').length}/${x.papers.length*x.config.repeats}</td></tr>`;}).join('')}</tbody></table></div></div>`;
}
function renderMethod() {
  const b=currentBatch(), prompt=b?.protocol.systemPrompt||PB.makeSystemPrompt(state.config.paperType,state.config.anchors);
  $('method').innerHTML=`<div class="card"><h2>让评分可复核的六项约定</h2><div class="method-list"><p><b>1. 固定评分口径。</b>v2 每维四个固定检查项，每项按 0–4 级行为锚点审查，论文类型改变证据适配。历史 v1 结果保留原直接量表。标题、版本号、发表身份与其他论文得分不进入评审请求。</p><p><b>2. 每篇独立，多轮交错。</b>同一轮中的论文随机排序、独立请求；整轮结束后才开始下一轮。模型不负责排序。相同 seed 也不保证相同结果；填写 seed 后会按轮递增。</p><p><b>3. 分数必须带证据。</b>要求定位、原文引文、具体理由和可执行建议。引用匹配只验证文字出现；公式、表格、外部事实及结论仍需作者核查。没有匹配引文的维度记为不可评。</p><p><b>4. 看分布，不只看一个数。</b>v2 先审查中心主张、支持与反对论证，再由四项等级计算维度分数。原始分为 1+9×等级均值÷4；出现等级0/1/2分别触发最高4/6/8分；任一项不可评则该维不计分。总览提供中位数、标准差、MAD、极差和有效轮数。默认 5 轮用于筛查，3 次同分也不能证明稳定。</p><p><b>5. 版本差异使用逐轮差值。</b>使用保守精确符号统计，对超出 ±δ 的方向支持计数；阈值内与边界值留在样本数中，不提供支持票。选择方向时乘二，并对本批所有非基准论文 × 五维做 Holm 校正。置信区间使用二项分布次序统计量及 Bonferroni 家族校正，数据不足可退到整个 [-9,9] 量表差值范围。</p><p><b>6. 显著性有边界。</b>只有复评完整、轮次足够且校正检验通过，才显示模型条件下的“显著改进/退步”。LLM 调用不一定独立，尺度是近似序数。未显著不是等效；已发表论文不保证高分；多次尝试协议直到显著会使推断失效。</p></div><p class="hint">方法参考：<a href="https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/signtest.htm" target="_blank" rel="noreferrer">NIST 符号检验</a>；<a href="https://stat.ethz.ch/R-manual/R-devel/library/stats/html/p.adjust.html" target="_blank" rel="noreferrer">R：Holm 多重比较校正</a>。本工具对实质阈值内观测采用更保守的支持计数处理。</p></div><div class="card"><h2>五维量表与完整 Prompt</h2><p class="hint">${b?'此处为当前批次冻结的实际评分指令。':'此处根据已保存配置生成。'}新增领域说明会形成新的评分协议。</p><pre>${esc(prompt)}</pre><div class="callout">不预置任意“优秀论文=9分”的带分样例，以免把发表身份当作证据。先用匿名对标论文做校准；如真实验收方差过大，再在新协议中修订锚点，并重打全部版本。成对盲评可作为后续独立核验，当前程序不将其与绝对分混合。</div></div><div class="card"><h2>PDF 与跨域连接</h2><p>v2.4 的PDF模式发送原始PDF与带固定编号的引文定位索引。模型从PDF审阅论文，用索引定位引用；程序核验编号与原文后才计分。文字模式只发送正文。PDF版式、公式与图表仍须核查；直接以file://打开页面不能发送PDF原件。</p><p>若连接报 CORS / 网络错误，确认 endpoint、TLS、代理及供应商权限。可使用附带的 <code>local_proxy.py</code> 在本机转发，操作见 README。提高超时不能解决 CORS。</p><p class="hint">单文件没有 CDN 或后台服务。断网时仍可查看、比较、导出已有记录；新评分需要连接所配模型接口。</p></div>`;
}
function renderAll() { renderPapers(); renderBatchHeader(); ({overview:renderOverview,compare:renderCompare,audit:renderAudit,history:renderHistory,method:renderMethod}[activeTab])(); }
function scheduleRender() {clearTimeout(renderTimer);renderTimer=setTimeout(renderAll,70);}
function showTab(tab) {activeTab=tab;for(const el of document.querySelectorAll('[data-tab]'))el.classList.toggle('active',el.dataset.tab===tab);for(const el of document.querySelectorAll('.tab-panel'))el.hidden=el.id!==tab;renderAll();}
function download(name,text,type='application/json') {const blob=new Blob([text],{type});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const stamp=()=>new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
function exportJSON() {try {if(dirtyPaper)savePaperForm();const archive=PB.exportArchive(state);archive.analysisPreferences={baselineId,threshold,alpha:.05};download(`paperbench-${stamp()}.json`,JSON.stringify(archive,null,2));notify('已导出全部论文、批次、原始调用与复算信息。备份不包含所配置的 API Key。');}catch(e){notify(e.message,true);}}
function summaryCSV() {
 const b=currentBatch();if(!b)return;
 const rows=[['rank','batch','paper','version','role',...PB.DIMS.flatMap(d=>[d.name,d.id+'_sd',d.id+'_mad',d.id+'_n']),'total_median_of_round_means','complete_rounds','planned_rounds','simulation']];
 const {data,ranked}=orderedSummaries(b);
 for(const {p,s}of data)rows.push([ranked?descriptiveRank(data,s.total):'',b.name,p.title,p.version,p.kind,...PB.DIMS.flatMap(d=>{const z=s.dimensions[d.id];return[z?.median??'',z?.sd??'',z?.mad??'',z?.n??0];}),s.total??'',s.completeRuns,b.config.repeats,!!b.demo]);
 download(`paperbench-summary-${stamp()}.csv`,PB.csv(rows),'text/csv;charset=utf-8');
}
function exportCSV() {
 const rows=[['batch_id','batch_name','simulation','protocol_id','paper_id','paper_title','group','version','role','paper_sha256','round','run_status','attempt','attempt_status','started_at','duration_ms','http_status','model','system_fingerprint','prompt_tokens','completion_tokens','total_tokens','dimension','score','reported_score','reason','improvement','evidence_json','summary','limitations','warnings','error','request_json','response_raw','review_schema_version','analysis_json','checks_json','raw_score','score_cap','cap_reasons_json','revisions_json','local_recovery_json','citation_repairs_json']];
 for(const b of state.batches)for(const r of b.runs){const p=b.papers.find(x=>x.id===r.paperId);const attempts=r.attempts?.length?r.attempts:[null];for(let j=0;j<attempts.length;j++){const a=attempts[j];const dims=(a?.status==='success'||(a&&r.localRecovery?.sourceAttemptId===a.id)||(!a&&b.demo))&&r.result?r.result.dimensions:[null];for(const d of dims) rows.push([b.id,b.name,!!b.demo,b.protocol.id,p?.id,p?.title,p?.group,p?.version,p?.kind,p?.hash,r.round,r.status,j+1,a?.status,a?.startedAt||a?.startAt,a?.durationMs,a?.httpStatus,a?.model,a?.systemFingerprint,a?.usage?.prompt_tokens,a?.usage?.completion_tokens,a?.usage?.total_tokens,d?.id,d?.score,d?.reportedScore,d?.reason,d?.improvement,d?JSON.stringify(d.evidence):'',d?r.result.summary:'',d?r.result.limitations:'',d?JSON.stringify(r.result.warnings||[]):'',a?.error||r.error,a?JSON.stringify(a.request):'',a?.responseBody,d?r.result.schemaVersion??1:'',d?JSON.stringify(r.result.analysis||null):'',d?JSON.stringify(d.items||[]):'',d?.rawScore,d?.scoreCap,d?JSON.stringify(d.capReasons||[]):'',d?JSON.stringify(r.result.revisions||[]):'',r.localRecovery?JSON.stringify(r.localRecovery):'',d?JSON.stringify(r.result.citationRepairs||[]):'']);}}
 download(`paperbench-calls-${stamp()}.csv`,PB.csv(rows),'text/csv;charset=utf-8');notify('已导出所有批次的调用级 CSV，含失败、重试与原始正文。每个已解析响应按五维展开，分析 token 时请按调用去重。');
}
async function copy(text) {try{await navigator.clipboard.writeText(text);notify('理由已复制。');}catch{download(`paperbench-notes-${stamp()}.txt`,text,'text/plain;charset=utf-8');notify('浏览器未开放剪贴板，已改为下载理由文本。');}}
function analysisEvidenceText(section) {
 const sources=Array.isArray(section?.sourceEvidence)?section.sourceEvidence:[];
 return sources.length?'\n原文定位 '+sources.length+' 段：\n'+sources.map(e=>`${e.sourceId} · ${e.location}：${e.quote}`).join('\n'):'';
}
function reasonText(r,p) {
 const z=r.result, a=z.analysis;
 const analysis=a?`\n中心主张审计：\n${a.centralClaims.map(c=>`${c.id}：${c.claim}\n声明范围：${c.scope}\n可见支撑：${c.supportAssessment}\n反对证据或限制：${c.counterEvidence}\n替代解释：${c.alternativeExplanations}\n模型判断：${claimVerdict(c)}${analysisEvidenceText(c)}`).join('\n\n')}\n最强支持论证：${a.strongestSupport.text}${analysisEvidenceText(a.strongestSupport)}\n最强反对论证：${a.strongestChallenge.text}${analysisEvidenceText(a.strongestChallenge)}\n审查边界：${a.verificationLimits}\n`:'';
 return `${paperName(p)} · 第 ${r.round} 轮\n${z.summary}\n`+(r.localRecovery?'本地恢复成功，未新增模型请求：'+JSON.stringify(r.localRecovery)+'\n':'')+(z.citationRepairs?.length?'原文编号恢复引用：\n'+z.citationRepairs.map(repair=>citationRepairText(repair,z)).join('\n')+'\n':'')+(z.warnings?.length?'核验提示：'+z.warnings.join('\n')+'\n':'')+(z.validation?.issues?.length?'返回内容校验：\n'+z.validation.issues.map(x=>`${x.severity} · ${x.path}：${x.message}`).join('\n')+'\n':'')+analysis+z.dimensions.map(d=>`${PB.DIMS.find(x=>x.id===d.id)?.name}: ${num(d.score)}${d.reportedScore!=null&&d.score==null?'（原报 '+num(d.reportedScore)+'；核验后不可评分）':''}\n理由：${d.reason}\n${d.items?`四项检查：\n${d.items.map(item=>`${item.name||item.id}：${item.status==='invalid'?'响应字段待处理，未计分':item.effectiveLevel==null?'不可评':'等级'+item.effectiveLevel+'/4'}；分档依据：${item.basis}；缺口：${item.missing||'未另列'}；引用本维第${(item.evidenceIndices||[]).map(i=>i+1).join('、')}条`).join('\n')}\n原始分：${num(d.rawScore,4)}；固定上限：${num(d.scoreCap)}；上限触发：${JSON.stringify(d.capReasons||[])}\n`:''}引文：${d.evidence.map(e=>(e.matched===false?'[未匹配，不算证据] ':'[文字已匹配，论断仍需核查] ')+e.location+'：'+e.quote).join('\n')}\n建议：${d.improvement}`).join('\n\n')+(z.revisions?`\n修订优先级：\n${[...z.revisions].sort((a,b)=>(a.priority??Infinity)-(b.priority??Infinity)).map(x=>`${revisionPriority(x)}：${x.action}\n理由：${x.rationale}\n对应：${x.dimensionId||'未分配维度'} · ${(x.claimIds||[]).join('、')}`).join('\n')}`:'')+'\n局限：'+z.limitations;
}
function assertBatchEndpoint(batch) {
 if(batch.protocol.citationMode!=='source_ids_v1')throw new Error('此批次使用旧评审协议，只读保留原结果。请开始新批次使用 v2.4 引文定位协议。');
 const current=readConfig();
 if(current.endpoint!==batch.config.endpoint)throw new Error('当前接口与该历史批次的真实接口不一致。请先为历史接口 '+batch.config.endpoint+' 配置对应凭据，再恢复；不会把当前Key发送到另一接口。旧本机代理协议请使用原启动环境或新建批次，不能静默改写。');
 const official=PB.validateConfig({...PB.DEFAULT_CONFIG,apiKey:''}).endpoint;
 if(workspaceSession&&workspacePreferences.apiMode==='default'&&current.endpoint!==official)throw new Error('默认GLM凭据模式仅用于官方GLM接口。请切换自定义模式，并为该历史接口填写对应Key。');
 return current;
}
function recoverCurrentBatchLocally() {
 if(inputBusy()||offlineSnapshot())return;
 const batch=currentBatch();if(!batch)return;
 if(batch.protocol.citationMode!=='source_ids_v1')throw new Error('此批次不使用原文编号协议，原记录保留，不能本地恢复引用。');
 if(typeof PB.recoverBatchLocally!=='function')throw new Error('当前程序未加载本地恢复工具，请完整重启新版本。');
 const result=PB.recoverBatchLocally(batch);
 const full=Number(result.recovered)||0,partial=Number(result.partialRecovered)||0,changed=full+partial;
 if(changed>0){
  if(lastSavedReport?.batchId===batch.id)lastSavedReport=null;
  $('outputStatus').textContent=`已本地恢复 ${full} 次完整评分、${partial} 次部分结果。已有离线报告仍是恢复前的快照；请点击“保存当前批报告”保存更新后的报告。`;
 }
 renderAll();persist(true);
 notify(`本地恢复完成：${full} 次恢复五维完整，${partial} 次恢复部分结果，仍有 ${result.remainingFailed} 次失败。未调用模型，原始请求与失败记录已保留。${changed?'请保存当前批报告，或导出 JSON 留存更新结果。':'可在评审理由与记录查看尚未恢复的原因。'}`,result.remainingFailed>0||partial>0);
 return result;
}
async function executeBatch(batch,key) {
 if(offlineSnapshot())return;
 assertBatchEndpoint(batch);await checkPDFInputs(batch.papers);
 running=true;controller=new AbortController();renderAll();persist(true);
 try{if(workspaceSession&&(!preparedRoute||preparedRoute.upstream!==batch.config.endpoint||preparedRoute.key!==key||preparedRoute.mode!==workspacePreferences.apiMode)){const c=await configureLocalAPI({...batch.config,apiKey:key});if(c.endpoint!==batch.config.endpoint)throw new Error('接口规范化结果与历史协议不同，请新建批次。');}await PB.runBatch(batch,key,{signal:controller.signal,onUpdate:()=>{persist();scheduleRender();}});const counts=batchProgress(batch);notify(batch.status==='paused'?`批次已暂停：${batchPauseReason(batch)} 当前五维完整 ${counts.complete}/${counts.total} 次；已有记录保留。`:`${batchCompletionLabel(batch)}：五维完整 ${counts.complete}/${counts.total} 次，部分结果 ${counts.partial} 次，失败 ${counts.failed} 次。`,batch.status==='paused'||batchHasIssues(batch));}
 catch(e){notify(e.message,true);}
 finally{running=false;controller=null;renderAll();persist(true);if(workspaceSession&&workspacePreferences.autoSaveReport&&batch.runs.some(r=>r.attempts?.length))await saveCurrentReport(batch,true);}
}
async function startBatch(){
 if(inputBusy()||offlineSnapshot())return;creating=true;mineruPreparation=null;renderBatchHeader();
 try{if(state.batches.length>=100)throw new Error('已达100批，请先导出并移除旧批次。');if(dirtyPaper)savePaperForm();let c=saveConfig(false);assertPaperReadiness();let papers=reviewPapers();await checkPDFInputs(papers);const localAPI=localMineruAPI(c),prepare=localAPI&&papers.some(p=>p.pdf);let outputPath='';if(localAPI||workspaceSession&&workspacePreferences.autoSaveReport)outputPath=await validateOutputPath();if(prepare){papers=await prepareMineruPapers(papers,outputPath);c={...c,inputMode:'text'};}c=await configureLocalAPI(c);const batch=await PB.createBatch(papers,c,$('batchName').value.trim()||`评审 ${new Date().toLocaleDateString('zh-CN')}`);state.batches.push(batch);changeBatch(batch.id);await executeBatch(batch,c.apiKey||'');}
 catch(e){notify(e.message,true);}finally{creating=false;renderBatchHeader();}
}
function mineruStatusText(){
 const job=mineruPreparation;if(!job)return '';
 const current=typeof job.current==='object'?job.current?.title||job.current?.paperId||'':job.current||'';
 const progress=`${Math.min(job.completed||0,job.total||0)}/${job.total||0} 篇完成`;
 if(job.status==='complete')return `MinerU 转换完成 · ${progress}。Markdown 已准备；图像链接不会作为图片发送给评分模型。`;
 if(job.status==='failed')return `MinerU 转换失败 · ${progress} · ${job.message||'请检查转换日志'}。未开始新批次评分。`;
 if(job.status==='cancelled')return `MinerU 转换已取消 · ${progress}。未开始新批次评分。`;
 if(job.connectionLost)return `MinerU 状态连接中断 · ${progress}。后台 GPU 任务可能仍在运行，正在重新查询${job.cancelRequested?'并请求取消':''}；当前保持锁定，不会另开转换或调用评分模型。${job.message?' '+job.message:''}`;
 return `${job.cancelRequested?'正在取消 GPU / MinerU 转换':'GPU / MinerU 转换中'} · ${progress} · 当前第 ${Math.min(Number.isInteger(job.current?.index)?job.current.index:(job.completed||0)+1,job.total||1)} 篇${current?'：'+current:''}${job.message?' · '+job.message:''}。转换完成前不会调用评分模型，请保持页面打开。`;
}
async function cancelMineruPreparation(){
 if(offlineSnapshot()||!creating||!mineruPreparation||['complete','failed','cancelled'].includes(mineruPreparation.status))return;
 const job=mineruPreparation;job.cancelRequested=true;renderBatchHeader();
 if(job.jobId&&!job.cancelSent){job.cancelSent=true;try{await mineruPost('/local-mineru/cancel',{jobId:job.jobId});}catch(error){job.cancelSent=false;throw error;}}
}
async function mineruPost(route,body){
 if(offlineSnapshot())return;
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{return await workspacePost(route,body,abort.signal);}finally{clearTimeout(timer);}
}
async function prepareMineruPapers(papers,outputPath){
 if(offlineSnapshot())return papers;
 const pdfs=papers.filter(p=>p.pdf);
 const job=mineruPreparation={status:'starting',requestId:uid(),completed:0,total:pdfs.length,current:'',message:'正在启动本地转换任务'};renderBatchHeader();
 try{
  const request={requestId:job.requestId,papers:pdfs.map(p=>({paperId:p.id,sha256:p.pdf.sha256,title:p.title})),outputPath};let started;
  while(true){
   try{started=await mineruPost('/local-mineru/start',request);if(typeof started?.jobId!=='string'||!started.jobId)throw new Error('MinerU 服务没有返回有效任务编号。');job.connectionLost=false;break;}
   catch(error){
    if(error.httpStatus>=400&&error.httpStatus<500&&![408,429].includes(error.httpStatus))throw error;
    job.connectionLost=true;job.message='正在核对同一启动请求：'+error.message;renderBatchHeader();await new Promise(resolve=>setTimeout(resolve,2000));
   }
  }
  job.jobId=started.jobId;job.status='running';
  let result;
  while(true){
   let cancelWarning='';
   if(job.cancelRequested&&!job.cancelSent)try{await cancelMineruPreparation();}catch(error){cancelWarning=error.message;}
   try{
    result=await mineruPost('/local-mineru/status',{jobId:job.jobId});
    if(result?.jobId!==job.jobId||!['running','complete','failed','cancelled'].includes(result.status))throw new Error('MinerU 转换状态响应无效。');
    job.connectionLost=false;
   }catch(error){
    if([400,404].includes(error.httpStatus)&&/任务不存在|会话已结束/.test(error.message))throw error;
    job.connectionLost=true;job.message=error.message;renderBatchHeader();await new Promise(resolve=>setTimeout(resolve,2000));continue;
   }
   for(const key of ['status','completed','total','current','message'])if(result[key]!==undefined)job[key]=result[key];
   if(cancelWarning&&result.status==='running'){job.connectionLost=true;job.message='取消请求暂未确认：'+cancelWarning;}
   renderBatchHeader();
   if(result.status!=='running')break;
   await new Promise(resolve=>setTimeout(resolve,800));
  }
  if(job.cancelRequested||result.status==='cancelled'){job.status='cancelled';throw new Error('MinerU 转换已取消，未开始新批次评分。');}
  if(result.status==='failed')throw new Error('MinerU 转换失败：'+(result.message||'请检查转换日志')+'；未开始新批次评分。');
  if(!Array.isArray(result.items)||result.items.length!==pdfs.length)throw new Error('MinerU 未完整返回所有 PDF 的转换结果；未开始评分。');
  const converted=new Map();
  for(const item of result.items){
   const original=pdfs.find(p=>p.id===item.paperId);
   if(!original||converted.has(item.paperId)||typeof item.text!=='string'||!item.text.trim())throw new Error('MinerU Markdown 为空或论文对应关系无效；不会改用原编辑框正文评分。');
   if(item.provenance?.method!=='mineru'||item.provenance.pdfSha256!==original.pdf.sha256||item.provenance.markdownSha256!==await PB.hashText(item.text))throw new Error('MinerU 原始 PDF 或 Markdown 哈希校验失败；未开始评分。');
   const prepared={...original,text:item.text,preparation:{...item.provenance}};delete prepared.pdf;converted.set(item.paperId,prepared);
  }
  return papers.map(p=>converted.get(p.id)||{...p});
 }catch(error){if(job.status!=='cancelled'){job.status='failed';job.message=error.message;}renderBatchHeader();throw error;}
}
async function loadDemo(){if(running||creating)return;if(state.batches.length>=100)throw new Error('已达100批，请先导出并移除旧批次。');creating=true;renderBatchHeader();try{const quote='本研究提出分层轨迹估计方法，并在合成噪声环境下评估定位误差。';const text=quote+'\n第 1 节：研究目标与适用范围。\n第 2 节：方法依赖已知噪声协方差，伪代码列出了状态更新步骤。\n第 3 节：实验使用三个噪声强度、统一数据划分和两种基线，报告平均误差但尚无置信区间。\n第 4 节：结论限制于仿真场景，尚不能外推到真实传感器部署。';
 const ps=[['初始草稿','v10','structure'],['结构修订','v13','structure'],['语言修订','v20','style'],['证据增强','v23','evidence'],['匿名对标文献','published','other']].map(([title,version,change],i)=>({id:uid(),title,version,change,group:i===4?'对标':'示例研究',kind:i===4?'reference':'draft',text:text+`\n模拟版本标记 ${i}，此文本仅供软件界面演示。`}));
 const c={...PB.DEFAULT_CONFIG,repeats:12,maxChars:200000,apiKey:'',model:'local-simulation'};const batch=await PB.createBatch(ps,c,'功能演示 · 合成评分');batch.demo=true;const bases=[[5.5,5,4.8,4.5,5.1],[6.6,5.1,4.9,4.6,6.2],[6.8,5.2,5,4.7,6.3],[7.6,7.4,7.6,7.1,7.7],[7.2,7.1,7.4,7,7.3]];
 for(const r of batch.runs){const i=ps.findIndex(p=>p.id===r.paperId);const noise=[-.3,.1,.2,-.1,.3,-.2,.2,-.2,.1,-.1,.3,-.3][r.round-1];const z={dimensions:PB.DIMS.map((d,k)=>({id:d.id,score:Math.round((bases[i][k]+noise+(i%2?.1:0))*10)/10,evidence:[{quote,location:'摘要首句'}],reason:`这是模拟评审理由：${d.name}在当前示例中有明确的研究对象，但仍需核查假设条件、对照设计与结论边界。该理由不用于判断真实论文。`,improvement:'请在实际论文中补充可定位的推导、数据及对应的局限说明。'})),summary:'本条为本地合成的模拟评审，展示五维评分、波动区间及版本差异。请使用真实全文和模型重新运行以验收效果。',limitations:'此批次完全由程序生成，未调用任何模型，不具有真实评审或统计验证效力。'};if(PB.REVIEW_SCHEMA_VERSION===2){z.schemaVersion=2;z.analysis={researchType:'simulation',typeRationale:'本示例描述固定合成噪声环境中的误差评估，仅用于离线界面演示。',centralClaims:[{id:'C1',claim:'示例方法在所声明的合成噪声环境中给出可评估的定位误差。',scope:'仅限示例给定的合成噪声与模拟数据，不外推真实环境。',evidenceRefs:[{dimensionId:'evidence',evidenceIndex:0}],supportAssessment:'示例正文说明了所考察问题和评估对象，但未提供真实运行数据。',counterEvidence:'示例没有真实反证材料，也没有通过独立实验确认其效果。',alternativeExplanations:'数据生成假设与评价设置可能影响表现，此示例无法排除。',verdict:'partial'}],strongestSupport:{text:'最强支持是示例明确交代研究对象和评价环境，这只是文字层面的可见支撑。',evidenceRefs:[{dimensionId:'contribution',evidenceIndex:0}]},strongestChallenge:{text:'最强反对理由是示例没有真实实验与独立验证，不能用合成评分宣称有效。',evidenceRefs:[]},verificationLimits:'全部等级及论证内容均由本地程序合成，不能用于评价任何真实研究。'};z.revisions=[{priority:1,dimensionId:'evidence',claimIds:['C1'],action:'在真实材料中逐项核查中心主张与现有证据的对应关系。',rationale:'示例不含可复核的真实数据，因此必须先确认材料与证据的真实性。'}];z.dimensions.forEach((d,k)=>{delete d.score;d.items=PB.CRITERIA[d.id].map((criterion,j)=>({id:criterion.id,level:Math.max(0,Math.min(4,Math.floor(Math.round((bases[i][k]+noise-1)*16/9)/4)+(j<Math.round((bases[i][k]+noise-1)*16/9)%4?1:0))),status:'assessable',basis:'这是模拟检查依据：示例中可以识别评价对象，但真实证据与边界仍须逐项人工核查。',evidenceIndices:[0],missing:'示例没有真实实验材料，本条仅展示检查项的布局和分档。'}));});}r.status='success';r.result=PB.parseReview(JSON.stringify(z),ps[i].text);r.attempts=[{id:uid(),status:'success',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:0,httpStatus:null,request:{simulation:true},responseBody:JSON.stringify(z),usage:null,model:'local-simulation',systemFingerprint:'synthetic-not-a-model'}];}
 batch.status='complete';batch.finishedAt=new Date().toISOString();state.batches.push(batch);changeBatch(batch.id);$('settings').open=false;notify('已载入独立演示批次。所有分数均为合成，论文库与模型配置保留原样。');persist(true);}finally{creating=false;renderBatchHeader();}
}
async function importFiles(files) {
 if(offlineSnapshot())return;
 if(workspaceSession)return importWorkspaceFiles(files);
 return withWorkspaceBusy(async()=>{if(dirtyPaper)savePaperForm();return importBrowserTextFiles(files);});
}
function bindWorkspace() {
 if($('cancelMineruBtn'))$('cancelMineruBtn').onclick=()=>cancelMineruPreparation().catch(error=>notify('取消请求失败：'+error.message+'；继续等待任务状态，尚未开始评分。',true));
 const showError=error=>{notify(error.message||String(error),true);if($('workflowStatus'))$('workflowStatus').textContent=error.message||String(error);};
 if($('checkSetupBtn'))$('checkSetupBtn').onclick=()=>checkSetup().catch(showError);
 if($('checkOutputBtn'))$('checkOutputBtn').onclick=()=>withWorkspaceBusy(async()=>{await validateOutputPath();$('outputStatus').textContent='第3步完成：输出路径已检查并保存。报告将在评分后写入独立子目录。';notify('第3步完成：输出路径已检查并保存。');}).catch(showError);
 if($('reconnectWorkspaceBtn'))$('reconnectWorkspaceBtn').onclick=async()=>{if(inputBusy()||offlineSnapshot())return;try{saveConfig(false);}catch(error){showError(error);return;}const ok=await connectLocalProfile(false);notify(ok?'本机服务已连接，现有参数已保留；请重新导入尚无正文的PDF。':'未连接到本机服务，请按顶部指引启动后打开本机地址。',!ok);renderWorkflow();};
 if($('settings'))$('settings').oninput=()=>renderWorkflow();
 if($('inputMode'))$('inputMode').onchange=()=>{if(inputBusy()||offlineSnapshot())return;renderAll();notify(localMineruAPI()?'本地自定义 API 的 PDF 将由 GPU / MinerU 转成 Markdown 后评分；编辑框正文不会代替原件转换。TXT、MD 仍发送文本。':$('inputMode').value==='pdf'?'PDF原件 + 引文定位索引：原PDF与编辑框文字生成的索引一并发送，并在本地核验引用。TXT仍发送文本。新建批次后生效。':'文本模式：只发送编辑框全文，不发送PDF。新建批次后生效。');};
 if($('apiMode'))$('apiMode').onchange=()=>{if(inputBusy()||offlineSnapshot())return;workspacePreferences.apiMode=$('apiMode').value==='custom'?'custom':'default';if(workspacePreferences.apiMode==='default'){for(const id of ['endpoint','model','thinking','reasoningEffort'])$(id).value=PB.DEFAULT_CONFIG[id];$('sendDoSample').checked=PB.DEFAULT_CONFIG.sendDoSample!==false;$('doSample').checked=PB.DEFAULT_CONFIG.doSample;}saveConfig(false);saveWorkspacePreferences();updateConfigSummary();};
 for(const id of ['endpoint','model'])$(id).onchange=()=>{if(inputBusy()||offlineSnapshot())return;if($(id).value.trim()!==PB.DEFAULT_CONFIG[id]&&workspacePreferences.apiMode==='default'){workspacePreferences.apiMode='custom';$('apiMode').value='custom';$('thinking').value='omit';$('reasoningEffort').value='omit';$('sendDoSample').checked=false;saveWorkspacePreferences();updateConfigSummary();}};
 for(const id of ['inputPaths','outputPath'])if($(id))$(id).oninput=()=>{if(inputBusy()||offlineSnapshot())return;workspacePreferences[id]=$(id).value;if(id==='outputPath'){validatedOutput='';lastSavedReport=null;}saveWorkspacePreferences();renderWorkflow();};
 for(const id of ['recursiveInput','autoSaveReport'])if($(id))$(id).onchange=()=>{if(inputBusy()||offlineSnapshot())return;workspacePreferences[id]=$(id).checked;saveWorkspacePreferences();};
 if($('readPathsBtn'))$('readPathsBtn').onclick=()=>readWorkspacePaths().catch(showError);
 if($('pickInputFiles'))$('pickInputFiles').onclick=()=>pickWorkspaceInput('files').catch(showError);
 if($('pickInputFolder'))$('pickInputFolder').onclick=()=>pickWorkspaceInput('folder').catch(showError);
 if($('pickOutputFolder'))$('pickOutputFolder').onclick=()=>pickWorkspaceOutput().catch(showError);
 if($('saveReportBtn'))$('saveReportBtn').onclick=()=>saveCurrentReport().catch(showError);
 if($('folderFiles'))$('folderFiles').onchange=async event=>{try{if(inputBusy()||offlineSnapshot())return;await importFiles([...event.target.files]);}catch(error){showError(error);}finally{event.target.value='';}};
 if($('dropZone')){
  $('dropZone').ondragover=event=>{event.preventDefault();if(!inputBusy())event.dataTransfer.dropEffect='copy';};
  $('dropZone').ondrop=event=>{event.preventDefault();if(inputBusy()||offlineSnapshot()){notify('当前任务进行中，未导入拖拽材料。');return;}try{const snapshot=snapshotDrop(event.dataTransfer);handleWorkspaceDrop(snapshot).catch(error=>{const message=fileReadMessage(error);$('inputStatus').textContent=message;notify(message,true);});}catch(error){const message=fileReadMessage(error);$('inputStatus').textContent=message;notify(message,true);}};
 }
 $('repeats').oninput=()=>{if(inputBusy()||offlineSnapshot())return;updateConfigSummary();renderBatchHeader();};
}
async function importBrowserTextFiles(files) {
 if(offlineSnapshot())return;
 const result={files:[],errors:[...(files.errors||[])]};
 for(const item of files){const file=item.file||item,relativePath=item.relativePath||file.webkitRelativePath||file.name;if(!/\.(pdf|txt|md|text)$/i.test(file.name)){result.errors.push({path:relativePath,message:'不支持的文件类型'});continue;}if(file.size>8*1024*1024){result.errors.push({path:relativePath,message:'浏览器文本模式限制8MB；可改用本机服务读取'});continue;}try{const isPDF=/\.pdf$/i.test(file.name)||file.type==='application/pdf';const text=isPDF?'':await file.text();const fileHash=typeof file.arrayBuffer==='function'&&crypto.subtle?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join(''):null;result.files.push({filename:file.name,title:file.name.replace(/\.[^.]+$/,''),relativePath,sourcePath:null,sourceId:null,text,sha256:fileHash,warnings:isPDF?['当前为浏览器模式，PDF仅登记条目；启用本机服务重新导入可自动提取全文。']:[]});}catch(error){result.errors.push({path:relativePath,message:fileReadMessage(error)});}}
 return mergeWorkspaceFiles(result);
}

function bind() {
 bindWorkspace();
 $('localProfileBtn').onclick=()=>connectLocalProfile(true);
 $('recoveryBtn').onclick=()=>download('paperbench-unloaded-recovery-'+stamp()+'.json',typeof recoveryData==='string'?recoveryData:JSON.stringify(recoveryData,null,2));
 $('saveConfigBtn').onclick=()=>{try{saveConfig();renderAll();}catch(e){notify(e.message,true);}};
 if ($('glmPresetBtn')) $('glmPresetBtn').onclick=()=>{try{restoreGLMDefaults();}catch(e){notify(e.message,true);}};
 $('rememberKey').onchange=()=>{if(!$('rememberKey').checked)try{localStorage.removeItem('paperbench-key-v1');}catch{}};
 $('testBtn').onclick=async()=>{if(inputBusy()||offlineSnapshot())return;try{testController=new AbortController();renderBatchHeader();const c=await configureLocalAPI(readConfig());const z=await PB.testConnection(c,{signal:testController.signal});notify('连接成功：'+JSON.stringify(z));}catch(e){notify(e.message,true);}finally{testController=null;renderBatchHeader();}};
 $('paperForm').onsubmit=e=>{e.preventDefault();try{savePaperForm();renderAll();notify('论文已保存。修改只影响未来的新批次。');}catch(err){notify(err.message,true);}};
 $('paperForm').oninput=()=>{dirtyPaper=true;updateTextHint();};
 $('newPaper').onclick=()=>{try{if(dirtyPaper)savePaperForm();fillPaper();$('paperTitle').focus();}catch(e){notify(e.message,true);}};
 $('paperList').onclick=e=>{const el=e.target.closest('[data-paper]');if(!el)return;try{if(dirtyPaper)savePaperForm();fillPaper(el.dataset.paper);}catch(err){notify(err.message,true);}};
 $('deletePaper').onclick=()=>{if(running||!editingId)return;state.papers=state.papers.filter(p=>p.id!==editingId);if(!state.batches.some(b=>b.papers.some(p=>p.id===editingId))){delete workspacePreferences.sourceRefs[editingId];delete workspacePreferences.sourceMetadata[editingId];}saveWorkspacePreferences();fillPaper();persist();renderAll();notify('已从论文库移除。已有批次中的论文快照仍保留。');};
 $('paperFiles').onchange=async e=>{try{if(inputBusy()||offlineSnapshot())return;if(dirtyPaper)savePaperForm();await importFiles([...e.target.files]);}catch(err){notify(err.message,true);}e.target.value='';};
 $('batchSelect').onchange=e=>changeBatch(e.target.value);$('runBtn').onclick=startBatch;
 $('pauseBtn').onclick=()=>{const batch=currentBatch();if(batch)batch.pauseReason='已按你的操作暂停，完成的评分与原始记录保留。';controller?.abort();notify('正在暂停，已完成的评分与原始记录保留。');};
 $('resumeBtn').onclick=async()=>{const b=currentBatch();if(!b||inputBusy()||offlineSnapshot())return;creating=true;renderBatchHeader();try{assertBatchEndpoint(b);if(workspaceSession&&workspacePreferences.autoSaveReport)await validateOutputPath();await executeBatch(b,$('apiKey').value.trim());}catch(e){notify(e.message,true);}finally{creating=false;renderBatchHeader();}};
 if($('recoverLocalBtn'))$('recoverLocalBtn').onclick=()=>{try{return recoverCurrentBatchLocally();}catch(e){notify(e.message,true);}};
 $('demoBtn').onclick=()=>loadDemo().catch(e=>notify(e.message,true));$('exportJSON').onclick=exportJSON;$('exportCSV').onclick=exportCSV;$('importBtn').onclick=()=>$('importFile').click();
 $('importFile').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(inputBusy()||offlineSnapshot())return;if(f.size>300*1024*1024)notify('备份超过300MB，正在尝试读取；处理时间可能较长。');const data=PB.validateArchive(JSON.parse(await f.text()));if(dirtyPaper)savePaperForm();if(state.batches.length+data.batches.filter(b=>!state.batches.some(x=>x.id===b.id)).length>100)throw new Error('合并后超过100批，请先导出并移除旧批次。');const old=state.batches.length;const batchIds=new Set(state.batches.map(b=>b.id));for(const b of data.batches)if(!batchIds.has(b.id)){state.batches.push(b);batchIds.add(b.id);}const paperIds=new Set(state.papers.map(p=>p.id));for(const p of data.papers)if(!paperIds.has(p.id)&&state.papers.length<30){state.papers.push(p);paperIds.add(p.id);}if(data.currentBatchId&&state.batches.some(b=>b.id===data.currentBatchId))changeBatch(data.currentBatchId);if(storageProtected){download('paperbench-unloaded-recovery-'+stamp()+'.json',typeof recoveryData==='string'?recoveryData:JSON.stringify(recoveryData,null,2));storageProtected=false;recoveryData=null;$('recoveryBtn').hidden=true;}fillPaper(editingId);renderAll();persist(true);notify(`已合并导入 ${state.batches.length-old} 个新批次。同 ID 批次不覆盖；当前 API 配置保留。`);}catch(err){notify('导入失败，现有数据未替换：'+err.message,true);}e.target.value='';};
 document.querySelector('.tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(b)showTab(b.dataset.tab);};
 document.querySelector('.results-area').addEventListener('change',e=>{const el=e.target;if(el.dataset.radar){if(el.checked&&radarIds.size>=6){el.checked=false;notify('最多同时叠加6篇，请先取消一篇。',true);return;}el.checked?radarIds.add(el.dataset.radar):radarIds.delete(el.dataset.radar);renderOverview();}if(el.id==='overviewPaper'){overviewPaperId=el.value;renderOverview();}if(el.id==='overviewRound'){overviewRound=Number(el.value);renderOverview();}if(el.id==='baselineSelect'){baselineId=el.value;renderCompare();}if(el.id==='effectThreshold'){const value=Number(el.value);if(!Number.isFinite(value)||value<0||value>3){notify('阈值范围为0–3分。',true);}else threshold=value;renderCompare();}if(el.id==='reasonTarget'){reasonTarget=el.value;renderCompare();}if(el.id==='reasonRound'){reasonRound=Number(el.value);renderCompare();}if(el.id==='auditPaper'){auditPaperId=el.value;renderAudit();}if(el.id==='historyBatch'){historyBatchId=el.value;renderHistory();}});
 document.querySelector('.results-area').addEventListener('click',async e=>{const a=e.target.closest('[data-action]')?.dataset.action;try{if(a==='demo')await loadDemo();if(a==='summaryCSV')summaryCSV();const b=currentBatch();if(a==='removeBatch'&&b&&!running){if(pendingRemoval!==b.id){download('paperbench-archived-'+stamp()+'.json',JSON.stringify(PB.exportArchive({...state,papers:[],batches:[b],currentBatchId:b.id}),null,2));pendingRemoval=b.id;renderHistory();notify('已发起此批JSON下载。确认备份已保存后，再点“确认已保存，移除此批”；当前记录仍保留。');}else{state.batches=state.batches.filter(x=>x.id!==b.id);changeBatch(state.batches.at(-1)?.id||'');notify('已从当前工作区移除此批，可导入其JSON归档恢复。');}return;}if(a==='copyReasons'&&b){const p=b.papers.find(x=>x.id===auditPaperId);await copy(b.runs.filter(r=>r.paperId===p.id&&hasParsedResult(r)).map(r=>reasonText(r,p)).join('\n\n——\n\n'));}if(a==='copyComparison'&&b){await copy([baselineId,reasonTarget].map(id=>{const r=b.runs.find(x=>x.paperId===id&&x.round===reasonRound&&hasParsedResult(x)),p=b.papers.find(x=>x.id===id);return r?reasonText(r,p):paperName(p)+'：本轮暂无有效评分';}).join('\n\n——\n\n'));}}catch(err){notify(err.message,true);}});
 window.addEventListener('beforeunload',e=>{if(running||creating||dirtyPaper){e.preventDefault();e.returnValue='';}persist(true);});
}
async function init() {
  bind();renderBatchHeader();let saved=null;
  try{db=await openDB();saved=await dbGet();}catch(e){db=null;storageLabel('IndexedDB不可用，降级使用localStorage；请定期导出备份。',true);}
  if(!saved)try{const raw=localStorage.getItem('paperbench-state-v1');try{saved=JSON.parse(raw||'null');}catch(e){storageProtected=true;recoveryData=raw;$('recoveryBtn').hidden=false;notify('本地记录不是有效JSON，已保护原始存储。请先导出未加载记录，再导入有效备份。',true);}}catch(e){storageLabel('无法读取本地存储：'+e.message,true);}
  if(saved)try{state=PB.validateArchive(saved);}catch(e){storageProtected=true;recoveryData=saved;$('recoveryBtn').hidden=false;notify('本地记录未通过校验，已保护原有存储：'+e.message+'。请从JSON备份导入。',true);}
  state.config={...PB.DEFAULT_CONFIG,...state.config,apiKey:''};
  try{const c=JSON.parse(localStorage.getItem('paperbench-config-v1')||'null');if(c)state.config={...state.config,...PB.validateConfig({...PB.DEFAULT_CONFIG,...c,apiKey:''})};$('rememberKey').checked=false;state.config.apiKey='';localStorage.removeItem('paperbench-key-v1');}catch(e){notify('本地配置无法读取，已使用默认参数。',true);}
  for(const b of state.batches){if(b.status==='running'){b.status='paused';b.pauseReason='页面关闭或刷新使本机评审流程中断；已有记录保留，未返回请求的服务端状态未知。';}for(const r of b.runs)if(r.status==='running'){r.status='pending';for(const a of r.attempts||[])if(a.status==='running'){a.status='cancelled';a.error='页面关闭或刷新中断，服务端是否计费未知。';}}}
  loadWorkspacePreferences();if(!workspaceModeSaved&&state.config.endpoint!==PB.DEFAULT_CONFIG.endpoint)workspacePreferences.apiMode='custom';fillWorkspaceControls();
  await connectLocalProfile(false);
  fillConfig();fillPaper();ready=true;changeBatch(state.currentBatchId||state.batches.at(-1)?.id||'');if(state.batches.length)$('settings').open=false;
}
init().catch(e=>{ready=true;notify('启动异常：'+e.message,true);renderAll();});
})();
