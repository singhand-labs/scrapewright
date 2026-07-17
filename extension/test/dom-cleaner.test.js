const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  filterClasses,
  truncateText,
  shouldRemoveTag,
  buildIframePrefix,
} = require('../lib/dom-cleaner');

function setupJSDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.window = dom.window;
  global.DOMParser = dom.window.DOMParser;
  global.NodeFilter = dom.window.NodeFilter;
  global.CSS = dom.window.CSS;
  return dom;
}

describe('filterClasses', () => {
  it('drops Angular and Vue scoped markers', () => {
    assert.equal(filterClasses('_ngcontent-abc foo bar'), 'foo bar');
    assert.equal(filterClasses('_nghost-xyz main-content'), 'main-content');
    assert.equal(filterClasses('data-v-abc123 btn'), 'btn');
  });

  it('drops emotion and styled-components hashes', () => {
    assert.equal(filterClasses('css-1abc23 ant-btn'), 'ant-btn');
    assert.equal(filterClasses('sc-abc123 primary'), 'primary');
    assert.equal(filterClasses('styled-xyz hover-state'), 'hover-state');
  });

  it('drops pure hash tokens', () => {
    assert.equal(filterClasses('abc123 def455 button'), 'button');
    assert.equal(filterClasses('_9a3b2c'), '');
  });

  it('preserves semantic classes including Tailwind utilities', () => {
    assert.equal(filterClasses('btn btn-primary'), 'btn btn-primary');
    assert.equal(filterClasses('flex p-4 text-sm'), 'flex p-4 text-sm');
    assert.equal(filterClasses('ant-btn ant-input'), 'ant-btn ant-input');
    assert.equal(filterClasses('chakra-stack product-card'), 'chakra-stack product-card');
  });

  it('returns empty string for empty input', () => {
    assert.equal(filterClasses(''), '');
    assert.equal(filterClasses(null), '');
    assert.equal(filterClasses(undefined), '');
  });
});

describe('truncateText', () => {
  const { truncateText } = require('../lib/dom-cleaner');

  it('preserves text under 60 chars unchanged', () => {
    assert.equal(truncateText('short text'), 'short text');
    assert.equal(truncateText('a'.repeat(60)), 'a'.repeat(60));
  });

  it('preserves prices and numbers regardless of length', () => {
    assert.equal(truncateText('¥1,234.56'), '¥1,234.56');
    assert.equal(truncateText('$9,999,999.99'), '$9,999,999.99');
  });

  it('preserves ISO and slash dates', () => {
    assert.equal(truncateText('2026-07-17'), '2026-07-17');
    assert.equal(truncateText('07/17/2026'), '07/17/2026');
  });

  it('preserves ALL-CAPS codes and identifier-like tokens', () => {
    assert.equal(truncateText('INV-2024-001'), 'INV-2024-001');
    assert.equal(truncateText('ORDER_12345'), 'ORDER_12345');
  });

  it('truncates long prose to 60 chars with ellipsis', () => {
    const prose = 'This is a paragraph of marketing copy that goes on for many words and exceeds the threshold';
    const out = truncateText(prose);
    assert.equal(out.length, 63); // 60 + '...'
    assert.ok(out.endsWith('...'));
    assert.equal(out.startsWith(prose.slice(0, 60)), true);
  });
});

describe('shouldRemoveTag', () => {
  const { shouldRemoveTag } = require('../lib/dom-cleaner');

  it('returns true for script/style/media tags', () => {
    ['script', 'style', 'link', 'img', 'video', 'audio', 'canvas', 'svg',
     'noscript', 'template', 'meta', 'path', 'g', 'defs', 'use'
    ].forEach(tag => assert.equal(shouldRemoveTag(tag), true, tag));
  });

  it('returns false for content tags', () => {
    ['div', 'span', 'p', 'a', 'button', 'input', 'table', 'ul', 'iframe']
      .forEach(tag => assert.equal(shouldRemoveTag(tag), false, tag));
  });
});

describe('buildIframePrefix', () => {
  const { buildIframePrefix } = require('../lib/dom-cleaner');

  it('prefers id selector', () => {
    setupJSDOM(`<html><body><iframe id="zbggframe1"></iframe></body></html>`);
    const iframe = document.getElementById('zbggframe1');
    assert.equal(buildIframePrefix(iframe), 'iframe#zbggframe1::');
  });

  it('falls back to name when id is absent', () => {
    setupJSDOM(`<html><body><iframe name="content"></iframe></body></html>`);
    const iframe = document.querySelector('iframe[name="content"]');
    assert.equal(buildIframePrefix(iframe), 'iframe[name="content"]::');
  });

  it('falls back to nth-of-type when neither id nor name', () => {
    setupJSDOM(`<html><body><iframe></iframe><iframe></iframe></body></html>`);
    const iframes = document.querySelectorAll('iframe');
    assert.equal(buildIframePrefix(iframes[0]), 'iframe:nth-of-type(1)::');
    assert.equal(buildIframePrefix(iframes[1]), 'iframe:nth-of-type(2)::');
  });

  it('returns empty string for null input', () => {
    assert.equal(buildIframePrefix(null), '');
  });

  it('escapes double-quote in name attribute', () => {
    setupJSDOM(`<html><body><iframe name='bad"name'></iframe></body></html>`);
    const iframe = document.querySelector('iframe[name]');
    // Whatever escaping is used, the output must be parseable by document.querySelector.
    const prefix = buildIframePrefix(iframe);
    const selector = prefix.replace(/::$/, '');  // strip trailing ::
    assert.doesNotThrow(() => document.querySelector(selector));
  });

  it('nth-of-type is correct among same-parent siblings', () => {
    setupJSDOM(`<html><body>
      <div><iframe></iframe></div>
      <div><iframe></iframe><iframe></iframe></div>
    </body></html>`);
    const allIframes = document.querySelectorAll('iframe');
    // First iframe is the only iframe in its parent → nth-of-type(1)
    assert.equal(buildIframePrefix(allIframes[0]), 'iframe:nth-of-type(1)::');
    // Second and third iframes share a parent; positions 1 and 2 within that parent
    assert.equal(buildIframePrefix(allIframes[1]), 'iframe:nth-of-type(1)::');
    assert.equal(buildIframePrefix(allIframes[2]), 'iframe:nth-of-type(2)::');
  });
});

describe('cleanPageHtml', () => {
  const { cleanPageHtml } = require('../lib/dom-cleaner');

  it('removes script and style tags', () => {
    setupJSDOM(`<html><body>
      <div id="main">Hello</div>
      <script>alert('bad')</script>
      <style>.x{color:red}</style>
    </body></html>`);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(!cleaned.includes('alert'));
    assert.ok(!cleaned.includes('color:red'));
    assert.ok(cleaned.includes('id="main"'));
    assert.ok(cleaned.includes('Hello'));
  });

  it('removes on* event handler attributes', () => {
    setupJSDOM(`<html><body><button onclick="evil()">Click</button></body></html>`);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(!cleaned.includes('onclick'));
    assert.ok(cleaned.includes('Click'));
  });

  it('removes style attributes but keeps class', () => {
    setupJSDOM(`<html><body><div class="keep" style="color:red">X</div></body></html>`);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(!cleaned.includes('style='));
    assert.ok(cleaned.includes('class="keep"'));
  });

  it('trims attribute values longer than 200 chars', () => {
    const longVal = 'a'.repeat(250);
    setupJSDOM(`<html><body><div data-x="${longVal}">X</div></body></html>`);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(cleaned.includes('...'));
    assert.ok(!cleaned.includes('a'.repeat(250)));
  });

  it('removes noise containers (nav, footer, aside)', () => {
    setupJSDOM(`<html><body>
      <main><p>content</p></main>
      <nav><a>nav link</a></nav>
      <footer>(c) 2026</footer>
      <aside>sidebar</aside>
    </body></html>`);
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

  it('NEW: filters framework-generated class hashes', () => {
    setupJSDOM(`<html><body>
      <div class="sc-abc123 _ngcontent-abc css-1xyz ant-btn btn-primary">Save</div>
    </body></html>`);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(cleaned.includes('ant-btn'));
    assert.ok(cleaned.includes('btn-primary'));
    assert.ok(!cleaned.includes('sc-abc123'));
    assert.ok(!cleaned.includes('_ngcontent'));
    assert.ok(!cleaned.includes('css-1xyz'));
  });

  it('NEW: drops class attribute entirely when all classes are noise', () => {
    setupJSDOM(`<html><body><div class="css-abc123 _ngcontent-xyz">X</div></body></html>`);
    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(!cleaned.includes('class='));
  });

  it('NEW: marks same-origin iframes with data-iframe-prefix and inlines children', () => {
    // jsdom does not serialize an iframe's contentDocument into the parent
    // document's outerHTML, so populate the iframe's element children instead
    // (which jsdom does preserve through serialization). In a real browser the
    // iframe's contentDocument is reachable directly; here we mirror the
    // post-inline shape cleanPageHtml produces for same-origin iframes.
    setupJSDOM(`<html><body>
      <iframe id="zbggframe1"><div class="ewb-info-main"><u>项目名称</u></div></iframe>
    </body></html>`);

    const cleaned = cleanPageHtml(document.documentElement.outerHTML);
    assert.ok(cleaned.includes('data-iframe-prefix="iframe#zbggframe1::"'), 'expected data-iframe-prefix attribute');
    assert.ok(cleaned.includes('项目名称'), 'iframe children should be inlined');
    assert.ok(!cleaned.includes('<div data-iframe'), 'old wrapper should be gone');
  });
});
