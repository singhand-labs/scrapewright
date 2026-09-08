// Forty-first log: sandbox global cross-run leak. Step scripts execute in the
// shared sandbox iframe's global scope via new Function — a script that parks
// state on globalThis (v2's scroll-stall counter `globalThis.__stall = 6`)
// leaves it there for the NEXT orchestration run: a later, UNRELATED verify
// run (different tab, different service version) read the stale counter,
// exited its scroll after one iteration, and lied "feed exhausted".
//
// sandbox.js now snapshots its base globals at load and exposes
// __scrapewrightScrubSandbox; StepOrchestrator.execute invokes it before a
// run's first step (run boundaries are the orchestrator's to own). We load
// sandbox.js in a vm context so `globalThis` IS the sandbox object — exactly
// the production topology of the iframe.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

function loadSandboxContext() {
  const posted = [];
  const listeners = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    parent: { postMessage(m) { posted.push(m); } },
    addEventListener(type, fn) { listeners.push(fn); }
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'sandbox.js' });
  if (!listeners.length) throw new Error('sandbox.js registered no message listener');
  return {
    ctx, posted,
    async send(script, input) {
      const execId = 'e' + posted.length;
      // Production shape: OffscreenExecutor pre-wraps step bodies as
      // `(async function(__input__) { ... })(__input__)` before EXECUTE.
      const wrapped = script.startsWith('(async function') ? script : `(async function(__input__) { ${script} })(__input__)`;
      listeners[listeners.length - 1]({ data: { type: 'EXECUTE', script: wrapped, input: input || {}, execId } });
      await new Promise((r) => setImmediate(r));
      const result = posted.filter((m) => m.type === 'EXECUTE_RESULT' && m.execId === execId).pop();
      if (!result) throw new Error('no EXECUTE_RESULT for ' + execId);
      return result;
    }
  };
}

// The exact glue string StepOrchestrator.execute sends before a run's first
// step (kept in one place here so drift between the two files is visible).
const ORCHESTRATOR_SCRUB_SCRIPT =
  'if (typeof globalThis.__scrapewrightScrubSandbox === "function") { try { globalThis.__scrapewrightScrubSandbox(); } catch (e) {} }\nreturn { sandboxScrubbed: true };';

describe('sandbox global scrub (forty-first log)', () => {
  it('a global parked by one run is gone after the orchestrator scrub snippet runs', async () => {
    const sb = loadSandboxContext();
    const run1 = await sb.send('globalThis.__stall = 6; return { stall: globalThis.__stall };');
    assert.equal(run1.result.stall, 6);
    assert.equal(sb.ctx.__stall, 6, 'pre-scrub: the leak reproduces (shared global scope)');

    const scrub = await sb.send(ORCHESTRATOR_SCRUB_SCRIPT);
    assert.equal(scrub.result.sandboxScrubbed, true);

    assert.equal(sb.ctx.__stall, undefined, 'leaked counter is gone');
    assert.equal(typeof sb.ctx.$, 'function', 'framework $ APIs survive (base snapshot)');
    assert.equal(typeof sb.ctx.$extractList, 'function', 'all load-time APIs survive');
    assert.equal(typeof sb.ctx.__scrapewrightScrubSandbox, 'function', 'the scrub fn itself survives');

    const run2 = await sb.send('const stalled = (typeof globalThis.__stall === "undefined") ? 0 : globalThis.__stall; return { stalled };');
    assert.equal(run2.result.stalled, 0, 'the next run starts from a clean global scope');
  });

  it('within-run persistence across poll iterations is NOT scrubbed (scrub is a run boundary, not per-step)', async () => {
    const sb = loadSandboxContext();
    const iter = 'globalThis.__k = (typeof globalThis.__k === "undefined") ? 1 : globalThis.__k + 1; return { k: globalThis.__k };';
    const a = await sb.send(iter);
    const b = await sb.send(iter);
    assert.equal(a.result.k, 1);
    assert.equal(b.result.k, 2, 'same-run iterations still share state — the poll-counter pattern keeps working');
  });

  it('scrub deletes only non-base globals (framework APIs and host shims untouched)', async () => {
    const sb = loadSandboxContext();
    await sb.send('globalThis.__leak1 = "a"; globalThis.__leak2 = { deep: true }; return 1;');
    await sb.send(ORCHESTRATOR_SCRUB_SCRIPT);
    assert.equal(sb.ctx.__leak1, undefined);
    assert.equal(sb.ctx.__leak2, undefined);
    assert.equal(typeof sb.ctx.parent, 'object', 'host shim objects survive');
  });
});
