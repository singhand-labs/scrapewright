// B12: $type(sel, undefined) typed the literal string "undefined" into the
// field (DOMString IDL coercion) with no signal. Coerce explicitly with
// String() and record the original type in _diagnostics.
// B13: recordDomActivity logged outcome 1 for $type even when the call was
// about to throw — the activity log never saw a failure.
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

function makeInput() {
  return { tagName: 'INPUT', value: '', dispatchEvent() {} };
}

describe('B12: $type coercion diagnostics', () => {
  it('a non-string text is String()-coerced and flagged with the original type', async () => {
    const el = makeInput();
    const domType = buildFn('domType', {
      domQuerySelector: async () => ({}),
      querySelectorDeep: () => ({ element: el }),
      sendDebugLog: () => {}
    });
    const out = await domType('input.q', undefined);
    assert.deepEqual(Object.keys(out).sort(), ['_diagnostics', 'result']);
    assert.equal(out.result, true);
    assert.equal(out._diagnostics.typeCoercedFrom, 'undefined');
    assert.match(out._diagnostics.note, /non-string/);
    assert.equal(el.value, 'undefined', 'documented coercion — visible in diagnostics, not silent');
  });

  it('null is reported as null (not the misleading typeof "object")', async () => {
    const el = makeInput();
    const domType = buildFn('domType', {
      domQuerySelector: async () => ({}),
      querySelectorDeep: () => ({ element: el }),
      sendDebugLog: () => {}
    });
    const out = await domType('input.q', null);
    assert.equal(out._diagnostics.typeCoercedFrom, 'null');
  });

  it('a plain string stays clean (no diagnostics key)', async () => {
    const el = makeInput();
    const domType = buildFn('domType', {
      domQuerySelector: async () => ({}),
      querySelectorDeep: () => ({ element: el }),
      sendDebugLog: () => {}
    });
    const out = await domType('input.q', 'hello');
    assert.deepEqual(out, { result: true });
    assert.equal(el.value, 'hello');
  });
});

describe('B13: handleDomRequest type case', () => {
  const DOM_FNS = ['domQuerySelector', 'domClick', 'domType', 'domExtract', 'domWait', 'domCheck',
    'domOpenTab', 'domExists', 'domCount', 'domList', 'domWaitForStable', 'domExtractList',
    'domExtractListMulti', 'domClickInList', 'domExtractWithHover', 'domScrollBy',
    'domScrollToBottom', 'domScrollIntoView', 'domHover', 'recordDomActivity'];

  function buildHandleDomRequest(overrides) {
    const base = {};
    for (const n of DOM_FNS) base[n] = async () => ({ result: {} });
    const o = Object.assign(base, overrides || {});
    const factory = eval('(function (' + DOM_FNS.join(', ') + ') { return (' + sliceFn('handleDomRequest') + '); })');
    return factory(...DOM_FNS.map((n) => o[n]));
  }

  it('unwraps the {result,_diagnostics} envelope', async () => {
    const handle = buildHandleDomRequest({ domType: async () => ({ result: true, _diagnostics: { typeCoercedFrom: 'undefined' } }) });
    const out = await handle({ action: 'type', selector: 'input.q', args: [undefined] });
    assert.equal(out.result, true);
    assert.deepEqual(out._diagnostics, { typeCoercedFrom: 'undefined' });
  });

  it('records outcome 0 when domType throws (then rethrows)', async () => {
    const activity = [];
    const handle = buildHandleDomRequest({
      domType: async () => { throw new Error('ELEMENT_NOT_INPUTTABLE'); },
      recordDomActivity: (m, s, o) => activity.push([m, s, o])
    });
    // The rethrow lands in handleDomRequest's own catch, which builds the
    // {result, error, ...} error payload (the B2-pinned existing flow).
    const out = await handle({ action: 'type', selector: 'input.q', args: ['x'] });
    assert.match(out.error, /ELEMENT_NOT_INPUTTABLE/);
    assert.equal(out.result, undefined);
    assert.deepEqual(activity, [['$type', 'input.q', 0]]);
  });

  it('records outcome 1 on success', async () => {
    const activity = [];
    const handle = buildHandleDomRequest({
      domType: async () => ({ result: true }),
      recordDomActivity: (m, s, o) => activity.push([m, s, o])
    });
    await handle({ action: 'type', selector: 'input.q', args: ['x'] });
    assert.deepEqual(activity, [['$type', 'input.q', 1]]);
  });
});
