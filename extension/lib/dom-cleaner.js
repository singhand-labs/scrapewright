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

  // Export stub — extended by later tasks.
  const api = { filterClasses, truncateText, shouldRemoveTag, buildIframePrefix };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.DomCleaner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
