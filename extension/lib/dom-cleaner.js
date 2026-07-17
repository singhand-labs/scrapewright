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

  // IframeSelector is loaded as a content script BEFORE this file in the
  // extension (see manifest.json). In Node tests, require it directly.
  let IframeSelector = null;
  if (typeof module !== 'undefined' && module.exports) {
    try { IframeSelector = require('./iframe-selector'); } catch (_) { IframeSelector = null; }
  } else if (typeof global !== 'undefined' && global.IframeSelector) {
    IframeSelector = global.IframeSelector;
  }

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

  // --- extractAnnotationContext ---------------------------------------------
  // Extract the DOM subtree around an annotated element: N ancestors up, 2
  // siblings on each side at each level. Used when the full cleaned HTML is
  // too big to send to the LLM.
  const ANNOTATION_CONTEXT_RADIUS = 3;
  const MAX_DEPTH_BELOW_TARGET = 2;
  const SIBLING_KEEP_COUNT = 2;

  function extractAnnotationContext(doc, selector, ancestorRadius) {
    const radius = ancestorRadius === undefined ? ANNOTATION_CONTEXT_RADIUS : ancestorRadius;
    if (!selector) return null;
    let target;
    try {
      target = doc.querySelector(selector);
    } catch (e) {
      return null;
    }
    if (!target) return null;

    let root = target;
    for (let i = 0; i < radius; i++) {
      if (root.parentElement && root.parentElement !== doc.body) {
        root = root.parentElement;
      } else {
        break;
      }
    }

    const path = [];
    let cur = target;
    while (cur) {
      path.unshift(cur);
      if (cur === root) break;
      cur = cur.parentElement;
    }
    if (!path.includes(root)) return null;

    function attrsFor(node, markAnnotated) {
      let attrs = '';
      if (node.id) attrs += ` id="${node.id}"`;
      const filtered = filterClasses(node.className || '');
      const cls = filtered.split(' ').filter(c => c).slice(0, 2).join(' ');
      if (cls) attrs += ` class="${cls}"`;
      if (markAnnotated) attrs += ' data-annotated';
      return attrs;
    }

    function foldNonPath(node) {
      const cc = node.children.length;
      const tag = node.tagName.toLowerCase();
      if (cc > 0) {
        return `<${tag}${attrsFor(node, false)}>+${cc} children</${tag}>`;
      }
      const t = node.textContent.trim();
      return t ? `<${tag}${attrsFor(node, false)}>${t}</${tag}>` : `<${tag}${attrsFor(node, false)}></${tag}>`;
    }

    function serialize(node, belowTarget, depth) {
      if (node.nodeType === Node.TEXT_NODE) {
        return truncateText(node.textContent);
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const isTarget = node === target;
      const isOnPath = path.includes(node);

      if (belowTarget && depth > MAX_DEPTH_BELOW_TARGET) {
        const dc = node.querySelectorAll('*').length;
        const tag = node.tagName.toLowerCase();
        if (dc > 0) return `<${tag}${attrsFor(node, false)}>+${dc} descendants</${tag}>`;
        const t = node.textContent.trim();
        return t ? `<${tag}${attrsFor(node, false)}>${t}</${tag}>` : `<${tag}${attrsFor(node, false)}></${tag}>`;
      }

      if (!isOnPath && !belowTarget) {
        return foldNonPath(node);
      }

      const tag = node.tagName.toLowerCase();
      const attrs = attrsFor(node, isTarget);
      const children = Array.from(node.childNodes);

      if (isTarget) {
        const inner = children.map(c => serialize(c, true, depth + 1)).filter(s => s).join('');
        return `<${tag}${attrs}>${inner}</${tag}>`;
      }

      if (isOnPath) {
        const pathChildIdx = path.indexOf(node) + 1;
        const pathChild = path[pathChildIdx];
        const childIdx = children.indexOf(pathChild);
        if (childIdx === -1) {
          const inner = children.map(c => serialize(c, belowTarget, depth)).filter(s => s).join('');
          return `<${tag}${attrs}>${inner}</${tag}>`;
        }

        const beforeStart = Math.max(0, childIdx - SIBLING_KEEP_COUNT);
        const afterEnd = Math.min(children.length, childIdx + 1 + SIBLING_KEEP_COUNT);
        const parts = [];
        if (beforeStart > 0) parts.push(`<!-- ${beforeStart} siblings before -->`);
        for (let i = beforeStart; i < childIdx; i++) {
          const s = serialize(children[i], false, 0);
          if (s) parts.push(s);
        }
        const pathSer = serialize(pathChild, false, 0);
        if (pathSer) parts.push(pathSer);
        for (let i = childIdx + 1; i < afterEnd; i++) {
          const s = serialize(children[i], false, 0);
          if (s) parts.push(s);
        }
        const skippedAfter = children.length - afterEnd;
        if (skippedAfter > 0) parts.push(`<!-- ${skippedAfter} siblings after -->`);
        return `<${tag}${attrs}>${parts.join('')}</${tag}>`;
      }

      const inner = children.map(c => serialize(c, true, depth + 1)).filter(s => s).join('');
      return `<${tag}${attrs}>${inner}</${tag}>`;
    }

    return serialize(root, false, 0);
  }

  // --- compressStructure ----------------------------------------------------
  // Depth-limited tree compression. Used when cleaned HTML > 80 KB.
  const STRUCTURE_REMOVE_TAGS = new Set([
    'script', 'style', 'link', 'img', 'video', 'audio', 'canvas', 'svg',
    'noscript', 'template', 'meta', 'path', 'g', 'defs', 'use'
  ]);
  const STRUCTURE_MAX_DEPTH_NORMAL = 4;
  const STRUCTURE_MAX_DEPTH_ANNOTATED = 8;

  function elementContainsAny(node, selectors) {
    if (!selectors || !selectors.length) return false;
    if (node.matches) {
      for (const sel of selectors) {
        try { if (node.matches(sel)) return true; } catch (_) {}
      }
    }
    if (node.querySelector) {
      for (const sel of selectors) {
        try { if (node.querySelector(sel)) return true; } catch (_) {}
      }
    }
    return false;
  }

  function compressNode(node, depth, annotatedSelectors) {
    if (node.nodeType === Node.TEXT_NODE) {
      return truncateText(node.textContent);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (STRUCTURE_REMOVE_TAGS.has(tag)) return '';

    const containsAnnotated = elementContainsAny(node, annotatedSelectors);

    let attrs = '';
    if (node.id) attrs += ` id="${node.id}"`;
    const filtered = filterClasses(node.className || '');
    const cls = filtered.split(' ').filter(c => c).slice(0, 1).join(' ');
    if (cls) attrs += ` class="${cls}"`;
    if (node.placeholder) attrs += ` placeholder="${String(node.placeholder).slice(0, 30)}"`;
    if (containsAnnotated) attrs += ' [ANNOTATED]';

    const childElementCount = node.children.length;
    const maxDepth = containsAnnotated ? STRUCTURE_MAX_DEPTH_ANNOTATED : STRUCTURE_MAX_DEPTH_NORMAL;

    if (depth >= maxDepth) {
      if (childElementCount > 0) {
        return `<${tag}${attrs}>+${childElementCount} children</${tag}>`;
      }
      const t = node.textContent.trim();
      return t ? `<${tag}${attrs}>${truncateText(t)}</${tag}>` : `<${tag}${attrs}></${tag}>`;
    }

    const childParts = [];
    for (const child of node.childNodes) {
      const c = compressNode(child, depth + 1, annotatedSelectors);
      if (c) childParts.push(c);
    }
    const inner = childParts.join('');

    if (containsAnnotated) {
      return `<${tag}${attrs}>${inner}</${tag}>`;
    }
    if (childElementCount > 0) {
      return `<${tag}${attrs}>+${childElementCount} children</${tag}>`;
    }
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  function compressStructure(doc, annotatedSelectors) {
    const selectors = annotatedSelectors || [];
    if (!doc || !doc.body) return '';
    const parts = [];
    for (const child of doc.body.childNodes) {
      const c = compressNode(child, 0, selectors);
      if (c) parts.push(c);
    }
    return parts.join('\n');
  }

  // --- cleanHtmlForLLM ------------------------------------------------------
  const CLEAN_THRESHOLD = 80000;

  function cleanHtmlForLLM(rawHtml, annotations) {
    const cleaned = cleanPageHtml(rawHtml);
    if (cleaned.length <= CLEAN_THRESHOLD) {
      return { mode: 'full', html: cleaned };
    }
    const doc = new DOMParser().parseFromString(cleaned, 'text/html');
    const annotList = annotations || [];
    const selectors = annotList.map(a => a.selector).filter(Boolean);
    const contexts = annotList.map(a => {
      if (!a.selector) return { selector: null, context: null };
      return { selector: a.selector, context: extractAnnotationContext(doc, a.selector) };
    });
    const structure = compressStructure(doc, selectors);
    return { mode: 'compressed', contexts, structure };
  }

  // --- getCompressedSnapshot ------------------------------------------------
  // Walk the live document.documentElement. Returns { structure, textSummary,
  // url, title }. Same-origin iframes are inlined as <iframe data-iframe-prefix="...">
  // with their children inside. Cross-origin iframes are omitted.
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildAttrs(node) {
    const parts = [];
    if (node.id) parts.push(`id="${escapeHtml(node.id)}"`);
    if (node.getAttribute && node.getAttribute('name')) {
      parts.push(`name="${escapeHtml(node.getAttribute('name'))}"`);
    }
    if (node.getAttribute) {
      const classAttr = node.getAttribute('class');
      if (classAttr) {
        const filtered = filterClasses(classAttr);
        const classes = filtered.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
        if (classes) parts.push(`class="${escapeHtml(classes)}"`);
      }
      const placeholder = node.getAttribute('placeholder');
      if (placeholder) parts.push(`placeholder="${escapeHtml(truncateText(placeholder))}"`);
      if (node.getAttribute('type')) parts.push(`type="${escapeHtml(node.getAttribute('type'))}"`);
      if (node.tagName === 'A' && node.getAttribute('href')) {
        parts.push(`href="${escapeHtml(node.getAttribute('href'))}"`);
      }
      if (['SCRIPT', 'IMG', 'IFRAME'].includes(node.tagName) && node.getAttribute('src')) {
        parts.push(`src="${escapeHtml(node.getAttribute('src'))}"`);
      }
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  }

  function getCompressedSnapshot() {
    if (!document || !document.documentElement || !document.body) {
      return {
        structure: '',
        textSummary: '',
        url: (typeof location !== 'undefined' && location && location.href) || '',
        title: (document && document.title) || ''
      };
    }

    const CONTAINER_TAGS = new Set(['div','span','p','section','article','header','footer','nav','aside','main']);

    function walk(node, depth) {
      if (depth > 20) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return escapeHtml(truncateText(node.textContent));
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      if (shouldRemoveTag(tag)) return '';

      if (tag === 'iframe') {
        try {
          const doc = node.contentDocument;
          if (doc && doc.body) {
            const parts = [];
            for (const child of doc.body.childNodes) {
              const compressed = walk(child, depth + 1);
              if (compressed) parts.push(compressed);
            }
            const prefix = buildIframePrefix(node);
            const attrs = buildAttrs(node) + ` data-iframe-prefix="${escapeHtml(prefix)}"`;
            return parts.length ? `<iframe${attrs}>${parts.join('')}</iframe>` : '';
          }
        } catch (_) { /* cross-origin: omit */ }
        return '';
      }

      const attrs = buildAttrs(node);
      const parts = [];
      for (const child of node.childNodes) {
        const compressed = walk(child, depth + 1);
        if (compressed) parts.push(compressed);
      }
      const children = parts.join('');

      if (!children && CONTAINER_TAGS.has(tag)) {
        return `<${tag}${attrs}></${tag}>`;
      }
      return `<${tag}${attrs}>${children}</${tag}>`;
    }

    const structure = walk(document.documentElement, 0);
    const textSummary = (document.body && document.body.textContent ? document.body.textContent.slice(0, 3000) : '');
    return {
      structure,
      textSummary,
      url: (document.location && document.location.href) || (typeof location !== 'undefined' && location && location.href) || '',
      title: document.title || ''
    };
  }

  // --- getElementFullHtml ---------------------------------------------------
  function getElementFullHtml(selector) {
    if (!IframeSelector) {
      return { selector, found: false, error: 'IframeSelector not available' };
    }
    let el;
    try {
      const found = IframeSelector.querySelectorDeep(document, selector);
      el = found ? found.element : null;
    } catch (e) {
      return { selector, found: false, error: 'INVALID_SELECTOR: ' + (e && e.message ? e.message : String(e)) };
    }
    if (!el) return { selector, found: false };
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

  const api = {
    filterClasses, truncateText, shouldRemoveTag, buildIframePrefix,
    cleanPageHtml, extractAnnotationContext, compressStructure, cleanHtmlForLLM,
    getCompressedSnapshot, getElementFullHtml, getElementsFullHtml,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.DomCleaner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
