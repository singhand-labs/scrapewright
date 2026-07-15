const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { cleanPageHtml, extractAnnotationContext, compressStructure, cleanHtmlForLLM } = require('../lib/html-cleaner');

function setupJSDOM(html) {
  const dom = new JSDOM(html);
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.window = dom.window;
  global.DOMParser = dom.window.DOMParser;
  global.NodeFilter = dom.window.NodeFilter;
  return dom;
}

describe('cleanPageHtml', () => {
  it('removes script and style tags', () => {
    setupJSDOM(`
      <html><body>
        <div id="main">Hello</div>
        <script>alert('bad')</script>
        <style>.x{color:red}</style>
      </body></html>
    `);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(!cleaned.includes('alert'));
    assert.ok(!cleaned.includes('color:red'));
    assert.ok(cleaned.includes('id="main"'));
    assert.ok(cleaned.includes('Hello'));
  });

  it('removes on* event handler attributes', () => {
    setupJSDOM(`
      <html><body>
        <button onclick="evil()">Click</button>
      </body></html>
    `);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(!cleaned.includes('onclick'));
    assert.ok(cleaned.includes('Click'));
  });

  it('removes style attributes but keeps class', () => {
    setupJSDOM(`
      <html><body>
        <div class="keep" style="color:red">X</div>
      </body></html>
    `);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(!cleaned.includes('style='));
    assert.ok(cleaned.includes('class="keep"'));
  });

  it('trims attribute values longer than 200 chars', () => {
    const longVal = 'a'.repeat(250);
    setupJSDOM(`
      <html><body>
        <div data-x="${longVal}">X</div>
      </body></html>
    `);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(cleaned.includes('...'));
    assert.ok(!cleaned.includes('a'.repeat(250)));
  });

  it('removes noise containers (nav, footer, aside)', () => {
    setupJSDOM(`
      <html><body>
        <main><p>content</p></main>
        <nav><a>nav link</a></nav>
        <footer>(c) 2026</footer>
        <aside>sidebar</aside>
      </body></html>
    `);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(cleaned.includes('content'));
    assert.ok(!cleaned.includes('nav link'));
    assert.ok(!cleaned.includes('(c) 2026'));
    assert.ok(!cleaned.includes('sidebar'));
  });

  it('does NOT truncate long output', () => {
    const big = '<div>' + 'x'.repeat(100000) + '</div>';
    setupJSDOM(`<html><body>${big}</body></html>`);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(cleaned.length > 90000);
    assert.ok(!cleaned.includes('[truncated]'));
  });
});

describe('extractAnnotationContext', () => {
  it('returns null for missing selector', () => {
    setupJSDOM(`<html><body><div>X</div></body></html>`);
    const result = extractAnnotationContext(document, '.missing');
    assert.equal(result, null);
  });

  it('returns context including annotated element', () => {
    setupJSDOM(`
      <html><body>
        <table>
          <tbody>
            <tr><td class="label">公司名称</td></tr>
            <tr><td class="label">注册资本</td></tr>
            <tr><td class="label">成立日期</td></tr>
          </tbody>
        </table>
      </body></html>
    `);
    const result = extractAnnotationContext(document, 'td.label');
    assert.ok(result);
    assert.ok(result.includes('公司名称'));
  });

  it('folds distant siblings into a comment', () => {
    setupJSDOM(`
      <html><body>
        <ul>
          <li>item 1</li>
          <li>item 2</li>
          <li class="target">target</li>
          <li>item 4</li>
          <li>item 5</li>
          <li>item 6</li>
          <li>item 7</li>
        </ul>
      </body></html>
    `);
    const result = extractAnnotationContext(document, '.target', 1);
    assert.ok(result);
    assert.ok(result.includes('target'));
    assert.ok(result.includes('item 2'));
    assert.ok(result.includes('siblings'));
    assert.ok(!result.includes('item 7'));
  });

  it('limits depth below annotated element', () => {
    setupJSDOM(`
      <html><body>
        <div class="outer">
          <div class="target">
            <div><div><div><div>deep</div></div></div></div>
          </div>
        </div>
      </body></html>
    `);
    const result = extractAnnotationContext(document, '.target', 1);
    assert.ok(result);
    assert.ok(result.includes('target'));
    assert.ok(!result.includes('deep'));
  });
});

describe('compressStructure', () => {
  it('returns tag and class for top-level nodes', () => {
    setupJSDOM(`
      <html><body>
        <div class="app"><p>hi</p></div>
      </body></html>
    `);
    const result = compressStructure(document, []);
    assert.ok(result.includes('div'));
    assert.ok(result.includes('class="app"'));
  });

  it('marks annotated subtrees', () => {
    setupJSDOM(`
      <html><body>
        <main>
          <section class="info"><table><tbody><tr><td>cell</td></tr></tbody></table></section>
        </main>
      </body></html>
    `);
    const result = compressStructure(document, ['td']);
    assert.ok(result.includes('[ANNOTATED]'));
  });

  it('folds deep non-annotated subtrees', () => {
    setupJSDOM(`
      <html><body>
        <div class="root">
          <div><div><div><div><div>very deep</div></div></div></div></div>
        </div>
      </body></html>
    `);
    const result = compressStructure(document, []);
    assert.ok(result.includes('children'));
    assert.ok(!result.includes('very deep'));
  });

  it('includes child count for folded nodes', () => {
    setupJSDOM(`
      <html><body>
        <ul><li>1</li><li>2</li><li>3</li></ul>
      </body></html>
    `);
    const result = compressStructure(document, []);
    assert.ok(result.includes('3') || result.includes('children'));
  });
});

describe('cleanHtmlForLLM', () => {
  it('returns mode full for small pages', () => {
    setupJSDOM(`
      <html><body>
        <div class="content"><p>small page</p></div>
      </body></html>
    `);
    const result = cleanHtmlForLLM(document.documentElement.outerHTML, []);
    assert.equal(result.mode, 'full');
    assert.ok(result.html);
    assert.ok(result.html.includes('small page'));
  });

  it('returns mode compressed for large pages with annotations', () => {
    const big = '<div class="target">' + 'x'.repeat(100000) + '</div>';
    setupJSDOM(`<html><body>${big}</body></html>`);
    const result = cleanHtmlForLLM(document.documentElement.outerHTML, [{ selector: '.target' }]);
    assert.equal(result.mode, 'compressed');
    assert.ok(Array.isArray(result.contexts));
    assert.equal(result.contexts.length, 1);
    assert.ok(result.contexts[0].context);
    assert.ok(result.structure);
  });

  it('mode compressed preserves annotated element context', () => {
    const big = '<div>' + 'z'.repeat(100000) + '</div>';
    setupJSDOM(`<html><body>${big}<table><tr><td class="key">注册资本</td><td class="val">100万美元</td></tr></table></body></html>`);
    const result = cleanHtmlForLLM(document.documentElement.outerHTML, [
      { selector: '.key' },
      { selector: '.val' }
    ]);
    assert.equal(result.mode, 'compressed');
    const combined = result.contexts.map(c => c.context || '').join('');
    assert.ok(combined.includes('注册资本'));
    assert.ok(combined.includes('100万美元'));
  });
});
