// extension/test/hundred-forty-first-log-exec-binding.test.js
//
// 141st log (user-approved design): per-execution $ API binding. The 140th
// incident proved requests were ANONYMOUS — the deadline was read from a
// module global that any later EXECUTE overwrites (the zombie rode a
// stranger's budget), and routing resolved from stack order at the offscreen
// hop (a research probe's $count could execute on the verify tab and return
// the wrong tab's data as a green result). Every execution now builds its own
// $ API bag from the EXECUTE envelope's execId + deadlineAt, injected into
// the script as FUNCTION PARAMETERS (bare $hover/$count in a script resolve
// to THIS execution's closures, never to the window globals); every
// DOM_REQUEST carries its execId; the offscreen routes by the execId→tab
// map first (stack-top remains the legacy fallback).
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SANDBOX_SRC = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');
const OFFSCREEN_SRC = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
const BG_SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function loadSandbox() {
  const posted = [];
  let windowListener = null;
  const sandboxWindow = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout,
    Date, JSON, Promise, Map, Set, Array, Object, Number, String, Boolean, Math, RegExp, Error, TypeError,
    addEventListener: (kind, fn) => { if (kind === 'message') windowListener = fn; },
    postMessage: () => {}
  };
  // Auto-feeder: answer every DOM_REQUEST on the next tick so sequential
  // awaits in scripts run to completion (the real offscreen↔content round
  // trip is not under test here — identity and stamping are).
  sandboxWindow.parent = { postMessage: (m) => {
    posted.push(m);
    if (m && m.type === 'DOM_REQUEST') {
      setTimeout(() => {
        if (windowListener) windowListener({ data: { type: 'DOM_RESPONSE', id: m.id, result: m.action === 'count' ? 3 : 'ok' } });
      }, 0);
    }
  } };
  sandboxWindow.window = sandboxWindow;
  sandboxWindow.globalThis = sandboxWindow;
  sandboxWindow.self = sandboxWindow;
  vm.createContext(sandboxWindow);
  vm.runInContext(SANDBOX_SRC, sandboxWindow);
  return { window: sandboxWindow, posted, listener: () => windowListener };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('141st log — per-execution identity rides every DOM_REQUEST', () => {
  it('a script\'s request carries ITS execId + envelope deadline even after a later EXECUTE lands (the 140th cross-stamp, killed at construction)', async () => {
    const h = loadSandbox();
    const D1 = Date.now() + 5000;
    const D2 = Date.now() + 120000;
    // Execution A: pause briefly, THEN issue $count — a later EXECUTE (B)
    // will have landed by then. A's request must still carry (A, D1).
    h.listener()({ data: { type: 'EXECUTE', script:
      '(async function(){ await new Promise(r=>setTimeout(r,60)); return {n: await $count(".card")}; })();',
      input: {}, execId: 'execA', deadlineAt: D1 } });
    await sleep(20);
    h.listener()({ data: { type: 'EXECUTE', script: '(async function(){ return 1; })();', input: {}, execId: 'execB', deadlineAt: D2 } });
    await sleep(150);
    const reqA = h.posted.find((m) => m.type === 'DOM_REQUEST' && m.execId === 'execA');
    assert.ok(reqA, 'execution A\'s request posted with its execId');
    assert.equal(reqA.deadlineAt, D1, 'A rides ITS OWN envelope deadline — not the later execution\'s (D2)');
    assert.ok(!h.posted.some((m) => m.type === 'DOM_REQUEST' && m.execId === 'execB'),
      'B made no $ calls, and none of A\'s requests were stamped with B\'s identity');
    // both executions completed
    const ids = h.posted.filter((m) => m.type === 'EXECUTE_RESULT').map((m) => m.execId).sort();
    assert.deepEqual(ids, ['execA', 'execB']);
  });

  it('the script\'s bare $ APIs resolve to the INJECTED closures, not window globals (parameters shadow)', async () => {
    const h = loadSandbox();
    // Sabotage the window global: if the script saw it, the request would
    // carry execId null and the module-global deadline.
    h.window.execDeadlineAt = 12345;
    const D = Date.now() + 30000;
    h.listener()({ data: { type: 'EXECUTE', script:
      '(async function(){ const a = await $extract(".x"); const b = await $hover(".y"); return [a, b]; })();',
      input: {}, execId: 'execX', deadlineAt: D } });
    await sleep(80);
    const reqs = h.posted.filter((m) => m.type === 'DOM_REQUEST');
    assert.ok(reqs.length >= 2, 'both calls posted');
    for (const r of reqs) {
      assert.equal(r.execId, 'execX', 'injected closure identity, not the window legacy bag');
      assert.equal(r.deadlineAt, D);
    }
  });

  it('the legacy window bag still works (null execId, module-global deadline) for direct callers', async () => {
    const h = loadSandbox();
    // the module-global deadline is a closure set by the EXECUTE envelope —
    // drive it through the real path, not a window property
    h.listener()({ data: { type: 'EXECUTE', script: '(async function(){ return 0; })();', input: {}, execId: 'seed', deadlineAt: 777 } });
    await sleep(40);
    h.posted.length = 0;
    const p = h.window.$count('.legacy');
    await sleep(30);
    const req = h.posted.find((m) => m.type === 'DOM_REQUEST');
    assert.ok(req, 'legacy request posted');
    assert.equal(req.execId, null);
    assert.equal(req.deadlineAt, 777);
    void p;
  });

  it('the API bag covers the full $ surface (every name is a function on both bags)', () => {
    const NAMES = ['$','$click','$type','$extract','$wait','$check','$exists','$labelledby','$timestamp','$count','$list','$waitForStable','$openTab','$extractList','$extractListMulti','$extractWithHover','$clickInList','$scrollBy','$scrollToBottom','$collectUntil','$scrollIntoView','$hover'];
    const h = loadSandbox();
    for (const n of NAMES) {
      assert.equal(typeof h.window[n], 'function', 'window legacy bag has ' + n);
    }
    assert.ok(/API_PARAM_NAMES = \[/.test(SANDBOX_SRC), 'param name list exists');
    for (const n of NAMES) {
      assert.ok(SANDBOX_SRC.indexOf("'" + n + "'") !== -1, 'API_PARAM_NAMES carries ' + n);
    }
  });
});

describe('141st log — offscreen routes by execution identity (source audit)', () => {
  it('DOM_REQUEST routing resolves execId→tab from execTabMap FIRST; stack-top is the legacy fallback', () => {
    const i = OFFSCREEN_SRC.indexOf("e.data.type === 'DOM_REQUEST'");
    assert.ok(i > -1, 'DOM_REQUEST handler found');
    const region = OFFSCREEN_SRC.slice(i, i + 1600);
    assert.match(region, /execTabMap\.has\(e\.data\.execId\)/, 'execId map lookup');
    assert.match(region, /execTabMap\.get\(e\.data\.execId\)/, 'tab resolved by execId');
    const mapAt = region.indexOf('execTabMap.get(e.data.execId)');
    const stackAt = region.indexOf('tabIdStack[tabIdStack.length - 1]');
    assert.ok(mapAt > -1 && stackAt > -1 && mapAt < stackAt, 'the map lookup takes precedence over stack-top');
    assert.match(region, /execId: e\.data\.execId/, 'the forwarded request carries the execId');
  });

  it('the script function is compiled WITH the API parameter list and invoked with the bag values', () => {
    assert.match(SANDBOX_SRC, /new Function\('__input__', '__stepResults__', '__lastResult__', \.\.\.API_PARAM_NAMES/, 'parameter injection at compile');
    assert.match(SANDBOX_SRC, /API_PARAM_NAMES\.map\(\(k\) => execApi\[k\]\)/, 'bag values built per execution');
    assert.match(SANDBOX_SRC, /makeExecApi\(execId, deadlineAt\)/, 'the bag binds the envelope identity');
  });

  it('the background relay whitelists execId through to the content script', () => {
    const i = BG_SRC.indexOf("message.type === 'DOM_REQUEST' && message._fromOffscreen");
    const region = BG_SRC.slice(i, i + 1600);
    assert.match(region, /execId: message\.execId/, 'relayMsg carries execId');
  });
});
