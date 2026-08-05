// extension/lib/annotation-cluster.js
//
// Cluster flat annotations by DOM container proximity. Called by
// buildAnnotationsText in wizard-utils.js to surface multi-sample structure
// to the LLM. Pure module — no DOM access, no IO.
//
// Algorithm: STRUCTURAL BRANCHING ANALYSIS + TAG SEMANTIC CONFIRMATION.
// No site-specific DOM patterns. See doc comment on clusterAnnotationsByContainer
// for the two-stage algorithm.

function clusterAnnotationsByContainer(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (!list.length) return { samples: [], supplemental: [] };
  // Placeholder — subsequent tasks fill in the real algorithm.
  return { samples: [], supplemental: list };
}

const api = { clusterAnnotationsByContainer };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.AnnotationCluster = api;
if (typeof self !== 'undefined') self.AnnotationCluster = api;
if (typeof global !== 'undefined') {
  global.clusterAnnotationsByContainer = clusterAnnotationsByContainer;
  global.AnnotationCluster = api;
}
