// extension/lib/list-extract-ops.js
//
// Pure helpers that operate on already-resolved container Element arrays.
// content-script.js wraps these with querySelectorAllDeep to produce
// domExtractList / domClickInList.
//
// IIFE-wrapped: content_scripts in the same manifest entry share a global
// lexical scope, so a top-level `const api` here collides with the same
// declaration in selector-generator.js (Identifier 'api' has already been
// declared). The IIFE gives the module its own lexical scope; the api object
// is still exposed via window.X / self.X / module.exports.

(function (global) {
// DOM properties that look like attributes but aren't — getAttribute returns
// null for these. Read from the element directly when `attr` names one of them.
// Regression for console.log 2026-07-26 RC5: $extract(_, 'outerHTML') returned
// null because outerHTML is a DOM property, silently breaking the domHtml
// field in extraction outputs.
const DOM_PROPERTY_READS = new Set(['outerHTML', 'innerHTML']);

// 机械-语义分离（spec 3.A，mirror of content-script.js inline ops）：match
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
    // Code-review P1: preserve the array envelope — a multi:true input must
    // yield the FILTERED ARRAY of values that pass (aligned with the
    // extractWithHover multi path's map+filter), never the first scalar hit.
    return value.filter((v) => testMatchValue(v, re));
  }
  return testMatchValue(value, re) ? value : '';
}
// Code-review P2 hardening: (a) reset lastIndex defensively — new RegExp(m)
// compiles flagless, but user-supplied source could still smuggle state via
// sticky-ish constructs in some engines; the reset is free. (b) >2000-char
// strings are matched against their FIRST 2000 chars only — a catastrophic-
// backtracking predicate over a 50K-char outerHTML read would hang the whole
// step budget. Sixty-ninth review F8: the guard used to return FALSE
// silently for long strings (a match early in a long popover HTML read was
// invisible); it now tests the bounded prefix and counts the skipped guard
// so diagnostics can disclose it (getMatchGuardSkips).
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
function getMatchGuardSkips() { return matchGuardSkips; }
function resetMatchGuardSkips() { matchGuardSkips = 0; }
// Sixty-ninth review F9: hover-read candidate caps moved OUT of records
// (records[i][field+'__capped'] polluted the output schema consumers read)
// into this per-call map, lifted into _diagnostics.hoverReadCapped by the
// caller. extractWithHoverRecords resets it at call start.
let hoverReadCappedByField = null;
function getHoverReadCapped() { return hoverReadCappedByField; }
function isHoverPopoverSpec(spec) {
  return !!(spec && typeof spec === 'object' &&
    (spec.read === 'hoverPopover' || spec.read === 'hoverPopoverHtml'));
}
function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Forty-first log: whole-card `attr: 'outerHTML'` fields came back 82396-99278
// chars each (result.json: 332KB for 3 posts). ElementData caps textContent at
// 50000 — element-HTML property reads get the same budget, with an in-value
// disclosure comment so downstream consumers know the value was cut.
function capElementHtmlRead(value) {
  const cap = 50000;
  if (typeof value !== 'string' || value.length <= cap) return value;
  return value.slice(0, cap) + '<!--TRUNCATED: element HTML capped at ' + cap + ' of ' + value.length + ' chars-->';
}

const ARIA_REFERENCE_DEFAULT = 'aria-labelledby';

// spec.labelledby: true → resolve the default reference attr; a non-empty
// string → resolve THAT attr ('aria-describedby'). null when unset.
function normalizeLabelledby(spec) {
  const lb = (spec && typeof spec === 'object') ? spec.labelledby : undefined;
  if (lb === true) return ARIA_REFERENCE_DEFAULT;
  if (typeof lb === 'string' && lb.trim()) return lb.trim();
  return null;
}

// Thirty-third log D1: anti-scraped pages put decoy characters in the
// visible element's textContent while the clean value lives only in the
// hidden-but-readable elements an ARIA reference attribute points at.
// Mirrors content-script.js resolveLabelledbyText (kept behaviorally in
// sync by test/labelledby-fieldmap.test.js parity cases).
function resolveAriaReference(el, attr) {
  const out = { text: '', attr: attr || ARIA_REFERENCE_DEFAULT, refCount: 0, missingIds: [] };
  let raw = '';
  try { raw = el.getAttribute(out.attr) || ''; } catch (err) { raw = ''; }
  if (!raw.trim()) {
    // Forty-third log (mirrors content-script.js resolveLabelledbyText):
    // when the matched element carries NEITHER reference attribute, resolve
    // via its first descendant that carries either one. Own attributes
    // always win — an explicit attr request against an element bearing only
    // the sibling stays an honest absent-note.
    let ownSibling = '';
    try {
      ownSibling = (out.attr === ARIA_REFERENCE_DEFAULT)
        ? (el.getAttribute('aria-describedby') || '')
        : (el.getAttribute(ARIA_REFERENCE_DEFAULT) || '');
    } catch (err) { ownSibling = ''; }
    if (!ownSibling.trim() && typeof el.querySelector === 'function') {
      let carrier = null;
      try { carrier = el.querySelector('[aria-labelledby],[aria-describedby]'); } catch (err) { carrier = null; }
      if (carrier) {
        let carrierAttr = '';
        try { carrierAttr = carrier.getAttribute(out.attr) || ''; } catch (err) { carrierAttr = ''; }
        const resolvedAttr = carrierAttr.trim() ? out.attr
          : (out.attr === ARIA_REFERENCE_DEFAULT ? 'aria-describedby' : ARIA_REFERENCE_DEFAULT);
        const via = resolveAriaReference(carrier, resolvedAttr);
        via.viaDescendant = carrier.tagName ? String(carrier.tagName).toLowerCase() : 'descendant';
        via.note = (via.note ? via.note + ' ' : '') + '(resolved via descendant <' + via.viaDescendant + '> — the matched element itself carries no reference attribute)';
        return via;
      }
    }
    out.note = 'element matched but ' + out.attr + ' is absent';
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

function readField(container, spec) {
  // spec is either a string ('.author') or { selector, attr?, labelledby?, multi? }
  // Forty-eighth log: probe.extract {multi:true} returns all-matches arrays
  // while this path was first-match scalar — a fieldMap dry-runned through a
  // multi probe silently degraded to one value when pasted into a step, and
  // `for (const h of hrefs)` over the scalar string iterated CHARACTERS
  // (silent dead code across three artifact versions while verify said
  // 2/4 forever). spec.multi:true routes through readFieldAll so the probe
  // envelope and the service DSL stay the same shape.
  if (spec && typeof spec === 'object' && spec.multi === true) {
    return readFieldAll(container, spec);
  }
  const sel = typeof spec === 'string' ? spec : spec.selector;
  const attr = typeof spec === 'string' ? null : spec.attr;
  // labelledby takes precedence over attr when both are present: reading the
  // raw attribute value back is an id list, never the human text.
  const refAttr = typeof spec === 'string' ? null : normalizeLabelledby(spec);
  if (!sel) {
    // Empty selector → the container itself.
    if (refAttr) return resolveAriaReference(container, refAttr).text;
    if (attr) {
      if (DOM_PROPERTY_READS.has(attr)) return capElementHtmlRead(container[attr]);
      return container.getAttribute(attr);
    }
    return (container.textContent || '').trim();
  }
  const el = container.querySelector(sel);
  if (!el) return undefined;
  if (refAttr) return resolveAriaReference(el, refAttr).text;
  if (attr) {
    if (DOM_PROPERTY_READS.has(attr)) return capElementHtmlRead(el[attr]);
    return el.getAttribute(attr);
  }
  return (el.textContent || '').trim();
}
// Needed when CSS alone can't disambiguate which match is the right one —
// e.g. a[role=link] inside a feed post matches both the author link and
// the timestamp link. $extractList picks first-only; the LLM needs ALL matches
// so it can filter in JS by text/attribute regex.
//
// Each field value is an Array<string|null> (textContent or attribute value
// per match, in document order). Empty arrays when no matches.
//
// Regression for console.log 2026-07-26 RC4: $extractList returned first-match
// only, so the LLM kept picking the author link as publishTime and producing
// empty timestamps across every iteration.
function readFieldAll(container, spec) {
  const sel = typeof spec === 'string' ? spec : spec.selector;
  const attr = typeof spec === 'string' ? null : spec.attr;
  const refAttr = typeof spec === 'string' ? null : normalizeLabelledby(spec);
  if (!sel) {
    // Empty selector → the container itself (single-element "match").
    // Used to read the container's own outerHTML/textContent/attribute.
    if (refAttr) return [resolveAriaReference(container, refAttr).text];
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
      out.push(resolveAriaReference(el, refAttr).text);
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
  // Code-review P2: compile each predicate ONCE per call, before any DOM
  // work — an invalid match throws before the first querySelector instead
  // of after N containers of reads.
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
  // Code-review P2: compile once per call, before any DOM work (mirrors
  // extractListRecords).
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

// computeClickInListDiagnostics(containers, subSel, containerSelector, result) → object
//
// console.log 2026-08-23 (FB search): step 3's $clickInList errored on all
// 10 containers ('subSel not found'), returned done:true, and the failure
// was silent — the wizard had no framework-level evidence that the click
// sub-selector matched nothing. Mirrors computeExtractListDiagnostics so
// autoFix sees container counts plus one real container's HTML (the place
// where the actually-clickable element lives).
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

// extractWithHoverRecords(containers, fieldMap, hoverConfig, hoverFn, opts) → Promise<records>
//
// Container-scoped extract-then-hover. For each container:
//   1. Extract fields via extractListRecords (delegation — same
//      fieldMap semantics, including empty-selector-returns-container-itself).
//   2. Enumerate anchors via container.querySelectorAll(hoverConfig.anchorSel)
//      — scoped to the container subtree. Anchors outside any container
//      are never reached.
//   3. For each anchor, call hoverFn(anchorEl, hoverConfig.popoverSel, perHoverOpts).
//      hoverFn is injected so the helper stays testable without chrome.* deps
//      (production passes domHover; tests pass a mock).
//   4. Append a hovercards[] array to the record. Each entry carries the
//      full hover result shape plus anchorIndex (the anchor position within
//      THIS container, not globally).
//
// Why this exists: the existing manual-loop pattern of $hover(..., {index:i})
// uses a GLOBAL anchor enumeration. When containers hold variable numbers of
// anchors, the i-th global anchor does not correspond to the i-th container,
// producing systematically mis-aligned hovercard attachments. Container-scoped
// querySelector makes misalignment structurally impossible.
//
// hoverConfig: { anchorSel (required), popoverSel?, timeoutMs?, dismiss? }
// opts:        { allowEmpty? } — same semantics as extractListRecords
async function extractWithHoverRecords(containers, fieldMap, hoverConfig, hoverFn, opts) {
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
  // F9: per-call cap accumulator reset (see getHoverReadCapped).
  hoverReadCappedByField = {};
  // Step 1: extract fields per container via the existing helper. allowEmpty
  // is forced on here because we already validated containers.length > 0;
  // per-field emptiness is signaled via diagnostics, not by throwing.
  // 机械-语义分离（spec 3.A）：read:hoverPopover 字段在悬停阶段后填充
  // ——预提取用过滤后的 fieldMap（extractListRecords 现在对 hoverPopover
  // 规格教学性抛错）。
  const staticFieldMap = {};
  const hoverReadFields = [];
  const hoverMatchByField = {};
  for (const fk in fieldMap) {
    if (Object.prototype.hasOwnProperty.call(fieldMap, fk)) {
      if (isHoverPopoverSpec(fieldMap[fk])) {
        hoverReadFields.push(fk);
        // Code-review P2: compile hover-field predicates during the split —
        // an invalid match throws BEFORE any DOM work / hoverFn call.
        hoverMatchByField[fk] = compileMatch(fieldMap[fk]);
      } else {
        staticFieldMap[fk] = fieldMap[fk];
      }
    }
  }
  const records = Object.keys(staticFieldMap).length
    ? extractListRecords(containers, staticFieldMap, { allowEmpty: true })
    : containers.map(() => ({}));
  // Step 2-4: per-container anchor iteration. Sequential — only one popover
  // can be on screen at a time on most sites (the page dismisses the previous
  // popover on the next hover). Parallel dispatch would race.
  const anchorSel = hoverConfig.anchorSel;
  const popoverSel = hoverConfig.popoverSel || null;
  const perHoverOpts = {};
  if (typeof hoverConfig.timeoutMs === 'number' && hoverConfig.timeoutMs > 0) {
    perHoverOpts.timeoutMs = hoverConfig.timeoutMs;
  }
  if (typeof hoverConfig.dismiss === 'boolean') {
    perHoverOpts.dismiss = hoverConfig.dismiss;
  } else {
    perHoverOpts.dismiss = true;
  }
  // Seventieth log F1: wall budget. A hover batch over N containers burns
  // ~5-10s per hovered anchor even when no popover appears — over a 30+
  // container feed the call outlives BOTH the probe rail (30s) and the step
  // budget (120s), dying as a zombie with zero partial results. Before
  // processing container i>0, check elapsed; a budget hit returns the
  // processed records wrapped in a { records, partial } envelope (all-fit
  // runs keep returning the plain array — consumers' Array.isArray path is
  // unchanged).
  const maxWallMs = (opts && typeof opts.maxWallMs === 'number' && opts.maxWallMs > 0) ? opts.maxWallMs : 25000;
  const wallStart = Date.now();
  let processedCount = 0;
  for (let i = 0; i < containers.length; i++) {
    if (i > 0 && (Date.now() - wallStart) > maxWallMs) break;
    const container = containers[i];
    let anchors = [];
    try {
      anchors = Array.prototype.slice.call(container.querySelectorAll(anchorSel));
    } catch (_) {
      // Invalid anchorSel inside this container subtree — leave anchors empty.
      anchors = [];
    }
    const hovercards = [];
    for (let j = 0; j < anchors.length; j++) {
      const anchorEl = anchors[j];
      // RC51 (console.log 2026-08-14): anchorHref is the primary downstream
      // classification signal — step scripts bucket hovercards by the source
      // anchor link. The hover layer was fully working (18/18 picks, 68/68
      // dismisses) yet every result had hovercards:[] because the entry shape
      // omitted the href and the classification regex read undefined.
      let anchorHref = '';
      try {
        anchorHref = anchorEl.getAttribute('href') || '';
        // Forty-ninth log: anchorSel routinely matches the label span INSIDE
        // the link rather than the <a> itself — the span has no own href, and
        // hovercards[].anchorHref shipped '' on every record while the hover
        // layer worked perfectly, sinking every downstream link-based
        // classification. Walk up to the nearest enclosing link (the same
        // read-where-the-value-lives pattern as the labelledby descendant
        // descent, forty-third log).
        if (!anchorHref && typeof anchorEl.closest === 'function') {
          const enclosing = anchorEl.closest('a[href]');
          if (enclosing) anchorHref = enclosing.getAttribute('href') || '';
        }
      } catch (_) {}
      let anchorText = '';
      try { anchorText = (anchorEl.textContent || '').trim().slice(0, 120); } catch (_) {}
      try {
        const r = await hoverFn(anchorEl, popoverSel, perHoverOpts);
        hovercards.push({
          hovered: !!(r && r.hovered),
          htmlSnippet: (r && r.htmlSnippet) || null,
          popoverSelector: (r && r.popoverSelector) || null,
          autoDiscovered: !!(r && r.autoDiscovered),
          reason: (r && r.reason) || null,
          // Sixth-log followup (2026-09-01): failed hovers carry the
          // structural identity of the popover auto-discovery observed
          // (role/aria/id/class), so a popoverSelector mismatch can be
          // repaired from evidence instead of re-guessed. Thirty-sixth log:
          // forwarded on success too — the identity now names the CAPTURED
          // popover, so harvest gates reading `observedPopover &&
          // htmlSnippet` see a successful capture.
          observedPopover: (r && r.observedPopover) || null,
          anchorIndex: j,
          anchorHref: anchorHref,
          anchorText: anchorText,
          // Forty-second log: the anchor-label harvest the hover layer took
          // at dwell time (before the dismiss could unmount the referenced
          // text). Carried on FAILED entries too — label text routinely
          // needs no visible popover.
          labelledbyText: (r && typeof r.labelledbyText === 'string' && r.labelledbyText) ? r.labelledbyText : null,
          // Ninetieth-round F2c: text READ out of became-visible strips the
          // visual picker rejected (narrow tooltip bars — the timestamp
          // tooltip's full date lives here when the 50×50 gate turns the
          // strip away). Bindable via read:'hoverPopover'-style routing.
          rejectedAddedTexts: (r && Array.isArray(r.rejectedAddedTexts) && r.rejectedAddedTexts.length) ? r.rejectedAddedTexts.slice(0, 3) : undefined,
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
    // 机械-语义分离（spec 3.A）：悬停来源字段 —— 对字段选择器命中的元素
    // 执行捕获，剥标签（hoverPopover）或保留标记（hoverPopoverHtml），
    // match 谓词照常应用（命中→原文，未命中→空串；捕获原文仍留在
    // hovercards[].popoverText 供证据回环）。
    // Code-review P1 (hover-read budget): this loop used to hover EVERY
    // element matching spec.selector with no cap and no reuse — a broad
    // union selector over a big container burned the whole step budget on
    // redundant dispatches. Four layered mitigations, mirroring
    // TS_MAX_HOVER_ANCHORS's rationale in domTimestamp (enumerate
    // time-ish anchors, hover only up to the first 3 — tooltips mount in
    // 600-1600ms, so a handful of dwells is the evidence budget that
    // matters):
    const HR_MAX_FIELD_HOVER_CANDIDATES = 3;
    for (let hf = 0; hf < hoverReadFields.length; hf++) {
      const hfieldName = hoverReadFields[hf];
      const hspec = fieldMap[hfieldName] || {};
      const hsel = typeof hspec.selector === 'string' ? hspec.selector : null;
      const hre = hoverMatchByField[hfieldName] || null;
      const hvals = [];
      let hcands = hsel
        ? Array.prototype.slice.call(container.querySelectorAll(hsel))
        : [container];
      // (a) cap candidate hovers per field per container
      let capped = 0;
      if (hcands.length > HR_MAX_FIELD_HOVER_CANDIDATES) {
        capped = hcands.length - HR_MAX_FIELD_HOVER_CANDIDATES;
        hcands = hcands.slice(0, HR_MAX_FIELD_HOVER_CANDIDATES);
      }
      const readHoverText = (snip) =>
        (typeof snip === 'string' && snip)
          ? ((hspec.read === 'hoverPopoverHtml') ? snip : stripTags(snip))
          : null;
      for (let hh = 0; hh < hcands.length; hh++) {
        let htext = null;
        // (c) reuse: if the anchor loop already hovered THIS element (same
        // node — identity via the anchors array), reuse its capture instead
        // of dispatching a second dwell at the same anchor.
        const reuseIdx = anchors.indexOf(hcands[hh]);
        if (reuseIdx >= 0 && hovercards[reuseIdx]) {
          htext = readHoverText(hovercards[reuseIdx].htmlSnippet);
        } else {
          try {
            const hr = await hoverFn(hcands[hh], popoverSel, perHoverOpts);
            htext = readHoverText(hr && hr.htmlSnippet);
          } catch (_) { htext = null; }
        }
        if (htext) hvals.push(htext);
        // (b) scalar (non-multi) fields stop at the FIRST non-empty capture
        if (htext && hspec.multi !== true) break;
      }
      if (capped > 0) {
        // F9: caps live in diagnostics, never in records — a
        // field__capped key in the output shape is schema pollution.
        hoverReadCappedByField[hfieldName] = (hoverReadCappedByField[hfieldName] || 0) + capped;
      }
      if (hspec.multi === true) {
        records[i][hfieldName] = hvals.map((v) => applyMatch(v, hre)).filter(Boolean);
      } else {
        records[i][hfieldName] = applyMatch(hvals.length ? hvals[0] : '', hre);
        // (d) scalar fallback: when the field's own candidates yielded
        // nothing, fall back to the record's own hovercards captures before
        // settling '' — the anchor loop's popoverText is the same popover
        // text the field wanted, already tag-stripped.
        if (!hvals.length) {
          for (const hce of hovercards) {
            const t = (hspec.read === 'hoverPopoverHtml')
              ? hce.htmlSnippet
              : hce.popoverText;
            if (typeof t === 'string' && t) {
              records[i][hfieldName] = applyMatch(t, hre);
              break;
            }
          }
        }
      }
    }
    processedCount = i + 1;
  }
  // Forty-fourth log: the field extraction above ran BEFORE the hover batch,
  // but on a cold tab the batch is exactly what hydrates lazily-mounted ARIA
  // label chains — postingTime shipped "" in 4/4 records while the SAME
  // resolution recomputed after the loop (the diagnostics census) resolved
  // fine. Re-read labelledby fields whose pre-hover read came back empty;
  // fill from the post-hover DOM. Non-empty values are never overwritten and
  // non-labelledby fields are never re-read (attr/text reads don't hydrate).
  // Seventieth log F1: the re-read pass covers only PROCESSED containers —
  // records past the wall-budget cut carry no hovercards and no post-batch
  // hydration is possible for them anyway (their hovers never ran).
  const outRecords = records.slice(0, processedCount);
  for (let i = 0; i < outRecords.length; i++) {
    for (const [field, spec] of Object.entries(fieldMap)) {
      const refAttr = normalizeLabelledby(typeof spec === 'string' ? null : spec);
      if (!refAttr) continue;
      const cur = outRecords[i][field];
      // Forty-eighth log: multi:true fields arrive here as arrays. Heal only
      // when EVERY match resolved empty (a partially-populated array was
      // never hydration-starved); refill via the same multi read so the
      // healed value keeps the array envelope.
      if (Array.isArray(cur)) {
        const anyVal = cur.some((x) => typeof x === 'string' && x);
        if (anyVal) continue;
        let av;
        try { av = readField(containers[i], spec); } catch (_) { continue; }
        if (Array.isArray(av) && av.some((x) => typeof x === 'string' && x)) {
          outRecords[i][field] = av;
        }
        continue;
      }
      if (cur !== undefined && cur !== null && String(cur) !== '') continue;
      let v;
      try { v = readField(containers[i], spec); } catch (_) { continue; }
      if (typeof v === 'string' && v) outRecords[i][field] = v;
    }
  }
  // Seventieth log F1: budget-hit runs return the partial envelope instead
  // of the bare array — the resume advice names the caller-side range opts
  // (containerRange is applied by the content-script wrapper BEFORE this
  // helper, so [processed, total) composes natively without re-hovering).
  // Eighty-eighth log (SECOND crash occurrence: 86th v10 + 88th v5 both
  // died as `rs.slice is not a function`): the envelope IS the records
  // array now, carrying NON-ENUMERABLE partial/records annotations — array
  // consumers (slice/map/spread) keep working, envelope consumers keep
  // working, and JSON serialization of the records stays clean.
  if (processedCount < containers.length) {
    try {
      Object.defineProperty(outRecords, 'partial', {
        value: {
          processed: processedCount,
          total: containers.length,
          maxWallMs: maxWallMs,
          note: 'wall budget reached — ' + processedCount + ' of ' + containers.length +
            ' containers processed; re-run with containerRange:[' + processedCount + ',' + containers.length +
            '] (or maxContainers) to continue, or raise opts.maxWallMs'
        },
        enumerable: false, configurable: true
      });
      Object.defineProperty(outRecords, 'records', {
        get() { return outRecords; },
        enumerable: false, configurable: true
      });
    } catch (_) { /* annotations are best-effort */ }
    return outRecords;
  }
  return outRecords;
}

// computeExtractListDiagnostics(containers, fieldMap, containerSelector) → object
//
// Computes per-field match diagnostics for an $extractList call. For each
// field in fieldMap, walks every container and counts matches + collects
// up to 3 sample textContent/href strings. Used by content-script.js's
// domExtractList to attach _diagnostics to the DOM_RESPONSE so the autoFix
// prompt can show "your publishTime selector matched 0 elements while
// author matched 6" — empirical evidence the LLM needs to converge.
//
// Mirrors readField()'s selector/attr semantics so the diagnostic exactly
// reflects what extractListRecords returned.
//
// firstContainerHtml (RC13, console.log 2026-07-27 02:30): the outerHTML of
// the first matched container, lightly trimmed + capped. WITHOUT this, when
// the user reports "field X missing" the LLM has no way to discover WHERE
// the missing field's value lives in the DOM neighborhood of a record. It
// only sees its own (wrong) selectors' sample texts and the cleaned full-
// page HTML (which has typically stripped the very nested spans that carry
// reaction/comment/share counts). Showing one real record's outerHTML lets
// the LLM discover "the count is in a <span> inside the button, not the
// button itself" — a fully generic fix that works for any site, any field.
// multiMode (fourth-session log 2026-08-31): when $extractListMulti reuses
// this diagnostic, first-match-per-container samples can mislead — the value
// the script filters on (a permalink href) may be the 2nd..Nth match while
// the 1st is a profile link. In multi mode, sample ALL matches of the FIRST
// container (up to 5) so the observed value SHAPES are visible. sampleValues
// (both modes) carries actual extracted values — attr-based fields previously
// produced NO samples at all, so a script-level regex filtering attr values to
// zero was invisible to autoFix (the ZERO-TRAP failure mode).
function computeExtractListDiagnostics(containers, fieldMap, containerSelector, multiMode) {
  const containerArr = Array.isArray(containers) ? containers : [];
  const fields = fieldMap && typeof fieldMap === 'object' ? Object.entries(fieldMap) : [];
  const perField = fields.map(([field, spec]) => {
    const subSelector = typeof spec === 'string' ? spec : (spec && spec.selector);
    const attr = typeof spec === 'string' ? null : (spec && spec.attr) || null;
    const refAttr = typeof spec === 'string' ? null : normalizeLabelledby(spec);
    // Forty-eighth log: a field-level multi:true spec reads ALL matches —
    // census it like the call-level multiMode (sample every match of the
    // first container), and disclose multi:true so the report distinguishes
    // an all-matches field from a first-match one.
    const fieldMulti = !!(spec && typeof spec === 'object' && spec.multi === true);
    const sampleTexts = [];
    const sampleHrefs = [];
    const sampleValues = [];
    let matchCount = 0;
    // Thirty-third log D1: for labelledby fields the interesting census is
    // the RESOLUTION outcome — an element can match while every referenced
    // id is stale/missing. refResolved counts containers whose resolution
    // produced text; missingIds samples the stale ids for the crumbs.
    let refResolved = 0;
    let missingIds = null;
    if (!subSelector) {
      return { field, subSelector: null, attr, labelledby: refAttr, matchCount: 0, refResolved: 0, missingIds: [], sampleTexts: [], sampleHrefs: [], sampleValues: [] };
    }
    const pushValue = (el) => {
      if (sampleValues.length >= 5) return;
      let v = null;
      if (refAttr) {
        const r = resolveAriaReference(el, refAttr);
        if (r.text) refResolved += 1;
        if (r.missingIds && r.missingIds.length) {
          if (!missingIds) missingIds = [];
          for (const mid of r.missingIds) {
            if (missingIds.length < 3) missingIds.push(mid);
          }
        }
        v = r.text;
      } else if (attr) {
        v = DOM_PROPERTY_READS.has(attr) ? el[attr] : (el.getAttribute ? el.getAttribute(attr) : null);
      } else {
        v = (el.textContent || '').trim();
      }
      if (v != null && String(v).length > 0) sampleValues.push(String(v).slice(0, 160));
    };
    if ((multiMode || fieldMulti) && containerArr.length > 0) {
      // Multi (call-level or field-level): count containers with ≥1 match,
      // but sample every match inside the first container — the full value
      // shape distribution.
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
  // Capture up to ~8000 chars of the first container's outerHTML, head+tail
  // split. The cap is per-call: if there are multiple $extractList calls in one
  // step, each one contributes its own snippet. summarizeAllStepDiagnostics
  // further caps the aggregate to avoid unbounded prompt growth.
  // RC59 (console.log 2026-08-18): the cap used to be HEAD-ONLY, but metric
  // evidence (aria-label counts on action-bar elements) clusters at the END
  // of record markup — the head-only cap amputated exactly the evidence the
  // LLM needed to fix chronic-empty count fields, across 10 blind autoFix
  // rounds. Tail share ~60%.
  // 2026-08-24: 2000 → 8000 (user directive: page evidence the LLM must
  // reason about gets a real budget — a generic tight cap blind-amputates
  // nesting/anchor structure the same way RC59's head-only cut did).
  let firstContainerHtml = null;
  if (containerArr.length > 0) {
    const c0 = containerArr[0];
    if (c0 && typeof c0.outerHTML === 'string') {
      // Collapse runs of whitespace to keep the snippet compact and to avoid
      // dumping huge indented DOM. Keep newlines so the LLM can read structure.
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

// computeSimpleSelectorDiagnostics(elements, selector, api?) → object
//
// Single-selector diagnostics for $list / $extract / $count. `api` defaults
// to 'list'. For 'count', returns only matchCount (no samples — caller
// only wants the number). For 'list'/'extract', includes up to 3 sample
// textContent + href.
//
// Twenty-third log: for 'count' the census also carries the
// visible/invisible split — $count matches regardless of visibility while
// $exists is visibility-gated, and the divergence (count N / exists false)
// is exactly the hidden-but-readable trap that ships guarded fields as "".
// Census runs only for count (match populations there are small and the
// signal is only needed there; list/extract stay lean).

// Visibility check for the census — mirrors content-script's isElementVisible
// checks, but defensive: diagnostics must never throw the read it annotates.
// Exported for the content-script inline-mirror parity test.
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

const api = {
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

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof global !== 'undefined') global.ListExtractOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
