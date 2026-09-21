// Hundred-third-round AUDIT followups — three implementation bugs surfaced by
// the user's demanded re-audit of the live log:
//
// A. Debugger attach race (SW log 03:47:31.912): TRUSTED_HOVER dispatch and
//    TRUSTED_HOVER_DISMISS each run attach→sendCommand→detach with NO
//    per-tab serialization; two overlapping domHover calls (an un-awaited
//    script fired the next $hover while the first one's deferred dismiss was
//    still attached) fail the second attach outright ("Another debugger is
//    already attached"). Fix: per-tab CDP chain in renderer-activation.
//
// B. hover_anchor_timing dismissMs stopped measuring anything: the 101st
//    round moved the dismiss block AFTER result assembly (to hold the popover
//    open during the debug pause) but left the timing notify BEFORE it — the
//    whole session logged dismissMs:0/1. Fix: notify after the dismiss,
//    dismissMs measures the real dismiss, pauseMs separates the debug pause.
//
// C. The brand-new rejectedAddedHtml channel starves at the receipt-compaction
//    layer: compactObjectForLLM divides the tool budget EQUALLY across keys —
//    a probe.hover receipt at the 4000 default cap splits ~10 keys into ~400
//    chars each, slicing both the 8000-char htmlSnippet AND the fragments the
//    103rd-round fix just added. Fix: probe.hover gets a toolResultCaps
//    override sized for its evidence payload.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const RS = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'lib', 'research-session.js'), 'utf8');
const RA_PATH = path.join(__dirname, '..', 'lib', 'renderer-activation.js');

function tick(n) { return new Promise((r) => setTimeout(r, n || 0)); }

// Local copy of the renderer-activation sandbox loader with STEP-RELEASED
// attach/sendCommand/detach: each CDP callback stays pending until the test
// releases it via step('attach'|'sendCommand'|'detach'), so the interleaving
// is fully controlled.
function loadWithDeferredDebugger() {
  const calls = { attach: [], sendCommand: [], detach: [] };
  const pending = [];
  const makeStepKind = (kind, record) => (target, extra, maybeParams, maybeCb) => {
    const cb = typeof maybeCb === 'function' ? maybeCb : maybeParams;
    calls[kind].push(Object.assign({ target }, extra));
    pending.push({ kind, cb });
  };
  const chrome = {
    debugger: {
      attach: (target, version, cb) => makeStepKind('attach', { version })(target, { version }, cb),
      sendCommand: (target, method, params, cb) => makeStepKind('sendCommand', { method })(target, { method }, params, cb),
      detach: (target, cb) => makeStepKind('detach', {})(target, {}, cb)
    },
    storage: { local: { get: (k, cb) => cb({ enhancedModeEnabled: true }), set: (i, cb) => cb && cb() } },
    runtime: { lastError: undefined }
  };
  const sandbox = {
    chrome, console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(RA_PATH, 'utf8'), sandbox, { filename: 'renderer-activation.js' });
  return {
    api: sandbox.module.exports, calls,
    step: (kind) => new Promise((resolve) => setTimeout(() => {
      const i = pending.findIndex((p) => p.kind === kind);
      if (i === -1) { resolve(); return; }
      const p = pending.splice(i, 1)[0];
      p.cb();
      resolve();
    }, 0))
  };
}

describe('audit A: per-tab CDP attach serialization (renderer-activation)', () => {
  it('a second hover on the SAME tab waits for the first chain to detach', async () => {
    const h = loadWithDeferredDebugger();
    const p1 = h.api.dispatchTrustedHover(101, { x: 10, y: 10 });
    await tick();
    assert.equal(h.calls.attach.length, 1, 'first hover attached');
    const p2 = h.api.dispatchTrustedHover(101, { x: 20, y: 20 });
    await tick(10);
    assert.equal(h.calls.attach.length, 1,
      'the second hover MUST NOT attach while the first chain still holds the debugger — the 103rd-log race');
    // walk the first chain to completion
    await h.step('attach'); await tick();
    await h.step('sendCommand'); await tick();
    await h.step('detach'); await tick();
    await p1;
    await tick(10);
    assert.equal(h.calls.attach.length, 2, 'second hover attaches only after the first detached');
    await h.step('attach'); await h.step('sendCommand'); await h.step('detach');
    const r2 = await p2;
    assert.equal(r2.dispatched, true, 'the serialized second hover still dispatches (no attach-failure loss)');
  });
  it('DIFFERENT tabs do not block each other', async () => {
    const h = loadWithDeferredDebugger();
    const p1 = h.api.dispatchTrustedHover(201, { x: 1, y: 1 });
    await tick();
    const p2 = h.api.dispatchTrustedHover(202, { x: 2, y: 2 });
    await tick(10);
    assert.equal(h.calls.attach.length, 2, 'per-TAB chain — cross-tab dispatches stay concurrent');
    await h.step('attach'); await h.step('sendCommand'); await h.step('detach');
    await h.step('attach'); await h.step('sendCommand'); await h.step('detach');
    await Promise.all([p1, p2]);
  });
});

describe('audit B: hover_anchor_timing dismissMs measures the real dismiss again', () => {
  it('the notify sits AFTER the dismiss send and separates pauseMs', () => {
    const notifyIdx = CS.indexOf("notifyBackgroundDiagnostic('hover_anchor_timing'");
    const dismissIdx = CS.indexOf("type: 'TRUSTED_HOVER_DISMISS'");
    assert.ok(notifyIdx > -1 && dismissIdx > -1);
    assert.ok(notifyIdx > dismissIdx,
      'the 101st-round move put the dismiss after result assembly; the timing notify must follow it or dismissMs logs 0/1 forever');
    const chunk = CS.slice(notifyIdx, notifyIdx + 700);
    assert.match(chunk, /dismissMs:/, 'dismissMs kept');
    assert.match(chunk, /pauseMs:/, 'the debug-pause duration is separated from the dismiss duration');
  });
});

describe('audit C: probe.hover receipt cap override (fragment channel survives compaction)', () => {
  it('toolResultCaps DEFAULTS carry a probe.hover override', () => {
    assert.match(RS, /'probe\.hover':\s*\d{4,}/,
      'the 4000 default splits ~10 keys into ~400 chars each — the 8000-char htmlSnippet AND rejectedAddedHtml fragments both get sliced to noise');
  });
});
