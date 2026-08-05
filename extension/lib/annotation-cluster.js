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

function clusterAnnotationsByContainer(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (!list.length) return { samples: [], supplemental: [] };
  // Placeholder — subsequent tasks fill in the real algorithm.
  return { samples: [], supplemental: list };
}

const api = { clusterAnnotationsByContainer, parseDomPathSegments };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.AnnotationCluster = api;
if (typeof self !== 'undefined') self.AnnotationCluster = api;
if (typeof global !== 'undefined') {
  global.clusterAnnotationsByContainer = clusterAnnotationsByContainer;
  global.AnnotationCluster = api;
}
