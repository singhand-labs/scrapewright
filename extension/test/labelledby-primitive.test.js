// Twenty-fourth log root fix (hidden-risk follow-up ③): the timestamp value
// existed ONLY in the hidden-but-readable span the anchor's aria-labelledby
// reference pointed at — the visible tooltip never rendered (zero-height
// mounts), and the model fought 14 hover variants because no read primitive
// resolves ARIA reference chains. $labelledby / probe.labelledby resolve the
// id list and concatenate the referenced elements' text in one call, with
// falsification notes on every empty path (attr absent / ids unresolvable /
// refs carry no text).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const SANDBOX_SRC = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined in content-script.js');
  let depth = 0, i = start;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return SRC.slice(start, i + 1);
}

function resolver(document) {
  return new Function('document', 'return (' + sliceFn('resolveLabelledbyText') + ')')(document);
}

function tooltipDom() {
  return new JSDOM(
    '<a id="anchor1" aria-labelledby="tt1 tt2">3:42 PM</a>' +
    '<span id="tt1" style="display:none">July 17, 2026 at 3:42 PM</span>' +
    '<span id="tt2" style="display:none">tooltip extra</span>' +
    '<a id="anchor2" aria-labelledby="ghost1 ghost2">v2</a>' +
    '<a id="anchor3" aria-labelledby="tt3">v3</a><span id="tt3"></span>' +
    '<a id="anchor4">plain</a>' +
    '<a id="anchor5" aria-describedby="desc1">v5</a><span id="desc1">described here</span>'
  ).window.document;
}

describe('resolveLabelledbyText (twenty-fourth-log root fix)', () => {
  it('resolves the id list and concatenates referenced texts (hidden but readable)', () => {
    const doc = tooltipDom();
    const r = resolver(doc)(doc.getElementById('anchor1'), 'aria-labelledby');
    assert.equal(r.text, 'July 17, 2026 at 3:42 PM tooltip extra');
    assert.equal(r.refCount, 2);
    assert.deepEqual(r.missingIds, []);
  });

  it('falsifies: attr absent names the sibling fallbacks', () => {
    const doc = tooltipDom();
    const r = resolver(doc)(doc.getElementById('anchor4'), 'aria-labelledby');
    assert.equal(r.text, '');
    assert.match(r.note, /aria-labelledby.*absent.*aria-describedby/);
  });

  it('falsifies: unresolvable ids are named (stale/dynamic ids)', () => {
    const doc = tooltipDom();
    const r = resolver(doc)(doc.getElementById('anchor2'), 'aria-labelledby');
    assert.equal(r.text, '');
    assert.deepEqual(r.missingIds, ['ghost1', 'ghost2']);
    assert.match(r.note, /resolve to nothing/);
  });

  it('falsifies: refs exist but carry no text', () => {
    const doc = tooltipDom();
    const r = resolver(doc)(doc.getElementById('anchor3'), 'aria-labelledby');
    assert.equal(r.text, '');
    assert.equal(r.refCount, 1);
    assert.match(r.note, /none carry text/);
  });

  it('supports aria-describedby', () => {
    const doc = tooltipDom();
    const r = resolver(doc)(doc.getElementById('anchor5'), 'aria-describedby');
    assert.equal(r.text, 'described here');
    assert.equal(r.attr, 'aria-describedby');
  });
});

describe('$labelledby wiring (source audit)', () => {
  it('sandbox exposes the primitive; content-script dispatches it; domLabelledby defaults the attr safely', () => {
    assert.match(SANDBOX_SRC, /\$labelledby = \(sel, attr, timeoutMs\) => sendDomRequest\('labelledby', sel, \[attr, timeoutMs\]\)/);
    assert.match(SRC, /case 'labelledby':/);
    assert.match(SRC, /domLabelledby\(data\.selector, data\.args && data\.args\[0\], data\.args && data\.args\[1\]\)/);
    assert.match(SRC, /const refAttr = \(attr === 'aria-describedby' \|\| attr === 'aria-labelledby'\) \? attr : 'aria-labelledby';/, 'non-reference attrs fall back to aria-labelledby instead of reading an arbitrary attribute');
  });

  it('DSL guide and session-tools teach the primitive and the probe', () => {
    const WU = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    assert.match(WU, /- \$labelledby\(selector, attr\?, timeoutMs\?\)/);
    assert.match(WU, /HIDDEN but readable \(reads are not visibility-gated\)/i);
    const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
    assert.match(ST, /\$labelledby\(sel, attr\?, timeoutMs\?\)/, '$ API listing');
    assert.match(ST, /name: 'probe\.labelledby'/, 'probe tool spec');
    assert.match(ST, /'probe\.labelledby': probes\.labelledby/, 'probe registered');
  });
});

function makeTools(executorImpl) {
  const observationLog = createObservationLog();
  const tools = createProbeTools({ executeDsl: executorImpl, observationLog });
  return { tools, observationLog };
}

describe('probe.labelledby', () => {
  it('composes the $labelledby primitive and returns the text with diagnostics merged', async () => {
    const { tools, observationLog } = makeTools(async (snippet) => {
      assert.match(snippet, /return \$labelledby\(/);
      assert.match(snippet, /"aria-labelledby"/);
      // Thirty-second log RC-C: the DSL returns the self-describing object —
      // probe.labelledby passes that exact shape through.
      return { text: 'July 17, 2026 at 3:42 PM', attr: 'aria-labelledby', refCount: 2, missingIds: [] };
    });
    const r = await tools.labelledby('#anchor1');
    assert.equal(r.text, 'July 17, 2026 at 3:42 PM');
    assert.equal(r.refCount, 2);
    assert.ok(observationLog.covers('#anchor1'), 'observation receipt recorded');
    assert.ok(observationLog.serialize().entries.some(e => e.tool === 'probe.labelledby'));
  });

  it('rejects non-string attr instead of composing a broken snippet', async () => {
    const { tools } = makeTools(async () => { throw new Error('must not run'); });
    const r = await tools.labelledby('#a', 42);
    assert.match(r.error, /attr must be a string/);
  });

  it('propagates executor errors without recording a receipt', async () => {
    const { tools, observationLog } = makeTools(async () => { throw new Error('ELEMENT_NOT_FOUND: #gone'); });
    const r = await tools.labelledby('#gone');
    assert.equal(r.error, 'ELEMENT_NOT_FOUND: #gone');
    assert.equal(observationLog.size(), 0);
  });
});
