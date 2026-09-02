// B9: $openTab had no local timeout — a pending entry could sit in
// openTabPending forever (background never answers) and the script burned
// the whole step timeout. 60s local cap + reqId cleanup.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

function sliceFn(name) {
  let start = SRC.indexOf('async function ' + name + '(');
  if (start === -1) start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists in content-script.js');
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

describe('B9: $openTab local timeout', () => {
  function buildDomOpenTab() {
    const openTabPending = new Map();
    const sent = [];
    const chrome = { runtime: { sendMessage: (msg) => { sent.push(msg); } } };
    const factory = eval('(function (openTabPending, chrome) { let openTabCounter = 0; let currentSenderTabId = 11; const OPEN_TAB_LOCAL_TIMEOUT_MS = 60000; return (' + sliceFn('domOpenTab') + '); })');
    return { fn: factory(openTabPending, chrome), openTabPending, sent };
  }

  it('times out locally, cleans the pending entry, and teaches', async () => {
    const { fn, openTabPending, sent } = buildDomOpenTab();
    const p = fn('https://example.com/item', 'return 1;', 15); // tiny timeout override for the test
    await assert.rejects(() => p, /OPEN_TAB_TIMEOUT/);
    assert.equal(openTabPending.size, 0, 'pending entry cleaned up');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'OPEN_TAB_EXECUTE');
  });

  it('a normal reply resolves and clears the timer path (no OPEN_TAB_TIMEOUT)', async () => {
    const { fn, openTabPending } = buildDomOpenTab();
    const p = fn('https://example.com/item', 'return 1;', 60);
    setTimeout(() => {
      const entry = [...openTabPending.values()][0];
      entry.resolve({ title: 'ok' });
    }, 5);
    const r = await p;
    assert.deepEqual(r, { title: 'ok' });
    assert.equal(openTabPending.size, 0);
  });
});
