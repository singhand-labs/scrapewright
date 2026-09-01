// extension/lib/observation-log.js
//
// Observation receipts for a research session (2026-09-01 research-session
// architecture, spec §8). Every probe result is recorded here with the
// selector strings and attribute names it actually observed. The grounding
// gate consults this log as the PRIMARY receipt source: a selector entering
// the service artifact must have been observed in this session (or carry a
// ledger/annotation/override receipt instead).
//
// Coverage semantics are deliberately EXACT-STRING: if the session observed
// "div[role='feed']" that does NOT cover the derived compound
// "div[role='feed'] div[role='article']" — derived selectors go through the
// gate's cheap auto-verify probe instead. Exact matching keeps the receipt
// check deterministic and auditable; any fuzziness would let a guessed
// selector ride in on a similar observed one.
//
// Pure module: no DOM, no chrome.*, no IO. IIFE-wrapped per RC30.

(function (global) {

  function createObservationLog(initial) {
    const seed = initial && typeof initial === 'object' ? initial : {};
    const entries = Array.isArray(seed.entries) ? seed.entries.map(sanitizeEntry) : [];
    let seq = typeof seed.seq === 'number' ? seed.seq : entries.length;

    function sanitizeEntry(raw) {
      const e = raw && typeof raw === 'object' ? raw : {};
      return {
        id: typeof e.id === 'number' ? e.id : 0,
        tool: typeof e.tool === 'string' ? e.tool : 'unknown',
        selectors: Array.isArray(e.selectors)
          ? e.selectors.filter(s => typeof s === 'string' && s.length > 0)
          : [],
        attrs: Array.isArray(e.attrs)
          ? e.attrs
              .filter(a => a && typeof a === 'object' && typeof a.attr === 'string' && a.attr.length > 0)
              .map(a => ({ selector: typeof a.selector === 'string' ? a.selector : '', attr: a.attr }))
          : [],
        summary: typeof e.summary === 'string' ? e.summary : '',
        at: typeof e.at === 'number' ? e.at : 0
      };
    }

    function record(obs) {
      const e = sanitizeEntry({
        id: seq + 1,
        tool: obs && obs.tool,
        selectors: obs && obs.selectors,
        attrs: obs && obs.attrs,
        summary: obs && obs.summary,
        at: Date.now()
      });
      seq += 1;
      entries.push(e);
      return e;
    }

    function covers(selector) {
      if (typeof selector !== 'string' || !selector) return false;
      for (const e of entries) {
        if (e.selectors.indexOf(selector) !== -1) return true;
      }
      return false;
    }

    function coversAttr(attr) {
      if (typeof attr !== 'string' || !attr) return false;
      for (const e of entries) {
        for (const a of e.attrs) {
          if (a.attr === attr) return true;
        }
      }
      return false;
    }

    function size() { return entries.length; }

    function serialize() {
      return { entries: entries.slice(), seq: seq };
    }

    return { record, covers, coversAttr, size, serialize };
  }

  const api = { createObservationLog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ObservationLogLib = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
