// extension/lib/field-candidate-discovery.js
//
// Framework-side field candidate discovery. When autoFix detects fields that
// are 100% empty across all extracted records (and no annotations exist),
// this module scans the normalized record HTML and surfaces up to K candidate
// leaf elements per empty field. The LLM picks from candidates instead of
// guessing from training data.
//
// IIFE-wrapped (RC30 pattern): classic <script> tags share a global lexical
// scope, so a top-level `const api` here would collide with the same
// declaration in list-pattern.js / annotation-cluster.js /
// record-shape-distribution.js. The IIFE gives this module its own lexical
// scope; the api object is exposed via window.X / module.exports / global.X.
//
// Export convention (mirrors lib/record-shape-distribution.js): functions
// called from wizard.js as bare names are also exposed directly on global
// (e.g. `global.discoverFieldCandidates = ...`). Functions used only by
// tests remain on the api namespace.

(function (global) {
  'use strict';

  // --- inferFieldType -----------------------------------------------------
  // Map a schema field name to one of 5 generic types. The mapping drives
  // candidate matching in findFieldCandidates. Nested paths use the LAST
  // segment (so 'account.profileUrl' classifies by 'profileUrl').
  //
  // Patterns are deliberately permissive: false positives are fine (text-like
  // fallback catches misses), false negatives cost more (a time-like field
  // misclassified as text-like loses time-specific DOM cues).

  const TIME_NAME_RE = /time$|date$|created|published|updated/i;
  const COUNT_NAME_RE = /count$|likes$|shares$|comments$|reactions$|views$|downloads$/i;
  const URL_NAME_RE = /url$|link$|href$|profile$/i;
  const ID_NAME_RE = /id$/i;

  function inferFieldType(fieldName) {
    if (!fieldName || typeof fieldName !== 'string') return 'text-like';
    // Use last segment of dotted path.
    const lastSegment = fieldName.split('.').pop() || fieldName;
    // Order matters: time/count/url are more specific than id.
    if (TIME_NAME_RE.test(lastSegment)) return 'time-like';
    if (COUNT_NAME_RE.test(lastSegment)) return 'count-like';
    if (URL_NAME_RE.test(lastSegment)) return 'url-like';
    if (ID_NAME_RE.test(lastSegment)) return 'id-like';
    return 'text-like';
  }

  // --- findFieldCandidates -----------------------------------------------
  // Scan `recordHtml` for leaf elements matching `fieldType`. Returns up to
  // options.maxCandidates results sorted by strength desc, then DOM order.
  //
  // Leaf = element with no element children (text-only or empty). Each leaf
  // gets a per-type strength score; weak/medium/strong. Filtered out if no
  // strength matches the type.

  const TIME_TEXT_RE = /\d+\s*(s|min|hour|hr|day|week|month|year)s?(\s*ago)?|yesterday|today|just now/i;
  const TIME_DATE_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}|^\d{4}-\d{2}-\d{2}/;
  const TIME_ATTRS = new Set(['datetime', 'data-absolute-time', 'data-utc', 'data-timestamp', 'data-shorten']);

  const COUNT_TEXT_RE = /^\d+([.,]\d+)?[KkMm]?$/;
  const COUNT_PLAIN_RE = /^\d+$/;
  // RC59 (console.log 2026-08-18): CJK labels added — the incident site
  // exposes engagement counts ONLY via Chinese aria-labels (93 则评论 /
  // 8 人赞), and the English-only pattern classified zero count-like
  // leaves, so count-field discovery never fired.
  const COUNT_LABEL_WORDS = 'comment|like|share|reaction|view|download' +
    '|评论|留言|赞|分享|转发|查看|浏览|下载|收藏';
  const COUNT_LABEL_RE = new RegExp(
    '(' + COUNT_LABEL_WORDS + ')s?[^0-9]*\\d|\\d[^0-9]*(' + COUNT_LABEL_WORDS + ')', 'i');

  const ID_NUMERIC_RE = /^\d{5,}$/;
  const ID_HASH_RE = /^[a-z0-9]{10,}$/i;

  const DEFAULT_MAX_CANDIDATES = 5;
  const DEFAULT_MAX_LEAVES = 50;

  function buildLeafSelector(el, doc) {
    // Build a minimal CSS selector for this leaf. Strategy: tag + first useful
    // attribute (id > class > data-*). Falls back to nth-of-type path.
    const tag = el.tagName.toLowerCase();
    if (el.id) return '#' + CSSescape(el.id);
    const cls = el.getAttribute('class');
    if (cls) {
      const first = cls.split(/\s+/)[0];
      if (first) return tag + '.' + first;
    }
    // Look for a data-* attribute.
    for (const attr of Array.from(el.attributes)) {
      if (/^data-/i.test(attr.name)) {
        return tag + '[' + attr.name + ']';
      }
    }
    // Fall back to nth-of-type path (3 levels max).
    const parts = [];
    let cur = el;
    for (let i = 0; i < 3 && cur && cur.nodeType === Node.ELEMENT_NODE && cur !== doc.body; i++) {
      const t = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(t); break; }
      const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      const idx = siblings.indexOf(cur) + 1;
      parts.unshift(t + ':nth-of-type(' + idx + ')');
      cur = parent;
    }
    return parts.join(' > ');
  }

  function CSSescape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function scoreLeaf(el, fieldType) {
    const text = (el.textContent || '').trim();
    const tag = el.tagName.toLowerCase();
    // Keys match fieldType names exactly so strength[fieldType] lookup works.
    const strength = { 'time-like': null, 'count-like': null, 'url-like': null, 'id-like': null, 'text-like': null };

    // time-like
    const hasTimeAttr = Array.from(el.attributes).some(a => TIME_ATTRS.has(a.name.toLowerCase()));
    if (tag === 'time' || tag === 'abbr' || hasTimeAttr || TIME_TEXT_RE.test(text)) {
      strength['time-like'] = 'strong';
    } else if (TIME_DATE_RE.test(text) || hasAriaLabelMatching(el, TIME_TEXT_RE)) {
      strength['time-like'] = 'medium';
    }

    // count-like
    if (COUNT_TEXT_RE.test(text)) {
      strength['count-like'] = 'strong';
    } else if (COUNT_PLAIN_RE.test(text) && (tag === 'span' || tag === 'div')) {
      strength['count-like'] = 'medium';
    } else if (hasAriaLabelMatching(el, COUNT_LABEL_RE)) {
      strength['count-like'] = 'medium';
    }

    // url-like
    const href = el.getAttribute('href');
    if (tag === 'a' && href && href !== '#') {
      strength['url-like'] = 'strong';
    } else if (tag === 'a' && (href === '#' || !href) && el.getAttribute('role') === 'link') {
      strength['url-like'] = 'medium';
    } else if (tag === 'img' && el.getAttribute('src')) {
      strength['url-like'] = 'strong';
    } else if (el.getAttribute('data-href') || el.getAttribute('data-uri')) {
      strength['url-like'] = 'medium';
    }

    // id-like
    if (ID_NUMERIC_RE.test(text) || ID_HASH_RE.test(text)) {
      strength['id-like'] = 'strong';
    } else if (el.getAttribute('data-id') || el.getAttribute('data-key') || el.getAttribute('data-entity-id')) {
      strength['id-like'] = 'medium';
    }

    // text-like (always medium for non-empty, weak for empty-but-attributed)
    if (text) {
      strength['text-like'] = 'medium';
    } else if (el.getAttribute('placeholder') || el.getAttribute('aria-label')) {
      strength['text-like'] = 'weak';
    }

    return strength[fieldType];
  }

  function hasAriaLabelMatching(el, regex) {
    const al = el.getAttribute('aria-label');
    return !!al && regex.test(al);
  }

  function collectLeaves(root, doc) {
    const leaves = [];
    const walk = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const elementChildren = Array.from(node.children);
      if (elementChildren.length === 0) {
        leaves.push(node);
        return;
      }
      for (const c of elementChildren) walk(c);
    };
    walk(root);
    return leaves;
  }

  function findFieldCandidates(recordHtml, fieldType, options) {
    const opts = options || {};
    const maxCandidates = typeof opts.maxCandidates === 'number' ? opts.maxCandidates : DEFAULT_MAX_CANDIDATES;
    if (!recordHtml) return [];
    let doc;
    try {
      doc = new DOMParser().parseFromString('<html><body>' + String(recordHtml) + '</body></html>', 'text/html');
    } catch (_) {
      return [];
    }
    if (!doc || !doc.body) return [];

    const leaves = collectLeaves(doc.body, doc);
    const STRENGTH_ORDER = { strong: 0, medium: 1, weak: 2 };
    const scored = [];
    let domOrder = 0;
    for (const leaf of leaves) {
      const strength = scoreLeaf(leaf, fieldType);
      if (!strength) continue;
      scored.push({
        selector: buildLeafSelector(leaf, doc),
        text: (leaf.textContent || '').trim().slice(0, 40),
        tag: leaf.tagName.toLowerCase(),
        strength,
        _domOrder: domOrder++,
      });
    }
    scored.sort((a, b) => {
      const s = STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength];
      if (s !== 0) return s;
      return a._domOrder - b._domOrder;
    });
    return scored.slice(0, maxCandidates).map(({ _domOrder, ...rest }) => rest);
  }

  // --- discoverFieldCandidates -------------------------------------------
  // Top-level: for each empty field name, infer type and find candidates.
  // Returns { fields: [...], skipped?: string }.
  // Each field: { fieldName, fieldType, candidates, nameMismatch?, fallbackReason? }

  function discoverFieldCandidates(recordHtml, emptyFields, options) {
    const opts = options || {};
    const maxCandidatesPerField = typeof opts.maxCandidatesPerField === 'number'
      ? opts.maxCandidatesPerField : DEFAULT_MAX_CANDIDATES;
    const maxLeavesToScan = typeof opts.maxLeavesToScan === 'number'
      ? opts.maxLeavesToScan : DEFAULT_MAX_LEAVES;

    if (!recordHtml) return { fields: [], skipped: 'no_html' };

    // Count leaves once; skip if too many.
    let doc;
    try {
      doc = new DOMParser().parseFromString('<html><body>' + String(recordHtml) + '</body></html>', 'text/html');
    } catch (_) {
      return { fields: [], skipped: 'parse_error' };
    }
    if (!doc || !doc.body) return { fields: [], skipped: 'no_body' };
    const leaves = collectLeaves(doc.body, doc);
    if (leaves.length > maxLeavesToScan) {
      return { fields: [], skipped: 'too_many_leaves' };
    }

    const fieldsOut = [];
    const fieldList = Array.isArray(emptyFields) ? emptyFields : [];
    for (const fieldName of fieldList) {
      const inferred = inferFieldType(fieldName);
      // Track nameMismatch: text-like as a result of falling through (not
      // matching any explicit pattern). Distinguish from a hypothetical
      // future 'text-like' pattern.
      const lastSegment = (fieldName || '').split('.').pop() || fieldName;
      const matchedExplicit = TIME_NAME_RE.test(lastSegment)
        || COUNT_NAME_RE.test(lastSegment)
        || URL_NAME_RE.test(lastSegment)
        || ID_NAME_RE.test(lastSegment);
      const nameMismatch = !matchedExplicit;

      const candidates = findFieldCandidates(recordHtml, inferred, { maxCandidates: maxCandidatesPerField });
      const entry = { fieldName, fieldType: inferred, candidates };
      if (nameMismatch) entry.nameMismatch = true;
      if (candidates.length === 0) entry.fallbackReason = 'no_match';
      fieldsOut.push(entry);
    }
    return { fields: fieldsOut };
  }

  // --- formatFieldCandidatesBlock ----------------------------------------
  // Render a discovery result as the FIELD CANDIDATES block for the autoFix
  // prompt. Empty string when nothing to show (no fields, skipped, etc.).
  //
  // Universality: no site-specific terms. Only generic type names and
  // selectors extracted from the user's actual record HTML appear.

  function pad(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }

  function formatFieldCandidatesBlock(result) {
    if (!result || !Array.isArray(result.fields) || result.fields.length === 0) return '';
    const lines = ['FIELD CANDIDATES (chronic-empty fields — pick a selector or write your own)'];
    for (const f of result.fields) {
      const candCount = f.candidates.length;
      const namePart = f.nameMismatch ? ' — NAME DOES NOT MATCH A TYPE PATTERN, rename to /Time$|Date$|Count$|Url$|Id$/ to opt into a tighter type, or keep text-like fallback' : '';
      const fallbackPart = f.fallbackReason === 'no_match'
        ? ', 0 candidates — RELAX SELECTOR OR ANNOTATE THIS FIELD'
        : '';
      lines.push('  Field: ' + f.fieldName + ' (inferred type: ' + f.fieldType + ', ' + candCount + ' candidate' + (candCount === 1 ? '' : 's') + namePart + fallbackPart + ')');
      for (let i = 0; i < f.candidates.length; i++) {
        const c = f.candidates[i];
        const idx = '[' + (i + 1) + ']';
        const sel = pad(c.selector, 42);
        const text = '"' + (c.text || '').slice(0, 40) + '"';
        const tag = pad(c.tag, 8);
        lines.push('    ' + pad(idx, 4) + sel + ' text: ' + pad(text, 24) + ' tag: ' + tag + ' strength: ' + c.strength);
      }
    }
    return lines.join('\n');
  }

  const api = {
    inferFieldType,
    findFieldCandidates,
    discoverFieldCandidates,
    formatFieldCandidatesBlock,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FieldCandidateDiscovery = api;
  if (typeof self !== 'undefined') self.FieldCandidateDiscovery = api;
  if (typeof global !== 'undefined') {
    global.FieldCandidateDiscovery = api;
    global.inferFieldType = inferFieldType;
    global.findFieldCandidates = findFieldCandidates;
    global.discoverFieldCandidates = discoverFieldCandidates;
    global.formatFieldCandidatesBlock = formatFieldCandidatesBlock;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
