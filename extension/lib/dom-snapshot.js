// NOTE: This module is used for Node.js testing. The production implementation
// lives inline in extension/content-script.js (getCompressedSnapshot,
// getElementFullHtml). Keep both implementations in sync.
//
// Iframe-aware selector support is shared with lib/iframe-selector.js, which
// is loaded as a content script before content-script.js (see manifest.json).
// We require it here so the test copy exercises the same logic.

const IframeSelector = require('./iframe-selector');

function getCompressedSnapshot() {
  if (!document || !document.documentElement || !document.body) {
    return { structure: '', textSummary: '', url: location?.href || '', title: document?.title || '' };
  }

  const REMOVE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'NOSCRIPT'
    // NOTE: IFRAME is intentionally NOT in this set. Same-origin iframe
    // content is inlined into the snapshot so the LLM can reason about it
    // (matches the production implementation in content-script.js). Cross-
    // origin iframes are replaced with a placeholder.
  ]);
  const CONTAINER_TAGS = new Set([
    'DIV', 'SPAN', 'P', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN'
  ]);

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isNumericOrPriceLike(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    return /^[\d\$\€\£\¥\,\.\%\s\-\+]+$/.test(trimmed) || /^\d/.test(trimmed);
  }

  function truncateText(text, maxLen) {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...';
  }

  function buildAttrs(node) {
    const parts = [];
    if (node.id) parts.push(`id="${escapeHtml(node.id)}"`);
    if (node.getAttribute('name')) parts.push(`name="${escapeHtml(node.getAttribute('name'))}"`);
    const classAttr = node.getAttribute('class');
    if (classAttr) {
      const classes = classAttr.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
      if (classes) parts.push(`class="${escapeHtml(classes)}"`);
    }
    const placeholder = node.getAttribute('placeholder');
    if (placeholder) parts.push(`placeholder="${escapeHtml(truncateText(placeholder, 30))}"`);
    if (node.getAttribute('type')) parts.push(`type="${escapeHtml(node.getAttribute('type'))}"`);
    if (node.tagName === 'A' && node.getAttribute('href')) {
      parts.push(`href="${escapeHtml(node.getAttribute('href'))}"`);
    }
    if (['SCRIPT', 'IMG', 'IFRAME'].includes(node.tagName) && node.getAttribute('src')) {
      parts.push(`src="${escapeHtml(node.getAttribute('src'))}"`);
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  }

  function walk(node, depth) {
    if (depth > 20) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      const trimmed = text.trim();
      if (trimmed.length === 0) return '';
      if (isNumericOrPriceLike(trimmed) || trimmed.length <= 20) {
        return escapeHtml(trimmed);
      }
      return escapeHtml(truncateText(trimmed, 20));
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    if (REMOVE_TAGS.has(node.tagName)) return '';

    const tag = node.tagName.toLowerCase();
    const attrs = buildAttrs(node);

    // Inline same-origin iframe content so the LLM can write selectors
    // against it. Without this, every selector the LLM writes that targets
    // iframe content returns no match in the snapshot.
    if (tag === 'iframe') {
      try {
        const doc = node.contentDocument;
        if (doc && doc.body) {
          const parts = [];
          for (const child of doc.body.childNodes) {
            const compressed = walk(child, depth + 1);
            if (compressed) parts.push(compressed);
          }
          return parts.length ? `<div data-iframe>${parts.join('')}</div>` : '';
        }
      } catch (e) { /* cross-origin */ }
      return '';
    }

    const parts = [];
    for (const child of node.childNodes) {
      parts.push(walk(child, depth + 1));
    }
    const children = parts.join('');

    if (children.length === 0 && CONTAINER_TAGS.has(node.tagName)) {
      return `<${tag}${attrs}></${tag}>`;
    }

    return `<${tag}${attrs}>${children}</${tag}>`;
  }

  const body = document.body;
  const structure = walk(body, 0);
  const textSummary = (document.body?.textContent?.slice(0, 3000)) || '';

  return {
    structure,
    textSummary,
    url: (document.location && document.location.href) || '',
    title: document.title || ''
  };
}

function getElementFullHtml(selector) {
  // Iframe-prefixed selectors (iframe#x::inner) and legacy selectors that
  // resolve inside same-origin iframes both go through querySelectorDeep.
  // Required for the wizard research phase: when LLM candidates target iframe
  // elements, the LLM needs the full HTML to confirm or revise them.
  let el;
  try {
    const found = IframeSelector.querySelectorDeep(document, selector);
    el = found ? found.element : null;
  } catch (e) {
    // Invalid CSS selector (e.g. IDs containing colons like `radix-:rfm:`
    // that the LLM sometimes copies verbatim from the page snapshot).
    return { selector, found: false, error: 'INVALID_SELECTOR: ' + (e && e.message ? e.message : String(e)) };
  }

  if (!el) {
    return { selector, found: false };
  }

  const attributes = [];
  for (const attr of el.attributes) {
    attributes.push({ name: attr.name, value: attr.value });
  }

  return {
    selector,
    found: true,
    outerHTML: el.outerHTML,
    innerText: el.innerText || el.textContent || '',
    attributes
  };
}

function getElementsFullHtml(selectors) {
  return selectors.map(getElementFullHtml);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getCompressedSnapshot, getElementFullHtml, getElementsFullHtml };
} else if (typeof window !== 'undefined') {
  window.DomSnapshot = { getCompressedSnapshot, getElementFullHtml, getElementsFullHtml };
}
