// extension/lib/census-lanes.js
//
// The page-level field census LANE ENGINE — extracted from probe-tools.js
// (175th round, review #10/#34): the pure DOM-classification half of
// probe.census. It receives the already-extracted sample container HTML
// (offline copies — this module never touches page DOM, only a DOMParser
// over extracted markup), walks each sample's leaves ONCE, and classifies
// every leaf into generic lanes via FieldCandidateDiscovery's scoring
// primitives (scoreLeaf/collectLeaves/buildLeafSelector — the same
// primitives the autoFix path's findFieldCandidates uses).
//
// Single-pass (#34): the earlier shape re-parsed each sample once per lane
// (5 lanes + aria + href = up to 7 parses per sample). Leaves are now
// collected once per doc and scored per lane against the same walk.
//
// Coverage semantics (#30): a lane entry's sample TEXTS are harvested from
// doc.body.querySelector(sel) — the FIRST match, exactly what production
// $extractList reads — not from the scored leaf that produced the selector
// (a tag+first-class collision can fold two fields into one selector; the
// texts then show what production would actually bind).
//
// Universality: no site-specific terms anywhere; lanes are generic
// (time/count/url/id/text) plus the aria-carrier lane and the href-token
// identity diff.
//
// IIFE-wrapped per RC30: classic <script> tags share a global lexical
// scope; the IIFE gives this module its own. Exposed via module.exports /
// window.CensusLanes / global.CensusLanes.

(function (global) {
  'use strict';

  function createCensusLaneEngine() {

    let __fcdBag = null;
    function fcdRef() {
      if (__fcdBag === null) {
        __fcdBag = false;
        if (typeof require !== 'undefined') {
          try { __fcdBag = require('./field-candidate-discovery'); } catch (eFcd) { __fcdBag = false; }
        }
        if (!__fcdBag) {
          const g = (typeof global !== 'undefined') ? global : globalThis;
          if (g && g.FieldCandidateDiscovery) __fcdBag = g.FieldCandidateDiscovery;
        }
      }
      return __fcdBag || null;
    }

    function parserRef() {
      if (typeof DOMParser !== 'undefined') return DOMParser;
      const w = (typeof window !== 'undefined') ? window : globalThis;
      return (w && w.DOMParser) || null;
    }

    // Derived, not spelled out: the lane key is the type minus its '-like'
    // suffix, so adding a lane is a one-word change with no second literal
    // to keep in sync.
    const LANES = ['time-like', 'count-like', 'url-like', 'id-like', 'text-like']
      .map((t) => ({ key: t.replace(/-like$/, ''), type: t }));

    // Evenly spaced sample indices (first/middle/last — the 171st-round
    // diversity rule). Deduped: a 2-container population with samples:3
    // yields [0,1], never a repeated index.
    function pickIndices(total, want) {
      if (total <= 0) return [];
      const n = Math.max(1, Math.min(want, total));
      if (n === 1) return [0];
      const set = [];
      for (let i = 0; i < n; i++) {
        set.push(Math.min(total - 1, Math.round((i * (total - 1)) / (n - 1))));
      }
      return Array.from(new Set(set));
    }

    function parseSample(html) {
      const Parser = parserRef();
      if (!Parser) return null;
      try {
        return new Parser().parseFromString('<html><body>' + html + '</body></html>', 'text/html');
      } catch (eP) { return null; }
    }

    // First-match coverage: the element production $extractList would read.
    function coverageHit(sel, doc) {
      try { return (doc && doc.body && doc.body.querySelector(sel)) || null; }
      catch (eQ) { return null; }
    }

    function coverageCount(sel, docs) {
      let k = 0;
      for (const doc of docs) if (coverageHit(sel, doc)) k += 1;
      return k;
    }

    // #34 single pass: walk leaves ONCE per doc, score every lane per leaf.
    // Returns { byLane: Map laneType -> [{selector,text,tag,strength}] } or
    // null when the scan threw (the caller counts that as a lane error).
    function scanDocLeaves(doc, fcd) {
      const leaves = fcd.collectLeaves(doc.body, doc);
      const byLane = new Map();
      for (const lane of LANES) byLane.set(lane.type, []);
      let domOrder = 0;
      for (const leaf of leaves) {
        const text = (leaf.textContent || '').trim();
        const tag = leaf.tagName.toLowerCase();
        for (const lane of LANES) {
          const strength = fcd.scoreLeaf(leaf, lane.type);
          if (!strength) continue;
          byLane.get(lane.type).push({
            selector: fcd.buildLeafSelector(leaf, doc),
            text: text.slice(0, 40),
            tag: tag,
            strength: strength,
            _domOrder: domOrder
          });
        }
        domOrder += 1;
      }
      return byLane;
    }

    // Group one lane's per-sample candidates by selector; measure coverage
    // on the parsed docs; sort coverage desc -> strength asc -> distinct
    // sample texts desc (#31: informative wrappers differ across samples;
    // near-identical repeated chrome sinks to the bottom) -> DOM order.
    // texts come from the coverage FIRST-MATCH element (#30) with the
    // scored-leaf text as fallback for zero-coverage entries.
    function groupLane(perSampleCandidates, docs, maxEntries, strengthOrder) {
      const order = [];
      const bySel = new Map();
      docs.forEach((doc, di) => {
        for (const c of (perSampleCandidates[di] || [])) {
          if (!c || !c.selector) continue;
          let g = bySel.get(c.selector);
          if (!g) {
            g = { selector: c.selector, tag: c.tag, strength: c.strength, texts: [], _fallbackTexts: [], _domOrder: c._domOrder || 0 };
            bySel.set(c.selector, g);
            order.push(g);
          }
          const t = String(c.text || '').trim();
          if (t && g._fallbackTexts.length < 2 && g._fallbackTexts.indexOf(t) === -1) g._fallbackTexts.push(t);
        }
      });
      for (const g of order) {
        g._coverageN = coverageCount(g.selector, docs);
        // #30: harvest from the FIRST match — what production reads. When
        // two leaves share a tag+first-class selector, this shows the value
        // that would actually bind, not the leaf that scored.
        for (const doc of docs) {
          const el = coverageHit(g.selector, doc);
          if (!el) continue;
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          // Receipt-budget cap: TWO distinct sample texts per entry is
          // enough to read value diversity without bloating the receipt.
          if (t && g.texts.length < 2 && g.texts.indexOf(t) === -1) g.texts.push(t);
        }
        if (!g.texts.length) g.texts = g._fallbackTexts;
      }
      order.sort((x, y) => (y._coverageN - x._coverageN) ||
        ((strengthOrder[x.strength] ?? 9) - (strengthOrder[y.strength] ?? 9)) ||
        (y.texts.length - x.texts.length) ||
        (x._domOrder - y._domOrder));
      return order.slice(0, maxEntries).map((g) => ({
        selector: g.selector,
        tag: g.tag,
        strength: g.strength,
        coverage: g._coverageN + '/' + docs.length,
        texts: g.texts
      }));
    }

    // The hidden-value lane: aria reference carriers. Rounds 42/43/90/105
    // all had fields whose clean value lived ONLY in the elements an
    // aria-labelledby reference points at — a lane the leaf-type scorer has
    // no concept of. Reported as carriers; resolution stays with
    // probe.labelledby (references can point OUTSIDE the container, so the
    // census must not pretend to resolve them).
    function ariaLane(docs, maxEntries, cssEscape) {
      const order = [];
      const byKey = new Map();
      for (const doc of docs) {
        if (!doc || !doc.body) continue;
        let carriers = [];
        try { carriers = Array.from(doc.body.querySelectorAll('[aria-labelledby], [aria-describedby]')); } catch (eQ) { carriers = []; }
        for (const el of carriers.slice(0, 20)) {
          const tag = el.tagName.toLowerCase();
          const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0] || '';
          const attrName = (el.getAttribute('aria-labelledby') != null) ? 'aria-labelledby' : 'aria-describedby';
          // The class token must be CSS-escaped — design-system classes
          // carry ':'/'/' characters that would otherwise produce a selector
          // no querySelector accepts.
          const sel = tag + (cls ? '.' + cssEscape(cls) : '') + '[' + attrName + ']';
          let g = byKey.get(sel);
          if (!g) {
            g = { selector: sel, refAttr: attrName, texts: [] };
            byKey.set(sel, g);
            order.push(g);
          }
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          if (t && g.texts.length < 3 && g.texts.indexOf(t) === -1) g.texts.push(t);
        }
      }
      for (const g of order) g._coverageN = coverageCount(g.selector, docs);
      order.sort((x, y) => y._coverageN - x._coverageN);
      return order.slice(0, maxEntries).map((g) => ({
        selector: g.selector,
        refAttr: g.refAttr,
        coverage: g._coverageN + '/' + docs.length,
        texts: g.texts
      }));
    }

    function idishValue(v) {
      const s = String(v == null ? '' : v);
      if (!s || s.length > 64) return false;
      // Pure digits of 10-13 chars are epoch seconds/milliseconds — a
      // cache-buster/per-request decoration that differs on EVERY link and
      // therefore diffs like an id without being one.
      if (/^\d{10,13}$/.test(s)) return false;
      return /^\d{2,}$/.test(s) || (/^[a-z0-9]+$/i.test(s) && s.length >= 6 && /\d/.test(s));
    }

    // 139th/150th/152nd rounds: the per-record identity usually lives in an
    // href TOKEN — a query param whose NAME persists across cards while its
    // VALUE differs, or a numeric terminal path segment. utm_* params are
    // transport decoration, never identity.
    // #33: values collect into a PER-CARD SET — a key whose value varies
    // WITHIN one card is per-link decoration (cache-busters, signatures),
    // not a card identity, and is excluded even before the cross-card diff.
    // First-seen-wins is gone: the whole card contributes, not its first
    // link in DOM order.
    function hrefIdentity(docs) {
      const perDoc = docs.map((doc) => {
        const vals = new Map();
        if (!doc || !doc.body) return vals;
        let links = [];
        try { links = Array.from(doc.body.querySelectorAll('a[href]')); } catch (eQ) { links = []; }
        for (const a of links.slice(0, 30)) {
          let u;
          try { u = new URL(a.getAttribute('href') || '', 'https://census.invalid/'); } catch (eU) { continue; }
          u.searchParams.forEach((v, k) => {
            if (/^utm_/i.test(k)) return;
            if (idishValue(v)) {
              const key = 'query:' + k;
              if (!vals.has(key)) vals.set(key, new Set());
              vals.get(key).add(v);
            }
          });
          const segs = u.pathname.split('/').filter(Boolean);
          const last = segs[segs.length - 1] || '';
          if (idishValue(last)) {
            if (!vals.has('path:last')) vals.set('path:last', new Set());
            vals.get('path:last').add(decodeURIComponent(last));
          }
        }
        return vals;
      });
      if (perDoc.length < 2) return [];
      const common = [];
      const firstKeys = Array.from(perDoc[0].keys());
      for (const key of firstKeys) {
        if (!perDoc.every((m) => m.has(key))) continue;
        // A key varying WITHIN any card is per-link decoration.
        if (perDoc.some((m) => m.get(key).size > 1)) continue;
        const vals = perDoc.map((m) => Array.from(m.get(key))[0]);
        const distinct = new Set(vals.map((v) => String(v))).size === vals.length;
        if (distinct) common.push({ token: key, coverage: perDoc.length + '/' + perDoc.length, samples: vals.map((v) => String(v).slice(0, 48)) });
      }
      return common.slice(0, 4);
    }

    // Top-level lane build over the parsed sample docs. Returns
    // { lanes, laneErrors } — laneErrors counts per-doc scan throws so the
    // caller can disclose partial degradation loudly.
    function buildLanes(docs, maxPerLane) {
      const fcd = fcdRef();
      const strengthOrder = (fcd && fcd.STRENGTH_ORDER) || { strong: 0, medium: 1, weak: 2 };
      const cssEscape = (fcd && typeof fcd.CSSescape === 'function')
        ? fcd.CSSescape
        : (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const lanes = {};
      let laneErrors = 0;
      // Single-pass: one scan per doc, reused by every lane.
      const scans = docs.map((doc) => {
        try { return scanDocLeaves(doc, fcd); } catch (eS) { laneErrors += LANES.length; return null; }
      });
      for (const lane of LANES) {
        // scanDocLeaves returns the byLane Map directly (lane.type ->
        // candidate list); a thrown scan is null and contributes nothing.
        const perSample = scans.map((scan) => (scan ? scan.get(lane.type) : []));
        // #31: the text lane is the flood lane (every text-bearing leaf is
        // medium) — it gets double the entries so the distinct-text sort can
        // lift informative deep-card leaves over near-identical wrappers.
        const entries = groupLane(perSample, docs, lane.key === 'text' ? maxPerLane * 2 : maxPerLane, strengthOrder);
        if (entries.length) lanes[lane.key] = entries;
      }
      const aria = ariaLane(docs, Math.min(4, maxPerLane), cssEscape);
      if (aria.length) lanes.aria = aria;
      return { lanes: lanes, laneErrors: laneErrors };
    }

    return {
      pickIndices,
      parseSample,
      buildLanes,
      hrefIdentity,
      // Test-surface primitives (also handy for future probes):
      idishValue,
      LANES
    };
  }

  const api = { createCensusLaneEngine };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CensusLanes = api;
  if (typeof self !== 'undefined') self.CensusLanes = api;
  if (typeof global !== 'undefined') global.CensusLanes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
