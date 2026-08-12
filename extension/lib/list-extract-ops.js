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

function readField(container, spec) {
  // spec is either a string ('.author') or { selector, attr? }
  const sel = typeof spec === 'string' ? spec : spec.selector;
  const attr = typeof spec === 'string' ? null : spec.attr;
  if (!sel) {
    // Empty selector → the container itself.
    if (attr) {
      if (DOM_PROPERTY_READS.has(attr)) return container[attr];
      return container.getAttribute(attr);
    }
    return (container.textContent || '').trim();
  }
  const el = container.querySelector(sel);
  if (!el) return undefined;
  if (attr) {
    if (DOM_PROPERTY_READS.has(attr)) return el[attr];
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
  if (!sel) {
    // Empty selector → the container itself (single-element "match").
    // Used to read the container's own outerHTML/textContent/attribute.
    let val;
    if (attr) {
      if (DOM_PROPERTY_READS.has(attr)) val = container[attr];
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
    if (attr) {
      if (DOM_PROPERTY_READS.has(attr)) out.push(el[attr]);
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
        errors.push({ index, container, reason: 'subSel not found' });
        return;
      }
      clickFn(el);
      clicked++;
    } catch (err) {
      errors.push({ index, container, reason: err.message || String(err) });
    }
  });
  return { clicked, errors, delayMs: delay };
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
function computeExtractListDiagnostics(containers, fieldMap, containerSelector) {
  const containerArr = Array.isArray(containers) ? containers : [];
  const fields = fieldMap && typeof fieldMap === 'object' ? Object.entries(fieldMap) : [];
  const perField = fields.map(([field, spec]) => {
    const subSelector = typeof spec === 'string' ? spec : (spec && spec.selector);
    const attr = typeof spec === 'string' ? null : (spec && spec.attr) || null;
    const sampleTexts = [];
    const sampleHrefs = [];
    let matchCount = 0;
    if (!subSelector) {
      return { field, subSelector: null, attr, matchCount: 0, sampleTexts: [], sampleHrefs: [] };
    }
    for (const c of containerArr) {
      let el;
      try { el = c.querySelector(subSelector); } catch (_) { el = null; }
      if (!el) continue;
      matchCount += 1;
      if (!attr && sampleTexts.length < 3 && typeof el.textContent === 'string') {
        sampleTexts.push(el.textContent.trim().slice(0, 80));
      }
      if (!attr && sampleHrefs.length < 3 && el.getAttribute) {
        const href = el.getAttribute('href');
        if (href) sampleHrefs.push(String(href).slice(0, 120));
      }
    }
    return { field, subSelector, attr, matchCount, sampleTexts, sampleHrefs };
  });
  // Capture up to 2000 chars of the first container's outerHTML. The cap is
  // per-call: if there are multiple $extractList calls in one step, each one
  // contributes its own snippet. summarizeAllStepDiagnostics further caps the
  // aggregate to avoid unbounded prompt growth.
  let firstContainerHtml = null;
  if (containerArr.length > 0) {
    const c0 = containerArr[0];
    if (c0 && typeof c0.outerHTML === 'string') {
      // Collapse runs of whitespace to keep the snippet compact and to avoid
      // dumping huge indented DOM. Keep newlines so the LLM can read structure.
      const collapsed = c0.outerHTML.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ');
      firstContainerHtml = collapsed.length > 2000 ? collapsed.slice(0, 2000) + '…[truncated]' : collapsed;
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
  return {
    api: apiName,
    selector: selector || null,
    matchCount: arr.length,
    sampleTexts,
    sampleHrefs
  };
}

const api = {
  extractListRecords,
  extractListMultiRecords,
  clickInListItems,
  computeExtractListDiagnostics,
  computeSimpleSelectorDiagnostics
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof global !== 'undefined') global.ListExtractOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
