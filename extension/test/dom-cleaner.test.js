const { describe, it, beforeEach } = require('node:test');
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

describe('extractAnnotationContext', () => {
  const { extractAnnotationContext } = require('../lib/dom-cleaner');

  it('returns null for missing selector', () => {
    setupJSDOM(`<html><body><div>X</div></body></html>`);
    assert.equal(extractAnnotationContext(document, '.missing'), null);
  });

  it('returns context including annotated element', () => {
    setupJSDOM(`<html><body>
      <table><tbody>
        <tr><td class="label">公司名称</td></tr>
        <tr><td class="label">注册资本</td></tr>
      </tbody></table>
    </body></html>`);
    const result = extractAnnotationContext(document, 'td.label');
    assert.ok(result);
    assert.ok(result.includes('公司名称'));
  });

  it('folds distant siblings into a comment', () => {
    setupJSDOM(`<html><body>
      <ul>
        <li>item 1</li><li>item 2</li>
        <li class="target">target</li>
        <li>item 4</li><li>item 5</li><li>item 6</li><li>item 7</li>
      </ul>
    </body></html>`);
    const result = extractAnnotationContext(document, '.target', 1);
    assert.ok(result);
    assert.ok(result.includes('target'));
    assert.ok(result.includes('item 2'));
    assert.ok(result.includes('siblings'));
    assert.ok(!result.includes('item 7'));
  });

  it('limits depth below annotated element', () => {
    setupJSDOM(`<html><body>
      <div class="outer"><div class="target">
        <div><div><div><div>deep</div></div></div></div>
      </div></div>
    </body></html>`);
    const result = extractAnnotationContext(document, '.target', 1);
    assert.ok(result);
    assert.ok(result.includes('target'));
    assert.ok(!result.includes('deep'));
  });
});

describe('compressStructure', () => {
  const { compressStructure } = require('../lib/dom-cleaner');

  it('returns tag and class for top-level nodes', () => {
    setupJSDOM(`<html><body><div class="app"><p>hi</p></div></body></html>`);
    const result = compressStructure(document, []);
    assert.ok(result.includes('div'));
    assert.ok(result.includes('class="app"'));
  });

  it('marks annotated subtrees', () => {
    setupJSDOM(`<html><body>
      <main><section class="info"><table><tbody><tr><td>cell</td></tr></tbody></table></section></main>
    </body></html>`);
    const result = compressStructure(document, ['td']);
    assert.ok(result.includes('[ANNOTATED]'));
  });

  it('folds deep non-annotated subtrees', () => {
    setupJSDOM(`<html><body>
      <div class="root"><div><div><div><div><div>very deep</div></div></div></div></div></div>
    </body></html>`);
    const result = compressStructure(document, []);
    assert.ok(result.includes('children'));
    assert.ok(!result.includes('very deep'));
  });

  it('includes child count for folded nodes', () => {
    setupJSDOM(`<html><body><ul><li>1</li><li>2</li><li>3</li></ul></body></html>`);
    const result = compressStructure(document, []);
    assert.ok(result.includes('3') || result.includes('children'));
  });
});

describe('cleanHtmlForLLM', () => {
  const { cleanHtmlForLLM } = require('../lib/dom-cleaner');

  it('returns mode full for small pages', () => {
    setupJSDOM(`<html><body><div class="content"><p>small page</p></div></body></html>`);
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
      { selector: '.key' }, { selector: '.val' }
    ]);
    assert.equal(result.mode, 'compressed');
    const combined = result.contexts.map(c => c.context || '').join('');
    assert.ok(combined.includes('注册资本'));
    assert.ok(combined.includes('100万美元'));
  });
});

describe('getCompressedSnapshot', () => {
  const { getCompressedSnapshot } = require('../lib/dom-cleaner');

  // Reset globals before each case — getCompressedSnapshot reads global.document.
  beforeEach(() => {
    delete global.location;
  });

  it('removes script/style tags', () => {
    setupJSDOM(`<html><body>
      <div id="main">Hello</div>
      <script>alert('bad')</script>
      <style>.x{color:red}</style>
    </body></html>`);
    const result = getCompressedSnapshot();
    assert.ok(!result.structure.includes('alert'));
    assert.ok(!result.structure.includes('color:red'));
    assert.ok(result.structure.includes('id="main"'));
    assert.ok(result.structure.includes('Hello'));
  });

  it('preserves prices fully (truncateText threshold bump)', () => {
    setupJSDOM(`<html><body>
      <span>$9,999,999.99</span>
    </body></html>`);
    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('$9,999,999.99'));
  });

  it('truncates long prose to 60 chars', () => {
    setupJSDOM(`<html><body>
      <p>This is a paragraph of marketing copy that goes on for many words and exceeds sixty characters</p>
    </body></html>`);
    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('This is a paragraph of marketing copy that goes on for m'));
    assert.ok(result.structure.includes('...'));
  });

  it('limits class names to first 2 after filtering', () => {
    setupJSDOM(`<html><body><div class="a b c d" id="box">Content</div></body></html>`);
    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('class="a b"'));
    assert.ok(!result.structure.includes('class="a b c d"'));
  });

  it('NEW: drops framework class hashes from snapshot output', () => {
    setupJSDOM(`<html><body>
      <button class="css-1abc23 ant-btn btn-primary">Save</button>
    </body></html>`);
    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('ant-btn'));
    assert.ok(result.structure.includes('btn-primary'));
    assert.ok(!result.structure.includes('css-1abc23'));
  });

  it('handles missing body gracefully', () => {
    global.document = { documentElement: true, title: '' };
    global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    global.location = { href: 'about:blank' };
    const result = getCompressedSnapshot();
    assert.strictEqual(result.structure, '');
    assert.strictEqual(result.textSummary, '');
  });

  it('inlines same-origin iframe content with data-iframe-prefix marker', () => {
    setupJSDOM(`<html><body><iframe id="zbggframe1"></iframe></body></html>`);
    const iframe = document.getElementById('zbggframe1');
    const doc = iframe.contentDocument;
    doc.open();
    doc.write('<!DOCTYPE html><html><body><u><font>项目名称</font></u></body></html>');
    doc.close();

    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('data-iframe-prefix="iframe#zbggframe1::"'),
      'expected data-iframe-prefix attribute, got: ' + result.structure);
    assert.ok(result.structure.includes('项目名称'), 'iframe text content not inlined');
    assert.ok(!result.structure.includes('<div data-iframe'),
      'old wrapper should be gone; got: ' + result.structure);
  });

  it('uses name-based prefix when iframe has no id', () => {
    setupJSDOM(`<html><body><iframe name="content-frame"></iframe></body></html>`);
    const iframe = document.querySelector('iframe[name="content-frame"]');
    const doc = iframe.contentDocument;
    doc.open();
    doc.write('<!DOCTYPE html><html><body><p>frame text</p></body></html>');
    doc.close();

    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('data-iframe-prefix="iframe[name="content-frame"]::"'),
      'expected name-based prefix, got: ' + result.structure);
  });

  it('uses nth-of-type prefix when iframe has neither id nor name', () => {
    setupJSDOM(`<html><body><iframe></iframe><iframe></iframe></body></html>`);
    const iframes = document.querySelectorAll('iframe');
    for (const fr of iframes) {
      const d = fr.contentDocument;
      d.open(); d.write('<!DOCTYPE html><html><body><p>x</p></body></html>'); d.close();
    }
    const result = getCompressedSnapshot();
    assert.ok(result.structure.includes('data-iframe-prefix="iframe:nth-of-type(1)::"'),
      'expected nth-of-type(1) prefix, got: ' + result.structure);
    assert.ok(result.structure.includes('data-iframe-prefix="iframe:nth-of-type(2)::"'),
      'expected nth-of-type(2) prefix, got: ' + result.structure);
  });

  it('does not crash on cross-origin iframes (contentDocument throws)', () => {
    setupJSDOM(`<html><body><iframe id="cross"></iframe></body></html>`);
    const iframe = document.getElementById('cross');
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new Error('cross-origin'); }
    });
    const result = getCompressedSnapshot();
    assert.doesNotThrow(() => result.structure.length);
  });
});

describe('getElementFullHtml', () => {
  const { getElementFullHtml } = require('../lib/dom-cleaner');

  it('returns full outerHTML for matched element', () => {
    setupJSDOM(`<html><body><div id="target" data-foo="bar"><span>Inner</span></div></body></html>`);
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
  });

  it('returns found:false with error for invalid CSS selector', () => {
    setupJSDOM(`<html><body><div id="radix-:rfm:">x</div></body></html>`);
    const result = getElementFullHtml('#radix-:rfm:');
    assert.equal(result.found, false);
    assert.equal(result.selector, '#radix-:rfm:');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  });

  it('finds element inside a specific iframe via prefixed selector', () => {
    setupJSDOM(`<html><body><iframe id="frameA"></iframe><iframe id="frameB"></iframe></body></html>`);
    const fillIframe = (id, html) => {
      const d = document.getElementById(id).contentDocument;
      d.open(); d.write('<!DOCTYPE html><html><body>' + html + '</body></html>'); d.close();
    };
    fillIframe('frameA', '<u><font>frame-a-value</font></u>');
    fillIframe('frameB', '<u><font>frame-b-value</font></u>');
    const result = getElementFullHtml('iframe#frameB::u > font');
    assert.equal(result.found, true);
    assert.ok(result.outerHTML.includes('frame-b-value'));
    assert.ok(!result.outerHTML.includes('frame-a-value'));
  });

  it('returns found:false when the named iframe does not exist', () => {
    setupJSDOM(`<html><body><iframe id="real"></iframe></body></html>`);
    const d = document.getElementById('real').contentDocument;
    d.open(); d.write('<!DOCTYPE html><html><body><div id="x">y</div></body></html>'); d.close();
    const result = getElementFullHtml('iframe#missing::div');
    assert.equal(result.found, false);
  });

  it('preserves backward compat for legacy selectors that resolve in iframes', () => {
    setupJSDOM(`<html><body><iframe id="fr"></iframe></body></html>`);
    const d = document.getElementById('fr').contentDocument;
    d.open(); d.write('<!DOCTYPE html><html><body><div id="only-here">x</div></body></html>'); d.close();
    const result = getElementFullHtml('#only-here');
    assert.equal(result.found, true);
    assert.ok(result.outerHTML.includes('only-here'));
  });
});
