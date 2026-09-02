// extension/test/content-script-invalid-selector.test.js
//
// Ninth-log M4: the model probed `[role='button']:has-text-login` (a
// Playwright-style pseudo-class that does not exist in CSS). querySelectorAll
// threw, domCount caught the exception, logged a debug line, and returned
// els=[] — so the tool reported {"count":0}. The session's grounding ledger
// recorded "no login button" from a selector that never ran. The DSL guide
// already teaches that invalid selectors "throw 'not a valid selector'
// instantly and kill the step" (dsl-guide-css-only.test.js); $count/$list
// must honor the same contract.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists in content-script.js');
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function buildFn(name, querySelectorAllDeepImpl) {
  const factory = eval('(function (querySelectorAllDeep, sendDebugLog, getListExtractOps) { return (' + sliceFn(name) + '); })');
  return factory(
    querySelectorAllDeepImpl,
    () => {}, // sendDebugLog — console mirroring is irrelevant here
    () => null // getListExtractOps
  );
}

const INVALID = new Error('":has-text-login" is not a valid selector.');

describe('domCount invalid-selector contract (ninth-log M4)', () => {
  it('throws on an invalid selector instead of silently returning 0', () => {
    const domCount = buildFn('domCount', () => { throw INVALID; });
    assert.throws(() => domCount('[role=\'button\']:has-text-login'), /not a valid selector/);
  });

  it('returns the count for a valid selector (existing behavior preserved)', () => {
    const domCount = buildFn('domCount', () => [{}, {}, {}]);
    const r = domCount('div.card');
    assert.equal(r.result, 3);
    assert.ok(r._diagnostics, 'diagnostics still attached');
  });
});

describe('domList invalid-selector contract (ninth-log M4)', () => {
  it('throws on an invalid selector instead of silently returning []', () => {
    const domList = buildFn('domList', () => { throw INVALID; });
    assert.throws(() => domList('a:has-text-login'), /not a valid selector/);
  });
});
