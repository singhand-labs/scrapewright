// RC45: container-scoped $extractWithHover primitive.
//
// Thirteenth hover-family incident. The existing $hover(..., { index: i })
// manual loop pattern assumes 1 anchor per container globally. When
// containers hold variable numbers of anchors (the universal case for any
// list of items with N>=0 hoverable entity references), the global anchor
// array interleaves across containers and the i-th call lands on the wrong
// container's anchor. $extractWithHover makes per-container anchor
// iteration a framework concern, eliminating the alignment failure mode.
//
// This file covers:
//   - Source-text audit for the domHover element-input refactor (Task 1)
//   - Source-text audit for the pure helper in lib/list-extract-ops.js (Task 2)
//   - Source-text audit for the inline fallback mirror (Task 3)
//   - Source-text audit for domExtractWithHover wrapper (Task 4)
//   - Source-text audit for sandbox + DOM_REQUEST wiring (Task 5)
//   - Source-text audit for ARRAY_EXTRACTION_RE update (Task 6)
//   - Source-text audit for DSL guide section + HOVER ENRICHMENT pointer (Tasks 7-8)
//   - JSDOM behavioral tests for extractWithHoverRecords (covered in Task 2)
//
// See docs/superpowers/specs/2026-08-12-extract-with-hover-design.md for the
// full design (local-only).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('RC45 Task 1: domHover accepts element-or-selector', () => {
  it('branches on element vs string input (avoids global querySelector when an element is passed)', () => {
    // Without this branch, $extractWithHover cannot pass a resolved anchor
    // element; it would have to re-enumerate globally, reintroducing the
    // alignment bug.
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domHover(');
    assert.ok(fnStart > -1, 'domHover function must exist');
    // Slice a reasonable window for the anchor-resolution block.
    const window = src.slice(fnStart, fnStart + 4000);
    // Must detect an element (DOM node) branch via nodeType or typeof object.
    assert.ok(/nodeType|typeof\s+\w+\s*===\s*['"]object['"]/.test(window),
      'domHover must branch on element vs string input (look for nodeType or typeof object check near the anchor-resolution block)');
  });

  it('keeps the existing string-selector path working (regression guard)', () => {
    // The refactor must be backward compatible: existing $hover callers
    // pass strings and use opts.index. The querySelectorAllDeep and
    // querySelectorDeep calls must still be present.
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domHover(');
    const window = src.slice(fnStart, fnStart + 5000);
    assert.ok(/querySelectorAllDeep/.test(window),
      'domHover must still call querySelectorAllDeep for string input with opts.index');
    assert.ok(/querySelectorDeep/.test(window),
      'domHover must still call querySelectorDeep for string input without opts.index');
  });
});
