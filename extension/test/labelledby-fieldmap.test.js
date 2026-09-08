// Thirty-third log D1: the model PROVED the clean value lives in the
// elements an ARIA reference points at (probe.labelledby returned "June 25"
// while the visible span's textContent was anti-scrape decoy junk), but
// $extractList's fieldMap could only read textContent (the decoy) or a raw
// attribute (the id list) — the $labelledby primitive's resolution had no
// fieldMap expression, so the diagnosis never reached the artifact across
// every version (v2 shipped the decoy junk, v3 zero-matched).
//
// Fix under test: field spec gains `labelledby: true | '<attr>'` — resolves
// the ARIA reference on each match and yields the referenced elements'
// concatenated text. Mirrors $labelledby / probe.labelledby resolution.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const LIB = require(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'));
const CS_PATH = path.join(__dirname, '..', 'content-script.js');
const WU = require(path.join(__dirname, '..', 'lib', 'wizard-utils.js'));

const DECOY = 'eporntosdS9u77m62gllh0i16i81a1l5gcf7hg2taf545h7tcu9c32mt5i9c';

function freshDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div class="card" id="card1">
      <span class="ts" aria-labelledby="idA idB">${DECOY}</span>
      <span class="desc" aria-describedby="idC">visual</span>
    </div>
    <div class="card" id="card2">
      <span class="ts">plain text</span>
      <span class="desc">bare</span>
      <span class="none">no reference attr</span>
    </div>
    <span id="idA" hidden>June 25</span>
    <span id="idB" hidden>at 3:42 PM</span>
    <span id="idC" hidden>the tooltip payload</span>
  </body></html>`);
  return dom;
}

// ---- comment-aware brace walker (same technique as the drift-guard test) ----
function extractFnSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'could not find function ' + name);
  let depth = 0, inString = null, bodyStart = -1, bodyEnd = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') { if (depth === 0) bodyStart = i + 1; depth++; }
    else if (ch === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert.ok(bodyEnd !== -1, 'function ' + name + ' body never closes');
  return source.slice(start, bodyEnd + 1);
}

// The inline fallback runs inside content-script's IIFE where
// resolveLabelledbyText is hoisted into scope — emulate by declaring it on
// the global the eval'd factory will see.
function buildInlineOps(dom) {
  const csSrc = fs.readFileSync(CS_PATH, 'utf8');
  global.document = dom.window.document;
  const resolverSrc = extractFnSource(csSrc, 'resolveLabelledbyText');
  const factorySrc = extractFnSource(csSrc, 'createInlineListExtractOps');
  (0, eval)(resolverSrc); // declares resolveLabelledbyText on global scope
  const factory = (0, eval)(factorySrc + '; createInlineListExtractOps');
  return factory();
}

describe('fieldMap labelledby resolution — lib path', () => {
  let dom, cards;
  beforeEach(() => {
    dom = freshDom();
    global.document = dom.window.document;
    cards = [dom.window.document.getElementById('card1'), dom.window.document.getElementById('card2')];
  });

  it('resolves aria-labelledby refs and bypasses the decoy textContent', () => {
    const recs = LIB.extractListRecords(cards, { time: { selector: '.ts', labelledby: true } }, { allowEmpty: true });
    assert.equal(recs[0].time, 'June 25 at 3:42 PM');
    assert.ok(recs[0].time.indexOf(DECOY) === -1, 'decoy textContent must not leak into the resolved value');
  });

  it('card without the reference attr yields empty string (matched but unresolvable), missing selector stays undefined', () => {
    const recs = LIB.extractListRecords(cards, [
      { time: { selector: '.ts', labelledby: true } },
      { none: { selector: '.none', labelledby: true } },
      { absent: { selector: '.nope', labelledby: true } }
    ].reduce((m, e) => Object.assign(m, e), {}), { allowEmpty: true });
    // card1 .ts resolves; card2 .ts has no aria-labelledby → '' (not junk text)
    const r2 = recs[1];
    assert.equal(r2.time, '');
    assert.notEqual(r2.time, 'plain text');
    assert.equal(r2.none, ''); // element matched, attr absent
    assert.strictEqual(r2.absent, undefined); // selector missed — existing semantics
  });

  it("labelledby:'aria-describedby' resolves that attribute instead", () => {
    const recs = LIB.extractListRecords(cards, { tip: { selector: '.desc', labelledby: 'aria-describedby' } }, { allowEmpty: true });
    assert.equal(recs[0].tip, 'the tooltip payload');
    assert.equal(recs[1].tip, '');
  });

  it('multi mode resolves every match into an array of resolved texts', () => {
    const recs = LIB.extractListMultiRecords(cards, { ts: { selector: '.ts', labelledby: true } }, { allowEmpty: true });
    assert.deepEqual(recs[0].ts, ['June 25 at 3:42 PM']);
    assert.deepEqual(recs[1].ts, ['']);
  });

  it('empty selector + labelledby resolves on the container itself', () => {
    const recs = LIB.extractListRecords(cards, { self: { labelledby: true } }, { allowEmpty: true });
    // Forty-third log: the container carries no reference attribute, but its
    // descendant .ts does — descent resolves through it (own attrs first,
    // descendant carrier as fallback). Pre-descent this was ''.
    assert.equal(recs[0].self, 'June 25 at 3:42 PM');
    assert.equal(recs[1].self, ''); // card2: no attr anywhere in the subtree
    const dom2 = new JSDOM(`<!DOCTYPE html><div class="c" aria-labelledby="x1"><i>decoy</i></div><span id="x1">container-level truth</span>`);
    global.document = dom2.window.document;
    const recs2 = LIB.extractListRecords([dom2.window.document.querySelector('.c')], { self: { labelledby: true } }, { allowEmpty: true });
    assert.equal(recs2[0].self, 'container-level truth');
  });

  it('extractWithHover fieldMap carries the same labelledby semantics', async () => {
    const hoverFn = async () => ({ hovered: true, htmlSnippet: '<div/>' });
    const recs = await LIB.extractWithHoverRecords(cards, { time: { selector: '.ts', labelledby: true } }, { anchorSel: '.ts' }, hoverFn, { allowEmpty: true });
    assert.equal(recs[0].time, 'June 25 at 3:42 PM');
    assert.ok(Array.isArray(recs[0].hovercards));
  });

  it('computeExtractListDiagnostics marks labelledby fields and samples RESOLVED values', () => {
    const d = LIB.computeExtractListDiagnostics(cards, { time: { selector: '.ts', labelledby: true } }, '.card');
    const pf = d.perField[0];
    assert.equal(pf.labelledby, 'aria-labelledby');
    assert.equal(pf.matchCount, 2);
    assert.deepEqual(pf.sampleValues, ['June 25 at 3:42 PM']);
    assert.equal(pf.refResolved, 1); // only card1 produced text
  });

  it('computeExtractListDiagnostics carries missingIds for unresolvable references', () => {
    const dom2 = new JSDOM(`<!DOCTYPE html><div class="c"><span class="ts" aria-labelledby="gone1 gone2">x</span></div>`);
    global.document = dom2.window.document;
    const c = dom2.window.document.querySelector('.c');
    const d = LIB.computeExtractListDiagnostics([c], { time: { selector: '.ts', labelledby: true } }, '.c');
    const pf = d.perField[0];
    assert.equal(pf.matchCount, 1);
    assert.equal(pf.refResolved, 0);
    assert.deepEqual(pf.missingIds, ['gone1', 'gone2']);
  });
});

describe('fieldMap labelledby resolution — inline fallback parity', () => {
  it('inline ops resolve identically (lib vs createInlineListExtractOps)', () => {
    const dom = freshDom();
    const inlineOps = buildInlineOps(dom);
    const cards = [dom.window.document.getElementById('card1'), dom.window.document.getElementById('card2')];
    const recs = inlineOps.extractListRecords(cards, { time: { selector: '.ts', labelledby: true } }, { allowEmpty: true });
    assert.equal(recs[0].time, 'June 25 at 3:42 PM');
    assert.equal(recs[1].time, '');
    const multi = inlineOps.extractListMultiRecords(cards, { ts: { selector: '.ts', labelledby: true } }, { allowEmpty: true });
    assert.deepEqual(multi[0].ts, ['June 25 at 3:42 PM']);
    const d = inlineOps.computeExtractListDiagnostics(cards, { time: { selector: '.ts', labelledby: true } }, '.card');
    assert.equal(d.perField[0].labelledby, 'aria-labelledby');
    assert.equal(d.perField[0].refResolved, 1);
  });
});

describe('labelledby falsification crumbs (emptyFieldDiagnostics)', () => {
  it('matched-but-unresolvable produces a resolution crumb, not silence', () => {
    const diags = [{
      api: 'extractList',
      containerMatches: 2,
      containerSelector: "div[role='feed'] > div",
      perField: [{
        field: 'postingTime',
        subSelector: 'span.ts',
        labelledby: 'aria-labelledby',
        matchCount: 2,
        refResolved: 0,
        missingIds: ['dyn1', 'dyn2'],
        sampleValues: []
      }]
    }];
    const events = [{ type: 'STEP_ITERATION', stepId: 'extract', selectorDiagnostics: diags }];
    const steps = [{ id: 'extract', name: 'extract', script: 'postingTime' }];
    const out = WU.emptyFieldDiagnostics(
      [{ field: 'postingTime', path: 'posts.postingTime', emptyCount: 2, totalCount: 2 }],
      steps, events);
    assert.ok(out.length === 1, 'crumb entry expected');
    const crumb = out[0].crumbs[0];
    assert.ok(/aria-labelledby/.test(crumb.note), 'crumb names the reference attr: ' + crumb.note);
    assert.ok(/resolved no text|produced no text/i.test(crumb.note), 'crumb says the resolution died: ' + crumb.note);
    assert.ok(/dyn1/.test(crumb.note), 'crumb carries unresolved ids: ' + crumb.note);
  });
});

describe('labelledby fieldMap source-teaching (doc lines)', () => {
  it('session-tools DSL guide documents the labelledby option', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
    const line = src.split('\n').find((l) => l.indexOf('$extractList(containerSel') !== -1);
    assert.ok(line, '$extractList guide line found');
    assert.ok(/labelledby/.test(line), 'guide line teaches labelledby: ' + line);
  });

  it('wizard-utils DSL guide documents the labelledby option', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    const i = src.indexOf('$extractList(containerSel, fieldMap, opts?):');
    assert.ok(i !== -1);
    const seg = src.slice(i, i + 700);
    assert.ok(/labelledby/.test(seg), 'DSL guide segment teaches labelledby');
  });

  it('both readField implementations carry the labelledby branch (drift)', () => {
    const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');
    const csSrc = fs.readFileSync(CS_PATH, 'utf8');
    const libFn = extractFnSource(libSrc, 'readField');
    const inlineFn = extractFnSource(csSrc, 'readField');
    assert.ok(/labelledby/i.test(libFn), 'lib readField handles labelledby');
    assert.ok(/labelledby/i.test(inlineFn), 'inline readField handles labelledby');
    const libAll = extractFnSource(libSrc, 'readFieldAll');
    const inlineAll = extractFnSource(csSrc, 'readFieldAll');
    assert.ok(/labelledby/i.test(libAll), 'lib readFieldAll handles labelledby');
    assert.ok(/labelledby/i.test(inlineAll), 'inline readFieldAll handles labelledby');
  });
});
