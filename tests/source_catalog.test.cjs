'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Like the existing core_v2 suite, the runner stages core.js next to tests.
require('./core.js');
const PB = globalThis.PB;
const { makeV2Review, TEXT } = require('./v2_fixture.cjs');
const MODE = { expectedVersion: 2, citationMode: 'source_ids_v1' };
const clone = value => JSON.parse(JSON.stringify(value));
const sourceText = 'Source paragraph: the observed derivative is V̇ ≤ 0, the angle is 90◦, and an extraction glyph is \u0006CL. Keep symbols exactly as supplied.\nThis fixture audits software citation anchoring only; it is not a scientific finding.\fPage two is a separate physical source page with a distinct explanatory sentence.';
function sourceReview(text = sourceText, options = {}) {
  const input = makeV2Review(text, options);
  const catalog = PB.buildSourceCatalog(text);
  for (const dimension of input.dimensions) dimension.evidence = [{ sourceId: catalog[0].id }];
  return input;
}

test('source catalog is deterministic with exact source offsets and physical-page boundaries', () => {
  const text = sourceText + '\f' + 'A repeated readable source sentence. '.repeat(40);
  const catalog = PB.buildSourceCatalog(text);
  assert.ok(catalog.length >= 4);
  assert.deepEqual(PB.buildSourceCatalog(text), catalog);
  const ids = new Set();
  for (const [index, entry] of catalog.entries()) {
    assert.equal(entry.id, `Q${String(index + 1).padStart(5, '0')}`);
    assert.ok(!ids.has(entry.id)); ids.add(entry.id);
    assert.ok(Number.isInteger(entry.start) && Number.isInteger(entry.end));
    assert.ok(entry.start >= 0 && entry.end > entry.start && entry.end <= text.length);
    assert.equal(entry.quote, text.slice(entry.start, entry.end));
    assert.ok(entry.quote.length <= 420);
    assert.ok(!entry.quote.includes('\f'));
    assert.equal(entry.page, text.slice(0, entry.start).split('\f').length);
  }
});

test('an empty or whitespace-only source has no manufactured source entries', () => {
  for (const text of ['', ' \n\t\r\f ']) assert.deepEqual(PB.buildSourceCatalog(text), []);
});

test('source IDs retain exact extracted math glyphs and derive unchanged five-dimensional scores', () => {
  const input = sourceReview(sourceText, { level: 4, levels: { rigor: [1, 4, 4, 4] } });
  const parsed = PB.parseReview(input, sourceText, MODE);
  const first = PB.buildSourceCatalog(sourceText)[0];
  assert.deepEqual(parsed.dimensions.map(d => d.score), [10, 6, 10, 10, 10]);
  for (const dimension of parsed.dimensions) {
    const evidence = dimension.evidence[0];
    assert.equal(evidence.quote, first.quote);
    assert.equal(evidence.matched, true);
    assert.equal(evidence.matchedMethod, 'source_id_exact');
    assert.equal(evidence.sourceId, first.id);
    assert.equal(evidence.sourceStart, first.start);
    assert.equal(evidence.sourceEnd, first.end);
    assert.equal(evidence.sourcePage, first.page);
    assert.equal(dimension.completeness.assessedItems, 4);
  }
  assert.match(parsed.dimensions[0].evidence[0].quote, /V̇ ≤ 0/);
  assert.match(parsed.dimensions[0].evidence[0].quote, /90◦/);
  assert.match(parsed.dimensions[0].evidence[0].quote, /\u0006CL/);
});

test('canonical source evidence cannot be overwritten by model-supplied quote or location', () => {
  const input = sourceReview();
  input.dimensions[0].evidence[0].quote = 'Model invented content must never replace the referenced source.';
  input.dimensions[0].evidence[0].location = 'Invented page 999';
  const parsed = PB.parseReview(input, sourceText, MODE);
  const first = PB.buildSourceCatalog(sourceText)[0];
  assert.equal(parsed.dimensions[0].evidence[0].quote, first.quote);
  assert.notEqual(parsed.dimensions[0].evidence[0].location, 'Invented page 999');
  assert.deepEqual(PB.parseReview(parsed, sourceText, MODE), parsed);
});

test('unknown and case-changed source IDs fail even when a valid fallback quote is present', () => {
  for (const badId of ['Q99999', 'q00001', 'Q00001-extra', ' Q00001 ']) {
    const input = sourceReview();
    input.dimensions[0].evidence[0] = { sourceId: badId, quote: sourceText.slice(0, 50), location: 'page 1' };
    assert.throws(() => PB.parseReview(input, sourceText, MODE));
  }
});

test('source-ID mode does not invent missing item references, levels or unavailable scores', () => {
  for (const mutate of [
    r => r.dimensions[0].items[0].evidenceIndices = [],
    r => r.dimensions[0].items[0].evidenceIndices = [1],
    r => r.dimensions[0].items[0].level = '3',
    r => r.dimensions[0].items[0].level = 2.5,
  ]) {
    const input = sourceReview(); mutate(input);
    assert.throws(() => PB.parseReview(input, sourceText, MODE));
  }
  const input = sourceReview();
  Object.assign(input.dimensions[0].items[0], { status: 'unavailable', level: null, evidenceIndices: [], missing: 'Required source material is explicitly unavailable in this synthetic test.' });
  const parsed = PB.parseReview(input, sourceText, MODE);
  assert.equal(parsed.dimensions[0].score, null);
  assert.equal(parsed.dimensions[0].items[0].effectiveLevel, null);
  assert.equal(parsed.dimensions[0].completeness.assessedItems, 3);
});

test('an ancillary priority outside 1–3 is retained as a warning without discarding source-backed grades', () => {
  const input = sourceReview();
  input.revisions[0].priority = 4;
  const parsed = PB.parseReview(input, sourceText, MODE);
  assert.ok(parsed.dimensions.every(d => d.score === 7.75));
  assert.equal(parsed.revisions[0].priority, null);
  assert.equal(parsed.revisions[0].reportedPriority, 4);
  assert.ok(parsed.metadataWarnings.length > 0);
  assert.deepEqual(PB.parseReview(parsed, sourceText, MODE), parsed);
  const legacy = makeV2Review(TEXT); legacy.revisions[0].priority = 4;
  assert.throws(() => PB.parseReviewV2(legacy, TEXT));
});

test('old quote protocol remains strict and a source ID requires the explicit new citation mode', () => {
  assert.throws(() => PB.parseReviewV2(sourceReview(), sourceText));
  const literal = makeV2Review(TEXT);
  const old = PB.parseReviewV2(literal, TEXT);
  const same = PB.parseReview(literal, TEXT, MODE);
  assert.deepEqual(same.dimensions, old.dimensions);
  const unrelated = clone(literal);
  unrelated.dimensions[0].evidence[0].quote = 'This unrelated statement does not exist anywhere in the synthetic source.';
  assert.equal(PB.parseReview(unrelated, TEXT, MODE).dimensions[0].score, null);
});

test('unknown auxiliary verdict is unassessable with its original value retained and never changes item grades', () => {
  const input = sourceReview(); input.analysis.centralClaims[0].verdict = 'uncertain';
  const parsed = PB.parseReview(input, sourceText, MODE), claim = parsed.analysis.centralClaims[0];
  assert.ok(parsed.dimensions.every(d => d.score === 7.75));
  assert.equal(claim.verdict, 'unassessable');
  assert.equal(claim.reportedVerdict, 'uncertain');
  assert.ok(parsed.metadataWarnings.some(w => w.original === 'uncertain'));
  assert.deepEqual(PB.parseReview(parsed, sourceText, MODE), parsed);
});

test('invalid and duplicate auxiliary references do not count as located evidence and keep audit warnings on reparse', () => {
  const input = sourceReview();
  input.analysis.centralClaims[0].evidenceRefs = [
    { dimensionId: 'evidence', evidenceIndex: 0 },
    { dimensionId: 'missing-dimension', evidenceIndex: 0 },
    { dimensionId: 'evidence', evidenceIndex: 999 },
    { dimensionId: 'evidence', evidenceIndex: 0 },
  ];
  const parsed = PB.parseReview(input, sourceText, MODE), claim = parsed.analysis.centralClaims[0];
  assert.ok(parsed.dimensions.every(d => d.score === 7.75));
  assert.equal(claim.evidenceRefs.length, 1);
  assert.equal(claim.matchedEvidenceCount, 1);
  assert.equal(claim.citationStatus, 'matched_text_only');
  assert.equal(parsed.metadataWarnings.length, 3);
  assert.deepEqual(PB.parseReview(parsed, sourceText, MODE), parsed);
});

test('auxiliary claims with only invalid references remain unverified without lowering or inventing dimension grades', () => {
  const input = sourceReview();
  input.analysis.centralClaims[0].evidenceRefs = [{ dimensionId: 'rigor', evidenceIndex: 99 }];
  input.analysis.strongestSupport.evidenceRefs = 'invalid-array';
  const parsed = PB.parseReview(input, sourceText, MODE);
  for (const item of [parsed.analysis.centralClaims[0], parsed.analysis.strongestSupport]) {
    assert.deepEqual(item.evidenceRefs, []);
    assert.equal(item.matchedEvidenceCount, 0);
    assert.equal(item.citationStatus, 'unverified');
  }
  assert.ok(parsed.dimensions.every(d => d.score === 7.75));
  assert.ok(parsed.metadataWarnings.some(w => w.original === 'invalid-array'));
  assert.deepEqual(PB.parseReview(parsed, sourceText, MODE), parsed);
});

test('missing auxiliary prose remains a visibly missing value with its original audit warning after reparse', () => {
  const input = sourceReview(); input.summary = null; input.analysis.strongestSupport.text = null;
  const parsed = PB.parseReview(input, sourceText, MODE);
  assert.ok(parsed.dimensions.every(d => d.score === 7.75));
  assert.match(parsed.summary, /未提供有效内容/);
  assert.match(parsed.analysis.strongestSupport.text, /未提供有效内容/);
  assert.equal(parsed.metadataWarnings.filter(w => w.original === null).length, 2);
  assert.deepEqual(PB.parseReview(parsed, sourceText, MODE), parsed);
});

test('malformed or oversized prior auxiliary warnings stay bounded, cannot alter grades and survive two reparses without amplification', () => {
  const cases = [
    { not: 'an array' },
    [null, {}, { path: 99, message: 'wrong path type', original: null }],
    [{ path: 'x'.repeat(301), message: 'overlong path', original: 0 }],
    Array.from({length: 513}, () => ({ path: 'many', message: 'too many warnings', original: null })),
    [{ path: 'large', message: 'oversized overall payload', original: 'x'.repeat(1100000) }],
    [{ path: 'escaped', message: 'oversized escaped original', original: '\\'.repeat(20000) }],
  ];
  for (const metadataWarnings of cases) {
    const input = sourceReview(); input.metadataWarnings = metadataWarnings;
    const parsed = PB.parseReview(input, sourceText, MODE);
    assert.ok(parsed.dimensions.every(d => d.score === 7.75));
    assert.ok(parsed.dimensions.every(d => d.evidence[0].matchedMethod === 'source_id_exact'));
    assert.ok(parsed.metadataWarnings.length > 0 && parsed.metadataWarnings.length <= 512);
    assert.ok(JSON.stringify(parsed.metadataWarnings).length <= 1048576);
    const again = PB.parseReview(parsed, sourceText, MODE);
    assert.deepEqual(again, parsed);
    assert.deepEqual(PB.parseReview(again, sourceText, MODE), parsed);
  }
});
