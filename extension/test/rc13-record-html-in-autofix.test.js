// Regression for RC13 Issue #2 (console.log 2026-07-27 02:30):
//
// User reported reaction/comment/share counts (点赞数/评论数/转发数) not
// extracted from Facebook even after annotation + autoFix iterations. The
// LLM acknowledged its selectors were "too specific (matching exact aria-
// labels like '赞' or '发表评论')" — it was targeting the LIKE BUTTON rather
// than the count-bearing span next to / inside it. Even with full-page HTML
// in the prompt, the LLM couldn't see WHERE the count text lives because:
//
//   1. The pageSnapshot.html sent to the LLM is cleaned/sanitized, and the
//      sanitizer had stripped the nested spans carrying the counts.
//   2. The per-field selector diagnostics show matchCount + sampleTexts
//      for selectors the LLM ALREADY TRIED — not the DOM neighborhood
//      those selectors were supposed to target.
//
// Fix: when $extractList matches at least one container, capture that
// container's outerHTML and surface it as a RECORD HTML block in the
// autoFix prompt. This gives the LLM a concrete DOM view of one record
// so it can discover "the count is in a nested span, not the button".
//
// This test uses JSDOM to construct a realistic record DOM, runs the
// real computeExtractListDiagnostics against it, and verifies:
//   - firstContainerHtml is populated from outerHTML
//   - the HTML is trimmed/capped as documented
//   - summarizeAllStepDiagnostics emits it in the prompt
//
// Generic by design — works for any site, any missing field. NOT FB-specific.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  computeExtractListDiagnostics
} = require('../lib/list-extract-ops');
const {
  summarizeAllStepDiagnostics
} = require('../lib/wizard-utils');

function makeRecordDom() {
  // Mirrors the shape of a generic "list item with a count-bearing span
  // nested inside a button" — Twitter, FB, Reddit, etc. all have this
  // pattern. The LLM's mistake is to target the button by aria-label and
  // miss the count span inside it.
  const html = `
    <div class="post" role="article">
      <div class="post-header">
        <a class="author" href="/u/alice">Alice</a>
        <span class="time">2h</span>
      </div>
      <p class="body">Hello world</p>
      <div class="actions">
        <button aria-label="Like"><span class="count">42</span></button>
        <button aria-label="Comment"><span class="count">7</span></button>
        <button aria-label="Share"><span class="count">3</span></button>
      </div>
    </div>`;
  const dom = new JSDOM('<!DOCTYPE html><body>' + html + '</body>');
  return dom.window.document.querySelector('.post');
}

describe('RC13 — firstContainerHtml capture (Issue #2 fix)', () => {
  it('computeExtractListDiagnostics captures firstContainerHtml when container matches', () => {
    const record = makeRecordDom();
    // Wrap in an array since $extractList receives a list of containers.
    // Use a bad-by-design fieldMap mirroring the FB incident: likeCount
    // targets the BUTTON by aria-label, missing the nested span.count.
    const fieldMap = {
      author: '.author',
      likeCount: 'button[aria-label="Like"]'
    };
    const diag = computeExtractListDiagnostics([record], fieldMap, '.post');

    assert.equal(diag.api, 'extractList');
    assert.equal(diag.containerMatches, 1);
    assert.ok(typeof diag.firstContainerHtml === 'string',
      'firstContainerHtml must be a string when at least one container matched');
    assert.ok(diag.firstContainerHtml.length > 0,
      'firstContainerHtml must not be empty');
    // The record HTML must contain the nested count span — that's the whole
    // point. Without this assertion, a regression that drops outerHTML would
    // silently disable Issue #2's fix.
    assert.ok(diag.firstContainerHtml.indexOf('count') !== -1,
      'firstContainerHtml must preserve nested elements: ' + diag.firstContainerHtml);
    assert.ok(diag.firstContainerHtml.indexOf('42') !== -1,
      'firstContainerHtml must preserve the count text: ' + diag.firstContainerHtml);
  });

  it('firstContainerHtml is null when no containers match', () => {
    const diag = computeExtractListDiagnostics([], { f: '.x' }, '.post');
    assert.equal(diag.containerMatches, 0);
    assert.equal(diag.firstContainerHtml, null,
      'firstContainerHtml must be null when container array is empty');
  });

  it('firstContainerHtml is null when container has no outerHTML (stub elements)', () => {
    // Pure-object stubs (used in selector-diagnostics.test.js) don't define
    // outerHTML. The helper must degrade gracefully rather than throwing.
    const stub = { querySelector: () => null };
    const diag = computeExtractListDiagnostics([stub], { f: '.x' }, '.post');
    assert.equal(diag.firstContainerHtml, null);
  });

  it('firstContainerHtml is capped near 2000 chars, head+tail with truncation marker (RC59)', () => {
    // Build a record whose outerHTML exceeds the cap. RC59: the cap is a
    // head+tail split (metric attributes cluster at the END of record
    // markup; the old head-only cap amputated that evidence).
    const longBody = 'x'.repeat(3000);
    const dom = new JSDOM('<!DOCTYPE html><body><div class="post"><p>' + longBody + '</p></div></body>');
    const record = dom.window.document.querySelector('.post');
    const diag = computeExtractListDiagnostics([record], { body: 'p' }, '.post');
    assert.ok(diag.firstContainerHtml.length <= 2060,
      'firstContainerHtml must be capped (got ' + diag.firstContainerHtml.length + ')');
    assert.match(diag.firstContainerHtml, /…\[truncated \d+ chars, middle cut\]…/,
      'marker must disclose the original length');
    assert.ok(diag.firstContainerHtml.startsWith('<div class="post">'),
      'head prefix kept');
    assert.ok(diag.firstContainerHtml.endsWith('</div>'),
      'tail suffix kept — end-of-record evidence survives (RC59)');
  });

  it('firstContainerHtml collapses whitespace runs (no huge indented blocks)', () => {
    const indented = `
      <div class="post">
        <p>hi</p>
      </div>`;
    const dom = new JSDOM('<!DOCTYPE html><body>' + indented + '</body>');
    const record = dom.window.document.querySelector('.post');
    const diag = computeExtractListDiagnostics([record], { p: 'p' }, '.post');
    assert.ok(diag.firstContainerHtml.indexOf('\n') === -1 || diag.firstContainerHtml.indexOf('\n') === diag.firstContainerHtml.length - 1,
      'firstContainerHtml must be single-line after whitespace collapse');
    assert.ok(!/\s{2,}/.test(diag.firstContainerHtml),
      'firstContainerHtml must not contain runs of 2+ whitespace chars');
  });

  it('summarizeAllStepDiagnostics emits RECORD HTML block for $extractList calls', () => {
    const record = makeRecordDom();
    const fieldMap = { likeCount: 'button[aria-label="Like"]' };
    const diag = computeExtractListDiagnostics([record], fieldMap, '.post');
    const events = [{
      type: 'STEP_ITERATION',
      stepId: '4',
      iteration: 1,
      resultPreview: '{likeCount:""}',
      selectorDiagnostics: [diag]
    }];
    const steps = [{ id: '4', name: 'extract' }];
    const out = summarizeAllStepDiagnostics(events, steps);
    assert.ok(out.indexOf('RECORD HTML') !== -1,
      'summarize output must include RECORD HTML block');
    assert.ok(out.indexOf('first container\'s actual outerHTML') !== -1,
      'summarize output must explain what RECORD HTML is');
    assert.ok(out.indexOf('42') !== -1,
      'summarize output must contain the count text from the record');
    assert.ok(out.indexOf('button aria-label="Like"') !== -1,
      'summarize output must preserve the button element so LLM sees where counts live');
  });

  it('summarizeAllStepDiagnostics omits RECORD HTML block when firstContainerHtml is null', () => {
    // Old-style stub containers without outerHTML — don't surface an empty block.
    const stub = { querySelector: () => null };
    const diag = computeExtractListDiagnostics([stub], { f: '.x' }, '.post');
    const events = [{
      type: 'STEP_ITERATION',
      stepId: '4',
      iteration: 1,
      resultPreview: '{}',
      selectorDiagnostics: [diag]
    }];
    const steps = [{ id: '4', name: 'extract' }];
    const out = summarizeAllStepDiagnostics(events, steps);
    assert.ok(out.indexOf('RECORD HTML') === -1,
      'no RECORD HTML block when firstContainerHtml is null — avoids cluttering prompt');
  });
});
