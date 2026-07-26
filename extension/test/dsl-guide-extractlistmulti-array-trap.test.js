// Regression test for the $extractListMulti return-shape ambiguity.
//
// console.log 2026-07-26 14:02:11 showed step 4 crash with
// `(r.author || "").trim is not a function`. The LLM used $extractListMulti
// (which returns Array<string|null> per field — see readFieldAll in
// lib/list-extract-ops.js) but wrote `(r.author || '').trim()` as if
// r.author were a string. (r.author || '') short-circuits to the truthy
// array, then .trim() crashes because Array has no .trim().
//
// That TypeError triggered a 4-iteration autoFix thrash (TypeError →
// POLL_EXHAUSTED → EMPTY_EXTRACTION → another EMPTY_EXTRACTION) because
// each fix addressed the symptom and triggered a new framework error
// classification.
//
// Root cause: the DSL guide's $extractListMulti example used plural field
// name `links`, which naturally suggests array, but didn't explicitly warn
// against the singular-name trap (author/content/time → LLM treats as
// single value). The fix strengthens the guide with explicit WRONG/RIGHT
// patterns. This test guards the warning text against future regressions.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');

function loadScriptDslGuide() {
  const src = fs.readFileSync(UTILS_PATH, 'utf8');
  // SCRIPT_DSL_GUIDE is a backticked template literal. The body itself
  // contains inline backticks for inline-code references (e.g. `class_name`),
  // so we can't just walk to the next backtick. The const declaration ends
  // with `; on its own line — anchor on that.
  const startIdx = src.indexOf('SCRIPT_DSL_GUIDE');
  assert.ok(startIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE not found');
  const eqIdx = src.indexOf('=', startIdx);
  const btIdx = src.indexOf('`', eqIdx);
  assert.ok(btIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE opening backtick not found');
  // The const declaration ends with `; (backtick + semicolon). The body
  // itself contains inline backticks (for inline-code references), so we
  // can't walk to the next backtick — we look for the literal `\`;`
  // sequence that terminates the template literal + statement.
  const endMarker = '`;';
  const endIdx = src.indexOf(endMarker, btIdx + 1);
  assert.ok(endIdx > btIdx, 'wizard-utils.js: SCRIPT_DSL_GUIDE closing backtick-semicolon not found — has the declaration moved?');
  return src.slice(btIdx + 1, endIdx);
}

describe('SCRIPT_DSL_GUIDE warns about $extractListMulti array trap', () => {
  const guide = loadScriptDslGuide();

  it('states that every $extractListMulti field value is an Array', () => {
    // Must explicitly call out "Array" in close proximity to the
    // $extractListMulti description so the LLM can't miss it.
    const idx = guide.indexOf('$extractListMulti');
    assert.ok(idx > -1, 'guide missing $extractListMulti entry');
    const window = guide.slice(idx, idx + 1500);
    assert.match(window, /Array/, 'guide must mention Array near $extractListMulti');
    assert.match(window, /Array<string\|null>/i, 'guide must specify the element type as string|null');
  });

  it('shows the WRONG `(r.field || \'\').trim()` pattern explicitly', () => {
    // The exact pattern that crashed at console.log 2026-07-26 14:02:11.
    // If a future edit drops this, the regression is back.
    const idx = guide.indexOf('$extractListMulti');
    const window = guide.slice(idx, idx + 2500);
    assert.match(window, /\(\s*r\.\w+\s*\|\|\s*''\s*\)\.trim\(\)/,
      'guide must show the WRONG pattern of (r.field OR empty-string).trim() near $extractListMulti');
    assert.match(window, /WRONG/i, 'guide must label the failing pattern as WRONG');
    assert.match(window, /\.trim\(\) is not a function|X\.trim/,
      'guide must mention the exact error message the LLM will see');
  });

  it('shows the RIGHT pattern: index [0] or .map/.filter/.find/.join', () => {
    const idx = guide.indexOf('$extractListMulti');
    const window = guide.slice(idx, idx + 2500);
    assert.match(window, /RIGHT/i, 'guide must show RIGHT pattern alongside WRONG');
    // Either pattern is acceptable: r.field[0] for first-match, or array method for multi.
    assert.ok(
      /r\.\w+\[\s*0\s*\]/.test(window) || /\.filter\(Boolean\)\.join/.test(window),
      'guide must show either r.field[0] or .filter(Boolean).join(...) as the correct alternative'
    );
  });

  it('nudges toward $extractList for first-match-only fields', () => {
    // The DSL has two tools: $extractList (single values, simpler) and
    // $extractListMulti (arrays). The LLM should reach for Multi only when
    // necessary; using Multi for everything increases the surface for the
    // .trim()-on-array bug.
    const idx = guide.indexOf('$extractListMulti');
    const window = guide.slice(idx, idx + 1500);
    assert.match(window, /\$extractList[\s,().]/,
      'guide must mention $extractList near $extractListMulti for comparison');
  });
});
