// NOTE: This module is used for Node.js testing. The production implementation
// lives inline in extension/content-script.js (getCompressedSnapshot, getElementFullHtml).
// Keep both implementations in sync.

function getCompressedSnapshot() {
  if (!document || !document.documentElement || !document.body) {
    return { structure: '', textSummary: '', url: location?.href || '', title: document?.title || '' };
  }

  const REMOVE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'IFRAME', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'NOSCRIPT'
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
  let el;
  try {
    el = document.querySelector(selector);
  } catch (e) {
    // Invalid CSS selector (e.g., IDs containing colons like `radix-:rfm:`
    // that the LLM sometimes copies verbatim from the page snapshot).
    // Without this guard, querySelector throws synchronously and crashes
    // the GET_ELEMENTS_HTML listener, surfacing in the wizard as a generic
    // "Error message from listener couldn't be parsed or was empty."
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
