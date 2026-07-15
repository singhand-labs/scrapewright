const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { getCompressedSnapshot, getElementFullHtml, getElementsFullHtml } = require('../lib/dom-snapshot');

function setupJSDOM(html) {
  const dom = new JSDOM(html);
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.window = dom.window;
  return dom;
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
