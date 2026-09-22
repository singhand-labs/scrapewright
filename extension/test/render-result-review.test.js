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

function loadRenderResultReview(report) {
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
});

describe('presentSessionCompletion STALE LIST (source audit)', () => {
  it('hasArtifact branch: renderResultReview() runs AFTER await testScript()', () => {
    const body = sliceFn(WIZARD_SRC, 'async function presentSessionCompletion()', '\nfunction showSessionFeedbackPanel');
    const rr = body.lastIndexOf('renderResultReview()');
    const ts = body.indexOf('await testScript()');
    assert.ok(rr > -1 && ts > -1);
    assert.ok(rr > ts, 'the LAST renderResultReview call (hasArtifact branch) must follow the fresh testScript run');
  });
});
