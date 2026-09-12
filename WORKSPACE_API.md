# v2.1 local workflow interface

All POST requests are JSON, same-origin loopback, authenticated with `X-Paperbench-Token` obtained from `/local-config`. The secret API key never comes back in responses. Existing scoring/core rules remain unchanged.

`GET /local-config`: existing response + `workspace:{enabled:true,defaultInputPath,defaultOutputPath,pdfTextAvailable,nativePickerAvailable}`. `credentialReady` may be false; local file/report tools still work without a key.

`POST /local-files/read` `{paths:[absolute paths or file:// URIs],recursive:true}` => `{files:[{sourceId,filename,title,text,sourcePath,relativePath,sha256,pages,warnings}],errors:[{path,message}]}`. PDF text extraction via local Poppler; no automatic image-based evaluation in browser. Browser UI must identify text-only PDF entry, warn about scans and formulas. Empty PDFs don't become score-ready. Directory reads skip symlinks/hidden entries and enforce bounded input/file counts.

`POST /local-files/upload` `{files:[{name,relativePath,base64}]}` => same shape; uploaded files have `sourcePath:null`, browser-relative name retained, **never invent original absolute path**. Server keeps source asset by `sourceId` for later reports.

`POST /local-files/pick` `{kind:'files'|'folder'|'output'}` => `{paths:[absolute strings],cancelled:boolean}`. Server opens native file/directory picker; no shell execution/interpolation; cancel is normal. GUI missing => useful error allowing pasted paths.

`POST /local-output/validate` `{path:absolute directory}` => `{path:resolved,exists:boolean,writable:true}`. Check existing directory or nearest parent permission; don't write a report yet. No overwrite of existing files.

`POST /local-reports/save` `{outputPath,archive,sourceRefs:{paperId:sourceId}}` => `{path:absolute new run dir,indexPath:absolute,indexUrl:same-origin capability URL,files:[relative names]}`. Unique `YYYY-MM-DD__HHmmss__model__Nxx_Rxx__batchid` child. Validate archive with existing offline exporter; only current selected batch expected. Save JSON+offlineHTML+CSV+README and actual available source PDFs/text, with metadata. Root will strip transient API route IDs and keys before passing archive. Backend also defensively redacts all known credentials. Never run real models during export. Never overwrite existing run directories. Result GET route serves only files inside successfully registered export dirs, no symlinks/traversal; report read capability remains outside archived files.

`POST /local-api/configure` `{endpoint,apiKey,useDefault:boolean}` => `{endpoint:normalized real upstream,routeId:string}`. useDefault=true ignores supplied endpoint/key and uses original BigModel credential solely with its own official endpoint. false uses explicitly supplied key or empty key, never falls back to GLM secret. Routes are immutable and in memory. Per-model request to local `/v1/chat/completions` uses `X-Paperbench-Route:routeId`; server forwards to that route. No route header uses original default (legacy). Client scoring snapshots retain upstream real URL, not transient route.

Browser config state stores editable real endpoint; PB local transport is registered with upstream+local endpoint+routeId+token in closures, and rewrites fetch target only, leaving scoring protocol snapshots unchanged. Outgoing audit request bodies and exported archives exclude tokens and route IDs.

UI controls: apiMode(default/custom), existing endpoint/model/apiKey and generating settings; inputPaths textarea, recursiveInput checkbox, dropZone, paperFiles file picker, folderFiles directory picker, pickInputFiles, pickInputFolder, readPathsBtn; outputPath, pickOutputFolder, autoSaveReport checkbox, saveReportBtn, outputStatus. Preserve all original IDs and event signatures used by offline exporter. Existing repeats/concurrency IDs can be moved into first-visible run settings, one instance each. Prefer 1–30 repeats (currently core allows 3–30; root will update config bounds with explicit low-n statistical messaging).

App ownership: UI agent app.js/template.html/style.css plus its new tests. Root: start_local.py/local_proxy.py/transport.js/core config bounds/run_tests integration. Files/report agent: local_workspace.py/local_workspace_test.py. Export agent: export_offline.cjs/offline_v2.test.cjs + README workflow update when finalized.

## v2.2 PDF original input

`/local-files/read` and `/local-files/upload` include `bytes` with the original byte count. Original PDF bytes remain in the authenticated in-memory source cache even if optional text extraction is unavailable. Non-PDF decoding errors still fail normally.

POST `/local-files/pdf-check` accepts `{hashes:[sha256,...]}` and verifies that 1–30 requested PDFs are cached, have PDF headers, and match their SHA-256 values. It never calls a model.

In PDF mode, frozen papers carry `pdf:{sha256,size}` and the protocol carries `pdfInputs`. Model requests recorded in the archive use `file_url.url: "paperbench-pdf:<sha256>"`. The local model gateway resolves only existing cache entries, validates their bytes, and replaces that reference with `data:application/pdf;base64,...` in the POST body sent to the configured upstream. No filesystem path is resolved from the reference. No text fallback occurs. Each evaluation request includes only one PDF; plaintext paper input is omitted from that request. Archived text remains a local quote-verification corpus.

The PDF input parameter and PDF prompt are protocol fields; original hashes and sizes are part of the frozen batch snapshot. Restoring a batch requires the same PDFs to be cached again. Missing references fail before upstream traffic. Old text and image protocols remain unchanged.
