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
    const cleanHtmlFn = deps && typeof deps.cleanHtml === 'function' ? deps.cleanHtml : null;
    if (!executeDsl) throw new Error('createProbeTools requires an executeDsl(snippet) function');

    // Page-cleaning hook for probe.sample clean:true — strips the noise the
    // DOM carries (scripts/styles/tracking attrs) so the model reads
    // STRUCTURE, not 30K of raw outerHTML. Injected for tests; in the wizard
    // the DomCleaner global is resolved lazily so script load order never
    // matters. cleanHtmlForLLM returns {mode,html,fingerprint,error?} and
    // needs a DOMParser (browser): any failure degrades to raw HTML —
    // cleaning is an aid, never a gate.
    function applyClean(html) {
      try {
        let out = null;
        if (cleanHtmlFn) out = cleanHtmlFn(html);
        else {
          const dc = (typeof DomCleaner !== 'undefined') ? DomCleaner
            : ((typeof window !== 'undefined' && window.DomCleaner) || null);
          if (dc && typeof dc.cleanHtmlForLLM === 'function') out = dc.cleanHtmlForLLM(html);
        }
        if (typeof out === 'string') return out;
        if (out && typeof out === 'object' && typeof out.html === 'string' && out.html && !out.error) return out.html;
      } catch (e) { /* cleaner failure must not break the probe */ }
      return html;
    }

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
      // Composed on the EXISTING rail: $extractList with an EMPTY-selector
      // attribute fieldMap reads the attribute on EACH CONTAINER ITSELF (the
      // list-extract-ops readField self-read form, same mechanism probe.sample
      // wantHtml uses). First-live-log P-D: the previous descendant form
      // ({selector:'[attr]'}) answered "which containers CONTAIN a descendant
      // carrying attr" — probe.sample('[role=feed] > [role=article]') then
      // contradicted it (direct children), burning turns. The distribution
      // semantics here (what fraction of the population carries each value ON
      // the selected elements) is exactly the polarity evidence the grounding
      // gate requires for filter attributes (spec §8).
      const fieldMap = { m: { attr: attr } };
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
        .map(v => ({ value: v.slice(0, 80), items: counts[v], pct: total ? Math.round(counts[v] / total * 1000) / 10 : 0 }))
        .sort((a, b) => b.items - a.items)
        .slice(0, ATTR_VALUES_MAX);
      return {
        totalItems: total,
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
          if (rec && typeof rec.h === 'string' && rec.h) {
            const html = o.clean === true ? applyClean(rec.h) : rec.h;
            out.html = html.slice(0, 30000);
          } else out.htmlError = 'no outerHTML for match ' + index + ' (' + recs.length + ' match(es))';
        }
      }
      return out;
    }

    // Sixth-log turn-sink: t26-t40 burned 15 turns on the verify loop — every
    // fieldMap revision needed a full service.update rewrite plus a verify.run
    // on a FRESH tab (cold-load divergence re-introducing doubt). This probe
    // dry-runs the extraction DSL in the LIVE research tab: one turn per
    // fieldMap revision, warm DOM, and the container + field selectors all
    // become observation receipts (grounding the eventual step fieldMap).
    const FIELD_VALUE_CAP = 500;

    async function extract(args0) {
      const a = args0 && typeof args0 === 'object' ? args0 : {};
      const containerSel = typeof a.containerSel === 'string' ? a.containerSel.trim() : '';
      if (!containerSel) return { error: 'containerSel required' };
      const fieldMap = (a.fieldMap && typeof a.fieldMap === 'object' && !Array.isArray(a.fieldMap)) ? a.fieldMap : null;
      const fieldKeys = fieldMap ? Object.keys(fieldMap) : [];
      if (!fieldKeys.length) {
        return { error: 'fieldMap required — {field:{selector,attr?}} (a field without "selector" reads the container itself)' };
      }
      const snippet = 'return $extractList' + (a.multi === true ? 'Multi' : '') + '(' +
        JSON.stringify(containerSel) + ', ' + JSON.stringify(fieldMap) +
        (a.allowEmpty === true ? ', ' + JSON.stringify({ allowEmpty: true }) : '') + ');';
      const r = await runSnippet(snippet);
      if (r && typeof r.error === 'string') return r;
      const records = Array.isArray(r) ? r : (r && Array.isArray(r.records) ? r.records : []);
      if (!records.length) {
        return { total: 0, records: [], emptyFields: {}, note: '0 records — the container matched nothing (probe.count the containerSel first) or every record was filtered' };
      }
      if (observationLog) {
        const sels = [containerSel];
        for (const k of fieldKeys) {
          const f = fieldMap[k];
          if (f && typeof f === 'object' && typeof f.selector === 'string' && f.selector && sels.indexOf(f.selector) === -1) {
            sels.push(f.selector);
          }
        }
        observationLog.record({
          tool: 'probe.extract',
          selectors: sels,
          summary: 'extract' + (a.multi === true ? 'Multi' : '') + ' ' + records.length + ' records over ' + fieldKeys.length + ' fields'
        });
      }
      const capValue = (v) => {
        if (typeof v !== 'string') return v;
        return v.length > FIELD_VALUE_CAP ? v.slice(0, FIELD_VALUE_CAP) + '…[truncated]' : v;
      };
      const sampled = records.slice(0, 3).map(rec => {
        if (!rec || typeof rec !== 'object') return rec;
        const out = {};
        for (const k of Object.keys(rec)) out[k] = capValue(rec[k]);
        return out;
      });
      // RC15 census: which fields came back empty, and how often — the
      // cheapest signal that a field selector misses the card population.
      const emptyFields = {};
      for (const rec of records) {
        for (const k of fieldKeys) {
          const v = rec ? rec[k] : null;
          if (v === '' || v == null || (Array.isArray(v) && !v.length)) {
            emptyFields[k] = (emptyFields[k] || 0) + 1;
          }
        }
      }
      return { total: records.length, records: sampled, emptyFields: emptyFields };
    }

    // Sixth-live-log I1: the session bag had no scroll probe, so the model
    // spent turns 5-13 repeating "I can't scroll via research tools" and
    // authored scroll steps blind. The DSL already scrolls — expose it. The
    // container selector IS recorded as a receipt: step scripts claim it
    // through $scrollToBottom(sel)/$scrollBy(n, sel), so a scroll the model
    // performed during research also grounds the step that repeats it.
    async function scroll(args0) {
      const a = args0 && typeof args0 === 'object' ? args0 : {};
      const sel = (typeof a.sel === 'string' && a.sel.trim()) ? a.sel.trim() : null;
      const mode = a.mode === 'by' ? 'by' : 'bottom';
      const by = (typeof a.by === 'number' && a.by > 0) ? Math.floor(a.by) : null;
      if (mode === 'by' && !by) return { error: 'by (positive pixel count) required for mode:"by"' };
      const snippet = mode === 'by'
        ? 'return $scrollBy(' + by + (sel ? ', ' + JSON.stringify(sel) : '') + ');'
        : 'return $scrollToBottom(' + (sel ? JSON.stringify(sel) : '') + ');';
      const r = await runSnippet(snippet);
      if (r && typeof r.error === 'string') return r;
      if (!r || typeof r !== 'object') return { error: 'unexpected scroll result shape' };
      if (observationLog) {
        observationLog.record({
          tool: 'probe.scroll',
          selectors: sel ? [sel] : [],
          summary: 'scroll ' + mode + (sel ? ' @' + sel : '') + ' scrolled=' + !!r.scrolled
        });
      }
      return { scrolled: !!r.scrolled, prevY: r.prevY, newY: r.newY };
    }

    // Sixth-live-log I2b: auto-discovery SEES the real popover but the
    // observation receipt carried only the anchor selector — a popoverSel the
    // model rewrites from the evidence could never match a receipt, so the
    // grounding gate deadlocked the session (turns 19-24). Derive a canonical
    // selector from the observed structural identity (or the htmlSnippet
    // opening tags), record THAT exact string as the receipt, and hand it back
    // as popoverSelector so the model copies it verbatim (RC51 anchorHref
    // pattern: the framework supplies the field instead of letting the LLM
    // invent a variant like adding [aria-modal='true']).
    //
    // Seventh-live-log J3: the snippet usually opens with a BARE portal
    // wrapper (hashed classes only) while the semantic tokens live on a
    // descendant — the first-tag-only parse produced no canonical and the
    // model hand-derived the selector across 3 extra turns. Scan the first 8
    // opening tags, outermost-first, and take the first token-bearing element.
    function popoverOpeningTags(html) {
      if (typeof html !== 'string' || !html) return [];
      const head = html.slice(0, 4000);
      const out = [];
      const re = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
      let m;
      while (out.length < 8 && (m = re.exec(head)) !== null) {
        out.push({ tag: m[1], attrs: m[2] || '' });
      }
      return out;
    }

    function identityFromAttrs(tag, attrs) {
      const get = (name) => {
        const am = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\'])(.*?)\\1', 'i').exec(attrs);
        return am ? am[2].trim() : '';
      };
      return { tag: tag, id: get('id'), role: get('role'), ariaLabel: get('aria-label'), cls: get('class') };
    }

    function canonicalFromHtml(html) {
      for (const t of popoverOpeningTags(html)) {
        const c = canonicalPopoverSelector(identityFromAttrs(t.tag, t.attrs));
        if (c) return c;
      }
      return null;
    }

    // Audit C10: sites with semantic BEM classes (popover__content) and no
    // id/aria/role derived NO canonical — the model hand-wrote selectors for
    // extra turns. A SINGLE stable-looking class token is a legitimate
    // canonical when it survives the churn filters below (pure structure, no
    // site knowledge).
    const CHURN_CLASS_RE = /^(mount_|react-aria[-_:]|headlessui-|r_[0-9]+_|css-|js-|m_-)/i;
    function isStableClassToken(t) {
      if (t.length < 3 || t.length > 60) return false;
      if (!/^[A-Za-z][A-Za-z0-9]*(?:[-_]+[A-Za-z0-9]+)*$/.test(t)) return false;
      if (CHURN_CLASS_RE.test(t)) return false;
      if (/^[a-z][0-9]{2,}$/i.test(t)) return false; // hash-like short tokens (x9f619 class)
      if (!/[A-Za-z]{3}/.test(t)) return false;
      return true;
    }

    function canonicalPopoverSelector(op) {
      if (!op || typeof op !== 'object') return null;
      const tag = typeof op.tag === 'string' ? op.tag.toLowerCase() : '';
      if (!/^[a-z][\w-]*$/.test(tag)) return null;
      // Only STABLE, semantic tokens — id / aria-label / role. Hashed classes
      // churn between sessions and a bare tag is too broad to be a receipt.
      // Values are capped (observedPopover slices at 80): a possibly-
      // truncated value would make an unmatchable selector, so skip it.
      let s = tag;
      if (op.id && /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(op.id)) s += '#' + op.id;
      if (typeof op.ariaLabel === 'string' && op.ariaLabel && op.ariaLabel.length <= 60) {
        s += "[aria-label='" + op.ariaLabel.replace(/'/g, "\\'") + "']";
      }
      if (typeof op.role === 'string' && op.role && op.role.length <= 60) {
        s += "[role='" + op.role.replace(/'/g, "\\'") + "']";
      }
      if (s === tag && typeof op.cls === 'string') {
        const tokens = op.cls.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 1 && isStableClassToken(tokens[0])) s += '.' + tokens[0];
      }
      return s === tag ? null : s;
    }

    // First-live-log P-A: the session bag had no way to OBSERVE a hover
    // popover, so the LLM invoked the DSL primitive "$hover" as a tool name
    // (unknown tool) and fell back to attrStats. This probe runs the SAME
    // primitive once over the rail and keeps the receipt — anchor/popover
    // selectors for later $extractWithHover steps ground like any selector.
    async function hover(args0) {
      const a = args0 && typeof args0 === 'object' ? args0 : {};
      const anchorSel = typeof a.anchorSel === 'string' ? a.anchorSel.trim() : '';
      const popoverSel = (typeof a.popoverSel === 'string' && a.popoverSel.trim()) ? a.popoverSel.trim() : null;
      const o = (a.opts && typeof a.opts === 'object') ? a.opts : {};
      if (!anchorSel) return { error: 'anchorSel required' };
      const opts = {};
      if (typeof o.index === 'number' && o.index >= 0) opts.index = Math.floor(o.index);
      if (typeof o.timeoutMs === 'number' && o.timeoutMs > 0) opts.timeoutMs = o.timeoutMs;
      // Position-preserving $hover(anchorSel, popoverSel?, opts?) build:
      // a leading null keeps opts in 3rd place when no popoverSel is guessed.
      const parts = [JSON.stringify(anchorSel)];
      if (popoverSel) parts.push(JSON.stringify(popoverSel));
      if (Object.keys(opts).length) {
        if (!popoverSel) parts.push('null');
        parts.push(JSON.stringify(opts));
      }
      const r = await runSnippet('return $hover(' + parts.join(', ') + ');');
      if (r && typeof r.error === 'string') return r;
      if (!r || typeof r !== 'object') return { error: 'unexpected $hover result shape' };
      const op = (r.observedPopover && typeof r.observedPopover === 'object')
        ? r.observedPopover
        : null;
      const canonical = canonicalPopoverSelector(op) || canonicalFromHtml(typeof r.htmlSnippet === 'string' ? r.htmlSnippet : '');
      if (observationLog) {
        const receiptSels = popoverSel ? [anchorSel, popoverSel] : [anchorSel];
        if (canonical && receiptSels.indexOf(canonical) === -1) receiptSels.push(canonical);
        observationLog.record({
          tool: 'probe.hover',
          selectors: receiptSels,
          summary: 'hover probe' + (typeof opts.index === 'number' ? ' index=' + opts.index : '')
            + (canonical ? ' popover=' + canonical : '')
        });
      }
      // '[auto-discovered popover]' is a human-readable SENTINEL from the
      // hover layer, not a CSS selector — it must never be handed back as one
      // (seventh-log J3: the model ignored it, but a copy would throw).
      const matchedSel = (typeof r.popoverSelector === 'string' && r.popoverSelector && r.popoverSelector.charAt(0) !== '[')
        ? r.popoverSelector
        : null;
      const out = {
        hovered: !!r.hovered,
        popoverSelector: canonical || matchedSel,
        autoDiscovered: !!r.autoDiscovered,
        hoverDispatched: !!r.hoverDispatched,
        reason: (typeof r.reason === 'string' && r.reason) || null,
        observedPopover: r.observedPopover || null,
        // Generous evidence budget (popover structure is exactly what the LLM
        // rewrites popoverSel from); matches the record-HTML 8000 precedent.
        htmlSnippet: typeof r.htmlSnippet === 'string' && r.htmlSnippet ? r.htmlSnippet.slice(0, 8000) : null
      };
      if (canonical) {
        out.popoverSelectorNote = 'canonical popoverSelector derived from the observed popover — an observation receipt was recorded for THIS EXACT STRING. If you configure popoverSel in a step, copy it VERBATIM; an embellished variant (e.g. adding [aria-modal=\'true\']) is a new string the grounding gate must reject.';
      } else if (out.htmlSnippet) {
        out.popoverSelectorNote = 'auto-discovery captured the popover HTML but no stable token (id, aria-label, or role with a value of 60 chars or less) could be derived from its opening tags. Read htmlSnippet, pick a specific selector you can SEE in it (e.g. div[aria-label=\'...\']), and pass it as popoverSel to probe.hover again — a run that observes the popover via that selector records the receipt.';
      }
      return out;
    }

    return { count, text, attrStats, sample, hover, scroll, extract };
  }

  const api = { createProbeTools };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ProbeTools = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
