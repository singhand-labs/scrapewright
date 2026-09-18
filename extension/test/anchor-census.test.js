// Eighty-fourth log (2026-09-18, facebook-search-posts-hovercards session):
// verify v1/v2 both failed HOVER_ANCHORS_BLIND — the artifact's timestamp
// anchorSel matched 0 elements inside every comet container ON THE VERIFY
// TAB. The error carried teaching text but NO inventory of what anchor
// forms do exist in those containers, so the model went back to the
// research tab to re-ground: it opened a FRESH, UNSCROLLED tab, censused
// its un-hydrated shell (posinset:2, comet:0, article:4 with empty bodies),
// misread that as a "population variant", blind-widened the anchor union,
// and burned the remaining budget — postTime/postId/location/mediaUrls
// shipped 5/5 empty with the widened artifact never verified.
//
// Fix: census the universal anchor families inside the BLIND containers at
// $extractWithHover time (content-script), carry `_diagnostics.anchorCensus`
// up the same diagnostics relay that already carries capturedPopovers, and
// embed it in the verify-side HOVER_ANCHORS_BLIND error — the next
// anchorSel is authored against the verify population's observed elements.
// Families are generic HTML/ARIA forms; samples are the page's own values.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const contentScriptSrc = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const { detectHoverAnchorsBlind } = require('../lib/wizard-utils');
const { createVerifyRunner } = require('../lib/verify-runner');

function sliceFn(name) {
  const start = contentScriptSrc.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists in content-script.js');
  let i = contentScriptSrc.indexOf('{', start);
  let depth = 0;
  for (; i < contentScriptSrc.length; i++) {
    if (contentScriptSrc[i] === '{') depth += 1;
    else if (contentScriptSrc[i] === '}') { depth -= 1; if (depth === 0) return contentScriptSrc.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function domWithContainers() {
  return new JSDOM(`<!DOCTYPE html><body>
    <div class="card" id="c1">
      <a href="/story/123">label</a>
      <a href="/photo/9">photo</a>
      <span aria-label="Like 37">like</span>
      <div role="button">more</div>
    </div>
    <div class="card" id="c2">
      <a>no href anchor</a>
      <time>2 days ago</time>
    </div>
  </body>`, { url: 'https://example.com/feed' });
}

describe('computeAnchorCensus — behavioral (JSDOM slice)', () => {
  const computeAnchorCensus = new Function('return (' + sliceFn('computeAnchorCensus') + ');')();

  it('counts the universal anchor families across blind containers and samples observed href/aria-label values', () => {
    const dom = domWithContainers();
    const cards = Array.from(dom.window.document.querySelectorAll('.card'));
    const c = computeAnchorCensus(cards, 'a:has(span[aria-labelledby])');
    assert.equal(c.anchorSel, 'a:has(span[aria-labelledby])');
    assert.equal(c.blindContainers, 2);
    assert.equal(c.families['a'], 3, '3 anchors total');
    assert.equal(c.families['a[href]'], 2);
    assert.equal(c.families['[aria-labelledby]'], 0, 'the family the anchorSel assumed is absent — this is the point');
    assert.equal(c.families['[aria-label]'], 1);
    assert.equal(c.families['abbr'], 0);
    assert.equal(c.families['time'], 1);
    assert.equal(c.families['[role=link]'], 0);
    assert.equal(c.families['[role=button]'], 1);
    assert.deepEqual(c.hrefSamples, ['/story/123', '/photo/9']);
    assert.deepEqual(c.ariaLabelSamples, ['Like 37']);
  });

  it('caps samples at 5 and truncates long values to 140 chars', () => {
    const html = ['<div class="card">'];
    for (let i = 0; i < 8; i++) html.push('<a href="/item/' + i + '/' + 'x'.repeat(200) + '">a' + i + '</a>');
    html.push('</div>');
    const dom = new JSDOM('<body>' + html.join('') + '</body>', { url: 'https://example.com/' });
    const cards = Array.from(dom.window.document.querySelectorAll('.card'));
    const c = computeAnchorCensus(cards, 'a:has(span[aria-labelledby])');
    assert.equal(c.hrefSamples.length, 5);
    assert.ok(c.hrefSamples.every((h) => h.length <= 140));
  });

  it('survives empty and malformed container lists (defensive at the DOM boundary)', () => {
    const c1 = computeAnchorCensus([], 'a');
    assert.equal(c1.blindContainers, 0);
    const c2 = computeAnchorCensus([null, undefined, {}], 'a');
    assert.equal(c2.blindContainers, 3);
    assert.equal(c2.families['a'], 0);
  });
});

describe('domExtractWithHover wiring (source-text audit)', () => {
  it('computes the census exactly when the call found 0 anchors, over the blind containers', () => {
    assert.ok(/if \(anchorsFound === 0\) \{[\s\S]{0,400}computeAnchorCensus\(/.test(contentScriptSrc),
      'census must be computed when anchorsFound === 0');
    assert.ok(contentScriptSrc.indexOf('_diagnostics.anchorCensus = computeAnchorCensus(') !== -1,
      'census lands on _diagnostics.anchorCensus');
  });
});

describe('detectHoverAnchorsBlind carries the census into the aggregate', () => {
  function itEvt(stepId, diags) {
    return { type: 'STEP_ITERATION', stepId, iteration: 1, selectorDiagnostics: diags };
  }
  function ehDiag(over) {
    return Object.assign({
      api: 'extractWithHover',
      containerSelector: 'div.card',
      containerMatches: 6,
      processedContainers: 6,
      anchorSel: 'a:has(span[aria-labelledby])',
      hoverSummary: { anchorsFound: 0, hovercardsCaptured: 0, hoverFailures: 0 },
      anchorCensus: { anchorSel: 'a:has(span[aria-labelledby])', blindContainers: 6, families: { a: 18, 'a[href]': 12, '[aria-labelledby]': 0 }, hrefSamples: ['/story/1'], ariaLabelSamples: [] },
      perField: []
    }, over || {});
  }

  it('the aggregate carries anchorCensus from the diagnostics', () => {
    const hit = detectHoverAnchorsBlind([itEvt('s3', [ehDiag()])]);
    assert.ok(hit, 'fires');
    assert.equal(hit.anchorCensus.blindContainers, 6);
    assert.equal(hit.anchorCensus.families['[aria-labelledby]'], 0);
    assert.deepEqual(hit.anchorCensus.hrefSamples, ['/story/1']);
  });

  it('fires unchanged when diagnostics carry no census (older relays / pre-fix captures)', () => {
    const hit = detectHoverAnchorsBlind([itEvt('s3', [ehDiag({ anchorCensus: undefined })])]);
    assert.ok(hit, 'still fires');
    assert.equal(hit.anchorCensus, null);
  });
});

describe('verify-runner embeds the census in the HOVER_ANCHORS_BLIND error', () => {
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
  const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's3', name: 'time hover', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };

  it('the error names the families present, flags the absent one, and shows observed samples', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 's3', iteration: 1,
        selectorDiagnostics: [{
          api: 'extractWithHover',
          containerSelector: 'div.card',
          containerMatches: 6,
          processedContainers: 6,
          anchorSel: 'a:has(span[aria-labelledby])',
          hoverSummary: { anchorsFound: 0, hovercardsCaptured: 0, hoverFailures: 0 },
          anchorCensus: {
            anchorSel: 'a:has(span[aria-labelledby])', blindContainers: 6,
            families: { 'a': 18, 'a[href]': 12, '[aria-labelledby]': 0, '[aria-label]': 7, 'abbr': 0, 'time': 0, '[role=link]': 0, '[role=button]': 9 },
            hrefSamples: ['/story/123', '/photo/9'],
            ariaLabelSamples: ['Like 37'],
            note: 'census'
          },
          perField: []
        }]
      });
      return {
        finalResult: { posts: [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }] },
        steps: [{ stepId: 's3', stepName: 'time hover', result: { done: true }, snapshot: { html: 'x' } }],
        pages: [], pagesTruncated: false
      };
    };
    const runner = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /HOVER_ANCHORS_BLIND/);
    assert.match(out.report.error.message, /ANCHOR CENSUS/);
    assert.match(out.report.error.message, /a\[href\]×12/);
    assert.match(out.report.error.message, /\[aria-labelledby\]×0/);
    assert.match(out.report.error.message, /\/story\/123/);
    assert.match(out.report.error.message, /Like 37/);
    assert.match(out.report.error.message, /×0 does not exist/);
  });
});
