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

    // Skeleton-dossier (2026-09-18 spec §3.C): HTML results DEFAULT to the
    // numbered skeleton view; opts.raw:true keeps the original. Model-directed
    // cleaning — opts (stripTags/keepAttrs/maxTextLen/maxDepth/capChars) pass
    // straight through to DomCleaner.skeletonView. Degrades to cleanHtmlForLLM
    // then raw HTML when no cleaner/parser is resolvable (never a gate).
    const skeletonFn = (deps && typeof deps.skeletonView === 'function')
      ? deps.skeletonView
      : (() => {
        const dc = (typeof DomCleaner !== 'undefined') ? DomCleaner
          : ((typeof window !== 'undefined' && window.DomCleaner) || null);
        return (dc && typeof dc.skeletonView === 'function') ? dc.skeletonView.bind(dc) : null;
      })();

    function applySkeleton(html, opts) {
      if (skeletonFn) {
        try {
          const o = (opts && typeof opts === 'object') ? opts : {};
          const out = skeletonFn(html, {
            stripTags: Array.isArray(o.stripTags) ? o.stripTags : undefined,
            keepAttrs: Array.isArray(o.keepAttrs) ? o.keepAttrs : undefined,
            maxTextLen: typeof o.maxTextLen === 'number' ? o.maxTextLen : undefined,
            maxDepth: typeof o.maxDepth === 'number' ? o.maxDepth : undefined,
            capChars: typeof o.capChars === 'number' ? o.capChars : (o.full ? 20000 : 8000)
          });
          if (typeof out === 'string' && out) return out;
        } catch (e) { /* degrade below */ }
      }
      return null; // caller decides (applyClean or raw)
    }

    // OffscreenExecutor resolves with an envelope {result, selectorDiagnostics};
    // the wizard rail used to unwrap to `result` at the boundary, silently
    // discarding selectorDiagnostics for every probe (twenty-third log — the
    // count/exists visibility split rides exactly that field). runSnippet
    // unwraps a recognizable envelope, stashes its diagnostics for the probe
    // that just ran, and passes raw values (test executors, future rails)
    // through untouched. Probes on one rail serialize through ensureLock, so
    // the stash is never interleaved.
    let lastSelectorDiagnostics = null;

    // Sixty-eighth log F1: probe snippets are NOT steps — the rail's
    // per-step 30s budget had no knob, and a 33-container $extractWithHover
    // was resent verbatim 3× against it. probe.snippet accepts timeoutMs
    // (default 30000, capped at 90000). Sixty-ninth review F1: the rail now
    // FORWARDS opts.timeoutMs to the executor, so the knob actually extends
    // the executor budget (≤90s) instead of only racing it client-side; the
    // client race stays as a backstop for rails that ignore the option.
    // Probes serialize through ensureLock, so the next probe queues behind
    // the current one, same as before.
    const SNIPPET_DEFAULT_TIMEOUT_MS = 30000;
    const SNIPPET_MAX_TIMEOUT_MS = 90000;

    // Sixty-ninth review F11 (queue-wait disclosure): probes serialize on the
    // rail's exec lock, but the client cannot see WHEN the lock is granted —
    // a timed-out probe may have burned its whole budget waiting behind the
    // previous probe, which teaches "shrink the snippet" when the real fix is
    // "wait your turn". A local promise chain mirrors the rail's
    // serialization (it is semantics-preserving: the rail serializes anyway)
    // and measures how long each probe waited in queue.
    let railTail = Promise.resolve();

    function snippetTimeoutError(ms, queuedMs) {
      const queuedNote = (typeof queuedMs === 'number' && queuedMs > 2000)
        ? ' (' + Math.round(queuedMs) + 'ms of that spent waiting behind the previous probe on the serialized rail)'
        : '';
      return {
        error: 'snippet exceeded ' + ms + 'ms' + queuedNote + ' — size the batch (each hovered anchor burns ~5-10s; narrow with maxContainers, and narrow the anchorSel union to the ONE anchor the hover-derived fields need — every extra union member costs a full hover cycle per card) or pass a larger timeoutMs (≤' + SNIPPET_MAX_TIMEOUT_MS + ')'
      };
    }

    async function runSnippet(snippet, timeoutMs) {
      lastSelectorDiagnostics = null;
      const opts = (typeof timeoutMs === 'number' && timeoutMs > 0)
        ? { timeoutMs: Math.min(timeoutMs, SNIPPET_MAX_TIMEOUT_MS) } : undefined;
      try {
        const env = await executeDsl(snippet, opts);
        if (env && typeof env === 'object' && !Array.isArray(env) && typeof env.error === 'string') return env;
        if (env && typeof env === 'object' && !Array.isArray(env) &&
            typeof env.result !== 'undefined' && Array.isArray(env.selectorDiagnostics)) {
          lastSelectorDiagnostics = env.selectorDiagnostics.length ? env.selectorDiagnostics : null;
          return env.result;
        }
        return env;
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    }

    // F1 race wrapper (see comment above): resolves with runSnippet's value,
    // or the timeoutMs-naming error when the budget elapses first. The call
    // first waits its turn on the local serialization chain (rail mirror);
    // the budget timer starts when the turn begins, so queue wait does not
    // count against the snippet's own budget — but it IS disclosed in the
    // timeout error when it exceeds 2s.
    function runSnippetWithTimeout(snippet, timeoutMs) {
      return new Promise((resolve) => {
        const tEntry = Date.now();
        const prev = railTail;
        let turnDone;
        railTail = new Promise((r) => { turnDone = r; });
        prev.then(() => {
          const queuedMs = Date.now() - tEntry;
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(snippetTimeoutError(timeoutMs, queuedMs));
          }, timeoutMs);
          // The chain slot releases only when the underlying rail call
          // settles — a timed-out probe's rail call keeps running and the
          // NEXT probe still queues behind it, exactly like the rail's lock.
          const p = Promise.resolve().then(() => runSnippet(snippet, timeoutMs));
          p.then((v) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
          }, (e) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve({ error: String((e && e.message) || e) }); }
          });
          p.then(turnDone, turnDone);
        });
      });
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
      const out = { count: n };
      // Twenty-third log: $count matches regardless of visibility while
      // $exists is visibility-gated — surface the split so "count 5 but
      // $exists false" reconciles as hidden-but-readable, not as a mystery.
      const cd = (lastSelectorDiagnostics || []).filter(d => d && d.api === 'count')[0];
      if (cd && typeof cd.invisibleCount === 'number' && cd.invisibleCount > 0) {
        out.visibleCount = typeof cd.visibleCount === 'number' ? cd.visibleCount : null;
        out.invisibleCount = cd.invisibleCount;
        out.note = 'visibility census: ' + out.visibleCount + ' visible / ' + cd.invisibleCount +
          ' invisible of ' + n + ' match(es). $exists is visibility-gated and returns false for the invisible ones; reads ($extract/$list/$extractList) are NOT visibility-gated and read them fine — do not gate a read on $exists.';
      }
      if (observationLog) {
        observationLog.record({ tool: 'probe.count', selectors: [sel], summary: 'count=' + n });
      }
      return out;
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
      const out = {
        totalItems: total,
        values: values,
        absentPct: total ? Math.round(absent / total * 1000) / 10 : 0
      };
      // Twenty-fifth log: absentPct 100 reads as "the attr does not exist in
      // my containers" but attrStats censuses the attr ON the matched
      // elements themselves — :has()/:not(:has()) test DESCENDANTS. Point at
      // the descendant form instead of leaving the scope ambiguity to guess.
      if (total > 0 && out.absentPct >= 100) {
        out.note = 'the attr is not ON any of the ' + total + ' element(s) containerSel matched — attrStats reads attributes on the matched elements THEMSELVES, while :has()/:not(:has()) filter by DESCENDANTS. To census what :has() sees (does the marker exist INSIDE each container, on which share), re-run attrStats with the descendant form: containerSel + " [' + attr + ']".';
      }
      return out;
    }

    // Twenty-fourth-log root fix (hidden-risk follow-up): research-side read
    // of ARIA reference chains — the full tooltip/hovercard value usually
    // lives in the hidden-but-readable element aria-labelledby points at.
    async function labelledby(sel0, attr0) {
      let sel = sel0, attr = attr0;
      if (sel && typeof sel === 'object' && !Array.isArray(sel)) {
        attr = sel.attr;
        sel = sel.sel;
      }
      if (typeof sel !== 'string' || !sel) return { error: 'selector required' };
      if (attr !== undefined && attr !== null && typeof attr !== 'string') return { error: 'attr must be a string (aria-labelledby | aria-describedby)' };
      const snippet = 'return $labelledby(' + JSON.stringify(sel) + ', ' + JSON.stringify(attr || 'aria-labelledby') + ');';
      const r = await runSnippet(snippet);
      if (r && typeof r.error === 'string') return r;
      if (observationLog) {
        observationLog.record({
          tool: 'probe.labelledby',
          selectors: [sel],
          attrs: [{ selector: sel, attr: attr || 'aria-labelledby' }],
          summary: 'labelledby' + (r && typeof r.text === 'string' && r.text ? ' len=' + r.text.length : ' empty')
        });
      }
      // Thirty-second log RC-C: the DSL now returns the self-describing
      // {text, attr, refCount, missingIds, note?} object — pass it through
      // VERBATIM so the probe envelope a step script copies is CORRECT (the
      // old {text}-only envelope taught scripts `.text` on a bare string).
      const isDslShape = r && typeof r === 'object' && typeof r.text === 'string';
      const out = isDslShape
        ? { text: r.text, attr: r.attr || attr || 'aria-labelledby', refCount: typeof r.refCount === 'number' ? r.refCount : 0, missingIds: Array.isArray(r.missingIds) ? r.missingIds : [] }
        : { text: '' };
      const src = isDslShape ? r : null;
      const ld = (lastSelectorDiagnostics || []).filter(d => d && d.api === 'labelledby')[0];
      const note = (src && src.note) || (ld && ld.note);
      if (note) out.note = note;
      else if (!out.text) out.note = 'referenced element(s) resolved but carry no text — check the sibling reference attr (aria-describedby) or read the anchor textContent directly';
      return out;
    }

    // Dossier feed: the most recent HTML a probe actually fetched (raw,
    // capped) — session-tools stashes this as the dossier's container source.
    let lastFetchedHtml = null;
    function stashHtml(html) {
      if (typeof html === 'string' && html) lastFetchedHtml = html.slice(0, 60000);
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
            let html;
            if (o.raw === true) {
              html = rec.h;
            } else if (o.clean === true) {
              // Explicit tier choice stays honored verbatim.
              html = applyClean(rec.h);
            } else {
              // Spec §3.C: skeleton view is the DEFAULT for HTML results; a
              // failed skeleton pass degrades to raw, never errors.
              html = applySkeleton(rec.h, o.skeleton || o);
              if (html === null) html = rec.h;
            }
            out.html = html.slice(0, 30000);
            stashHtml(rec.h);
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
      // Fifty-first log: negative by is a legal scroll-UP (envelope parity
      // with $scrollBy's signed deltaY — the model's "scroll back to
      // re-examine the top of the feed" was blocked). Zero / non-numeric
      // stays an error: a no-op scroll is a bug.
      const by = (typeof a.by === 'number' && Number.isFinite(a.by) && a.by !== 0) ? Math.floor(a.by) : null;
      if (mode === 'by' && !by) return { error: 'by (non-zero pixel count; negative scrolls up) required for mode:"by"' };
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

    // Thirty-ninth log: "scroll until there are N items" could only be
    // expressed as repeated probe.scroll + probe.count turns, and with a
    // selector whose count was structurally frozen the loop degraded to
    // scroll-until-budget — 6+ scroll rounds with the count pinned at 4
    // while the feed itself kept growing. Bound the loop IN the tool: one
    // call scrolls one viewport, settles, re-counts, and stops the moment
    // the population reaches the requirement count. The per-round trace
    // also carries the frozen-count diagnosis (page height grows while the
    // sel count never moves = the selector matches static page chrome, not
    // the growing population) as a single note instead of ten turns of
    // contradictory evidence the model had to correlate by hand.
    async function scrollUntil(args0) {
      const a = args0 && typeof args0 === 'object' ? args0 : {};
      const sel = (typeof a.sel === 'string' && a.sel.trim()) ? a.sel.trim() : null;
      if (!sel) return { error: 'sel required (the population selector counted every round)' };
      const targetCount = (typeof a.targetCount === 'number' && a.targetCount > 0) ? Math.floor(a.targetCount) : null;
      if (!targetCount) return { error: 'targetCount (positive integer) required — the requirement count the scroll loop is bounded by' };
      const scrollSel = (typeof a.scrollSel === 'string' && a.scrollSel.trim()) ? a.scrollSel.trim() : null;
      const maxRounds = Math.max(1, Math.min(25, (typeof a.maxRounds === 'number' && a.maxRounds > 0) ? Math.floor(a.maxRounds) : 8));
      const settleMs = Math.max(100, Math.min(5000, (typeof a.settleMs === 'number' && a.settleMs > 0) ? Math.floor(a.settleMs) : 1200));
      const by = (typeof a.by === 'number' && a.by > 0) ? Math.floor(a.by) : 800;
      const receiptSelectors = [sel].concat(scrollSel ? [scrollSel] : []);

      const r0 = await runSnippet('return $count(' + JSON.stringify(sel) + ');');
      if (r0 && typeof r0.error === 'string') return r0;
      let count = typeof r0 === 'number' ? r0 : 0;
      if (count >= targetCount) {
        if (observationLog) {
          observationLog.record({
            tool: 'probe.scrollUntil',
            selectors: receiptSelectors,
            summary: 'scrollUntil 0 rounds — already ' + count + '/' + targetCount
          });
        }
        return { satisfied: true, finalCount: count, targetCount: targetCount, rounds: 0, trace: [{ count: count, y: null, h: null }], reason: 'target_reached' };
      }

      const heightSel = scrollSel || 'html';
      const roundSnippet =
        'const __c0 = await $count(' + JSON.stringify(sel) + ');\n' +
        'const __s = await $scrollBy(' + by + (scrollSel ? ', ' + JSON.stringify(scrollSel) : '') + ');\n' +
        'await new Promise(r => setTimeout(r, ' + settleMs + '));\n' +
        'const __c1 = await $count(' + JSON.stringify(sel) + ');\n' +
        'const __h = await $check(' + JSON.stringify(heightSel) + ', "scrollHeight");\n' +
        'return { c0: __c0, c1: __c1, scrolled: __s.scrolled, y: __s.newY, h: __h };';

      const initialCount = count;
      const trace = [];
      let heightEverGrew = false;
      let prevH = null;
      let stillRounds = 0;
      let reason = 'max_rounds';
      for (let i = 0; i < maxRounds; i++) {
        const r = await runSnippet(roundSnippet);
        if (r && typeof r.error === 'string') return r;
        if (!r || typeof r !== 'object') return { error: 'unexpected scrollUntil round result shape' };
        const h = typeof r.h === 'number' ? r.h : null;
        const grew = prevH !== null && h !== null && h > prevH;
        if (grew) heightEverGrew = true;
        const moved = !!r.scrolled || grew;
        stillRounds = moved ? 0 : stillRounds + 1;
        prevH = h;
        count = typeof r.c1 === 'number' ? r.c1 : count;
        trace.push({ count: count, y: (typeof r.y === 'number' ? r.y : null), h: h });
        if (count >= targetCount) { reason = 'target_reached'; break; }
        if (stillRounds >= 2) { reason = 'at_bottom'; break; }
      }

      const satisfied = count >= targetCount;
      if (!satisfied && count === initialCount && heightEverGrew) reason = 'count_frozen';
      const out = {
        satisfied: satisfied,
        finalCount: count,
        targetCount: targetCount,
        rounds: trace.length,
        trace: trace,
        reason: reason
      };
      if (reason === 'count_frozen') {
        out.note = 'page height grew across ' + trace.length + ' scroll round(s) but the sel count never changed from ' + initialCount + ' — sel matches static page chrome, not the growing population (wrong selector, not missing data). Census what actually grows between scrolls (probe.count candidate containers before/after one probe.scroll) and re-target sel; scrolling further cannot raise this count.';
      } else if (reason === 'at_bottom') {
        out.note = 'scroll position and page height both stopped changing under the scroll root tested — the population reachable by THIS scroll path is exhausted at ' + count + ' item(s) under this selector (target ' + targetCount + '). This proves the tested root is at its bottom, NOT that the page has no more data: when the site scrolls its feed inside an INNER overflow container the window sits still while the feed has more. If the $scrollBy rounds carried fallback:"inner-container" the infra already found and scrolled one (keep scrolling); otherwise retry with scrollSel set to the feed\'s own scrollable container (an overflow:auto/scroll ancestor of the items) before concluding the data is all there is.';
      } else if (reason === 'max_rounds') {
        out.note = 'reached the ' + maxRounds + '-round cap at ' + count + '/' + targetCount + ' — the population was still growing; re-run scrollUntil to continue from the current position, or raise maxRounds.';
      }
      if (observationLog) {
        observationLog.record({
          tool: 'probe.scrollUntil',
          selectors: receiptSelectors,
          summary: 'scrollUntil ' + count + '/' + targetCount + ' reason=' + reason
        });
      }
      return out;
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
      // Thirty-first log: hover-layer evidence MUST survive the probe layer.
      // budgetNote/timeoutMs (popover_timeout waited N ms — absence at N ms
      // says nothing about a larger budget) and rejectedAddedTexts (the
      // twenty-fourth-log readable-mounts evidence) are both taught in the
      // toolSpec and rule 6, but this object silently dropped them — the
      // teaching promised fields the plumbing never delivered.
      if (typeof r.budgetNote === 'string' && r.budgetNote) {
        out.budgetNote = r.budgetNote;
        if (typeof r.timeoutMs === 'number') out.timeoutMs = r.timeoutMs;
      }
      if (Array.isArray(r.rejectedAddedTexts) && r.rejectedAddedTexts.length) {
        out.rejectedAddedTexts = r.rejectedAddedTexts;
        if (typeof r.rejectedAddedNote === 'string' && r.rejectedAddedNote) out.rejectedAddedNote = r.rejectedAddedNote;
      }
      // Hundred-third log: the rejected mounts' HTML fragments — the
      // text-bearing leaves the size gate turned away; structure + attributes
      // a match predicate binds against (the picked popover's markup can bury
      // the same content past the 2000-char match guard).
      if (Array.isArray(r.rejectedAddedHtml) && r.rejectedAddedHtml.length) {
        out.rejectedAddedHtml = r.rejectedAddedHtml.slice(0, 3).map((h) => (h.length > 1200 ? h.slice(0, 1200) + '<!--capped-->' : h));
      }
      // Forty-second log: the anchor-label harvest taken at dwell time
      // (before the dismiss). Same contract as the fields above — hover-layer
      // evidence must survive the probe layer, or the teaching that names it
      // is a promise the plumbing never delivers.
      if (typeof r.labelledbyText === 'string' && r.labelledbyText) {
        out.labelledbyText = r.labelledbyText;
        if (typeof r.labelledbyAttr === 'string' && r.labelledbyAttr) out.labelledbyAttr = r.labelledbyAttr;
      }
      if (typeof r.labelledbyNote === 'string' && r.labelledbyNote) {
        out.labelledbyNote = r.labelledbyNote;
      }
      if (canonical) {
        out.popoverSelectorNote = 'canonical popoverSelector derived from the observed popover — an observation receipt was recorded for THIS EXACT STRING. If you configure popoverSel in a step, copy it VERBATIM; an embellished variant (e.g. adding [aria-modal=\'true\']) is a new string the grounding gate must reject.';
      } else if (out.htmlSnippet) {
        out.popoverSelectorNote = 'auto-discovery captured the popover HTML but no stable token (id, aria-label, role, or a single stable class token with a value of 60 chars or less) could be derived from its opening tags. Read htmlSnippet, pick a specific selector you can SEE in it (e.g. div[aria-label=\'...\']), and pass it as popoverSel to probe.hover again — a run that observes the popover via that selector records the receipt.';
      }
      return out;
    }

    // Fifty-sixth log (user directive: model-capability walls deserve TOOLS,
    // not more prompt-preaching): the absolute-timestamp wall recurred across
    // logs 15/24/28/31/52/55/56 — models re-discover the same dance every
    // session at 5-10 turns each (candidate anchors → hover → labelledby →
    // regex filtering) and still finish with "only sometimes reachable".
    // ONE composite call does the whole dance: it extracts the time-ish
    // anchors of ONE container through $extractWithHover (which hovers every
    // anchor and harvests labelledbyText at dwell, cold-tab re-read included)
    // and returns ONLY date-shaped candidates (the fifty-second-log shape
    // rules), preferring an ABSOLUTE value over a relative age.
    let __wuBag = null;
    function looksLikeDateRef(v) {
      if (!__wuBag) {
        if (typeof require !== 'undefined') {
          try { __wuBag = require('./wizard-utils'); } catch (e) { __wuBag = null; }
        }
        if (!__wuBag && typeof global !== 'undefined' && global.__wizardUtilsModuleMarker__) __wuBag = global.__wizardUtilsModuleMarker__;
      }
      if (__wuBag && typeof __wuBag.looksLikeDate === 'function') return __wuBag.looksLikeDate(v);
      // Degraded fallback (page context without wizard-utils): permissive.
      return /\d/.test(String(v == null ? '' : v));
    }
    // Sixty-fourth log: date-shaped SUBSTRING extraction for long strings —
    // the whole-string predicate lets prose that merely mentions a duration
    // ("…in 20 years…") pass, and the absolute value often lives INSIDE a
    // captured popover snippet rather than in any single anchor attribute.
    function extractDateSubstringsRef(v) {
      if (__wuBag && typeof __wuBag.extractDateSubstrings === 'function') return __wuBag.extractDateSubstrings(v);
      const m = String(v == null ? '' : v).match(/\d{4}-\d{1,2}-\d{1,2}/);
      return m ? [m[0]] : [];
    }
    // Sixty-ninth log: full-vs-partial absolute classification. "August 2"
    // (labelledby) is date-shaped and not relative, so the binary relative
    // flag blessed it as a FULL absolute while the hover tooltip carried the
    // year-carrying date — and the model bound the cheap value, never
    // touching read:'hoverPopover'. partial marks year-less absolutes; a
    // full absolute (year token present) outranks them in the pick order.
    function hasYearTokenRef(v) {
      if (__wuBag && typeof __wuBag.hasYearToken === 'function') return __wuBag.hasYearToken(v);
      // Degraded fallback (page context without wizard-utils): 4-digit
      // 19xx/20xx token only — misses CJK 年 dates but never false-positives.
      return /\b(?:19|20)\d{2}\b/.test(String(v == null ? '' : v));
    }

    async function timestamp(args0) {
      const a = args0 && typeof args0 === 'object' ? args0 : {};
      const containerSel = (typeof a.containerSel === 'string' && a.containerSel.trim()) ? a.containerSel.trim() : null;
      if (!containerSel) {
        return { error: 'containerSel (required) — the repeating card container whose timestamp you are binding. The probe hovers its time-ish anchors once and returns date-shaped candidates only (absolute preferred).' };
      }
      const index = (typeof a.index === 'number' && a.index >= 0) ? Math.floor(a.index) : 0;
      // Ninety-ninth round (user ground truth: the time tooltip ALWAYS carries
      // the full date): a custom anchorSel is UNIONED with the default
      // time-anchor union, never a replacement — two live sessions hovered
      // spans-only custom anchors and concluded "no year on these cards"
      // while the timestamp <a> (in the default union) was never hovered.
      const DEFAULT_TS_ANCHORS = 'a:has(span[aria-labelledby]), [aria-labelledby], abbr[aria-label], time';
      const customAnchorSel = (typeof a.anchorSel === 'string' && a.anchorSel.trim()) ? a.anchorSel.trim() : '';
      const anchorSel = customAnchorSel ? (customAnchorSel + ', ' + DEFAULT_TS_ANCHORS) : DEFAULT_TS_ANCHORS;
      const snippet = 'return $extractWithHover(' + JSON.stringify(containerSel) + ', {' +
        '__t_label: { selector: ' + JSON.stringify(anchorSel) + ', labelledby: true },' +
        '__t_aria: { selector: ' + JSON.stringify(anchorSel) + ', attr: "aria-label" },' +
        '__t_text: { selector: ' + JSON.stringify(anchorSel) + ' }' +
        '}, { hover: { anchorSel: ' + JSON.stringify(anchorSel) + ' }, containerIndex: ' + index + ' });';
      const r = await runSnippet(snippet);
      if (r && typeof r.error === 'string') return r;
      const rec = Array.isArray(r) ? r[0] : null;
      if (!rec) return { error: 'no containers matched ' + containerSel + ' — check the container selector before concluding anything about timestamps' };
      const REL = /\b(?:second|minute|hour|day|week|month|year)s?\s+ago\b|[0-9一二三四五六七八九十百千]+\s*(?:秒|分钟|分|小时|时|天|日|周|月|年)/i;
      const candidates = [];
      // Sixty-fourth log, two defects fixed in one gate:
      //   (a) MASQUERADE — the 64th session's probe.timestamp returned
      //       "Ng6cOb30.comCatThis week mathematicians used AI … in 20
      //       years…" in the ABSOLUTE slot: the whole-string predicate
      //       passed it via \b\d+\s*years\b and REL found no "ago", so
      //       prose that MENTIONS a duration became a "date". Long strings
      //       are prose — they contribute date-shaped SUBSTRINGS only.
      //   (b) POPOVER BLINDNESS — the harvest read only anchor
      //       labelledby/aria/text; the absolute timestamp usually lives in
      //       the hover-mounted tooltip's own text (htmlSnippet), which was
      //       never a source. The tool's confident "no absolute" receipts
      //       were then quoted by the model into "the timestamp hovercard
      //       never renders a full-date popover" — an environmental claim
      //       contradicted by its own earlier manual hover capture.
      const MAX_WHOLE_VALUE_CHARS = 60;
      const push = (value, source) => {
        const str = typeof value === 'string' ? value.trim() : '';
        if (!str) return;
        if (str.length <= MAX_WHOLE_VALUE_CHARS) {
          if (looksLikeDateRef(str)) candidates.push({ value: str.slice(0, 120), source: source, relative: REL.test(str), partial: !REL.test(str) && !hasYearTokenRef(str) });
          return;
        }
        for (const sub of extractDateSubstringsRef(str)) {
          const v = String(sub).slice(0, 120);
          candidates.push({ value: v, source: source, relative: REL.test(v), partial: !REL.test(v) && !hasYearTokenRef(v) });
        }
      };
      push(rec.__t_label, 'labelledby');
      push(rec.__t_aria, 'aria-label');
      push(rec.__t_text, 'text');
      for (const h of (rec.hovercards || [])) {
        if (!h) continue;
        push(h.labelledbyText, 'hover.labelledbyText');
        push(h.anchorText, 'hover.anchorText');
        // Ninetieth-round F2b: rejectedAddedTexts — text READ out of
        // became-visible strips the visual picker turned away (narrow
        // tooltip bars). Reads are not visibility-gated; a full-absolute
        // date there is the tooltip payload.
        if (Array.isArray(h.rejectedAddedTexts)) {
          for (const rej of h.rejectedAddedTexts) push(rej, 'hover.rejectedText');
        }
        // Hundred-third log: the rejected mounts' HTML fragments ride the
        // hovercards — same date-candidate harvest as the journal above.
        if (Array.isArray(h.rejectedAddedHtml)) {
          for (const rhtml of h.rejectedAddedHtml) {
            const rtxt = String(rhtml || '').replace(/<[^>]*>/g, ' ');
            for (const rsub of extractDateSubstringsRef(rtxt)) push(rsub, 'hover.rejectedDom');
          }
        }
        // Ninety-first-round user directive: the dynamic-DOM journal — every
        // node the hover rendered before mouse-out unmounted it, picker
        // verdicts not gating. A full-absolute date in here IS the tooltip
        // payload even when the visual picker never blessed the strip.
        if (Array.isArray(h.addedNodesHtml)) {
          for (const html of h.addedNodesHtml) {
            const txt = String(html || '').replace(/<[^>]*>/g, ' ');
            for (const sub of extractDateSubstringsRef(txt)) push(sub, 'hover.addedDom');
          }
        }
        // The captured popover's own text — popover markup is structurally
        // prose ("Shared with Public · Friday, September 11, 2026 at …"), so
        // it NEVER takes the whole-value path: strip markup and extract the
        // date-shaped substrings.
        if (h.htmlSnippet) {
          const popText = String(h.htmlSnippet).replace(/<[^>]*>/g, ' ');
          for (const sub of extractDateSubstringsRef(popText)) {
            const v = String(sub).slice(0, 120);
            candidates.push({ value: v, source: 'hover.popoverText', relative: REL.test(v), partial: !REL.test(v) && !hasYearTokenRef(v) });
          }
        }
      }
      // G3 (seventy-second log): zero-hover negative firewall. When every
      // hovercards entry failed (hovered:false / no dispatch) and none
      // captured a popover (htmlSnippet), the popover route was NEVER
      // exercised — a "no popover-borne value exists" conclusion from this
      // run is tool-blindness quoted as page fact, not evidence.
      const cards = Array.isArray(rec.hovercards) ? rec.hovercards : [];
      const anyHoverEvidence = cards.some((h) => h && (h.hovered === true || h.hoverDispatched === true || h.htmlSnippet));
      const zeroHoverBlind = !anyHoverEvidence && candidates.length > 0;
      // Pick order (sixty-ninth log): full absolute (no relative flag, year
      // token present) → partial absolute (year-less month-day) → relative.
      const absolute = (candidates.find((c) => !c.relative && !c.partial) ||
                        candidates.find((c) => !c.relative) || null);
      const relative = (candidates.find((c) => c.relative) || null);
      // Ninety-first-round anchorLog: per-anchor hover reality — what was
      // hovered, what mounted, what the picker did — so a tooltip that
      // never yields is diagnosable from the receipt instead of guessed at.
      // Ninety-fourth-round: addedNodes COUNTS alone cannot adjudicate "the
      // tooltip never mounts" — nodes may mount and ALL get rejected by the
      // picker (live: addedNodes:3 + reason no_hover_signal_early_exit).
      // Sample the journal texts so the receipt shows WHAT mounted.
      const stripTagsLocal = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const anchorLog = cards.slice(0, 5).map((h, i) => ({
        anchor: i,
        desc: String((h && h.anchorText) || (h && h.labelledbyText) || '').slice(0, 40) || null,
        href: (h && h.anchorHref) ? String(h.anchorHref).slice(0, 80) : null,
        hovered: !!(h && (h.hovered === true || h.hoverDispatched === true)),
        captured: !!(h && h.htmlSnippet),
        reason: (h && h.reason) || null,
        addedNodes: Array.isArray(h && h.addedNodesHtml) ? h.addedNodesHtml.length : 0,
        addedTexts: Array.isArray(h && h.addedNodesHtml)
          ? [...new Set(h.addedNodesHtml.map((html) => stripTagsLocal(html).slice(0, 100)).filter(Boolean))].slice(0, 5)
          : []
      }));
      const out = {
        containerSel: containerSel,
        anchorSel: anchorSel,
        anchorLog: anchorLog,
        // 机械-语义分离（spec 3.B）：heuristicValue 是日历通用正则的
        // 便捷默认（value 为旧名别名，保留一个版本周期）；识别职责归
        // 研究期 LLM —— candidates[]（原文+来源）才是一等公民。
        heuristicValue: absolute ? absolute.value : (relative ? relative.value : ''),
        value: absolute ? absolute.value : (relative ? relative.value : ''),
        absolute: absolute ? absolute.value : null,
        absoluteSource: absolute ? absolute.source : null,
        relative: relative ? relative.value : null,
        candidates: candidates
      };
      if (!candidates.length) {
        // Eighty-fifth log: a zero-anchor run is a VACUOUS negative — all
        // three probe layers (labelledby/aria/text reads + the hover batch)
        // key on the SAME anchorSel, so a selector that matches nothing
        // inside the container reads nothing and hovers nothing, and the
        // old "these anchors expose no timestamp" note read as a page fact
        // (the feedback session shipped partial absolutes off exactly this
        // shape). The 84th-round anchor census already rides the
        // extractWithHover diagnostics — surface it in the receipt and
        // teach the descendant-direction trap.
        if (!cards.length) {
          const ehDiag = (lastSelectorDiagnostics || []).filter((d) => d && d.api === 'extractWithHover')[0] || null;
          const anchorCensus = (ehDiag && ehDiag.anchorCensus) || null;
          let censusText = '';
          if (anchorCensus && anchorCensus.families && typeof anchorCensus.families === 'object') {
            out.anchorCensus = anchorCensus;
            const fam = Object.keys(anchorCensus.families).map((k) => k + '×' + anchorCensus.families[k]).join(', ');
            censusText = ' ANCHOR CENSUS (this container): ' + fam + '.' +
              (Array.isArray(anchorCensus.hrefSamples) && anchorCensus.hrefSamples.length
                ? ' href samples: ' + JSON.stringify(anchorCensus.hrefSamples.slice(0, 5)) + '.' : '');
          }
          out.note = 'VACUOUS NEGATIVE — anchorSel matched 0 anchors inside the container, so nothing was read or hovered; this is a selector miss, not a page fact.' + censusText +
            ' Rewrite anchorSel against the census families — mind the descendant direction: a:has(span[aria-labelledby]) is the link CONTAINING the labelledby span, while span[aria-labelledby] a demands an <a> INSIDE the span and usually matches nothing — or drop anchorSel entirely to run the default union.';
        } else {
          out.note = 'no date-shaped value on the anchors THIS call hovered (labelledby / aria-label / text, hover-mounted popover text included). If a second probe.timestamp with a narrower anchorSel over the timestamp element itself also fails, these anchors expose no timestamp — renegotiate the field via io.confirm instead of shipping titles or relative ages as postTime.';
        }
      } else if (!absolute) {
        out.note = 'only RELATIVE ages are date-shaped here — the absolute value needs the hover-mounted tooltip: re-run with a narrower anchorSel over the timestamp link itself; if that also yields only relative ages, renegotiate — or bind the relative age itself with a finish disclosure: the verify RELATIVE_TIMESTAMP tag is report-only and an empty required field is worse than a disclosed relative value.';
      } else if (absolute.partial) {
        // Distinct from the only-relative case above: an absolute WAS found,
        // but it lacks a year. Keep both notes mutually exclusive so the
        // model can tell which situation it is in.
        out.note = 'the absolute candidate lacks a YEAR (month-day only — recent items often render relative ages while older ones render month-day; this population mixes them). If the year or clock time matters, the hover tooltip usually carries the full date: inspect with probe.hover, then bind the field via read:\'hoverPopover\' with your own match regex.';
      }
      if (zeroHoverBlind) {
        out.note = (out.note ? out.note + '\n' : '') +
          'NOTICE: zero anchors were actually hovered this call (all anchors box-less or dispatch-refused) — the popover route is UNVERIFIED for this card; do NOT conclude the page lacks a popover-borne value: scroll the card into view and re-run, or inspect manually with probe.hover before claiming absence.';
      }
      if (observationLog) {
        observationLog.record({
          tool: 'probe.timestamp',
          selectors: [containerSel],
          summary: 'timestamp probe heuristicValue=' + JSON.stringify(out.heuristicValue) + ' absolute=' + JSON.stringify(out.absolute) + ' relative=' + JSON.stringify(!!out.relative)
        });
      }
      return out;
    }

    // Fifty-ninth-log correction (user-reported): a session's model asserted
    // "unauthenticated page" from page SHAPE (recommendation cards) with zero
    // login-marker evidence — and the claim propagated into conclusions. The
    // browser was logged in the whole time; the 55th/58th sessions on the
    // SAME browser extracted real posts. Environmental claims need EVIDENCE:
    // one call returns the generic login/logout marker census with an
    // interpretation, so "requires login" / "logged-out" conclusions quote
    // numbers instead of vibes.
    async function loginState() {
      const snippet = 'return {' +
        'passwordFields: await $count(\'input[type=password]\'),' +
        'loginLinks: await $count(\'a[href*="login"], a[href*="signin"]\'),' +
        'logoutMarkers: await $count(\'a[href*="logout"], form[action*="logout"], button[name*="logout"], [role="menuitem"][href*="logout"]\')' +
        '};';
      const r = await runSnippet(snippet);
      if (r && typeof r.error === 'string') return r;
      const ev = (r && typeof r === 'object') ? r : {};
      const out = {
        evidence: {
          passwordFields: Number(ev.passwordFields) || 0,
          loginLinks: Number(ev.loginLinks) || 0,
          logoutMarkers: Number(ev.logoutMarkers) || 0
        }
      };
      if (out.evidence.logoutMarkers > 0 && out.evidence.passwordFields === 0) {
        out.loggedIn = true;
        out.loginWall = false;
        out.note = 'logout markers present and no password fields — the session IS logged in. Do NOT attribute empty results to authentication; look for population/selector/throttling causes instead.';
      } else if (out.evidence.passwordFields > 0 && out.evidence.logoutMarkers === 0) {
        out.loggedIn = false;
        out.loginWall = true;
        out.note = 'password fields and login links present with no logout markers — this page is a login wall / logged-out view. Before concluding the SERVICE needs login, retry once after a page.settle (SPA shells mount the form first).';
      } else {
        out.loggedIn = null;
        out.loginWall = null;
        out.note = 'no decisive markers on this view (SPA shells often render neither). Retry after page.settle, or sample the account-menu region ([aria-haspopup=menu]) before asserting ANY login state. Never write "requires login" or "unauthenticated" into a ledger finding or finish without this census.';
      }
      if (observationLog) {
        observationLog.record({ tool: 'probe.loginState', selectors: [], summary: 'loginState loggedIn=' + JSON.stringify(out.loggedIn) + ' wall=' + JSON.stringify(out.loginWall) + ' evidence=' + JSON.stringify(out.evidence) });
      }
      return out;
    }

    // Harness 对标（2026-09-11 用户指示 ④）：Claude-Code 式"先跑再写"——任意
    // DSL 片段在研究页试跑，原始返回（截断）。装配逻辑先在此验证，再写进
    // service.update，8 版本盲改的迭代模式变成 1 次试跑。
    async function snippet(args0) {
      const a = args0 && typeof args0 === 'object' ? args0 : {};
      const code = typeof a.code === 'string' ? a.code : '';
      if (!code.trim()) return { error: 'code (required) — an async function BODY using the $ API; MUST contain a top-level return' };
      if (code.length > 8000) return { error: 'code too long (' + code.length + ' chars, max 8000) — split the experiment' };
      if (!/\breturn\b/.test(code)) return { error: 'snippet must contain a top-level return statement (STEP_NO_RETURN otherwise)' };
      let timeoutMs = SNIPPET_DEFAULT_TIMEOUT_MS;
      if (a.timeoutMs != null) {
        if (typeof a.timeoutMs !== 'number' || !isFinite(a.timeoutMs) || a.timeoutMs <= 0) {
          return { error: 'timeoutMs must be a positive number of milliseconds (default ' + SNIPPET_DEFAULT_TIMEOUT_MS + ', max ' + SNIPPET_MAX_TIMEOUT_MS + ')' };
        }
        // Cap, don't reject: a caller asking 100000 gets 90000, the most
        // the probe lane will ever spend on one experiment.
        timeoutMs = Math.min(Math.floor(a.timeoutMs), SNIPPET_MAX_TIMEOUT_MS);
      }
      const r = await runSnippetWithTimeout(code, timeoutMs);
      // Code-review P3: r.error is a failure ONLY when it is the sole own
      // key — a snippet legitimately returning {error:'x', data:1} (e.g. an
      // $openTab result envelope or the model's own shaped return) passed
      // through as data before; the old check swallowed it into a tool error.
      if (r && typeof r.error === 'string' && Object.keys(r).length === 1) return { error: r.error };
      // Spec §3.C passthrough: HTML-bearing result fields default to the
      // skeleton view too (raw:true opts out) — a snippet returning
      // outerHTML samples reads as a numbered skeleton, not 4K of noise.
      let skeletonized = false;
      if (a.raw !== true) {
        const skel = (v) => {
          if (typeof v === 'string' && v.length > 300 && v.indexOf('<') !== -1) {
            const s = applySkeleton(v, { capChars: 4000 });
            if (typeof s === 'string' && s) { skeletonized = true; return s; }
          }
          return v;
        };
        const walk = (node, depth) => {
          if (!node || typeof node !== 'object' || depth > 6) return node;
          if (Array.isArray(node)) return node.map(x => walk(x, depth + 1));
          const out = {};
          for (const k of Object.keys(node)) {
            out[k] = /^(h|html|outerHTML|htmlSnippet)$/i.test(k) ? skel(node[k]) : walk(node[k], depth + 1);
          }
          return out;
        };
        try { r = walk(r, 0); } catch (e) { /* passthrough untouched */ }
      }
      let out;
      try { out = JSON.stringify(r, null, 1); } catch (e) { out = String(r); }
      const capped = out.length > 4000;
      // Code-review P3: log the code head + hash so the observation log can
      // correlate results with WHICH experiment ran.
      let codeHead = '';
      try { codeHead = code.replace(/\s+/g, ' ').trim().slice(0, 80); } catch (_) { codeHead = ''; }
      let codeHash = 0;
      for (let i = 0; i < code.length; i++) { codeHash = ((codeHash * 31) + code.charCodeAt(i)) | 0; }
      const passthrough = !!(r && typeof r === 'object' && typeof r.error === 'string');
      if (observationLog) observationLog.record({ tool: 'probe.snippet', selectors: [], summary: 'snippet ' + code.length + ' chars hash=' + codeHash + ' head=' + JSON.stringify(codeHead) });
      const res = { result: capped ? out.slice(0, 2000) + '…[+' + (out.length - 4000) + ' chars]…' + out.slice(-2000) : out, truncated: capped };
      if (passthrough) res.note = 'result carried an error field; passed through';
      if (skeletonized) res.skeletonized = true;
      return res;
    }

    // Skeleton-dossier (2026-09-18 spec §3.A exposure): model-directed
    // cleaning as a TOOL — the numbered skeleton of the Nth match of sel,
    // with the full cleaning-capability knob set passed through. This is the
    // view the dossier's CONTAINER SKELETON section is built from, available
    // on demand for any selector with per-call cleaning parameters.
    async function skeleton(args0) {
      let a = args0 && typeof args0 === 'object' && !Array.isArray(args0) ? args0 : {};
      const sel = typeof a.sel === 'string' ? a.sel.trim() : '';
      if (!sel) return { error: 'sel required' };
      const index = typeof a.index === 'number' && a.index >= 0 ? Math.floor(a.index) : 0;
      const o = (a.opts && typeof a.opts === 'object') ? a.opts : a;
      const fieldMap = { h: { attr: 'outerHTML' } };
      const r = await runSnippet('return $extractList(' + JSON.stringify(sel) + ', ' + JSON.stringify(fieldMap) + ');');
      if (r && typeof r.error === 'string') return r;
      const recs = Array.isArray(r) ? r : (r && Array.isArray(r.records) ? r.records : []);
      const rec = recs[index];
      if (!rec || typeof rec.h !== 'string' || !rec.h) return { error: 'no match ' + index + ' for ' + JSON.stringify(sel) + ' (' + recs.length + ' match(es))' };
      if (observationLog) {
        observationLog.record({ tool: 'probe.skeleton', selectors: [sel], summary: 'skeleton index=' + index });
      }
      if (o.raw === true) { stashHtml(rec.h); return { total: recs.length, match: index, raw: rec.h.slice(0, 30000) }; }
      const sk = applySkeleton(rec.h, o);
      stashHtml(rec.h);
      if (typeof sk !== 'string' || !sk) {
        return { total: recs.length, match: index, error: 'skeleton view unavailable (no cleaner/parser wired) — retry with opts.raw:true' };
      }
      return { total: recs.length, match: index, skeleton: sk };
    }

    return { count, text, attrStats, labelledby, sample, hover, scroll, scrollUntil, extract, timestamp, loginState, snippet, skeleton, getLastSelectorDiagnostics: () => lastSelectorDiagnostics, getLastFetchedHtml: () => lastFetchedHtml };
  }

  const api = { createProbeTools };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ProbeTools = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
