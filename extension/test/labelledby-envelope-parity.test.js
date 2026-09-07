// Thirty-second log root fix (RC-C): probe.labelledby returned {text, ...}
// while the DSL primitive $labelledby returned a BARE string — the probe is
// empirical evidence and beat the prose doc, so the model wrote
// `(await $labelledby(sel)).text` in the shipped artifact. postTime was
// structurally ALWAYS empty across v2-v4 and the session died at 60 turns one
// verify short of green. The envelopes must MATCH: the DSL returns the same
// self-describing object the probe shows (RC51 anchorHref pattern — make
// envelope-copying CORRECT instead of teaching around it).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const SESSION_TOOLS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const WIZARD_UTILS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');

function fnBody(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  assert.ok(start > -1, name + ' must exist');
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

describe('DSL $labelledby returns the self-describing object (RC-C)', () => {
  it('domLabelledby returns the resolveLabelledbyText object as the result, not the flattened text', () => {
    const body = fnBody(SRC, 'domLabelledby');
    assert.match(body, /const resolved = resolveLabelledbyText\(found\.element, refAttr\)/);
    assert.match(body, /return \{ result: resolved, _diagnostics \}/,
      'the DSL resolves to {text, attr, refCount, missingIds, note?} — exactly the shape probe.labelledby shows');
    assert.ok(!/result: resolved\.text/.test(body), 'the old bare-string flattening is gone');
  });
});

describe('probe.labelledby passes the DSL shape through verbatim (RC-C)', () => {
  function makeTools(executorImpl) {
    const observationLog = createObservationLog();
    const tools = createProbeTools({ executeDsl: executorImpl, observationLog });
    return { tools, observationLog };
  }

  it('returns the SAME keys the DSL returns — nothing invented, nothing hidden', async () => {
    const dslReturn = { text: 'July 17, 2026 at 3:42 PM tooltip extra', attr: 'aria-labelledby', refCount: 2, missingIds: [] };
    const { tools } = makeTools(async () => dslReturn);
    const r = await tools.labelledby('#anchor1');
    assert.equal(r.text, dslReturn.text);
    assert.equal(r.attr, dslReturn.attr);
    assert.equal(r.refCount, 2);
    assert.deepEqual(r.missingIds, []);
    assert.deepEqual(Object.keys(r).sort(), ['attr', 'missingIds', 'refCount', 'text'],
      'probe envelope keys === DSL return keys — envelope-copying into a step script must be CORRECT');
  });

  it('keeps the DSL falsification note when the refs resolve to nothing', async () => {
    const dslReturn = { text: '', attr: 'aria-labelledby', refCount: 0, missingIds: ['ghost1'], note: 'aria-labelledby references id(s) that resolve to nothing in this document (dynamic/stale ids): ghost1' };
    const { tools } = makeTools(async () => dslReturn);
    const r = await tools.labelledby('#gone');
    assert.equal(r.text, '');
    assert.match(r.note, /resolve to nothing/);
    assert.deepEqual(r.missingIds, ['ghost1']);
  });

  it('error results still propagate untouched', async () => {
    const { tools, observationLog } = makeTools(async () => { throw new Error('ELEMENT_NOT_FOUND: #x'); });
    const r = await tools.labelledby('#x');
    assert.equal(r.error, 'ELEMENT_NOT_FOUND: #x');
    assert.equal(observationLog.size(), 0);
  });

  it('observation summary reads the object shape', async () => {
    const { tools, observationLog } = makeTools(async () => ({ text: '5 hours ago', attr: 'aria-labelledby', refCount: 1, missingIds: [] }));
    await tools.labelledby('#t');
    const e = observationLog.serialize().entries.find((x) => x.tool === 'probe.labelledby');
    assert.ok(e, 'receipt recorded');
    assert.match(e.summary, /len=11/, 'summary derives from the object text');
  });
});

describe('$ API doc lines carry explicit return shapes (RC-C)', () => {
  it('the session-tools $labelledby line names the object return and the .text assignment', () => {
    const line = SESSION_TOOLS.split('\n').find((l) => l.includes('$labelledby(sel'));
    assert.ok(line, '$labelledby $ API line exists');
    assert.match(line, /→ \{text, attr, refCount, missingIds\?, note\?\}/);
    assert.match(line, /\.text\b/, 'the line shows which key carries the value');
  });

  it('the session-tools $extract line names its bare-string return', () => {
    const line = SESSION_TOOLS.split('\n').find((l) => l.includes('$extract(sel'));
    assert.ok(line, '$extract $ API line exists');
    assert.match(line, /→ string/);
  });

  it('the wizard-utils DSL guide teaches the object return for $labelledby', () => {
    const i = WIZARD_UTILS.indexOf('$labelledby(selector');
    assert.ok(i > -1, 'guide line exists');
    const chunk = WIZARD_UTILS.slice(i, i + 700);
    assert.match(chunk, /\{text, attr, refCount, missingIds\?, note\?\}/);
    assert.match(chunk, /\.text\b/);
  });
});
