// extension/lib/grounding-gate.js
//
// Observation admission for service artifacts (spec §8): no selector enters
// a service step script without an observation receipt. Two stages:
//
//   1. extractSelectorClaims(steps) — static scan of step scripts for the
//      selector strings in $-API call positions and known config keys.
//      claim kinds: 'static' (present in the DOM at rest) vs 'dynamic'
//      (mounts on interaction, e.g. popoverSel — static count is ALWAYS 0).
//   2. validateGrounding(...) — Task 9: receipt verification.
//
// v1 approximation, documented: the scan is regex-based over the script
// string; selectors built by string concatenation in script code are not
// statically extractable and rely on the engine auto-verify path at
// service.update time. Strings inside comments may produce false claims —
// harmless (an extra receipt demand, never a bypass).
//
// Pure module. IIFE-wrapped per RC30.

(function (global) {

  // $ APIs whose first string argument is a selector.
  const SELECTOR_APIS = [
    'extractListMulti', 'extractWithHover', 'extractList', 'extract',
    'clickInList', 'scrollIntoView', 'scrollToBottom', 'hover',
    'list', 'count', 'wait', 'exists', 'check', 'click', 'type'
  ];
  // Module-level /g regexes: callers must not break out of the exec loop; lastIndex is reset per step.
  const SELECTOR_API_RE = new RegExp(
    '(?<![.\\w$])\\$(?:' + SELECTOR_APIS.join('|') + ')\\s*\\(\\s*([\'"`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1',
    'g'
  );
  // Config keys whose string value is a selector (hoverCfg, opts objects).
  // Module-level /g regexes: callers must not break out of the exec loop; lastIndex is reset per step.
  const CONFIG_KEY_RE = /\b(anchorSel|popoverSel|containerSelector|scopeSel)\s*:\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  const DYNAMIC_KEYS = new Set(['popoverSel']);
  // Presentational/global HTML attributes that never serve as card-type
  // filters — excluded from attribute-distribution receipt demands.
  const GLOBAL_ATTRS = new Set([
    'class', 'id', 'title', 'href', 'type', 'name', 'value', 'style',
    'dir', 'lang', 'tabindex', 'has', 'not'
  ]);

  function extractSelectorClaims(steps) {
    const bySelector = new Map();
    const list = Array.isArray(steps) ? steps : [];
    for (const step of list) {
      if (!step || typeof step.script !== 'string') continue;
      const script = step.script;
      let m;
      SELECTOR_API_RE.lastIndex = 0;
      while ((m = SELECTOR_API_RE.exec(script)) !== null) {
        addClaim(bySelector, m[2], 'static', step.id);
      }
      CONFIG_KEY_RE.lastIndex = 0;
      while ((m = CONFIG_KEY_RE.exec(script)) !== null) {
        const kind = DYNAMIC_KEYS.has(m[1]) ? 'dynamic' : 'static';
        addClaim(bySelector, m[3], kind, step.id);
      }
    }
    return Array.from(bySelector.values());
  }

  function addClaim(map, selector, kind, stepId) {
    let sel = String(selector || '');
    if (!sel) return;
    // Unescape JS string-literal escapes so claims match the runtime selector string (realistic selector escapes are quotes/backslashes).
    sel = sel.replace(/\\(.)/g, '$1');
    // Heuristic: selector-position strings do not look like URLs or bare
    // identifiers used as field names. Cheap, no false negatives observed in
    // the corpus; the engine's auto-verify would catch anything odd anyway.
    if (/^https?:\/\//i.test(sel)) return;
    let c = map.get(sel);
    if (!c) {
      c = { selector: sel, kind: kind, stepIds: [] };
      map.set(sel, c);
    }
    if (kind === 'dynamic') c.kind = 'dynamic';
    const sid = String(stepId == null ? '' : stepId);
    if (sid && c.stepIds.indexOf(sid) === -1) c.stepIds.push(sid);
  }

  // Attribute names appearing inside :has(...) / :not(...) filter clauses.
  // Approximation: scans the argument spans of those pseudo-functions for
  // [attr] / [attr=value] tokens. Nested pseudo-functions inside the span
  // (like :not(:has([x]))) are included because the span extends to the
  // LAST ')' on the same nesting run — implemented via bracket balancing.
  function extractFilterAttributes(selector) {
    if (typeof selector !== 'string' || !selector) return [];
    const attrs = new Set();
    const re = /:(has|not|is|where)\s*\(/g;
    let m;
    while ((m = re.exec(selector)) !== null) {
      let depth = 1;
      let i = re.lastIndex;
      let quote = null;
      while (i < selector.length && depth > 0) {
        const ch = selector[i];
        if (quote) {
          if (ch === '\\' && i + 1 < selector.length) { i += 2; continue; }
          if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"') {
          quote = ch;
        } else if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        i += 1;
      }
      const span = selector.slice(re.lastIndex, i - 1);
      const attrRe = /\[\s*([a-zA-Z][\w-]*)\s*(?:[*^$|~]?=\s*(?:"[^"]*"|'[^']*'|[^\]]*))?\s*\]/g;
      let a;
      while ((a = attrRe.exec(span)) !== null) {
        // Well-known presentational/global HTML attributes do not discriminate
        // card types — only custom (data-*/aria-*/role-style) attributes do.
        if (GLOBAL_ATTRS.has(a[1])) continue;
        attrs.add(a[1]);
      }
    }
    return Array.from(attrs);
  }

  const api = { extractSelectorClaims, extractFilterAttributes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.GroundingGate = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
