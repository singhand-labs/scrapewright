// B3: $extract fail-fasts at 5s while $click/$type burned the full 30s
// element wait — a wrong click selector cost 6x the step budget of a wrong
// extract selector. Default both to 10s, with an explicit override param.
// B11: $exists(sel, 0) was read as "unset" and polled the full 5s — 0 must
// mean one immediate query.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const SANDBOX_SRC = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

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

describe('B3: $click/$type element-wait default 10s + override', () => {
  it('domClick defaults the element wait to 10000ms and forwards an explicit timeout', async () => {
    const seen = [];
    const domClick = buildFn('domClick', {
      domQuerySelector: async (sel, t) => { seen.push(t); },
      querySelectorDeep: () => ({ element: { click() {}, tagName: 'BUTTON', id: '', className: '' } }),
      sendDebugLog: () => {},
      classStr: () => ''
    });
    await domClick('button.go');
    await domClick('button.go', 25000);
    assert.deepEqual(seen, [10000, 25000]);
  });

  it('domType defaults the element wait to 10000ms and forwards an explicit timeout', async () => {
    const seen = [];
    const domType = buildFn('domType', {
      domQuerySelector: async (sel, t) => { seen.push(t); },
      querySelectorDeep: () => ({ element: { tagName: 'INPUT', value: '', dispatchEvent() {} } }),
      sendDebugLog: () => {}
    });
    await domType('input.q', 'hi');
    await domType('input.q', 'hi', 25000);
    assert.deepEqual(seen, [10000, 25000]);
  });

  it('sandbox threads the override: $click(sel, timeoutMs) and $type(sel, text, timeoutMs)', () => {
    assert.match(SANDBOX_SRC, /\$click\s*=\s*\(\s*sel\s*,\s*timeoutMs\s*\)\s*=>\s*legacySend\('click',\s*sel,/);
    assert.match(SANDBOX_SRC, /\$type\s*=\s*\(\s*sel\s*,\s*text\s*,\s*timeoutMs\s*\)\s*=>\s*legacySend\('type',\s*sel,\s*\[text,/);
  });
});

describe('B11: $exists timeoutMs=0 is one immediate query', () => {
  it('0 performs exactly one querySelectorDeep call and returns false when absent', async () => {
    let calls = 0;
    const domExists = buildFn('domExists', {
      querySelectorDeep: () => { calls += 1; return null; },
      isElementVisible: () => false,
      sendDebugLog: () => {}
    });
    const r = await domExists('div.maybe', 0);
    assert.equal(r, false);
    assert.equal(calls, 1);
  });

  it('negative timeoutMs is clamped to the same immediate single query', async () => {
    let calls = 0;
    const domExists = buildFn('domExists', {
      querySelectorDeep: () => { calls += 1; return null; },
      isElementVisible: () => false,
      sendDebugLog: () => {}
    });
    await domExists('div.maybe', -5);
    assert.equal(calls, 1);
  });

  it('a visible match still returns true immediately (no mandatory sleep)', async () => {
    const domExists = buildFn('domExists', {
      querySelectorDeep: () => ({ element: {} }),
      isElementVisible: () => true,
      sendDebugLog: () => {}
    });
    const r = await domExists('div.here', 0);
    assert.equal(r, true);
  });
});
