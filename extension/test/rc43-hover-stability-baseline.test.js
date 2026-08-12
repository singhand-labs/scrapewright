// RC43 audit: content-stability + non-empty + baseline-diff in domHover.
//
// ELEVENTH hover-family incident. console.log 2026-08-12 (post-RC42) showed
// RC42's three fixes (dist cap 600, source-before-dist, REQUIRED_OUTPUT_MISSING
// autoFix) didn't resolve the symptom. New failure mode: domHover returned
// htmlSnippet of:
//   (1) EMPTY pre-allocated portal wrapper: `<div class="x1exxf4d ..."></div>`
//       (FB pre-allocates a `role="dialog"` wrapper, popoverSelector `div[role=dialog]`
//       matches it on every tick, domHover's path (a) breaks immediately and
//       returns the empty outerHTML).
//   (2) Page chrome containing top-nav (首页/好友/...): auto_discover picked
//       a large posAbsolute DIV (the popup layer that holds page chrome).
//
// Architectural flaw: popoverSelector MATCH ≠ popover CONTENT RENDERED. The
// path (a) "match + visible → break" check accepts empty pre-existing
// wrappers. The path (b) "best of pool" picks pre-existing chrome because
// it ties/wins on posAbsolute + has content + is stable.
//
// Three-gate fix (RC43):
//   1. NON-EMPTY: childElementCount > 0 OR textContent.trim().length >= 20.
//      Rejects truly empty wrappers (no children, no meaningful text).
//   2. BASELINE-DIFF: outerHTML must DIFFER from a T0 baseline sample taken
//      BEFORE hover dispatch. Catches pre-existing elements (popover wrappers
//      pre-allocated, page chrome) that don't change during the hover window.
//   3. STABLE: same outerHTML across two consecutive 100ms samples of the
//      SAME element. Catches mid-render states (content streaming in).
//
// For path (a): baseline is the popoverSel-matched element's outerHTML at T0.
// For path (b): baseline is a Set of outerHTMLs of every element returned by
// elementsFromPoint at cursor + cardinal offsets at T0. Candidates are
// rejected during scoring when source!=='added' AND outerHTML is in the set.
//
// Source-text audit pattern: domHover runs in the content script where
// chrome.* + page DOM are available, so unit tests cannot exercise it
// directly. Audit by grepping the source for the diagnostic markers.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceDomHover(src) {
  const start = src.indexOf('async function domHover(');
  const end = src.indexOf('async function domOpenTab(', start);
  assert.ok(start > -1 && end > start, 'domHover must be sliceable');
  return src.slice(start, end);
}

describe('RC43: domHover samples popover baseline BEFORE hover dispatch', () => {
  it('captures popoverBaseline (outerHTML of popoverSel match at T0)', () => {
    // Without baseline, path (a) cannot distinguish "popoverSel matched an
    // empty pre-allocated wrapper" from "popoverSel matched a hovercard that
    // just mounted". The baseline is the comparison anchor.
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/popoverBaseline\s*=/.test(body),
      'domHover must declare a popoverBaseline variable. It holds the outerHTML ' +
      'of the popoverSel-matched element sampled BEFORE hover dispatch.');
    assert.ok(/popoverBaseline\s*=\s*[^;]*querySelectorDeep\s*\(\s*popoverSel/.test(body) ||
      /querySelectorDeep\s*\(\s*popoverSel[^)]*\)[^;]*popoverBaseline/.test(body),
      'popoverBaseline must be sampled by calling querySelectorDeep(popoverSel) BEFORE hover dispatch. ' +
      'The whole point is to compare against the pre-hover state.');
  });

  it('samples baseline BEFORE the hover is dispatched (not after)', () => {
    // If baseline is sampled after hover dispatch, the hovercard may have
    // already mounted and the baseline would include the hovercard content —
    // defeating the purpose. Baseline must be sampled before TRUSTED_HOVER_REQUEST.
    const body = sliceDomHover(readSrc('content-script.js'));
    const baselineIdx = body.indexOf('popoverBaseline =');
    assert.ok(baselineIdx > -1, 'popoverBaseline assignment must exist');
    const hoverReqIdx = body.indexOf('TRUSTED_HOVER_REQUEST');
    assert.ok(hoverReqIdx > -1, 'TRUSTED_HOVER_REQUEST must exist');
    assert.ok(baselineIdx < hoverReqIdx,
      'popoverBaseline must be sampled BEFORE TRUSTED_HOVER_REQUEST is sent. ' +
      'Sampling after dispatch defeats the baseline-diff check (hovercard may already be mounted).');
  });
});

describe('RC43: domHover path (a) requires non-empty + baseline-diff + stable', () => {
  it('does NOT break path (a) immediately on first visible match', () => {
    // The prior code did: `if (popFound && isElementVisible) { htmlSnippet = ...; break; }`.
    // That accepts empty pre-allocated wrappers. RC43 requires three gates to
    // pass before break.
    const body = sliceDomHover(readSrc('content-script.js'));
    // The path (a) block must reference hasContent + differsFromBaseline + stable
    // (or equivalent named flags) together — not break on visibility alone.
    const pathABlock = body.slice(body.indexOf('// Path (a): explicit selector match'),
      body.indexOf('// Path (a): explicit selector match') + 2000);
    assert.ok(/hasContent/i.test(pathABlock),
      'path (a) must compute a hasContent flag (childElementCount > 0 OR textContent.trim().length >= N).');
    assert.ok(/differsFromBaseline|baselineDiff/i.test(pathABlock),
      'path (a) must compute a differsFromBaseline flag (current outerHTML !== popoverBaseline).');
    assert.ok(/stable/i.test(pathABlock),
      'path (a) must compute a stable flag (current outerHTML === last sample of same element).');
  });

  it('defines a minimum text length constant for the non-empty gate', () => {
    // Magic number 20 (or similar) must be named so future maintainers see
    // the intent. Inline literal `length >= 20` works but is fragile.
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/MIN_HOVERCONTENT_TEXT_LEN|MIN_HOVER_CONTENT_TEXT_LEN|MIN_CONTENT_TEXT_LEN\s*=\s*\d+/.test(body),
      'domHover must define a named constant for the minimum text length in the non-empty gate ' +
      '(e.g. MIN_HOVERCONTENT_TEXT_LEN = 20).');
  });
});

describe('RC43: domHover samples baseline EFP elements and rejects unchanged pre-existing', () => {
  it('captures baselineEfpSnippets (Set of outerHTMLs at cursor + cardinal offsets at T0)', () => {
    // For path (b) auto_discover: efp candidates are pre-existing elements
    // caught by elementsFromPoint. Without a baseline, the scoring cascade
    // picks the best-positioned one — usually page chrome. With a baseline
    // outerHTML Set, we can reject candidates whose outerHTML hasn't changed.
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/baselineEfpSnippets|baselineEfpSet|baselineEfpOuterHTMLs\s*=/.test(body),
      'domHover must declare a baselineEfpSnippets (or similarly named) Set that stores ' +
      'the outerHTML of every element returned by elementsFromPoint at cursor + cardinal offsets, ' +
      'sampled BEFORE hover dispatch.');
    assert.ok(/baselineEfpSnippets|baselineEfpSet|baselineEfpOuterHTMLs\s*\.\s*add\s*\(/.test(body),
      'baseline EFP set must be populated via .add() calls during T0 sampling.');
  });

  it('rejects path (b) candidates whose outerHTML matches baseline (pre_existed_unchanged)', () => {
    // The rejection reason name matters — it surfaces in the diagnostic so
    // future hover bugs can be triaged from the SW log alone.
    const body = sliceDomHover(readSrc('content-script.js'));
    const scoringStart = body.indexOf('for (var ci = 0; ci < candidatePool.length');
    assert.ok(scoringStart > -1, 'candidate scoring loop must exist');
    const scoringBlock = body.slice(scoringStart, scoringStart + 4000);
    assert.ok(/pre_existed_unchanged|preExistedUnchanged|unchanged_from_baseline/i.test(scoringBlock),
      'candidate scoring must reject pre-existing-unchanged candidates with a named reject reason ' +
      '(pre_existed_unchanged or similar). The reason surfaces in the rejected[] diagnostic.');
    // The check should be: candidate's outerHTML is in baselineEfpSnippets AND source !== 'added'.
    assert.ok(/baselineEfpSnippets|baselineEfpSet|baselineEfpOuterHTMLs/.test(scoringBlock),
      'scoring loop must reference the baseline EFP set.');
  });
});

describe('RC43: domHover uses tighter polling interval for stability convergence', () => {
  it('uses 100ms (or shorter) sample interval inside the polling loop', () => {
    // The prior 250ms interval means stability check (two consecutive equal
    // samples) takes 500ms minimum. With 100ms, stability converges in 200ms.
    // Required because the total timeout budget (timeoutMs, default 3000)
    // must accommodate both the dwell gate AND multiple stability samples
    // AND multiple candidates being tried.
    const body = sliceDomHover(readSrc('content-script.js'));
    // Find setTimeout calls inside the polling loop; check at least one
    // uses <= 100ms. (We don't pin the exact number to allow tuning, but
    // the prior 250ms is too long for stability-based convergence.)
    const setTimeoutMatches = body.match(/setTimeout\s*\(\s*[a-z]+\s*,\s*(\d+)\s*\)/g) || [];
    const intervals = setTimeoutMatches.map(m => parseInt(m.match(/,\s*(\d+)/)[1], 10));
    const hasShortInterval = intervals.some(n => n <= 150);
    assert.ok(hasShortInterval,
      'domHover polling loop must include a setTimeout <= 150ms (recommended 100ms) for stability ' +
      'check convergence. Found intervals: ' + JSON.stringify(intervals));
  });
});

describe('RC43: domHover diagnostic surfaces baseline state for triage', () => {
  it('hover_request diagnostic includes popoverBaselineSampled flag', () => {
    // Without this flag, future incidents can't tell from the SW log whether
    // baseline sampling succeeded (and thus baseline-diff check was active)
    // or failed (and thus the check was a no-op).
    const body = sliceDomHover(readSrc('content-script.js'));
    const reqIdx = body.indexOf("notifyBackgroundDiagnostic('hover_request'");
    assert.ok(reqIdx > -1, 'hover_request diagnostic must exist');
    const reqBlock = body.slice(reqIdx, reqIdx + 800);
    assert.ok(/popoverBaselineSampled|baselineSampled/i.test(reqBlock),
      'hover_request diagnostic must include a popoverBaselineSampled (or similar) flag.');
  });

  it('hover_auto_discover diagnostic includes baselineEfpCount', () => {
    // The count tells future debuggers how many pre-existing elements were
    // filtered by the baseline-diff check. A high count with low passing
    // indicates the baseline is doing its job.
    const body = sliceDomHover(readSrc('content-script.js'));
    const autoIdx = body.indexOf("notifyBackgroundDiagnostic('hover_auto_discover'");
    assert.ok(autoIdx > -1, 'hover_auto_discover diagnostic must exist');
    const autoBlock = body.slice(autoIdx, autoIdx + 1500);
    assert.ok(/baselineEfpCount|baselineEfpSize|baselineEfp/.test(autoBlock),
      'hover_auto_discover diagnostic must include baselineEfpCount (or similar) so future ' +
      'incidents can see how many pre-existing elements were filtered by baseline-diff.');
  });
});
