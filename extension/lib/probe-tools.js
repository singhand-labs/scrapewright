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

    async function runSnippet(snippet) {
      try {
        return await executeDsl(snippet);
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    }

    // Dual dispatch: the engine calls every tool as fn(args, ctx) with a
    // single args object; direct callers (tests, Plan 3 wiring) may keep the
    // positional form. Normalize an object first-arg into the positional
    // parameters each function below expects.
    function unpackSel(a) {
      if (a && typeof a === 'object' && !Array.isArray(a)) return [a.sel, a];
      return [a, null];
    }

    async function count(sel0) {
      const sel = unpackSel(sel0)[0];
      if (typeof sel !== 'string' || !sel) return { error: 'selector required' };
      const r = await runSnippet('return $count(' + JSON.stringify(sel) + ');');
      if (r && typeof r.error === 'string') return r;
      const n = typeof r === 'number' ? r : 0;
      if (observationLog) {
        observationLog.record({ tool: 'probe.count', selectors: [sel], summary: 'count=' + n });
      }
      return { count: n };
    }

    async function text(sel0) {
      const sel = unpackSel(sel0)[0];
      if (typeof sel !== 'string' || !sel) return { error: 'selector required' };
      const r = await runSnippet('return $list(' + JSON.stringify(sel) + ');');
      if (r && typeof r.error === 'string') return r;
      if (observationLog) {
        observationLog.record({ tool: 'probe.text', selectors: [sel], summary: 'text sample' });
      }
      const arr = Array.isArray(r) ? r : [];
      const items = arr.slice(0, TEXT_ITEMS_MAX).map(el =>
        String((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_ITEM_CAP)
      );
      return { total: arr.length, items: items };
    }

    const ATTR_VALUES_MAX = 12;

    async function attrStats(containerSel0, attr0) {
      let containerSel = containerSel0, attr = attr0;
      if (containerSel && typeof containerSel === 'object' && !Array.isArray(containerSel)) {
        attr = containerSel.attr;
        containerSel = containerSel.containerSel;
      }
      if (typeof containerSel !== 'string' || !containerSel) return { error: 'containerSelector required' };
      if (typeof attr !== 'string' || !/^[a-zA-Z][\w-]*$/.test(attr)) return { error: 'attribute name required' };
      // Composed on the EXISTING rail: $extractList with an attribute-read
      // fieldMap returns one record per container; records missing the
      // attribute carry ''. The distribution semantics (what fraction of the
      // population carries each value) is exactly the polarity evidence the
      // grounding gate requires for filter attributes (spec §8).
      const fieldMap = { m: { selector: '[' + attr + ']', attr: attr } };
      const snippet = 'return $extractList(' + JSON.stringify(containerSel) + ', ' + JSON.stringify(fieldMap) + ');';
      const r = await runSnippet(snippet);
      if (r && typeof r.error === 'string') return r;
      if (observationLog) {
        observationLog.record({
          tool: 'probe.attrStats',
          selectors: [containerSel],
          attrs: [{ selector: containerSel, attr: attr }],
          summary: 'attrStats ' + attr
        });
      }
      const records = Array.isArray(r) ? r : (r && Array.isArray(r.records) ? r.records : []);
      const total = records.length;
      const counts = {};
      let absent = 0;
      for (const rec of records) {
        const v = rec && typeof rec.m === 'string' ? rec.m.trim() : '';
        if (!v) { absent += 1; continue; }
        counts[v] = (counts[v] || 0) + 1;
      }
      const values = Object.keys(counts)
        .map(v => ({ value: v.slice(0, 80), cards: counts[v], pct: total ? Math.round(counts[v] / total * 1000) / 10 : 0 }))
        .sort((a, b) => b.cards - a.cards)
        .slice(0, ATTR_VALUES_MAX);
      return {
        totalCards: total,
        values: values,
        absentPct: total ? Math.round(absent / total * 1000) / 10 : 0
      };
    }

    async function sample(sel0, opts0) {
      let sel = sel0, opts = opts0;
      if (sel && typeof sel === 'object' && !Array.isArray(sel)) {
        opts = sel.opts;
        sel = sel.sel;
      }
      const o = opts || {};
      const index = typeof o.index === 'number' && o.index >= 0 ? Math.floor(o.index) : 0;
      if (typeof sel !== 'string' || !sel) return { error: 'selector required' };
      const r = await runSnippet('return $list(' + JSON.stringify(sel) + ');');
      if (r && typeof r.error === 'string') return r;
      if (observationLog) {
        observationLog.record({ tool: 'probe.sample', selectors: [sel], summary: 'sample index=' + index });
      }
      const arr = Array.isArray(r) ? r : [];
      const el = arr[index];
      if (!el) return { notFound: true, total: arr.length };
      const out = {
        match: index,
        total: arr.length,
        element: {
          tagName: String(el.tagName || ''),
          id: String(el.id || '').slice(0, 80),
          className: String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          textContent: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          href: String(el.href || '').slice(0, 300),
          src: String(el.src || '').slice(0, 300)
        }
      };
      // Empty-selector fieldMap = "the container itself" (list-extract-ops
      // readField), so one $extractList returns every match's OWN outerHTML
      // and any index is addressable — $extract alone can only reach the
      // first match. The relay carries all matches (the DSL has no indexed
      // extract); the kept result is capped below.
      if (o.wantHtml) {
        const fieldMap = { h: { attr: 'outerHTML' } };
        const r2 = await runSnippet('return $extractList(' + JSON.stringify(sel) + ', ' + JSON.stringify(fieldMap) + ');');
        if (r2 && typeof r2.error === 'string') {
          out.htmlError = r2.error;
        } else {
          const recs = Array.isArray(r2) ? r2 : (r2 && Array.isArray(r2.records) ? r2.records : []);
          const rec = recs[index];
          if (rec && typeof rec.h === 'string' && rec.h) out.html = rec.h.slice(0, 30000);
          else out.htmlError = 'no outerHTML for match ' + index + ' (' + recs.length + ' match(es))';
        }
      }
      return out;
    }

    return { count, text, attrStats, sample };
  }

  const api = { createProbeTools };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ProbeTools = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
