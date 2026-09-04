// Twentieth log: v2/v3 extract scripts carried a one-char typo —
// html:{selector':'', attr:'outerHTML'} — and the SyntaxError thrown by the
// Function constructor carries NO position, so diag.read showed only
// {"message":"Unexpected string"}. The model could not locate the bug in a
// 2000-char script and burned its last turns guessing (including a wrong
// IIFE-wrapper theory fed by an inaccurate system-prompt sentence).
// sandbox.js now prefix-scans the script on the compile-failure path and
// enriches the error with line/column + a marked context snippet.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadSandbox() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

  const posted = [];
  const messageListeners = [];
  const fakeParent = { postMessage(msg) { posted.push(msg); } };
  const fakeWindow = {
    addEventListener(_type, fn) { messageListeners.push(fn); },
    location: { href: 'about:blank' }
  };

  const fn = new Function('parent', 'window', 'self', source);
  fn(fakeParent, fakeWindow, fakeWindow);

  return {
    posted,
    async send(msg) {
      const listener = messageListeners[messageListeners.length - 1];
      listener({ data: msg, source: fakeWindow });
      await new Promise(r => setImmediate(r));
    }
  };
}

// The wrap OffscreenExecutor.wrapScript applies in production — positions
// must be reported against the INNER step script, not this wrapper.
function wrap(code) {
  return '(async function(__input__) { ' + code + ' })(__input__);';
}

const TYPO_SCRIPT = [
  "const container = '[role=\"feed\"] > div:has(div[data-ad-preview=\"message\"])';",
  "const raw = await $extractWithHover(container, {",
  "  postIdLink:{selector:'a[href*=\"/posts/\"]', attr:'href'},",
  "  media:{selector:'img', attr:'src'},",
  "  html:{selector':'', attr:'outerHTML'}",
  "}, {hover:{anchorSel:'h3 a', popoverSel:'div[role=\"none\"]'}, allowEmpty:true});",
  "const posts = (raw || []).map(function(r, i){ return { index: i, postId: r.postIdLink || '' }; });",
  "return {posts: posts};"
].join('\n');

describe('sandbox.js syntax-error locator (twentieth log)', () => {
  it('a stray quote before a colon yields SYNTAX_ERROR with line/column and a marker on the offending quote', async () => {
    const sb = loadSandbox();
    await sb.send({ type: 'EXECUTE', script: wrap(TYPO_SCRIPT), input: {}, execId: 'exec-1' });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.ok(result, 'posted EXECUTE_RESULT');
    assert.ok(result.error, 'has error');
    assert.match(result.error, /SYNTAX_ERROR: Unexpected string/);
    assert.match(result.error, /line 5, column \d+/);
    // The marker lands in the offending `selector':'` token.
    assert.match(result.error, /selector':>>><<<''/);
    assert.match(result.error, />>><</);
  });

  it('positions are reported against the inner step script, not the async wrapper', async () => {
    const sb = loadSandbox();
    // Line 5 in TYPO_SCRIPT holds the typo; the wrapper prefix has no
    // newline, so the reported line must still be 5.
    await sb.send({ type: 'EXECUTE', script: wrap(TYPO_SCRIPT), input: {}, execId: 'exec-2' });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.match(result.error, /line 5,/);
  });

  it('a valid wrapped script still executes and returns normally', async () => {
    const sb = loadSandbox();
    await sb.send({ type: 'EXECUTE', script: wrap('const a = 1; return {ok: a};'), input: {}, execId: 'exec-3' });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.deepEqual(result.result, { ok: 1 });
    assert.equal(result.error, undefined);
  });

  it('an unterminated string locates its opening quote', async () => {
    const sb = loadSandbox();
    await sb.send({ type: 'EXECUTE', script: wrap("const a = 'abc; return {x: a};"), input: {}, execId: 'exec-4' });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.match(result.error, /SYNTAX_ERROR:/);
    assert.match(result.error, /line 1, column 1[12]/); // on the opening quote of the unterminated string
    assert.match(result.error, />>><<<'abc/);
  });

  it('SYNTAX_CHECK responses carry the same enrichment', async () => {
    const sb = loadSandbox();
    await sb.send({ type: 'SYNTAX_CHECK', script: wrap(TYPO_SCRIPT), reqId: 'req-1' });
    const result = sb.posted.find(m => m.type === 'SYNTAX_CHECK_RESULT');
    assert.equal(result.ok, false);
    assert.match(result.error, /SYNTAX_ERROR: Unexpected string/);
    assert.match(result.error, /selector':>>><<<''/);
  });

  it('drift pin: sandbox.js unwrap constants match OffscreenExecutor.wrapScript exactly', () => {
    const sandboxSrc = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');
    const executorSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'offscreen-executor.js'), 'utf8');
    const prefix = sandboxSrc.match(/const WRAP_PREFIX = '([^']+)';/);
    const suffix = sandboxSrc.match(/const WRAP_SUFFIX = '([^']+)';/);
    assert.ok(prefix && suffix, 'unwrap constants defined');
    const wrapRe = new RegExp('return `' + prefix[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\$\\{code\\} ' + suffix[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`;');
    assert.ok(
      wrapRe.test(executorSrc),
      'OffscreenExecutor.wrapScript must produce exactly WRAP_PREFIX + " ${code} " + WRAP_SUFFIX — otherwise sandbox.js unwraps nothing and reported columns shift'
    );
  });
});
