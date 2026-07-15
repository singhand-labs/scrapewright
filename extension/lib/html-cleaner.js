// Node-testable HTML cleaning utilities for annotation-based script generation.
// Production usage: content-script.js and wizard.js load this via script tags OR
// inline equivalent code. Keep both in sync (same pattern as dom-snapshot.js).

const NOISE_SELECTORS = 'nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [class*="sidebar"], [class*="side-bar"], [class*="Sidebar"], [class*="toast"], [class*="modal-backdrop"], [class*="overlay"], [class*="cookie"], [class*="banner"], [class*="popup"], [class*="tooltip"], [class*="dropdown-menu"]';

const REMOVE_TAGS = 'script, style, link[rel="stylesheet"], link[rel="preload"], link[rel="icon"], video, audio, canvas, svg, noscript, template, meta, path, g, defs, use';

const HIDDEN_SELECTORS = '[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"]';

function cleanPageHtml(htmlString) {
  if (!htmlString) return '';
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');
  const root = doc.documentElement;

  root.querySelectorAll(REMOVE_TAGS).forEach(el => el.remove());
  root.querySelectorAll(HIDDEN_SELECTORS).forEach(el => el.remove());
  root.querySelectorAll(NOISE_SELECTORS).forEach(el => el.remove());

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach(c => c.remove());

  root.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('on') || attr.name === 'style') {
        el.removeAttribute(attr.name);
      }
    });
    Array.from(el.attributes).forEach(attr => {
      if (attr.value.length > 200) {
        el.setAttribute(attr.name, attr.value.slice(0, 200) + '...');
      }
    });
  });

  let result = root.outerHTML;
  result = result.replace(/\n\s*\n/g, '\n').replace(/>\s+</g, '><');
  return result;
}

const ANNOTATION_CONTEXT_RADIUS = 3;
const MAX_DEPTH_BELOW_TARGET = 2;
const SIBLING_KEEP_COUNT = 2;

function extractAnnotationContext(doc, selector, ancestorRadius) {  const radius = ancestorRadius === undefined ? ANNOTATION_CONTEXT_RADIUS : ancestorRadius;
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
    const cls = (node.className || '').split(' ').filter(c => c).slice(0, 2).join(' ');
    if (cls) attrs += ` class="${cls}"`;
    if (markAnnotated) attrs += ' data-annotated';
    return attrs;
  }

  function foldNonPath(node) {
    const cc = node.children.length;
    if (cc > 0) {
      return `<${node.tagName.toLowerCase()}${attrsFor(node, false)}>+${cc} children</${node.tagName.toLowerCase()}>`;
    }
    const t = node.textContent.trim();
    const tag = node.tagName.toLowerCase();
    return t ? `<${tag}${attrsFor(node, false)}>${t}</${tag}>` : `<${tag}${attrsFor(node, false)}></${tag}>`;
  }

  function serialize(node, belowTarget, depth) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (!t) return '';
      return t.length > 60 ? t.slice(0, 60) + '...' : t;
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

    // belowTarget but within depth limit
    const inner = children.map(c => serialize(c, true, depth + 1)).filter(s => s).join('');
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  return serialize(root, false, 0);
}

const STRUCTURE_REMOVE_TAGS = new Set([
  'script', 'style', 'link', 'img', 'video', 'audio', 'canvas', 'svg', 'noscript', 'template', 'meta', 'path', 'g', 'defs', 'use'
]);

const STRUCTURE_MAX_DEPTH_NORMAL = 4;
const STRUCTURE_MAX_DEPTH_ANNOTATED = 8;

function elementContainsAny(node, selectors) {
  if (!selectors || !selectors.length) return false;
  if (node.matches) {
    for (const sel of selectors) {
      try {
        if (node.matches(sel)) return true;
      } catch (e) { /* invalid selector */ }
    }
  }
  if (node.querySelector) {
    for (const sel of selectors) {
      try {
        if (node.querySelector(sel)) return true;
      } catch (e) { /* invalid selector */ }
    }
  }
  return false;
}

function compressNode(node, depth, annotatedSelectors) {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent.trim();
    if (!t) return '';
    if (/^\d+[\d,.]*$/.test(t) || t.length <= 20) return t;
    return t.slice(0, 20) + '...';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();
  if (STRUCTURE_REMOVE_TAGS.has(tag)) return '';

  const containsAnnotated = elementContainsAny(node, annotatedSelectors);

  let attrs = '';
  if (node.id) attrs += ` id="${node.id}"`;
  const cls = (node.className || '').split(' ').filter(c => c).slice(0, 1).join(' ');
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
    return t ? `<${tag}${attrs}>${t.slice(0, 40)}</${tag}>` : `<${tag}${attrs}></${tag}>`;
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
    return {
      selector: a.selector,
      context: extractAnnotationContext(doc, a.selector)
    };
  });

  const structure = compressStructure(doc, selectors);

  return { mode: 'compressed', contexts, structure };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cleanPageHtml, extractAnnotationContext, compressStructure, cleanHtmlForLLM };
} else if (typeof window !== 'undefined') {
  window.cleanPageHtml = cleanPageHtml;
  window.extractAnnotationContext = extractAnnotationContext;
  window.compressStructure = compressStructure;
  window.cleanHtmlForLLM = cleanHtmlForLLM;
}
