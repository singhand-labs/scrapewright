// extension/lib/findings-ledger.js
//
// Per-service findings ledger (spec §3B): the per-site memory a research
// session writes while investigating a page ("this page's ad marker is X",
// "popover mounts as role=tooltip in ~1.2s") and reads on every resume, so
// later repair sessions do NOT re-discover the page.
//
// Entries ride the service object (ServiceRegistry persists free-form JSON,
// so `service.findingsLedger = ledger.serialize()` needs no registry change).
// Compaction keeps ground truths (provenance 'user' and high confidence) and
// drops the weakest entries when the ledger exceeds its cap.
//
// Pure module. IIFE-wrapped per RC30.

(function (global) {

  const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 };

  function sanitizeEntry(raw, id) {
    const e = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof e.id === 'string' && e.id ? e.id : 'fl-' + id,
      finding: typeof e.finding === 'string' ? e.finding : '',
      evidence: typeof e.evidence === 'string' ? e.evidence : '',
      confidence: CONFIDENCE_ORDER[e.confidence] ? e.confidence : 'low',
      provenance: typeof e.provenance === 'string' ? e.provenance : 'probe',
      selectors: Array.isArray(e.selectors)
        ? e.selectors.filter(s => typeof s === 'string' && s.length > 0)
        : [],
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0
    };
  }

  function createFindingsLedger(initial) {
    const seed = initial && typeof initial === 'object' ? initial : {};
    const rawEntries = Array.isArray(seed.entries) ? seed.entries : [];
    const entries = rawEntries.map((e, i) => sanitizeEntry(e, i + 1));

    function add(spec) {
      const s = spec || {};
      const existing = entries.findIndex(e => e.finding === s.finding);
      const entry = sanitizeEntry({
        id: existing !== -1 ? entries[existing].id : 'fl-' + (entries.length + 1) + '-' + Date.now(),
        finding: s.finding,
        evidence: s.evidence,
        confidence: s.confidence,
        provenance: s.provenance,
        selectors: s.selectors,
        createdAt: Date.now()
      }, entries.length + 1);
      if (existing !== -1) entries[existing] = entry;
      else entries.push(entry);
      return { ...entry, selectors: entry.selectors.slice() };
    }

    function compact(opts) {
      const maxEntries = opts && typeof opts.maxEntries === 'number' ? opts.maxEntries : 20;
      const scored = entries.map((e, i) => ({
        e,
        i,
        score: (e.provenance === 'user' ? 1000 : 0) +
               (CONFIDENCE_ORDER[e.confidence] || 0) * 100 +
               (e.createdAt / 1e13)
      }));
      const keep = new Set(
        scored
          .sort((a, b) => b.score - a.score)
          .slice(0, maxEntries)
          .map(x => x.i)
      );
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].provenance === 'user') keep.add(i);
      }
      const kept = entries.filter((_, i) => keep.has(i));
      entries.length = 0;
      entries.push(...kept);
      return serialize();
    }

    function size() { return entries.length; }

    function serialize() {
      return { entries: entries.map(e => ({ ...e, selectors: e.selectors.slice() })) };
    }

    return { add, compact, size, serialize };
  }

  const api = { createFindingsLedger };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FindingsLedgerLib = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
