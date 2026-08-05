// extension/lib/annotation-cluster.js
//
// Cluster flat annotations by DOM container proximity. Called by
// buildAnnotationsText in wizard-utils.js to surface multi-sample structure
// to the LLM. Pure module — no DOM access, no IO.
//
// Algorithm: STRUCTURAL BRANCHING ANALYSIS + TAG SEMANTIC CONFIRMATION.
// No site-specific DOM patterns. See doc comment on clusterAnnotationsByContainer
// for the two-stage algorithm.

// Parse a domPath like "div > div[x='1'] > span" into ["div", "div[x='1']", "span"].
// Bracket-aware: spaces inside [attr='value'] are not split. Returns [] for
// non-string input so callers can pass annotation.domPath without type guards.
function parseDomPathSegments(domPath) {
  if (!domPath || typeof domPath !== 'string') return [];
  const tokens = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < domPath.length; i++) {
    const c = domPath[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && c === '>') {
      if (current.trim()) tokens.push(current.trim());
      current = '';
      // skip the space after '>'
      if (domPath[i + 1] === ' ') i++;
    } else {
      current += c;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

// Normalize a domPath segment for branching comparison: strip positional
// VALUES so annotations on list-item instances 3 vs 7 collapse to the same
// normalized form. The RAW segment (with positionals preserved) is still
// used as the group key so different instances produce different samples.
function normalizeSegment(seg) {
  if (!seg) return '';
  let s = seg;
  // [attr="..."] / [attr='...'] / [attr=bare] → [attr]
  s = s.replace(/\[([a-zA-Z-]+)=(?:"[^"]*"|'[^']*'|[^\]]+)\]/g, '[$1]');
  // #id-with-digits → [id] marker (numeric suffix is positional)
  s = s.replace(/#[a-zA-Z_-]*\d[\w-]*/g, '[id]');
  // .class-digits / .classDigits → prefix marker (item-3 → item-, card7 → card)
  s = s.replace(/\.([a-zA-Z]+)(-?)\d[\w-]*/g, (m, name, dash) => '.' + name + dash);
  // :nth-of-type(N) / :nth-child(N) → drop entirely
  s = s.replace(/:nth-(?:of-type|child)\(\d+\)/g, '');
  return s;
}

// Semantic confirmation that a branching segment looks "list-item-like".
// Used after structural branching analysis to assign HIGH vs LOW confidence.
// HIGH confidence patterns are universal across feed/search/e-commerce sites:
//   - semantic role attribute
//   - aria-posinset or data-* positioning attrs
//   - list/table/option tag
//   - numeric-suffix class names common in component libraries
// LOW confidence = clusters but flags the LLM/user that grouping may be off.
const HIGH_CONFIDENCE_ATTRS = [
  /\[role=/i,
  /\[aria-posinset\b/i,
  /\[data-item/i,
  /\[data-index/i,
  /\[data-row/i,
  /\[data-testid/i,
  /\[data-cid/i,
  /\[data-id/i,
];
const HIGH_CONFIDENCE_TAGS = /^(li|tr|option)\b/i;
const HIGH_CONFIDENCE_CLASS = /(?:^|[\s'.])(?:item|post|card|row|entry|result|product)-?\d/i;

function isHighConfidence(seg) {
  if (!seg || typeof seg !== 'string') return false;
  if (HIGH_CONFIDENCE_ATTRS.some(re => re.test(seg))) return true;
  if (HIGH_CONFIDENCE_TAGS.test(seg)) return true;
  if (HIGH_CONFIDENCE_CLASS.test(seg)) return true;
  return false;
}

// Return a shallow copy of `a` with `selector` generalized: positional
// values stripped so the LLM sees a reusable selector instead of one
// pinned to a specific list-item instance. The input annotation is NOT
// mutated. Selectors with no positionals pass through unchanged.
function cleanupAnnotationSelector(a) {
  if (!a || !a.selector || typeof a.selector !== 'string') return a;
  let s = a.selector;
  s = s.replace(/\[([a-zA-Z-]+)=(?:"[^"]*"|'[^']*'|[^\]]+)\]/g, '[$1]');
  // #id-with-digits → [id] marker (numeric suffix is positional). Matches
  // normalizeSegment's collapse so the LLM sees the same shape on container
  // tags and per-annotation selectors.
  s = s.replace(/#[a-zA-Z_-]*\d[\w-]*/g, '[id]');
  s = s.replace(/:nth-(?:of-type|child)\(\d+\)/g, '');
  // Tidy accidental double spaces from the above replacements.
  s = s.replace(/  +/g, ' ').trim();
  return { ...a, selector: s };
}

function clusterAnnotationsByContainer(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (!list.length) return { samples: [], supplemental: [] };

  // Parse all domPaths up front.
  const parsed = list.map(a => ({
    anno: a,
    segs: parseDomPathSegments(a && a.domPath),
  }));

  // STAGE 1 — find first depth where annotations diverge.
  const maxDepth = Math.max(...parsed.map(p => p.segs.length));
  let branchingDepth = -1;
  for (let d = 0; d < maxDepth; d++) {
    const at = parsed.filter(p => p.segs.length > d);
    if (at.length < 2) break; // need ≥2 annotations reaching this depth to branch
    const rawValues = new Set(at.map(p => p.segs[d]));
    const normValues = new Set(at.map(p => normalizeSegment(p.segs[d])));
    // Branching condition: distinct raw segments at this depth.
    // NOTE: the plan spec'd `rawValues.size > 1 && normValues.size > 1`, but
    // that rejects the canonical list-item case (e.g. aria-posinset='1' vs '2'
    // both normalize to [aria-posinset], so normValues.size === 1). The tests
    // (TDD contract, binding) require branching in exactly that case, so the
    // rule is just `rawValues.size > 1`. normValues is still computed for
    // future diagnostic use.
    void normValues;
    if (rawValues.size > 1) {
      branchingDepth = d;
      break; // FIRST divergence = container level
    }
  }

  // STAGE 2 — group by RAW segment at the branching depth.
  if (branchingDepth < 0) {
    return {
      samples: [{ containerSelector: null, containerTag: null, confidence: 'low', annotations: list.slice() }],
      supplemental: [],
    };
  }

  const groups = new Map(); // rawSeg -> annotations[]
  const supplemental = [];
  for (const p of parsed) {
    if (p.segs.length <= branchingDepth) {
      supplemental.push(p.anno);
      continue;
    }
    const key = p.segs[branchingDepth];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.anno);
  }

  const samples = [];
  for (const [rawSeg, annos] of groups) {
    const normSeg = normalizeSegment(rawSeg);
    const confidence = isHighConfidence(rawSeg) ? 'high' : 'low';
    samples.push({
      containerSelector: rawSeg,
      containerTag: normSeg,
      confidence,
      annotations: annos.map(cleanupAnnotationSelector),
    });
  }

  return { samples, supplemental };
}

const api = { clusterAnnotationsByContainer, parseDomPathSegments, normalizeSegment, isHighConfidence, cleanupAnnotationSelector };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.AnnotationCluster = api;
if (typeof self !== 'undefined') self.AnnotationCluster = api;
if (typeof global !== 'undefined') {
  global.clusterAnnotationsByContainer = clusterAnnotationsByContainer;
  global.AnnotationCluster = api;
}
