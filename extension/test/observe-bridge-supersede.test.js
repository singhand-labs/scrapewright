// Code-review P3 regressions: observe bridge supersede (#11) + userObserve
// try/catch fallback.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createSessionTools } = require('../lib/session-tools');

const WIZARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
function sliceFn(src, a, b) {
  const s = src.indexOf(a); assert.ok(s > -1, 'marker ' + a);
  const e = src.indexOf(b, s); assert.ok(e > s, 'end ' + b);
  return src.slice(s, e);
}

function loadBridge() {
  const dom = new JSDOM('<div><div id="userObservePanel" class="hidden"></div>' +
    '<div id="userObserveQuestion"></div><div id="userObserveHint"></div>' +
    '<textarea id="userObserveAnswer"></textarea></div>', { url: 'https://w.local/' });
  const ctx = {
    document: dom.window.document,
    badgeAfterPanelClose: () => {},
    setSessionBadge: () => {},
    appendLog: () => {},
    focusWizardTab: () => {},
    showToast: () => {}
  };
  vm.createContext(ctx);
  const fn = sliceFn(WIZARD_SRC, 'function createWizardObserveBridge()', '\n// Sixth-log G5');
  vm.runInContext(fn + '\nthis.__bridge = createWizardObserveBridge();', ctx);
  return { bridge: ctx.__bridge, doc: dom.window.document };
}

describe('#11 observe bridge supersede', () => {
  it('a second pending request resolves the first with {cancelled, note:"superseded"}', async () => {
    const { bridge, doc } = loadBridge();
    const p1 = bridge.request({ question: 'q1' });
    const p2 = bridge.request({ question: 'q2' });
    const r1 = await p1;
    assert.equal(r1.cancelled, true);
    assert.equal(r1.note, 'superseded');
    doc.getElementById('userObserveAnswer').value = 'my observation';
    bridge.submit();
    const r2 = await p2;
    assert.equal(r2.answer, 'my observation');
    assert.ok(!r2.cancelled);
  });
});

describe('#11 userObserve try/catch fallback', () => {
  it('a crashing bridge returns the probe-fallback error instead of killing the turn', async () => {
    const tools = createSessionTools({
      rail: { pageOpen: async () => ({ tabId: 1, url: 'u', ready: true }), pageState: async () => ({}), executeDsl: async () => 1, ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1 },
      runVerify: async () => ({}),
      getDraftService: () => ({ name: 's', steps: [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }] }),
      applyArtifact: () => {}, getTestInput: () => ({}), getOutputSchema: () => null, getSteps: () => [],
      annotationBridge: null, ioConfirmBridge: { request: async () => ({ confirmed: true }) },
      observeBridge: { request: async () => { throw new Error('panel exploded'); } }
    });
    const r = await tools.tools['user.observe']({ question: 'look at the page' });
    assert.match(r.error, /observe bridge failed: panel exploded/);
    assert.match(r.error, /fall back to probing, never guess/);
  });
});
