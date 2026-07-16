const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  parseIframeSelector,
  formatIframeSelector,
  isIframePrefixed,
  buildIframeChain,
  querySelectorDeep,
  querySelectorAllDeep,
  resolveIframeChain,
  IFRAME_PREFIX,
  SEGMENT_SEPARATOR
} = require('../lib/iframe-selector');

function setupDomWithIframes(html, opts = {}) {
  const dom = new JSDOM(html, { url: opts.url || 'https://example.com/page', runScripts: 'outside-only' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.CSS = dom.window.CSS;
  return dom;
}

// Populate an iframe's contentDocument with the given HTML. JSDOM creates
// same-origin iframe documents by default but leaves them empty; we write
// directly so querySelector inside the iframe works in tests.
function fillIframe(iframe, innerHtml) {
  const doc = iframe.contentDocument;
  doc.open();
  doc.write('<!DOCTYPE html><html><body>' + innerHtml + '</body></html>');
  doc.close();
  return doc;
}

describe('parseIframeSelector', () => {
  it('parses a single-iframe selector', () => {
    const parsed = parseIframeSelector('iframe#zbggframe1::p.MsoNormal');
    assert.deepEqual(parsed.iframeChain, ['#zbggframe1']);
    assert.equal(parsed.innerSelector, 'p.MsoNormal');
  });

  it('parses a nested-iframe chain', () => {
    const parsed = parseIframeSelector('iframe#iframe1::iframe#iframe2::#deep');
    assert.deepEqual(parsed.iframeChain, ['#iframe1', '#iframe2']);
    assert.equal(parsed.innerSelector, '#deep');
  });

  it('preserves ::inside the inner selector (CSS pseudo-elements)', () => {
    const parsed = parseIframeSelector('iframe#iframe1::td::before');
    assert.deepEqual(parsed.iframeChain, ['#iframe1']);
    assert.equal(parsed.innerSelector, 'td::before');
  });

  it('returns empty chain for non-prefixed selectors', () => {
    const parsed = parseIframeSelector('#plain-id');
    assert.deepEqual(parsed.iframeChain, []);
    assert.equal(parsed.innerSelector, '#plain-id');
  });

  it('returns empty chain for selectors that just start with the substring "iframe"', () => {
    // `iframeSelector` is a class name, not an iframe-prefixed selector.
    const parsed = parseIframeSelector('.iframeSelector');
    assert.deepEqual(parsed.iframeChain, []);
    assert.equal(parsed.innerSelector, '.iframeSelector');
  });

  it('handles empty / invalid input', () => {
    assert.deepEqual(parseIframeSelector(''), { iframeChain: [], innerSelector: '' });
    assert.deepEqual(parseIframeSelector(null), { iframeChain: [], innerSelector: '' });
  });
});

describe('formatIframeSelector', () => {
  it('formats a single-iframe selector', () => {
    assert.equal(formatIframeSelector(['#zbggframe1'], 'p.MsoNormal'), 'iframe#zbggframe1::p.MsoNormal');
  });

  it('formats a nested chain', () => {
    assert.equal(formatIframeSelector(['#a', '#b'], '#deep'), 'iframe#a::iframe#b::#deep');
  });

  it('returns the inner selector alone when chain is empty', () => {
    assert.equal(formatIframeSelector([], '#plain'), '#plain');
    assert.equal(formatIframeSelector(null, '#plain'), '#plain');
  });

  it('round-trips through parseIframeSelector', () => {
    const cases = [
      'iframe#zbggframe1::p',
      'iframe#a::iframe#b::#deep',
      '#plain',
      'iframe[src="x.html"]::td::before'
    ];
    for (const sel of cases) {
      const parsed = parseIframeSelector(sel);
      const reformatted = formatIframeSelector(parsed.iframeChain, parsed.innerSelector);
      assert.equal(reformatted, sel, 'round-trip failed for: ' + sel);
    }
  });
});

describe('isIframePrefixed', () => {
  it('returns true for iframe-prefixed selectors', () => {
    assert.equal(isIframePrefixed('iframe#x::#y'), true);
    assert.equal(isIframePrefixed('iframe#iframe1::iframe#iframe2::#deep'), true);
  });

  it('returns false for plain selectors', () => {
    assert.equal(isIframePrefixed('#plain'), false);
    assert.equal(isIframePrefixed('.iframeSelector'), false);
    assert.equal(isIframePrefixed('div.iframe'), false);
  });
});

describe('buildIframeChain', () => {
  it('returns empty chain for element in top document', () => {
    setupDomWithIframes('<html><body><div id="top">x</div></body></html>');
    const el = document.getElementById('top');
    assert.deepEqual(buildIframeChain(el, document), []);
  });

  it('builds single-iframe chain from iframe element id', () => {
    setupDomWithIframes('<html><body><iframe id="zbggframe1"></iframe></body></html>');
    const iframe = document.getElementById('zbggframe1');
    fillIframe(iframe, '<div id="inside"></div>');
    const inner = iframe.contentDocument.getElementById('inside');
    const chain = buildIframeChain(inner, document);
    assert.deepEqual(chain, ['#zbggframe1']);
  });

  it('falls back to [name="..."] when iframe has no id', () => {
    setupDomWithIframes('<html><body><iframe name="content"></iframe></body></html>');
    const iframe = document.querySelector('iframe[name="content"]');
    fillIframe(iframe, '<div id="inside"></div>');
    const inner = iframe.contentDocument.getElementById('inside');
    const chain = buildIframeChain(inner, document);
    assert.equal(chain.length, 1);
    assert.match(chain[0], /^\[name="content"\]$/);
  });

  it('falls back to [src="..."] when iframe has neither id nor name', () => {
    setupDomWithIframes('<html><body><iframe src="content.html"></iframe></body></html>');
    const iframe = document.querySelector('iframe[src="content.html"]');
    fillIframe(iframe, '<div id="inside"></div>');
    const inner = iframe.contentDocument.getElementById('inside');
    const chain = buildIframeChain(inner, document);
    assert.equal(chain.length, 1);
    assert.match(chain[0], /^\[src="content\.html"\]$/);
  });

  it('builds nested chain for iframe-in-iframe', () => {
    setupDomWithIframes('<html><body><iframe id="outer"></iframe></body></html>');
    const outer = document.getElementById('outer');
    fillIframe(outer, '<iframe id="inner"></iframe>');
    const innerIframe = outer.contentDocument.getElementById('inner');
    fillIframe(innerIframe, '<div id="deep"></div>');
    const deepEl = innerIframe.contentDocument.getElementById('deep');
    // top document in our test is the global `document`
    const chain = buildIframeChain(deepEl, document);
    assert.deepEqual(chain, ['#outer', '#inner']);
  });
});

describe('querySelectorDeep', () => {
  it('finds element in top document via legacy selector', () => {
    setupDomWithIframes('<html><body><div id="top">x</div></body></html>');
    const found = querySelectorDeep(document, '#top');
    assert.ok(found);
    assert.equal(found.element.id, 'top');
    assert.equal(found.doc, document);
  });

  it('finds element inside an iframe via legacy selector (backward compat)', () => {
    setupDomWithIframes('<html><body><iframe id="fr"></iframe></body></html>');
    fillIframe(document.getElementById('fr'), '<div id="inside">x</div>');
    const found = querySelectorDeep(document, '#inside');
    assert.ok(found);
    assert.equal(found.element.id, 'inside');
    assert.notEqual(found.doc, document);
  });

  it('finds element inside a specific iframe via prefixed selector', () => {
    setupDomWithIframes(`
      <html><body>
        <iframe id="frameA"></iframe>
        <iframe id="frameB"></iframe>
      </body></html>
    `);
    fillIframe(document.getElementById('frameA'), '<div class="target">A</div>');
    fillIframe(document.getElementById('frameB'), '<div class="target">B</div>');
    const found = querySelectorDeep(document, 'iframe#frameB::div.target');
    assert.ok(found);
    assert.equal(found.element.textContent, 'B');
  });

  it('returns null when the named iframe does not exist', () => {
    setupDomWithIframes('<html><body></body></html>');
    const found = querySelectorDeep(document, 'iframe#missing::div');
    assert.equal(found, null);
  });

  it('returns null when the inner element is missing in the named iframe', () => {
    setupDomWithIframes('<html><body><iframe id="fr"></iframe></body></html>');
    fillIframe(document.getElementById('fr'), '<div id="present">x</div>');
    const found = querySelectorDeep(document, 'iframe#fr::div.missing');
    assert.equal(found, null);
  });

  it('walks nested iframes via chained prefixed selector', () => {
    setupDomWithIframes('<html><body><iframe id="outer"></iframe></body></html>');
    const outer = document.getElementById('outer');
    fillIframe(outer, '<iframe id="inner"></iframe>');
    fillIframe(outer.contentDocument.getElementById('inner'), '<div id="deep">x</div>');
    const found = querySelectorDeep(document, 'iframe#outer::iframe#inner::div#deep');
    assert.ok(found);
    assert.equal(found.element.id, 'deep');
  });

  it('does not match across iframes when prefixed — strict isolation', () => {
    // Same .target class in two iframes; prefix selects only frameA.
    setupDomWithIframes(`
      <html><body>
        <iframe id="frameA"></iframe>
        <iframe id="frameB"></iframe>
      </body></html>
    `);
    fillIframe(document.getElementById('frameA'), '<div class="target">A</div>');
    fillIframe(document.getElementById('frameB'), '<div class="target">B</div>');
    const a = querySelectorDeep(document, 'iframe#frameA::div.target');
    const b = querySelectorDeep(document, 'iframe#frameB::div.target');
    assert.equal(a.element.textContent, 'A');
    assert.equal(b.element.textContent, 'B');
  });

  it('throws on invalid CSS selector (matches standard DOM semantics)', () => {
    setupDomWithIframes('<html><body><div></div></body></html>');
    assert.throws(() => querySelectorDeep(document, '!!!invalid!!!'));
  });
});

describe('querySelectorAllDeep', () => {
  it('collects from top doc + all same-origin iframes for legacy selector', () => {
    setupDomWithIframes(`
      <html><body>
        <div class="row">top-1</div>
        <iframe id="frA"></iframe>
        <iframe id="frB"></iframe>
      </body></html>
    `);
    fillIframe(document.getElementById('frA'), '<div class="row">a-1</div>');
    fillIframe(document.getElementById('frB'), '<div class="row">b-1</div>');
    const all = querySelectorAllDeep(document, '.row');
    assert.equal(all.length, 3);
    const texts = all.map(el => el.textContent).sort();
    assert.deepEqual(texts, ['a-1', 'b-1', 'top-1']);
  });

  it('restricts to the named iframe when prefixed', () => {
    setupDomWithIframes(`
      <html><body>
        <iframe id="frA"></iframe>
        <iframe id="frB"></iframe>
      </body></html>
    `);
    fillIframe(document.getElementById('frA'), '<div class="row">a-1</div><div class="row">a-2</div>');
    fillIframe(document.getElementById('frB'), '<div class="row">b-1</div>');
    const aRows = querySelectorAllDeep(document, 'iframe#frA::.row');
    assert.equal(aRows.length, 2);
    assert.ok(aRows.every(el => el.textContent.startsWith('a-')));
  });
});

describe('resolveIframeChain', () => {
  it('returns the deepest document for a valid chain', () => {
    setupDomWithIframes('<html><body><iframe id="outer"></iframe></body></html>');
    const outer = document.getElementById('outer');
    fillIframe(outer, '<iframe id="inner"></iframe>');
    const innerDoc = outer.contentDocument.getElementById('inner').contentDocument;
    fillIframe(outer.contentDocument.getElementById('inner'), '<div id="deep">x</div>');
    const resolved = resolveIframeChain(document, ['#outer', '#inner']);
    assert.equal(resolved, innerDoc);
  });

  it('returns null for a broken chain', () => {
    setupDomWithIframes('<html><body></body></html>');
    assert.equal(resolveIframeChain(document, ['#missing']), null);
  });
});
