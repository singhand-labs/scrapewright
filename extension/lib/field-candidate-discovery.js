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

  const api = {
    // Populated by tasks below. Empty for now so the file parses cleanly.
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FieldCandidateDiscovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
