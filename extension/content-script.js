(function() {
  'use strict';

  // Forty-first log: whole-card `attr: 'outerHTML'` fields came back
  // 82396-99278 chars each (result.json: 332KB for 3 posts). ElementData caps
  // textContent at 50000 — element-HTML property reads get the same budget,
  // with an in-value disclosure comment so consumers know the value was cut.
  // Self-contained on purpose: domExtract and createInlineListExtractOps both
  // call it, and the test harness slices it out of source to pin behavior.
  function capElementHtmlRead(value) {
    const cap = 50000;
    if (typeof value !== 'string' || value.length <= cap) return value;
    return value.slice(0, cap) + '<!--TRUNCATED: element HTML capped at ' + cap + ' of ' + value.length + ' chars-->';
  }

  // lib/list-extract-ops.js (loaded as an earlier content script) attaches its
  // API as `window.ListExtractOps`. Inside this strict-mode IIFE, a free
  // identifier reference does NOT resolve to a `window` property — it must be
  // captured lexically. Without this alias, `$extractList` / `$clickInList`
  // throw "ListExtractOps is not defined" at call time.
  //
  // Lookup is LAZY + has an INLINE FALLBACK. bugx.log (2026-07-23 16:26)
  // showed that even after the manifest-correct load order, the user's browser
  // ended up with window.ListExtractOps undefined at call time — likely a
  // Chrome MV3 caching/injection glitch after a mid-session reload. When that
  // happens, we build the same tiny API inline (the functions are ~50 lines
  // total) so $extractList / $clickInList always work regardless of whether
  // the separate file made it in. lib/list-extract-ops.js remains the source
  // of truth for Node tests; this fallback is a defensive duplicate.
  // ⚠️ DRIFT GUARD: This inline object MUST mirror the public `api` export
  // of lib/list-extract-ops.js exactly (function names + behavior). The drift
  // guard test (test/inline-list-extract-ops-drift.test.js) asserts that
  // `Object.keys(api).sort()` matches `Object.keys(inlineApi).sort()`. If you
  // add a function to one, add a stub/real impl to the other in the same
  // commit — otherwise the inline fallback silently loses capabilities when
  // the MV3 injection glitch triggers it (see bugx.log 2026-07-23 + the
  // console.log 2026-07-26 regression where $extractListMultiRecords was
  // missing from this fallback and the LLM-generated script crashed at step
  // 4 with "ops.extractListMultiRecords is not a function").
  function createInlineListExtractOps() {
    // DOM properties that look like attributes but aren't — getAttribute
    // returns null for these. Read from the element directly when `attr`
    // names one of them. Mirrors lib/list-extract-ops.js (RC5 fix).
    const DOM_PROPERTY_READS = new Set(['outerHTML', 'innerHTML']);

    // 机械-语义分离（spec 3.A，inline 镜像 lib/list-extract-ops.js）：match
    // 是 LLM 自写正则——基建只应用，不解释（谓词零知识）。命中即取整个
    // 原文值，未命中得空串；非法正则报错教重写。
    function compileMatch(spec) {
      const m = (spec && typeof spec === 'object' && typeof spec.match === 'string') ? spec.match : null;
      if (m == null) return null;
      try { return new RegExp(m); }
      catch (e) { throw new Error('field match is not a valid regex (' + m + '): ' + (e && e.message) + ' — rewrite the predicate; the harness applies it verbatim and never interprets it'); }
    }
    function applyMatch(value, re) {
      if (!re) return value;
      if (Array.isArray(value)) {
        // Code-review P1 (inline mirror): preserve the array envelope —
        // multi:true inputs yield the FILTERED ARRAY of passing values.
        return value.filter(function (v) { return testMatchValue(v, re); });
      }
      return testMatchValue(value, re) ? value : '';
    }
    // Code-review P2 hardening (inline mirror): defensive lastIndex reset +
    // >2000-char strings matched against their FIRST 2000 chars only
    // (backtracking hang guard). Sixty-ninth review F8 (inline mirror): the
    // guard used to return FALSE silently for long strings; it now tests the
    // bounded prefix and counts the skipped guard for diagnostics.
    const MATCH_GUARD_LIMIT = 2000;
    let matchGuardSkips = 0;
    function testMatchValue(v, re) {
      if (typeof v !== 'string') return false;
      let s = v;
      if (s.length > MATCH_GUARD_LIMIT) {
        matchGuardSkips += 1;
        s = s.slice(0, MATCH_GUARD_LIMIT);
      }
      re.lastIndex = 0;
      return re.test(s);
    }
    // F9 (inline mirror): hover-read candidate caps move out of records
    // into this per-call map, lifted into _diagnostics.hoverReadCapped.
    let hoverReadCappedByField = null;
    function getMatchGuardSkips() { return matchGuardSkips; }
    function resetMatchGuardSkips() { matchGuardSkips = 0; }
    function getHoverReadCapped() { return hoverReadCappedByField; }
    function isHoverPopoverSpec(spec) {
      return !!(spec && typeof spec === 'object' &&
        (spec.read === 'hoverPopover' || spec.read === 'hoverPopoverHtml'));
    }
    function stripTags(html) {
      return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function readField(container, spec) {
      // Forty-eighth log (inline mirror of lib/list-extract-ops.js): a
      // multi:true spec reads ALL matches — probe.extract {multi:true}
      // parity, so a fieldMap dry-runned through a multi probe keeps its
      // array envelope when pasted into a step.
      if (spec && typeof spec === 'object' && spec.multi === true) {
        return readFieldAll(container, spec);
      }
      const sel = typeof spec === 'string' ? spec : spec.selector;
      const attr = typeof spec === 'string' ? null : spec.attr;
      // Thirty-third log D1 (mirrors lib/list-extract-ops.js): labelledby
      // resolves the ARIA reference on the match — the anti-scrape decoy in
      // textContent is bypassed. Takes precedence over attr (the raw attr
      // value is an id list, never human text). resolveLabelledbyText is
      // hoisted into this IIFE's scope.
      const lb = (spec && typeof spec === 'object') ? spec.labelledby : undefined;
      const refAttr = lb === true ? 'aria-labelledby'
        : (typeof lb === 'string' && lb.trim() ? lb.trim() : null);
      if (!sel) {
        if (refAttr) return resolveLabelledbyText(container, refAttr).text;
        if (attr) {
          if (DOM_PROPERTY_READS.has(attr)) return capElementHtmlRead(container[attr]);
          return container.getAttribute(attr);
        }
        return (container.textContent || '').trim();
      }
      const el = container.querySelector(sel);
      if (!el) return undefined;
      if (refAttr) return resolveLabelledbyText(el, refAttr).text;
      if (attr) {
        if (DOM_PROPERTY_READS.has(attr)) return capElementHtmlRead(el[attr]);
        return el.getAttribute(attr);
      }
      return (el.textContent || '').trim();
    }

    function readFieldAll(container, spec) {
      const sel = typeof spec === 'string' ? spec : spec.selector;
      const attr = typeof spec === 'string' ? null : spec.attr;
      const lb = (spec && typeof spec === 'object') ? spec.labelledby : undefined;
      const refAttr = lb === true ? 'aria-labelledby'
        : (typeof lb === 'string' && lb.trim() ? lb.trim() : null);
      if (!sel) {
        if (refAttr) return [resolveLabelledbyText(container, refAttr).text];
        let val;
        if (attr) {
          if (DOM_PROPERTY_READS.has(attr)) val = capElementHtmlRead(container[attr]);
          else val = container.getAttribute(attr);
        } else {
          val = (container.textContent || '').trim();
        }
        return [val];
      }
      const els = container.querySelectorAll(sel);
      const out = [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (refAttr) {
          out.push(resolveLabelledbyText(el, refAttr).text);
        } else if (attr) {
          if (DOM_PROPERTY_READS.has(attr)) out.push(capElementHtmlRead(el[attr]));
          else out.push(el.getAttribute(attr));
        } else {
          out.push((el.textContent || '').trim());
        }
      }
      return out;
    }

    function extractListRecords(containers, fieldMap, opts) {
      if (!Array.isArray(containers)) {
        throw new Error('$extractList: containers must be an array');
      }
      if (!fieldMap || typeof fieldMap !== 'object' || Object.keys(fieldMap).length === 0) {
        throw new Error('$extractList fieldMap must be a non-empty object');
      }
      if (!containers.length) {
        if (opts && opts.allowEmpty) return [];
        throw new Error('$extractList: no containers matched');
      }
      const records = [];
      // Code-review P2 (inline mirror): compile predicates once, before any
      // DOM work.
      const matchByField = {};
      for (const [field, spec] of Object.entries(fieldMap)) {
        if (isHoverPopoverSpec(spec)) {
          throw new Error('$extractList field "' + field + '" uses read:\'hoverPopover\' — hover-mounted popover sources are only valid in $extractWithHover (which has a hover phase); drop the read: here or switch the call to $extractWithHover');
        }
        matchByField[field] = compileMatch(spec);
      }
      for (const container of containers) {
        const rec = {};
        for (const [field, spec] of Object.entries(fieldMap)) {
          try {
            rec[field] = applyMatch(readField(container, spec), matchByField[field]);
          } catch (err) {
            throw new Error(`$extractList field "${field}" selector invalid: ${err.message}`);
          }
        }
        records.push(rec);
      }
      return records;
    }

    function extractListMultiRecords(containers, fieldMap, opts) {
      if (!Array.isArray(containers)) {
        throw new Error('$extractListMulti: containers must be an array');
      }
      if (!fieldMap || typeof fieldMap !== 'object' || Object.keys(fieldMap).length === 0) {
        throw new Error('$extractListMulti fieldMap must be a non-empty object');
      }
      if (!containers.length) {
        if (opts && opts.allowEmpty) return [];
        throw new Error('$extractListMulti: no containers matched');
      }
      const records = [];
      // Code-review P2 (inline mirror): compile once, before any DOM work.
      const matchByField = {};
      for (const [field, spec] of Object.entries(fieldMap)) {
        if (isHoverPopoverSpec(spec)) {
          throw new Error('$extractListMulti field "' + field + '" uses read:\'hoverPopover\' — hover-mounted popover sources are only valid in $extractWithHover (which has a hover phase); drop the read: here or switch the call to $extractWithHover');
        }
        matchByField[field] = compileMatch(spec);
      }
      for (const container of containers) {
        const rec = {};
        for (const [field, spec] of Object.entries(fieldMap)) {
          try {
            rec[field] = applyMatch(readFieldAll(container, spec), matchByField[field]);
          } catch (err) {
            throw new Error(`$extractListMulti field "${field}" selector invalid: ${err.message}`);
          }
        }
        records.push(rec);
      }
      return records;
    }

    function extractWithHoverRecords(containers, fieldMap, hoverConfig, hoverFn, opts) {
      if (!Array.isArray(containers)) {
        throw new Error('$extractWithHover: containers must be an array');
      }
      if (!fieldMap || typeof fieldMap !== 'object' || Object.keys(fieldMap).length === 0) {
        throw new Error('$extractWithHover fieldMap must be a non-empty object');
      }
      if (!hoverConfig || typeof hoverConfig !== 'object') {
        throw new Error('$extractWithHover hoverConfig must be an object');
      }
      if (!hoverConfig.anchorSel || typeof hoverConfig.anchorSel !== 'string') {
        throw new Error('$extractWithHover hoverConfig.anchorSel must be a non-empty string');
      }
      if (typeof hoverFn !== 'function') {
        throw new Error('$extractWithHover hoverFn must be a function');
      }
      if (!containers.length) {
        if (opts && opts.allowEmpty) return [];
        throw new Error('$extractWithHover: no containers matched');
      }
      // F9 (inline mirror): per-call cap accumulator reset.
      hoverReadCappedByField = {};
      // 机械-语义分离（spec 3.A）：read:hoverPopover 字段在悬停阶段后填
      // 充——预提取用过滤后的 fieldMap（这些字段的值不来自静态 DOM；
      // extractListRecords 现在对 hoverPopover 规格教学性抛错）。
      var staticFieldMap = {};
      var hoverReadFields = [];
      var hoverMatchByField = {};
      for (var fk0 in fieldMap) {
        if (Object.prototype.hasOwnProperty.call(fieldMap, fk0)) {
          if (isHoverPopoverSpec(fieldMap[fk0])) {
            hoverReadFields.push(fk0);
            // Code-review P2 (inline mirror): compile during the split — an
            // invalid match throws BEFORE any hoverFn call.
            hoverMatchByField[fk0] = compileMatch(fieldMap[fk0]);
          } else {
            staticFieldMap[fk0] = fieldMap[fk0];
          }
        }
      }
      var records = Object.keys(staticFieldMap).length
        ? extractListRecords(containers, staticFieldMap, { allowEmpty: true })
        : containers.map(function () { return {}; });
      var anchorSel = hoverConfig.anchorSel;
      var popoverSel = hoverConfig.popoverSel || null;
      var perHoverOpts = {};
      if (typeof hoverConfig.timeoutMs === 'number' && hoverConfig.timeoutMs > 0) {
        perHoverOpts.timeoutMs = hoverConfig.timeoutMs;
      }
      perHoverOpts.dismiss = (typeof hoverConfig.dismiss === 'boolean') ? hoverConfig.dismiss : true;
      // Seventieth log F1 (inline mirror of lib/list-extract-ops.js): wall
      // budget — a hover batch over a long feed outlives the probe rail and
      // the step budget; a budget hit returns { records, partial } with the
      // resume cursor instead of dying as a zombie.
      var maxWallMs = (opts && typeof opts.maxWallMs === 'number' && opts.maxWallMs > 0) ? opts.maxWallMs : 25000;
      var wallStart = Date.now();
      var processedCount = 0;
      // Sequential hover iteration. Only one popover can be on screen at a
      // time on most sites; parallel dispatch would race.
      return (async function () {
        for (var i = 0; i < containers.length; i++) {
          if (i > 0 && (Date.now() - wallStart) > maxWallMs) break;
          var container = containers[i];
          var anchors = [];
          try {
            anchors = Array.prototype.slice.call(container.querySelectorAll(anchorSel));
          } catch (_) {
            anchors = [];
          }
          var hovercards = [];
          for (var j = 0; j < anchors.length; j++) {
            var anchorEl = anchors[j];
            var anchorHref = '';
            try {
              anchorHref = anchorEl.getAttribute('href') || '';
              // Forty-ninth log: mirrors lib/list-extract-ops.js — the anchor
              // is often the label span inside the link; harvest the enclosing
              // link's href when the match carries none of its own.
              if (!anchorHref && typeof anchorEl.closest === 'function') {
                const enclosing = anchorEl.closest('a[href]');
                if (enclosing) anchorHref = enclosing.getAttribute('href') || '';
              }
            } catch (_) {}
            var anchorText = '';
            try { anchorText = (anchorEl.textContent || '').trim().slice(0, 120); } catch (_) {}
            try {
              var r = await hoverFn(anchorEl, popoverSel, perHoverOpts);
              hovercards.push({
                hovered: !!(r && r.hovered),
                htmlSnippet: (r && r.htmlSnippet) || null,
                popoverSelector: (r && r.popoverSelector) || null,
                autoDiscovered: !!(r && r.autoDiscovered),
                reason: (r && r.reason) || null,
                // Sixth-log followup: observed popover identity on failures
                // (inline mirror of lib/list-extract-ops.js). Thirty-sixth
                // log: forwarded on success too — the identity now names the
                // CAPTURED popover, and harvest gates read
                // `observedPopover && htmlSnippet`.
                observedPopover: (r && r.observedPopover) || null,
                anchorIndex: j,
                anchorHref: anchorHref,
                anchorText: anchorText,
                // Forty-second log (inline mirror of lib/list-extract-ops.js):
                // anchor-label harvest forwarding, failed entries included.
                labelledbyText: (r && typeof r.labelledbyText === 'string' && r.labelledbyText) ? r.labelledbyText : null,
                labelledbyAttr: (r && typeof r.labelledbyAttr === 'string' && r.labelledbyAttr) ? r.labelledbyAttr : null,
                labelledbyNote: (r && typeof r.labelledbyNote === 'string' && r.labelledbyNote) ? r.labelledbyNote : null,
                // 机械-语义分离（spec 3.B）：剥标签原文，模型免写 DOM 解析。
                popoverText: (r && typeof r.htmlSnippet === 'string' && r.htmlSnippet)
                  ? r.htmlSnippet.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
                  : null
              });
            } catch (err) {
              hovercards.push({
                hovered: false,
                htmlSnippet: null,
                popoverSelector: null,
                autoDiscovered: false,
                reason: 'hover_error: ' + (err && err.message || String(err)),
                anchorIndex: j,
                anchorHref: anchorHref,
                anchorText: anchorText,
                labelledbyText: null,
                labelledbyAttr: null,
                labelledbyNote: null,
                popoverText: null
              });
            }
          }
          records[i].hovercards = hovercards;
          // 机械-语义分离（spec 3.A）：悬停来源字段 —— 对字段选择器命中的
          // 元素执行捕获，剥标签（hoverPopover）或保留标记
          // （hoverPopoverHtml），match 谓词照常应用（命中→原文，未命中→
          // 空串；捕获原文仍留在 hovercards[].popoverText 供证据回环）。
          // Code-review P1 (inline mirror of lib/list-extract-ops.js): hover-
          // read budget — cap candidates, stop scalars at first capture,
          // reuse anchor-loop captures, fall back to hovercards popoverText.
          // Mirrors TS_MAX_HOVER_ANCHORS's rationale (a handful of dwells is
          // the evidence budget that matters).
          var HR_MAX_FIELD_HOVER_CANDIDATES = 3;
          for (var hf = 0; hf < hoverReadFields.length; hf++) {
            var hfieldName = hoverReadFields[hf];
            var hspec = fieldMap[hfieldName] || {};
            var hsel = typeof hspec.selector === 'string' ? hspec.selector : null;
            var hre = hoverMatchByField[hfieldName] || null;
            var hvals = [];
            var hcands = hsel
              ? Array.prototype.slice.call(container.querySelectorAll(hsel))
              : [container];
            var capped = 0;
            if (hcands.length > HR_MAX_FIELD_HOVER_CANDIDATES) {
              capped = hcands.length - HR_MAX_FIELD_HOVER_CANDIDATES;
              hcands = hcands.slice(0, HR_MAX_FIELD_HOVER_CANDIDATES);
            }
            var readHoverText = function (snip) {
              return (typeof snip === 'string' && snip)
                ? ((hspec.read === 'hoverPopoverHtml') ? snip : stripTags(snip))
                : null;
            };
            for (var hh = 0; hh < hcands.length; hh++) {
              var htext = null;
              var reuseIdx = anchors.indexOf(hcands[hh]);
              if (reuseIdx >= 0 && hovercards[reuseIdx]) {
                htext = readHoverText(hovercards[reuseIdx].htmlSnippet);
              } else {
                try {
                  var hr = await hoverFn(hcands[hh], popoverSel, perHoverOpts);
                  htext = readHoverText(hr && hr.htmlSnippet);
                } catch (_) { htext = null; }
              }
              if (htext) hvals.push(htext);
              if (htext && hspec.multi !== true) break;
            }
            if (capped > 0) {
              // F9 (inline mirror): caps live in diagnostics, never in
              // records — a field__capped key in the output is schema
              // pollution.
              hoverReadCappedByField[hfieldName] = (hoverReadCappedByField[hfieldName] || 0) + capped;
            }
            if (hspec.multi === true) {
              records[i][hfieldName] = hvals
                .map(function (v) { return applyMatch(v, hre); })
                .filter(Boolean);
            } else {
              records[i][hfieldName] = applyMatch(hvals.length ? hvals[0] : '', hre);
              if (!hvals.length) {
                for (var hci = 0; hci < hovercards.length; hci++) {
                  var hct = (hspec.read === 'hoverPopoverHtml')
                    ? hovercards[hci].htmlSnippet
                    : hovercards[hci].popoverText;
                  if (typeof hct === 'string' && hct) {
                    records[i][hfieldName] = applyMatch(hct, hre);
                    break;
                  }
                }
              }
            }
          }
          processedCount = i + 1;
        }
        // Forty-fourth log (inline mirror of lib/list-extract-ops.js): field
        // extraction ran BEFORE the hover batch, but on a cold tab the batch
        // is exactly what hydrates lazily-mounted ARIA label chains. Re-read
        // labelledby fields whose pre-hover read came back empty; fill from
        // the post-hover DOM. Non-empty values are never overwritten and
        // non-labelledby fields are never re-read. Seventieth log F1: only
        // PROCESSED containers are re-read.
        var outRecords = records.slice(0, processedCount);
        for (var ri = 0; ri < outRecords.length; ri++) {
          for (var fk in fieldMap) {
            var specR = fieldMap[fk];
            var lbR = (specR && typeof specR === 'object') ? specR.labelledby : undefined;
            var refAttrR = lbR === true ? 'aria-labelledby'
              : (typeof lbR === 'string' && lbR.trim() ? lbR.trim() : null);
            if (!refAttrR) continue;
            var curR = outRecords[ri][fk];
            // Forty-eighth log (inline mirror): multi:true fields arrive as
            // arrays — heal only when EVERY match resolved empty, and refill
            // through the multi read so the envelope stays an array.
            if (Array.isArray(curR)) {
              var anyR = curR.some(function (x) { return typeof x === 'string' && x; });
              if (anyR) continue;
              try {
                var arrV = readField(containers[ri], specR);
                if (Array.isArray(arrV) && arrV.some(function (x) { return typeof x === 'string' && x; })) {
                  outRecords[ri][fk] = arrV;
                }
              } catch (_) {}
              continue;
            }
            if (curR !== undefined && curR !== null && String(curR) !== '') continue;
            var vR;
            try { vR = readField(containers[ri], specR); } catch (_) { continue; }
            if (typeof vR === 'string' && vR) outRecords[ri][fk] = vR;
          }
        }
        // Seventieth log F1 (inline mirror): budget-hit runs return the
        // partial envelope; all-fit runs keep the plain array.
        if (processedCount < containers.length) {
          return {
            records: outRecords,
            partial: {
              processed: processedCount,
              total: containers.length,
              maxWallMs: maxWallMs,
              note: 'wall budget reached — ' + processedCount + ' of ' + containers.length +
                ' containers processed; re-run with containerRange:[' + processedCount + ',' + containers.length +
                '] (or maxContainers) to continue, or raise opts.maxWallMs'
            }
          };
        }
        return outRecords;
      })();
    }

    function clickInListItems(containers, subSel, clickFn, delayMs) {
      const delay = Math.max(0, Math.min(5000, typeof delayMs === 'number' ? delayMs : 500));
      let clicked = 0;
      const errors = [];
      containers.forEach((container, index) => {
        try {
          const el = container.querySelector(subSel);
          if (!el) {
            errors.push({ index, reason: 'subSel not found' });
            return;
          }
          clickFn(el);
          clicked++;
        } catch (err) {
          errors.push({ index, reason: err.message || String(err) });
        }
      });
      return { clicked, errors, delayMs: delay };
    }

    // ⚠️ DRIFT GUARD: mirrors computeExtractListDiagnostics in
    // lib/list-extract-ops.js (including the multiMode/sampleValues semantics
    // added for the 2026-08-31 ZERO-TRAP fix). If you change one, change the
    // other in the same commit.
    function computeExtractListDiagnostics(containers, fieldMap, containerSelector, multiMode) {
      const containerArr = Array.isArray(containers) ? containers : [];
      const fields = fieldMap && typeof fieldMap === 'object' ? Object.entries(fieldMap) : [];
      const perField = fields.map(([field, spec]) => {
        const subSelector = typeof spec === 'string' ? spec : (spec && spec.selector);
        const attr = typeof spec === 'string' ? null : (spec && spec.attr) || null;
        const lb = (spec && typeof spec === 'object') ? spec.labelledby : undefined;
        const refAttr = lb === true ? 'aria-labelledby'
          : (typeof lb === 'string' && lb.trim() ? lb.trim() : null);
        // Forty-eighth log (inline mirror): field-level multi:true census
        const fieldMulti = !!(spec && typeof spec === 'object' && spec.multi === true);
        const sampleTexts = [];
        const sampleHrefs = [];
        const sampleValues = [];
        let matchCount = 0;
        let refResolved = 0;
        let missingIds = null;
        if (!subSelector) {
          return { field, subSelector: null, attr, labelledby: refAttr, matchCount: 0, refResolved: 0, missingIds: [], sampleTexts: [], sampleHrefs: [], sampleValues: [] };
        }
        const pushValue = (el) => {
          if (sampleValues.length >= 5) return;
          let v = null;
          if (refAttr) {
            const r = resolveLabelledbyText(el, refAttr);
            if (r.text) refResolved += 1;
            if (r.missingIds && r.missingIds.length) {
              if (!missingIds) missingIds = [];
              for (const mid of r.missingIds) {
                if (missingIds.length < 3) missingIds.push(mid);
              }
            }
            v = r.text;
          } else if (attr) {
            v = (attr === 'outerHTML' || attr === 'innerHTML') ? el[attr] : (el.getAttribute ? el.getAttribute(attr) : null);
          } else {
            v = (el.textContent || '').trim();
          }
          if (v != null && String(v).length > 0) sampleValues.push(String(v).slice(0, 160));
        };
        if ((multiMode || fieldMulti) && containerArr.length > 0) {
          for (const c of containerArr) {
            let el;
            try { el = c.querySelector(subSelector); } catch (_) { el = null; }
            if (el) matchCount += 1;
          }
          const c0 = containerArr[0];
          let els0 = [];
          try { els0 = c0 ? Array.from(c0.querySelectorAll(subSelector)) : []; } catch (_) { els0 = []; }
          for (const el of els0) pushValue(el);
        } else {
          for (const c of containerArr) {
            let el;
            try { el = c.querySelector(subSelector); } catch (_) { el = null; }
            if (!el) continue;
            matchCount += 1;
            pushValue(el);
            if (!attr && !refAttr && sampleTexts.length < 3 && typeof el.textContent === 'string') {
              sampleTexts.push(el.textContent.trim().slice(0, 80));
            }
            if (!attr && !refAttr && sampleHrefs.length < 3 && el.getAttribute) {
              const href = el.getAttribute('href');
              if (href) sampleHrefs.push(String(href).slice(0, 120));
            }
          }
        }
        return Object.assign(
          { field, subSelector, attr, labelledby: refAttr, matchCount, refResolved, missingIds: missingIds || [], sampleTexts, sampleHrefs, sampleValues },
          fieldMulti ? { multi: true } : null
        );
      });
      // Mirror lib/list-extract-ops.js RC13 + RC59: capture ~2000 chars of
      // the first container outerHTML with a head+tail split. WITHOUT this,
      // field-candidate discovery silently suppresses because
      // getFirstRecordHtmlFromAnyStep requires firstContainerHtml — autoFix
      // then iterates blind to where in the DOM neighborhood of a record
      // the missing fields actually live. RC59: metric attributes cluster
      // at the END of record markup, so a head-only cap amputated exactly
      // that evidence. This inline fallback fires on Chrome MV3 injection
      // glitches; the same drift hit RC8 (extractListMultiRecords missing)
      // and RC19 (ScrollOps missing).
      let firstContainerHtml = null;
      if (containerArr.length > 0) {
        const c0 = containerArr[0];
        if (c0 && typeof c0.outerHTML === 'string') {
          const collapsed = c0.outerHTML.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ');
          if (collapsed.length <= 8000) {
            firstContainerHtml = collapsed;
          } else {
            const tail = 4000;
            const head = 8000 - tail - 60; // marker budget
            firstContainerHtml = collapsed.slice(0, head) +
              ' …[truncated ' + collapsed.length + ' chars, middle cut]… ' +
              collapsed.slice(collapsed.length - tail);
          }
        }
      }
      return {
        api: 'extractList',
        containerSelector: containerSelector || null,
        containerMatches: containerArr.length,
        firstContainerHtml,
        perField
      };
    }

    function computeSimpleSelectorDiagnostics(elements, selector, api) {
      const apiName = api || 'list';
      const arr = Array.isArray(elements) ? elements : [];
      const wantSamples = apiName !== 'count';
      const sampleTexts = [];
      const sampleHrefs = [];
      if (wantSamples) {
        for (const el of arr) {
          if (!el) continue;
          if (sampleTexts.length < 3 && typeof el.textContent === 'string') {
            sampleTexts.push(el.textContent.trim().slice(0, 80));
          }
          if (sampleHrefs.length < 3 && el.getAttribute) {
            const href = el.getAttribute('href');
            if (href) sampleHrefs.push(String(href).slice(0, 120));
          }
          if (sampleTexts.length >= 3 && sampleHrefs.length >= 3) break;
        }
      }
      const out = {
        api: apiName,
        selector: selector || null,
        matchCount: arr.length,
        sampleTexts,
        sampleHrefs
      };
      // Twenty-third log (mirror of lib/list-extract-ops.js): the count
      // census carries the visible/invisible split — $count matches
      // regardless of visibility while $exists is visibility-gated, and the
      // divergence (count N / exists false) is exactly the hidden-but-
      // readable trap. Census runs only for count.
      if (apiName === 'count') {
        let visibleCount = 0;
        for (const el of arr) {
          if (isVisibleForDiagnostics(el)) visibleCount += 1;
        }
        out.visibleCount = visibleCount;
        out.invisibleCount = arr.length - visibleCount;
      }
      return out;
    }

    // Mirror of lib/list-extract-ops.js isVisibleForDiagnostics — defensive
    // visibility check for the count census (diagnostics must never throw).
    function isVisibleForDiagnostics(el) {
      if (!el) return false;
      try {
        const doc = el.ownerDocument;
        const win = doc && doc.defaultView;
        if (win && typeof win.getComputedStyle === 'function') {
          const style = win.getComputedStyle(el);
          if (style) {
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          }
        }
        if (typeof el.getBoundingClientRect === 'function') {
          const rect = el.getBoundingClientRect();
          if (rect && rect.width === 0 && rect.height === 0) return false;
        }
        return true;
      } catch {
        return true;
      }
    }

    // Inline mirror of lib/list-extract-ops.js computeClickInListDiagnostics —
    // keep in sync (pinned by test/inline-list-extract-ops-drift.test.js).
    function computeClickInListDiagnostics(containers, subSel, containerSelector, result) {
      const containerArr = Array.isArray(containers) ? containers : [];
      const errors = (result && Array.isArray(result.errors)) ? result.errors : [];
      const notFoundCount = errors.filter(e => e && typeof e.reason === 'string' && e.reason.indexOf('subSel not found') >= 0).length;
      const sampleTexts = [];
      for (const c of containerArr) {
        if (sampleTexts.length >= 3) break;
        if (c && typeof c.textContent === 'string') {
          const t = c.textContent.trim().slice(0, 80);
          if (t) sampleTexts.push(t);
        }
      }
      let firstContainerHtml = null;
      if (containerArr.length > 0) {
        const c0 = containerArr[0];
        if (c0 && typeof c0.outerHTML === 'string') {
          const collapsed = c0.outerHTML.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ');
          if (collapsed.length <= 8000) {
            firstContainerHtml = collapsed;
          } else {
            const tail = 4000;
            const head = 8000 - tail - 60;
            firstContainerHtml = collapsed.slice(0, head) +
              ' …[truncated ' + collapsed.length + ' chars, middle cut]… ' +
              collapsed.slice(collapsed.length - tail);
          }
        }
      }
      return {
        api: 'clickInList',
        containerSelector: containerSelector || null,
        containerMatches: containerArr.length,
        subSelector: subSel || null,
        clicked: (result && typeof result.clicked === 'number') ? result.clicked : 0,
        errorCount: errors.length,
        notFoundCount,
        sampleTexts,
        firstContainerHtml
      };
    }

    return {
      extractListRecords,
      extractListMultiRecords,
      extractWithHoverRecords,
      clickInListItems,
      computeExtractListDiagnostics,
      computeClickInListDiagnostics,
      computeSimpleSelectorDiagnostics,
      isVisibleForDiagnostics,
      getMatchGuardSkips,
      resetMatchGuardSkips,
      getHoverReadCapped
    };
  }

  let __listOpsFallbackWarned = false;
  function getListExtractOps() {
    const g = typeof window !== 'undefined' ? window : self;
    if (g && g.ListExtractOps) return g.ListExtractOps;
    if (!g.__inlineListExtractOps) g.__inlineListExtractOps = createInlineListExtractOps();
    if (!__listOpsFallbackWarned) {
      __listOpsFallbackWarned = true;
      // One-shot warning. Repeats would spam the log since getListExtractOps
      // is called on every $extractList / $clickInList invocation.
      console.warn('[content-script] Using inline $extractList fallback — lib/list-extract-ops.js did not attach window.ListExtractOps at call time. Reload the extension to investigate.');
    }
    return g.__inlineListExtractOps;
  }

  // RC19 follow-up (console.log 2026-07-29): same MV3 injection glitch hits
  // lib/scroll-ops.js — diagnostic `scrollToBottom_entry {hasScrollOps:false}`
  // confirmed it in production on Windows. Mirror the inline-fallback pattern
  // from ListExtractOps so the trusted-wheel stack still runs when the lib
  // doesn't attach. lib/scroll-ops.js remains the source of truth for Node
  // tests; this fallback is a defensive duplicate.
  // ⚠️ DRIFT GUARD: This inline object MUST mirror the public `api` export
  // of lib/scroll-ops.js exactly (function names + property keys). The drift
  // guard test (test/inline-scroll-ops-drift.test.js) parses both files as
  // text and asserts key parity. If you add a function to one, add it to the
  // other in the same commit — otherwise the inline fallback silently loses
  // capabilities (e.g. trusted-wheel resets) when the MV3 glitch fires it.
  // Behavior is additionally pinned by test/inline-scroll-ops-behavior-drift.test.js
  // (both implementations run over scripted roots; outputs must be deep-equal).
  function createInlineScrollOps() {
    var SCROLL_INCREMENT_RATIO = 0.85;
    var DEFAULT_MAX_ATTEMPTS = 15;        // RC21: was 8; bumped to give stallWindowMs room to fire
    var DEFAULT_NO_PROGRESS_LIMIT = 3;
    var DEFAULT_SETTLE_MS = 350;
    var DEFAULT_STALL_WINDOW_MS = 3000;   // RC21: time-based stall signal
    var DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS = 3;

    function defaultSleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function defaultNow() {
      return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
    }

    // Inline copy of scrollToBottomIncremental from lib/scroll-ops.js,
    // including the RC21 dual-signal stall detection. Behavior is pinned by
    // test/inline-scroll-ops-behavior-drift.test.js (deep-equal against the
    // lib over scripted roots) — keep this a verbatim port.
    function scrollToBottomIncremental(root, opts) {
      opts = opts || {};
      var sleep = opts.sleep || defaultSleep;
      var now = opts.now || defaultNow;
      var maxAttempts = (typeof opts.maxAttempts === 'number') ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
      var noProgressLimit = (typeof opts.noProgressLimit === 'number') ? opts.noProgressLimit : DEFAULT_NO_PROGRESS_LIMIT;
      var settleMs = (typeof opts.settleMs === 'number') ? opts.settleMs : DEFAULT_SETTLE_MS;
      var stallWindowMs = (typeof opts.stallWindowMs === 'number') ? opts.stallWindowMs : DEFAULT_STALL_WINDOW_MS;
      var scrollRootLabel = opts.scrollRootLabel || 'window';
      var trustedWheelFallback = (typeof opts.trustedWheelFallback === 'function') ? opts.trustedWheelFallback : null;
      var maxTrustedWheelAttempts = (typeof opts.maxTrustedWheelAttempts === 'number')
        ? opts.maxTrustedWheelAttempts : DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS;
      var onIter = (typeof opts.onIter === 'function') ? opts.onIter : function () {};

      var prevY = root.scrollTop || 0;
      var prevScrollHeight = root.scrollHeight || 0;
      var lastScrollTop = prevY;
      var lastScrollHeight = prevScrollHeight;
      var lastGrowTime = now();
      var noProgress = 0;
      var attempts = 0;
      var trustedWheelAttempts = 0;
      var stallReason = null;

      // RC19 follow-up: no-overflow root — exit before the loop so the
      // caller's inner-container probe can find the real scroll root.
      var rootClientHeight = root.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800);
      if (prevScrollHeight <= rootClientHeight) {
        return {
          scrolled: false,
          prevY: prevY,
          newY: prevY,
          prevScrollHeight: prevScrollHeight,
          newScrollHeight: prevScrollHeight,
          scrollRoot: scrollRootLabel,
          stalled: true,
          stallReason: 'no_overflow',
          attempts: 0,
          stallWindowMs: stallWindowMs,
          noOverflow: true
        };
      }

      return (async function loop() {
        for (var i = 0; i < maxAttempts; i++) {
          attempts += 1;
          var delta = Math.round((root.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800)) * SCROLL_INCREMENT_RATIO);
          if (root.scrollBy) {
            root.scrollBy(0, delta);
          } else {
            root.scrollTop = (root.scrollTop || 0) + delta;
          }
          if (settleMs > 0) await sleep(settleMs);

          var curTop = root.scrollTop || 0;
          var curHeight = root.scrollHeight || 0;
          var heightGrew = curHeight > lastScrollHeight;
          var posChanged = curTop !== lastScrollTop;
          lastScrollTop = curTop;
          lastScrollHeight = curHeight;

          // RC21: height growth resets BOTH signals; position change alone
          // resets only the count (legacy semantics).
          if (heightGrew) {
            lastGrowTime = now();
            noProgress = 0;
          } else if (posChanged) {
            noProgress = 0;
          } else {
            noProgress += 1;
          }

          var timeSinceGrowMs = now() - lastGrowTime;
          var countStalled = noProgress >= noProgressLimit;
          var timeStalled = timeSinceGrowMs >= stallWindowMs;

          try {
            onIter({
              root: scrollRootLabel, iter: i, delta: delta,
              curTop: curTop, curHeight: curHeight,
              heightGrew: heightGrew, posChanged: posChanged,
              noProgress: noProgress,
              timeSinceGrowMs: timeSinceGrowMs,
              settleMs: settleMs,
              stallWindowMs: stallWindowMs
            });
          } catch (e) { /* diagnostic must not break the loop */ }

          if (countStalled || timeStalled) {
            if (trustedWheelFallback && trustedWheelAttempts < maxTrustedWheelAttempts) {
              var wheelResult = null;
              try {
                wheelResult = await trustedWheelFallback({
                  deltaY: delta,
                  attempt: trustedWheelAttempts + 1,
                  scrollRoot: scrollRootLabel
                });
              } catch (e) {
                wheelResult = { dispatched: false, reason: 'fallback threw: ' + (e && e.message || String(e)) };
              }
              trustedWheelAttempts += 1;
              if (wheelResult && wheelResult.dispatched) {
                if (settleMs > 0) await sleep(settleMs);
                lastGrowTime = now();
                noProgress = 0;
                continue;
              }
              stallReason = timeStalled ? 'stall_window_elapsed' : 'no_progress_count_elapsed';
              if (wheelResult && wheelResult.reason) stallReason += ': ' + wheelResult.reason;
              break;
            }
            stallReason = timeStalled ? 'stall_window_elapsed' : 'no_progress_count_elapsed';
            break;
          }
        }

        var newY = root.scrollTop || 0;
        var newScrollHeight = root.scrollHeight || 0;
        var result = {
          scrolled: newY !== prevY,
          prevY: prevY,
          newY: newY,
          prevScrollHeight: prevScrollHeight,
          newScrollHeight: newScrollHeight,
          scrollRoot: scrollRootLabel,
          stalled: stallReason !== null,
          stallReason: stallReason,
          attempts: attempts,
          stallWindowMs: stallWindowMs
        };
        if (trustedWheelFallback) result.trustedWheelAttempts = trustedWheelAttempts;
        return result;
      })();
    }

    function findScrollableContainer(doc) {
      if (!doc || !doc.defaultView) return null;
      var view = doc.defaultView;
      var all;
      try {
        all = doc.querySelectorAll('*');
      } catch (e) {
        return null;
      }
      var best = null;
      var bestHeight = 0;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var style;
        try { style = view.getComputedStyle(el); } catch (e) { continue; }
        if (!style) continue;
        var ov = style.overflowY;
        if (ov !== 'auto' && ov !== 'scroll') continue;
        var sh = el.scrollHeight || 0;
        var ch = el.clientHeight || 0;
        if (sh <= ch * 1.5) continue;
        if (sh > bestHeight) {
          bestHeight = sh;
          best = el;
        }
      }
      return best;
    }

    return {
      scrollToBottomIncremental: scrollToBottomIncremental,
      findScrollableContainer: findScrollableContainer,
      DEFAULT_MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,
      DEFAULT_NO_PROGRESS_LIMIT: DEFAULT_NO_PROGRESS_LIMIT,
      DEFAULT_SETTLE_MS: DEFAULT_SETTLE_MS,
      DEFAULT_STALL_WINDOW_MS: DEFAULT_STALL_WINDOW_MS,
      DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS: DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS,
      SCROLL_INCREMENT_RATIO: SCROLL_INCREMENT_RATIO
    };
  }

  let __scrollOpsFallbackWarned = false;
  function getScrollOps() {
    const g = typeof window !== 'undefined' ? window : self;
    if (g && g.ScrollOps) return g.ScrollOps;
    if (!g.__inlineScrollOps) g.__inlineScrollOps = createInlineScrollOps();
    if (!__scrollOpsFallbackWarned) {
      __scrollOpsFallbackWarned = true;
      console.warn('[content-script] Using inline ScrollOps fallback — lib/scroll-ops.js did not attach window.ScrollOps at call time. Reload the extension to investigate.');
    }
    return g.__inlineScrollOps;
  }

  let isAnnotationMode = false;
  let selectedAnnotations = [];
  let annotationSchemas = { inputSchema: {}, outputSchema: {} };
  let annotationCounterPill = null;
  let activeMenuClose = null;
  let activeElementLabel = null;
  let sandboxIframe = null;
  let sandboxReady = false;
  const sandboxReadyCallbacks = [];
  let currentSenderTabId = null;

  // Intent dropdown presets — keep in sync with wizard-utils.js
  // ANNOTATION_PURPOSES / WAIT_CONDITIONS. The content-script cannot require
  // modules (it runs injected in the page), so the small preset list is
  // duplicated here. Update both together when adding a purpose/condition.
  const PURPOSES = [
    { value: 'submit', label: 'Submit' },
    { value: 'toggle', label: 'Toggle State' },
    { value: 'navigate', label: 'Navigate / Paginate' },
    { value: 'expand', label: 'Expand / Collapse' },
    { value: 'wait-for-load', label: 'Wait for Load' },
    { value: 'check-login', label: 'Check Login State' },
    { value: 'verify-state', label: 'Verify State' },
    { value: 'other', label: 'Other…' }
  ];
  const WAIT_CONDITIONS = [
    { value: 'appear', label: 'Element Appears' },
    { value: 'disappear', label: 'Element Disappears' },
    { value: 'textStable', label: 'Text Stabilizes' },
    { value: 'attributeChange', label: 'Attribute Changes' }
  ];
  // Annotation listener tracking — documents we've attached capture-phase
  // click/mouseover/keydown listeners to (top doc + same-origin iframe docs).
  let attachedAnnotationDocs = [];
  let iframeObserver = null;
  let hoverLogCounter = 0;
  let lastHoverTarget = null;

  function sendDebugLog(level, component, message, data) {
    const prefix = '[' + level + '] [' + component + '] ' + message;
    if (level === 'error') console.error(prefix, data || '');
    else if (level === 'warn') console.warn(prefix, data || '');
    else console.log(prefix, data || '');
  }

  // RC19 follow-up (console.log 2026-07-28): mirrors a content-script diagnostic
  // up to the background service worker so it lands in the SAME log capture the
  // user already takes from background SW DevTools. Content-script's own
  // console.log only shows in the page's DevTools, which the user wasn't watching.
  // Fire-and-forget; no response needed. Wrapped so any failure is silent —
  // diagnostics must never break the scrape path they're observing.
  function notifyBackgroundDiagnostic(category, payload) {
    try {
      chrome.runtime.sendMessage({
        type: 'CONTENT_SCRIPT_DIAGNOSTIC',
        category: category,
        payload: payload,
        tabUrl: (typeof location !== 'undefined' && location.href) || null
      }, function () {
        // Swallow: chrome.runtime.lastError is expected when the SW is asleep.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // Diagnostic must never throw into the scrape path.
    }
  }

  // RC25 (console.log 2026-08-04): inline copy of createEnhancedModeCache from
  // lib/renderer-activation.js. Content-script can't load renderer-activation.js
  // (it's background-only — chrome.debugger territory). The cache lazy-queries
  // background for Enhanced Mode state on first stall, then short-circuits
  // subsequent stalls when known-disabled. Eliminates N×(request+response)
  // wasted messages per $scrollToBottom when Enhanced Mode is off.
  // ⚠️ DRIFT GUARD: test/enhanced-mode-cache-inline-drift.test.js asserts this
  // inline copy matches lib/renderer-activation.js's createEnhancedModeCache
  // behaviorally. If you change one, change the other in the same commit.
  function createInlineEnhancedModeCache(opts) {
    opts = opts || {};
    var queryFn = (typeof opts.query === 'function') ? opts.query : null;
    var cachedState = null; // null = unknown, true/false = known
    var inFlightPromise = null;

    function resolveQuery() {
      if (!queryFn) return Promise.resolve(false);
      try {
        var p = queryFn();
        if (!p || typeof p.then !== 'function') p = Promise.resolve(p);
        return p.then(
          function (v) { return !!v; },
          function () { return false; }
        );
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    return {
      isKnown: function () { return cachedState !== null; },
      getState: function () {
        if (cachedState !== null) return Promise.resolve(cachedState);
        if (!inFlightPromise) {
          inFlightPromise = resolveQuery().then(function (v) {
            cachedState = v;
            inFlightPromise = null;
            return v;
          });
        }
        return inFlightPromise;
      },
      invalidate: function () { cachedState = null; },
      _setForTest: function (v) { cachedState = !!v; inFlightPromise = null; }
    };
  }

  // Module-scope singleton. Query asks background via the same message channel
  // trustedWheelFallback used to use, so no new infrastructure needed.
  var enhancedModeCache = createInlineEnhancedModeCache({
    query: function () {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({ type: 'GET_ENHANCED_MODE_STATE' }, function (resp) {
            // Swallow: lastError is expected when SW is asleep.
            void chrome.runtime.lastError;
            resolve(!!(resp && resp.enabled));
          });
        } catch (e) {
          resolve(false);
        }
      });
    }
  });

  // Listen for Enhanced Mode state changes broadcast by background (fired
  // when the user toggles the option). Without this, a user who enables
  // Enhanced Mode mid-session would have a stale "false" cache until the
  // tab reloads. The invalidate() forces re-query on the next stall.
  try {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === 'ENHANCED_MODE_STATE_CHANGED') {
        enhancedModeCache.invalidate();
      }
    });
  } catch (e) {
    // Test sandbox or no chrome.runtime — cache still works (just won't
    // auto-invalidate on toggle, which is fine for tests).
  }

  // RC20 (console.log 2026-07-30): wrap input-required DOM ops so the scrape
  // tab is the active tab during the op. Chrome's renderer only
  // produces compositor frames for the active tab in the focused window, and
  // both IntersectionObserver callbacks AND CDP Input.dispatchMouseEvent
  // require frame production. This is the one layer that visibility-keepalive,
  // launch flags, and Enhanced Mode could not be (necessary but not
  // sufficient). See lib/tab-activation.js for the rationale and the
  // background TAB_ACTIVATION_REQUEST handler.
  //
  // Content scripts can't call chrome.tabs.* — this helper uses message-
  // passing to ask background to do it. It runs `fn` regardless of whether
  // activation succeeded (graceful degradation — fgPath already active,
  // cross-window refusals, missing chrome.tabs, etc.). Errors in the message
  // channel do NOT abort `fn`.
  async function withTabActivation(label, fn) {
    // Forty-ninth log: real page focus evidence, read from THIS (isolated)
    // world — the MAIN-world visibility-keepalive override cannot lie on
    // this side. A page that reports itself hidden/unfocused cannot produce
    // compositor frames regardless of tab-active state (the window lost OS
    // focus, is occluded, or another app holds focus), so the background
    // must re-assert window focus even when Chrome's own window APIs
    // believe everything is fine.
    let needsWindowFocus = false;
    try {
      const vis = (typeof document !== 'undefined' && document.visibilityState) || '';
      const focused = (typeof document !== 'undefined' && typeof document.hasFocus === 'function')
        ? document.hasFocus() : true;
      needsWindowFocus = !!(vis && vis !== 'visible') || focused === false;
    } catch (_) { /* evidence is best-effort */ }
    let req = null;
    try {
      req = await chrome.runtime.sendMessage({ type: 'TAB_ACTIVATION_REQUEST', needsWindowFocus: needsWindowFocus });
      notifyBackgroundDiagnostic('tabActivation_request', {
        label: label,
        ok: !!(req && req.ok),
        activated: !!(req && req.ok && req.activated),
        crossWindow: !!(req && req.crossWindow),
        focusedWindow: !!(req && req.focusedWindow),
        needsWindowFocus: needsWindowFocus,
        reason: (req && req.reason) || null
      });
    } catch (e) {
      notifyBackgroundDiagnostic('tabActivation_request', {
        label: label, ok: false, needsWindowFocus: needsWindowFocus,
        reason: 'sendMessage error: ' + (e && e.message || String(e))
      });
    }
    return await fn(); // RC56 sticky: activation persists, no release message
  }

  // Forty-ninth log: the two pieces of evidence that explain a scroll that
  // moves nothing and loads nothing. Both read REAL values from the isolated
  // world — the visibility-keepalive MAIN-world override cannot touch them.
  function readPageFrameState() {
    const st = { visibilityState: null, hasFocus: null };
    try { st.visibilityState = document.visibilityState || null; } catch (_) {}
    try {
      if (typeof document.hasFocus === 'function') st.hasFocus = document.hasFocus();
    } catch (_) {}
    return st;
  }

  // rAF ticks over a short window: an active visible tab fires ~60/s; a
  // throttled/frozen renderer fires ~0. This distinguishes "genuinely
  // exhausted feed" (frames flowing, count stable) from "renderer gated"
  // (no frames, lazy-load callbacks cannot fire) — the forty-ninth-log
  // model guessed seven scroll shapes across v1-v7 because nothing told it
  // which of the two it was facing.
  function sampleFrameProduction(sampleMs) {
    const ms = typeof sampleMs === 'number' && sampleMs > 0 ? sampleMs : 300;
    const t0 = Date.now();
    let ticks = 0;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ rAFTicks: ticks, sampleMs: Date.now() - t0 });
      };
      try {
        if (typeof window.requestAnimationFrame !== 'function') { finish(); return; }
        const tick = () => { ticks++; if (!done) window.requestAnimationFrame(tick); };
        window.requestAnimationFrame(tick);
        setTimeout(finish, ms);
      } catch (_) { finish(); }
    });
  }

  // No-progress scroll results carry the page state (always) and an rAF
  // sample + teaching note when the state looks gated. Progress means
  // frames exist — evidence is only wanted when the scroll stalls.
  async function attachScrollEvidence(result) {
    if (!result || result.scrolled !== false) return result;
    const pageState = readPageFrameState();
    result.pageState = pageState;
    const gated = (pageState.visibilityState && pageState.visibilityState !== 'visible') ||
                  pageState.hasFocus === false;
    if (gated) {
      result.frameSample = await sampleFrameProduction(300);
      result.throttleNote = 'page reports ' + JSON.stringify(pageState) +
        ' while the scroll made no progress — the renderer is not producing frames for this tab, so lazy-load callbacks cannot fire. Window focus is re-asserted automatically by every scroll op; if this persists check `scrapewright throttle on` (occluded-window launch flags).';
    }
    return result;
  }

  sendDebugLog('info', 'content-script', 'Content script loaded', { url: location.href, readyState: document.readyState });

  // ===== Sandbox =====
  function ensureSandbox() {
    sendDebugLog('info', 'content-script', 'ensureSandbox called', { hasIframe: !!sandboxIframe, hasBody: !!document.body, readyState: document.readyState });
    if (sandboxIframe) {
      sendDebugLog('info', 'content-script', 'ensureSandbox: iframe already exists');
      return;
    }
    if (!document.body) {
      sendDebugLog('warn', 'content-script', 'ensureSandbox: document.body not ready, retrying');
      setTimeout(ensureSandbox, 50);
      return;
    }

    // Log any CSP meta tags that might block our iframe
    const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (cspMeta) {
      sendDebugLog('warn', 'content-script', 'Page has CSP meta tag', { content: cspMeta.getAttribute('content') });
    }

    sandboxIframe = document.createElement('iframe');
    // Use visibility-off positioning instead of display:none to avoid
    // browsers deferring resource loads in hidden iframes.
    sandboxIframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    // sandbox.html is already declared as a sandbox page in manifest.json.
    // Adding sandbox="allow-scripts" here can conflict with the declared
    // sandbox and cause scripts inside to not execute on some sites.
    sandboxIframe.src = chrome.runtime.getURL('sandbox.html');

    sandboxIframe.onload = () => {
      sendDebugLog('info', 'content-script', 'Sandbox iframe onload fired', { src: sandboxIframe.src });
    };
    sandboxIframe.onerror = (err) => {
      sendDebugLog('error', 'content-script', 'Sandbox iframe onerror fired', { error: String(err) });
    };

    document.body.appendChild(sandboxIframe);
    sendDebugLog('info', 'content-script', 'Sandbox iframe appended to body', { src: sandboxIframe.src });

    // Warn if SANDBOX_READY not received within 5 seconds
    setTimeout(() => {
      if (!sandboxReady) {
        let iframeDocInfo = 'unknown';
        try {
          const doc = sandboxIframe.contentDocument;
          iframeDocInfo = {
            title: doc?.title,
            bodyLen: doc?.body?.innerHTML?.length,
            bodyPreview: doc?.body?.innerHTML?.slice(0, 300),
            scripts: Array.from(doc?.querySelectorAll('script')).map(s => ({ src: s.src, textLen: s.textContent?.length }))
          };
        } catch (e) {
          iframeDocInfo = { error: e.message };
        }
        sendDebugLog('error', 'content-script', 'SANDBOX_READY not received after 5s', {
          iframeInDom: !!document.body?.contains(sandboxIframe),
          iframeSrc: sandboxIframe?.src,
          iframeContentWindow: !!sandboxIframe?.contentWindow,
          iframeDocInfo,
          location: location.href
        });
      }
    }, 5000);

    window.addEventListener('message', (e) => {
      if (e.source !== sandboxIframe.contentWindow) return;
      if (e.data.type === 'SANDBOX_READY') {
        sandboxReady = true;
        sendDebugLog('info', 'content-script', 'Sandbox ready');
        while (sandboxReadyCallbacks.length) sandboxReadyCallbacks.shift()();
      } else if (e.data.type === 'DOM_REQUEST') {
        sendDebugLog('info', 'content-script', 'DOM_REQUEST from sandbox', { action: e.data.action, selector: e.data.selector });
        handleDomRequest(e.data).then(({ result, error, subTabSnapshot, _diagnostics }) => {
          sendDebugLog(error ? 'error' : 'info', 'content-script', 'DOM_RESPONSE to sandbox', { action: e.data.action, selector: e.data.selector, error, resultType: typeof result, hasSubTabSnapshot: !!subTabSnapshot });
          sandboxIframe.contentWindow.postMessage({
            type: 'DOM_RESPONSE',
            id: e.data.id,
            result,
            error,
            subTabSnapshot,
            _diagnostics
          }, '*');
        });
      } else if (e.data.type === 'EXECUTE_RESULT') {
        sendDebugLog('info', 'content-script', 'EXECUTE_RESULT from sandbox', { error: e.data.error, resultType: typeof e.data.result, hasSubTabSnapshot: !!e.data.subTabSnapshot });
        chrome.runtime.sendMessage({
          type: 'SCRIPT_RESULT',
          result: e.data.result,
          error: e.data.error,
          subTabSnapshot: e.data.subTabSnapshot,
          tabId: currentSenderTabId
        });
      }
    });
  }

  function whenSandboxReady() {
    return new Promise((resolve, reject) => {
      if (sandboxReady) return resolve();
      sandboxReadyCallbacks.push(resolve);
      // Timeout to avoid hanging forever
      setTimeout(() => {
        if (sandboxReady) return;
        const errorMsg = 'SANDBOX_READY_TIMEOUT: sandbox iframe never signaled ready';
        sendDebugLog('error', 'content-script', errorMsg, {
          iframeInDom: !!document.body?.contains(sandboxIframe),
          hasIframe: !!sandboxIframe,
          iframeSrc: sandboxIframe?.src,
          location: location.href
        });
        reject(new Error(errorMsg));
      }, 10000);
    });
  }

  // Per-iteration DOM activity accumulator. StepOrchestrator RESETs at the start
  // of each iteration and GETs after executeScript returns, so it can include
  // the per-iteration selector/outcome summary in the STEP_ITERATION event.
  // Outside the wizard testScript path this state is unused (HTTP API jobs
  // never send RESET/GET messages).
  let domActivityLog = [];

  function recordDomActivity(method, selector, outcome, ms) {
    if (typeof selector !== 'string' || selector === '') return;
    domActivityLog.push({
      method,
      selector,
      outcome: typeof outcome === 'number' ? outcome : 0,
      ms: typeof ms === 'number' ? ms : 0
    });
  }

  async function handleDomRequest(data) {
    let result, error, subTabSnapshot, _diagnostics;
    try {
      switch (data.action) {
        case 'querySelector': {
          const __t0 = Date.now();
          result = await domQuerySelector(data.selector);
          recordDomActivity('$', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'click': {
          const __t0 = Date.now();
          result = await domClick(data.selector, data.args && data.args[0]);
          recordDomActivity('$click', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'type': {
          const __t0 = Date.now();
          try {
            const __r = await domType(data.selector, data.args && data.args[0], data.args && data.args[1]);
            result = __r && typeof __r === 'object' && 'result' in __r ? __r.result : __r;
            _diagnostics = __r && typeof __r === 'object' ? __r._diagnostics : undefined;
            recordDomActivity('$type', data.selector, 1, Date.now() - __t0);
          } catch (e) {
            // B13: the activity log must see failures too — outcome 1 was
            // hardcoded and the throw path recorded nothing.
            recordDomActivity('$type', data.selector, 0, Date.now() - __t0);
            throw e;
          }
          break;
        }
        case 'extract': {
          const __t0 = Date.now();
          const __r = await domExtract(data.selector, data.args[0], data.args[1]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$extract', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'wait': {
          const __t0 = Date.now();
          result = await domWait(data.selector, data.args[0]);
          recordDomActivity('$wait', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'check': {
          const __t0 = Date.now();
          result = await domCheck(data.selector, data.args[0]);
          recordDomActivity(
            '$check',
            data.selector,
            typeof result === 'boolean' ? (result ? 1 : 0) : 1,
            Date.now() - __t0
          );
          break;
        }
        case 'openTab':
          result = await domOpenTab(data.args[0], data.args[1]);
          break;
        case 'exists': {
          const __t0 = Date.now();
          result = await domExists(data.selector, data.args[0]);
          recordDomActivity('$exists', data.selector, result ? 1 : 0, Date.now() - __t0);
          if (result !== true) {
            // Twenty-third log: a false $exists whose selector still MATCHES
            // must not read as "absent" — hidden-but-readable elements are
            // the exact trap (reads are not visibility-gated).
            const __d = computeExistsDiagnostics(data.selector);
            if (__d) _diagnostics = [__d];
          }
          break;
        }
        case 'labelledby': {
          const __t0 = Date.now();
          const __r = await domLabelledby(data.selector, data.args && data.args[0], data.args && data.args[1]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$labelledby', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'timestamp': {
          const __t0 = Date.now();
          const __r = await domTimestamp(data.selector, data.args && data.args[0]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$timestamp', data.selector, (result && result.value) ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'count': {
          const __t0 = Date.now();
          const __r = domCount(data.selector);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$count', data.selector, typeof result === 'number' ? result : 0, Date.now() - __t0);
          break;
        }
        case 'list': {
          const __t0 = Date.now();
          const __r = domList(data.selector);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$list', data.selector, Array.isArray(result) ? result.length : 0, Date.now() - __t0);
          break;
        }
        case 'waitForStable': {
          const __t0 = Date.now();
          const __r = await domWaitForStable(data.selector, data.args && data.args[0]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$waitForStable', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'extractList': {
          const __t0 = Date.now();
          const __r = domExtractList(data.selector, data.args && data.args[0], data.args && data.args[1]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$extractList', data.selector, Array.isArray(result) ? result.length : 0, Date.now() - __t0);
          break;
        }
        case 'extractListMulti': {
          const __t0 = Date.now();
          const __r = domExtractListMulti(data.selector, data.args && data.args[0], data.args && data.args[1]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$extractListMulti', data.selector, Array.isArray(result) ? result.length : 0, Date.now() - __t0);
          break;
        }
        case 'clickInList': {
          const __t0 = Date.now();
          const __r = await domClickInList(data.selector, data.args && data.args[0], data.args && data.args[1]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$clickInList', data.selector, __r.result && typeof __r.result.clicked === 'number' ? __r.result.clicked : 0, Date.now() - __t0);
          break;
        }
        case 'extractWithHover': {
          const __t0 = Date.now();
          const __r = await domExtractWithHover(data.selector, data.args && data.args[0], data.args && data.args[1]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$extractWithHover', data.selector, Array.isArray(result) ? result.length : 0, Date.now() - __t0);
          break;
        }
        case 'scrollBy': {
          const __t0 = Date.now();
          const __r = await domScrollBy(data.selector, data.args && data.args[0]);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$scrollBy', data.selector, result && result.scrolled ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'scrollToBottom': {
          const __t0 = Date.now();
          result = await domScrollToBottom(data.selector);
          recordDomActivity('$scrollToBottom', data.selector, result && result.scrolled ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'scrollIntoView': {
          const __t0 = Date.now();
          const __r = await domScrollIntoView(data.selector);
          result = __r.result;
          _diagnostics = __r._diagnostics;
          recordDomActivity('$scrollIntoView', data.selector, result && result.found ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'hover': {
          const __t0 = Date.now();
          result = await domHover(data.selector, data.args && data.args[0], data.args && data.args[1]);
          recordDomActivity('$hover', data.selector, result && result.hovered ? 1 : 0, Date.now() - __t0);
          break;
        }
        default:
          error = 'Unknown DOM action: ' + data.action;
      }
    } catch (e) {
      error = e.message || String(e);
      if (e.subTabSnapshot) subTabSnapshot = e.subTabSnapshot;
      // B2: a dom* helper that diagnosed its failure before throwing must
      // not lose that evidence — merge it into the error payload (the
      // sandbox/orchestrator relay forwards it to autoFix).
      if (e && e._diagnostics) _diagnostics = e._diagnostics;
    }
    return { result, error, subTabSnapshot, _diagnostics };
  }

  // ===== Deep DOM Search (main doc + same-origin iframes) =====
  // Delegates to lib/iframe-selector.js (loaded as a content script before
  // content-script.js — see manifest.json). That library understands the
  // `iframe<css>::<inner-css>` selector syntax used to target elements inside
  // a specific iframe deterministically. Without a prefix, both functions
  // preserve the legacy "search top doc then iterate same-origin iframes"
  // behavior so existing services keep working.
  const IframeSelectorLib = (typeof window !== 'undefined' && window.IframeSelector) || null;

  function querySelectorDeep(sel) {
    if (IframeSelectorLib) {
      return IframeSelectorLib.querySelectorDeep(document, sel);
    }
    let el = document.querySelector(sel);
    if (el) return { element: el, doc: document };
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          el = doc.querySelector(sel);
          if (el) return { element: el, doc };
        }
      } catch { /* cross-origin */ }
    }
    return null;
  }

  function querySelectorAllDeep(sel) {
    if (IframeSelectorLib) {
      return IframeSelectorLib.querySelectorAllDeep(document, sel);
    }
    const results = [];
    function collectFromDoc(doc) {
      doc.querySelectorAll(sel).forEach(el => results.push(el));
    }
    try { collectFromDoc(document); } catch {}
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const doc = iframe.contentDocument;
        if (doc) collectFromDoc(doc);
      } catch { /* cross-origin */ }
    });
    return results;
  }

  // ===== DOM APIs =====
  function domQuerySelector(sel, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const found = querySelectorDeep(sel);
      if (found) {
        sendDebugLog('info', 'content-script', 'domQuerySelector found element immediately', { selector: sel, tagName: found.element.tagName, id: found.element.id, className: classStr(found.element).slice(0, 100) });
        return resolve(elToData(found.element));
      }
      sendDebugLog('info', 'content-script', 'domQuerySelector waiting for element', { selector: sel });
      const observers = [];
      const timer = setTimeout(() => {
        observers.forEach(o => o.disconnect());
        sendDebugLog('error', 'content-script', 'domQuerySelector timeout', { selector: sel, timeoutMs });
        reject(new Error('ELEMENT_NOT_FOUND: ' + sel));
      }, timeoutMs);

      function check() {
        const found = querySelectorDeep(sel);
        if (found) {
          clearTimeout(timer);
          observers.forEach(o => o.disconnect());
          sendDebugLog('info', 'content-script', 'domQuerySelector found element after wait', { selector: sel, tagName: found.element.tagName, id: found.element.id, className: classStr(found.element).slice(0, 100) });
          resolve(elToData(found.element));
        }
      }

      const mainObs = new MutationObserver(check);
      mainObs.observe(document.body, { childList: true, subtree: true });
      observers.push(mainObs);

      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          const doc = iframe.contentDocument;
          if (doc?.body) {
            const obs = new MutationObserver(check);
            obs.observe(doc.body, { childList: true, subtree: true });
            observers.push(obs);
          }
          iframe.addEventListener('load', () => {
            try {
              const d = iframe.contentDocument;
              if (d?.body) {
                const obs = new MutationObserver(check);
                obs.observe(d.body, { childList: true, subtree: true });
                observers.push(obs);
              }
            } catch { /* cross-origin */ }
            check();
          });
        } catch { /* cross-origin */ }
      });
    });
  }

  // SVG elements have className = SVGAnimatedString (an object, not a string).
  // Normalize to a plain string so .slice/.split and script-side consumers work.
  function classStr(el) {
    if (!el) return '';
    const c = el.className;
    return typeof c === 'string' ? c : (c?.baseVal || '');
  }

  function elToData(el) {
    return {
      tagName: el.tagName,
      id: el.id,
      className: classStr(el),
      textContent: el.textContent?.trim()?.slice(0, 50000) || '',
      value: el.value,
      href: el.href,
      src: el.src,
      checked: el.checked,
      disabled: el.disabled
    };
  }

  async function domClick(sel, timeoutMs) {
    // B3: extraction fail-fasts at 5s because a missing element there means
    // a wrong selector; clicks/types have the same failure shape — default
    // them to 10s (not the 30s read-primitive budget) unless overridden.
    await domQuerySelector(sel, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 10000);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    const el = found.element;
    sendDebugLog('info', 'content-script', 'domClick clicking element', { selector: sel, tagName: el.tagName, id: el.id, className: classStr(el).slice(0, 100) });
    el.click();
    return true;
  }

  async function domType(sel, text, timeoutMs) {
    await domQuerySelector(sel, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 10000);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    let el = found.element;
    let isInputtable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    sendDebugLog('info', 'content-script', 'domType checking element', { selector: sel, tagName: el.tagName, isContentEditable: el.isContentEditable, isInputtable });
    if (!isInputtable) {
      const child = el.querySelector('input, textarea, [contenteditable="true"]');
      if (child) {
        el = child;
        isInputtable = true;
        sendDebugLog('info', 'content-script', 'domType using inputtable child', { selector: sel, childTagName: el.tagName, childId: el.id });
      }
    }
    if (!isInputtable) {
      throw new Error('ELEMENT_NOT_INPUTTABLE: ' + sel + ' (found ' + el.tagName + ', id=' + (el.id || 'none') + ', class=' + (el.className || 'none') + ')');
    }
    const textIsString = typeof text === 'string';
    const textStr = textIsString ? text : String(text);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = textStr;
    } else {
      el.innerText = textStr;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    sendDebugLog('info', 'content-script', 'domType value set', { selector: sel, textLength: textStr.length });
    // B12: a non-string text previously hit the DOMString IDL coercion and
    // literally typed "undefined"/"null" into the field with no signal.
    // Coerce explicitly and surface the original type.
    if (textIsString) return { result: true };
    return {
      result: true,
      _diagnostics: {
        typeCoercedFrom: (text === null ? 'null' : typeof text),
        note: '$type received a non-string value — coerced with String() before setting. Check that the step script computes the text instead of passing an unset variable.'
      }
    };
  }

  async function domExtract(sel, attr, timeoutMs) {
    // Extraction is "read this element" not "wait for element to appear" — a missing
    // element almost always means the wrong selector, so cap the wait short (default 5s)
    // instead of the full 30s. Waiting 30s here burns the whole step timeout → SCRIPT_TIMEOUT.
    await domQuerySelector(sel, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 5000);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    const el = found.element;
    // outerHTML / innerHTML are DOM PROPERTIES, not HTML ATTRIBUTES — getAttribute
    // returns null for them. Read from the element directly when attr names one.
    // Regression for console.log 2026-07-26 RC5: $extract(sel, 'outerHTML') returned
    // null, silently breaking the domHtml field in extraction outputs.
    let result;
    if (attr === 'outerHTML' || attr === 'innerHTML') {
      result = capElementHtmlRead(el[attr]);
    } else if (attr) {
      result = el.getAttribute(attr);
    } else {
      result = el.textContent.trim();
    }
    const matchedEls = [el];
    const ops = getListExtractOps();
    const _diagnostics = ops && ops.computeSimpleSelectorDiagnostics
      ? ops.computeSimpleSelectorDiagnostics(matchedEls, sel, 'extract')
      : { api: 'extract', selector: sel, matchCount: result != null ? 1 : 0, sampleTexts: [], sampleHrefs: [] };
    // B10: distinguish "element matched but attribute absent" from "selector
    // wrong" — getAttribute returns null for both today, and autoFix cannot
    // tell them apart.
    if (attr && attr !== 'outerHTML' && attr !== 'innerHTML' && result == null) {
      _diagnostics.attrAbsent = true;
      _diagnostics.attrAbsentNote = 'element matched but attribute "' + attr + '" is absent — the selector is likely right and the attribute wrong or optional; check nearby attributes or drop the attr argument to read textContent';
    }
    sendDebugLog('info', 'content-script', 'domExtract result', { selector: sel, attr, resultPreview: result?.slice(0, 200), resultLength: result?.length });
    return { result, _diagnostics };
  }

  async function domWait(sel, ms) {
    // B4: an empty/missing selector used to skip the wait and return a fake
    // success — throw with teaching text instead (M4 precedent).
    if (typeof sel !== 'string' || !sel.trim()) {
      throw new Error('WAIT_SELECTOR_EMPTY: $wait requires a selector string as its first argument — e.g. $wait(\'div.results\', 1000) waits for the element then sleeps 1000ms. If you only need a delay, pass the element you are waiting on, not an empty string.');
    }
    await domQuerySelector(sel);
    if (ms) {
      sendDebugLog('info', 'content-script', 'domWait sleeping', { delayMs: ms });
      await new Promise(r => setTimeout(r, ms));
    }
    return true;
  }

  async function domCheck(sel, prop) {
    await domQuerySelector(sel);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    const result = found.element[prop];
    sendDebugLog('info', 'content-script', 'domCheck result', { selector: sel, prop, result });
    return result;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  // Which visibility check failed — for the exists diagnostics below. Mirrors
  // isElementVisible's checks; defensive because diagnostics must never throw
  // the read that would otherwise succeed.
  function invisibleElementReason(el) {
    if (!el) return 'hidden';
    try {
      const win = el.ownerDocument?.defaultView || window;
      const style = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
      if (style) {
        if (style.display === 'none') return 'display:none';
        if (style.visibility === 'hidden') return 'visibility:hidden';
        if (style.opacity === '0') return 'opacity:0';
      }
      if (typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) return 'zero-size';
      }
    } catch { /* diagnostics must never throw */ }
    return 'hidden';
  }

  // Twenty-third log: $exists is the ONLY $ primitive gated on visibility,
  // while every read ($extract/$list/$count/$extractList) resolves through
  // querySelector(All)Deep with no visibility filter. The model's natural
  // guard idiom — `if (!(await $exists(sel))) return null` — therefore read
  // hidden-but-readable elements (aria-labelledby tooltip spans, collapsed
  // labels) as "absent", the guarded fields extracted "" in every record,
  // and the bare `false` left the model to invent a wrong race hypothesis.
  // When $exists returns false but the selector DOES match, record the
  // hidden match: reason, sample text (readable right now through the
  // ungated reads), and the teaching note. Rides the DOM_RESPONSE
  // _diagnostics relay like every other selector diagnostic.
  function computeExistsDiagnostics(sel) {
    let els;
    try {
      els = querySelectorAllDeep(sel);
    } catch (err) {
      return null; // invalid selector: the caller's own error path speaks
    }
    if (!els.length) return null; // genuinely absent — no divergence to explain
    const visible = els.filter(isElementVisible).length;
    if (visible > 0) return null; // a visible match exists — no trap
    const reasons = [];
    const sampleTexts = [];
    for (const el of els) {
      if (!el) continue;
      const reason = invisibleElementReason(el);
      if (reason && reasons.length < 3 && reasons.indexOf(reason) === -1) reasons.push(reason);
      if (sampleTexts.length < 3 && typeof el.textContent === 'string') {
        const t = el.textContent.trim().slice(0, 80);
        if (t) sampleTexts.push(t);
      }
      if (reasons.length >= 3 && sampleTexts.length >= 3) break;
    }
    sendDebugLog('warn', 'content-script', 'domExists false but selector matches invisible element(s)', {
      selector: sel, invisibleMatches: els.length, reasons
    });
    return {
      api: 'exists',
      selector: sel,
      exists: false,
      matchedButInvisible: true,
      matchCount: els.length,
      visibleCount: 0,
      invisibleCount: els.length,
      invisibleReasons: reasons,
      sampleTexts,
      note: 'selector MATCHES ' + els.length + ' element(s) but every one is invisible (' +
        (reasons.join(', ') || 'hidden') + '). $exists is visibility-gated; reads ($extract/$list/$extractList/$count) are NOT — the sample text above is readable right now via a direct read. Do not treat this false as "absent": bind the field directly or drop the $exists guard.'
    };
  }

  // Twenty-fourth log: the hover popover picker is visual by design, but a
  // tooltip's payload may mount as a HIDDEN or ZERO-HEIGHT wrapper (layout
  // never materializes) while its text is fully readable — the same
  // reads-are-not-visibility-gated asymmetry the twenty-third log fixed for
  // $exists. Reads the textContent out of nodes the visual filter rejected.
  function collectRejectedAddedTexts(nodes) {
    const out = [];
    if (!Array.isArray(nodes)) return out;
    const seen = new Set();
    for (const node of nodes) {
      if (out.length >= 3) break;
      if (!node || node.nodeType !== 1) continue;
      let txt = '';
      try { txt = String(node.textContent || ''); } catch (err) { txt = ''; }
      txt = txt.replace(/\s+/g, ' ').trim();
      if (!txt || seen.has(txt)) continue;
      seen.add(txt);
      out.push(txt.length > 120 ? txt.slice(0, 120) + '…' : txt);
    }
    return out;
  }

  // Twenty-fifth log: a list container matching ZERO while its own base
  // selector matches many is the compound-selector trap — a trailing
  // :not()/:has() clause built on an attr-name guess (data-ad-*) removed the
  // whole population, and the bare "no containers matched" error carried no
  // evidence, so the model iterated fieldMaps and input values for 60 turns
  // while the fatal clause never changed. Strips trailing filter clauses
  // (balanced-paren scan) and counts each stage live.
  function stripTrailingFilterClause(sel) {
    const s = String(sel || '').trim();
    if (!s || s.slice(-1) !== ')') return null;
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      if (ch === ')') { depth += 1; continue; }
      if (ch === '(') {
        depth -= 1;
        if (depth === 0) {
          const m = s.slice(0, i).match(/:(not|has)$/i);
          return m ? s.slice(0, i - m[0].length) : null;
        }
      }
    }
    return null;
  }

  // Returns [{sel, count}] from the FULL selector down to the stripped base
  // (later entries are weaker), or null when the selector has no strippable
  // trailing clause / is a comma list / cannot be counted. Best-effort: an
  // invalid intermediate stage stops the walk, keeping earlier stages.
  function computeSelectorDifferential(sel) {
    if (typeof sel !== 'string' || !sel) return null;
    // Fifty-first log: a comma is only a LIST SEPARATOR at paren depth 0.
    // Commas inside functional pseudo-class arguments — :has(a[href*='/posts/'],
    // a[href*='/permalink/']) is the standard inclusion-list shape — are part of
    // ONE compound selector and must not disable the differential (the blanket
    // indexOf(',') bail shipped a bare "no containers matched" while the
    // stripped base matched 4). Quote-aware so '(' / ',' inside attribute
    // values cannot skew the depth count.
    {
      let d = 0, q = null;
      for (const ch of sel) {
        if (q) { if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'") { q = ch; continue; }
        if (ch === '(') d += 1;
        else if (ch === ')') d -= 1;
        else if (ch === ',' && d === 0) return null;
      }
    }
    const stages = [];
    let cur = sel.trim();
    let guard = 0;
    while (cur && guard++ < 5) {
      let count = 0;
      try {
        count = querySelectorAllDeep(cur).length;
      } catch (err) {
        break;
      }
      stages.push({ sel: cur, count: count });
      const next = stripTrailingFilterClause(cur);
      if (next === null || !next.trim() || next.trim() === cur) break;
      cur = next.trim();
    }
    return stages.length >= 2 ? stages : null;
  }

  // Human/model-readable collapse line: weakest stage first, then each clause
  // re-added with the count it produces, so the reader sees WHERE the
  // population dies. Returns null when the differential carries no signal.
  function formatSelectorDifferentialNote(diff) {
    if (!Array.isArray(diff) || diff.length < 2) return null;
    const weakest = diff[diff.length - 1];
    for (const st of diff) {
      if (st.count > 0) {
        const parts = [];
        for (let i = diff.length - 1; i >= 0; i--) {
          const clause = i === diff.length - 1 ? diff[i].sel : '+' + diff[i].sel.slice(diff[i + 1].sel.length);
          parts.push(clause + ' → ' + diff[i].count);
        }
        return 'SELECTOR DIFFERENTIAL: ' + parts.join('; ') +
          ' — your trailing :not()/:has() clause(s) removed EVERY item the base selector matches' +
          ' (weakest form "' + weakest.sel + '" matched ' + weakest.count + ')' +
          '. Census each clause by counting with and without it before iterating anything else:' +
          ' an exclusion built on an attr-NAME guess (data-ad-*, data-sponsored-*) is often a design-system' +
          ' attribute present on ALL cards, ads and organic alike.';
      }
    }
    return 'SELECTOR DIFFERENTIAL: even the stripped base "' + weakest.sel + '" matched 0 — the page holds' +
      ' no elements for the base selector itself, so this is a population/input question, not your filter clauses.';
  }

  // Forty-fourth log: the zero-match paths attach a selector differential,
  // but a PARTIAL population loss was invisible — a verify container whose
  // trailing :has() exclusion removed 2 of 6 base matches shipped a census
  // with no clause-cost evidence, so the model had no way to audit its own
  // exclusion clause's polarity. On a populated container with strippable
  // trailing clauses, attach the clause-by-clause counts to the census; note
  // only when the clauses actually removed something (else it's noise).
  function attachClauseCostCensus(diagnostics, containerSel) {
    if (!diagnostics || typeof containerSel !== 'string') return diagnostics;
    const diff = computeSelectorDifferential(containerSel);
    if (!diff || diff.length < 2) return diagnostics;
    diagnostics.selectorDifferential = diff;
    const base = diff[0].count;
    const kept = diff[diff.length - 1].count;
    if (kept < base) {
      diagnostics.note = 'SELECTOR DIFFERENTIAL (clause cost on a POPULATED container): ' +
        diff.map((st) => st.sel + ' → ' + st.count).join('; ') +
        ' — trailing clause(s) removed ' + (base - kept) + ' of ' + base + ' base matches.' +
        ' Verify each exclusion clause against sampled matches: an attr-NAME-based exclusion' +
        ' (data-* design-system attributes) often matches organic items too — check polarity,' +
        ' not just presence.';
    }
    return diagnostics;
  }

  // Twenty-fourth log root fix (hidden-risk follow-up): tooltip and card-name
  // payloads frequently live ONLY in the hidden-but-readable element an ARIA
  // reference attribute points at (aria-labelledby="id1 id2"). Resolves the
  // id list and concatenates the referenced elements' text. Reads are not
  // visibility-gated, so this works when the visual popover never renders.
  function resolveLabelledbyText(el, attr) {
    const out = { text: '', attr: attr || 'aria-labelledby', refCount: 0, missingIds: [] };
    let raw = '';
    try { raw = el.getAttribute(attr) || ''; } catch (err) { raw = ''; }
    if (!raw.trim()) {
      // Forty-third log: pages hang the machine-readable value on a
      // DESCENDANT of the matched element (time anchor a > span[aria-
      // labelledby] → hidden #id span mounted lazily elsewhere). When the
      // matched element carries NEITHER reference attribute, resolve via
      // its first descendant that carries either one. Own attributes
      // always win — descent is a fallback, and the sibling-attr check
      // below keeps an explicit aria-describedby request honest.
      let ownSibling = '';
      try {
        ownSibling = (attr === 'aria-labelledby')
          ? (el.getAttribute('aria-describedby') || '')
          : (el.getAttribute('aria-labelledby') || '');
      } catch (err) { ownSibling = ''; }
      if (!ownSibling.trim() && typeof el.querySelector === 'function') {
        let carrier = null;
        try { carrier = el.querySelector('[aria-labelledby],[aria-describedby]'); } catch (err) { carrier = null; }
        if (carrier) {
          let carrierAttr = '';
          try { carrierAttr = carrier.getAttribute(out.attr) || ''; } catch (err) { carrierAttr = ''; }
          const resolvedAttr = carrierAttr.trim() ? out.attr
            : (out.attr === 'aria-labelledby' ? 'aria-describedby' : 'aria-labelledby');
          const via = resolveLabelledbyText(carrier, resolvedAttr);
          via.viaDescendant = carrier.tagName ? String(carrier.tagName).toLowerCase() : 'descendant';
          via.note = (via.note ? via.note + ' ' : '') + '(resolved via descendant <' + via.viaDescendant + '> — the matched element itself carries no reference attribute)';
          return via;
        }
      }
      out.note = 'element matched but ' + out.attr + ' is absent — check the sibling reference attrs (aria-describedby, aria-label) or read textContent directly';
      return out;
    }
    const ids = raw.trim().split(/\s+/).slice(0, 12);
    const texts = [];
    for (const id of ids) {
      let ref = null;
      try { ref = document.getElementById(id); } catch (err) { ref = null; }
      if (!ref) { out.missingIds.push(id); continue; }
      out.refCount += 1;
      const t = String(ref.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) texts.push(t);
    }
    out.text = texts.join(' ');
    if (!out.text && !out.missingIds.length) {
      out.note = out.attr + ' references ' + ids.length + ' element(s) but none carry text';
    } else if (out.missingIds.length && !out.text) {
      out.note = out.attr + ' references id(s) that resolve to nothing in this document (dynamic/stale ids): ' + out.missingIds.slice(0, 3).join(', ');
    }
    return out;
  }

  async function domLabelledby(sel, attr, timeoutMs) {
    const refAttr = (attr === 'aria-describedby' || attr === 'aria-labelledby') ? attr : 'aria-labelledby';
    await domQuerySelector(sel, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 5000);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    const resolved = resolveLabelledbyText(found.element, refAttr);
    const _diagnostics = {
      api: 'labelledby',
      selector: sel,
      attr: refAttr,
      refCount: resolved.refCount,
      missingIds: resolved.missingIds,
      textLength: resolved.text.length
    };
    if (resolved.note) _diagnostics.note = resolved.note;
    // Forty-third log: disclose when the resolution went through a
    // descendant carrier (the matched element had no reference attribute).
    if (typeof resolved.viaDescendant === 'string') {
      _diagnostics.viaDescendant = resolved.viaDescendant;
      _diagnostics.resolvedAttr = resolved.attr;
    }
    // Thirty-second log RC-C: the DSL used to flatten this to the bare text
    // string while probe.labelledby showed the {text, ...} object — the probe
    // is empirical evidence and beat the prose doc, so step scripts copied
    // `.text` off a string and the field was structurally always empty.
    // Return the self-describing object (same shape as the probe): empty
    // paths carry their falsification note IN the return value.
    return { result: resolved, _diagnostics };
  }

  // Sixty-fifth log: the step-side timestamp primitive. The research side
  // has probe.timestamp (fifty-sixth log); the STEP DSL had nothing, and the
  // 65th session hand-rolled EIGHT artifact versions of the candidate dance:
  // labelledby-only reads (empty on cold verify tabs where the reference
  // chain is not mounted), then anchor visible-text unions (junk from media
  // anchors passing first-match filters — the verify tags TIME_FIELD_IMPLAUSIBLE
  // were flagging exactly that junk), then fire-and-forget $hover calls whose
  // captured tooltip htmlSnippet — the absolute date, visibly mounting on
  // screen — was discarded on arrival by `try { await $hover(...) } catch {}`.
  // One call now does the whole dance per card: labelledby / aria-label /
  // visible text (the source that survives cold tabs) + the hover-mounted
  // popover's own text, filtered to date-shaped candidates, ABSOLUTE
  // preferred over a relative age. Mirrors wizard-utils' extractDateSubstrings
  // (sixty-fourth log) — the drift-guard test pins the two behaviors equal.
  var TS_MAX_HOVER_ANCHORS = 3;
  var TS_MAX_WHOLE_VALUE_CHARS = 60;
  // Code-review P2: cross-call shared hover budget. $timestamp's per-call cap
  // (TS_MAX_HOVER_ANCHORS × timeoutMs) still multiplied across calls — a
  // loop over N cards burned N×3×4500ms of dwell while labels kept arriving
  // for free. The budget is shared per content-script instance (per page) and
  // only covers the HOVER dwells; when exhausted, remaining hovers are
  // skipped (label harvest continues) and the result's note explains.
  // Sixty-ninth review F2 (budget ratchet): the budget RECHARGES when
  // location.href changes (a real navigation or SPA route change means a new
  // page population; letting the budget ratchet to zero forever starves
  // long sessions — over-fresh beats never-fresh). TS_currentHref is a
  // helper so tests can stub it.
  var TS_HOVER_BUDGET_FULL_MS = 30000;
  var TS_SHARED_HOVER_BUDGET_MS = TS_HOVER_BUDGET_FULL_MS;
  var TS_SHARED_HOVER_PRIOR_SPEND_MS = 0;
  var TS_LAST_HREF = null;
  function TS_currentHref() {
    try { return String((typeof location !== 'undefined' && location && location.href) || ''); } catch (_) { return ''; }
  }
  var TS_REL_RE = /\b(?:second|minute|hour|day|week|month|year)s?\s+ago\b|[0-9一二三四五六七八九十百千]+\s*(?:秒|分钟|分|小时|时|天|日|周|月|年)\s*前/i;
  var TS_SHAPE_RES = [
    /(?:january|february|march|april|may|june|july|august|september|october|november|december)/i,
    /\d{1,2}:\d{2}/,
    /\b\d+\s*(?:second|sec|minute|min|hour|hr|day|week|month|year)s?\b/i,
    /\b(?:second|minute|hour|day|week|month|year)s?\s+ago\b/i,
    /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,
    /\d{4}\s*年/,
    /[0-9一二三四五六七八九十百千]+\s*(?:秒|分钟|分|小时|时|天|日|周|月|年)/
  ];
  var TS_DATE_SUBSTRING_RES = [
    /\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?/g,
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:[ ,]+at[ ,]+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))?/g,
    /\b\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?/g,
    /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*\d{1,2}:\d{2})?/g,
    /\b\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/g,
    /[0-9一二三四五六七八九十百千]+\s*(?:秒|分钟|分|小时|时|天|日|周|月|年)\s*前/g
  ];
  // Sixty-ninth log: full-vs-partial absolute classification (twin of
  // wizard-utils hasYearToken — regex parity pinned by the twins test).
  // "August 2" is date-shaped and not relative, so the binary relative flag
  // blessed it as a FULL absolute while the tooltip carried the year.
  var TS_HAS_YEAR_RES = [/\b(?:19|20)\d{2}\b/, /\d{4}\s*年/];
  function TS_hasYear(v) {
    const s = String(v == null ? '' : v);
    for (const re of TS_HAS_YEAR_RES) { if (re.test(s)) return true; }
    return false;
  }
  function extractDateSubstringsCS(text) {
    const s = String(text == null ? '' : text);
    if (!s) return [];
    const out = [];
    const seen = new Set();
    for (const re of TS_DATE_SUBSTRING_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s)) !== null) {
        const v = m[0].replace(/\s+/g, ' ').trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
    }
    return out.filter((v) => !out.some((w) => w !== v && w.includes(v)));
  }
  async function domTimestamp(sel, opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const anchorSel = (typeof o.anchorSel === 'string' && o.anchorSel.trim()) ? o.anchorSel.trim()
      : 'a:has(span[aria-labelledby]), [aria-labelledby], abbr[aria-label], time';
    const timeoutMs = (typeof o.timeoutMs === 'number' && o.timeoutMs > 0) ? o.timeoutMs : 4500;
    // F2 recharge: a changed href means the page navigated (SPA route change
    // included) — restore the full budget and forget prior spend.
    {
      const hrefNow = TS_currentHref();
      if (TS_LAST_HREF !== null && hrefNow !== TS_LAST_HREF) {
        TS_SHARED_HOVER_BUDGET_MS = TS_HOVER_BUDGET_FULL_MS;
        TS_SHARED_HOVER_PRIOR_SPEND_MS = 0;
      }
      TS_LAST_HREF = hrefNow;
    }
    const spendAtCallStart = TS_SHARED_HOVER_PRIOR_SPEND_MS;
    const index = (typeof o.index === 'number' && o.index >= 0) ? Math.floor(o.index) : 0;
    // Code-review P3 (selector hygiene): querySelectorAllDeep swallows
    // SyntaxError internally — an invalid container selector would come back
    // as "0 containers" (a cold-tab-shaped false negative) instead of a named
    // error. Probe the selector and rethrow named.
    try { document.querySelectorAll(sel); } catch (e) {
      throw new Error('$timestamp container selector invalid: ' + sel + ' — ' + ((e && e.message) || String(e)));
    }
    const containers = querySelectorAllDeep(sel);
    if (!containers.length) {
      return { result: { error: 'ELEMENT_NOT_FOUND: ' + sel + ' — $timestamp takes the repeating card container selector', note: 'no containers matched — cold tab? await $wait(sel) first' }, _diagnostics: { api: 'timestamp', selector: sel, containers: 0 } };
    }
    const container = containers[Math.min(index, containers.length - 1)];
    let anchors = [];
    // Code-review P3: same hygiene for anchorSel — the old catch swallowed
    // the SyntaxError into anchors=[] (a silent "no timestamp here" for what
    // is a typo'd selector).
    try { anchors = Array.prototype.slice.call(container.querySelectorAll(anchorSel)); }
    catch (e) { throw new Error('$timestamp anchor selector invalid: ' + anchorSel + ' — ' + ((e && e.message) || String(e))); }
    const candidates = [];
    const seen = new Set();
    const push = (value, source) => {
      const str = typeof value === 'string' ? value.trim() : '';
      if (!str) return;
      const add = (v, rel) => {
        const k = source + '|' + v;
        if (seen.has(k)) return;
        seen.add(k);
        candidates.push({ value: v.slice(0, 120), source: source, relative: rel, partial: !rel && !TS_hasYear(v) });
      };
      if (str.length <= TS_MAX_WHOLE_VALUE_CHARS) {
        for (const re of TS_SHAPE_RES) {
          if (re.test(str)) { add(str, TS_REL_RE.test(str)); return; }
        }
        return;
      }
      for (const sub of extractDateSubstringsCS(str)) add(sub, TS_REL_RE.test(sub));
    };
    let hoversDone = 0;
    let hoverBudgetExhausted = false;
    for (let ai = 0; ai < anchors.length; ai++) {
      const anchor = anchors[ai];
      if (!anchor || anchor.nodeType !== 1) continue;
      push((anchor.getAttribute && anchor.getAttribute('aria-label')) || '', 'aria-label');
      push((anchor.textContent || ''), 'text');
      let lbl = null;
      try { lbl = harvestAnchorLabel(anchor); } catch (_) { lbl = null; }
      if (lbl && lbl.text) push(lbl.text, 'labelledby');
      // Hover only while no FULL absolute candidate exists yet and the anchor
      // budget holds — once a year-carrying date is in hand, remaining
      // anchors cost nothing but time. A PARTIAL absolute ("August 2") does
      // NOT satisfy this gate: the 69th session's cheap labelledby month-day
      // stopped the hunt before the tooltip carrying the full date was ever
      // hovered. Default 4500ms: tooltips mount in 600-1600ms, and
      // narrowing the dwell below that (the 65th session's 1200ms) closes
      // the capture window before the popover appears.
      const haveAbs = candidates.some((c) => !c.relative && !c.partial);
      if (haveAbs || hoversDone >= TS_MAX_HOVER_ANCHORS) continue;
      if (TS_SHARED_HOVER_BUDGET_MS <= 0) { hoverBudgetExhausted = true; break; }
      hoversDone += 1;
      let hv = null;
      const __hvT0 = Date.now();
      try { hv = await domHover(anchor, null, { timeoutMs: timeoutMs }); } catch (_) { hv = null; }
      // Code-review P2: charge the measured dwell to the shared budget (min
      // 1ms so uninstrumented fast returns cannot make it infinite).
      const __hvSpend = Math.max(1, Date.now() - __hvT0);
      TS_SHARED_HOVER_BUDGET_MS -= __hvSpend;
      TS_SHARED_HOVER_PRIOR_SPEND_MS += __hvSpend;
      if (hv && hv.htmlSnippet) {
        // Popover text is structurally prose ("Shared with Public ·
        // Friday, …") — never a whole-value candidate; extract substrings.
        const popText = String(hv.htmlSnippet).replace(/<[^>]*>/g, ' ');
        for (const sub of extractDateSubstringsCS(popText)) {
          const k = 'popoverText|' + sub;
          if (seen.has(k)) continue;
          seen.add(k);
          candidates.push({ value: sub.slice(0, 120), source: 'popoverText', relative: TS_REL_RE.test(sub), partial: !TS_REL_RE.test(sub) && !TS_hasYear(sub) });
        }
      }
    }
    // Pick order (sixty-ninth log): full absolute (year token present) →
    // partial absolute (year-less month-day) → relative.
    const absolute = candidates.find((c) => !c.relative && !c.partial) || candidates.find((c) => !c.relative) || null;
    const relative = candidates.find((c) => c.relative) || null;
    const heuristic = absolute ? absolute.value : (relative ? relative.value : '');
    const result = {
      // 机械-语义分离（spec 3.B）：heuristicValue 是日历通用形态的便捷
      // 默认；识别职责归研究期 LLM —— candidates[]（原文+来源）才是
      // 一等公民。value 为旧名别名，保留一个版本周期。
      heuristicValue: heuristic,
      value: heuristic,
      absolute: absolute ? absolute.value : null,
      absoluteSource: absolute ? absolute.source : null,
      relative: relative ? relative.value : null,
      candidates: candidates,
      anchorsProbed: anchors.length,
      hoversDispatched: hoversDone
    };
    if (!candidates.length) {
      result.note = 'no date-shaped value on this card (labelledby / aria-label / visible text / hover popover text). If the page exposes no timestamp for these cards, renegotiate the field via io.confirm instead of shipping titles or junk as postTime.';
    } else if (absolute && absolute.partial) {
      // Sixty-ninth log: distinct from a relative-only harvest — an absolute
      // WAS found but it lacks a year. $timestamp's own hover phase already
      // ran over this card's anchors; narrowing anchorSel to the timestamp
      // link and re-running gives the hover budget to the one anchor that
      // matters.
      result.note = 'the absolute candidate lacks a YEAR (month-day only — recent items often render relative ages while older ones render month-day; this population mixes them). If the year or clock time matters, the hover tooltip usually carries the full date — this call\'s own hover phase already ran, so narrow anchorSel to the timestamp link itself and re-run $timestamp, or bind via read:\'hoverPopover\' with your own match regex.';
    }
    if (hoverBudgetExhausted) {
      // F2 note fidelity: only blame EARLIER $timestamp calls when prior
      // calls actually consumed budget; a first-call exhaustion means this
      // card's own anchors spent it.
      const who = spendAtCallStart > 0
        ? 'shared hover budget exhausted on this page after earlier $timestamp calls'
        : "this card's own anchors exhausted the shared hover budget";
      result.note = (result.note ? result.note + ' ' : '') +
        'hovering stopped (' + who + ') — narrow anchorSel to the time-bearing anchor(s) via probe, or renegotiate the field via io.confirm; labels are still harvested without hovering; the budget recharges when the page navigates';
    }
    notifyBackgroundDiagnostic('timestamp_done', {
      selector: sel, anchors: anchors.length, hoversDispatched: hoversDone, absoluteFound: !!absolute
    });
    return { result, _diagnostics: { api: 'timestamp', selector: sel, anchors: anchors.length, hovers: hoversDone, absolute: !!absolute } };
  }

  async function domExists(sel, timeoutMs) {
    // B11: an explicitly numeric timeoutMs of 0 (or negative) means "one
    // immediate query" — `timeoutMs || 5000` used to read 0 as unset and
    // burn the full 5s poll.
    const budget = (typeof timeoutMs === 'number') ? Math.max(0, timeoutMs) : 5000;
    const deadline = Date.now() + budget;
    while (true) {
      const found = querySelectorDeep(sel);
      if (found && isElementVisible(found.element)) {
        sendDebugLog('info', 'content-script', 'domExists found', { selector: sel });
        return true;
      }
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))));
    }
    sendDebugLog('info', 'content-script', 'domExists not found', { selector: sel, timeoutMs: budget });
    return false;
  }

  // WS5: returns true once the element's text/attr stops changing across N
  // consecutive checks — a content-stability completion signal for streaming
  // content (AI answers, live feeds). Returns false on timeout (not stable).
  async function domWaitForStable(sel, opts) {
    // Forty-ninth log: activation coverage — waiting for streaming content
    // to settle is waiting on rendering, which a throttled tab never does.
    return await withTabActivation('waitForStable', async () => {
      opts = opts || {};
      const attr = opts.attr || null;
      const interval = opts.interval || 1500;
      const stableChecks = opts.stableChecks || 2;
      const maxMs = opts.maxMs || 20000;
      const deadline = Date.now() + maxMs;
      let lastVal = null;
      let stableCount = 0;
      let stable = false;
      while (Date.now() < deadline) {
        const found = querySelectorDeep(sel);
        let val = null;
        if (found && found.element) {
          val = attr ? found.element.getAttribute(attr) : (found.element.textContent || '').trim();
        }
        if (val && val.length > 0 && val === lastVal) {
          stableCount++;
          if (stableCount >= stableChecks) {
            stable = true;
            break;
          }
        } else {
          stableCount = 0;
          lastVal = val;
        }
        await new Promise(r => setTimeout(r, interval));
      }
      const diag = {
        api: 'waitForStable',
        selector: sel || null,
        stable: stable,
        stableCount: stableCount
      };
      if (!stable) {
        // Forty-ninth log: a not-stable timeout on a page that is hidden or
        // unfocused is a throttle diagnosis, not a content diagnosis — the
        // streaming content may simply never have been allowed to arrive.
        const pageState = readPageFrameState();
        diag.pageState = pageState;
        sendDebugLog('info', 'content-script', 'domWaitForStable not stable within maxMs', { selector: sel, maxMs, pageState });
      } else {
        sendDebugLog('info', 'content-script', 'domWaitForStable stable', { selector: sel, stableCount });
      }
      return { result: stable, _diagnostics: diag };
    });
  }

  function domCount(sel) {
    let els;
    try {
      els = querySelectorAllDeep(sel);
    } catch (err) {
      // Ninth-log M4: an invalid selector must surface as an error — a silent
      // 0 poisons the caller's grounding ("no such element" from a selector
      // that never ran). The DSL guide teaches the same contract for steps.
      sendDebugLog('error', 'content-script', 'domCount invalid selector', { selector: sel, error: err.message });
      throw err;
    }
    const count = els.length;
    const ops = getListExtractOps();
    const _diagnostics = ops && ops.computeSimpleSelectorDiagnostics
      ? ops.computeSimpleSelectorDiagnostics(els, sel, 'count')
      : { api: 'count', selector: sel, matchCount: count, sampleTexts: [], sampleHrefs: [] };
    sendDebugLog('info', 'content-script', 'domCount result', { selector: sel, count });
    return { result: count, _diagnostics };
  }

  function domList(sel) {
    const results = [];
    let els = [];
    try {
      els = querySelectorAllDeep(sel);
      els.forEach(el => results.push(elToData(el)));
    } catch (err) {
      // Ninth-log M4: see domCount — invalid selectors throw, never [] .
      sendDebugLog('error', 'content-script', 'domList invalid selector', { selector: sel, error: err.message });
      throw err;
    }
    const ops = getListExtractOps();
    const _diagnostics = ops && ops.computeSimpleSelectorDiagnostics
      ? ops.computeSimpleSelectorDiagnostics(els, sel, 'list')
      : { api: 'list', selector: sel, matchCount: els.length, sampleTexts: [], sampleHrefs: [] };
    sendDebugLog('info', 'content-script', 'domList result', { selector: sel, count: results.length });
    return { result: results, _diagnostics };
  }

  function domExtractList(containerSel, fieldMap, opts) {
    if (!containerSel || typeof containerSel !== 'string') {
      throw new Error('$extractList containerSel must be a non-empty string');
    }
    let containers;
    try {
      containers = querySelectorAllDeep(containerSel);
    } catch (err) {
      throw new Error('$extractList container selector invalid: ' + (err.message || err));
    }
    sendDebugLog('info', 'content-script', 'domExtractList resolved containers', {
      selector: containerSel,
      count: containers.length,
      fields: Object.keys(fieldMap || {})
    });
    const ops = getListExtractOps();
    if (!ops) {
      throw new Error('$extractList runtime missing: lib/list-extract-ops.js did not attach window.ListExtractOps. Reload the extension and refresh the target tab.');
    }
    if (containers.length === 0) {
      // Twenty-fifth log: zero containers with a compound selector must not
      // fail evidence-free — the trailing-clause differential tells the caller
      // whether their own :not()/:has() removed the population.
      const diff = computeSelectorDifferential(containerSel);
      const diffNote = formatSelectorDifferentialNote(diff);
      if (!(opts && opts.allowEmpty)) {
        const err = new Error('$extractList: no containers matched' + (diffNote ? ' — ' + diffNote : ''));
        err._diagnostics = {
          api: 'extractList',
          containerSelector: containerSel,
          containerMatches: 0,
          perField: [],
          selectorDifferential: diff,
          note: diffNote || 'no containers matched'
        };
        throw err;
      }
      return {
        result: [],
        _diagnostics: {
          api: 'extractList',
          containerSelector: containerSel,
          containerMatches: 0,
          perField: [],
          selectorDifferential: diff,
          note: diffNote || 'no containers matched (allowEmpty set)'
        }
      };
    }
    if (typeof ops.resetMatchGuardSkips === 'function') ops.resetMatchGuardSkips();
    const records = ops.extractListRecords(containers, fieldMap, opts || {});
    const _diagnostics = ops && ops.computeExtractListDiagnostics
      ? ops.computeExtractListDiagnostics(containers, fieldMap, containerSel)
      : { api: 'extractList', containerSelector: containerSel, containerMatches: containers.length, perField: [] };
    if (_diagnostics && typeof ops.getMatchGuardSkips === 'function') {
      const _mgSkips = ops.getMatchGuardSkips();
      if (_mgSkips > 0) _diagnostics.matchGuardSkips = _mgSkips;
    }
    attachClauseCostCensus(_diagnostics, containerSel);
    notifyBackgroundDiagnostic('extractList_entry', {
      containerSelector: containerSel,
      containerMatches: containers.length,
      fields: Object.keys(fieldMap || {})
    });
    return { result: records, _diagnostics };
  }

  // Multi-match variant of domExtractList. Each field value is an Array of
  // all matches in document order (textContent or attribute value), not just
  // the first match. Use when CSS alone can't disambiguate which match is the
  // right one (e.g. a[role=link] inside an FB post matches BOTH the author
  // link and the timestamp link — the LLM needs both so it can pick by text
  // regex in JS). Regression for console.log 2026-07-26 RC4.
  function domExtractListMulti(containerSel, fieldMap, opts) {
    if (!containerSel || typeof containerSel !== 'string') {
      throw new Error('$extractListMulti containerSel must be a non-empty string');
    }
    let containers;
    try {
      containers = querySelectorAllDeep(containerSel);
    } catch (err) {
      throw new Error('$extractListMulti container selector invalid: ' + (err.message || err));
    }
    sendDebugLog('info', 'content-script', 'domExtractListMulti resolved containers', {
      selector: containerSel,
      count: containers.length,
      fields: Object.keys(fieldMap || {})
    });
    const ops = getListExtractOps();
    if (!ops) {
      throw new Error('$extractListMulti runtime missing: lib/list-extract-ops.js did not attach window.ListExtractOps. Reload the extension and refresh the target tab.');
    }
    if (typeof ops.extractListMultiRecords !== 'function') {
      // Drift between lib/list-extract-ops.js and the inline fallback in this
      // file. The drift guard test should prevent this — if you see this error
      // at runtime, run the drift-guard test and update the inline fallback to
      // mirror the module's public api.
      throw new Error('$extractListMulti runtime stale: ops.extractListMultiRecords missing — lib/list-extract-ops.js and content-script.js inline fallback are out of sync. Reload the extension; if it persists, run test/inline-list-extract-ops-drift.test.js.');
    }
    if (containers.length === 0) {
      // Twenty-fifth log: same zero-container differential as domExtractList.
      const diff = computeSelectorDifferential(containerSel);
      const diffNote = formatSelectorDifferentialNote(diff);
      if (!(opts && opts.allowEmpty)) {
        const err = new Error('$extractListMulti: no containers matched' + (diffNote ? ' — ' + diffNote : ''));
        err._diagnostics = {
          api: 'extractListMulti',
          containerSelector: containerSel,
          containerMatches: 0,
          perField: [],
          selectorDifferential: diff,
          note: diffNote || 'no containers matched'
        };
        throw err;
      }
      return {
        result: [],
        _diagnostics: {
          api: 'extractListMulti',
          containerSelector: containerSel,
          containerMatches: 0,
          perField: [],
          selectorDifferential: diff,
          note: diffNote || 'no containers matched (allowEmpty set)'
        }
      };
    }
    const records = ops.extractListMultiRecords(containers, fieldMap, opts || {});
    // Fourth-session log 2026-08-31: step 2 counted posts by filtering hrefs
    // extracted with attr:'href' — the diagnostic sampled nothing for attr
    // fields, so the zero-match regex was invisible. multiMode samples every
    // match in the first container; sampleValues carries the real shapes.
    const _diagnostics = ops && ops.computeExtractListDiagnostics
      ? ops.computeExtractListDiagnostics(containers, fieldMap, containerSel, true)
      : { api: 'extractList', containerSelector: containerSel, containerMatches: containers.length, perField: [] };
    if (_diagnostics && typeof ops.getMatchGuardSkips === 'function') {
      const _mgSkips = ops.getMatchGuardSkips();
      if (_mgSkips > 0) _diagnostics.matchGuardSkips = _mgSkips;
    }
    if (_diagnostics && _diagnostics.api === 'extractList') _diagnostics.api = 'extractListMulti';
    attachClauseCostCensus(_diagnostics, containerSel);
    notifyBackgroundDiagnostic('extractListMulti_entry', {
      containerSelector: containerSel,
      containerMatches: containers.length,
      fields: Object.keys(fieldMap || {})
    });
    return { result: records, _diagnostics };
  }

  async function domClickInList(containerSel, subSel, opts) {
    if (!containerSel || typeof containerSel !== 'string') {
      throw new Error('$clickInList containerSel must be a non-empty string');
    }
    if (!subSel || typeof subSel !== 'string') {
      throw new Error('$clickInList subSel must be a non-empty string');
    }
    // Forty-ninth log: activation coverage — the expand-click's lazy
    // hydration after each click needs compositor frames like every other
    // rendering-dependent op.
    return await withTabActivation('clickInList', async () => {
      let containers;
      try {
        containers = querySelectorAllDeep(containerSel);
      } catch (err) {
        throw new Error('$clickInList container selector invalid: ' + (err.message || err));
      }
      sendDebugLog('info', 'content-script', 'domClickInList resolved containers', {
        selector: containerSel,
        count: containers.length,
        subSelector: subSel
      });
      const delayMs = (opts && typeof opts.delayMs === 'number') ? opts.delayMs : 500;
      const ops = getListExtractOps();
      if (!ops) {
        throw new Error('$clickInList runtime missing: lib/list-extract-ops.js did not attach window.ListExtractOps. Reload the extension and refresh the target tab.');
      }
      const clickResult = ops.clickInListItems(
        containers,
        subSel,
        (el) => { el.click(); },
        delayMs
      );
      // The pure helper is synchronous; per-click spacing is approximated by a single
      // post-batch sleep. For long lists requiring strict per-click timing, split across
      // orchestrator iterations (see DSL guide's EXPAND-THEN-EXTRACT block).
      if (delayMs > 0 && clickResult.clicked > 1) {
        await new Promise(r => setTimeout(r, Math.min(delayMs, 500)));
      }
      sendDebugLog('info', 'content-script', 'domClickInList done', {
        selector: containerSel,
        clicked: clickResult.clicked,
        errors: clickResult.errors.length
      });
      // console.log 2026-08-23: total clickInList failure (0 clicked, all
      // containers 'subSel not found') was invisible to autoFix — instrumented
      // like the extractList family so the evidence rides the DOM_RESPONSE.
      const _diagnostics = (typeof ops.computeClickInListDiagnostics === 'function')
        ? ops.computeClickInListDiagnostics(containers, subSel, containerSel, clickResult)
        : null;
      return { result: { clicked: clickResult.clicked, errors: clickResult.errors }, _diagnostics };
    });
  }

  // ===== Scroll APIs =====
  // Scroll the TARGET page (window or matched element), not the sandbox iframe.
  // All three return { scrolled, prevY, newY } (or { found } for scrollIntoView)
  // so step scripts can terminate loops when the position stops changing — the
  // canonical "loaded everything" signal for infinite-feed pages (Facebook,
  // Twitter, LinkedIn). Without these, step scripts emitted dead
  // `if (scrollable) { /* nothing */ }` blocks and declared the feed exhausted
  // after the first batch (bugx.log 2026-07-24).
  function resolveScrollTarget(sel) {
    if (!sel) return null;
    const found = querySelectorDeep(sel);
    if (!found) {
      throw new Error('ELEMENT_NOT_FOUND: ' + sel + ' (scroll target)');
    }
    return found.element;
  }

  async function domScrollBy(sel, deltaY) {
    // Forty-ninth log: scroll-driven lazy-load needs compositor frames
    // exactly like the trusted-wheel path — domScrollToBottom has been
    // wrapped since RC20 while scrollBy/scrollIntoView/waitForStable/
    // clickInList were the uncovered remainder, so a user switching away
    // froze the feed (count stuck at 2 then 8 across 18 iterations) with no
    // re-activation ever attempted.
    return await withTabActivation('scrollBy', async () => {
      const target = resolveScrollTarget(sel);
      const root = target || document.scrollingElement || document.documentElement;
      const prevY = root.scrollTop || 0;
      const delta = typeof deltaY === 'number' && isFinite(deltaY) ? Math.trunc(deltaY) : 0;
      const finish = async (r) => {
        await attachScrollEvidence(r);
        sendDebugLog('info', 'content-script', 'domScrollBy', {
          selector: sel || '(window)',
          deltaY: delta,
          prevY: r.prevY,
          newY: r.newY,
          scrolled: r.scrolled,
          pageState: r.pageState || null,
          frameSample: r.frameSample || null
        });
        return {
          result: r,
          _diagnostics: {
            api: 'scrollBy',
            selector: sel || null,
            moved: !!r.scrolled,
            pageState: r.pageState || null,
            frameSample: r.frameSample || null,
            throttleNote: r.throttleNote || null
          }
        };
      };
      if (delta === 0) {
        return finish({ scrolled: false, prevY, newY: prevY });
      }
      root.scrollBy ? root.scrollBy(0, delta) : (root.scrollTop = prevY + delta);
      const newY = root.scrollTop || 0;
      if (newY !== prevY) {
        return finish({ scrolled: true, prevY, newY });
      }
      // Forty-sixth log: a frozen WINDOW root is not a frozen page. The feed
      // may scroll inside an inner overflow container — the window sits at its
      // bottom while the feed has more, and $scrollBy loops reported
      // scrolled:false forever (scrollUntil then declared the feed exhausted
      // on window evidence alone). Mirror domScrollToBottom's inner-container
      // fallback: when the primary root made NO position change, probe for a
      // real scrollable element and scroll THAT. Coordinates switch to the
      // root that actually scrolled so no-progress loops still terminate
      // correctly; the window coordinate survives as rootY and the fallback
      // key discloses the path.
      const ops = getScrollOps();
      const inner = (ops && typeof ops.findScrollableContainer === 'function')
        ? ops.findScrollableContainer(document)
        : null;
      if (inner && inner !== root) {
        const innerPrev = inner.scrollTop || 0;
        inner.scrollBy ? inner.scrollBy(0, delta) : (inner.scrollTop = innerPrev + delta);
        const innerNew = inner.scrollTop || 0;
        return finish({
          scrolled: innerNew !== innerPrev,
          prevY: innerPrev,
          newY: innerNew,
          rootY: newY,
          fallback: 'inner-container'
        });
      }
      return finish({ scrolled: false, prevY, newY });
    });
  }

  async function domScrollToBottom(sel) {
    const target = resolveScrollTarget(sel);
    const initialRoot = target || document.scrollingElement || document.documentElement;
    // RC19 follow-up (console.log 2026-07-29): use getScrollOps() instead of
    // direct window.ScrollOps lookup. Diagnostic proved Chrome's MV3 injection
    // glitch leaves window.ScrollOps unset after mid-session reloads — without
    // this, $scrollToBottom silently degrades to the legacy one-shot path and
    // the trusted-wheel stack never fires.
    const ops = getScrollOps();
    const t0 = (typeof Date !== 'undefined') ? Date.now() : 0;
    notifyBackgroundDiagnostic('scrollToBottom_entry', {
      selector: sel || null,
      hasScrollOps: !!ops,
      hasIncremental: !!(ops && typeof ops.scrollToBottomIncremental === 'function'),
      initialRootTag: initialRoot && initialRoot.tagName,
      initialScrollTop: (initialRoot && initialRoot.scrollTop) || 0,
      initialScrollHeight: (initialRoot && initialRoot.scrollHeight) || 0,
      initialClientHeight: (initialRoot && initialRoot.clientHeight) || 0
    });
    // Defensive: if the lib helper didn't load, fall back to the legacy one-shot
    // behavior so the API still functions (older bug logs show this matters).
    if (!ops || typeof ops.scrollToBottomIncremental !== 'function') {
      const prevY = initialRoot.scrollTop || 0;
      const bottom = initialRoot.scrollHeight || 0;
      initialRoot.scrollTo ? initialRoot.scrollTo(0, bottom) : (initialRoot.scrollTop = bottom);
      const legacyResult = {
        scrolled: (initialRoot.scrollTop || 0) !== prevY,
        prevY, newY: initialRoot.scrollTop || 0,
        path: 'legacy'
      };
      notifyBackgroundDiagnostic('scrollToBottom_legacy', {
        selector: sel || null,
        prevY: legacyResult.prevY,
        targetBottom: bottom,
        newY: legacyResult.newY,
        scrolled: legacyResult.scrolled,
        elapsedMs: Date.now() - t0
      });
      sendDebugLog('warn', 'content-script', 'domScrollToBottom', {
        selector: sel || '(window)',
        note: 'ScrollOps helper missing — used legacy one-shot scroll',
        prevY, targetBottom: bottom, newY: initialRoot.scrollTop || 0
      });
      return legacyResult;
    }

    // RC19 (console.log 2026-07-28): trusted-wheel fallback.
    // When programmatic scrollBy stalls (no growth, no position change), ask
    // background to dispatch a CDP Input.dispatchMouseEvent mouseWheel — the
    // only programmatic mechanism that produces an isTrusted=true wheel event.
    // Background fast-fails if Enhanced Mode is off, so this is a no-op for
    // users who haven't opted in. The fallback is generic; no site-specific
    // logic here.
    //
    // RC25 (console.log 2026-08-04): consult enhancedModeCache BEFORE sending
    // the TRUSTED_WHEEL_SCROLL_REQUEST message. Without the cache, every stall
    // in an Enhanced-Mode-off run produced a full round-trip just to learn
    // "debugger permission not granted" — dozens of wasted messages per FB
    // scrape. Now: first stall queries the cache (one round-trip to read
    // chrome.storage.local via background), subsequent stalls short-circuit
    // when known-disabled. Per-invocation flag ensures we emit ONE
    // trustedWheel_skipped marker per $scrollToBottom (not per stall) so the
    // log stays readable.
    let trustedWheelSkipLoggedThisInvocation = false;
    const trustedWheelFallback = async (info) => {
      // Short-circuit when Enhanced Mode is known-disabled.
      const enabled = await enhancedModeCache.getState();
      if (!enabled) {
        if (!trustedWheelSkipLoggedThisInvocation) {
          trustedWheelSkipLoggedThisInvocation = true;
          notifyBackgroundDiagnostic('trustedWheel_skipped', {
            selector: sel || null,
            reason: 'enhanced mode disabled',
            attempt: info && info.attempt
          });
        }
        return { dispatched: false, ok: false, reason: 'enhanced mode disabled' };
      }
      notifyBackgroundDiagnostic('trustedWheel_request', {
        selector: sel || null,
        attempt: info && info.attempt,
        deltaY: info && info.deltaY,
        scrollRoot: info && info.scrollRoot
      });
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'TRUSTED_WHEEL_SCROLL_REQUEST',
          deltaY: info && info.deltaY,
          attempt: info && info.attempt
        });
        const wrapped = response || { dispatched: false, reason: 'no response from background' };
        notifyBackgroundDiagnostic('trustedWheel_response', {
          selector: sel || null,
          attempt: info && info.attempt,
          dispatched: !!wrapped.dispatched,
          ok: !!wrapped.ok,
          reason: wrapped.reason || null
        });
        return wrapped;
      } catch (e) {
        notifyBackgroundDiagnostic('trustedWheel_response', {
          selector: sel || null,
          attempt: info && info.attempt,
          dispatched: false,
          ok: false,
          reason: 'sendMessage error: ' + (e && e.message || String(e))
        });
        return { dispatched: false, reason: 'sendMessage error: ' + (e && e.message || String(e)) };
      }
    };

    // Per-iter progress reporter — mirrors into background SW via the same
    // diagnostic relay used by entry/exit logging. Bounded by maxAttempts (8),
    // so at most 8 messages per $scrollToBottom invocation — well under any
    // rate-limit concern. The receiver is the background SW which is awake
    // for the duration of the scrape.
    const onIter = (info) => {
      notifyBackgroundDiagnostic('scrollToBottom_iter', info);
    };

    // RC20 (console.log 2026-07-30): wrap the scroll work in withTabActivation
    // so the scrape tab is the active tab during the op (RC56: activation is
    // sticky — it persists after the op; landing on the user's last-clicked
    // tab happens when the scrape tab closes). Chrome's
    // renderer only produces compositor frames for the active tab; both the
    // IntersectionObserver-based growth probe AND the CDP trusted-wheel
    // fallback depend on frame production. This is the one layer that the
    // four-layer throttle stack (visibility-keepalive, Enhanced Mode, launch
    // flags, trusted-wheel) could not be — they address throttle/lifecycle
    // but not the underlying frame-production rule. Generic; no FB-specific
    // logic here. degrades gracefully if activation fails (cross-window,
    // missing chrome.tabs, etc.) — the scroll still runs, it just may not
    // trigger lazy-load on throttled renderers.
    return await withTabActivation('scrollToBottom', async () => {
      // First attempt: incremental scroll on the resolved root.
      const r1 = await ops.scrollToBottomIncremental(initialRoot, {
        scrollRootLabel: target ? ('selector:' + sel) : 'window',
        trustedWheelFallback: trustedWheelFallback,
        onIter: onIter
      });

      // Fallback: if the resolved root made zero position progress, probe for
      // an inner scrollable container and try again. This catches pages whose
      // scroll root is an inner overflow:auto element, not the document OR not
      // the element the LLM guessed (e.g. FB wraps the real scrollable feed
      // inside a non-scrolling div[role=main]; the LLM picks the wrapper).
      // Probing whenever r1.scrolled is false — selector or not — is the
      // generic fix and matches what a human would do: if the obvious scroll
      // root doesn't move, look for a real scrollable element. Site-agnostic.
      //
      // RC19 follow-up (console.log 2026-07-29): the no-overflow early-exit in
      // scroll-ops.js returns attempts:0, so the old `r1.attempts > 0` gate
      // would have skipped this probe exactly when we need it most. Accept
      // either signal: attempts > 0 (loop ran but stalled) OR noOverflow (loop
      // refused to run because the root has no scroll range).
      if (!r1.scrolled && (r1.attempts > 0 || r1.noOverflow)) {
        const inner = typeof ops.findScrollableContainer === 'function'
          ? ops.findScrollableContainer(document)
          : null;
        if (inner && inner !== initialRoot) {
          notifyBackgroundDiagnostic('scrollToBottom_innerFallback', {
            selector: sel || null,
            innerTag: inner.tagName,
            innerScrollHeight: inner.scrollHeight || 0,
            innerClientHeight: inner.clientHeight || 0,
            r1: r1
          });
          const r2 = await ops.scrollToBottomIncremental(inner, {
            scrollRootLabel: 'inner',
            trustedWheelFallback: trustedWheelFallback,
            onIter: onIter
          });
          sendDebugLog('info', 'content-script', 'domScrollToBottom', {
            selector: sel || '(window)',
            fallback: 'inner-container',
            attempt1: r1,
            attempt2: r2
          });
          r2.path = 'inner';
          notifyBackgroundDiagnostic('scrollToBottom_done', {
            selector: sel || null,
            path: 'inner',
            r1: r1,
            r2: r2,
            elapsedMs: Date.now() - t0
          });
          return r2;
        }
      }

      sendDebugLog('info', 'content-script', 'domScrollToBottom', {
        selector: sel || '(window)',
        result: r1
      });
      r1.path = 'incremental';
      notifyBackgroundDiagnostic('scrollToBottom_done', {
        selector: sel || null,
        path: 'incremental',
        r1: r1,
        elapsedMs: Date.now() - t0
      });
      return r1;
    });
  }

  async function domScrollIntoView(sel) {
    // Forty-ninth log: same activation coverage as the rest of the scroll
    // family — scrolling a lazy-load feed into view needs frames.
    return await withTabActivation('scrollIntoView', async () => {
      if (!sel) throw new Error('$scrollIntoView requires a selector');
      const found = querySelectorDeep(sel);
      if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
      const el = found.element;
      if (typeof el.scrollIntoView === 'function') {
        // behavior:'instant' avoids the smooth-scroll animation so subsequent
        // $extract calls land on the final layout. Older browsers ignore the
        // options arg and fall back to the default (block:'start' equivalent).
        try { el.scrollIntoView({ block: 'start', behavior: 'instant' }); }
        catch { el.scrollIntoView(); }
      }
      sendDebugLog('info', 'content-script', 'domScrollIntoView', { selector: sel });
      return {
        result: { found: true },
        _diagnostics: { api: 'scrollIntoView', selector: sel || null }
      };
    });
  }

  // $hover DSL primitive: dispatch a trusted mouseMoved at the anchor's
  // bounding-box center via CDP so the page's JS hover handler fires with
  // event.isTrusted=true. After hover, poll for popoverSel; once present,
  // return its outerHTML as htmlSnippet. Used for hovercard enrichment —
  // fields not in the list DOM but present in the page's hover popover.
  //
  // WHY CDP: same root cause as RC19 trusted-wheel. Sites whose hover handlers
  // filter on event.isTrusted=true (link-preview loaders, hovercard fetches)
  // ignore JS-only mouseover/mouseenter events because they have
  // isTrusted=false. CDP Input.dispatchMouseEvent enters Chrome's input
  // pipeline so the resulting event is trusted. JS event dispatch
  // (el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))) is NOT
  // a substitute — the isTrusted property is read-only and always false for
  // script-initiated events.
  //
  // WHY TAB ACTIVATION: compositor frames are produced only for the active
  // tab — without frames, hover handlers tied to layout (most of them) won't
  // run. Mirrors domScrollToBottom's RC20 wrapping.
  //
  // Returns { hovered, htmlSnippet, popoverSelector, reason? }. Never throws
  // on hover/popover failure — returns hovered:false or htmlSnippet:null so
  // the LLM script can branch. Throws only on ELEMENT_NOT_FOUND for the
  // anchor (so the LLM gets an autoFix-able error, not silent empty).
  //
  // Structural identity of a popover element for hover results. Shared by
  // the SUCCESS path (the element the htmlSnippet was captured from) and
  // the FAILURE path (the best candidate auto-discovery observed) so the
  // two can never drift. meta carries the scoring-cascade fields when the
  // element came out of auto-discovery; an explicit-selector capture passes
  // only source and the geometry fields are computed here (cheap one-shot
  // reads on a single element).
  function popoverIdentityOf(node, meta, ox, oy) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    try {
      var m = meta || {};
      var posAbsolute = m.posAbsolute;
      var z = m.z;
      if (posAbsolute == null || z == null) {
        try {
          var st = (node.ownerDocument && node.ownerDocument.defaultView || window).getComputedStyle(node);
          if (st) {
            if (posAbsolute == null) posAbsolute = (st.position === 'absolute' || st.position === 'fixed');
            if (z == null) {
              var zr = st.zIndex;
              if (zr !== 'auto' && zr !== '') { var zi = parseInt(zr, 10); if (isFinite(zi) && zi > 0) z = zi; }
            }
          }
        } catch (_) { /* geometry must never break the identity */ }
      }
      var dist = m.dist;
      var area = m.area;
      if (dist == null || area == null) {
        try {
          var r2 = node.getBoundingClientRect();
          if (r2) {
            if (area == null && r2.width > 0 && r2.height > 0) area = Math.round(r2.width * r2.height);
            if (dist == null && typeof ox === 'number' && isFinite(ox)) {
              var dx = (r2.left + r2.width / 2) - ox;
              var dy = (r2.top + r2.height / 2) - oy;
              dist = Math.round(Math.sqrt(dx * dx + dy * dy));
            }
          }
        } catch (_) { /* geometry must never break the identity */ }
      }
      var obClass = typeof node.className === 'string'
        ? node.className.replace(/\s+/g, ' ').trim() : '';
      return {
        tag: node.tagName,
        role: (node.getAttribute('role') || '').slice(0, 80),
        ariaLabel: (node.getAttribute('aria-label') || '').slice(0, 80),
        id: (node.id || '').slice(0, 80),
        classHead: obClass.slice(0, 120),
        source: m.source != null ? m.source : null,
        posAbsolute: (posAbsolute == null) ? null : posAbsolute,
        z: (z == null) ? null : z,
        dist: (dist == null) ? null : dist,
        area: (area == null) ? null : area,
        wonTicks: (m.wonTicks == null) ? null : m.wonTicks,
        lastSeenDwellMs: (m.lastDwellMs == null) ? null : m.lastDwellMs
      };
    } catch (_) { return null; }
  }

  // Forty-second log: resolve an anchor's accessible label — the text its
  // aria-labelledby (or aria-describedby, fallback) referenced elements
  // carry. Timestamps, icon buttons, and compact labels routinely hold their
  // FULL value only in those hidden-but-readable references, which the page
  // mounts lazily (often only once the anchor has been hovered). Runs at
  // harvest time inside domHover, BEFORE the dismiss: the same mouseout that
  // closes the popover can unmount the referenced text (24th-log lesson,
  // applied to the anchor's own label). Returns {text, attr, note}; a quiet
  // {text:'', attr:null, note:null} when the anchor carries no reference
  // attribute at all (nothing to harvest — not an error).
  function harvestAnchorLabel(el) {
    if (!el || typeof el.getAttribute !== 'function') return { text: '', attr: null, note: null };
    var firstWithAttr = null;
    var attrs = ['aria-labelledby', 'aria-describedby'];
    for (var i = 0; i < attrs.length; i++) {
      var raw = '';
      try { raw = String(el.getAttribute(attrs[i]) || ''); } catch (_) { raw = ''; }
      if (!raw.trim()) continue;
      if (!firstWithAttr) firstWithAttr = attrs[i];
      var resolved = resolveLabelledbyText(el, attrs[i]);
      if (resolved.text) {
        return { text: resolved.text.slice(0, 1000), attr: attrs[i], note: null };
      }
    }
    if (!firstWithAttr) {
      // Forty-third log: the anchor itself carries no reference attribute —
      // the value may hang on a descendant carrier (the resolver descends
      // when the element has neither attr). Quiet only when nothing exists
      // anywhere in the subtree.
      var descended = resolveLabelledbyText(el, 'aria-labelledby');
      if (descended.text) {
        return {
          text: descended.text.slice(0, 1000),
          attr: descended.attr,
          note: (typeof descended.viaDescendant === 'string') ? (descended.note || null) : null
        };
      }
      // Forty-fourth log: on a cold tab the whole chain can be unmounted or
      // carry stale ids — a silent {text:'', attr:null, note:null} is
      // indistinguishable from "no label exists" and shipped postingTime ""
      // 4/4 with zero falsification receipts. Keep the resolver's note
      // (absent-attr / resolve-to-nothing / descent disclosure) and the
      // probed attr name so the empty is auditable.
      return { text: '', attr: descended.attr || null, note: descended.note || null };
    }
    var fallback = resolveLabelledbyText(el, firstWithAttr);
    return { text: '', attr: firstWithAttr, note: fallback.note || null };
  }

  async function domHover(selOrEl, popoverSel, opts) {
    if (!selOrEl) throw new Error('$hover requires an anchor selector or element');
    // Sixth-log followup: per-anchor phase timings. Run 1 of the 2026-09-01
    // log burned ~7s/anchor BETWEEN logged events (dismiss-ok → next
    // anchor's activation) with no way to attribute it from the log —
    // scrollIntoView-triggered virtualized reflow and a deep popoverSel
    // query over a huge DOM are indistinguishable without timestamps.
    var hoverT0 = Date.now();
    opts = opts || {};
    var timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 4500;
    var dismiss = (typeof opts.dismiss === 'boolean') ? opts.dismiss : true;
    var index = (typeof opts.index === 'number' && Number.isFinite(opts.index)) ? Math.floor(opts.index) : null;
    // RC43 constants for the three-gate acceptance check.
    //   - MIN_HOVERCONTENT_TEXT_LEN: empty pre-allocated portal wrappers have
    //     no children and no meaningful text. Requiring >= 20 chars of trimmed
    //     text rejects them while still accepting hovercards that render as
    //     pure text (rare but possible).
    //   - STABILITY_SAMPLE_INTERVAL_MS: outerHTML is sampled this often; two
    //     consecutive equal samples mark content as stable. The prior 250ms
    //     interval meant stability converged in 500ms minimum, eating the
    //     3000ms timeout budget across multiple candidates. 100ms converges
    //     in 200ms.
    var MIN_HOVERCONTENT_TEXT_LEN = 20;
    var STABILITY_SAMPLE_INTERVAL_MS = 100;
    // RC47 (console.log 2026-08-13): no-signal early-exit threshold. Real
    //   hovercards mount in 600-1600ms (per empirical captures across
    //   portal-based hovercard frameworks). If no signal has appeared — no
    //   MutationObserver additions AND no popoverSel match (verified via
    //   querySelectorDeep(popoverSel) + isElementVisible) — the anchor almost
    //   certainly has no hovercard. With $extractWithHover iterating many
    //   anchors per container (and the LLM sometimes writing overly-broad
    //   anchorSels that match post permalinks, timestamps, etc.), unbounded
    //   polling wastes minutes per step. The NO_SIGNAL_EARLY_EXIT_MS constant
    //   caps it. RC60 (user decision 2026-08-19): relaxed 1500 → 3000ms for
    //   robustness on slow-mounting hovercards; the polling default timeout
    //   rose 3000 → 4500ms in lockstep so this branch stays reachable (at
    //   threshold == timeout it would be dead code) and no-signal anchors
    //   stay capped at 3s. The path (a) match check (earlyPathAMatch via
    //   popoverSel + isElementVisible) preserves RC39 pre-allocated portals
    //   (which never fire MutationObserver but DO match popoverSel once CSS
    //   reveals them via isElementVisible).
    var NO_SIGNAL_EARLY_EXIT_MS = 3000;

    // RC45: accept a resolved DOM element as the first argument. Callers like
    // $extractWithHover iterate anchors inside a specific container and pass
    // them directly, bypassing global querySelector enumeration. The
    // element branch MUST run before the string branches so opts.index is
    // ignored when an element is supplied (the caller already chose the
    // anchor; index would re-enumerate globally and reintroduce the
    // alignment bug this primitive exists to fix). Same signature, backward
    // compatible: existing $hover callers pass strings and behave unchanged.
    var anchor = null;
    var selectorForLog = selOrEl;
    if (selOrEl && typeof selOrEl === 'object' && selOrEl.nodeType) {
      anchor = selOrEl;
      selectorForLog = '[element:' + (selOrEl.tagName || 'DIV') + ']';
    } else if (index !== null) {
      // Multi-record addressing: when opts.index is set, enumerate ALL matches
      // and pick the Nth. This is the correct way to hover "the i-th anchor in
      // a list" — `:nth-of-type(N)` is a CSS TRAP (matches the Nth sibling OF
      // THE SAME TAG, not the Nth compound-selector match) and silently picks
      // the wrong anchor or none. Same addressing semantics as `$list()[N]`.
      if (index < 0) throw new Error('INDEX_OUT_OF_RANGE: $hover opts.index must be >= 0, got ' + index);
      var matches = querySelectorAllDeep(selOrEl);
      if (matches.length === 0) throw new Error('ELEMENT_NOT_FOUND: ' + selOrEl);
      if (index >= matches.length) throw new Error('INDEX_OUT_OF_RANGE: $hover opts.index=' + index + ' but selector matched only ' + matches.length + ' element(s)');
      anchor = matches[index];
    } else {
      var found = querySelectorDeep(selOrEl);
      if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + selOrEl);
      anchor = found.element;
    }

    // Scroll anchor into view so the bounding rect has viewport coordinates
    // CDP can target. Without this, an anchor below the fold has negative/
    // out-of-range y and the mouseMoved lands on the wrong pixel.
    if (typeof anchor.scrollIntoView === 'function') {
      try { anchor.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      catch { anchor.scrollIntoView(); }
      // Layout settles within a frame; a 50ms wait covers the reflow.
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    var scrollDoneAt = Date.now();

    var rect = anchor.getBoundingClientRect();
    // Sixty-third log: a degenerate rect (display:none / zero-size — e.g. a
    // hidden tooltip span dragged in by a broad union anchorSel like
    // `[aria-labelledby]`) used to fall through to a fixed (400,400)
    // "viewport center" dispatch point that had no relationship to the
    // anchor. The full pipeline then ran (activation + CDP mouseMoved +
    // ~3s no-signal dwell + dismiss) and the receipt reported
    // no_hover_signal_early_exit — which reads as "this anchor has no
    // popover" when the truth is that hover was structurally impossible: no
    // box, no pixels, no mouse target, ever. Same failure genre as the
    // sixty-second log's deterministic gate: report the structural fact,
    // skip everything, keep the label harvest (hidden elements are
    // perfectly readable — reading needs no box).
    // G1 (seventy-second log): an ATTACHED zero-box anchor is not
    // necessarily display:none — a VIRTUALIZED feed reclaims the boxes of
    // off-screen cards while the nodes stay in the tree. The 72nd session's
    // timestamp anchor hover was refused as anchor_not_hoverable on a
    // 0×0 rect, the popover could never mount, and the model quoted the
    // tool-blindness as a page fact ("no year exists anywhere"). ONE
    // remount retry: walk up to ~8 ancestor levels for anything with a
    // nonzero box, scroll THAT into view (a recycled anchor's own
    // scrollIntoView is a no-op — its box was reclaimed), wait for
    // re-layout, re-read the anchor's rect. If the box came back, fall
    // through to the normal pipeline with the refreshed rect. A display:none
    // node in a live subtree also retries here — harmlessly: its rect stays
    // 0×0 and the existing early-out below still fires.
    var gateReasonDetail = null;
    if ((rect.width <= 0 || rect.height <= 0) && anchor.isConnected) {
      var remountTarget = null;
      var walkNode = anchor;
      for (var wl = 0; wl < 8 && walkNode && walkNode.nodeType === 1; wl++) {
        var wr = walkNode.getBoundingClientRect();
        if (wr.width > 0 && wr.height > 0) { remountTarget = walkNode; break; }
        walkNode = walkNode.parentElement;
      }
      if (remountTarget && typeof remountTarget.scrollIntoView === 'function') {
        try { remountTarget.scrollIntoView({ block: 'center', behavior: 'instant' }); }
        catch (_) { try { remountTarget.scrollIntoView(); } catch (_2) { remountTarget = null; } }
        if (remountTarget) {
          await new Promise(function (r) { setTimeout(r, 250); });
          rect = anchor.getBoundingClientRect();
          // Only an ATTEMPTED remount that still yields 0×0 earns the
          // attached/virtualized reasonDetail — a box-less walk with no
          // scrollable ancestor (the classic display:none-in-a-live-tree
          // case, and the JSDOM all-zero-rect world) keeps the original
          // deterministic note.
          if (rect.width <= 0 || rect.height <= 0) {
            gateReasonDetail = 'attached, box-less after scroll retry (virtualized or hidden subtree)';
          }
        }
      }
    }
    if (rect.width <= 0 || rect.height <= 0) {
      notifyBackgroundDiagnostic('hover_request', {
        selector: selectorForLog,
        popoverSelector: popoverSel || null,
        hoverX: null, hoverY: null,
        dispatched: false, ok: false, reason: 'anchor_not_hoverable',
        reasonDetail: gateReasonDetail,
        anchorRect: { width: rect.width, height: rect.height },
        // Same shape as the dispatch-path diagnostic so SW-log readers never
        // fork on which fields exist — baselines are honestly false here
        // (the skip precedes baseline sampling).
        popoverBaselineSampled: false,
        baselineEfpCount: 0
      });
      var notHoverableLabel = null;
      try { notHoverableLabel = harvestAnchorLabel(anchor); } catch (_) { notHoverableLabel = null; }
      var notHoverable = {
        hovered: false,
        htmlSnippet: null,
        popoverSelector: null,
        autoDiscovered: false,
        hoverDispatched: false,
        hoverReason: 'anchor_not_hoverable',
        reason: 'anchor_not_hoverable',
        reasonDetail: gateReasonDetail,
        anchorRect: { width: rect.width, height: rect.height },
        // G2 (seventy-second log): the note branches on the CAUSE. An
        // attached-but-box-less node (virtualization reclaimed the box
        // off-screen) is RECOVERABLE by scrolling and re-resolving; a
        // display:none node is not — pick a different anchor. The old
        // single note taught NO-retry unconditionally, which the 72nd log
        // falsified for the virtualized case.
        budgetNote: gateReasonDetail
          ? 'the anchor element is attached but rendered box-less — off-screen virtualized cards reclaim boxes: scroll the card into view and RE-RESOLVE the anchor (re-query after scroll), then retry; a display:none element (this note absent) instead means pick a different, visible anchor'
          : 'the anchor element has no rendered box (display:none or zero size — typically a hidden tooltip span a broad union anchorSel matched), so no mouse dispatch can ever target it — this is a property of the anchor, not a transient and not evidence about popovers: do NOT retry it. Narrow anchorSel to VISIBLE interactive elements, or read the value through the non-hover routes — labelledby/attr/text reads work on hidden elements (the anchor-label harvest ran; its result is attached when the references resolve).'
      };
      if (notHoverableLabel) {
        if (notHoverableLabel.text) {
          notHoverable.labelledbyText = notHoverableLabel.text;
          notHoverable.labelledbyAttr = notHoverableLabel.attr;
        } else if (notHoverableLabel.note) {
          notHoverable.labelledbyAttr = notHoverableLabel.attr;
          notHoverable.labelledbyNote = notHoverableLabel.note;
        }
      }
      return notHoverable;
    }
    var x = Math.round(rect.left + rect.width / 2);
    var y = Math.round(rect.top + rect.height / 2);

    // Popover detection. Two paths:
    //   (a) If popoverSel was provided, poll for it explicitly (preferred —
    //       the LLM named the container so trust it).
    //   (b) Auto-discovery fallback: observe DOM mutations during the hover
    //       window and pick up ANY new visible element of non-trivial size.
    //       React Portal / Vue Teleport / Popper / Floating UI all render
    //       popovers as new body-level elements, so a subtree MutationObserver
    //       on document.body catches them. Size-filter rejects analytics
    //       pixels, hidden scaffolding, etc. (RC34 followup: console.log
    //       2026-08-11 showed every iteration returning htmlSnippet:null
    //       because the LLM's popoverSel guess never matched the actual
    //       portal markup.)
    // RC36 (console.log 2026-08-11 13:14+): observer MUST be set up BEFORE
    // the hover dispatch. The page's hover handler can fire synchronously
    // during the CDP roundtrip and add the popover before .observe() is
    // called. MutationObserver doesn't fire for past mutations, so a
    // late-starting observer silently misses the popover.
    var htmlSnippet = null;
    var matchedSel = null;
    var autoDiscovered = false;
    // RC47: set when the polling loop breaks early because no hover signal
    // was observed past NO_SIGNAL_EARLY_EXIT_MS. Drives the result.reason
    // field so the LLM's autoFix context can distinguish "this anchor has
    // no hovercard" from "we waited the full timeout budget".
    var earlyExited = false;
    // RC43: per-path stability tracking. Two consecutive samples of the SAME
    // element with the SAME outerHTML mark content as stable (streaming done).
    // Separate trackers per path because they observe different elements.
    var lastPopEl = null;
    var lastPopSample = null;
    var lastBestEl = null;
    var lastBestSample = null;
    // Thirty-sixth log: the element a SUCCESSFUL capture took htmlSnippet
    // from (path (a) explicit match or path (b) auto-discovered best).
    // Drives the success-path observedPopover identity.
    var capturedEl = null;

    var addedNodes = [];
    var observedBest = null;
    // Twenty-fourth log: ADDED-source nodes the visual filter rejected
    // (too_small / invisible / viewport_sized / beyond the distance cap).
    // Their textContent can still be READ (layout state is irrelevant to
    // text) — the payload of a tooltip whose visual layer never
    // materialized. Sampled before the dismiss unmounts the scaffolding.
    var rejectedAddedNodes = [];
    var observer = null;
    try {
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var arr = records[i].addedNodes;
            for (var j = 0; j < arr.length; j++) addedNodes.push(arr[j]);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) {
      sendDebugLog('warn', 'content-script', 'MutationObserver setup failed; auto-discovery disabled', { error: e && e.message });
    }

    var hoverResp = null;
    var hoverError = null;

    // RC43: Baseline sampling BEFORE hover dispatch. Two baselines:
    //   - popoverBaseline: outerHTML of popoverSel-matched element at T0.
    //     Path (a) later requires the CURRENT outerHTML to DIFFER from this
    //     baseline — so an empty pre-allocated portal wrapper (role="dialog"
    //     set, content not yet rendered) doesn't get accepted just because
    //     popoverSelector matched it. Console.log 2026-08-12 incident: a
    //     portal-based site pre-allocates
    //     `<div role="dialog" class="xtijo5x ..."></div>` at page load;
    //     popoverSel `div[role=dialog]` matched it on every tick; path (a)
    //     broke immediately and returned the empty outerHTML.
    //   - baselineEfpSnippets: Set of outerHTMLs of every element returned
    //     by elementsFromPoint at cursor + cardinal offsets at T0. Path (b)
    //     later rejects candidates whose source !== 'added' AND whose
    //     outerHTML is in this set — so pre-existing page chrome (top nav,
    //     popup layer wrappers, content sections that happen to be near the
    //     cursor) doesn't win the scoring cascade just because it has
    //     position:absolute and content.
    // Both baselines are best-effort: a thrown querySelector / elementsFromPoint
    // just leaves the baseline empty, which disables that specific check.
    var popoverBaseline = null;
    if (popoverSel) {
      try {
        // Sample popoverSel-matched element's outerHTML at T0. The IIFE keeps
        // the sampling as a single expression so source-text audits can verify
        // popoverBaseline is anchored to querySelectorDeep(popoverSel).
        popoverBaseline = (function () {
          var f = querySelectorDeep(popoverSel);
          return (f && isElementVisible(f.element)) ? f.element.outerHTML : null;
        })();
      } catch (e) {
        // baseline sampling best-effort; absence disables baseline-diff check
      }
    }
    var baselineEfpSnippets = new Set();
    if (typeof document.elementsFromPoint === 'function') {
      var baselineOffsets = [[0, 0], [0, -120], [0, 120], [-120, 0], [120, 0]];
      for (var boi = 0; boi < baselineOffsets.length; boi++) {
        var box = x + baselineOffsets[boi][0];
        var boy = y + baselineOffsets[boi][1];
        if (box < 0 || boy < 0 || box > window.innerWidth || boy > window.innerHeight) continue;
        var bstack = [];
        try { bstack = document.elementsFromPoint(box, boy) || []; }
        catch (e) { bstack = []; }
        for (var bti = 0; bti < bstack.length; bti++) {
          try {
            var bhtml = bstack[bti].outerHTML;
            if (bhtml) baselineEfpSnippets.add(bhtml);
          } catch (e) { /* skip unreadable */ }
        }
      }
    }

    try {
      var hoverResult = await withTabActivation('hover', async function () {
        return await chrome.runtime.sendMessage({
          type: 'TRUSTED_HOVER_REQUEST',
          x: x, y: y
        });
      });
      hoverResp = hoverResult || { dispatched: false, reason: 'no response from background' };
    } catch (e) {
      hoverError = e && e.message || String(e);
      hoverResp = { dispatched: false, reason: 'sendMessage error: ' + hoverError };
    }
    var preDispatchDoneAt = Date.now();

    notifyBackgroundDiagnostic('hover_request', {
      selector: selectorForLog,
      popoverSelector: popoverSel || null,
      hoverX: x, hoverY: y,
      dispatched: !!(hoverResp && hoverResp.dispatched),
      ok: !!(hoverResp && hoverResp.ok),
      reason: hoverResp ? hoverResp.reason : null,
      popoverBaselineSampled: !!popoverBaseline,
      baselineEfpCount: baselineEfpSnippets.size
    });
    var dispatchDoneAt = Date.now();

    // Forty-fifth log F1: dispatch-failure early-out. When the trusted
    // mouseMoved never reached the page (hoverResp.dispatched === false), NO
    // popover can have mounted from this hover — yet the code below used to
    // run the full dwell loop (whose first scoring tick on a giant streaming
    // DOM takes tens of seconds: addedNodes rescan from index 0, RC49
    // descendant walks, elementsFromPoint sampling, per-candidate outerHTML
    // serialization + baseline Set hashing) and then the dismiss CDP
    // roundtrip anyway. Live evidence: dispatch failed 17:20:40 and the
    // failure returned promptly (hover_request diagnostic 17:20:40.055), but
    // the result was not delivered until 17:21:05 — a 30s step-budget kill
    // with ZERO hover_auto_discover diagnostics in the gap; three such kills
    // taught the model to abandon hovercards for the rest of the session.
    // The dwell loop and the dismiss are now skipped on dispatch failure;
    // the anchor-label harvest below still runs (needs no dispatch).
    var dispatchFailed = !(hoverResp && hoverResp.dispatched);
    var dispatchedAt = Date.now();
    var deadline = dispatchedAt + timeoutMs;
    // Forty-fifth log F3: mid-tick deadline bail. The while-loop deadline is
    // only checked BETWEEN ticks; one synchronous scoring tick over a giant
    // streaming DOM can exceed the entire dwell budget by itself (see F1
    // above). The per-candidate loops below check tickOverBudget() and bail
    // mid-tick once deadline + grace has passed — returning popover_timeout
    // with deadlineBailed evidence instead of eating the caller's whole step
    // budget inside a single tick.
    var TICK_DEADLINE_GRACE_MS = 1500;
    var deadlineBailed = false;
    function tickOverBudget() {
      return Date.now() > deadline + TICK_DEADLINE_GRACE_MS;
    }
    // Forty-fifth log F2: the candidate pool persists across ticks and
    // addedNodes is consumed through a cursor. The prior code rebuilt the
    // pool EVERY tick from addedNodes[0] — on streaming pages hundreds of
    // accumulated feed mounts were re-walked (RC49 descendant descent) and
    // re-deduped (linear seenEls array scan) per tick: O(ticks × nodes²)
    // candidate work before scoring even began. Pool persistence also
    // preserves the RC43 stability contract: a candidate that passed on
    // tick N is still in the pool on tick N+1, so "same element wins two
    // consecutive ticks" remains observable.
    var candidatePool = [];
    var candidateSource = new Map();
    var seenEls = new Set();
    var addedNodesCursor = 0;
    function pushCandidate(el, source) {
      if (!el || el.nodeType !== 1) return;
      if (seenEls.has(el)) return;
      seenEls.add(el);
      candidatePool.push(el);
      candidateSource.set(el, source);
    }
    // Twenty-fourth log: keep the node REFERENCE of every rejected
    // ADDED candidate so the no-popover result can read its text.
    // candidateSource persists across ticks (F2), so an added node rejected
    // on any tick is still remembered here.
    function rememberRejectedAdded(node) {
      if (!node || node.nodeType !== 1) return;
      if (candidateSource.get(node) !== 'added') return;
      if (rejectedAddedNodes.indexOf(node) !== -1) return;
      if (rejectedAddedNodes.length >= 8) return;
      rejectedAddedNodes.push(node);
    }
    // RC49: portal-wrapper descent. Portal-based hovercard frameworks
    // (React Portals, modal-style popovers) mount in two phases: (1) create
    // an invisible wrapper DIV (display:none, visibility:hidden, opacity:0,
    // or 0x0), then (2) render the hovercard content INSIDE the wrapper as
    // a child. MutationObserver fires for the wrapper; the candidate filter
    // calls isElementVisible(wrapper) which returns false; the filter
    // rejects it without ever inspecting the visible children inside.
    //
    // console.log 2026-08-13 08:27:43-52 (post-RC48) showed 82 of 116
    // null-pick iterations with addedNodes:2 (portal mounted) where BOTH
    // added DIVs were rejected as `invisible` — 164 invisible rejections
    // across the run. Every one was a missed hovercard whose content was
    // fully rendered inside the wrapper.
    //
    // Fix: when pushCandidate surfaces an ADDED node that is itself
    // invisible, walk its descendants (bounded) and push visible
    // descendants to candidatePool with source='added'. The source tag
    // lets them win the RC46 cascade over efp-sampled page chrome.
    //
    // The walk happens BEFORE the filter loop so descendants enter the
    // scoring pool on the same tick as the wrapper mount — no extra
    // polling round-trip needed.
    var RC49_MAX_DESCENDANTS = 50;
    function collectVisibleDescendantsFromInvisibleAdded(root) {
      if (!root || root.nodeType !== 1) return;
      if (candidateSource.get(root) !== 'added') return;
      if (isElementVisible(root)) return;
      var descendants;
      try { descendants = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < descendants.length && i < RC49_MAX_DESCENDANTS; i++) {
        if (isElementVisible(descendants[i])) {
          pushCandidate(descendants[i], 'added');
        }
      }
    }
    // RC41 (console.log 2026-08-12 NINTH hover incident): gate auto-discovery
    // behind a minimum dwell time. The prior architecture picked "best of
    // pool" on the FIRST 250ms tick — before the hovercard had time to mount.
    // MutationObserver pool was empty (addedNodes:0) and elementsFromPoint
    // returned 77-113 pre-existing positioned DIVs, of which the scoring
    // cascade picked the most overlay-looking one. Result: every iteration
    // picked noise like {dist:297, area:136200} or {dist:489, area:463760}.
    // The actual hovercard appears around T=500ms (React Portal mount
    // delay — universal across portal-based hovercard frameworks). With the
    // dwell gate, the loop sleeps through the pre-hover window and only
    // scores candidates after the hovercard has had time to appear. Path
    // (a) popoverSel is exempt — explicit selectors should be honored
    // immediately.
    var MIN_AUTO_DISCOVER_DWELL_MS = 500;
    while (!dispatchFailed && Date.now() < deadline) {
      var dwellMs = Date.now() - dispatchedAt;
      // Path (a): explicit selector match.
      // RC43 (ELEVENTH hover incident, console.log 2026-08-12): the prior
      // code broke on the first visible match — accepting an empty
      // pre-allocated portal wrapper (popoverSel matched role="dialog" but
      // the wrapper had no children yet, content would fill in 100-300ms
      // later). The result was htmlSnippet = `<div role="dialog"></div>`
      // returned as success. Now apply three gates before accepting:
      // hasContent (children OR trimmed text >= MIN_HOVERCONTENT_TEXT_LEN),
      // differsFromBaseline (outerHTML !== popoverBaseline sampled at T0),
      // stable (same element + same outerHTML across two consecutive
      // samples). Fall through to path (b) on any gate failure so
      // auto_discover can catch the actual hovercard content once mounted.
      if (popoverSel) {
        var popFound = querySelectorDeep(popoverSel);
        if (popFound && isElementVisible(popFound.element)) {
          var popEl = popFound.element;
          var popHtml = popEl.outerHTML;
          var hasContent = (popEl.childElementCount > 0) ||
            ((popEl.textContent || '').trim().length >= MIN_HOVERCONTENT_TEXT_LEN);
          var differsFromBaseline = !popoverBaseline || popHtml !== popoverBaseline;
          var popStable = (lastPopEl === popEl && lastPopSample === popHtml);
          lastPopEl = popEl;
          lastPopSample = popHtml;
          if (hasContent && differsFromBaseline && popStable) {
            htmlSnippet = popHtml;
            matchedSel = popoverSel;
            capturedEl = popEl;
            break;
          }
          // Gates failed. Fall through to path (b).
        }
      }
      // Path (b): auto-discovery. Gated by MIN_AUTO_DISCOVER_DWELL_MS to
      // avoid scoring pre-existing noise before the hovercard mounts.
      //
      // Why TWO candidate sources (RC39 architectural fix):
      //   - MutationObserver catches DOM ADDITIONS (React Portal mounts,
      //     Vue Teleport mounts, Popper / Floating UI / Tippy mounts).
      //   - elementsFromPoint catches PRE-EXISTING overlays shown via
      //     CSS toggle (display:block, visibility:visible). Common in
      //     architectures that pre-allocate the portal container at page
      //     load and show/hide its children on hover. The observer cannot
      //     see these because nothing is added — only CSS changes.
      //
      // RC38 added scoring; RC38 alone was insufficient because scoring
      // only helps when the hovercard is in the candidate pool at all.
      // RC39 console.log showed `addedNodes:3, picked:null` on every
      // iteration: the hovercard was never in addedNodes (it pre-existed).
      //
      // Scoring signals (strongest first):
      //   1. position absolute/fixed (overlay positioning — primary signal)
      //   2. numeric z-index (creates stacking context; common but
      //      inherited from parent in some frameworks)
      //   3. proximity to cursor (universal — hovercards always appear
      //      AT/NEAR the anchor)
      //   4. area (larger wins on full ties)
      //
      // Hard reject: tiny additions (<50x50) and candidates too far from
      // cursor (>400px). These cannot be hovercards.

      // RC41 dwell gate: skip auto-discovery entirely for the first
      // MIN_AUTO_DISCOVER_DWELL_MS after dispatch. Path (a) above still
      // runs each tick. Without this gate, auto-discover picks pre-existing
      // noise on the first tick (T=0) because the hovercard has not yet
      // mounted — the loop breaks before the typical ~500ms portal mount
      // delay fires. Skipping auto-discover lets the loop sleep through the
      // pre-hover window.
      if (dwellMs < MIN_AUTO_DISCOVER_DWELL_MS) {
        await new Promise(function (r) { setTimeout(r, STABILITY_SAMPLE_INTERVAL_MS); });
        continue;
      }

      // RC47: no-signal early-exit. If we've polled past
      // NO_SIGNAL_EARLY_EXIT_MS with no MutationObserver activity AND no
      // visible popoverSel match, the anchor almost certainly has no
      // hovercard — break early instead of burning the rest of the timeout
      // budget. Real hovercards mount in 600-1600ms; by 1500ms something
      // would have appeared. The path (a) check preserves RC39
      // pre-allocated portals (MutationObserver blind but popoverSel
      // matches once CSS reveals them).
      if (dwellMs > NO_SIGNAL_EARLY_EXIT_MS && addedNodes.length === 0) {
        var earlyPathAMatch = false;
        if (popoverSel) {
          try {
            var earlyProbe = querySelectorDeep(popoverSel);
            earlyPathAMatch = !!(earlyProbe && isElementVisible(earlyProbe.element));
          } catch (e) { earlyPathAMatch = false; }
        }
        if (!earlyPathAMatch) {
          earlyExited = true;
          sendDebugLog('info', 'content-script', 'domHover no-signal early-exit', {
            selector: selectorForLog, dwellMs: Math.round(dwellMs),
            addedNodes: addedNodes.length, popoverSel: popoverSel || null
          });
          break;
        }
      }

      // Build candidate pool from the incremental cursor (F2): only added
      // nodes observed since the last tick are pushed/walked. Accumulated
      // feed mounts from earlier ticks are already in the persistent pool.
      // F3: check the tick budget per node — the RC49 descendant walks make
      // this loop the most expensive part of a tick on streaming pages.
      for (var k = addedNodesCursor; k < addedNodes.length; k++) {
        if (tickOverBudget()) { deadlineBailed = true; break; }
        pushCandidate(addedNodes[k], 'added');
        collectVisibleDescendantsFromInvisibleAdded(addedNodes[k]);
      }
      addedNodesCursor = addedNodes.length;
      // Path (c): elementsFromPoint sampling. Sample at cursor and
      // cardinal offsets (~120px) to catch hovercards appearing beside
      // the anchor rather than overlapping it. Wraps in try/catch since
      // the API can throw on out-of-viewport coordinates in some engines.
      if (typeof document.elementsFromPoint === 'function') {
        var offsets = [[0, 0], [0, -120], [0, 120], [-120, 0], [120, 0]];
        for (var oi = 0; oi < offsets.length; oi++) {
          var ox = x + offsets[oi][0];
          var oy = y + offsets[oi][1];
          if (ox < 0 || oy < 0 || ox > window.innerWidth || oy > window.innerHeight) continue;
          var stack = [];
          try { stack = document.elementsFromPoint(ox, oy) || []; }
          catch (e) { stack = []; }
          for (var ti = 0; ti < stack.length; ti++) {
            pushCandidate(stack[ti], 'efp');
          }
        }
      }

      // Score each candidate. Cap rejectedSummary to bound diagnostic size.
      //
      // RC40 (console.log 2026-08-12): added viewport-size rejection. The
      // prior "larger area wins on ties" tiebreaker silently preferred a
      // full-viewport positioned backdrop (area ~= innerWidth*innerHeight,
      // pos:absolute, z:0, dist<100) over the actual hovercard (~250x400)
      // because the backdrop "won" every tie dimension. Hovercards are by
      // construction smaller than the viewport: they float OVER content,
      // never covering it. A candidate with area > 50% of the viewport
      // is a backdrop/wrapper/portal-root, never the hovercard itself.
      // REJECTING these is universal: works for any site that uses a
      // portal backdrop (React Portal overlays, modal-style hover popovers,
      // loading-shim containers that persist between hovers).
      //
      // Also: track ALL passing candidates and emit the top-3 to the SW log
      // even when one wins. "Picked the wrong one of N that passed" is
      // invisible without this — only the winner was logged before.
      var viewportArea = (window.innerWidth || 0) * (window.innerHeight || 0);
      var viewportAreaThreshold = viewportArea * 0.5;
      var passingCandidates = [];
      var rejectedSummary = [];
      for (var ci = 0; ci < candidatePool.length; ci++) {
        if (tickOverBudget()) { deadlineBailed = true; break; }
        var node = candidatePool[ci];
        // F2 pool persistence: detached nodes (efp chrome removed mid-dwell,
        // portal scaffolding unmounted by the page) can never be picked —
        // skip them without paying outerHTML serialization. Added-source
        // detaches still feed the twenty-fourth-log text harvest.
        if (!node.isConnected) { rememberRejectedAdded(node); continue; }
        if (!isElementVisible(node)) {
          rememberRejectedAdded(node);
          if (rejectedSummary.length < 5) rejectedSummary.push({
            tag: node.tagName, reason: 'invisible'
          });
          continue;
        }
        var nsource = candidateSource.get(node) || 'efp';
        // RC43: reject pre-existing-unchanged candidates early. baselineEfpSnippets
        // was sampled at T0 (before hover dispatch) at cursor + cardinal offsets.
        // If a candidate's outerHTML matches a baseline entry AND its source is
        // not 'added' (MutationObserver didn't catch it as a new node), the
        // candidate is pre-existing chrome that didn't change during the hover
        // window — page nav, popup layer wrappers, content sections near the
        // cursor. The actual hovercard must either be a NEW addition (source
        // 'added') or a pre-existing element whose outerHTML CHANGED. Without
        // this reject, page chrome wins the scoring cascade on
        // posAbsolute+z+area ties.
        var nhtml = '';
        try { nhtml = node.outerHTML; } catch (e) { nhtml = ''; }
        if (nsource !== 'added' && nhtml && baselineEfpSnippets.has(nhtml)) {
          if (rejectedSummary.length < 5) rejectedSummary.push({
            tag: node.tagName,
            source: nsource,
            reason: 'pre_existed_unchanged'
          });
          continue;
        }
        var nr = node.getBoundingClientRect();
        if (nr.width < 50 || nr.height < 50) {
          rememberRejectedAdded(node);
          if (rejectedSummary.length < 5) rejectedSummary.push({
            tag: node.tagName,
            size: Math.round(nr.width) + 'x' + Math.round(nr.height),
            reason: 'too_small'
          });
          continue;
        }
        var narea = nr.width * nr.height;
        if (viewportArea > 0 && narea > viewportAreaThreshold) {
          rememberRejectedAdded(node);
          if (rejectedSummary.length < 5) rejectedSummary.push({
            tag: node.tagName,
            size: Math.round(nr.width) + 'x' + Math.round(nr.height),
            viewportRatio: Math.round((narea / viewportArea) * 100) / 100,
            reason: 'viewport_sized'
          });
          continue;
        }
        var nodeWin = node.ownerDocument && node.ownerDocument.defaultView || window;
        var nodeStyle;
        try { nodeStyle = nodeWin.getComputedStyle(node); }
        catch (e) { nodeStyle = null; }
        if (!nodeStyle) {
          rememberRejectedAdded(node);
          if (rejectedSummary.length < 5) rejectedSummary.push({
            tag: node.tagName, reason: 'no_computed_style'
          });
          continue;
        }
        var posAbsolute = (nodeStyle.position === 'absolute' || nodeStyle.position === 'fixed');
        var nz = 0;
        var zRaw = nodeStyle.zIndex;
        if (zRaw !== 'auto' && zRaw !== '') {
          var zi = parseInt(zRaw, 10);
          if (isFinite(zi) && zi > 0) nz = zi;
        }
        var ndx = (nr.left + nr.width / 2) - x;
        var ndy = (nr.top + nr.height / 2) - y;
        var ndist = Math.sqrt(ndx * ndx + ndy * ndy);
        // RC41 + RC42: UNIVERSAL distance cap. The prior filter only rejected
        // STATIC-positioned far candidates (`!posAbsolute && dist > 300`),
        // which let posAbsolute post-wrappers 400-500px from cursor win the
        // scoring cascade. Universal UX property: hovercards ALWAYS appear
        // AT/NEAR the anchor. RC41 set the cap at 400; RC42 widens it to 600
        // after console.log 2026-08-12 showed a real hovercard rejected at
        // dist:496 ('too_far_from_cursor'). Portal-based hovercard frameworks
        // commonly mount the popover centered ~400-500px below the cursor
        // when the anchor sits near the top of the viewport (popover grows
        // downward from anchor; its center ends up far from cursor center
        // because the cursor sits on the anchor at the top edge). 600 keeps
        // a margin against page-wide modals while admitting real hovercards.
        // Rejecting farther candidates regardless of positioning is
        // universal — works for any site.
        if (ndist > 600) {
          rememberRejectedAdded(node);
          if (rejectedSummary.length < 5) rejectedSummary.push({
            tag: node.tagName,
            pos: nodeStyle.position,
            dist: Math.round(ndist),
            reason: 'too_far_from_cursor'
          });
          continue;
        }
        passingCandidates.push({
          node: node, posAbsolute: posAbsolute, z: nz, dist: ndist, area: narea,
          source: nsource
        });
      }
      // F3: a mid-tick bail means the DOM outran the budget — stop polling
      // instead of sleeping into another oversized tick. The partial
      // passingCandidates of a bailed tick are discarded (never scored as a
      // pick), and the result below discloses deadlineBailed.
      if (deadlineBailed) break;
      // Sort passing candidates by the scoring cascade. RC46 reordering:
      // source ('added' beats 'efp') is checked BEFORE posAbsolute. Why: a
      // candidate that just appeared in the MutationObserver buffer (added)
      // is the strongest hovercard-mount signal — it must win over
      // pre-existing efp-sampled elements regardless of positioning. The
      // prior ordering (posAbsolute first, then source) let a pre-existing
      // positioned page chrome (posAbsolute:true, source:"efp") beat the
      // actual hovercard (posAbsolute:false on its visible inner content,
      // source:"added"). The captured htmlSnippet was page chrome, which
      // downstream classifiers then dropped for lacking hovercard-shaped
      // content — producing empty results despite the portal mount
      // succeeding. source > posAbsolute > z > dist > area.
      //
      // RC42 had moved source ahead of dist (correct) but kept posAbsolute
      // ahead of source. RC46 finishes the reorder. posAbsolute remains a
      // tiebreaker BETWEEN same-source candidates: when no portal mount was
      // observed (both source:"efp"), positioned overlays still beat static
      // content — preserving the RC39 pre-allocated-portal scenario.
      passingCandidates.sort(function (a, b) {
        if (a.source !== b.source) return a.source === 'added' ? -1 : 1;
        if (a.posAbsolute !== b.posAbsolute) return a.posAbsolute ? -1 : 1;
        if (a.z !== b.z) return b.z - a.z;
        if (a.dist !== b.dist) return a.dist - b.dist;
        return b.area - a.area;
      });
      var bestCandidate = passingCandidates.length > 0 ? passingCandidates[0] : null;
      function summarizeCandidate(c) {
        if (!c) return null;
        return {
          tag: c.node.tagName,
          posAbsolute: c.posAbsolute,
          z: c.z,
          dist: Math.round(c.dist),
          area: Math.round(c.area),
          source: c.source
        };
      }
      var consideredTop = passingCandidates.slice(0, 3).map(summarizeCandidate);
      if (bestCandidate) {
        // RC43: apply stability check before accepting. The best candidate
        // may change tick to tick (different element wins the cascade); only
        // accept when the SAME element wins TWO consecutive ticks with the
        // SAME outerHTML. Catches mid-render states where the hovercard is
        // streaming in content.
        var bestEl = bestCandidate.node;
        var bestHtml = bestEl.outerHTML;
        var bestStable = (lastBestEl === bestEl && lastBestSample === bestHtml);
        lastBestEl = bestEl;
        lastBestSample = bestHtml;
        if (bestStable) {
          htmlSnippet = bestHtml;
          matchedSel = '[auto-discovered popover]';
          autoDiscovered = true;
          capturedEl = bestEl;
        }
        // Sixth-log followup (2026-09-01): remember the best candidate the
        // cascade has seen even when it never stabilizes into a capture. A
        // failed hover that SAW a popover-sized element mount is a
        // popoverSelector MISMATCH — the summary of this observation rides
        // the failure into the step result so the selector can be rewritten
        // from evidence instead of guessed again. 'added' observations beat
        // stale 'efp' ones (a fresh mount is the popover; a positioned
        // overlay picked on an early tick is not).
        if (observedBest && observedBest.node === bestCandidate.node) {
          observedBest.wonTicks += 1;
          observedBest.lastDwellMs = Math.round(dwellMs);
        } else if (!observedBest || observedBest.source !== 'added' || bestCandidate.source === 'added') {
          observedBest = {
            node: bestCandidate.node,
            source: bestCandidate.source,
            posAbsolute: !!bestCandidate.posAbsolute,
            z: bestCandidate.z,
            dist: Math.round(bestCandidate.dist),
            area: Math.round(bestCandidate.area),
            wonTicks: 1,
            lastDwellMs: Math.round(dwellMs)
          };
        }
        notifyBackgroundDiagnostic('hover_auto_discover', {
          selector: selectorForLog,
          dwellMs: Math.round(dwellMs),
          addedNodes: addedNodes.length,
          pool: candidatePool.length,
          passing: passingCandidates.length,
          picked: summarizeCandidate(bestCandidate),
          considered: consideredTop,
          stable: bestStable,
          baselineEfpCount: baselineEfpSnippets.size
        });
      } else if (candidatePool.length > 0) {
        // Diagnostic: observer and/or elementsFromPoint caught candidates
        // but none passed the scoring filter. rejected[] surfaces per-node
        // properties + reject reason so future hover-family bugs are
        // debuggable from the SW log alone — no separate page-console
        // capture needed.
        notifyBackgroundDiagnostic('hover_auto_discover', {
          selector: selectorForLog,
          dwellMs: Math.round(dwellMs),
          addedNodes: addedNodes.length,
          pool: candidatePool.length,
          passing: 0,
          picked: null,
          considered: [],
          reason: 'no candidate passed visibility+size+viewport+distance+baseline filter',
          rejected: rejectedSummary,
          baselineEfpCount: baselineEfpSnippets.size
        });
      }
      if (htmlSnippet) break;
      await new Promise(function (r) { setTimeout(r, STABILITY_SAMPLE_INTERVAL_MS); });
    }
    if (observer) {
      try { observer.disconnect(); } catch {}
    }
    var dwellDoneAt = Date.now();

    // Twenty-fourth log: read the text out of rejected ADDED mounts BEFORE
    // the dismiss — mouseout can unmount the scaffolding, but the text is
    // the payload the visual picker could not see (zero-height/hidden).
    var rejectedAddedTexts = collectRejectedAddedTexts(rejectedAddedNodes);

    // Forty-second log (user design directive: dynamic content triggered by
    // a simulated action must be read back into THIS tool in the SAME
    // operation, before later actions can wash it away): resolve the
    // ANCHOR's accessible label here, while the hover dwell has the tooltip
    // scaffolding mounted. This runs on every path — visible popover
    // captured, popover_timeout, no_hover_signal early exit — because label
    // text frequently needs no visible popover at all.
    var anchorLabel = null;
    try { anchorLabel = harvestAnchorLabel(anchor); } catch (_) { anchorLabel = null; }

    // Dismiss: move the trusted cursor to (1,1) so hover handlers fire
    // mouseout/mouseleave and the popover closes. Best-effort — failure here
    // doesn't affect the htmlSnippet already captured.
    //
    // RC50 (console.log 2026-08-13 13:24-28): wrap dismiss in withTabActivation,
    // matching the hover path's wrapper at line 1869. RC48 raised the dismiss
    // timeout to 2000ms but 100% of dismisses still timed out — because the
    // root cause was NOT timeout duration but background-tab throttle. CDP
    // Input.dispatchMouseEvent on a background tab hangs because Chrome only
    // produces compositor frames for the active tab in the focused window
    // (RC20 architectural rule). The hover path got the wrapper in RC20; the
    // dismiss path was missed. Same CDP command (Input.dispatchMouseEvent
    // mouseMoved), same tab, same debugger — hover succeeds (active tab),
    // dismiss hung (background tab). This is the parallel asymmetry to RC48
    // (which fixed asymmetric timeouts); RC50 fixes asymmetric tab activation.
    // Forty-fifth log F1: also skip entirely on dispatch failure — the mouse
    // never moved, so there is nothing to dismiss, and the extra activation +
    // CDP roundtrip only burns the caller's budget.
    if (dismiss && !dispatchFailed) {
      try {
        await withTabActivation('hoverDismiss', async function () {
          await chrome.runtime.sendMessage({ type: 'TRUSTED_HOVER_DISMISS' });
        });
        notifyBackgroundDiagnostic('hover_dismiss', { selector: selectorForLog, ok: true });
      } catch (e) {
        notifyBackgroundDiagnostic('hover_dismiss', {
          selector: selectorForLog, ok: false,
          reason: 'sendMessage error: ' + (e && e.message || String(e))
        });
      }
    }

    var result = {
      hovered: !!(hoverResp && hoverResp.ok),
      htmlSnippet: htmlSnippet,
      popoverSelector: matchedSel,
      autoDiscovered: autoDiscovered,
      hoverDispatched: !!(hoverResp && hoverResp.dispatched),
      hoverReason: hoverResp ? hoverResp.reason : null
    };
    // Forty-second log: attach the anchor-label harvest. Success shape
    // (text + attr) and falsification shape (attr present, note why it
    // resolved nothing) — the model reads the value without regexing the
    // htmlSnippet, and a partial/failed label has its reason on-channel.
    if (anchorLabel) {
      if (anchorLabel.text) {
        result.labelledbyText = anchorLabel.text;
        result.labelledbyAttr = anchorLabel.attr;
      } else if (anchorLabel.note) {
        result.labelledbyAttr = anchorLabel.attr;
        result.labelledbyNote = anchorLabel.note;
      }
    }
    if (earlyExited) {
      result.reason = 'no_hover_signal_early_exit';
    } else if (dispatchFailed) {
      // Forty-fifth log F1: name the environmental failure and its remedy —
      // the 45th-log model read bare dispatch-failure reasons as "popovers
      // unavailable in this environment" and abandoned hovercards for the
      // whole session. The dwell budget was never spent, so the
      // popover_timeout budgetNote below would be a lie here.
      result.reason = (hoverResp && hoverResp.reason) ? hoverResp.reason : 'hover_dispatch_failed';
      // Sixty-second log: the 45th-log "transient, retry" teaching was written
      // for CDP-contention dispatch failures — but the Enhanced Mode opt-out
      // gate fails the SAME way (dispatched:false) DETERMINISTICALLY, and the
      // single transient note actively misled: one session retried 23 times,
      // every retry structurally doomed, because the receipt kept saying
      // "transient, retry". Two failure shapes, two opposite remedies.
      if (result.reason === 'enhanced mode disabled') {
        result.budgetNote = 'the trusted-hover path is opted out — Enhanced Scraping Mode is OFF (a Settings toggle, not a page property), so NO hover in this session can dispatch and no retry can change that. Popover-mounted values are unavailable until the user enables it: surface that in the finish summary. The non-hover routes still work — labelledby/attr/text reads (the anchor-label harvest above already ran) — so fall back to those or renegotiate hover-dependent fields via io.confirm.';
      } else {
        result.budgetNote = 'the trusted mouseMoved never reached the page, so no popover could mount — this is an environmental transient (busy renderer / CDP contention), not evidence about this anchor: retry the same hover before concluding popovers are unavailable';
      }
    } else if (!htmlSnippet && (popoverSel || observer)) {
      result.reason = 'popover_timeout';
      // Thirty-first log: the contract was renegotiated on underpowered
      // evidence — probes self-shrunk to a 3000ms timeoutMs read as "the
      // hovercard never renders" while later probes at 5-9s budgets captured
      // real cards. Absence at N ms says nothing about N+1 ms: disclose the
      // budget the failure is bounded by so the caller retries larger before
      // concluding the popover does not exist.
      result.timeoutMs = timeoutMs;
      result.budgetNote = 'absence is budget-bounded — hover waited ' + timeoutMs + 'ms; slow/cold popovers can exceed it, retry with a larger opts.timeoutMs before concluding the popover never renders';
      // Forty-fifth log F3: a mid-tick bail means the budget expired INSIDE
      // a scoring tick — evidence beyond the scanned prefix went unscored,
      // which is strictly different from "nothing mounted".
      if (deadlineBailed) {
        result.deadlineBailed = true;
        result.budgetNote += '; scoring bailed mid-tick (deadlineBailed) — the page DOM was too large to scan within this budget, so popover evidence beyond the scanned prefix went unscored: retry with a larger opts.timeoutMs';
      }
    } else if (!result.hovered) {
      result.reason = hoverResp && hoverResp.reason ? hoverResp.reason : 'hover_failed';
    }

    // Sixth-log followup: a bare 'popover_timeout' gave autoFix nothing to
    // act on while auto-discovery had SEEN the real popover mount — the
    // observation above was discarded at return time and the same wrong
    // popoverSelector survived two consecutive runs. Attach the observed
    // element's structural identity so the selector can be rewritten from
    // evidence (role/aria/id/class), never re-guessed.
    //
    // Thirty-sixth log: observedPopover used to ride ONLY the failure path
    // — htmlSnippet alone signaled success. But callers gate harvests on
    // "a popover was observed AND captured" (`h.observedPopover &&
    // h.htmlSnippet`), a natural reading that was structurally impossible:
    // the field was populated exactly when htmlSnippet was null (enforced
    // again at the probe relay). Whole sessions shipped hovercards:[] while
    // the hover layer worked end to end. Attach the identity on SUCCESS too
    // — naming the element the snippet was captured from (same fields, same
    // caps).
    if (capturedEl) {
      var capturedMeta = (autoDiscovered && observedBest && observedBest.node === capturedEl)
        ? observedBest
        : { source: 'explicit-selector' };
      result.observedPopover = popoverIdentityOf(capturedEl, capturedMeta, x, y);
    } else if (!htmlSnippet && observedBest && observedBest.node && typeof observedBest.node.getAttribute === 'function') {
      result.observedPopover = popoverIdentityOf(observedBest.node, observedBest, x, y);
    }
    // Twenty-fourth log: no visible popover captured, but the hover DID mount
    // nodes whose text was readable through the visual filter's rejects. A
    // tooltip whose layout never materialized still carries its payload as
    // textContent — hand it to the caller instead of a bare popover_timeout.
    if (!htmlSnippet && rejectedAddedTexts.length) {
      result.rejectedAddedTexts = rejectedAddedTexts;
      result.rejectedAddedNote = "no visible popover was captured, but the hover mounted node(s) whose text was READ out of the visual filter's rejects (hidden or zero-height mounts). reads are not visibility-gated: if the value you need appears in rejectedAddedTexts, bind the field from it directly instead of waiting for a visible popover.";
    }
    notifyBackgroundDiagnostic('hover_anchor_timing', {
      selector: selectorForLog,
      scrollMs: scrollDoneAt - hoverT0,
      preDispatchMs: preDispatchDoneAt - scrollDoneAt,
      dispatchMs: dispatchDoneAt - preDispatchDoneAt,
      dwellMs: dwellDoneAt - dispatchDoneAt,
      dismissMs: Date.now() - dwellDoneAt
    });

    sendDebugLog('info', 'content-script', 'domHover done', {
      selector: selectorForLog, popoverSelector: popoverSel || null,
      hovered: result.hovered, hasSnippet: !!htmlSnippet,
      snippetLen: htmlSnippet ? htmlSnippet.length : 0,
      autoDiscovered: autoDiscovered,
      reason: result.reason || null
    });
    return result;
  }

  // domExtractWithHover: container-scoped extract-then-hover. See
  // $EXTRACT-WITH-HOVER in SCRIPT_DSL_GUIDE for the LLM-facing contract.
  //
  // Resolves containers via querySelectorAllDeep, applies range opts
  // (containerIndex / containerRange / maxContainers), validates allowEmpty,
  // then delegates to ops.extractWithHoverRecords with the real domHover
  // injected as hoverFn. The pure helper in lib/list-extract-ops.js handles
  // the per-container anchor iteration; this wrapper handles the
  // chrome.*-dependent concerns (container resolution, diagnostics wiring).
  async function domExtractWithHover(containerSel, fieldMap, opts) {
    if (!containerSel || typeof containerSel !== 'string') {
      throw new Error('$extractWithHover containerSel must be a non-empty string');
    }
    opts = opts || {};
    var hoverConfig = opts.hover;
    if (!hoverConfig || typeof hoverConfig !== 'object') {
      throw new Error('$extractWithHover opts.hover must be an object');
    }
    if (!hoverConfig.anchorSel || typeof hoverConfig.anchorSel !== 'string') {
      throw new Error('$extractWithHover opts.hover.anchorSel must be a non-empty string');
    }
    if (!fieldMap || typeof fieldMap !== 'object' || Object.keys(fieldMap).length === 0) {
      throw new Error('$extractWithHover fieldMap must be a non-empty object');
    }
    // Range opts: at most one may be set. They narrow which containers get
    // processed before anchor iteration begins.
    var containerIndex = opts.containerIndex;
    var containerRange = opts.containerRange;
    var maxContainers = opts.maxContainers;
    var rangeOptsSet =
      (containerIndex !== null && containerIndex !== undefined ? 1 : 0) +
      (containerRange ? 1 : 0) +
      (maxContainers !== null && maxContainers !== undefined ? 1 : 0);
    if (rangeOptsSet > 1) {
      throw new Error('$extractWithHover only one of containerIndex/containerRange/maxContainers may be set');
    }
    // Resolve containers.
    var containers;
    try {
      containers = querySelectorAllDeep(containerSel);
    } catch (err) {
      throw new Error('$extractWithHover container selector invalid: ' + (err.message || err));
    }
    sendDebugLog('info', 'content-script', 'domExtractWithHover resolved containers', {
      selector: containerSel,
      count: containers.length,
      anchorSel: hoverConfig.anchorSel,
      fieldKeys: Object.keys(fieldMap)
    });
    // Mirror into the background SW console so a single log capture shows the
    // hover pipeline actually ran (third-session console.log 2026-08-23: the
    // wrapper's sendDebugLog only reached the page console, so the SW capture
    // had zero extractWithHover traces and diagnosis stalled).
    notifyBackgroundDiagnostic('extractWithHover_entry', {
      containerSelector: containerSel,
      containerMatches: containers.length,
      anchorSel: hoverConfig.anchorSel
    });
    // Apply range opts.
    var processed;
    if (containerIndex !== null && containerIndex !== undefined) {
      if (containerIndex < 0) {
        throw new Error('$extractWithHover containerIndex must be >= 0, got ' + containerIndex);
      }
      processed = (containerIndex < containers.length) ? [containers[containerIndex]] : [];
    } else if (containerRange) {
      var start = typeof containerRange[0] === 'number' ? Math.max(0, containerRange[0]) : 0;
      var end = typeof containerRange[1] === 'number' ? Math.min(containers.length, containerRange[1]) : containers.length;
      processed = containers.slice(start, end);
    } else if (maxContainers !== null && maxContainers !== undefined) {
      processed = containers.slice(0, Math.max(0, maxContainers));
    } else {
      processed = containers;
    }
    if (processed.length === 0) {
      // Twenty-fifth log: when the CONTAINER selector itself matched nothing
      // (not range filtering), attach the trailing-clause differential — same
      // evidence duty as domExtractList.
      var _contDiff = containers.length === 0 ? computeSelectorDifferential(containerSel) : null;
      var _contDiffNote = formatSelectorDifferentialNote(_contDiff);
      if (opts.allowEmpty) {
        return {
          result: [],
          _diagnostics: {
            api: 'extractWithHover',
            containerSelector: containerSel,
            containerMatches: 0,
            processedContainers: 0,
            perField: [],
            selectorDifferential: _contDiff,
            hoverSummary: { anchorsFound: 0, hovercardsCaptured: 0, hoverFailures: 0 }
          }
        };
      }
      var _noContainersErr = new Error('$extractWithHover: no containers matched' +
        (rangeOptsSet === 1 ? ' (after range filtering)' : '') +
        (_contDiffNote ? ' — ' + _contDiffNote : ''));
      _noContainersErr._diagnostics = {
        api: 'extractWithHover',
        containerSelector: containerSel,
        containerMatches: 0,
        processedContainers: 0,
        perField: [],
        selectorDifferential: _contDiff,
        hoverSummary: { anchorsFound: 0, hovercardsCaptured: 0, hoverFailures: 0 },
        note: 'no containers matched' + (rangeOptsSet === 1 ? ' after range filtering' : '') +
          (opts.allowEmpty ? '' : ' (allowEmpty not set)')
      };
      throw _noContainersErr;
    }
    var ops = getListExtractOps();
    if (!ops) {
      throw new Error('$extractWithHover runtime missing: lib/list-extract-ops.js did not attach window.ListExtractOps. Reload the extension and refresh the target tab.');
    }
    if (typeof ops.extractWithHoverRecords !== 'function') {
      throw new Error('$extractWithHover runtime stale: ops.extractWithHoverRecords missing — lib/list-extract-ops.js and content-script.js inline fallback are out of sync. Reload the extension; if it persists, run test/inline-list-extract-ops-drift.test.js.');
    }
    // Delegate the per-container iteration to the pure helper. Inject the
    // real domHover (refactor in Task 1 lets domHover accept the anchor
    // element directly, bypassing global querySelector).
    if (typeof ops.resetMatchGuardSkips === 'function') ops.resetMatchGuardSkips();
    // Seventieth log F1: forward opts.maxWallMs; a budget-hit run resolves
    // to the { records, partial } envelope (the Array.isArray consumer path is
    // unchanged for all-fit runs). The census lanes read the flag via
    // _diagnostics.partialWallBudget.
    var ret = await ops.extractWithHoverRecords(
      processed,
      fieldMap,
      hoverConfig,
      domHover,
      { allowEmpty: true, maxWallMs: opts.maxWallMs }
    );
    var partialEnvelope = null;
    var records = ret;
    if (ret && typeof ret === 'object' && !Array.isArray(ret) &&
        Array.isArray(ret.records) && ret.partial && typeof ret.partial === 'object') {
      records = ret.records;
      partialEnvelope = ret;
    }
    // Compute diagnostics: reuse the extractList diagnostics shape for
    // per-field match data, then layer on a hover summary.
    var _diagnostics = (ops && typeof ops.computeExtractListDiagnostics === 'function')
      ? ops.computeExtractListDiagnostics(processed, fieldMap, containerSel)
      : { api: 'extractWithHover', containerSelector: containerSel, containerMatches: processed.length, perField: [] };
    _diagnostics.api = 'extractWithHover';
    _diagnostics.processedContainers = processed.length;
    attachClauseCostCensus(_diagnostics, containerSel);
    // F8/F9 disclosures: how many match-predicate guards skipped past the
    // 2000-char prefix this call, and which hover-read fields had candidate
    // hovers capped (counts, never record keys).
    if (typeof ops.getMatchGuardSkips === 'function') {
      var _mgSkips = ops.getMatchGuardSkips();
      if (_mgSkips > 0) {
        _diagnostics.matchGuardSkips = _mgSkips;
        _diagnostics.matchGuardNote = 'match predicates were applied to the FIRST 2000 chars of ' + _mgSkips + ' over-long value(s) — a match living past char 2000 is invisible; narrow the field selector or read a shorter source';
      }
    }
    if (typeof ops.getHoverReadCapped === 'function') {
      var _hrc = ops.getHoverReadCapped();
      if (_hrc && typeof _hrc === 'object' && Object.keys(_hrc).length) _diagnostics.hoverReadCapped = _hrc;
    }
    var anchorsFound = 0;
    var hovercardsCaptured = 0;
    var hoverFailures = 0;
    // Seventh-log survey (2026-09-01): captured/failed COUNTS alone could not
    // distinguish popover_timeout (selector mismatch — the observedPopover
    // evidence path) from no_hover_signal (anchor without a popover), so the
    // sixth-log selector-repair rule could not be validated from production
    // logs. Tally the reasons and how many failures carried an observed
    // popover onto the done event and the autoFix-facing hover summary.
    var failureReasons = {};
    var observedPopoverCount = 0;
    for (var i = 0; i < records.length; i++) {
      var cards = records[i].hovercards || [];
      anchorsFound += cards.length;
      for (var j = 0; j < cards.length; j++) {
        if (cards[j].hovered && cards[j].htmlSnippet) {
          hovercardsCaptured++;
        } else {
          hoverFailures++;
          var _rsn = cards[j].reason || 'unknown';
          failureReasons[_rsn] = (failureReasons[_rsn] || 0) + 1;
          if (cards[j].observedPopover) observedPopoverCount++;
        }
      }
    }
    _diagnostics.hoverSummary = {
      anchorsFound: anchorsFound,
      hovercardsCaptured: hovercardsCaptured,
      hoverFailures: hoverFailures,
      failureReasons: failureReasons,
      observedPopoverCount: observedPopoverCount
    };
    // Sixty-second log: a gate failure in the tally is not one anchor's bad
    // luck — the Enhanced Mode opt-out disables EVERY dispatch in the session
    // deterministically. Name it at the aggregate so a verify-time reader of
    // the diagnostics sees a capability fact, not N per-anchor failures.
    if (failureReasons['enhanced mode disabled']) {
      _diagnostics.hoverSummary.enhancedModeDisabled = {
        failures: failureReasons['enhanced mode disabled'],
        note: 'deterministic capability gate — Enhanced Scraping Mode is off (Settings); no hover can dispatch until it is enabled. Popover-mounted values are unavailable this run: surface in finish, use labelledby/attr/text routes, or renegotiate hover-dependent fields.'
      };
    }
    // 机械-语义分离（spec 3.C）：未消费捕获普查的数据源——本次调用捕获
    // 的弹层原文样本 + fieldMap 里悬停读字段数。verify 侧据此生成
    // "捕获了 N 条弹层文本，0 字段消费" 的观测平权普查。
    var capturedSamples = [];
    for (var ci2 = 0; ci2 < records.length && capturedSamples.length < 3; ci2++) {
      var hcs2 = (records[ci2] && records[ci2].hovercards) || [];
      for (var cj2 = 0; cj2 < hcs2.length && capturedSamples.length < 3; cj2++) {
        var hsnip = hcs2[cj2] && hcs2[cj2].htmlSnippet;
        if (typeof hsnip === 'string' && hsnip) {
          capturedSamples.push(hsnip.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
        }
      }
    }
    var popoverReadFieldCount = 0;
    for (var fk3 in (fieldMap || {})) {
      if (Object.prototype.hasOwnProperty.call(fieldMap, fk3) &&
        (fieldMap[fk3] && (fieldMap[fk3].read === 'hoverPopover' || fieldMap[fk3].read === 'hoverPopoverHtml'))) popoverReadFieldCount += 1;
    }
    _diagnostics.capturedPopovers = {
      popoverReadFields: popoverReadFieldCount,
      captured: hovercardsCaptured,
      samples: capturedSamples
    };
    _diagnostics.anchorSel = hoverConfig.anchorSel;
    // Anchor fixes need the REAL container markup, not a generic snippet.
    // computeExtractListDiagnostics caps firstContainerHtml at 2000 chars,
    // but choosing an anchorSel requires seeing the full nesting around the
    // interactive link (wrapper elements, aria-hidden shells, object
    // elements). Capture generously from the first processed container —
    // when page evidence is what the LLM must reason about, give it a real
    // budget instead of amputating at a blind threshold.
    try {
      if (processed.length > 0 && processed[0] && typeof processed[0].outerHTML === 'string') {
        var collapsedEwh = processed[0].outerHTML.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ');
        if (collapsedEwh.length <= 8000) {
          _diagnostics.firstContainerHtml = collapsedEwh;
        } else {
          var tailEwh = 4000;
          var headEwh = 8000 - tailEwh - 60; // marker budget
          _diagnostics.firstContainerHtml = collapsedEwh.slice(0, headEwh) +
            ' …[truncated ' + collapsedEwh.length + ' chars, middle cut]… ' +
            collapsedEwh.slice(collapsedEwh.length - tailEwh);
        }
      }
    } catch (_) { /* diagnostics must never break the scrape path */ }
    if (partialEnvelope) {
      _diagnostics.partialWallBudget = {
        processed: partialEnvelope.partial.processed,
        total: partialEnvelope.partial.total
      };
      _diagnostics.partialNote = partialEnvelope.partial.note;
    }
    notifyBackgroundDiagnostic('extractWithHover_done', {
      containerSelector: containerSel,
      processed: processed.length,
      anchorsFound: anchorsFound,
      hovercardsCaptured: hovercardsCaptured,
      hoverFailures: hoverFailures,
      failureReasons: failureReasons,
      observedPopoverCount: observedPopoverCount
    });
    return { result: partialEnvelope || records, _diagnostics: _diagnostics };
  }

  const openTabPending = new Map();
  let openTabCounter = 0;
  const OPEN_TAB_LOCAL_TIMEOUT_MS = 60000; // B9: local cap — background must answer within this

  async function domOpenTab(url, fnStr, timeoutMs) {
    const budget = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : OPEN_TAB_LOCAL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const reqId = ++openTabCounter;
      const timer = setTimeout(() => {
        if (openTabPending.delete(reqId)) {
          reject(new Error('OPEN_TAB_TIMEOUT: sub-tab execution did not answer within ' + budget + 'ms (reqId=' + reqId + ') — the pending request was cleaned up; check the background service worker, and do not retry in a tight loop.'));
        }
      }, budget);
      // Wrap so the TAB_RESULT handler's plain resolve/reject clears the
      // timer and the map entry on the normal path too.
      openTabPending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); openTabPending.delete(reqId); resolve(v); },
        reject: (e) => { clearTimeout(timer); openTabPending.delete(reqId); reject(e); }
      });
      try {
        chrome.runtime.sendMessage({
          type: 'OPEN_TAB_EXECUTE',
          reqId,
          url,
          script: fnStr,
          parentTabId: currentSenderTabId
        });
      } catch (e) {
        clearTimeout(timer);
        openTabPending.delete(reqId);
        reject(e);
      }
    });
  }

  // ===== Script Execution =====
  async function executeScript(scriptCode, input) {
    sendDebugLog('info', 'content-script', 'executeScript waiting for sandbox', { sandboxReady });
    await whenSandboxReady();
    sendDebugLog('info', 'content-script', 'Posting EXECUTE to sandbox', { scriptPreview: scriptCode?.slice(0, 500) });
    sandboxIframe.contentWindow.postMessage({
      type: 'EXECUTE',
      script: scriptCode,
      input
    }, '*');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ pong: true });
      return false;
    }
    if (message.type === 'EXECUTE_SCRIPT') {
      currentSenderTabId = sender.tab?.id;
      sendDebugLog('info', 'content-script', 'EXECUTE_SCRIPT received', { senderTabId: currentSenderTabId, scriptPreview: message.script?.slice(0, 500) });
      executeScript(message.script, message.input)
        .then(() => sendResponse({ ack: true }))
        .catch(error => {
          sendDebugLog('error', 'content-script', 'executeScript failed', { error: error.message });
          chrome.runtime.sendMessage({
            type: 'SCRIPT_RESULT',
            error: error.message || String(error),
            tabId: currentSenderTabId
          });
          sendResponse({ ack: true });
        });
      return true;
    }

    if (message.type === 'DOM_REQUEST' && message._fromOffscreen) {
      // Set currentSenderTabId so $openTab can send results back to this tab.
      // In the offscreen path, this is the only place we learn our tabId.
      if (message.tabId) currentSenderTabId = message.tabId;
      sendDebugLog('info', 'content-script', 'DOM_REQUEST from offscreen', { action: message.action, selector: message.selector, tabId: message.tabId });
      handleDomRequest(message).then(({ result, error, subTabSnapshot, _diagnostics }) => {
        sendDebugLog(error ? 'error' : 'info', 'content-script', 'DOM_RESPONSE to offscreen', { action: message.action, selector: message.selector, error, resultType: typeof result, hasSubTabSnapshot: !!subTabSnapshot });
        chrome.runtime.sendMessage({
          type: 'DOM_RESPONSE',
          id: message.id,
          result,
          error,
          subTabSnapshot,
          _diagnostics,
          _fromOffscreen: true
        });
      });
      return false;
    }

    if (message.type === 'START_ANNOTATION') {
      annotationSchemas = {
        inputSchema: message.inputSchema || {},
        outputSchema: message.outputSchema || {},
        // Precomputed by the wizard page (which has wizard-utils.js loaded).
        // Array of {value, label} including nested array-of-objects fields
        // (e.g. {value:'posts.group', label:'posts → group'}) so the user
        // can map a selector to a specific sub-field of each list item.
        outputFieldOptions: Array.isArray(message.outputFieldOptions) ? message.outputFieldOptions : null
      };
      startAnnotationMode();
      sendResponse({ ack: true });
      return true;
    }

    if (message.type === 'STOP_ANNOTATION') {
      stopAnnotationMode();
      sendResponse({ annotations: selectedAnnotations });
      return true;
    }

    if (message.type === 'CAPTURE_ANNOTATION') {
      stopAnnotationMode();
      let snapshot;
      try {
        snapshot = getDomSnapshot();
      } catch (e) {
        sendResponse({
          error: 'CAPTURE_SNAPSHOT_FAILED: ' + (e && e.message ? e.message : String(e)),
          url: location.href,
          title: document.title,
          annotations: selectedAnnotations || [],
          fullHtml: ''
        });
        return true;
      }
      sendResponse({
        url: location.href,
        title: document.title,
        annotations: selectedAnnotations || [],
        fullHtml: snapshot.html
      });
      return true;
    }

    if (message.type === 'RESET_DOM_ACTIVITY') {
      domActivityLog = [];
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GET_DOM_ACTIVITY') {
      sendResponse({ activities: domActivityLog });
      return true;
    }

    if (message.type === 'GET_DOM_SNAPSHOT') {
      sendResponse({ snapshot: getDomSnapshot(message.mode) });
      return true;
    }

    if (message.type === 'GET_ELEMENT_HTML') {
      sendResponse({ element: window.DomCleaner.getElementFullHtml(message.selector) });
      return true;
    }

    if (message.type === 'GET_ELEMENTS_HTML') {
      const elements = message.selectors.map(sel => window.DomCleaner.getElementFullHtml(sel));
      sendResponse({ elements });
      return true;
    }

    if (message.type === 'TAB_RESULT') {
      const pending = openTabPending.get(message.reqId);
      if (pending) {
        openTabPending.delete(message.reqId);
        if (message.error) {
          // Preserve subTabSnapshot captured by handleOpenTabExecute before
          // the sub-tab was destroyed. Threaded through the message chain so
          // autoFix can hand the LLM the actual failing page's DOM instead
          // of being forced to snapshot the main tab (which shows whatever
          // page was active before $openTab ran).
          const err = new Error(message.error);
          if (message.subTabSnapshot) err.subTabSnapshot = message.subTabSnapshot;
          pending.reject(err);
        } else {
          pending.resolve(message.result);
        }
      }
      sendResponse({ ack: true });
      return true;
    }
  });

  // ===== Annotation Mode =====
  function attachAnnotationListenersToDoc(doc) {
    doc.addEventListener('mouseover', onHover, true);
    doc.addEventListener('click', onAnnotationClick, true);
    doc.addEventListener('keydown', onKeyDown, true);
  }

  function detachAnnotationListenersFromDoc(doc) {
    try {
      doc.removeEventListener('mouseover', onHover, true);
      doc.removeEventListener('click', onAnnotationClick, true);
      doc.removeEventListener('keydown', onKeyDown, true);
    } catch (e) { /* iframe may have navigated away */ }
  }

  function registerAnnotationListeners() {
    // Top-level document
    attachAnnotationListenersToDoc(document);
    attachedAnnotationDocs = [document];

    // Same-origin iframes present at start time
    let sameOriginCount = 0;
    let crossOriginCount = 0;
    document.querySelectorAll('iframe').forEach(iframe => {
      let iframeDoc = null;
      try { iframeDoc = iframe.contentDocument; } catch (e) { /* cross-origin */ }
      if (iframeDoc) {
        attachAnnotationListenersToDoc(iframeDoc);
        attachedAnnotationDocs.push(iframeDoc);
        sameOriginCount++;
        sendDebugLog('info', 'content-script', 'annotation listeners attached to iframe', {
          src: iframe.getAttribute('src') || '(no src)',
          readyState: iframeDoc.readyState
        });
      } else {
        crossOriginCount++;
      }
    });

    // Watch for iframes added after start (SPA patterns)
    if (!iframeObserver && document.body) {
      iframeObserver = new MutationObserver(mutationList => {
        for (const mutation of mutationList) {
          for (const node of mutation.addedNodes) {
            if (node.tagName === 'IFRAME') {
              tryAttachIframe(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll('iframe').forEach(tryAttachIframe);
            }
          }
        }
      });
      iframeObserver.observe(document.body, { childList: true, subtree: true });
    }

    sendDebugLog('info', 'content-script', 'annotation mode started', {
      iframeCount: document.querySelectorAll('iframe').length,
      sameOriginIframes: sameOriginCount,
      crossOriginIframes: crossOriginCount
    });
  }

  function tryAttachIframe(iframe) {
    let iframeDoc = null;
    try { iframeDoc = iframe.contentDocument; } catch (e) { return; }
    if (!iframeDoc) return;
    if (attachedAnnotationDocs.indexOf(iframeDoc) !== -1) return;
    attachAnnotationListenersToDoc(iframeDoc);
    attachedAnnotationDocs.push(iframeDoc);
    sendDebugLog('info', 'content-script', 'annotation listeners attached to late-added iframe', {
      src: iframe.getAttribute('src') || '(no src)'
    });
  }

  function startAnnotationMode() {
    isAnnotationMode = true;
    selectedAnnotations = [];
    if (annotationCounterPill) {
      annotationCounterPill.remove();
      annotationCounterPill = null;
    }
    updateAnnotationCounter();
    registerAnnotationListeners();
  }

  function stopAnnotationMode() {
    const recorded = selectedAnnotations.length;
    const docsToClean = attachedAnnotationDocs;
    attachedAnnotationDocs = [];
    isAnnotationMode = false;
    docsToClean.forEach(detachAnnotationListenersFromDoc);
    if (iframeObserver) {
      iframeObserver.disconnect();
      iframeObserver = null;
    }
    if (activeMenuClose) {
      activeMenuClose();
      activeMenuClose = null;
    }
    if (activeElementLabel) {
      if (activeElementLabel.parentNode) activeElementLabel.remove();
      activeElementLabel = null;
    }
    clearHighlights();
    docsToClean.forEach(doc => {
      try {
        doc.querySelectorAll('[data-cc-annotated]').forEach(el => {
          el.removeAttribute('data-cc-annotated');
          el.style.outline = '';
          el.style.outlineOffset = '';
        });
      } catch (e) { /* iframe navigated away */ }
    });
    if (annotationCounterPill) {
      annotationCounterPill.remove();
      annotationCounterPill = null;
    }
    sendDebugLog('info', 'content-script', 'annotation mode stopped', {
      annotationsRecorded: recorded
    });
  }

  function onHover(e) {
    hoverLogCounter++;
    const target = resolveAnnotationTarget(e.target);
    const targetChanged = lastHoverTarget !== target;
    if (targetChanged || hoverLogCounter % 20 === 0) {
      lastHoverTarget = target;
      const rect = target?.getBoundingClientRect?.();
      sendDebugLog('debug', 'content-script', 'annotation hover', {
        nth: hoverLogCounter,
        targetChanged,
        rawTag: e.target?.tagName,
        snapped: target !== e.target,
        snappedTag: target?.tagName,
        snappedClass: classStr(target).slice(0, 80),
        ownerDocIsTop: target?.ownerDocument === document,
        rect: rect ? { top: rect.top, left: rect.left, w: rect.width, h: rect.height } : null,
        isAnnotationMode
      });
    }
    if (!isAnnotationMode) return;
    clearHighlights();
    if (target.hasAttribute && target.hasAttribute('data-cc-annotated')) return;
    target.style.outline = '3px solid #f59e0b';
    target.style.outlineOffset = '2px';
  }

  function onAnnotationClick(e) {
    const target = resolveAnnotationTarget(e.target);
    const snapped = target !== e.target;
    sendDebugLog('info', 'content-script', 'annotation click received', {
      rawTag: e.target?.tagName,
      rawClass: classStr(e.target).slice(0, 80),
      snapped,
      snappedTag: target?.tagName,
      snappedClass: classStr(target).slice(0, 80),
      ownerDocIsTop: target?.ownerDocument === document,
      eventPhase: e.eventPhase,
      isAnnotationMode,
      hasClosest: typeof target?.closest === 'function'
    });
    if (!isAnnotationMode) {
      sendDebugLog('warn', 'content-script', 'annotation click dropped: not in annotation mode');
      return;
    }
    // Don't re-trigger when the click lands inside our own annotation menu.
    // Without this guard, clicking a menu button fires onAnnotationClick
    // again (it's a document-level capture listener), stopPropagation halts
    // the event before it reaches the button, and the menu's own click
    // handler never runs — so a new menu is built on every click (loop).
    if (target.closest && target.closest('[data-cc-annotation-menu]')) {
      sendDebugLog('debug', 'content-script', 'annotation click dropped: inside own menu');
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const selector = generateSelector(target);
    const domPath = getDomPath(target);
    const text = target.textContent?.trim()?.slice(0, 100) || '';
    const tagLower = target.tagName.toLowerCase();

    // Element-confirm label: a small fixed-position badge near the clicked
    // element so the non-technical annotator visually confirms the pick.
    const elementLabel = document.createElement('div');
    elementLabel.setAttribute('data-cc-element-label', '');
    const rawRect = target.getBoundingClientRect?.() || {};
    // target's rect is iframe-viewport-relative when the click landed inside
    // an iframe; translate to top-level viewport so the label and menu render
    // at the right spot (they're appended to top-level document.body).
    const rect = translateRectToTopLevel(target, rawRect);
    const coords = clientCoordsToTopLevel(target, e.clientX, e.clientY);
    elementLabel.style.cssText =
      'position:fixed; z-index:999998; max-width:260px; padding:3px 7px;' +
      'background:#111827; color:#fff; font:12px/1.4 sans-serif;' +
      'border-radius:4px; pointer-events:none; white-space:nowrap;' +
      'overflow:hidden; text-overflow:ellipsis;';
    elementLabel.textContent = (text || '(no text)') + '  ·  <' + tagLower + '>';
    // Place just above the element; clamp into the viewport.
    let labelTop = (rect.top || 0) - 22;
    if (labelTop < 4) labelTop = (rect.bottom || 0) + 4;
    let labelLeft = (rect.left || 0);
    if (labelLeft > window.innerWidth - 200) labelLeft = window.innerWidth - 260;
    if (labelLeft < 4) labelLeft = 4;
    elementLabel.style.top = labelTop + 'px';
    elementLabel.style.left = labelLeft + 'px';
    document.body.appendChild(elementLabel);
    activeElementLabel = elementLabel;

    // Highlight the target while the menu is open.
    target.style.outline = '3px solid #f59e0b';
    target.style.outlineOffset = '2px';

    const menu = document.createElement('div');
    menu.setAttribute('data-cc-annotation-menu', '');
    menu.style.cssText =
      'position:fixed; left:-9999px; top:-9999px; background:white;' +
      'border:1px solid #ccc; padding:10px; z-index:999999;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.25); font-family:sans-serif;' +
      'font-size:13px; min-width:260px; max-width:320px; border-radius:6px;';
    document.body.appendChild(menu);

    // Shared close: removes menu, element label, and outside-click listener.
    let onOutside = null;
    const close = () => {
      menu.remove();
      if (elementLabel.parentNode) elementLabel.remove();
      if (activeElementLabel === elementLabel) activeElementLabel = null;
      if (onOutside) {
        document.removeEventListener('click', onOutside, true);
        onOutside = null;
      }
      if (activeMenuClose === close) activeMenuClose = null;
    };
    activeMenuClose = close;

    // ---- Step 1: type selection ----
    function renderStep1() {
      menu.innerHTML = `
        <div style="font-weight:600; margin-bottom:8px;">Choose Annotation Type</div>
        <div style="font-size:11px; color:#6b7280; margin-bottom:8px;">Element: ${(text || '(no text)').replace(/</g, '&lt;').slice(0, 60)} · &lt;${tagLower}&gt;</div>
        <button data-type="click" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">click — click element</button>
        <button data-type="input" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">input — input field</button>
        <button data-type="extract" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">extract — extract text/attribute</button>
        <button data-type="check" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">check — read attribute</button>
        <button data-type="wait" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">wait — wait for element</button>
        <hr style="margin:8px 0; border:none; border-top:1px solid #e5e7eb;">
        <button data-type="key" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #bfdbfe; background:#dbeafe; border-radius:3px;">key — field name (header)</button>
        <button data-type="value" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #bbf7d0; background:#dcfce7; border-radius:3px;">value — field value (cell)</button>
        <button data-type="cancel" style="display:block; width:100%; margin:8px 0 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">Cancel</button>
      `;
      positionMenu(menu, coords.x, coords.y);
    }

    // Build a labelled <select> from a list of {value,label} options.
    function buildSelect(id, label, options, placeholder) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:6px 0;';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:11px; color:#374151; margin-bottom:3px;';
      lbl.textContent = label;
      wrap.appendChild(lbl);
      const sel = document.createElement('select');
      sel.id = id;
      sel.style.cssText = 'width:100%; padding:4px 6px; border:1px solid #d1d5db; border-radius:3px; font-size:13px; background:white;';
      if (placeholder) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = placeholder;
        sel.appendChild(opt);
      }
      options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      });
      wrap.appendChild(sel);
      return wrap;
    }

    // ---- Step 2: intent form (per type) ----
    function renderStep2(type) {
      menu.innerHTML = '';
      const header = document.createElement('div');
      header.style.cssText = 'font-weight:600; margin-bottom:8px;';
      header.textContent = 'Type: ' + type;
      menu.appendChild(header);

      // key/value types have no intent dropdowns — straight confirm.
      if (type !== 'key' && type !== 'value') {
        if (type === 'click' || type === 'check' || type === 'input') {
          menu.appendChild(buildSelect('cc-purpose', 'Intent (purpose)', PURPOSES, '— Select —'));
          const otherWrap = document.createElement('div');
          otherWrap.id = 'cc-purpose-other-wrap';
          otherWrap.style.cssText = 'margin:4px 0; display:none;';
          const otherInput = document.createElement('input');
          otherInput.type = 'text';
          otherInput.id = 'cc-purpose-other';
          otherInput.placeholder = 'Custom intent…';
          otherInput.style.cssText = 'width:100%; padding:4px 6px; border:1px solid #d1d5db; border-radius:3px; font-size:13px; box-sizing:border-box;';
          otherWrap.appendChild(otherInput);
          menu.appendChild(otherWrap);
        }
        if (type === 'check' || type === 'wait') {
          menu.appendChild(buildSelect('cc-wait', 'Wait condition', WAIT_CONDITIONS, '— Select —'));
        }
        if (type === 'extract') {
          // Prefer the precomputed options from the wizard (handles array-of
          // -objects outputs by descending into items.properties, e.g. posts →
          // posts.group, posts.username). Fall back to top-level keys for
          // older wizards that don't send outputFieldOptions.
          const outOptions = Array.isArray(annotationSchemas.outputFieldOptions) && annotationSchemas.outputFieldOptions.length
            ? annotationSchemas.outputFieldOptions
            : Object.keys(annotationSchemas.outputSchema?.properties || {}).map(k => ({ value: k, label: k }));
          if (outOptions.length) {
            menu.appendChild(buildSelect('cc-output', 'Output field',
              outOptions, '— Select —'));
          } else {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:11px; color:#9ca3af; margin:4px 0;';
            note.textContent = '(no outputSchema, outputField skipped)';
            menu.appendChild(note);
          }
        }
        if (type === 'input') {
          const inProps = Object.keys(annotationSchemas.inputSchema?.properties || {});
          if (inProps.length) {
            menu.appendChild(buildSelect('cc-input', 'Input field',
              inProps.map(k => ({ value: k, label: k })), '— Select —'));
          } else {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:11px; color:#9ca3af; margin:4px 0;';
            note.textContent = '(no inputSchema, inputField skipped)';
            menu.appendChild(note);
          }
        }
      }

      // Buttons: Confirm / Back / Cancel
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex; gap:6px; margin-top:10px;';
      const mkBtn = (label, kind) => {
        const b = document.createElement('button');
        b.textContent = label;
        const bg = { confirm: '#2563eb', back: '#f3f4f6', cancel: '#f3f4f6' }[kind];
        const fg = kind === 'confirm' ? '#fff' : '#374151';
        const border = kind === 'confirm' ? '#2563eb' : '#d1d5db';
        b.style.cssText = `flex:1; padding:6px 8px; cursor:pointer; border:1px solid ${border}; background:${bg}; color:${fg}; border-radius:3px; font-size:13px;`;
        b.dataset.action = kind;
        return b;
      };
      btnRow.appendChild(mkBtn('Confirm', 'confirm'));
      btnRow.appendChild(mkBtn('Back', 'back'));
      btnRow.appendChild(mkBtn('Cancel', 'cancel'));
      menu.appendChild(btnRow);
      positionMenu(menu, coords.x, coords.y);
    }

    function commit(type) {
      let purpose, waitCondition, outputField, inputField;
      if (type === 'click' || type === 'check' || type === 'input') {
        const sel = menu.querySelector('#cc-purpose');
        const chosen = sel ? sel.value : '';
        purpose = chosen === 'other'
          ? (menu.querySelector('#cc-purpose-other')?.value?.trim() || undefined)
          : (chosen || undefined);
      }
      if (type === 'check' || type === 'wait') {
        const sel = menu.querySelector('#cc-wait');
        waitCondition = sel ? (sel.value || undefined) : undefined;
      }
      // wait type = user is waiting for page completion — auto-assign purpose
      // so the LLM intent mapping fires (otherwise the annotation's
      // waitCondition is silently ignored and the LLM guesses its own signal).
      if (type === 'wait') {
        purpose = 'wait-for-load';
      }
      if (type === 'extract') {
        const sel = menu.querySelector('#cc-output');
        outputField = sel ? (sel.value || undefined) : undefined;
      }
      if (type === 'input') {
        const sel = menu.querySelector('#cc-input');
        inputField = sel ? (sel.value || undefined) : undefined;
      }

      selectedAnnotations.push({
        selector,
        domPath,
        elementType: tagLower,
        type,
        purpose,
        waitCondition,
        outputField,
        inputField,
        text,
        description: text.slice(0, 50),
        sampleText: text,
        html: target.outerHTML.slice(0, 500)
      });
      updateAnnotationCounter();

      const colors = { key: '#3b82f6', value: '#10b981' };
      target.setAttribute('data-cc-annotated', type);
      target.style.outline = '3px solid ' + (colors[type] || '#f59e0b');
      target.style.outlineOffset = '2px';

      sendDebugLog('info', 'content-script', 'annotation committed', {
        type, selector, purpose, waitCondition, outputField, inputField
      });
    }

    // Master click handler: handles both step-1 (data-type buttons) and
    // step-2 (data-action buttons + purpose <select> change).
    let currentType = null;
    menu.addEventListener('click', (ev) => {
      // Purpose <select> toggle of the free-text "other" input.
      const purposeSel = ev.target.closest && ev.target.closest('#cc-purpose');
      if (purposeSel) {
        const wrap = menu.querySelector('#cc-purpose-other-wrap');
        if (wrap) wrap.style.display = purposeSel.value === 'other' ? 'block' : 'none';
        ev.stopPropagation();
        return;
      }

      const btn = ev.target.closest('button');
      if (!btn) return;

      if (btn.dataset.type) {
        // Step 1 → step 2 (or cancel / direct-commit for key/value).
        const type = btn.dataset.type;
        if (type === 'cancel') { close(); return; }
        if (type === 'key' || type === 'value') { commit(type); close(); return; }
        currentType = type;
        renderStep2(type);
        return;
      }

      if (btn.dataset.action) {
        const action = btn.dataset.action;
        if (action === 'cancel') { close(); return; }
        if (action === 'back') {
          currentType = null;
          renderStep1();
          return;
        }
        if (action === 'confirm') {
          commit(currentType);
          close();
          return;
        }
      }
    });

    renderStep1();
    positionMenu(menu, coords.x, coords.y);

    sendDebugLog('info', 'content-script', 'annotation menu built', {
      selector,
      domPath,
      menuAppended: !!menu.parentNode
    });

    // Close on outside click (after a small delay so the current click doesn't trigger it)
    setTimeout(() => {
      if (!menu.parentNode) return;
      onOutside = (ev) => {
        if (!menu.contains(ev.target)) close();
      };
      document.addEventListener('click', onOutside, true);
    }, 100);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') stopAnnotationMode();
  }

  // Translate a getBoundingClientRect() (iframe-viewport-relative when the
  // target lives inside an iframe) into top-level-viewport coordinates by
  // walking up the iframe chain and adding each iframe element's offset.
  // Without this, the annotation menu / element label render at the wrong
  // position when the user clicks inside an iframe — the click's clientX/Y
  // and the target's rect are both iframe-viewport-relative, but the menu
  // is appended to the top-level document.body.
  function translateRectToTopLevel(target, rect) {
    if (!target || !rect) return rect || {};
    let ownerDoc = target.ownerDocument;
    if (!ownerDoc || ownerDoc === document) return rect;
    let top = rect.top, left = rect.left, bottom = rect.bottom, right = rect.right;
    while (ownerDoc && ownerDoc !== document) {
      const parentWin = ownerDoc.defaultView;
      if (!parentWin || parentWin === parentWin.parent) break;
      const parentDoc = parentWin.parent.document;
      let iframeEl = null;
      try {
        const candidates = parentDoc.querySelectorAll('iframe');
        for (const c of candidates) {
          if (c.contentWindow === parentWin) { iframeEl = c; break; }
        }
      } catch (e) { break; }
      if (!iframeEl) break;
      const offset = iframeEl.getBoundingClientRect();
      top += offset.top;
      left += offset.left;
      bottom += offset.top;
      right += offset.left;
      ownerDoc = parentDoc;
    }
    return { top, left, bottom, right, width: rect.width, height: rect.height };
  }

  function clientCoordsToTopLevel(target, clientX, clientY) {
    const rect = translateRectToTopLevel(target, { top: clientY, left: clientX, bottom: clientY, right: clientX, width: 0, height: 0 });
    return { x: rect.left, y: rect.top };
  }

  // Semantic clickable elements a user typically wants to annotate. When a
  // click lands on an inner icon (SVG/path/img inside a button), `closest()`
  // walks up to the nearest ancestor in this list — including the element
  // itself — so the annotation records the clickable parent, not the icon.
  // `[aria-haspopup]` covers div-based popup triggers that only expose
  // semantics via ARIA (e.g. doubao's mode-switch).
  const INTERACTIVE_SELECTOR = [
    'button',
    'a',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[aria-haspopup]',
    'summary',
    'input[type="checkbox"]',
    'input[type="radio"]'
  ].join(', ');

  function resolveAnnotationTarget(rawTarget) {
    if (!rawTarget || !rawTarget.closest) return rawTarget;
    // Don't snap to our own annotation UI.
    if (rawTarget.closest('[data-cc-annotation-menu]')) return rawTarget;
    return rawTarget.closest(INTERACTIVE_SELECTOR) || rawTarget;
  }

  function clearHighlights() {
    document.querySelectorAll('[style*="outline"]').forEach(el => {
      if (el.hasAttribute('data-cc-annotated')) return;
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
  }

  function updateAnnotationCounter() {
    if (!annotationCounterPill) {
      annotationCounterPill = document.createElement('div');
      annotationCounterPill.style.cssText =
        'position:fixed; top:12px; right:12px; z-index:999999;' +
        'background:#1f2937; color:white; padding:6px 12px; border-radius:999px;' +
        'font:13px sans-serif; box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
        'pointer-events:none;';
      document.body.appendChild(annotationCounterPill);
    }
    const n = selectedAnnotations.length;
    annotationCounterPill.textContent =
      '✓ ' + n + ' annotation' + (n === 1 ? '' : 's') + ' captured';
  }

  function positionMenu(menu, clickX, clickY) {
    const rect = menu.getBoundingClientRect();
    const menuW = rect.width;
    const menuH = rect.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = clickX;
    if (clickX > vw / 2) left = clickX - menuW;
    let top = clickY;
    if (clickY > vh / 2) top = clickY - menuH;
    left = Math.max(8, Math.min(left, vw - menuW - 8));
    top = Math.max(8, Math.min(top, vh - menuH - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function generateSelector(el) {
    // Delegate to lib/selector-generator.js. The full algorithm — stable
    // attribute preference, early-stop, leaf-only nth-of-type fallback —
    // lives there. content-script wraps it to prepend the iframe chain
    // (the lib module is iframe-agnostic; iframe context is added here
    // because that's where IframeSelectorLib lives).
    const inner = (typeof SelectorGenerator !== 'undefined' && SelectorGenerator)
      ? SelectorGenerator.generateSelector(el, el.ownerDocument || document)
      : (el && el.tagName ? el.tagName.toLowerCase() : 'body');
    if (!el || typeof IframeSelectorLib === 'undefined' || !IframeSelectorLib) return inner;
    const iframeChain = IframeSelectorLib.buildIframeChain(el, document);
    if (iframeChain.length === 0) return inner;
    return IframeSelectorLib.formatIframeSelector(iframeChain, inner);
  }

  function getDomPath(el) {
    // Full ancestry walk WITHOUT early-stop. annotation.domPath needs to
    // carry the parent list-item context (e.g. div[role="article"][aria-posinset="3"])
    // so clusterAnnotationsByContainer can detect multi-sample structure.
    // generateSelector's early-stop short-circuits at unique aria-labels and
    // loses that context (console.log 2026-08-05). The two diverge by design:
    // selector = short-optimized for execution, domPath = full chain for
    // context analysis.
    const inner = (typeof SelectorGenerator !== 'undefined' && SelectorGenerator && SelectorGenerator.generateFullDomPath)
      ? SelectorGenerator.generateFullDomPath(el, el.ownerDocument || document)
      : (el && el.tagName ? el.tagName.toLowerCase() : 'body');
    if (!el || typeof IframeSelectorLib === 'undefined' || !IframeSelectorLib) return inner;
    const iframeChain = IframeSelectorLib.buildIframeChain(el, document);
    if (iframeChain.length === 0) return inner;
    return IframeSelectorLib.formatIframeSelector(iframeChain, inner);
  }

  // ===== DOM Snapshot =====
  function getDomSnapshot(mode) {
    if (mode === 'compressed') {
      return window.DomCleaner.getCompressedSnapshot();
    }

    const clone = document.documentElement.cloneNode(true);

    // Remove tags that are never useful for scraping (but NOT iframe — processed separately)
    clone.querySelectorAll('script, style, link[rel="stylesheet"], link[rel="preload"], link[rel="icon"], video, audio, canvas, svg, noscript, template, meta, path, g, defs, use').forEach(el => el.remove());

    // Replace same-origin iframes with their content, mark cross-origin
    clone.querySelectorAll('iframe').forEach(el => {
      const src = el.getAttribute('src') || '';
      try {
        const liveIframes = document.querySelectorAll('iframe');
        let doc = null;
        let liveIframe = null;
        for (const iframe of liveIframes) {
          if (iframe.getAttribute('src') === src || iframe.src === el.getAttribute('src')) {
            doc = iframe.contentDocument;
            liveIframe = iframe;
            if (doc?.body) break;
          }
        }
        if (doc?.body && liveIframe) {
          const content = doc.body.cloneNode(true);
          content.querySelectorAll('script, style, link, video, audio, canvas, svg, noscript').forEach(c => c.remove());
          // Reuse the iframe element but mark it with the prefix and replace its
          // children with the inlined same-origin body. Keeps both snapshot paths
          // (compressed and full) emitting the same iframe marker.
          const prefix = window.DomCleaner.buildIframePrefix(liveIframe);
          el.setAttribute('data-iframe-prefix', prefix);
          while (el.firstChild) el.removeChild(el.firstChild);
          while (content.firstChild) el.appendChild(content.firstChild);
        } else {
          el.remove();
        }
      } catch {
        // Cross-origin iframe: leave the element in place but mark it so the LLM
        // sees the boundary. contentDocument access is blocked at runtime.
        el.setAttribute('data-cross-origin-iframe', src);
      }
    });

    // Remove hidden elements
    clone.querySelectorAll('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"]').forEach(el => el.remove());

    // Remove common noise containers (nav, sidebar, footer, cookie banners, tooltips, modals)
    clone.querySelectorAll('nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [class*="sidebar"], [class*="side-bar"], [class*="Sidebar"], [class*="toast"], [class*="modal-backdrop"], [class*="overlay"], [class*="cookie"], [class*="banner"], [class*="popup"], [class*="tooltip"], [class*="dropdown-menu"]').forEach(el => el.remove());

    // Remove comments
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(c => c.remove());

    // Clean attributes that bloat HTML but don't help selector identification
    clone.querySelectorAll('*').forEach(el => {
      // Remove inline event handlers
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on') || attr.name === 'style') {
          el.removeAttribute(attr.name);
        }
      });
      // Trim excessively long attribute values (data-*, class with hashes)
      Array.from(el.attributes).forEach(attr => {
        if (attr.value.length > 200) {
          el.setAttribute(attr.name, attr.value.slice(0, 200) + '...');
        }
      });
    });

    let html = clone.outerHTML;

    // Collapse whitespace
    html = html.replace(/\n\s*\n/g, '\n').replace(/>\s+</g, '><');

    // Only truncate if still extremely large after cleaning
    if (html.length > 80000) html = html.slice(0, 80000) + '\n... [truncated]';

    return {
      url: (typeof location !== 'undefined' && location && location.href) || '',
      title: (typeof document !== 'undefined' && document && document.title) || '',
      html: html,
      textContent: document.body.innerText.slice(0, 15000)
    };
  }

  // ===== Init =====
  // NOTE: The content-script no longer auto-creates a sandbox.html iframe.
  // Script execution migrated to the offscreen document (commit 3a567c4),
  // which hosts its own same-origin sandbox iframe that works. Embedding
  // chrome-extension://sandbox.html from a web page would require
  // web_accessible_resources, and even then may be blocked by page CSP.
  // The offscreen path is the canonical execution route.
})();
