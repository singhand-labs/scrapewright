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
  const ctx = {
    document: dom.window.document,
    wizardToolsBag: { getLastVerify: () => ({ report }) }
  };
  vm.createContext(ctx);
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
  it('covered detector keys are skipped; object detectors render a JSON snippet', () => {
    const list = loadRenderResultReview({
      detectors: {
        emptyFields: [{ field: 'x' }],
        siblingCountContrast: { populatedSibling: 'likes', tag: 'COUNT_FIELD_HIDDEN_VALUE' },
        unusedCaptures: null
      }
    });
    const text = list.textContent;
    assert.ok(!/检测器 emptyFields/.test(text), 'covered key emptyFields skipped');
    assert.match(text, /检测器 siblingCountContrast 有发现/);
    assert.match(text, /populatedSibling/);
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
