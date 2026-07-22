// Selector generator — produces stable, generalizable CSS selectors for
// annotated elements. Prefers stable attributes ([role], [aria-*], [data-*],
// id, semantic class names) over positional :nth-of-type() which only matches
// the exact clicked element and does not generalize to sibling list items.
//
// Three-environment export (Node tests, content-script window, service worker):
//   - module.exports (Node)
//   - window.SelectorGenerator (content-script context)
//   - self.SelectorGenerator (service worker / offscreen context)

const STABLE_ATTRS = [
  'role',
  'aria-label',
  'aria-posinset',
  'aria-describedby',
  'aria-labelledby',
  'data-testid',
  'data-ad-rendering-role',
  'data-sigil',
  'name',
  'type',
];

// Auto-generated className patterns from React/Facebook/CSS-in-JS libs.
// These hashes change between page loads and must NOT be encoded into
// annotation selectors. Matched case-insensitively.
//   x9f619, x1n2onr6  → React Facebook hash (x + hex)
//   _a58j              → Facebook legacy (_ + alnum)
//   html-h3            → FB internal semantic prefix (unstable across releases)
const AUTO_CLASS_RE = /^(x[0-9a-f]+|_[a-z0-9]+|html-)/i;

function escapeAttrValue(v) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
    return CSS.escape(v);
  }
  // Fallback for very old environments (MV3 requires Chrome 88+ which has
  // CSS.escape, so this branch is defensive only).
  return String(v).replace(/["\\]/g, '\\$&');
}

function buildSegment(el) {
  if (!el || !el.tagName) return '';

  // id wins outright — unique by spec.
  if (el.id) {
    return '#' + escapeAttrValue(el.id);
  }

  const tag = el.tagName.toLowerCase();
  const parts = [tag];

  for (const attr of STABLE_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) {
      parts.push(`[${attr}="${escapeAttrValue(v)}"]`);
    }
  }

  // Semantic (non-auto-generated) className — keep up to 3.
  const classList = el.classList
    ? Array.from(el.classList)
    : String(el.className || '').split(/\s+/).filter(Boolean);
  const semantic = classList.filter(c => c && !AUTO_CLASS_RE.test(c));
  if (semantic.length > 0) {
    parts.push('.' + semantic.slice(0, 3).map(escapeAttrValue).join('.'));
  }

  return parts.join('');
}

// Placeholder — implemented in Task 2.
function generateSelector(el, ownerDoc) {
  return 'body';
}

const api = { generateSelector, buildSegment, STABLE_ATTRS, AUTO_CLASS_RE };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.SelectorGenerator = api;
}
if (typeof self !== 'undefined') {
  self.SelectorGenerator = api;
}
