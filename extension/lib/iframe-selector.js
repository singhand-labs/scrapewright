// Iframe-aware selector utilities. Encodes "this element lives inside an
// iframe" into a CSS selector string so the annotation recorder, the extractor,
// and the LLM can all agree on which iframe an element belongs to.
//
// Format:   iframe<css>::<inner-css>     (single iframe)
//           iframe<a>::iframe<b>::<inner> (nested iframes)
//
// A leading `iframe` token on each `::`-separated segment marks an iframe
// selector evaluated in the parent document. Anything after the last iframe
// segment is the inner CSS selector evaluated inside the deepest iframe.
//
// Selectors without any `iframe...::` prefix keep their existing meaning
// (search main document, then iterate same-origin iframes) so old services
// and LLM-generated scripts continue to work.
//
// This module is dual-environment: Node tests use the CommonJS export; the
// content script inlines the same logic (see content-script.js). Keep both in
// sync — the inline copy is the production path because content scripts can't
// `require()` modules.

const IFRAME_PREFIX = 'iframe';
const SEGMENT_SEPARATOR = '::';

// Parse a selector string into { iframeChain: string[], innerSelector: string }.
// iframeChain is the list of iframe-element selectors (each with the leading
// "iframe" token stripped). innerSelector is the final CSS selector evaluated
// inside the deepest iframe. Returns iframeChain:[] for non-prefixed selectors
// so callers can fall back to the legacy "search every doc" behavior.
function parseIframeSelector(sel) {
  if (typeof sel !== 'string' || sel.length === 0) {
    return { iframeChain: [], innerSelector: sel || '' };
  }
  const parts = sel.split(SEGMENT_SEPARATOR);
  const iframeChain = [];
  let i = 0;
  while (i < parts.length && parts[i].startsWith(IFRAME_PREFIX)) {
    // Only treat as an iframe segment if what follows `iframe` is a CSS selector
    // char (not another `iframe` keyword run-on). Empty string after `iframe`
    // is invalid — bail out so we don't misinterpret an inner selector that
    // happens to begin with the substring.
    const rest = parts[i].slice(IFRAME_PREFIX.length);
    if (rest.length === 0) break;
    iframeChain.push(rest);
    i++;
  }
  // Re-join the rest in case the inner selector legitimately contains `::`
  // (e.g. a CSS pseudo-element like `td::before`).
  const innerSelector = parts.slice(i).join(SEGMENT_SEPARATOR);
  return { iframeChain, innerSelector };
}

// Inverse of parseIframeSelector. iframeChain is an array of CSS selectors
// for iframe elements (without the leading "iframe" token). innerSelector is
// the CSS selector evaluated inside the deepest iframe.
function formatIframeSelector(iframeChain, innerSelector) {
  const chain = (iframeChain || []).map(s => IFRAME_PREFIX + s).join(SEGMENT_SEPARATOR);
  if (!chain) return innerSelector || '';
  if (!innerSelector) return chain;
  return chain + SEGMENT_SEPARATOR + innerSelector;
}

function isIframePrefixed(sel) {
  return typeof sel === 'string' && sel.startsWith(IFRAME_PREFIX) &&
    sel.indexOf(SEGMENT_SEPARATOR) !== -1;
}

// Walk up from el to topDoc, returning the chain of iframe-element selectors
// (without the leading "iframe" token) that identifies which iframes enclose
// el. Empty array means el lives directly in topDoc.
//
// We prefer stable selectors: #id first, then iframe[src="..."], then a tag
// + nth-of-type fallback. We do NOT use generateSelector-style paths here
// because the iframe element itself is usually uniquely identifiable.
function buildIframeChain(el, topDoc) {
  const chain = [];
  let ownerDoc = el && el.ownerDocument;
  if (!ownerDoc) return chain;
  while (ownerDoc && ownerDoc !== topDoc) {
    const parentWin = ownerDoc.defaultView;
    if (!parentWin || parentWin === parentWin.parent) break;
    const parentDoc = parentWin.parent.document;
    // Find the iframe element in parentDoc whose contentWindow === parentWin.
    let iframeEl = null;
    try {
      const candidates = parentDoc.querySelectorAll('iframe');
      for (const candidate of candidates) {
        if (candidate.contentWindow === parentWin) {
          iframeEl = candidate;
          break;
        }
      }
    } catch (e) {
      // cross-origin parent — shouldn't normally happen since we own el
      break;
    }
    if (!iframeEl) break;
    chain.unshift(iframeElementSelector(iframeEl));
    ownerDoc = parentDoc;
  }
  return chain;
}

function iframeElementSelector(iframeEl) {
  if (iframeEl.id) return '#' + cssEscapeIdent(iframeEl.id);
  const name = iframeEl.getAttribute('name');
  if (name) return '[name="' + cssEscapeString(name) + '"]';
  const src = iframeEl.getAttribute('src');
  if (src) return '[src="' + cssEscapeString(src) + '"]';
  // Fallback: nth-of-type among sibling iframes
  const parent = iframeEl.parentElement;
  if (parent) {
    const siblings = Array.from(parent.querySelectorAll('iframe'));
    const idx = siblings.indexOf(iframeEl) + 1;
    return ':nth-of-type(' + idx + ')';
  }
  return '';
}

// Escape a CSS identifier (e.g. an #id value with special chars). CSS.escape
// is available in browsers and Node >= 17; fall back to a regex escaper.
function cssEscapeIdent(s) {
  if (typeof s !== 'string') return '';
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// Escape a CSS string literal (attribute-selector value). Inside double quotes
// only `"` and `\` need escaping — dots, slashes in URLs, etc. are literal.
function cssEscapeString(s) {
  if (typeof s !== 'string') return '';
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Resolve a (possibly iframe-prefixed) selector against topDoc. Returns
// { element, doc } where doc is the document the element belongs to, or null
// when not found. When the selector has no iframe prefix, falls back to the
// legacy "search topDoc then iterate same-origin iframes" behavior.
//
// Invalid CSS selectors THROW (matching standard DOM querySelector semantics)
// so callers like getElementFullHtml can distinguish "not found" from
// "malformed selector" and surface the right error to the LLM. Callers that
// want null-on-invalid can wrap the call in try/catch.
function querySelectorDeep(topDoc, sel) {
  const parsed = parseIframeSelector(sel);
  if (parsed.iframeChain.length > 0) {
    const resolved = resolveIframeChain(topDoc, parsed.iframeChain);
    if (!resolved) return null;
    const el = resolved.querySelector(parsed.innerSelector);
    if (el) return { element: el, doc: resolved };
    return null;
  }
  // Legacy: top doc first, then same-origin iframes in DOM order.
  const el = topDoc.querySelector(parsed.innerSelector);
  if (el) return { element: el, doc: topDoc };
  const iframes = topDoc.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      const doc = iframe.contentDocument;
      if (!doc) continue;
      const inner = doc.querySelector(parsed.innerSelector);
      if (inner) return { element: inner, doc };
    } catch (e) { /* cross-origin iframe — skip, not an error */ }
  }
  return null;
}

// Return all matches across topDoc and (when no iframe prefix) same-origin
// iframes. With an iframe prefix, restricts to that specific iframe. Invalid
// inner selectors THROW (see querySelectorDeep).
function querySelectorAllDeep(topDoc, sel) {
  const parsed = parseIframeSelector(sel);
  const results = [];
  const collect = (doc, selector) => {
    doc.querySelectorAll(selector).forEach(el => results.push(el));
  };
  if (parsed.iframeChain.length > 0) {
    const resolved = resolveIframeChain(topDoc, parsed.iframeChain);
    if (resolved) collect(resolved, parsed.innerSelector);
    return results;
  }
  collect(topDoc, parsed.innerSelector);
  const iframes = topDoc.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      const doc = iframe.contentDocument;
      if (doc) collect(doc, parsed.innerSelector);
    } catch (e) { /* cross-origin iframe */ }
  }
  return results;
}

// Walk the iframe chain from topDoc, returning the deepest document or null.
// Throws on invalid iframe selectors (consistent with querySelectorDeep).
function resolveIframeChain(topDoc, iframeChain) {
  let currentDoc = topDoc;
  for (const rawSelector of iframeChain) {
    if (!currentDoc) return null;
    // rawSelector is the part after `iframe` (e.g. `#zbggframe1`). Prepend
    // the iframe tag so querySelector matches the iframe element itself.
    const selector = IFRAME_PREFIX + rawSelector;
    const iframeEl = currentDoc.querySelector(selector);
    if (!iframeEl) return null;
    try {
      currentDoc = iframeEl.contentDocument;
    } catch (e) { return null; }
    if (!currentDoc) return null;
  }
  return currentDoc;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IFRAME_PREFIX,
    SEGMENT_SEPARATOR,
    parseIframeSelector,
    formatIframeSelector,
    isIframePrefixed,
    buildIframeChain,
    iframeElementSelector,
    querySelectorDeep,
    querySelectorAllDeep,
    resolveIframeChain
  };
} else if (typeof window !== 'undefined') {
  window.IframeSelector = {
    IFRAME_PREFIX,
    SEGMENT_SEPARATOR,
    parseIframeSelector,
    formatIframeSelector,
    isIframePrefixed,
    buildIframeChain,
    iframeElementSelector,
    querySelectorDeep,
    querySelectorAllDeep,
    resolveIframeChain
  };
}
