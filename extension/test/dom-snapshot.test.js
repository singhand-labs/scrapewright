const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { getCompressedSnapshot, getElementFullHtml, getElementsFullHtml } = require('../lib/dom-snapshot');

function setupJSDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page', runScripts: 'outside-only' });
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.window = dom.window;
  global.CSS = dom.window.CSS;
  return dom;
}

function fillIframe(iframe, innerHtml) {
  const doc = iframe.contentDocument;
  doc.open();
  doc.write('<!DOCTYPE html><html><body>' + innerHtml + '</body></html>');
  doc.close();
  return doc;
}

describe('getCompressedSnapshot', () => {
  it('removes script/style tags', () => {
    setupJSDOM(`
      <html><body>
        <div id="main">Hello</div>
        <script>alert('bad')</script>
        <style>.x{color:red}</style>
      </body></html>
    `);

    const result = getCompressedSnapshot();
    assert.ok(!result.structure.includes('alert'));
    assert.ok(!result.structure.includes('color:red'));
    assert.ok(result.structure.includes('id="main"'));
    assert.ok(result.structure.includes('Hello'));
  });

  it('truncates long text but preserves numbers', () => {
    setupJSDOM(`
      <html><body>
        <p>This is a very long decorative text that should be truncated</p>
        <span>$1,299.00</span>
      </body></html>
    `);

    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('This is a very long ...'));
    assert.ok(result.structure.includes('$1,299.00'));
  });

  it('limits class names to first 2', () => {
    setupJSDOM(`
      <html><body>
        <div class="a b c d" id="box">Content</div>
      </body></html>
    `);

    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('class="a b"'));
    assert.ok(!result.structure.includes('class="a b c d"'));
  });

  it('handles missing body gracefully', () => {
    global.document = { documentElement: true, title: '' };
    global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    global.location = { href: 'about:blank' };
    const result = getCompressedSnapshot();
    assert.strictEqual(result.structure, '');
    assert.strictEqual(result.textSummary, '');
    delete global.location;
  });
});

describe('getElementFullHtml', () => {
  it('returns full outerHTML for matched element', () => {
    setupJSDOM(`
      <html><body>
        <div id="target" data-foo="bar"><span>Inner</span></div>
      </body></html>
    `);

    const result = getElementFullHtml('#target');
    assert.equal(result.found, true);
    assert.equal(result.selector, '#target');
    assert.ok(result.outerHTML.includes('id="target"'));
    assert.ok(result.outerHTML.includes('data-foo="bar"'));
    assert.ok(result.outerHTML.includes('<span>Inner</span>'));
    assert.equal(result.innerText, 'Inner');
    assert.ok(result.attributes.some(a => a.name === 'id' && a.value === 'target'));
    assert.ok(result.attributes.some(a => a.name === 'data-foo' && a.value === 'bar'));
  });

  it('returns found:false for missing element', () => {
    setupJSDOM(`<html><body></body></html>`);

    const result = getElementFullHtml('#nonexistent');
    assert.equal(result.found, false);
    assert.equal(result.selector, '#nonexistent');
    assert.equal(result.outerHTML, undefined);
    assert.equal(result.innerText, undefined);
    assert.equal(result.attributes, undefined);
  });

  it('returns found:false with error for invalid CSS selector (does not throw)', () => {
    setupJSDOM(`<html><body><div id="radix-:rfm:">x</div></body></html>`);

    // `#radix-:rfm:` is invalid CSS — colon is parsed as pseudo-class start.
    // document.querySelector throws DOMException synchronously. This must not
    // escape the function (it crashed the GET_ELEMENTS_HTML listener and
    // broke Round 2 of the research flow with a generic Chrome runtime error).
    const result = getElementFullHtml('#radix-:rfm:');
    assert.equal(result.found, false);
    assert.equal(result.selector, '#radix-:rfm:');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  });
});

describe('iframe handling (getCompressedSnapshot)', () => {
  it('inlines same-origin iframe content wrapped in <div data-iframe>', () => {
    setupJSDOM(`<html><body>
      <iframe id="zbggframe1"></iframe>
    </body></html>`);
    fillIframe(document.getElementById('zbggframe1'),
      '<div class="ewb-info-main"><u><font face="宋体">项目名称</font></u></div>');

    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('data-iframe'), 'expected data-iframe wrapper missing');
    assert.ok(result.structure.includes('项目名称'), 'iframe text content not inlined');
    assert.ok(!result.structure.includes('<iframe'), 'raw iframe tag should be replaced');
  });

  it('does not crash on cross-origin iframes (contentDocument throws)', () => {
    setupJSDOM(`<html><body><iframe id="cross"></iframe></body></html>`);
    // Simulate a cross-origin iframe: make contentDocument access throw.
    const iframe = document.getElementById('cross');
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new Error('cross-origin'); }
    });
    const result = getCompressedSnapshot();
    // Should produce some structure without throwing, omitting the iframe.
    assert.doesNotThrow(() => result.structure.length);
  });
});

describe('iframe handling (getElementFullHtml)', () => {
  it('finds element inside a specific iframe via prefixed selector', () => {
    setupJSDOM(`<html><body>
      <iframe id="frameA"></iframe>
      <iframe id="frameB"></iframe>
    </body></html>`);
    fillIframe(document.getElementById('frameA'), '<u><font>frame-a-value</font></u>');
    fillIframe(document.getElementById('frameB'), '<u><font>frame-b-value</font></u>');

    const result = getElementFullHtml('iframe#frameB::u > font');
    assert.equal(result.found, true);
    assert.ok(result.outerHTML.includes('frame-b-value'));
    assert.ok(!result.outerHTML.includes('frame-a-value'));
  });

  it('returns found:false when the named iframe does not exist', () => {
    setupJSDOM(`<html><body><iframe id="real"></iframe></body></html>`);
    fillIframe(document.getElementById('real'), '<div id="x">y</div>');
    const result = getElementFullHtml('iframe#missing::div');
    assert.equal(result.found, false);
  });

  it('preserves backward compat for legacy selectors that resolve in iframes', () => {
    setupJSDOM(`<html><body><iframe id="fr"></iframe></body></html>`);
    fillIframe(document.getElementById('fr'), '<div id="only-here">x</div>');
    const result = getElementFullHtml('#only-here');
    assert.equal(result.found, true);
    assert.ok(result.outerHTML.includes('only-here'));
  });
});
