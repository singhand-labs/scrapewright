// B5: SCRIPT_RESULT matching by execId. Two executors targeting the SAME
// tab with out-of-order completion cross-wire under tabId-only matching;
// execId disambiguates. NOTE: OffscreenExecutor resolves with an envelope
// { result, selectorDiagnostics } (Task 8) — assertions read .result.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SENT = [];
let LISTENERS = [];
global.chrome = {
  runtime: {
    sendMessage: async (msg) => { SENT.push(msg); },
    getURL: (p) => `chrome-extension://fake/${p}`,
    getContexts: async () => [],
    onMessage: {
      addListener: (fn) => { LISTENERS.push(fn); },
      removeListener: (fn) => { LISTENERS = LISTENERS.filter((f) => f !== fn); }
    }
  },
  offscreen: { createDocument: async () => {} }
};

const { OffscreenExecutor } = require('../lib/offscreen-executor');

function deliver(message) {
  for (const l of [...LISTENERS]) l(message);
}

// execute() awaits ensureOffscreenDocument before sendMessage — yield until
// the dispatch lands in SENT.
async function waitForDispatch(count) {
  for (let i = 0; i < 100 && SENT.filter((m) => m.type === 'EXECUTE_SCRIPT_OFFSCREEN').length < count; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('B5: OffscreenExecutor execId identity', () => {
  beforeEach(() => { SENT.length = 0; LISTENERS = []; });

  it('EXECUTE_SCRIPT_OFFSCREEN carries a unique execId', async () => {
    const ex = new OffscreenExecutor(7);
    const p = ex.execute('return 1;', {});
    await waitForDispatch(1);
    const sent = SENT.find((m) => m.type === 'EXECUTE_SCRIPT_OFFSCREEN');
    assert.ok(sent, 'execution dispatched');
    assert.ok(typeof sent.execId === 'string' && sent.execId.length > 0, 'execId present');
    deliver({ type: 'SCRIPT_RESULT', _fromOffscreen: true, execId: sent.execId, tabId: 7, result: 41 });
    assert.equal((await p).result, 41);
  });

  it('two interleaved executions on the SAME tab resolve with their own results', async () => {
    const a = new OffscreenExecutor(9);
    const b = new OffscreenExecutor(9);
    const pa = a.execute('return "a";', {});
    const pb = b.execute('return "b";', {});
    await waitForDispatch(2);
    const idA = SENT.filter((m) => m.type === 'EXECUTE_SCRIPT_OFFSCREEN')[0].execId;
    const idB = SENT.filter((m) => m.type === 'EXECUTE_SCRIPT_OFFSCREEN')[1].execId;
    assert.notEqual(idA, idB);
    deliver({ type: 'SCRIPT_RESULT', _fromOffscreen: true, execId: idB, tabId: 9, result: 'B-first' });
    deliver({ type: 'SCRIPT_RESULT', _fromOffscreen: true, execId: idA, tabId: 9, result: 'A-second' });
    assert.equal((await pb).result, 'B-first');
    assert.equal((await pa).result, 'A-second');
  });

  it('an error result rejects with subTabSnapshot and selectorDiagnostics attached', async () => {
    const ex = new OffscreenExecutor(3);
    const p = ex.execute('return boom;', {});
    p.catch(() => {});
    await waitForDispatch(1);
    const sent = SENT.find((m) => m.type === 'EXECUTE_SCRIPT_OFFSCREEN');
    deliver({
      type: 'SCRIPT_RESULT', _fromOffscreen: true, execId: sent.execId, tabId: 3,
      error: 'SCRIPT_ERROR', subTabSnapshot: '<div>sub</div>', selectorDiagnostics: [{ api: 'extract', matchCount: 0 }]
    });
    await assert.rejects(() => p, (err) => {
      assert.match(err.message, /SCRIPT_ERROR/);
      assert.equal(err.subTabSnapshot, '<div>sub</div>');
      assert.deepEqual(err.selectorDiagnostics, [{ api: 'extract', matchCount: 0 }]);
      return true;
    });
  });
});
