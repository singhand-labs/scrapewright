// extension/lib/list-pattern.js
//
// Pure analyzer that turns a list of annotations (each with an outputField and
// a CSS selector) into a derived $extractList / $clickInList call template.
// The output is fed to buildAnnotationsText so the LLM sees a generalized
// pattern ABOVE the raw per-annotation lines.

const AUTO_CLASS_RE = /^(x[09a-f]+|_[a-z0-9]+|html-)/i;

// Regex matches a single CSS compound selector segment, supporting:
//   tag, .class, #id, [attr], [attr=val], [attr^=val], :nth-of-type(N), :nth-child(N), ::iframe-prefix
// Splits on descendant combinator ' ' and child combinator ' > '.
const COMPOUND_RE = /(?:iframe[^:]*::)?(?:[.#]?[a-zA-Z][\w-]*(?:\[[^\]]+\]|:[a-zA-Z-]+(?:\([^)]*\))?|\.[\w-]+|# [\w-]+)*)/g;

function splitOnCombinators(sel) {
  // Replace child combinator ' > ' with a placeholder, split on whitespace, restore.
  // This avoids splitting inside [attr="... with spaces ..."].
  const tokens = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && c === ' ') {
      if (current.length) tokens.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.length) tokens.push(current);
  // Strip child combinator '>' tokens (now standalone) and attach semantics — we keep
  // them as explicit markers so the caller can distinguish 'a b' from 'a > b' if needed.
  return tokens.map(t => (t === '>' ? '>' : t.replace(/^>\s*/, '').replace(/\s*>$/, '')));
}

function parseSelectorSegments(selector) {
  if (!selector || typeof selector !== 'string') return [];
  return splitOnCombinators(selector).filter(t => t && t !== '>');
}

function stripPositional(seg) {
  // Remove :nth-of-type(N) and :nth-child(N) from a segment.
  return seg.replace(/:nth-(?:of-type|child)\(\d+\)/g, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse a segment into structured pieces for comparison.
//   { iframePrefix, tag, classes:[], id, attrs:[{name,val,raw}], positionals:[] }
function parseSegment(seg) {
  const out = { iframePrefix: '', tag: '', classes: [], id: '', attrs: [], positionals: [] };
  let rest = seg;
  // iframe prefix is anything before '::' that starts with 'iframe'.
  const dd = rest.indexOf('::');
  if (dd >= 0 && rest.slice(0, dd).startsWith('iframe')) {
    out.iframePrefix = rest.slice(0, dd + 2); // include trailing '::'
    rest = rest.slice(dd + 2);
  }
  const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
  if (tagMatch) {
    out.tag = tagMatch[1];
    rest = rest.slice(tagMatch[1].length);
  }
  const re = /(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])|(:[a-zA-Z-]+(?:\([^)]*\))?)/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (m[1]) out.classes.push(m[1].slice(1));
    else if (m[2]) out.id = m[2].slice(1);
    else if (m[3]) {
      const inner = m[3].slice(1, -1);
      const opMatch = inner.match(/^([\w-]+)\s*([~^$*|]?=)\s*(.*)$/);
      if (opMatch) {
        out.attrs.push({ name: opMatch[1], val: opMatch[3], raw: m[3] });
      } else {
        out.attrs.push({ name: inner, val: null, raw: m[3] });
      }
    } else if (m[4]) {
      out.positionals.push(m[4]);
    }
  }
  return out;
}

function hasIdentifyingFeature(parsed) {
  // After stripping positionals, does the segment have anything that distinguishes
  // an element? Bare tag with no class/id/attr is too generic.
  return Boolean(
    parsed.tag && (parsed.classes.length || parsed.id || parsed.attrs.length)
  );
}

// Compute the longest common prefix across segment arrays.
// Returns [{ seg: <emitted CSS string> }] — positionals stripped, attrs common across all.
function lcpOf(segmentsArrays) {
  if (!segmentsArrays.length) return [];
  const minLen = Math.min(...segmentsArrays.map(a => a.length));
  const prefix = [];
  for (let i = 0; i < minLen; i++) {
    const parsed = segmentsArrays.map(a => parseSegment(a[i]));
    // iframe prefix must match literally across all, else stop.
    const iframe0 = parsed[0].iframePrefix;
    if (!parsed.every(p => p.iframePrefix === iframe0)) break;
    // tag must match across all.
    const tag0 = parsed[0].tag;
    if (!parsed.every(p => p.tag === tag0)) break;
    // classes: keep those present in ALL (treat as set intersection on values).
    const classes0 = parsed[0].classes;
    const commonClasses = classes0.filter(c => parsed.every(p => p.classes.includes(c)));
    // id: keep if all share the same id.
    const id0 = parsed[0].id;
    const commonId = parsed.every(p => p.id === id0) ? id0 : '';
    // attrs: keep those with same name AND value across all.
    const attrs0 = parsed[0].attrs;
    const commonAttrs = attrs0.filter(a0 =>
      parsed.every(p => p.attrs.some(a => a.name === a0.name && a.val === a0.val))
    );

    // Build the emitted segment.
    const emitted = { iframePrefix: iframe0, tag: tag0, classes: commonClasses, id: commonId, attrs: commonAttrs };
    if (!hasIdentifyingFeature(emitted)) break;
    prefix.push({ seg: emitSegment(emitted), _parsed: emitted });
  }
  return prefix;
}

function emitSegment(p) {
  let s = p.iframePrefix + p.tag;
  for (const c of p.classes) s += '.' + c;
  if (p.id) s += '#' + p.id;
  for (const a of p.attrs) {
    if (a.val === null) s += '[' + a.name + ']';
    else s += '[' + a.name + '=' + a.val + ']';
  }
  return s;
}

// Normalize a suffix segment list: strip positionals, drop leading segments
// that were per-item-indexed (had a positional before stripping) and become
// bare tags. A bare tag WITHOUT a positional origin (e.g. 'a', 'span') is a
// legitimate field selector and must be kept.
function normalizeSuffix(segments) {
  const out = [];
  let droppingLeading = true;
  for (const seg of segments) {
    const hadPositional = /:nth-(?:of-type|child)\(\d+\)/.test(seg);
    const stripped = stripPositional(seg);
    const parsed = parseSegment(stripped);
    const isBareTag = parsed.tag && !parsed.classes.length && !parsed.id && !parsed.attrs.length;
    if (droppingLeading && hadPositional && isBareTag) {
      // Drop leading per-item-indexed wrappers (e.g. 'div:nth-of-type(2)' -> 'div').
      continue;
    }
    droppingLeading = false;
    out.push(stripped);
  }
  return out;
}

function deriveListPattern(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  const result = { patterns: [], clickInList: [], annotationCount: list.length };

  // Step 1: group by outputField dotted prefix
  const groups = new Map();
  for (const a of list) {
    const of = a.outputField || '';
    const dot = of.indexOf('.');
    if (dot <= 0) continue; // _flat, skip
    const arr = of.slice(0, dot);
    if (!groups.has(arr)) groups.set(arr, []);
    groups.get(arr).push(a);
  }

  // Step 2-6 per group
  for (const [arr, annos] of groups) {
    // Only proceed if we have at least one extract annotation with a selector
    const withSel = annos.filter(a => a.selector && (a.type === 'extract' || a.outputField));
    if (!withSel.length) continue;

    const segArrays = withSel.map(a => parseSelectorSegments(a.selector));
    let prefix = lcpOf(segArrays);
    // Cap LCP at minLen - 1 so suffix is non-empty.
    const minLen = Math.min(...segArrays.map(a => a.length));
    if (prefix.length >= minLen) prefix = prefix.slice(0, Math.max(0, minLen - 1));
    if (!prefix.length) continue; // no common ancestor
    if (prefix.length > 8) continue; // too deep — likely wrong, emit nothing

    const containerStr = prefix.map(p => p.seg).join(' ');
    const prefixLen = prefix.length;

    // Derive fieldMap: for each annotation, compute suffix (segments after LCP),
    // then group by outputField sub-name.
    const fieldMap = {};
    for (const a of withSel) {
      const sub = (a.outputField.split('.')[1] || '').trim();
      if (!sub) continue;
      const segs = parseSelectorSegments(a.selector);
      const suffix = normalizeSuffix(segs.slice(prefixLen));
      if (!suffix.length) continue;
      const suffixStr = suffix.join(' ');
      if (!(sub in fieldMap)) {
        fieldMap[sub] = suffixStr;
      } else if (fieldMap[sub] !== suffixStr) {
        // Conflict — keep first-seen; rare in practice.
      }
    }

    if (Object.keys(fieldMap).length) {
      result.patterns.push({ container: containerStr, fieldMap, outputArray: arr });
    }

    // Classify expand clicks within this group
    const expandClicks = annos.filter(a => a.type === 'click' && a.purpose === 'expand' && a.selector);
    if (expandClicks.length) {
      // Compute suffix of the FIRST expand click (assume same shape across items)
      const firstSegs = parseSelectorSegments(expandClicks[0].selector);
      const suffix = normalizeSuffix(firstSegs.slice(prefixLen)).join(' ');
      if (suffix) {
        result.clickInList.push({
          container: containerStr,
          subSelector: suffix,
          delayMs: 500,
          intent: 'expand each item before extracting content',
        });
      }
    }
  }

  return result;
}

module.exports = { parseSelectorSegments, deriveListPattern };
