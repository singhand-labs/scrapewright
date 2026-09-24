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
// takes precedence via map lookup + lastIndexOf splice). 140th log: the
// handler grew a middle branch (purged-execId discard), so the region spans
// to the NEXT TOP-LEVEL handler, not the first `} else if`.
function handlerRegion(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'marker found: ' + marker);
  const end = src.indexOf("if (message.type === 'EXECUTE_SCRIPT_TIMEOUT'", start);
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
    // 138th log: deadlineAt rides the same paths (4th arg on forwardExecute,
    // extra key on the pending queue entry).
    assert.match(OFFSCREEN_SRC, /forwardExecute\(message\.script,\s*message\.input,\s*message\.execId,\s*message\.deadlineAt\)/);
    assert.match(OFFSCREEN_SRC, /pendingExecutes\.push\(\{\s*script:\s*message\.script,\s*input:\s*message\.input,\s*execId:\s*message\.execId,\s*deadlineAt:\s*message\.deadlineAt\s*\}\)/);
  });

  it('timeout purge targets only the timed-out execId (legacy branch for execId-less messages)', () => {
    // offscreen-executor must carry execId on EXECUTE_SCRIPT_TIMEOUT so the
    // purge can drop ONLY that map entry — purging every entry for the tab
    // would strand a concurrently running same-tab execution into the
    // legacy stack-pop fallback (cross-wire).
    const EXEC_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'offscreen-executor.js'), 'utf8');
    const timeoutRegion = EXEC_SRC.slice(EXEC_SRC.indexOf('EXECUTE_SCRIPT_TIMEOUT'), EXEC_SRC.indexOf('EXECUTE_SCRIPT_TIMEOUT') + 300);
    assert.match(timeoutRegion, /execId/);
    // offscreen.js: execId-guarded branch + legacy else branch both exist.
    assert.match(OFFSCREEN_SRC, /if \(message\.execId\)/);
    assert.match(OFFSCREEN_SRC, /execTabMap\.get\(message\.execId\) === message\.tabId\) execTabMap\.delete\(message\.execId\)/);
    assert.match(OFFSCREEN_SRC, /Array\.from\(execTabMap\.values\(\)\)\.some/);
  });

  it('timeout purges execTabMap entries for the timed-out tab', () => {
    assert.match(OFFSCREEN_SRC, /if \(v === message\.tabId\) execTabMap\.delete\(k\)/);
  });

  it('sandbox EXECUTE_RESULT echoes the execId it received', () => {
    // 140th log: the executor now also threads the deadline (4th arg).
    assert.match(SANDBOX_SRC, /executeInSandbox\(e\.data\.script,\s*e\.data\.input,\s*e\.data\.execId,\s*e\.data\.deadlineAt\)/);
    // 141st log: DOM_REQUESTs also carry an execId field now — count only
    // the result posts themselves.
    const n = (SANDBOX_SRC.match(/type: 'EXECUTE_RESULT', execId: execId/g) || []).length;
    const e = (SANDBOX_SRC.match(/type: 'EXECUTE_RESULT'/g) || []).length;
    assert.equal(n, e, 'every EXECUTE_RESULT post carries execId (' + e + ' sites)');
  });

  it('offscreen SCRIPT_RESULT payload carries the execId back to the resolver', () => {
    // Seam: OffscreenExecutor resolves ONLY messages whose execId matches the
    // pending execution (lib/offscreen-executor.js listener gate). sandbox.js
    // echoes execId in EXECUTE_RESULT, but if offscreen's outgoing
    // SCRIPT_RESULT drops it the real message never matches and every
    // execution dies at the 30s budget. The behavioral tests fake the
    // producer side (deliver SCRIPT_RESULT with execId already present), so
    // this seam must be pinned on the real producer's source.
    const region = handlerRegion(OFFSCREEN_SRC, "e.data.type === 'EXECUTE_RESULT'");
    const start = region.indexOf("type: 'SCRIPT_RESULT'");
    assert.ok(start !== -1, 'SCRIPT_RESULT send inside EXECUTE_RESULT handler');
    const payload = region.slice(start, region.indexOf('});', start));
    assert.match(payload, /execId:\s*e\.data\.execId/, 'payload echoes execId');
  });
});
