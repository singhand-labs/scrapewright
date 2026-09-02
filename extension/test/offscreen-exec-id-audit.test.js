// B5 source audit: offscreen.js cannot load under Node (chrome.* +
// document at top level). Pin the execId routing structurally.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OFFSCREEN_SRC = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
const SANDBOX_SRC = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

// The EXECUTE_RESULT handler region only (a fallback pop() may legitimately
// exist there for legacy sandbox versions — the pin is that the execId path
// takes precedence via map lookup + lastIndexOf splice).
function handlerRegion(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'marker found: ' + marker);
  const end = src.indexOf('} else if', start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe('B5: offscreen/sandbox execId routing (source audit)', () => {
  it('offscreen records execId→tabId at dispatch and resolves EXECUTE_RESULT by it (not blind pop)', () => {
    assert.match(OFFSCREEN_SRC, /execTabMap/, 'execId→tabId map exists');
    assert.match(OFFSCREEN_SRC, /execTabMap\.set\(message\.execId,\s*message\.tabId\)/);
    const region = handlerRegion(OFFSCREEN_SRC, "e.data.type === 'EXECUTE_RESULT'");
    assert.match(region, /execTabMap\.get\(e\.data\.execId\)/, 'result tabId resolved via map lookup');
    assert.match(region, /lastIndexOf\(tabId\)/, 'stack removal targets the completed tabId');
    assert.match(region, /execTabMap\.delete\(e\.data\.execId\)/, 'map entry consumed');
  });

  it('offscreen forwards execId to the sandbox and carries it on pending queues', () => {
    assert.match(OFFSCREEN_SRC, /forwardExecute\(message\.script,\s*message\.input,\s*message\.execId\)/);
    assert.match(OFFSCREEN_SRC, /pendingExecutes\.push\(\{\s*script:\s*message\.script,\s*input:\s*message\.input,\s*execId:\s*message\.execId\s*\}\)/);
  });

  it('timeout purges execTabMap entries for the timed-out tab', () => {
    assert.match(OFFSCREEN_SRC, /if \(v === message\.tabId\) execTabMap\.delete\(k\)/);
  });

  it('sandbox EXECUTE_RESULT echoes the execId it received', () => {
    assert.match(SANDBOX_SRC, /executeInSandbox\(e\.data\.script,\s*e\.data\.input,\s*e\.data\.execId\)/);
    const n = (SANDBOX_SRC.match(/type: 'EXECUTE_RESULT'/g) || []).length;
    const e = (SANDBOX_SRC.match(/execId: execId/g) || []).length;
    assert.equal(n, e, 'every EXECUTE_RESULT post carries execId (' + n + ' sites)');
  });
});
