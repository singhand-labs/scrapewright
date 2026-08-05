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

function clusterAnnotationsByContainer(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (!list.length) return { samples: [], supplemental: [] };
  // Placeholder — subsequent tasks fill in the real algorithm.
  return { samples: [], supplemental: list };
}

const api = { clusterAnnotationsByContainer, parseDomPathSegments, normalizeSegment };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.AnnotationCluster = api;
if (typeof self !== 'undefined') self.AnnotationCluster = api;
if (typeof global !== 'undefined') {
  global.clusterAnnotationsByContainer = clusterAnnotationsByContainer;
  global.AnnotationCluster = api;
}
