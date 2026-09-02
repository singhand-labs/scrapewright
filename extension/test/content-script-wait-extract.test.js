// B4: $wait('') silently skipped the element wait and returned true — a
// fake success indistinguishable from a real wait. M4 precedent: invalid
// selector inputs throw with teaching text.
// B10: $extract(sel, 'attr') returning null on an absent attribute carried
// no signal — add an attr-absent diagnostic so autoFix can tell "element
// matched, attribute missing" from "selector wrong".
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

function buildFn(name, deps) {
  const keys = Object.keys(deps);
  const factory = eval('(function (' + keys.join(', ') + ') { return (' + sliceFn(name) + '); })');
  return factory(...keys.map((k) => deps[k]));
}

describe('B4: $wait empty selector', () => {
  it('throws WAIT_SELECTOR_EMPTY with teaching text on ""', async () => {
    const domWait = buildFn('domWait', { domQuerySelector: async () => ({}), sendDebugLog: () => {} });
    await assert.rejects(() => domWait('', 500), /WAIT_SELECTOR_EMPTY/);
  });

  it('throws WAIT_SELECTOR_EMPTY on undefined too (missing argument is not a pure sleep)', async () => {
    const domWait = buildFn('domWait', { domQuerySelector: async () => ({}), sendDebugLog: () => {} });
    await assert.rejects(() => domWait(undefined, 500), /WAIT_SELECTOR_EMPTY/);
  });

  it('a real selector still waits then sleeps', async () => {
    const waited = [];
    const domWait = buildFn('domWait', { domQuerySelector: async (s) => { waited.push(s); }, sendDebugLog: () => {} });
    const r = await domWait('div.ready', 0);
    assert.equal(r, true);
    assert.deepEqual(waited, ['div.ready']);
  });
});

describe('B10: $extract attr-absent diagnostic', () => {
  function makeDomExtract(element) {
    return buildFn('domExtract', {
      domQuerySelector: async () => ({}),
      querySelectorDeep: () => ({ element }),
      sendDebugLog: () => {},
      getListExtractOps: () => null
    });
  }

  it('null from a missing attribute carries attrAbsent in _diagnostics', async () => {
    const el = { tagName: 'DIV', textContent: 'hi', getAttribute: () => null };
    const out = await makeDomExtract(el)('div.x', 'data-id');
    assert.equal(out.result, null);
    assert.equal(out._diagnostics.attrAbsent, true);
    assert.match(out._diagnostics.attrAbsentNote, /attribute/);
  });

  it('a present attribute and plain textContent extraction stay clean', async () => {
    const el = { tagName: 'DIV', textContent: 'hi', getAttribute: () => 'abc' };
    const out = await makeDomExtract(el)('div.x', 'data-id');
    assert.equal(out.result, 'abc');
    assert.equal(out._diagnostics.attrAbsent, undefined);
    const out2 = await makeDomExtract({ tagName: 'DIV', textContent: ' body ', getAttribute: () => null })('div.x');
    assert.equal(out2.result, 'body');
    assert.equal(out2._diagnostics.attrAbsent, undefined);
  });
});
