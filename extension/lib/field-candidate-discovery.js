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

  const api = {
    inferFieldType,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FieldCandidateDiscovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
