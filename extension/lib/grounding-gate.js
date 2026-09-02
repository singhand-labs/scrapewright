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

  // $ APIs whose first string argument is a selector. Longer names precede
  // their prefixes (alternation is ordered); must cover the full DSL surface —
  // any selector-bearing API missing here silently bypasses claim extraction.
  const SELECTOR_APIS = [
    'extractListMulti', 'extractWithHover', 'waitForStable', 'extractList',
    'scrollIntoView', 'scrollToBottom', 'scrollBy', 'extract',
    'clickInList', 'hover', 'list', 'count', 'wait', 'exists', 'check',
    'click', 'type'
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
  // Per-element presentational/global HTML attributes whose attrStats
  // distribution is meaningless noise — the only attrs excluded from
  // attribute-distribution receipt demands. Semantic-bearing globals
  // (title, href, name, type, value) and all data-*/aria-* attrs DO
  // discriminate card types and still require a distribution receipt.
  // 'has'/'not' are pseudo-class NAMES, never attribute names, but they are
  // load-bearing here: the attr-token regex inside extractFilterAttributes
  // captures bracket tokens `[name]` from :has(...)/:not(...) spans, and a
  // selector like `a:not([href])` yields no stray `[not]` token to filter —
  // the GLOBAL_ATTRS set is the ONLY exclusion check on captured names, so
  // removing them would change nothing today yet invite confusion; keeping
  // them documents that pseudo-class names never demand distributions.
  const GLOBAL_ATTRS = new Set([
    'class', 'id', 'style', 'dir', 'lang', 'tabindex', 'has', 'not'
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

  // Attribute names appearing inside :has(...) / :not(...) / :is(...) /
  // :where(...) filter spans — there the attribute is used as a CARD-TYPE
  // discriminator (the seventh-log polarity-inversion class). Attribute
  // selectors directly on a compound (`a[href*="/p/"]`) are ordinary match
  // constraints covered by the selector-level receipt (probe.count > 0) and
  // are NOT collected.
  // Approximation: scans the argument spans of those pseudo-functions for
  // [attr] / [attr=value] tokens. Nested pseudo-functions inside the span
  // (like :not(:has([x]))) are included because the span extends to the
  // LAST ')' on the same nesting run — implemented via bracket balancing.
  function extractFilterAttributes(selector) {
    if (typeof selector !== 'string' || !selector) return [];
    const attrs = new Set();
    const attrRe = /\[\s*([a-zA-Z][\w-]*)\s*(?:[*^$|~]?=\s*(?:"[^"]*"|'[^']*'|[^\]]*))?\s*\]/g;
    const collect = (span) => {
      attrRe.lastIndex = 0;
      let a;
      while ((a = attrRe.exec(span)) !== null) {
        // Per-element presentational attributes (class/id/style/…) are noise;
        // semantic globals (title/href/name/type/value) and custom
        // (data-*/aria-*/role-style) attributes DO discriminate card types.
        if (GLOBAL_ATTRS.has(a[1])) continue;
        attrs.add(a[1]);
      }
    };
    const re = /:(has|not|is|where)\s*\(/g;
    let m;
    while ((m = re.exec(selector)) !== null) {
      // Quote-aware span walk: balance parens, skip quoted attr values.
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
      collect(span);
    }
    return Array.from(attrs);
  }

  // Receipt verification (spec §8). Receipt sources, in order:
  //   1. override      — explicit human approval (logged by the caller)
  //   2. observation   — this session's ObservationLog covers the selector
  //   3. ledger        — prior-session findings (provenance probe or user)
  //   4. autoVerify    — engine-supplied probe.count for uncovered STATIC
  //                      selectors (derived compounds); count>0 issues the
  //                      receipt, count 0 rejects
  // Dynamic-mount selectors (popoverSel) never auto-verify: their static
  // count is ALWAYS 0 — they need an observation, a ledger entry, or an
  // override; the rejection points at diag.read / annotate.request.
  // Filter attributes (inside :has()/:not()) additionally require an
  // attribute-distribution receipt (attrStats) regardless of selector
  // coverage — the seventh-log lesson made structural.
  async function validateGrounding(opts) {
    const steps = Array.isArray(opts && opts.steps) ? opts.steps : [];
    const observationLog = opts && opts.observationLog;
    const ledger = opts && opts.ledger;
    const autoVerify = opts && typeof opts.autoVerify === 'function' ? opts.autoVerify : null;
    const overrides = new Set(
      Array.isArray(opts && opts.overrides) ? opts.overrides.filter(s => typeof s === 'string') : []
    );

    // Audit C3: current page epoch (from the live rail). When present, only
    // observation receipts recorded in this epoch count — a reload of the
    // research tab invalidates every earlier DOM observation.
    const epoch = (opts && typeof opts.epoch === 'number') ? opts.epoch : null;
    const ep = epoch !== null ? epoch : undefined;

    const ledgerSelectors = new Set();
    if (ledger) {
      const entries = (ledger.serialize && ledger.serialize().entries) || [];
      for (const e of entries) {
        for (const s of e.selectors || []) ledgerSelectors.add(s);
      }
    }

    const rejections = [];
    const overrideReceipts = [];
    const autoVerified = [];

    const claims = extractSelectorClaims(steps);
    for (const claim of claims) {
      let admitted = false;
      if (overrides.has(claim.selector)) {
        overrideReceipts.push(claim.selector);
        admitted = true;
      } else if (observationLog && observationLog.covers(claim.selector, ep)) {
        admitted = true;
      } else if (ledgerSelectors.has(claim.selector)) {
        admitted = true;
      } else if (claim.kind === 'static' && autoVerify) {
        // A routine probe failure (tab closed mid-probe, CDP timeout) must
        // reject the selector, not crash the gate: probe failed ⇒ count
        // unknown ⇒ not verified ⇒ falls through to the 'observation'
        // rejection. No separate rejection class (v1 keeps the taxonomy small).
        let n = null;
        try {
          n = await autoVerify(claim.selector);
        } catch (err) {
          n = null;
        }
        if (typeof n === 'number' && n > 0) {
          autoVerified.push(claim.selector);
          if (observationLog) {
            observationLog.record({ tool: 'gate.autoVerify', selectors: [claim.selector], summary: 'count=' + n, epoch: ep });
          }
          admitted = true;
        }
      }
      if (!admitted) {
        // Audit C3: the selector WAS observed once, but only in an older page
        // epoch — the receipt is stale after a mid-session tab reload.
        const staleObserved = epoch !== null && observationLog
          && typeof observationLog.covers === 'function'
          && observationLog.covers(claim.selector)
          && !observationLog.covers(claim.selector, epoch);
        rejections.push(claim.kind === 'dynamic'
          ? {
              selector: claim.selector,
              stepIds: claim.stepIds,
              missing: 'dynamic-evidence',
              suggestion: 'This selector matches an interaction-mounted element — a static count is always 0. Ground it by running probe.hover (its result carries a canonical popoverSelector recorded as an observation receipt — copy that string VERBATIM into your popoverSel), or annotate.request, or resend service.update with overrides: ["<this selector>"] to waive the receipt explicitly.'
            }
          : {
              selector: claim.selector,
              stepIds: claim.stepIds,
              missing: 'observation',
              suggestion: 'No observation receipt. Run probe.count(' + JSON.stringify(claim.selector) + ') (or scope a probe that matches it exactly), or annotate.request.'
                + (staleObserved ? ' This selector WAS observed earlier, but the page has reloaded since (page epoch changed) — that evidence is stale: page.open the target again or re-probe the live page to rebuild the receipt.' : '')
            });
      }
      // Filter-attribute distribution receipts are demanded for EVERY claim,
      // admitted or not — default-deny: an unadmitted selector's filter attrs
      // reject alongside (and independently of) the selector-level rejection.
      const filterAttrs = extractFilterAttributes(claim.selector);
      for (const attr of filterAttrs) {
        const haveAttr = (observationLog && observationLog.coversAttr(attr, ep));
        if (!haveAttr) {
          rejections.push({
            selector: claim.selector,
            attr: attr,
            stepIds: claim.stepIds,
            missing: 'attr-distribution',
            suggestion: 'Attribute "' + attr + '" is used as a card filter but its distribution was never observed. Run probe.attrStats on the container population first — count>0 alone cannot tell a promotion marker from a structural scaffold.'
          });
        }
      }
    }

    return {
      ok: rejections.length === 0,
      rejections: rejections,
      overrideReceipts: overrideReceipts,
      autoVerified: autoVerified,
      // Claims returned for callers (Plan-3 UI may render them); already
      // computed — callers may ignore.
      claims: claims
    };
  }

  const api = { extractSelectorClaims, extractFilterAttributes, validateGrounding };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.GroundingGate = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
