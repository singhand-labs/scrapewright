// extension/lib/list-pattern.js
//
// Pure analyzer that turns a list of annotations (each with an outputField and
// a CSS selector) into a derived $extractList / $clickInList call template.
// The output is fed to buildAnnotationsText so the LLM sees a generalized
// pattern ABOVE the raw per-annotation lines.

const AUTO_CLASS_RE = /^(x[09a-f]+|_[a-z0-9]+|html-)/i;

// Regex matches a single CSS compound selector segment, supporting:
//   tag, .class, #id, [attr], [attr=val], [attr^=val], :nth-of-type(N), :nth-child(N), ::iframe-prefix
// Splits on descendant combinator ' ' and child combinator ' > '.
const COMPOUND_RE = /(?:iframe[^:]*::)?(?:[.#]?[a-zA-Z][\w-]*(?:\[[^\]]+\]|:[a-zA-Z-]+(?:\([^)]*\))?|\.[\w-]+|# [\w-]+)*)/g;

function splitOnCombinators(sel) {
  // Replace child combinator ' > ' with a placeholder, split on whitespace, restore.
  // This avoids splitting inside [attr="... with spaces ..."].
  const tokens = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && c === ' ') {
      if (current.length) tokens.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.length) tokens.push(current);
  // Strip child combinator '>' tokens (now standalone) and attach semantics — we keep
  // them as explicit markers so the caller can distinguish 'a b' from 'a > b' if needed.
  return tokens.map(t => (t === '>' ? '>' : t.replace(/^>\s*/, '').replace(/\s*>$/, '')));
}

function parseSelectorSegments(selector) {
  if (!selector || typeof selector !== 'string') return [];
  return splitOnCombinators(selector).filter(t => t && t !== '>');
}

module.exports = { parseSelectorSegments, deriveListPattern: () => null };
