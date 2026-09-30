// 176th round (user report: "clicked the button, never entered annotation
// state, the session just continued researching"). Root cause chain:
//   (1) bridge.request() activated the tab WITHIN its window but never
//       raised the WINDOW — the user never saw the page enter annotation
//       mode (forty-ninth-log window-focus class);
//   (2) pressing Submit Annotations with ZERO captured marks resolved the
//       bridge as CANCELLED — the model read "user declined, keep
//       researching" (a false cancellation; the session visibly continued);
//   (3) the panel offered no re-entry when annotation mode silently died
//       (page reload clears it).
// Fix under test: window raise on request AND re-arm; zero-annotation
// Submit re-arms annotation mode, keeps the request pending, and teaches —
// only a capture ERROR or the explicit Cancel resolves.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '../wizard.js'), 'utf8');

function sliceBridge() {
  const start = SRC.indexOf('function createWizardAnnotationBridge(');
  assert.ok(start > -1, 'bridge defined');
  let depth = 0, i = SRC.indexOf('{', start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

function makeHarness() {
  const dom = new JSDOM('<div id="annotationRequestPanel" class="hidden"></div>' +
    '<p id="annotationRequestWhy"></p><p id="annotationRequestScope"></p>');
  const calls = { windows: [], startAnnotation: 0, capture: 0, toasts: [] };
  const tabState = { windowId: 77, active: false };
  const chromeStub = {
    tabs: {
      update: async (tabId, props) => { tabState.active = true; },
      get: async () => tabState,
      sendMessage: async (tabId, msg) => {
        if (msg.type === 'START_ANNOTATION') { calls.startAnnotation += 1; return { ack: true }; }
        if (msg.type === 'CAPTURE_ANNOTATION') { calls.capture += 1; return calls.captureResult; }
        return {};
      }
    },
    windows: {
      update: async (windowId, props) => { calls.windows.push({ windowId, props }); }
    }
  };
  const sendMessageWithRetry = async (tabId, msg) => chromeStub.tabs.sendMessage(tabId, msg);
  const setSessionBadge = () => {};
  const badgeAfterPanelClose = () => {};
  const showToast = (text, kind, ms) => { calls.toasts.push(text); };
  const getOutputFieldOptions = () => [];
  const wizardState = { inputSchema: {}, outputSchema: {} };
  const factory = eval('(function (document, chrome, sendMessageWithRetry, setSessionBadge, badgeAfterPanelClose, showToast, getOutputFieldOptions, wizardState) { return (' + sliceBridge() + '); })');
  const createBridge = factory(dom.window.document, chromeStub, sendMessageWithRetry, setSessionBadge, badgeAfterPanelClose, showToast, getOutputFieldOptions, wizardState);
  const bridge = createBridge(() => ({ tabId: 5 }));
  return { bridge, calls, dom, chromeStub };
}

describe('176th round: annotation bridge raises the window', () => {
  it('request() activates the tab AND focuses its window', async () => {
    const { bridge, calls, dom } = makeHarness();
    const p = bridge.request({ why: 'mark the postTime element', fields: ['postTime'] });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(calls.startAnnotation, 1, 'START_ANNOTATION armed');
    assert.equal(calls.windows.length, 1, 'the window was raised');
    assert.equal(calls.windows[0].windowId, 77);
    assert.equal(calls.windows[0].props.focused, true);
    assert.ok(!dom.window.document.getElementById('annotationRequestPanel').classList.contains('hidden'), 'panel shown');
    assert.match(dom.window.document.getElementById('annotationRequestScope').textContent, /hovering highlights elements and clicking marks one/i);
    bridge.cancel();
    await p;
  });
});

describe('176th round: zero-annotation Submit re-arms, never false-cancels', () => {
  it('finish() with zero captures keeps the request pending and re-arms annotation mode', async () => {
    const { bridge, calls, dom } = makeHarness();
    let resolved = null;
    const p = bridge.request({ why: 'w', fields: ['a'] }).then((r) => { resolved = r; return r; });
    await new Promise(r => setTimeout(r, 10));
    calls.captureResult = { annotations: [], url: 'https://example.com' };
    await bridge.finish();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(resolved, null, 'the bridge did NOT resolve — the session stays parked on the user');
    assert.equal(calls.startAnnotation, 2, 'annotation mode re-armed (page-reload self-heal)');
    assert.equal(calls.windows.length >= 2, true, 'the page window was raised again');
    assert.ok(calls.toasts.some(t => /No elements marked yet/i.test(t)), 'the user gets the teaching toast');
    assert.ok(!dom.window.document.getElementById('annotationRequestPanel').classList.contains('hidden'), 'panel stays open');
    // Cancel is the honest exit.
    bridge.cancel();
    const r = await p;
    assert.equal(r.cancelled, true, 'explicit cancel resolves cancelled');
  });

  it('finish() with annotations resolves with provenance user', async () => {
    const { bridge, calls } = makeHarness();
    const p = bridge.request({ why: 'w', fields: ['a'] });
    await new Promise(r => setTimeout(r, 10));
    calls.captureResult = { annotations: [{ selector: 'span.ts', purpose: 'time' }], url: 'https://example.com/x' };
    await bridge.finish();
    const r = await p;
    assert.equal(r.cancelled, undefined);
    assert.equal(r.annotations[0].selector, 'span.ts');
    assert.equal(r.annotations[0].provenance, 'user');
  });

  it('a capture ERROR still resolves (real failure — the model falls back to probes)', async () => {
    const { bridge, calls } = makeHarness();
    const p = bridge.request({ why: 'w', fields: ['a'] });
    await new Promise(r => setTimeout(r, 10));
    calls.captureResult = { error: 'CAPTURE_SNAPSHOT_FAILED: boom' };
    await bridge.finish();
    const r = await p;
    assert.equal(r.cancelled, true);
    assert.match(r.error, /CAPTURE_SNAPSHOT_FAILED/);
  });
});

// 177b round (user report): a container-confirm ask had no menu entry — the
// user clicked the post div and had no way to say "this is the container"
// because every pick demanded an output field. The page menu now carries a
// dedicated container type with role options (repeating item / exclude /
// scope) and NO output-field select.
describe('177b round: annotation menu container type (source audit)', () => {
  const CS = fs.readFileSync(path.join(__dirname, '../content-script.js'), 'utf8');
  it('step 1 offers the container type, labeled as NOT an output field', () => {
    assert.match(CS, /data-type="container"[^>]*>container — repeating item \/ scope \(NOT an output field\)/);
  });
  it('step 2 gives container picks role options instead of a field select', () => {
    const idx = CS.indexOf("type === 'click' || type === 'check' || type === 'input' || type === 'container'");
    assert.ok(idx > -1, 'the intent branch covers container');
    const branch = CS.slice(idx, idx + 1400);
    assert.match(branch, /repeating item \(post\/card\)/);
    assert.match(branch, /exclude — not an item/);
    assert.match(branch, /page region \/ scope/);
    assert.match(branch, /What is this container\?/);
  });
  it('commit reads the container purpose (no outputField expected)', () => {
    const idx = CS.indexOf("if (type === 'click' || type === 'check' || type === 'input' || type === 'container') {");
    assert.ok(idx > -1, 'commit covers container');
  });
});

// 178th review: a second request while one is pending supersedes honestly —
// the first promise resolves cancelled instead of leaking forever.
describe('178th review: pending request supersede guard', () => {
  it('a second request() resolves the first as superseded, not leaked', async () => {
    const { bridge } = makeHarness();
    const p1 = bridge.request({ why: 'first', fields: ['a'] });
    await new Promise(r => setTimeout(r, 10));
    const p2 = bridge.request({ why: 'second', fields: ['b'] });
    const r1 = await p1;
    assert.equal(r1.cancelled, true);
    assert.match(r1.error, /superseded/);
    // Wait for request#2 to actually PARK (its body awaits focus/arm before
    // setting pending) — a synchronous cancel would race the microtasks and
    // no-op on a null pending, leaking p2 forever.
    await new Promise(r => setTimeout(r, 10));
    bridge.cancel();
    await p2;
  });
});
