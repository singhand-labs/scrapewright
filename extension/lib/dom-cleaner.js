// Unified DOM cleaner for Scrapewright. Two entry-point families share one
// helper layer:
//   - Wizard path (string in, string out): cleanPageHtml, cleanHtmlForLLM,
//     extractAnnotationContext, compressStructure.
//   - Content-script path (live DOM in, structure object out):
//     getCompressedSnapshot, getElementFullHtml, getElementsFullHtml.
//
// Dual-environment: Node tests use the CommonJS export; the extension loads
// this file via <script> in wizard.html and via manifest.json content_scripts
// (assigned to window.DomCleaner).
(function (global) {
  'use strict';

  // --- filterClasses --------------------------------------------------------
  // Drop framework-generated class tokens (Angular/Vue scoped markers,
  // emotion/styled-components hashes, pure-hash tokens). Preserve semantic
  // classes (ant-btn, btn-primary, Tailwind utilities, etc.).
  const NOISE_CLASS_PATTERNS = [
    /^(_ng|_nghost|_ngcontent|data-v-)/i,
    /^(css-|sc-|styled-|StyledComponent__)/i,
    // Pure-hash tokens: optional leading underscore, mix of letters and digits,
    // no hyphens, >=6 chars. Must contain at least one digit and one letter,
    // so plain words like "primary" or "button" survive.
    /^_?(?=[a-z0-9]{6,}$)(?=.*\d)(?=.*[a-z])[a-z0-9]+$/i,
  ];

  function filterClasses(classAttr) {
    if (!classAttr) return '';
    const tokens = String(classAttr).split(/\s+/).filter(Boolean);
    const kept = tokens.filter(t => !NOISE_CLASS_PATTERNS.some(re => re.test(t)));
    return kept.join(' ');
  }

  // --- truncateText ---------------------------------------------------------
  // Threshold moved from 20 → 60 to give the LLM more disambiguating context.
  // Prices, dates, and identifier-like tokens are preserved verbatim so real
  // data survives compression. Only long prose gets cut.
  const TEXT_THRESHOLD = 60;
  const PRESERVE_PATTERNS = [
    /^[\d\s,.:$¥€£+-]+$/,
    /^\d{4}-\d{2}-\d{2}/,
    /^\d{1,2}\/\d{1,2}\/\d{2,4}/,
    /^[A-Z]{2,}[-_]?\w*$/,
    /^\w[\w-]*\d[-\w]*$/,
  ];

  function truncateText(text) {
    if (!text) return '';
    const t = String(text).trim();
    if (t.length <= TEXT_THRESHOLD) return t;
    for (const re of PRESERVE_PATTERNS) {
      if (re.test(t)) return t;
    }
    return t.slice(0, TEXT_THRESHOLD) + '...';
  }

  // --- shouldRemoveTag ------------------------------------------------------
  // Tags that never help the LLM write selectors. Note: iframe is NOT in this
  // set — same-origin iframes are inlined with a prefix marker so the LLM
  // can target content via iframe#x::selector syntax.
  const REMOVE_TAG_SET = new Set([
    'script', 'style', 'link', 'img', 'video', 'audio', 'canvas', 'svg',
    'noscript', 'template', 'meta', 'path', 'g', 'defs', 'use'
  ]);

  function shouldRemoveTag(tagName) {
    if (!tagName) return false;
    return REMOVE_TAG_SET.has(String(tagName).toLowerCase());
  }

  // --- buildIframePrefix ----------------------------------------------------
  // Compute the prefix string for the data-iframe-prefix attribute. The value
  // ends with `::` so the LLM appends its selector and lib/iframe-selector.js
  // parses the result as `iframe<css>::<inner>`.
  function escapeCssIdent(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(s);
    }
    // Minimal fallback for environments without CSS.escape (e.g. jsdom):
    // backslash-escape anything that isn't a letter, digit, hyphen, or underscore.
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // Escape a CSS string literal (attribute-selector value). Inside double quotes
  // only `"` and `\` need escaping — mirrors lib/iframe-selector.js cssEscapeString.
  function escapeCssString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function buildIframePrefix(iframe) {
    if (!iframe) return '';
    const id = iframe.getAttribute && iframe.getAttribute('id');
    if (id) return 'iframe#' + escapeCssIdent(id) + '::';
    const name = iframe.getAttribute && iframe.getAttribute('name');
    if (name) return 'iframe[name="' + escapeCssString(name) + '"]::';
    // nth-of-type is evaluated within the parent element — select among
    // same-parent iframe siblings, not document order. Mirrors the pattern
    // in lib/iframe-selector.js iframeElementSelector.
    const parent = iframe.parentElement;
    if (!parent) return 'iframe::';
    const siblings = Array.from(parent.children).filter(el => el.tagName === 'IFRAME');
    const idx = siblings.indexOf(iframe) + 1;
    return 'iframe:nth-of-type(' + idx + ')::';
  }

  // --- cleanPageHtml --------------------------------------------------------
  // Full-page cleaner. String in (DOMParser), string out. Strips noise tags,
  // hidden elements, comments, on*/style attributes; truncates long attr
  // values to 200 chars; applies filterClasses to class attrs in place;
  // rewrites same-origin iframes to inline their content with a prefix marker.
  const NOISE_SELECTORS = 'nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [class*="sidebar"], [class*="side-bar"], [class*="Sidebar"], [class*="toast"], [class*="modal-backdrop"], [class*="overlay"], [class*="cookie"], [class*="banner"], [class*="popup"], [class*="tooltip"], [class*="dropdown-menu"]';

  const REMOVE_SELECTORS = 'script, style, link[rel="stylesheet"], link[rel="preload"], link[rel="icon"], video, audio, canvas, svg, noscript, template, meta, path, g, defs, use';

  const HIDDEN_SELECTORS = '[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"]';

  function cleanPageHtml(htmlString) {
    if (!htmlString) return '';
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');
    const root = doc.documentElement;

    root.querySelectorAll(REMOVE_SELECTORS).forEach(el => el.remove());
    root.querySelectorAll(HIDDEN_SELECTORS).forEach(el => el.remove());
    root.querySelectorAll(NOISE_SELECTORS).forEach(el => el.remove());

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(c => c.remove());

    root.querySelectorAll('*').forEach(el => {
      // Strip on* handlers and style attrs.
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on') || attr.name === 'style') {
          el.removeAttribute(attr.name);
        }
      });
      // Filter class attribute in place; drop entirely if empty.
      if (el.hasAttribute('class')) {
        const filtered = filterClasses(el.getAttribute('class'));
        if (filtered) el.setAttribute('class', filtered);
        else el.removeAttribute('class');
      }
      // Truncate long attribute values.
      Array.from(el.attributes).forEach(attr => {
        if (attr.value.length > 200) {
          el.setAttribute(attr.name, attr.value.slice(0, 200) + '...');
        }
      });
    });

    // Iframe marker rewrite: same-origin → inline children + prefix attr.
    // Two cases:
    //  1) Parsed-from-string iframe with a reachable contentDocument (rare under
    //     DOMParser, common when cleanPageHtml is called on a live Document):
    //     move body children into the iframe element.
    //  2) Iframe whose children were already inlined upstream (e.g. by
    //     getCompressedSnapshot) or that simply has element children: leave the
    //     children in place. Either way, set the data-iframe-prefix marker so
    //     the LLM can target the iframe's content via iframe#x::selector.
    // Cross-origin iframes (contentDocument access throws) are left untouched.
    root.querySelectorAll('iframe').forEach(iframe => {
      const prefix = buildIframePrefix(iframe);
      let marked = false;
      try {
        const innerDoc = iframe.contentDocument;
        if (innerDoc && innerDoc.body) {
          while (iframe.firstChild) iframe.removeChild(iframe.firstChild);
          while (innerDoc.body.firstChild) {
            iframe.appendChild(innerDoc.body.firstChild);
          }
          marked = true;
        } else if (iframe.childNodes && iframe.childNodes.length > 0) {
          // Children already inlined upstream — preserve them and mark.
          marked = true;
        }
      } catch (_) { /* cross-origin: leave iframe as-is */ }
      if (marked) iframe.setAttribute('data-iframe-prefix', prefix);
    });

    let result = root.outerHTML;
    result = result.replace(/\n\s*\n/g, '\n').replace(/>\s+</g, '><');
    return result;
  }

  // Export stub — extended by later tasks.
  const api = { filterClasses, truncateText, shouldRemoveTag, buildIframePrefix, cleanPageHtml };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.DomCleaner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
