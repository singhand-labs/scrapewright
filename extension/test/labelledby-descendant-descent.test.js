// Forty-third log: every labelledby resolution path read the reference
// attribute ONLY on the matched/anchor element. The page under test hung
// its machine-readable timestamp on a DESCENDANT of the time anchor —
// <a href="?__cft__…"><span aria-labelledby="_r_58_">scrambled</span></a>
// with the hidden #_r_58_ span mounted lazily elsewhere — so $labelledby,
// fieldMap labelledby:true, probe.labelledby, AND the forty-second-log
// harvestAnchorLabel all returned the absent-attr note while the full time
// sat one querySelector away. The model's v6 "strip combining chars" fix
// fought the anti-scramble decoy in textContent — a dead end, because the
// clean value never was in the anchor's own subtree text.
//
// Fix under test: when the matched element carries NEITHER aria-labelledby
// NOR aria-describedby, resolve via its first descendant that carries either
// attribute (requested attr preferred on the carrier), with disclosure
// (viaDescendant tag + note) so the transformation is auditable. Element's
// own attributes always take precedence — descent is a fallback, never an
// override.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const LIB = require(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'));
const WU = require(path.join(__dirname, '..', 'lib', 'wizard-utils.js'));
const CS_PATH = path.join(__dirname, '..', 'content-script.js');

const FULL_TIME = 'June 21, 2026 at 6:04 PM';

// Exact production shape (console.log 2026-09-08, probe.sample card 0):
// time anchor with a bare query-string href (no permalink), anti-scramble
// decoy text, descendant span carrying the aria-labelledby reference, and
// the hidden-but-readable value mounted elsewhere in the document.
function descentDom() {
  return new JSDOM(`<!DOCTYPE html><html><body>
    <div class="card" id="card1">
      <a class="time" href="?__cft__[0]=abc123">
        <span aria-labelledby="_r_58_">e̶p̶o̶r̶n̶t̶o̶s̶d̶</span>
      </a>
    </div>
    <div class="card" id="card2">
      <a class="time" href="?__cft__[0]=def456">no carrier anywhere</a>
    </div>
    <div class="card" id="card3">
      <a class="time" aria-describedby="tip_9" href="?__cft__[0]=ghi789">
        <span aria-labelledby="_r_77_">wrong level?</span>
      </a>
    </div>
    <span id="_r_58_" hidden>${FULL_TIME}</span>
    <span id="_r_77_" hidden>wrong carrier value</span>
    <span id="tip_9" hidden>own-attr value</span>
  </body></html>`);
}

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, 'marker not found: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker not found after start: ' + endMarker);
  return source.slice(start, end);
}

// Runs resolveLabelledbyText in a vm context bound to the JSDOM document —
// the production topology (content-script inner functions close over the
// page document).
function loadResolver(dom) {
  const src = fs.readFileSync(CS_PATH, 'utf8');
  const resolve = sliceFn(src, 'function resolveLabelledbyText(', '\n  async function domLabelledby');
  const ctx = { document: dom.window.document };
  vm.createContext(ctx);
  vm.runInContext(resolve + '\nthis.__fn = resolveLabelledbyText;', ctx);
  return ctx.__fn;
}

function loadHarvestFn(dom) {
  const src = fs.readFileSync(CS_PATH, 'utf8');
  const resolve = sliceFn(src, 'function resolveLabelledbyText(', '\n  async function domLabelledby');
  const harvest = sliceFn(src, 'function harvestAnchorLabel(', '\n  async function domHover(');
  const ctx = { document: dom.window.document };
  vm.createContext(ctx);
  vm.runInContext(resolve + '\n' + harvest + '\nthis.__fn = harvestAnchorLabel;', ctx);
  return ctx.__fn;
}

// From labelledby-fieldmap.test.js: the inline fallback closes over a
// hoisted resolveLabelledbyText — declare it on the eval'd global scope.
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

function buildInlineOps(dom) {
  const csSrc = fs.readFileSync(CS_PATH, 'utf8');
  global.document = dom.window.document;
  const resolverSrc = extractFnSource(csSrc, 'resolveLabelledbyText');
  const factorySrc = extractFnSource(csSrc, 'createInlineListExtractOps');
  (0, eval)(resolverSrc);
  const factory = (0, eval)(factorySrc + '; createInlineListExtractOps');
  return factory();
}

describe('F1: resolveLabelledbyText descends to a descendant carrier (content-script)', () => {
  it('anchor without reference attrs resolves via its descendant span and discloses the descent', () => {
    const dom = descentDom();
    const r = loadResolver(dom)(dom.window.document.querySelector('#card1 a.time'), 'aria-labelledby');
    assert.equal(r.text, FULL_TIME, 'the hidden #_r_58_ value must resolve through the descendant carrier');
    assert.equal(r.attr, 'aria-labelledby');
    assert.equal(r.viaDescendant, 'span', 'the descent must be disclosed with the carrier tag');
    assert.ok(/descendant/i.test(r.note || ''), 'note must disclose the descent: ' + r.note);
  });

  it('element own attributes take precedence — no descent when the element itself carries a reference', () => {
    const dom = descentDom();
    // card3's anchor HAS aria-describedby; requesting labelledby must NOT
    // grab the descendant carrier (own attrs first, descent is a fallback).
    const r = loadResolver(dom)(dom.window.document.querySelector('#card3 a.time'), 'aria-labelledby');
    assert.notEqual(r.text, 'wrong carrier value');
    assert.notEqual(r.viaDescendant, 'span');
    assert.match(r.note, /absent/, 'absent-attr falsification stays for the requested attr: ' + r.note);
  });

  it('no carrier anywhere keeps the absent-attr falsification note (regression guard)', () => {
    const dom = descentDom();
    const r = loadResolver(dom)(dom.window.document.querySelector('#card2 a.time'), 'aria-labelledby');
    assert.equal(r.text, '');
    assert.ok(!r.viaDescendant);
    assert.match(r.note, /absent/, 'the 24th-log falsification contract is intact: ' + r.note);
  });
});

describe('F1: lib resolveAriaReference parity (fieldMap labelledby path)', () => {
  it('fieldMap { selector: anchor, labelledby: true } resolves the descendant reference', () => {
    const dom = descentDom();
    global.document = dom.window.document;
    const cards = ['card1', 'card2'].map((id) => dom.window.document.getElementById(id));
    const recs = LIB.extractListRecords(cards, { postTime: { selector: 'a.time', labelledby: true } }, { allowEmpty: true });
    assert.equal(recs[0].postTime, FULL_TIME, 'the 43rd-log page shape extracts the full time');
    assert.equal(recs[1].postTime, '', 'no carrier → empty string, not an exception');
  });

  it('multi mode resolves the same descent per match', () => {
    const dom = descentDom();
    global.document = dom.window.document;
    const cards = ['card1', 'card2'].map((id) => dom.window.document.getElementById(id));
    const recs = LIB.extractListMultiRecords(cards, { postTime: { selector: 'a.time', labelledby: true } }, { allowEmpty: true });
    assert.deepEqual(recs[0].postTime, [FULL_TIME]);
    assert.deepEqual(recs[1].postTime, ['']);
  });

  it('computeExtractListDiagnostics counts descent resolutions in refResolved', () => {
    const dom = descentDom();
    global.document = dom.window.document;
    const cards = ['card1', 'card2'].map((id) => dom.window.document.getElementById(id));
    const d = LIB.computeExtractListDiagnostics(cards, { postTime: { selector: 'a.time', labelledby: true } }, '.card');
    const pf = d.perField[0];
    assert.equal(pf.matchCount, 2);
    assert.equal(pf.refResolved, 1, 'card1 resolves through the descendant carrier');
    assert.deepEqual(pf.sampleValues, [FULL_TIME]);
  });

  it('inline fallback resolves identically (drift guard per RC35)', () => {
    const dom = descentDom();
    const inlineOps = buildInlineOps(dom);
    const cards = ['card1', 'card2'].map((id) => dom.window.document.getElementById(id));
    const recs = inlineOps.extractListRecords(cards, { postTime: { selector: 'a.time', labelledby: true } }, { allowEmpty: true });
    assert.equal(recs[0].postTime, FULL_TIME);
    assert.equal(recs[1].postTime, '');
  });
});

describe('F1: harvestAnchorLabel descends (forty-second-log harvest works on this page shape)', () => {
  it('anchor with no reference attrs harvests the descendant carrier text with disclosure', () => {
    const dom = descentDom();
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.querySelector('#card1 a.time'));
    assert.equal(out.text, FULL_TIME);
    assert.equal(out.attr, 'aria-labelledby');
    assert.ok(/descendant/i.test(String(out.note || '')), 'harvest note must disclose the descent: ' + out.note);
  });

  // Forty-fourth log: on a cold verify tab the whole reference chain can be
  // unmounted (no carrier at all) or mounted with stale ids (dead refs).
  // A silent {text:'', attr:null, note:null} indistinguishable from "the
  // anchor label simply doesn't exist" is what let postingTime ship "" 4/4
  // across four verifies with zero labelledbyNote receipts. The quiet path
  // now keeps the resolver's falsification note (and the probed attr) so
  // the harvest discloses WHY it is empty.
  it('anchor with nothing to find discloses the absent-attr probe instead of a bare empty', () => {
    const dom = descentDom();
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.querySelector('#card2 a.time'));
    assert.equal(out.text, '');
    assert.equal(out.attr, 'aria-labelledby', 'attr names the reference attribute the harvest probed');
    assert.match(out.note || '', /absent/);
  });

  it('dead-refs carrier on a cold tab: text stays empty but the falsification note + probed attr survive', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <a class="time" href="?__cft__[0]=jkl012">
        <span aria-labelledby="_r_91_">stale label chain</span>
      </a>
    </body></html>`);
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.querySelector('a.time'));
    assert.equal(out.text, '');
    assert.equal(out.attr, 'aria-labelledby');
    assert.match(out.note || '', /resolve to nothing/, 'stale/dynamic ids get the resolve-to-nothing note');
    assert.match(out.note || '', /descendant/, 'the descent disclosure survives too');
  });

  it('anchor own attrs still win inside the harvest', () => {
    const dom = descentDom();
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.querySelector('#card3 a.time'));
    assert.equal(out.text, 'own-attr value');
    assert.equal(out.attr, 'aria-describedby');
  });
});

describe('F1: domLabelledby diagnostics disclose the descent (source audit)', () => {
  it('the _diagnostics assembly forwards viaDescendant when the resolver descended', () => {
    const src = fs.readFileSync(CS_PATH, 'utf8');
    const start = src.indexOf('async function domLabelledby(');
    assert.ok(start > -1);
    const end = src.indexOf('\n  async function domExists(', start);
    const body = src.slice(start, end > start ? end : start + 3000);
    assert.ok(/viaDescendant/.test(body),
      'domLabelledby diagnostics must forward resolved.viaDescendant');
  });
});

describe('F2: emptyFieldDiagnostics lifts crumbs across an assembly rename', () => {
  // Forty-third log: every verify reported detectors.emptyFieldDiagnostics:
  // null although the extract step's LAST iteration carried perField crumbs
  // — the fieldMap key was `timeLbl` while the output field was `postTime`
  // (renamed in the step's assembly map), and both the association gate and
  // falsificationCrumb's perField lookup keyed on the OUTPUT name only.
  it('a field renamed at assembly lifts the failing fieldMap key crumb with asField disclosure', () => {
    const diags = [{
      api: 'extractList',
      containerMatches: 4,
      containerSelector: "div[role='feed'] div[aria-posinset]",
      perField: [{
        field: 'timeLbl',
        subSelector: "a[href^='?__cft__']",
        labelledby: 'aria-labelledby',
        matchCount: 4,
        refResolved: 0,
        missingIds: [],
        sampleValues: []
      }]
    }];
    const events = [{ type: 'STEP_ITERATION', stepId: 'extract', selectorDiagnostics: diags }];
    const steps = [{
      id: 'extract', name: 'extract',
      script: "const raw = await $extractList(...); return raw.map(r => ({ postTime: r.timeLbl }));"
    }];
    const out = WU.emptyFieldDiagnostics(
      [{ field: 'postTime', path: 'posts.postTime', emptyCount: 4, totalCount: 4 }],
      steps, events);
    assert.equal(out.length, 1, 'the renamed field must still get its crumb');
    const crumb = out[0].crumbs[0];
    assert.equal(crumb.asField, 'postTime');
    assert.ok(/timeLbl/.test(crumb.note), 'crumb names the fieldMap key it died under: ' + crumb.note);
    assert.ok(/resolution produced no text/.test(crumb.note), 'the underlying falsification survives: ' + crumb.note);
  });

  it('exact-name matches are unaffected (no rename → no asField key)', () => {
    const diags = [{
      api: 'extractList',
      containerMatches: 2,
      perField: [{ field: 'postTime', subSelector: 'span.ts', labelledby: 'aria-labelledby', matchCount: 2, refResolved: 0, missingIds: ['dyn1'], sampleValues: [] }]
    }];
    const events = [{ type: 'STEP_ITERATION', stepId: 'extract', selectorDiagnostics: diags }];
    const steps = [{ id: 'extract', name: 'extract', script: 'postTime' }];
    const out = WU.emptyFieldDiagnostics(
      [{ field: 'postTime', path: 'posts.postTime', emptyCount: 2, totalCount: 2 }],
      steps, events);
    assert.equal(out.length, 1);
    assert.equal(out[0].crumbs[0].asField, undefined, 'exact-name crumbs carry no rename marker');
  });

  it('healthy perField entries are never lifted by the rename pass', () => {
    const diags = [{
      api: 'extractList',
      containerMatches: 4,
      perField: [{ field: 'title', subSelector: 'h3', matchCount: 4, sampleValues: ['a', 'b'] }]
    }];
    const events = [{ type: 'STEP_ITERATION', stepId: 'extract', selectorDiagnostics: diags }];
    const steps = [{ id: 'extract', name: 'extract', script: 'return items.map(x => ({ postTitle: x.title }))' }];
    const out = WU.emptyFieldDiagnostics(
      [{ field: 'postTitle', path: 'posts.postTitle', emptyCount: 4, totalCount: 4 }],
      steps, events);
    assert.equal(out.length, 0, 'no failing crumb → no speculation');
  });
});
