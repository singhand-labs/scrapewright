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
  // spec is either a string ('.author') or { selector, attr?, labelledby? }
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
// e.g. a[role=link] inside a Facebook post matches both the author link and
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
  for (const container of containers) {
    const rec = {};
    for (const [field, spec] of Object.entries(fieldMap)) {
      try {
        rec[field] = readField(container, spec);
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
  for (const container of containers) {
    const rec = {};
    for (const [field, spec] of Object.entries(fieldMap)) {
      try {
        rec[field] = readFieldAll(container, spec);
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
  // Step 1: extract fields per container via the existing helper. allowEmpty
  // is forced on here because we already validated containers.length > 0;
  // per-field emptiness is signaled via diagnostics, not by throwing.
  const records = extractListRecords(containers, fieldMap, { allowEmpty: true });
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
  for (let i = 0; i < containers.length; i++) {
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
      try { anchorHref = anchorEl.getAttribute('href') || ''; } catch (_) {}
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
          labelledbyAttr: (r && typeof r.labelledbyAttr === 'string' && r.labelledbyAttr) ? r.labelledbyAttr : null,
          labelledbyNote: (r && typeof r.labelledbyNote === 'string' && r.labelledbyNote) ? r.labelledbyNote : null
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
          labelledbyNote: null
        });
      }
    }
    records[i].hovercards = hovercards;
  }
  return records;
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
    if (multiMode && containerArr.length > 0) {
      // Multi: count containers with ≥1 match, but sample every match inside
      // the first container — the full value shape distribution.
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
    return { field, subSelector, attr, labelledby: refAttr, matchCount, refResolved, missingIds: missingIds || [], sampleTexts, sampleHrefs, sampleValues };
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
  isVisibleForDiagnostics
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof global !== 'undefined') global.ListExtractOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
