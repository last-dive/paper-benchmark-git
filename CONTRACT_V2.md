# Core v2 contract (frozen 2026-09-08)

Archive envelope stays `schemaVersion:1`; review results distinguish `schemaVersion:2` from legacy results (missing schemaVersion or 1). Legacy scores and analysis semantics remain unchanged. Never mix v1/v2 successful reviews inside one batch; import/statistics reject a mixed batch. New transport must call `PB.parseReview(content,text,{expectedVersion:2})`; old import may call without an expected version. `PB.parseReviewV2(content,text)` is a strict alias.

Exports: `PB.REVIEW_SCHEMA_VERSION=2`, `PB.RUBRIC_VERSION='PB-RUBRIC-2.0'`, `PB.CRITERIA[dimensionId]` (four `{id,name,anchors:{0..4}}` each), `PB.SCORE_RULES`, existing `PB.DIMS` and statistics API. `PB.makeSystemPrompt(type,anchors)` emits v2. New batch protocol must record `reviewSchemaVersion:2`, `rubricVersion:PB.RUBRIC_VERSION`; never resume old batches with v2 transport.

Model reply (exactly five dimension IDs, four unique criterion IDs from PB.CRITERIA per dimension):

```json
{
  "schemaVersion": 2,
  "analysis": {
    "researchType": "theory|simulation|experimental|engineering|mixed",
    "typeRationale": "具体分类依据",
    "centralClaims": [{
      "id": "C1", "claim": "中心主张", "scope": "声明适用域",
      "evidenceRefs": [{"dimensionId":"evidence","evidenceIndex":0}],
      "supportAssessment": "可见支撑及其力度", "counterEvidence": "可见反证或明确未发现/不可见",
      "alternativeExplanations": "替代解释与是否已排除",
      "verdict": "supported|partial|unsupported|unassessable"
    }],
    "strongestSupport": {"text":"最强支撑及其限制","evidenceRefs":[{"dimensionId":"evidence","evidenceIndex":0}]},
    "strongestChallenge": {"text":"最强反对理由/限制及其依据，无法确认要明说","evidenceRefs":[]},
    "verificationLimits": "材料可见性、外部核查、识别与判断限制"
  },
  "dimensions": [{
    "id": "contribution", "evidence": [{"quote":"至少8个非空白字符的连续原文","location":"章节/表/式/物理页"}],
    "items": [{"id":"problem","level":3,"status":"assessable","basis":"该项具体依据和分档理由","evidenceIndices":[0],"missing":"尚缺内容；没有则空字符串"}],
    "reason":"该维主要优势与缺口，至少16非空白字",
    "improvement":"限学术报告和证据核查的下一步，至少8非空白字"
  }],
  "revisions": [{"priority":1,"dimensionId":"rigor","claimIds":["C1"],"action":"学术呈现或核查行动","rationale":"为何优先"}],
  "summary":"中心优点和主要瓶颈",
  "limitations":"此次审查限制"
}
```

Evidence indices are **zero-based** and dimension-local; cross-dimension refs carry dimensionId. `centralClaims`:1–8; `revisions`:1–8; priority 1/2/3. Each dimension has 0–5 quotes, each item 0–5 indices. `status` is `assessable` or `unavailable`: assessable requires integer level 0–4 and at least one cited index; unavailable requires `level:null` and a specific `missing` description. Visible absence/contradiction is a supported low grade; unseen/missing input is unavailable, never grade 0. No model-provided aggregate score is accepted as authoritative.

Normalized item adds `name`, `effectiveLevel` (null when unavailable or no referenced quote actually matches), `matchedEvidenceIndices`, `scorable`. Normalized dimension retains legacy renderer fields `id,score,evidence,reason,improvement`, adds `items`, `rawScore`, `scoreCap`, `capReasons:[{itemId,level,cap}]`, `completeness:{assessedItems,requiredItems:4,unavailableItems,unmatchedItems}`, `scoringRuleVersion`. All four items must be scorable, otherwise dimension score=null. No averaging over surviving items.

Local score = `1 + 9 * mean(effectiveLevel)/4` (no rounding or rank normalization). Fixed caps: any item level0 ⇒ cap4; otherwise any level1 ⇒ cap6; otherwise any level2 ⇒ cap8; all≥3 ⇒ cap10. Final score=min(rawScore,cap); each triggering item is recorded. Level0/1/2 signify visible serious/important/remaining partial gaps using item-specific behavioral anchors. Caps are fixed before seeing the batch. No target score/distribution/rank stretching.

Normalized quotes carry `matched`; unmatched warnings stay in result.warnings. Cross refs add `matched`, and each claim/support/challenge adds `matchedEvidenceCount`, `citationStatus` (`matched_text_only` or `unverified`): matching proves text presence only, not actual logical support or truth. Reasons and analysis are model reports, not external fact verification. Normalized replies can be parsed/imported/exported again without losing fields or changing scores; derived fields are recomputed from original levels and quotes.

Criterion IDs (order fixed):

| Dimension | IDs |
|---|---|
| contribution | problem, novelty, value, scope |
| rigor | assumptions, derivation, reproducibility, error_control |
| evidence | central_support, coverage, uncertainty, alternatives |
| fairness | relevance, conditions, resources, reporting |
| claims | traceability, strength, scope_limits, limitations |

Existing median/SD/MAD/paired-threshold testing semantics stay unchanged. V2 optional summary adds criterion-level repeated-grade statistics separately; never compares them to legacy direct scores. Recommendations are limited to academic reporting, evidence presentation, verification and limitations; no new weapons/guidance engineering designs or optimization.

Implemented `PB.summarize` v2 extras: `criteria[dimensionId][itemId]={name,n,median,mean,sd,mad,min,max,levelCounts:{0..4},unavailableRuns,unmatchedRuns}`; only scorable effective grades enter these grade statistics. `stability={description,dimensionSDThreshold:0.5,flaggedDimensions:[dimensionId]}` describes original 1–10 score SD. Legacy summaries keep exactly their original fields. No grade SD is represented as score SD.


Parser compatibility (`PB-PARSER-2.2`): new reviews must be strict JSON objects. A v2 object may additionally have at most two redundant closing `}`/`]` characters after an otherwise complete valid object; only this tail is removed. No internal repair, trailing prose, second value or code is accepted. The original response remains in the attempt archive. Normalized reviews record `parserVersion`, `formatWarnings`, and `normalization` (operation, removed suffix/count and lengths); warnings survive export/import without duplication. Legacy v1 remains strict.

Quote matching additionally recognizes ASCII words hyphenated at a physical line break, either by joining or retaining the hyphen. It does not strip inline hyphens or alter mathematical symbols. The original quote is retained; `matchedMethod` identifies `nfkc_whitespace` or the line-break-compatible method. The prompt prefers 20–120-character continuous prose quotes while mathematical content is checked against page images. Counter-evidence and alternative-explanation strings accept a three-character “未发现”, but the prompt asks for the scope and grounds of that finding. Missing criteria or invalid references still fail validation; unmatched evidence remains unscorable.
