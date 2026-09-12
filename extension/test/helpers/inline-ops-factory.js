// Shared vm harness for the content-script inline list-extract-ops factory.
// Extracted from test/mechanical-semantic.test.js (sixty-ninth review F6) so
// behavioral test files can dual-execute their cases against BOTH the
// requireable lib (extension/lib/list-extract-ops.js) and the inline mirror
// in content-script.js.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readSrc(rel) { return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'); }
function sliceFn(src, a, b) {
  const s = src.indexOf(a); if (s === -1) throw new Error('marker not found: ' + a);
  const e = src.indexOf(b, s); if (e <= s) throw new Error('end marker not found: ' + b);
  return src.slice(s, e);
}

const CS = readSrc('content-script.js');
// createInlineListExtractOps IIFE 结束于下一个同级函数 getListExtractOps。
const INLINE_SLICE = sliceFn(CS, 'function createInlineListExtractOps()', '\n  function getListExtractOps()');
const RESOLVE_SLICE = sliceFn(CS, 'function resolveLabelledbyText(', '\n  async function domLabelledby');

function loadInline(dom) {
  const ctx = {
    document: dom.window.document,
    resolveLabelledbyText: (el, attr) => ({ text: ((el && el.textContent) || '').trim(), attr, refCount: 0, missingIds: [] }),
    capElementHtmlRead: (v) => v
  };
  vm.createContext(ctx);
  vm.runInContext(RESOLVE_SLICE + '\n' + INLINE_SLICE + '\nthis.__ops = createInlineListExtractOps();', ctx);
  return ctx.__ops;
}

module.exports = { loadInline, readSrc, sliceFn };
