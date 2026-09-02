// B2: handleDomRequest's catch must merge err._diagnostics into the error
// payload — a dom* helper that diagnosed a failure before throwing loses
// that evidence today, and autoFix then iterates blind.
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

const DOM_FNS = ['domQuerySelector', 'domClick', 'domType', 'domExtract', 'domWait', 'domCheck',
  'domOpenTab', 'domExists', 'domCount', 'domList', 'domWaitForStable', 'domExtractList',
  'domExtractListMulti', 'domClickInList', 'domExtractWithHover', 'domScrollBy',
  'domScrollToBottom', 'domScrollIntoView', 'domHover', 'recordDomActivity'];

function buildHandleDomRequest(overrides) {
  const base = {};
  for (const n of DOM_FNS) base[n] = async () => ({ result: {} });
  const o = Object.assign(base, overrides || {});
  const factory = eval('(function (' + DOM_FNS.join(', ') + ') { return (async ' + sliceFn('handleDomRequest') + '); })');
  return factory(...DOM_FNS.map((n) => o[n]));
}

describe('B2: error diagnostics survive handleDomRequest', () => {
  it('a throwing dom helper carrying _diagnostics has them merged into the error payload', async () => {
    const boom = new Error('SELECTOR_DIAGNOSED_FAILURE');
    boom._diagnostics = { api: 'extract', matchCount: 0, note: 'container matched but field selector empty' };
    const handle = buildHandleDomRequest({ domExtract: async () => { throw boom; } });
    const out = await handle({ action: 'extract', selector: 'div.x', args: [null] });
    assert.match(out.error, /SELECTOR_DIAGNOSED_FAILURE/);
    assert.deepEqual(out._diagnostics, boom._diagnostics);
  });

  it('errors without _diagnostics still produce a clean payload (no undefined leaks)', async () => {
    const handle = buildHandleDomRequest({ domExtract: async () => { throw new Error('plain'); } });
    const out = await handle({ action: 'extract', selector: 'div.x', args: [null] });
    assert.match(out.error, /plain/);
    assert.equal('_diagnostics' in out && out._diagnostics !== undefined, false);
  });
});
