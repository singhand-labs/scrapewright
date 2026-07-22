// extension/lib/list-pattern.js
//
// Pure analyzer that turns a list of annotations (each with an outputField and
// a CSS selector) into a derived $extractList / $clickInList call template.
// The output is fed to buildAnnotationsText so the LLM sees a generalized
// pattern ABOVE the raw per-annotation lines.

// Split a selector into segments on descendant/child combinators, preserving
// whether each join was a child combinator ('>') so emit can rebuild it.
// Bracket-aware so attribute values with spaces aren't split.
function splitOnCombinators(sel) {
  const tokens = [];
  let depth = 0;
  let current = '';
  let pendingChild = false; // a '>' that joins the previous -> next segment
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && c === ' ') {
      if (current.length) {
        tokens.push({ seg: current, childCombinator: pendingChild });
        current = '';
        pendingChild = false;
      }
    } else if (depth === 0 && c === '>') {
      // Standalone child combinator — marks the NEXT segment.
      if (current.length) {
        tokens.push({ seg: current, childCombinator: pendingChild });
        current = '';
      }
      pendingChild = true;
    } else {
      current += c;
    }
  }
  if (current.length) tokens.push({ seg: current, childCombinator: pendingChild });
  return tokens;
}

// Public: return plain-string segments (API contract — tests rely on this).
function parseSelectorSegments(selector) {
  if (!selector || typeof selector !== 'string') return [];
  return splitOnCombinators(selector).filter(t => t.seg).map(t => t.seg);
}

// Internal: return [{ seg, childCombinator }] so joinSegments can rebuild '>' .
function parseSegmentsRich(selector) {
  if (!selector || typeof selector !== 'string') return [];
  return splitOnCombinators(selector).filter(t => t.seg);
}

function stripPositional(seg) {
  return seg.replace(/:nth-(?:of-type|child)\(\d+\)/g, '');
}

// Heuristic for auto-generated class names (Facebook x-prefixed, CSS-modules
// underscore/html-prefixed). Treated as non-identifying for conflict detection
// because they vary across page builds.
// Facebook class hashes are base36 (lowercase letters + digits), not hex —
// real examples include xjp7ctv, xjbqb8w, xpdmqnj, xyri2b. Match `x` followed
// by 4+ alphanumeric chars so the base36 hashes are stripped correctly.
const AUTO_CLASS_RE = /^(x[0-9a-z]{4,}|_[a-z0-9]+|html-)/i;

// Stable signature for conflict detection: segment with positionals stripped
// AND auto-generated classes removed. Two suffixes that differ only in
// positional/auto classes are compatible; any other difference (tag, role,
// aria-label, non-auto class) is a real conflict per spec rule 4.
function stableSignature(seg) {
  let s = stripPositional(seg);
  s = s.replace(/\.([a-zA-Z0-9_-]+)/g, (full, name) =>
    AUTO_CLASS_RE.test(name) ? '' : full
  );
  return s;
}

// Spec-literal LCP: strip positionals in-place, walk segment-by-segment,
// stop at first divergence, cap at minLen - 1 so the suffix is non-empty.
function lcpOf(arrays) {
  if (!arrays.length) return [];
  const minLen = Math.min(...arrays.map(a => a.length));
  if (minLen === 0) return [];
  const maxLen = Math.max(0, minLen - 1);
  const prefix = [];
  for (let i = 0; i < maxLen; i++) {
    const stripped = arrays.map(a => stripPositional(a[i].seg));
    if (stripped.every(s => s === stripped[0])) {
      prefix.push({
        seg: stripped[0],
        childCombinator: arrays.every(a => a[i].childCombinator),
      });
    } else {
      break;
    }
  }
  return prefix;
}

function joinSegments(segs) {
  if (!segs.length) return '';
  let out = segs[0].seg;
  for (let i = 1; i < segs.length; i++) {
    out += segs[i].childCombinator ? ' > ' : ' ';
    out += segs[i].seg;
  }
  return out;
}

// Strip positionals from a suffix segment list, preserving combinator flags.
// Returns [{ seg, childCombinator }] ready for joinSegments.
function stripSuffixPositionals(segs) {
  return segs.map(s => ({ seg: stripPositional(s.seg), childCombinator: s.childCombinator }));
}

function deriveListPattern(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  const result = { patterns: [], clickInList: [], annotationCount: list.length };

  // Step 1: group extract annotations by outputField dotted prefix.
  const groups = new Map();
  for (const a of list) {
    const of = a.outputField || '';
    const dot = of.indexOf('.');
    if (dot <= 0) continue; // flat field — skip
    const arr = of.slice(0, dot);
    if (!groups.has(arr)) groups.set(arr, []);
    groups.get(arr).push(a);
  }

  // Steps 2-6 per group.
  for (const [arr, annos] of groups) {
    const withSel = annos.filter(a => a.selector && (a.type === 'extract' || a.outputField));
    if (!withSel.length) continue;

    const segArrays = withSel.map(a => parseSegmentsRich(a.selector));
    const prefix = lcpOf(segArrays);
    if (!prefix.length) continue; // no common ancestor
    if (prefix.length > 8) continue; // too deep — likely wrong, emit nothing

    const containerStr = joinSegments(prefix);
    const prefixLen = prefix.length;

    // Derive fieldMap. Per spec rule 4: if two annotations for the same
    // sub-name have suffixes that differ in STABLE segments, drop the field.
    // Auto-generated classes (Facebook x-hashes, CSS-modules) are stripped
    // from BOTH the conflict signature and the emitted suffix, since they are
    // unstable across page loads and must not appear in the generated
    // $extractList template.
    const fieldMap = {};
    for (const a of withSel) {
      const sub = a.outputField.slice(a.outputField.indexOf('.') + 1).trim();
      if (!sub) continue;
      const segs = parseSegmentsRich(a.selector);
      const suffix = stripSuffixPositionals(segs.slice(prefixLen));
      if (!suffix.length) continue;
      const stableSuffix = suffix.map(s => ({
        seg: stableSignature(s.seg),
        childCombinator: s.childCombinator,
      }));
      const suffixStr = joinSegments(stableSuffix);
      const sig = stableSuffix.map(s => s.seg).join(' ');
      if (!(sub in fieldMap)) {
        fieldMap[sub] = { suffix: suffixStr, sig };
      } else if (fieldMap[sub] !== null) {
        if (fieldMap[sub].sig !== sig) {
          delete fieldMap[sub]; // conflict — drop per spec rule 4
          fieldMap[sub] = null; // tombstone so subsequent encounters also drop
        }
      }
    }

    // Drop tombstones; only emit if at least one field survived.
    const cleanFieldMap = {};
    for (const [k, v] of Object.entries(fieldMap)) {
      if (v) cleanFieldMap[k] = v.suffix;
    }
    if (Object.keys(cleanFieldMap).length) {
      result.patterns.push({ container: containerStr, fieldMap: cleanFieldMap, outputArray: arr });
    }
  }

  // Step 7: classify expand clicks by matching their selector against a derived
  // container (positional-stripped prefix match). Multiple click annotations on
  // different items (e.g. nth-of-type(1) and nth-of-type(2)) of the SAME button
  // collapse into ONE $clickInList template — that's the whole point of deriving
  // a generalized pattern. Dedup by container|subSelector so buildAnnotationsText
  // emits a single call instead of N copies.
  const expandClicks = list.filter(a => a.type === 'click' && a.purpose === 'expand' && a.selector);
  const seenClick = new Set();
  for (const click of expandClicks) {
    const clickSegs = parseSegmentsRich(click.selector);
    let matched = null;
    let prefixLen = 0;
    for (const p of result.patterns) {
      const containerSegs = parseSegmentsRich(p.container);
      if (containerSegs.length > clickSegs.length) continue;
      let isPrefix = true;
      for (let i = 0; i < containerSegs.length; i++) {
        const a = stripPositional(containerSegs[i].seg);
        const b = stripPositional(clickSegs[i].seg);
        if (a !== b) { isPrefix = false; break; }
      }
      if (isPrefix) { matched = p; prefixLen = containerSegs.length; break; }
    }
    if (matched) {
      const suffix = stripSuffixPositionals(clickSegs.slice(prefixLen));
      const suffixStr = joinSegments(suffix);
      if (suffixStr) {
        const dedupKey = matched.container + '|' + suffixStr;
        if (seenClick.has(dedupKey)) continue;
        seenClick.add(dedupKey);
        result.clickInList.push({
          container: matched.container,
          subSelector: suffixStr,
          delayMs: 500,
          intent: 'expand each item before extracting content',
        });
      }
    }
  }

  return result;
}

const api = { parseSelectorSegments, deriveListPattern };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ListPattern = api;
if (typeof self !== 'undefined') self.ListPattern = api;
// In Node, top-level function declarations are module-scoped, not global.
// wizard-utils.js references deriveListPattern as a free variable (browser
// globals pattern), so expose it on `global` for parity. The typeof guard in
// buildAnnotationsText handles the legacy/non-loaded case where this never ran.
if (typeof global !== 'undefined') {
  global.deriveListPattern = deriveListPattern;
  global.parseSelectorSegments = parseSelectorSegments;
  global.ListPattern = api;
}
