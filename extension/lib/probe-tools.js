// extension/lib/probe-tools.js
//
// Probe tool contracts (spec §2) over an INJECTED executor. The live-tab
// executor (Plan 3) routes snippets through the existing sandbox/offscreen
// rail — probes are ordinary DSL snippets, so no runtime rail changes are
// needed for count/text/attrStats. Every successful probe auto-records an
// observation receipt into the session's ObservationLog (spec §8 receipt
// source #1).
//
// Result contracts are deliberately small (context diet is structural):
// numbers, capped strings, distributions — never raw pages.
//
// IIFE-wrapped per RC30. No DOM access here (the executor owns the DOM);
// Node tests inject a mock executor.

(function (global) {

  const TEXT_ITEM_CAP = 200;
  const TEXT_ITEMS_MAX = 20;

  function createProbeTools(deps) {
    const executeDsl = deps && typeof deps.executeDsl === 'function' ? deps.executeDsl : null;
    const observationLog = deps && deps.observationLog ? deps.observationLog : null;
    if (!executeDsl) throw new Error('createProbeTools requires an executeDsl(snippet) function');

    async function runSnippet(snippet, observation) {
      try {
        const result = await executeDsl(snippet);
        if (observationLog && observation) {
          observationLog.record({
            tool: observation.tool,
            selectors: observation.selectors || [],
            attrs: observation.attrs || [],
            summary: observation.summary || ''
          });
        }
        return result;
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    }

    async function count(sel) {
      if (typeof sel !== 'string' || !sel) return { error: 'selector required' };
      const r = await runSnippet(
        'return $count(' + JSON.stringify(sel) + ');',
        { tool: 'probe.count', selectors: [sel], summary: 'pending' }
      );
      if (r && typeof r.error === 'string') return r;
      const n = typeof r === 'number' ? r : 0;
      // Rewrite the summary with the real count: receipts must carry what was
      // actually observed, and the observation was already recorded above —
      // re-record with the final summary so the log's LAST entry is truthful.
      if (observationLog) {
        observationLog.record({ tool: 'probe.count', selectors: [sel], summary: 'count=' + n });
      }
      return { count: n };
    }

    async function text(sel) {
      if (typeof sel !== 'string' || !sel) return { error: 'selector required' };
      const r = await runSnippet('return $list(' + JSON.stringify(sel) + ');',
        { tool: 'probe.text', selectors: [sel], summary: 'text sample' });
      if (r && typeof r.error === 'string') return r;
      const arr = Array.isArray(r) ? r : [];
      const items = arr.slice(0, TEXT_ITEMS_MAX).map(el =>
        String((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_ITEM_CAP)
      );
      return { total: arr.length, items: items };
    }

    return { count, text };
  }

  const api = { createProbeTools };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ProbeTools = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
