// Pure URL-template helpers shared by background (importScripts) and wizard (<script>).
// Placeholders use {{paramName}} syntax; paramName must match \w+.

const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

function extractTemplateParams(template) {
  if (!template || typeof template !== 'string') return [];
  const seen = new Set();
  const out = [];
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function resolveTargetUrl(template, input) {
  const names = extractTemplateParams(template);
  if (names.length === 0) return template;

  const values = {};
  for (const name of names) {
    const v = input ? input[name] : undefined;
    if (v === null || v === undefined) {
      const err = new Error(`Missing URL template parameter: ${name}`);
      err.code = 'MISSING_URL_PARAM';
      err.paramName = name;
      throw err;
    }
    values[name] = Array.isArray(v)
      ? encodeURIComponent(String(v.join(',')))
      : encodeURIComponent(String(v));
  }

  // Replace valid placeholders; leave non-identifier {{...}} as literal text.
  return template.replace(PLACEHOLDER_RE, (full, name) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    return full;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractTemplateParams, resolveTargetUrl };
}
if (typeof window !== 'undefined') {
  window.UrlTemplate = { extractTemplateParams, resolveTargetUrl };
}
// Service Worker scope (no window/module): expose on `self` so importScripts
// consumers (background.js, step-orchestrator.js) can address UrlTemplate.* .
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof module === 'undefined') {
  self.UrlTemplate = { extractTemplateParams, resolveTargetUrl };
}
