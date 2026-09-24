// extension/test/hundred-fortieth-log-zombie-relay.test.js
//
// 140th log — the session's final verify died RELAY_FAILED at its FIRST step
// ("no target tab bound to this request"), unfixable from the model side.
// Root cause was a two-bug compound in the execution-routing layer:
//
//   A. SANDBOX ZOMBIE: the executor's wall timeout only rejects the CALLER's
//      promise — the script kept running in the sandbox iframe. The
//      module-level execDeadlineAt had meanwhile been OVERWRITTEN by the next
//      execution's EXECUTE (the verify's cold run), so the zombie's
//      DOM_REQUESTs rode the NEW deadline, passed the background relay's
//      expiry pre-check, and kept dispatching real hovers for 67 more
//      seconds after its own 20s budget died.
//   B. LEGACY POP STEALS A ROUTING SLOT: when the zombie finally posted its
//      late EXECUTE_RESULT, its execId→tab entry had already been purged by
//      the timeout handler — the result fell into the "legacy sandbox"
//      fallback `tabIdStack.pop()` and popped the LIVE verify execution's
//      tab off the routing stack. The verify's next DOM_REQUEST found no
//      bound tab and the whole run died.
//
// Fixes under test:
//   A1. sandbox races each execution against its OWN deadline; on loss the
//       script's promise rejects (SANDBOX_DEADLINE) and stale in-flight $ calls
//       (captured deadline <= the dead execution's deadline) are rejected.
//   B1. offscreen EXECUTE_RESULT handler is a three-way branch: map hit →
//       resolve+splice; execId present but PURGED → discard, stack untouched;
//       execId absent (true legacy) → pop.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const OFFSCREEN_SRC = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
const SANDBOX_SRC = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

// Load the sandbox IIFE in a vm with REAL timers and a captured window
// message listener, mirroring the offscreen host. The window object IS the
// vm global (as in a real page) so `$hover` etc. resolve inside scripts.
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
  sandboxWindow.parent = { postMessage: (m) => { posted.push(m); } };
  sandboxWindow.window = sandboxWindow;
  sandboxWindow.globalThis = sandboxWindow;
  sandboxWindow.self = sandboxWindow;
  vm.createContext(sandboxWindow);
  vm.runInContext(SANDBOX_SRC, sandboxWindow);
  return { window: sandboxWindow, posted, listener: () => windowListener };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('140th log A — sandbox kills zombies at their own deadline', () => {
  it('a script outliving its deadline is abandoned: SANDBOX_DEADLINE result posted, no zombie', async () => {
    const h = loadSandbox();
    const deadline = Date.now() + 80;
    h.listener()({ data: { type: 'EXECUTE', script: '(async function(){ await new Promise(r=>setTimeout(r,5000)); return 42; })();', input: {}, execId: 'e1', deadlineAt: deadline } });
    await sleep(400);
    const res = h.posted.find((m) => m.type === 'EXECUTE_RESULT');
    assert.ok(res, 'EXECUTE_RESULT posted');
    assert.equal(res.execId, 'e1');
    assert.match(String(res.error), /SANDBOX_DEADLINE/, 'the result carries the deadline abandonment error');
  });

  it('stale in-flight $ calls are rejected at deadline loss (the zombie unwinds fast)', async () => {
    const h = loadSandbox();
    const deadline = Date.now() + 80;
    // script: issue a $hover that is NEVER answered, catch, and report the rejection reason
    h.listener()({ data: { type: 'EXECUTE', script:
      '(async function(){ try { await $hover(".anchor"); return {hovered: true}; } catch (e) { return {abandoned: String(e && e.message || e)}; } })();',
      input: {}, execId: 'e2', deadlineAt: deadline } });
    // the DOM_REQUEST must have been posted (and left pending — nobody answers it)
    await sleep(30);
    assert.ok(h.posted.some((m) => m.type === 'DOM_REQUEST'), 'the hover request was posted');
    await sleep(300);
    const res = h.posted.find((m) => m.type === 'EXECUTE_RESULT');
    assert.ok(res, 'result posted');
    // the script either finished via the swept rejection or was raced out —
    // either way it TERMINATED within the deadline window, not 5s later
    const out = res.error ? String(res.error) : JSON.stringify(res.result);
    assert.match(out, /abandoned|DEADLINE/i, 'the in-flight call was rejected, not left hanging');
  });

  it('a script finishing before its deadline completes normally (race does not misfire)', async () => {
    const h = loadSandbox();
    const deadline = Date.now() + 5000;
    h.listener()({ data: { type: 'EXECUTE', script: '(async function(){ return 7; })();', input: {}, execId: 'e3', deadlineAt: deadline } });
    await sleep(80);
    const res = h.posted.find((m) => m.type === 'EXECUTE_RESULT');
    assert.ok(res, 'result posted');
    assert.equal(res.result, 7);
    assert.equal(res.error, undefined);
  });

  it('no deadline (legacy sender) → no race, long scripts still run to completion', async () => {
    const h = loadSandbox();
    h.listener()({ data: { type: 'EXECUTE', script: '(async function(){ await new Promise(r=>setTimeout(r,60)); return "legacy-ok"; })();', input: {}, execId: 'e4', deadlineAt: null } });
    await sleep(200);
    const res = h.posted.find((m) => m.type === 'EXECUTE_RESULT');
    assert.ok(res && res.result === 'legacy-ok', 'legacy deadline-less execution unaffected');
  });
});

describe('140th log B — offscreen never pops a stranger\'s routing slot', () => {
  it('three-way branch: purged-execId results are DISCARDED (stack untouched); the blind pop is legacy-only', () => {
    const i = OFFSCREEN_SRC.indexOf("e.data.type === 'EXECUTE_RESULT'");
    assert.ok(i > -1, 'EXECUTE_RESULT handler found');
    const region = OFFSCREEN_SRC.slice(i, i + 2400);
    assert.match(region, /execTabMap\.has\(e\.data\.execId\)/, 'map-hit branch resolves by execId');
    assert.match(region, /Discarding late result of a timed-out execution/, 'purged-execId branch discards');
    // the discard branch must NOT pop or splice
    const discardAt = region.indexOf('Discarding late result');
    const discardBlock = region.slice(discardAt, region.indexOf('}', discardAt));
    assert.ok(!/pop\(|splice\(/.test(discardBlock), 'the discard branch touches no stack');
    // the legacy pop must be gated on execId being ABSENT
    const legacyAt = region.indexOf('tabIdStack.pop()');
    assert.ok(legacyAt > -1, 'legacy pop still exists for execId-less results');
    const gating = region.slice(0, legacyAt);
    assert.ok(/execId !== undefined\)/.test(gating) && gating.lastIndexOf('else') > gating.lastIndexOf('execId !== undefined)'),
      'the pop sits in a branch that only runs when execId is undefined');
  });

  it('sandbox threads the EXECUTE deadline into the executor (source pins)', () => {
    assert.match(SANDBOX_SRC, /executeInSandbox\(e\.data\.script, e\.data\.input, e\.data\.execId, e\.data\.deadlineAt\)/);
    assert.match(SANDBOX_SRC, /rejectStalePendingRequests\(deadlineAt\)/, 'error path sweeps stale pendings');
    assert.match(SANDBOX_SRC, /capturedDeadlineAt: execDeadlineAt/, 'requests capture the deadline at send time');
  });

  it('regression: the 138th deadline stamping still rides every DOM_REQUEST', () => {
    assert.match(SANDBOX_SRC, /deadlineAt: execDeadlineAt/);
    assert.match(SANDBOX_SRC, /execDeadlineAt = \(typeof e\.data\.deadlineAt === 'number'/);
  });
});
