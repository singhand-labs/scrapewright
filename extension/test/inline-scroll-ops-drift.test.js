// Drift guard: content-script.js's createInlineScrollOps() inline fallback
// MUST export the same function names + property keys as lib/scroll-ops.js's
// public `api` object. The fallback fires when Chrome's MV3 content-script
// injection glitches (see comment block in content-script.js and the
// scrollToBottom_entry {hasScrollOps:false} diagnostic in console.log
// 2026-07-29). If the two objects drift, the fallback silently loses
// capabilities — e.g. RC19's trusted-wheel handling would vanish from the
// inline path, making $scrollToBottom silently degrade to no-progress-break
// under the glitch.
//
// This test parses both files as text rather than executing them, because
// content-script.js is a strict-mode IIFE that does not export anything.
// Mirrors test/inline-list-extract-ops-drift.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'scroll-ops.js');
const CONTENT_SCRIPT_PATH = path.join(__dirname, '..', 'content-script.js');

function extractModuleExports(source) {
  // Match: var api = { ... }; (the public api object near the end)
  const m = source.match(/var\s+api\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, 'lib/scroll-ops.js: could not find `var api = { ... };`');
  const names = (m[1].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).filter(
    (n) => n !== 'module' && n !== 'exports' && n !== 'window' && n !== 'self'
  );
  return Array.from(new Set(names));
}

function sliceFunctionBody(source, fnName) {
  const fnStart = source.indexOf('function ' + fnName);
  assert.ok(fnStart !== -1, 'content-script.js: ' + fnName + ' not found');
  let depth = 0;
  let inString = null;
  let fnBodyStart = -1;
  let fnEnd = -1;
  for (let i = fnStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') {
      if (depth === 0) fnBodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) { fnEnd = i; break; }
    }
  }
  assert.ok(fnEnd !== -1, 'content-script.js: ' + fnName + ' body never closes');
  return source.slice(fnBodyStart, fnEnd);
}

function extractInlineReturn(source) {
  const body = sliceFunctionBody(source, 'createInlineScrollOps');
  // Find the LAST `return {` in the function body — that's the public api
  // object. Earlier `return { ... }` statements belong to inner helpers
  // (findScrollableContainer's `return best` and similar).
  let lastRet = -1;
  for (let i = 0; i < body.length - 8; i++) {
    if (body[i] === 'r' && body.slice(i, i + 8) === 'return {') {
      lastRet = i;
    }
  }
  assert.ok(lastRet !== -1, 'content-script.js: createInlineScrollOps has no return object');
  let i = lastRet + 'return '.length;
  let rdepth = 0;
  let inString = null;
  let end = -1;
  for (; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') rdepth++;
    else if (ch === '}') {
      rdepth--;
      if (rdepth === 0) { end = i; break; }
    }
  }
  assert.ok(end !== -1, 'content-script.js: createInlineScrollOps return object not balanced');
  const retBody = body.slice(lastRet + 'return '.length, end + 1);
  const names = (retBody.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).filter(
    (n) => n !== 'return'
  );
  return Array.from(new Set(names));
}

describe('inline ScrollOps fallback drift guard', () => {
  it('inline fallback returns the same keys as lib module exports', () => {
    const moduleSrc = fs.readFileSync(MODULE_PATH, 'utf8');
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const moduleExports = extractModuleExports(moduleSrc).sort();
    const inlineExports = extractInlineReturn(csSrc).sort();

    assert.deepEqual(
      inlineExports,
      moduleExports,
      'content-script.js createInlineScrollOps() return object must list the same keys as ' +
      'lib/scroll-ops.js `var api = { ... }`. If you added a function/property to the module, ' +
      'mirror it in the inline fallback — otherwise the fallback (fired by Chrome MV3 injection ' +
      'glitch) silently loses capabilities.'
    );
  });

  it('inline fallback source defines each exported function by name', () => {
    const moduleSrc = fs.readFileSync(MODULE_PATH, 'utf8');
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const moduleExports = extractModuleExports(moduleSrc);
    for (const name of moduleExports) {
      // Only check function-typed exports (skip scalar constants like
      // DEFAULT_SETTLE_MS — those are values, not function definitions).
      const looksLikeFn = /^[A-Z]/.test(name) === false;
      if (!looksLikeFn) continue;
      const defPattern = new RegExp('function\\s+' + name + '\\s*\\(');
      assert.ok(
        defPattern.test(csSrc),
        'content-script.js: inline fallback is missing function definition for "' + name + '". ' +
        'Update the inline fallback to mirror lib/scroll-ops.js.'
      );
    }
  });

  it('inline fallback preserves RC19 trusted-wheel handling', () => {
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const body = sliceFunctionBody(csSrc, 'createInlineScrollOps');
    assert.ok(
      /trustedWheelFallback/.test(body),
      'content-script.js: inline ScrollOps fallback must reference trustedWheelFallback. ' +
      'Without it, the RC19 trusted-wheel stall-recovery is silently lost under the MV3 glitch.'
    );
    assert.ok(
      /maxTrustedWheelAttempts/.test(body),
      'content-script.js: inline ScrollOps fallback must reference maxTrustedWheelAttempts.'
    );
    assert.ok(
      /DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS\s*=\s*3/.test(body),
      'content-script.js: inline ScrollOps fallback must define DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS=3.'
    );
  });

  it('inline fallback preserves RC19 follow-up no-overflow early-exit (2026-07-29)', () => {
    // lib/scroll-ops.js added an early-exit when the chosen root has no
    // overflow (clientHeight >= scrollHeight) — prevents spinning the loop
    // and invoking trustedWheelFallback on an unscrollable root (which for
    // background tabs hangs ~60s on a CDP callback that never fires).
    // Without this mirror, the inline fallback would silently degrade under
    // the MV3 glitch.
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const body = sliceFunctionBody(csSrc, 'createInlineScrollOps');
    assert.ok(
      /noOverflow/.test(body),
      'content-script.js: inline ScrollOps fallback must include the noOverflow early-exit check. ' +
      'See lib/scroll-ops.js RC19 follow-up (2026-07-29).'
    );
    assert.ok(
      /prevScrollHeight\s*<=\s*rootClientHeight/.test(body),
      'content-script.js: inline ScrollOps fallback must compare prevScrollHeight <= rootClientHeight ' +
      'to detect the no-overflow case.'
    );
  });
});
