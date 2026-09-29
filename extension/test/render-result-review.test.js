// Code-review P2 regression tests: renderResultReview (wizard.js) —
// (a) relativeTimestamps entries are OBJECTS ({field,path,sampleValue}) and
//     must render 'path=sample', never '[object Object]';
// (b) STALE LIST: presentSessionCompletion's hasArtifact branch must call
//     renderResultReview AFTER await testScript() (fresh report, not stale);
// (c) the generic detector sweep skips the covered set and renders object
//     detectors as JSON snippets.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const WIZARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

function sliceFn(src, a, b) {
  const s = src.indexOf(a); assert.ok(s > -1, 'marker ' + a);
  const e = src.indexOf(b, s); assert.ok(e > s, 'end ' + b);
  return src.slice(s, e);
}

function loadRenderResultReview(report, wizardState) {
  const dom = new JSDOM('<div><div id="resultReviewList"></div><textarea id="sessionFeedbackText"></textarea></div>', { url: 'https://w.local/' });
  const WU_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
  const detStart = WU_SRC.indexOf('const DETECTOR_PLAIN = {');
  const detEnd = WU_SRC.indexOf('function explainDetectorFinding');
  const detBlock = WU_SRC.slice(detStart, detEnd);
  let depth = 0, i = WU_SRC.indexOf('function explainDetectorFinding');
  for (; i < WU_SRC.length; i++) {
    if (WU_SRC[i] === '{') depth += 1;
    else if (WU_SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const exFn = WU_SRC.slice(WU_SRC.indexOf('function explainDetectorFinding'), i + 1);
  const ctx = {
    document: dom.window.document,
    wizardToolsBag: { getLastVerify: () => ({ report }) },
    wizardState: wizardState || null,
    explainDetectorFinding: null
  };
  vm.createContext(ctx);
  vm.runInContext(detBlock + '\n' + exFn + '\nthis.__ex = explainDetectorFinding;', ctx);
  ctx.explainDetectorFound = ctx.__ex;
  ctx.explainDetectorFinding = ctx.__ex;
  const fn = sliceFn(WIZARD_SRC, 'function renderResultReview()', '\nasync function sendSessionFeedback');
  vm.runInContext(fn + '\nthis.__fn = renderResultReview;', ctx);
  ctx.__fn();
  return dom.window.document.getElementById('resultReviewList');
}

describe('renderResultReview behavioral (jsdom)', () => {
  it('relativeTimestamps OBJECT entries render path=sampleValue, not [object Object]', () => {
    const list = loadRenderResultReview({
      detectors: {
        relativeTimestamps: [
          { field: 'postTime', path: 'posts.postTime', sampleValue: '4 hours ago' },
          { field: 't2', path: 'posts.t2', sampleValue: 'yesterday' }
        ]
      }
    });
    const text = list.textContent;
    assert.match(text, /posts\.postTime=4 hours ago/);
    assert.match(text, /posts\.t2=yesterday/);
    assert.ok(!text.includes('[object Object]'), 'no [object Object] leak');
  });
  it('every detector renders through the plain-language map (107th log) — no bare keys, no [object Object]', () => {
    const list = loadRenderResultReview({
      detectors: {
        emptyFields: [{ field: 'x' }],
        siblingCountContrast: { populatedSibling: 'likes', tag: 'COUNT_FIELD_HIDDEN_VALUE' },
        unusedCaptures: null
      }
    });
    const text = list.textContent;
    // 107th contract: emptyFields is an ACTION finding with a readable title
    // (the old renderer skipped it as "covered" — the user never saw it).
    assert.match(text, /Fields empty in every record/);
    assert.match(text, /x/, 'the empty field name is named');
    // siblingCountContrast renders its plain advisory title, not a bare key.
    assert.match(text, /Count hidden in an attribute/);
    assert.ok(!/检测器 \w+ 有发现/.test(text), 'no raw detector-key rendering remains');
    assert.ok(!text.includes('[object Object]'), 'no [object Object] leak');
  });

  it('review #6: wizardState.lastCompletionError renders an action-level red row ahead of the stale report', () => {
    const staleReport = { detectors: { siblingCountContrast: { populatedSibling: 'likes', tag: 'COUNT_FIELD_HIDDEN_VALUE' } } };
    const list = loadRenderResultReview(staleReport, { lastCompletionError: 'Step "extract" failed: ELEMENT_NOT_FOUND' });
    const text = list.textContent;
    assert.match(text, /fresh end-to-end run of the current steps failed: Step "extract" failed: ELEMENT_NOT_FOUND/);
    assert.match(text, /fix the steps below before deploy/);
    assert.match(text, /Findings that need your decision/, 'the row lands in the action list, not the advisories');
    assert.match(text, /Count hidden in an attribute/, 'the stale report still renders below it');
    // Clean state: no error row (a successful fresh run must not show the banner).
    const clean = loadRenderResultReview(staleReport, { lastCompletionError: null });
    assert.doesNotMatch(clean.textContent, /fresh end-to-end run of the current steps failed/);
    // No report at all + an error: the row is the only content (previously
    // the early return rendered NOTHING).
    const only = loadRenderResultReview(null, { lastCompletionError: 'boom' });
    assert.match(only.textContent, /fresh end-to-end run of the current steps failed: boom/);
  });
});

describe('presentSessionCompletion STALE LIST (source audit)', () => {
  it('hasArtifact branch: renderResultReview() runs AFTER await testScript()', () => {
    const body = sliceFn(WIZARD_SRC, 'async function presentSessionCompletion()', '\nfunction showSessionFeedbackPanel');
    const rr = body.lastIndexOf('renderResultReview()');
    const ts = body.indexOf('await testScript()');
    assert.ok(rr > -1 && ts > -1);
    assert.ok(rr > ts, 'the LAST renderResultReview call (hasArtifact branch) must follow the fresh testScript run');
  });

  it('173c: the fresh testScript run is try/caught, the review renders after the catch, and the blessing is gated on !freshRunError', () => {
    // The 173rd incident: the model shipped an untested artifact version,
    // testScript ran its unverified scripts, THREW, and the whole
    // presentSessionCompletion aborted — the user got an empty review stage
    // (no status, no result, no fix opportunity, no service name).
    const body = sliceFn(WIZARD_SRC, 'async function presentSessionCompletion()', '\nfunction showSessionFeedbackPanel');
    // (a) the fresh run is wrapped and the catch handler records the error.
    assert.match(body, /try\s*\{\s*await testScript\(\);?\s*\}\s*catch\s*\(\s*(\w+)\s*\)\s*\{\s*freshRunError\s*=\s*\1/,
      'await testScript() wrapped in try/catch whose handler assigns freshRunError');
    // (b) the review renders AFTER the catch — a thrown run still reaches
    // the panel (with the error), never an empty stage.
    const tsIdx = body.indexOf('await testScript()');
    const catchIdx = body.indexOf('catch', tsIdx);
    const rrIdx = body.lastIndexOf('renderResultReview()');
    assert.ok(tsIdx > -1 && catchIdx > tsIdx, 'catch follows the fresh run');
    assert.ok(rrIdx > catchIdx, 'renderResultReview() follows the catch');
    // (c) the lastVerified blessing is gated on !freshRunError — a failed
    // fresh run must not bless the current (broken) version.
    assert.match(body, /if\s*\(\s*!freshRunError\s*\)\s*blessCurrentVersionIfGreen\s*\(/,
      'blessing call gated on !freshRunError');
    const helper = sliceFn(WIZARD_SRC, 'function blessCurrentVersionIfGreen(', '\nasync function presentSessionCompletion');
    assert.match(helper, /wizardState\.lastVerified\s*=/, 'the helper performs the guarded assignment');
  });

  it('review #1: the catch path navigates to phase 5 with the abort controller nulled FIRST (catch-only)', () => {
    // The thrown-run bug: goToPhase(5) only ran inside presentTestOutcome on
    // the happy path, so the review rendered into a HIDDEN phase 5 — and
    // navigating with a live controller logs a spurious "Test aborted".
    const body = sliceFn(WIZARD_SRC, 'async function presentSessionCompletion()', '\nfunction showSessionFeedbackPanel');
    const catchIdx = body.indexOf('} catch (eTS) {');
    assert.ok(catchIdx > -1, 'catch block located');
    const catchBody = body.slice(catchIdx, body.indexOf('}', body.indexOf('goToPhase(5);', catchIdx)));
    const nullIdx = catchBody.indexOf('wizardState.testAbortController = null;');
    const navIdx = catchBody.indexOf('goToPhase(5);');
    assert.ok(nullIdx > -1 && navIdx > -1, 'both the null and the navigation live in the catch');
    assert.ok(nullIdx < navIdx, 'the controller is nulled BEFORE goToPhase (no spurious abort log)');
    // The error is recorded for the review panel (review #6).
    assert.ok(catchBody.indexOf('wizardState.lastCompletionError =') > -1, 'the failure is recorded on wizardState');
    // Catch-only: no goToPhase elsewhere in the hasArtifact branch (the
    // happy path relies on testScript's own navigation — a second one here
    // would double-navigate; the artifact-less `else` branch is out of
    // scope and keeps its own landing navigation).
    const branchEnd = body.indexOf('} else {', catchIdx);
    const afterCatch = body.slice(catchIdx + catchBody.length, branchEnd);
    assert.ok(!/goToPhase\(/.test(afterCatch), 'no goToPhase outside the catch in the hasArtifact branch');
    // testScript() resets the banner at its start so a later green run
    // never shows the stale error row.
    const tsFn = sliceFn(WIZARD_SRC, 'async function testScript()', '\n// Shared post-run presentation');
    assert.match(tsFn, /wizardState\.lastCompletionError = null;/, 'each fresh run starts clean');
  });
});

// 175th round (review #36): the three USER-TRIGGERED testScript call sites
// (Retry Test button, runTestFromStep5, custom-input run) route through
// runTestScriptUserFacing — a thrown run surfaces in the log, a toast, and
// the review panel red row instead of dying as an unhandled rejection.
describe('175th round: user-triggered test runs surface failures', () => {
  const fs175 = require('fs');
  const SRC = fs175.readFileSync(require('path').join(__dirname, '../wizard.js'), 'utf8');
  const testScriptCallSites = () => {
    const sites = [];
    let idx = SRC.indexOf('await testScript()');
    while (idx !== -1) { sites.push(idx); idx = SRC.indexOf('await testScript()', idx + 1); }
    return sites;
  };

  it('runTestScriptUserFacing is defined and catches into log + toast + review row', () => {
    assert.match(SRC, /async function runTestScriptUserFacing\(\)/);
    const helperStart = SRC.indexOf('async function runTestScriptUserFacing()');
    const helperEnd = SRC.indexOf('\n}', helperStart);
    const body = SRC.slice(helperStart, helperEnd);
    assert.match(body, /lastCompletionError = /, 'records the failure for the review red row');
    assert.match(body, /appendLog\('Test run failed/, 'logs the failure');
    assert.match(body, /showToast\('Test run failed/, 'toasts the failure');
    assert.match(body, /renderResultReview\(\)/, 're-renders the review with the error');
  });

  it('every await testScript() site is one of the three sanctioned ones (helper, session completion, reverify)', () => {
    const sites = testScriptCallSites();
    assert.equal(sites.length, 3, 'exactly three bare awaits remain: inside runTestScriptUserFacing, presentSessionCompletion, and the reverify handler — got ' + sites.length);
    const helperIdx = SRC.indexOf('async function runTestScriptUserFacing()');
    const completionIdx = SRC.indexOf('async function presentSessionCompletion()');
    const reverifyIdx = SRC.indexOf("rvBtn.id = 'btnReverifyCurrent'");
    for (const s of sites) {
      const inHelper = s > helperIdx && s < SRC.indexOf('\n}', helperIdx);
      const inCompletion = s > completionIdx && s < SRC.indexOf('\nasync function ', completionIdx + 10);
      const inReverify = s > reverifyIdx && s < SRC.indexOf("});", reverifyIdx);
      assert.ok(inHelper || inCompletion || inReverify, 'bare await at offset ' + s + ' outside the sanctioned sites');
    }
  });

  it('the three user-triggered sites route through the wrapper', () => {
    const wrapped = SRC.split('await runTestScriptUserFacing();').length - 1;
    assert.equal(wrapped, 3, 'Retry Test, runTestFromStep5, and the custom-input run each call the wrapper');
  });
});
