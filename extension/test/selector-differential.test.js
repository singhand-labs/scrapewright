// Twenty-fifth log: the session shipped a container selector
// div[role='feed'] div[role='article']:not(:has([data-ad-rendering-role]))
// whose own probes counted 0 while the base form counted 3-7 — the trailing
// :not() clause (built on an attr-NAME guess) removed the whole population.
// The bare "no containers matched" error carried no evidence, so the model
// iterated fieldMaps, scroll budgets and input values for 60 turns and the
// fatal clause never changed. Fix: a live SELECTOR DIFFERENTIAL — counts of
// the selector with trailing :not()/:has() clauses progressively stripped —
// attached to the zero-container error/diagnostics, carried through the
// container census, and surfaced in the verify message as
// SELECTOR_OVERFILTERED (which supersedes the INPUT_VALUE_SUSPECT advice).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createVerifyRunner } = require('../lib/verify-runner');
const WU = require('../lib/wizard-utils');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

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

function domWithCards() {
  return new JSDOM(
    '<div class="card"><a href="#1"></a><div data-x="m">a</div></div>' +
    '<div class="card"><a href="#2"></a><div data-x="m">b</div></div>' +
    '<div class="card"><a href="#3"></a><div data-x="m">c</div></div>'
  ).window.document;
}

function makeDifferential(document) {
  const deep = (sel) => Array.from(document.querySelectorAll(sel));
  const strip = new Function('return (' + sliceFn('stripTrailingFilterClause') + ')')();
  const factory = new Function('querySelectorAllDeep', 'stripTrailingFilterClause', 'return (' + sliceFn('computeSelectorDifferential') + ')');
  return factory(deep, strip);
}

describe('selector differential helpers (twenty-fifth log)', () => {
  it('counts the full selector and each stripped stage — the collapse point is visible', () => {
    const doc = domWithCards();
    const diff = makeDifferential(doc)("div.card:not(:has([data-x]))");
    assert.ok(Array.isArray(diff) && diff.length === 2, 'full + one stripped stage');
    assert.equal(diff[0].count, 0, 'full selector matches 0');
    assert.equal(diff[1].sel, 'div.card');
    assert.equal(diff[1].count, 3, 'stripped base matches all 3');
  });

  it('strips one clause per stage for compound suffixes', () => {
    const doc = domWithCards();
    const diff = makeDifferential(doc)("div.card:has(a):not(:has([data-x]))");
    assert.deepEqual(diff.map(s => s.count), [0, 3, 3], ':not(:has([data-x])) is the killer clause');
    assert.equal(diff[1].sel, 'div.card:has(a)');
  });

  it('returns null for comma lists and clause-free selectors', () => {
    const doc = domWithCards();
    const d = makeDifferential(doc);
    assert.equal(d('div.card, div.other'), null, 'comma lists are skipped (best-effort scope)');
    assert.equal(d('div.card'), null, 'nothing to strip → no differential');
  });

  it('formatter names the culprit when a stage survives, and the population reading when none do', () => {
    const fmt = new Function('return (' + sliceFn('formatSelectorDifferentialNote') + ')')();
    const culprit = fmt([
      { sel: "div.card:has(a):not(:has([data-x]))", count: 0 },
      { sel: 'div.card:has(a)', count: 3 },
      { sel: 'div.card', count: 3 }
    ]);
    assert.ok(/removed EVERY item/.test(culprit), 'says the clauses removed everything');
    assert.ok(/div\.card.*matched 3/.test(culprit), 'names the surviving base and its count');
    assert.ok(/data-ad-\*/.test(culprit), 'teaches the attr-name-guess polarity hazard');

    const thin = fmt([
      { sel: 'div.card:not(:has([data-x]))', count: 0 },
      { sel: 'div.card', count: 0 }
    ]);
    assert.ok(/population\/input question/.test(thin), 'base 0 → population, not clauses');
  });

  it('stripTrailingFilterClause handles balanced parens and non-clause tails', () => {
    const strip = new Function('return (' + sliceFn('stripTrailingFilterClause') + ')')();
    assert.equal(strip('div.card:not(:has([data-x]))'), 'div.card');
    assert.equal(strip('div.card:has(a)'), 'div.card');
    assert.equal(strip("a[href*='/posts/']"), null, 'attr tail with no trailing clause');
    assert.equal(strip('div.card'), null);
  });
});

describe('zero-container wiring (source audit)', () => {
  it('domExtractList / domExtractListMulti / domExtractWithHover attach the differential on zero containers', () => {
    assert.ok(/selectorDifferential: diff,/.test(SRC), 'diagnostic entries carry selectorDifferential');
    assert.ok(SRC.indexOf("computeSelectorDifferential(containerSel)") !== -1, 'differential computed from the container selector');
    assert.match(SRC, /\$extractList: no containers matched' \+ \(diffNote/, 'the throw embeds the differential note');
    assert.match(SRC, /\$extractListMulti: no containers matched' \+ \(diffNote/, 'multi variant too');
    assert.match(SRC, /\$extractWithHover: no containers matched' \+[\s\S]{0,120}_contDiffNote/, 'hover variant too');
  });
});

describe('detectContainerMatchZero census (twenty-fifth log)', () => {
  it('skips non-list diagnostics — count/wait entries no longer read as `container "" matched 0`', () => {
    const events = [
      { type: 'STEP_ITERATION', stepId: 's1', selectorDiagnostics: [
        { api: 'count', selector: 'div.card', matchCount: 3, sampleTexts: [] }
      ] },
      { type: 'STEP_ITERATION', stepId: 's2', selectorDiagnostics: [
        { api: 'extractList', containerSelector: 'div.card:not(:has([data-x]))', containerMatches: 0, perField: [] }
      ] }
    ];
    const hits = WU.detectContainerMatchZero(events);
    assert.ok(hits && hits.length === 1, 'only the list diagnostic participates');
    assert.equal(hits[0].stepId, 's2');
    assert.notEqual(hits[0].stepId, 's1', 'the count step (matchCount, no containerMatches) is excluded');
  });

  it('carries the live differential on the census hit', () => {
    const diff = [{ sel: 'div.card:not(:has([data-x]))', count: 0 }, { sel: 'div.card', count: 3 }];
    const events = [
      { type: 'STEP_ITERATION', stepId: 's2', selectorDiagnostics: [
        { api: 'extractList', containerSelector: 'div.card:not(:has([data-x]))', containerMatches: 0, selectorDifferential: diff, perField: [] }
      ] }
    ];
    const hits = WU.detectContainerMatchZero(events);
    assert.deepEqual(hits[0].selectorDifferential, diff);
  });
});

function makeRunner(orchestrate) {
  const deps = {
    orchestrate,
    ensureLock: async () => {},
    getSignal: () => null,
    log: () => {},
    onEvent: () => {},
    createTab: async (url) => ({ id: 11, url }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true
  };
  return createVerifyRunner(deps);
}

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { author: { type: 'string' } }, required: ['author'] } } } };
const SEL = "div[role='feed'] div[role='article']:not(:has([data-ad-rendering-role]))";
const DIFF = [{ sel: SEL, count: 0 }, { sel: "div[role='feed'] div[role='article']", count: 3 }];

function zeroContainerOrch(differential) {
  return async (svc, input, d, opts) => {
    const diag = { api: 'extractList', containerSelector: SEL, containerMatches: 0, perField: [] };
    if (differential) diag.selectorDifferential = differential;
    opts.onEvent({ type: 'STEP_ITERATION', stepId: 'collect', iteration: 1, selectorDiagnostics: [diag] });
    return { finalResult: { posts: [] }, steps: [{ stepId: 'collect', stepName: 'collect posts', result: { done: true, posts: [] }, snapshot: null }], pages: [] };
  };
}

describe('verify report SELECTOR_OVERFILTERED (twenty-fifth log)', () => {
  it('differential with surviving base leads the message and suppresses the input-value advice', async () => {
    const out = await makeRunner(zeroContainerOrch(DIFF))({ service: { targetUrl: 'https://example.com', steps: [{ id: 'collect', name: 'collect posts', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /SELECTOR_OVERFILTERED/);
    assert.match(out.report.error.message, /differential: .*→ 0, .*→ 3/, 'census line embeds the stage counts');
    assert.match(out.report.error.message, /YOUR OWN trailing/, 'names the caller\'s clauses as the remover');
    assert.doesNotMatch(out.report.error.message, /INPUT_VALUE_SUSPECT/, 'no input-value steering when the page HAS items');
    assert.ok(out.report.events.indexOf('SELECTOR_OVERFILTERED') !== -1, 'tag rides events for knowledge attach');
    assert.ok(out.report.events.indexOf('INPUT_VALUE_SUSPECT') === -1, 'input-value tag suppressed');
    assert.ok(out.report.events.indexOf('EMPTY_EXTRACTION') !== -1);
  });

  it('without a surviving base the INPUT_VALUE_SUSPECT branch is unchanged', async () => {
    const out = await makeRunner(zeroContainerOrch([{ sel: SEL, count: 0 }, { sel: "div[role='feed'] div[role='article']", count: 0 }]))({ service: { targetUrl: 'https://example.com', steps: [{ id: 'collect', name: 'collect posts', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: {}, outputSchema: SCHEMA });
    assert.match(out.report.error.message, /INPUT_VALUE_SUSPECT/);
    assert.ok(out.report.events.indexOf('SELECTOR_OVERFILTERED') === -1);
  });

  it('AD_MARKER_SELECTOR fires on the ERROR path — the detector is no longer gated behind !error', async () => {
    const svc = { targetUrl: 'https://example.com', steps: [{ id: 'collect', name: 'collect posts', script: "const SEL = \"div[role='article']:not(:has([data-ad-rendering-role]))\"; return $extractList(SEL, {author:{selector:'h2 a'}});", onSuccess: 'TERMINATE' }], config: {} };
    const out = await makeRunner(zeroContainerOrch(DIFF))({ service: svc, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false, 'error path');
    assert.ok(out.report.events.indexOf('AD_MARKER_SELECTOR') !== -1, 'polarity detector ran despite the error');
    assert.ok(Array.isArray(out.report.detectors.adMarkerSelectors) && out.report.detectors.adMarkerSelectors.length === 1);
  });
});
