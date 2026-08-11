// Drift guard: content-script.js's createInlineListExtractOps() inline
// fallback MUST export the same function names as lib/list-extract-ops.js's
// public `api` object. The fallback fires when Chrome's MV3 content-script
// injection glitches (see comment block in content-script.js and bugx.log
// 2026-07-23). If the two objects drift, the fallback silently loses
// capabilities and the LLM-generated script crashes at runtime — which is
// exactly what happened in console.log 2026-07-26: $extractListMultiRecords
// existed in lib but not in the inline fallback, so step 4 crashed with
// "ops.extractListMultiRecords is not a function" whenever the fallback fired.
//
// This test parses both files as text rather than executing them, because
// content-script.js is a strict-mode IIFE that does not export anything.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'list-extract-ops.js');
const CONTENT_SCRIPT_PATH = path.join(__dirname, '..', 'content-script.js');

const libModule = require(MODULE_PATH);

function extractModuleExports(source) {
  // Match: const api = { ... }; (the public api object near the end)
  const m = source.match(/const\s+api\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, 'lib/list-extract-ops.js: could not find `const api = { ... };`');
  // Identifiers before `(` or `,` or whitespace — these are the function names.
  const names = (m[1].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).filter(
    (n) => n !== 'module' && n !== 'exports' && n !== 'window' && n !== 'self'
  );
  return Array.from(new Set(names));
}

function extractInlineReturn(source) {
  // Slice from `function createInlineListExtractOps` to the end of its body.
  // The function ends at the first `}` at depth 0 after the `function ... {`
  // opener. We must skip: string literals (', ", `), line comments (//), and
  // block comments (/* */) so braces/apostrophes inside them don't corrupt
  // the depth counter — a single apostrophe in "aren't" inside a comment was
  // enough to make the original naive walker exit early.
  const fnStart = source.indexOf('function createInlineListExtractOps');
  assert.ok(fnStart !== -1, 'content-script.js: createInlineListExtractOps not found');
  let depth = 0;
  let inString = null;
  let fnBodyStart = -1;
  let fnEnd = -1;
  for (let i = fnStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    // Line comment: skip to end of line.
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // Block comment: skip to */.
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++; // consume the trailing /
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') {
      if (depth === 0) fnBodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) { fnEnd = i; break; }
    }
  }
  assert.ok(fnEnd !== -1, 'content-script.js: createInlineListExtractOps body never closes');
  const body = source.slice(fnBodyStart, fnEnd);

  // Find the LAST `return {` in the function body — that's the public api
  // object. Earlier `return { ... }` statements belong to inner helpers like
  // clickInListItems' `return { clicked, errors, delayMs: delay }`.
  let lastRet = -1;
  for (let i = 0; i < body.length - 8; i++) {
    if (body[i] === 'r' && body.slice(i, i + 8) === 'return {') {
      lastRet = i;
    }
  }
  assert.ok(lastRet !== -1, 'content-script.js: createInlineListExtractOps has no return object');
  // Balance braces from `return {` to its matching `}`.
  let i = lastRet + 'return '.length;
  let rdepth = 0;
  inString = null;
  let end = -1;
  for (; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') rdepth++;
    else if (ch === '}') {
      rdepth--;
      if (rdepth === 0) { end = i; break; }
    }
  }
  assert.ok(end !== -1, 'content-script.js: createInlineListExtractOps return object not balanced');
  const retBody = body.slice(lastRet + 'return '.length, end + 1);
  // The returned object is a flat shorthand: `{ name1, name2, name3 }`. Filter
  // out keywords/reserved words just in case the regex picks up stray tokens.
  const names = (retBody.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).filter(
    (n) => n !== 'return'
  );
  return Array.from(new Set(names));
}

describe('inline ListExtractOps fallback drift guard', () => {
  it('inline fallback returns the same function names as lib module exports', () => {
    const moduleSrc = fs.readFileSync(MODULE_PATH, 'utf8');
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const moduleExports = extractModuleExports(moduleSrc).sort();
    const inlineExports = extractInlineReturn(csSrc).sort();

    assert.deepEqual(
      inlineExports,
      moduleExports,
      'content-script.js createInlineListExtractOps() return object must list the same function ' +
      'names as lib/list-extract-ops.js `const api = { ... }`. If you added a function to the ' +
      'module, mirror it in the inline fallback — otherwise the fallback (fired by Chrome MV3 ' +
      'injection glitch) silently loses capabilities.'
    );
  });

  it('inline fallback source defines each exported function by name', () => {
    const moduleSrc = fs.readFileSync(MODULE_PATH, 'utf8');
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const moduleExports = extractModuleExports(moduleSrc);
    for (const name of moduleExports) {
      const defPattern = new RegExp(`function\\s+${name}\\s*\\(`);
      assert.ok(
        defPattern.test(csSrc),
        `content-script.js: inline fallback is missing function definition for "${name}". ` +
        'Update the inline fallback to mirror lib/list-extract-ops.js.'
      );
    }
  });

  it('inline fallback defines DOM_PROPERTY_READS set (RC5 fix)', () => {
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const fnStart = csSrc.indexOf('function createInlineListExtractOps');
    const slice = csSrc.slice(fnStart, fnStart + 4000);
    assert.ok(
      /DOM_PROPERTY_READS\s*=/.test(slice),
      'content-script.js: inline fallback missing DOM_PROPERTY_READS. ' +
      'outerHTML/innerHTML are DOM properties — getAttribute returns null. ' +
      'Mirrors lib/list-extract-ops.js RC5 fix.'
    );
    assert.ok(
      /outerHTML/.test(slice) && /innerHTML/.test(slice),
      'content-script.js: inline fallback DOM_PROPERTY_READS must include outerHTML and innerHTML.'
    );
  });

  it('lib computeExtractListDiagnostics emits firstContainerHtml (RC13 contract)', () => {
    // Pin the lib contract: with at least one container, the returned
    // diagnostic object MUST carry firstContainerHtml. This is the field
    // getFirstRecordHtmlFromAnyStep reads to produce the FIELD_CANDIDATES
    // signal. Without it, autoFix iterates blind to where in the record
    // DOM the missing fields live (console.log 2026-08-11 regression).
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><div id="c1"><span class="t">hello</span></div>');
    const c1 = dom.window.document.getElementById('c1');
    const result = libModule.computeExtractListDiagnostics(
      [c1],
      { text: '.t' },
      '#c1'
    );
    assert.ok(
      typeof result.firstContainerHtml === 'string' && result.firstContainerHtml.length > 0,
      'lib computeExtractListDiagnostics must return non-empty firstContainerHtml when containers non-empty'
    );
  });

  it('inline fallback computeExtractListDiagnostics body mentions firstContainerHtml (RC13 mirror)', () => {
    // Source-text audit: the inline fallback's computeExtractListDiagnostics
    // function body MUST reference firstContainerHtml. This guards against
    // the silent drift where lib gains a field (RC13 added firstContainerHtml)
    // but the inline fallback doesn't mirror it — when MV3 injection glitch
    // fires the fallback, the field goes missing and FIELD_CANDIDATES signal
    // silently suppresses (console.log 2026-08-11).
    //
    // We slice the inline function body using the same comment-aware brace
    // walker the existing tests use, then assert the literal appears.
    const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
    const fnName = 'computeExtractListDiagnostics';
    // Find the inline definition INSIDE createInlineListExtractOps (not the
    // lib's). The inline is at top-level inside the IIFE; pick the second
    // occurrence (first is the call site in domExtractList).
    const fnDefStart = csSrc.indexOf(`function ${fnName}(`);
    assert.ok(fnDefStart !== -1, `content-script.js: inline ${fnName} not defined`);

    // Brace-walk to the end of the function body.
    let depth = 0;
    let inString = null;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = fnDefStart; i < csSrc.length; i++) {
      const ch = csSrc[i];
      const next = csSrc[i + 1];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '/' && next === '/') {
        while (i < csSrc.length && csSrc[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < csSrc.length && !(csSrc[i] === '*' && csSrc[i + 1] === '/')) i++;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '{') {
        if (depth === 0) bodyStart = i + 1;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    assert.ok(bodyEnd !== -1, `content-script.js: inline ${fnName} body never closes`);
    const body = csSrc.slice(bodyStart, bodyEnd);
    assert.ok(
      /firstContainerHtml/.test(body),
      'content-script.js: inline computeExtractListDiagnostics must reference firstContainerHtml. ' +
      'lib/list-extract-ops.js RC13 added this field; the inline fallback must mirror the capture ' +
      'so FIELD_CANDIDATES signal survives MV3 injection glitches.'
    );
    // Also assert the field is in the return object (not just referenced in a
    // comment). Look for `firstContainerHtml,` or `firstContainerHtml:` in the
    // last `return {` block within the body.
    let lastRet = -1;
    for (let i = 0; i < body.length - 8; i++) {
      if (body[i] === 'r' && body.slice(i, i + 8) === 'return {') lastRet = i;
    }
    assert.ok(lastRet !== -1, `content-script.js: inline ${fnName} has no return object`);
    const retSlice = body.slice(lastRet);
    assert.ok(
      /firstContainerHtml/.test(retSlice),
      'content-script.js: inline computeExtractListDiagnostics return object must include firstContainerHtml'
    );
  });
});
