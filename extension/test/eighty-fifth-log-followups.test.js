// Eighty-fifth/86th-round log (2026-09-18/19, facebook-search-posts-hovercards
// feedback session): the user's session feedback explicitly demanded full
// absolute dates via timestamp tooltip hover. The model ran probe.timestamp
// with an INVERTED anchorSel ("span[aria-labelledby] a" — an <a> INSIDE the
// labelledby span — instead of the working "a:has(span[aria-labelledby])"),
// which matched 0 elements inside the container. probe.timestamp keys ALL
// three of its layers (labelledby/aria/text field reads + the hover batch)
// on the SAME anchorSel, so every layer was vacuous — and the receipt's "no
// date-shaped value on the anchors THIS call hovered … these anchors expose
// no timestamp" read as a page fact. The model concluded "没有找到绝对日期"
// and shipped 4/5 partial absolutes + 1/5 relative as a disclosed green.
// The 84th-round anchor census WAS computed in the extractWithHover
// diagnostics all along — the probe receipt layer just never surfaced it.
//
// Same log: v13 shipped GREEN with records #2/#5 carrying the IDENTICAL
// required postId (an author-scoped story token, not the per-record id) —
// DUPLICATE_ID_VALUES has been report-only since its birth and let a broken
// required identity field ship.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const CS_SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const { createProbeTools } = require('../lib/probe-tools');
const { createVerifyRunner } = require('../lib/verify-runner');

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, 'start marker not found: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end !== -1, 'end marker not found: ' + endMarker);
  return source.slice(start, end);
}

const TS_SLICE = sliceFn(CS_SRC, 'var TS_MAX_HOVER_ANCHORS', '\n  async function domExists(');
const HARVEST_SLICE =
  sliceFn(CS_SRC, 'function resolveLabelledbyText(', '\n  async function domLabelledby') + '\n' +
  sliceFn(CS_SRC, 'function harvestAnchorLabel(', '\n  async function domHover(');
const CENSUS_SLICE = sliceFn(CS_SRC, 'function computeAnchorCensus(', '\n  function computeSelectorDifferential(');

// ---------------------------------------------------------------------------
// F1a — $timestamp (domTimestamp): zero-anchor enumeration self-discloses.
// ---------------------------------------------------------------------------

describe('85th log F1a: domTimestamp zero-anchor receipt', () => {
  function makeBlindDom() {
    // The 85th-round population: labelledby spans exist (they carry the
    // partial label), links are /stories/ permalinks — the model's inverted
    // anchorSel "span[aria-labelledby] a" matches NOTHING here.
    return new JSDOM(
      '<div id="card">' +
      '<a class="ts" href="/stories/122104237953417176/UzpfSVNDOjE0Mw==/" aria-labelledby="tl"><span id="tl" aria-labelledby="tl2">August 18</span></a>' +
      '<span id="tl2" hidden>August 18</span>' +
      '</div>',
      { url: 'https://example.com/page' }
    );
  }

  function tsContext(dom) {
    const card = dom.window.document.getElementById('card');
    const ctx = {
      document: dom.window.document,
      querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
      notifyBackgroundDiagnostic: () => {},
      domHover: async () => { throw new Error('must not hover when 0 anchors enumerated'); },
      sendDebugLog: () => {}
    };
    vm.createContext(ctx);
    vm.runInContext(HARVEST_SLICE + '\n' + CENSUS_SLICE + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
    return ctx;
  }

  it('99th-round: a span-only custom anchorSel is RESCUED by the default union (the timestamp <a> gets hovered); a truly-empty union still self-discloses as vacuous', async () => {
    const ctx = tsContext(makeBlindDom());
    const r = await ctx.__ts('#card', { anchorSel: 'span[aria-labelledby] a' });
    // the custom sel alone matched 0 (85th-log case); the UNIONED defaults
    // now match the card's aria-labelledby carriers → no longer vacuous, and
    // the rescue means the ordinary harvest path runs (census not needed).
    assert.ok(r.result.anchorsProbed > 0, 'default union rescues the blind custom sel: ' + r.result.anchorsProbed);
    assert.doesNotMatch(r.result.note, /matched 0 anchors/i, 'no vacuous-negative when the union found anchors');
  });

  it('anchors that exist but expose no dates keep the ordinary negative (no census noise)', async () => {
    const dom = new JSDOM('<div id="card"><a class="ts" href="/x">not a date at all</a></div>', { url: 'https://example.com/' });
    const ctx = tsContext(dom);
    const r = await ctx.__ts('#card', { anchorSel: '.ts' });
    assert.equal(r.result.anchorsProbed, 1);
    assert.equal(r.result.anchorCensus, undefined);
    assert.match(r.result.note, /no date-shaped value/i);
  });
});

// ---------------------------------------------------------------------------
// F1b — probe.timestamp: surfaces the relayed anchor census when the anchor
// selector matched nothing (the receipt layer, not the diagnostics channel).
// ---------------------------------------------------------------------------

describe('85th log F1b: probe.timestamp zero-anchor receipt', () => {
  const CENSUS = {
    anchorSel: 'span[aria-labelledby] a',
    blindContainers: 1,
    families: { 'a': 2, 'a[href]': 2, '[aria-labelledby]': 1, '[aria-label]': 0, 'abbr': 0, 'time': 0, '[role=link]': 0, '[role=button]': 3 },
    hrefSamples: ['/stories/122104237953417176/UzpfSVNDOjE0Mw==/'],
    ariaLabelSamples: [],
    note: 'census of universal anchor forms inside the containers where anchorSel matched 0'
  };

  function blindExtractWithHoverEnv() {
    return {
      result: [{ __t_label: '', __t_aria: '', __t_text: '', hovercards: [] }],
      selectorDiagnostics: [{
        api: 'extractWithHover',
        containerSelector: 'div.card',
        containerMatches: 1,
        processedContainers: 1,
        anchorSel: 'span[aria-labelledby] a',
        hoverSummary: { anchorsFound: 0, hovercardsCaptured: 0, hoverFailures: 0 },
        anchorCensus: CENSUS,
        perField: []
      }]
    };
  }

  it('zero hovercards + empty candidates → VACUOUS note leads, census embedded, old note gone', async () => {
    const probes = createProbeTools({ executeDsl: async () => blindExtractWithHoverEnv() });
    const out = await probes.timestamp({ containerSel: 'div.card', anchorSel: 'span[aria-labelledby] a', index: 0 });
    assert.equal(out.candidates.length, 0);
    assert.match(out.note, /matched 0 anchors/i);
    assert.match(out.note, /selector miss, not a page fact/i);
    assert.match(out.note, /a:has\(span\[aria-labelledby\]\)/, 'teaches the descendant-direction fix');
    assert.ok(out.anchorCensus && out.anchorCensus.families['[aria-labelledby]'] === 1);
    assert.doesNotMatch(out.note, /these anchors expose no timestamp/);
  });

  it('anchors existed but no date shapes → ordinary negative (census absent)', async () => {
    const probes = createProbeTools({
      executeDsl: async () => ({
        result: [{ __t_label: 'not a date', __t_aria: '', __t_text: 'plain prose', hovercards: [{ hovered: true, htmlSnippet: null, labelledbyText: 'x' }] }],
        selectorDiagnostics: [{ api: 'extractWithHover', hoverSummary: { anchorsFound: 1, hovercardsCaptured: 0, hoverFailures: 1 } }]
      })
    });
    const out = await probes.timestamp({ containerSel: 'div.card', index: 0 });
    assert.equal(out.anchorCensus, undefined);
    assert.match(out.note, /no date-shaped value on the anchors THIS call hovered/);
  });
});

// ---------------------------------------------------------------------------
// F2 — DUPLICATE_ID_VALUES promotion: required identity fields veto.
// ---------------------------------------------------------------------------

describe('85th log F2: required duplicated id vetoes the run', () => {
  function makeRunner(finalResult, outputSchema) {
    const deps = {
      orchestrate: async (svc, input, d, opts) => {
        await d.createTab(svc.targetUrl);
        opts.onEvent({ type: 'EXECUTION_START' });
        return { finalResult, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: { html: 'x' } }], pages: [], pagesTruncated: false };
      },
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
  const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
  const REQ_SCHEMA = {
    type: 'object', required: ['posts'],
    properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
      postId: { type: 'string' }, content: { type: 'string' }
    } } } }
  };
  const OPT_SCHEMA = {
    type: 'object', required: ['posts'],
    properties: { posts: { type: 'array', items: { type: 'object', properties: {
      postId: { type: 'string' }, content: { type: 'string' }
    } } } }
  };
  const DUP = { posts: [
    { postId: 'UzpfSVNDOjI1NTM1NjM1MTg0NzkyMjM=', content: 'ML Explained' },
    { postId: 'UzpfSVNDOjE0MzA3MTMyOTU3OTEzNDA=', content: 'AI notes' },
    { postId: 'UzpfSVNDOjI1NTM1NjM1MTg0NzkyMjM=', content: 'Scikit-Learn notes' }
  ] };

  it('a REQUIRED id shared by 2/3 records turns the run red with per-record-identity teaching', async () => {
    const runner = makeRunner(DUP, REQ_SCHEMA);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /DUPLICATE_ID_REQUIRED/);
    assert.match(out.report.error.message, /2\/3/);
    assert.match(out.report.error.message, /records 1, 3/);
    assert.match(out.report.error.message, /per-record/);
    assert.ok(Array.isArray(out.report.detectors.duplicateIdValues) && out.report.detectors.duplicateIdValues.length === 1,
      'the census still rides the report');
  });

  it('a NON-required id sharing the same value stays advisory-green (the 50th-log contract)', async () => {
    const runner = makeRunner(DUP, OPT_SCHEMA);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: OPT_SCHEMA });
    assert.equal(out.report.ok, true, 'optional identity fields keep the report-only lane');
    assert.ok(Array.isArray(out.report.detectors.duplicateIdValues));
  });

  it('unique required ids stay green with no census', async () => {
    const uniq = { posts: [{ postId: 'a1', content: 'x' }, { postId: 'a2', content: 'y' }] };
    const runner = makeRunner(uniq, REQ_SCHEMA);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.duplicateIdValues, null);
  });
});
