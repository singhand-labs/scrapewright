// extension/lib/list-extract-ops.js
//
// Pure helpers that operate on already-resolved container Element arrays.
// content-script.js wraps these with querySelectorAllDeep to produce
// domExtractList / domClickInList.

function readField(container, spec) {
  // spec is either a string ('.author') or { selector, attr? }
  const sel = typeof spec === 'string' ? spec : spec.selector;
  const attr = typeof spec === 'string' ? null : spec.attr;
  const el = container.querySelector(sel);
  if (!el) return undefined;
  if (attr) return el.getAttribute(attr);
  return (el.textContent || '').trim();
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
  return {
    api: 'extractList',
    containerSelector: containerSelector || null,
    containerMatches: containerArr.length,
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
  clickInListItems,
  computeExtractListDiagnostics,
  computeSimpleSelectorDiagnostics
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ListExtractOps = api;
if (typeof self !== 'undefined') self.ListExtractOps = api;
