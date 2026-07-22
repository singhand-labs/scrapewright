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

function generateSelector(el, ownerDoc) {
  if (!el || !el.tagName) return 'body';

  const doc = ownerDoc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return 'body';

  const ownerBody = doc.body || doc.documentElement;
  if (!ownerBody) return el.tagName.toLowerCase();

  const path = [];
  let current = el;
  let uniqueFound = false;

  while (current && current !== ownerBody && current.tagName) {
    const segment = buildSegment(current);
    if (!segment) break;
    path.unshift(segment);

    // Early-stop: partial path now matches at most one element.
    const partial = path.join(' > ');
    let matches = null;
    try {
      matches = doc.querySelectorAll(partial);
    } catch (e) {
      // Invalid selector — should not happen given our construction,
      // but never throw. Bail with what we have.
      break;
    }
    if (matches.length <= 1) {
      uniqueFound = true;
      break;
    }

    current = current.parentNode;
  }

  // If we walked to body without uniqueness, the clicked element has siblings
  // sharing the same stable attrs (e.g. 10 <div role="article"> siblings).
  // Append :nth-of-type(N) to the LEAF segment to disambiguate.
  // Leaf is the LAST segment in path (the clicked element itself), not the
  // topmost — the topmost is shared by all siblings.
  if (!uniqueFound && path.length > 0) {
    const leaf = el;
    const parent = leaf.parentNode;
    if (parent) {
      const siblings = Array.from(parent.children || []);
      const sameTag = siblings.filter(s => s.tagName === leaf.tagName);
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(leaf) + 1;
        const lastIdx = path.length - 1;
        path[lastIdx] = path[lastIdx] + `:nth-of-type(${idx})`;
      }
    }
  }

  return path.length > 0 ? path.join(' > ') : el.tagName.toLowerCase();
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
