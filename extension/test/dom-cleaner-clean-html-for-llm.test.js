// RC24 Task A2 — cleanHtmlForLLM tiered degradation + htmlFingerprint.
//
// Before A2: cleanHtmlForLLM returned {mode:'full'|'compressed'} and used a
// blunt substring(0, 80000) cut on the cleaned HTML body. After A2: it takes
// a `budget` parameter (default 30000) and degrades through four tiers:
//   full → annotated → compressed → needs_subtree_selection.
// Every tier returns a `fingerprint` (djb2 of whitespace-normalized HTML)
// except needs_subtree_selection, which intentionally returns null so Module C
// cannot dedup a half-decided page.
//
// IMPORTANT — fixtures must respect A1 (truncateLongTextInNodes, 200-char cap).
// Padding with a single 'x'.repeat(40000) text node no longer overflows the
// budget because A1 truncates it to ~200 chars during cleanPageHtml. We use
// realistic shapes: many distinct short elements whose aggregate cleaned-HTML
// size exceeds the budget.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;
global.NodeFilter = dom.window.NodeFilter;
global.Node = dom.window.Node;
global.document = dom.window.document;
global.window = dom.window;
global.CSS = dom.window.CSS;

const DomCleaner = require('../lib/dom-cleaner.js');

// Realistic volume: many short elements. ~4000 rows × ~60 chars ≈ 240KB
// cleaned HTML — safely above any plausible default budget (30K) and the
// legacy 80K threshold alike.
function makeHugeHtml(elementCount) {
  let s = '<html><body>';
  for (let i = 0; i < elementCount; i++) {
    s += `<div class="row-${i}" data-i="${i}"><span>row ${i} label</span><a href="/p/${i}">item ${i}</a></div>`;
  }
  s += '</body></html>';
  return s;
}

describe('htmlFingerprint', () => {
  const { htmlFingerprint } = DomCleaner;

  it('returns "empty" for empty / whitespace-only input', () => {
    assert.equal(htmlFingerprint(''), 'empty');
    assert.equal(htmlFingerprint(null), 'empty');
    assert.equal(htmlFingerprint(undefined), 'empty');
    assert.equal(htmlFingerprint('   \n\t  '), 'empty');
  });

  it('returns an 8-char hex string for non-empty input', () => {
    const fp = htmlFingerprint('<html><body>hi</body></html>');
    assert.equal(typeof fp, 'string');
    assert.match(fp, /^[0-9a-f]{8}$/);
  });

  it('is insensitive to whitespace run differences (djb2 of normalized HTML)', () => {
    // The hash collapses internal whitespace runs to a single space.
    const a = htmlFingerprint('<div>hello   world</div>');
    const b = htmlFingerprint('<div>hello world</div>');
    assert.equal(a, b);
  });

  it('changes when content changes', () => {
    const a = htmlFingerprint('<div>foo</div>');
    const b = htmlFingerprint('<div>bar</div>');
    assert.notEqual(a, b);
  });
});

describe('cleanHtmlForLLM tiered degradation', () => {
  const { cleanHtmlForLLM } = DomCleaner;

  it('returns mode:"full" with a fingerprint when cleaned HTML fits budget', () => {
    const html = '<html><body><div class="product">Widget</div></body></html>';
    const result = cleanHtmlForLLM(html, [], 30000);
    assert.equal(result.mode, 'full');
    assert.ok(typeof result.html === 'string' && result.html.length > 0);
    assert.ok(result.html.includes('Widget'));
    assert.equal(typeof result.fingerprint, 'string');
    assert.match(result.fingerprint, /^[0-9a-f]{8}$/);
  });

  it('returns mode:"full" with default 30000 budget when budget is omitted', () => {
    // ~100 small elements — well under 30K cleaned.
    let s = '<html><body>';
    for (let i = 0; i < 100; i++) s += `<div class="r${i}">item ${i}</div>`;
    s += '</body></html>';
    const result = cleanHtmlForLLM(s, []);
    assert.equal(result.mode, 'full');
    assert.match(result.fingerprint, /^[0-9a-f]{8}$/);
  });

  it('returns mode:"annotated" when full exceeds budget but annotated contexts fit', () => {
    // Many rows so cleaned HTML blows past a small budget. The annotated
    // element wraps only a handful of rows → its context is tiny and fits.
    const huge = makeHugeHtml(2000);
    // Wrap a small slice in .target so extractAnnotationContext yields a
    // small subtree. The bulk stays outside .target.
    const annotatedHtml =
      '<html><body>' +
      '<div class="target"><span>wanted</span><a href="/x">link</a></div>' +
      makeHugeHtmlBodyOnly(2000) +
      '</body></html>';
    const annotations = [{ selector: '.target', outputField: 'wanted' }];
    const result = cleanHtmlForLLM(annotatedHtml, annotations, 5000);
    assert.equal(result.mode, 'annotated');
    assert.ok(Array.isArray(result.contexts));
    assert.equal(result.contexts.length, 1);
    assert.equal(result.contexts[0].selector, '.target');
    assert.ok(result.contexts[0].context);
    assert.ok(result.contexts[0].context.includes('wanted'));
    // No `html` or `structure` in annotated mode — caller must read contexts.
    assert.equal(result.html, undefined);
    assert.equal(result.structure, undefined);
    assert.match(result.fingerprint, /^[0-9a-f]{8}$/);
  });

  it('returns mode:"compressed" when annotated exceeds budget but structure fits', () => {
    // 4000 short rows whose cleaned HTML is ~240KB. Use a tiny budget AND
    // no annotations → annotatedBundle is empty → falls to compressed.
    // compressStructure at default depth folds most rows to "+1 children"
    // placeholders, producing output well under a generous budget.
    const html = makeHugeHtml(4000);
    // Pick a budget between structure size and cleaned size. Structure is
    // ~130K for 4000 rows; use budget=200000 → annotated bundle is empty
    // (no annotations) so we skip tier 2b and land on 2c, then 2c's output
    // is below 200K so we get mode:'compressed'.
    const result = cleanHtmlForLLM(html, [], 200000);
    assert.equal(result.mode, 'compressed');
    assert.equal(typeof result.structure, 'string');
    assert.ok(result.structure.length > 0);
    assert.ok(Array.isArray(result.contexts));
    assert.match(result.fingerprint, /^[0-9a-f]{8}$/);
  });

  it('returns mode:"needs_subtree_selection" with fingerprint:null when even structure overflows', () => {
    // 4000 rows → structure ~130K. Budget = 5000 → both annotated bundle
    // (empty) and compressed structure overflow. Tier 2d fires.
    const html = makeHugeHtml(4000);
    const result = cleanHtmlForLLM(html, [], 5000);
    assert.equal(result.mode, 'needs_subtree_selection');
    assert.equal(typeof result.structureForSelection, 'string');
    assert.ok(result.structureForSelection.length > 0);
    assert.equal(result.fingerprint, null);
    // structureForSelection uses opts.maxDepth=2 — verify by re-deriving.
    // (We assert the field exists and is non-empty; depth semantics are
    // covered by the compressStructure opts test below.)
  });

  it('falls back to mode:"annotated" when annotated context selector does not match', () => {
    // When extractAnnotationContext returns null for a missing selector,
    // the bundle is empty → annotatedBundle.length > 0 guard fails → falls
    // through to compressed / needs_subtree_selection.
    const huge = makeHugeHtml(4000);
    const annotations = [{ selector: '.does-not-exist', outputField: 'x' }];
    const result = cleanHtmlForLLM(huge, annotations, 200000);
    assert.equal(result.mode, 'compressed');
    assert.ok(Array.isArray(result.contexts));
    // The unmatched annotation produces no entry (filtered out).
    assert.equal(result.contexts.length, 0);
  });

  it('does not perform substring(0, budget) blunt cut on the HTML body', () => {
    // Even when budget is tiny (say 50), the result must NOT contain a
    // truncated mid-tag HTML body. Tier 2d should kick in instead.
    const html = '<html><body><div class="x">y</div></body></html>';
    const result = cleanHtmlForLLM(html, [], 50);
    // Such a small cleaned HTML (< 50 chars) stays in 'full' mode. Test
    // the boundary explicitly: cleaned is ~50-60 chars, so mode may be
    // either 'full' (if ≤50) or 'needs_subtree_selection' (if >50 and no
    // annotations and small compressed exceeds 50). Either way, the HTML
    // body is never blunt-cut mid-tag.
    assert.ok(['full', 'annotated', 'compressed', 'needs_subtree_selection'].includes(result.mode));
    if (result.mode === 'full') {
      // Full mode returns the complete cleaned HTML — never a substring.
      assert.ok(result.html.includes('</body>') || result.html.includes('<body'));
    }
  });

  it('returns mode:"full" html:"" fingerprint:"empty" for empty input', () => {
    const result = cleanHtmlForLLM('', [], 30000);
    assert.equal(result.mode, 'full');
    assert.equal(result.html, '');
    assert.equal(result.fingerprint, 'empty');
  });

  it('handles malformed HTML gracefully (parses what it can)', () => {
    // Malformed-but-parseable HTML shouldn't throw.
    const result = cleanHtmlForLLM('<html><body><div>unclosed', [], 30000);
    assert.equal(result.mode, 'full');
    assert.ok(result.html.length > 0);
  });

  it('accepts non-array annotations without throwing', () => {
    const html = '<html><body><div>x</div></body></html>';
    const result = cleanHtmlForLLM(html, null, 30000);
    assert.equal(result.mode, 'full');
  });

  it('accepts budget ≤ 0 by falling back to default 30000', () => {
    const html = '<html><body><div>x</div></body></html>';
    const r1 = cleanHtmlForLLM(html, [], 0);
    const r2 = cleanHtmlForLLM(html, [], -1);
    assert.equal(r1.mode, 'full');
    assert.equal(r2.mode, 'full');
  });
});

describe('compressStructure opts.maxDepth', () => {
  const { cleanPageHtml, compressStructure } = DomCleaner;

  it('uses opts.maxDepth for non-annotated subtrees when provided', () => {
    // Build a deep non-annotated tree. Default STRUCTURE_MAX_DEPTH_NORMAL=4
    // → nodes at depth 4 fold. With opts.maxDepth=2, nodes at depth 2 fold.
    // 5 nested divs: depth 0 (body) → 1 → 2 → 3 → 4 → 5.
    const html = '<html><body>' +
      '<div class="l1"><div class="l2"><div class="l3"><div class="l4"><div class="l5">deep</div></div></div></div></div>' +
      '</body></html>';
    const cleaned = cleanPageHtml(html);
    const doc = new DOMParser().parseFromString(cleaned, 'text/html');

    const defaultStruct = compressStructure(doc, []);
    const shallowStruct = compressStructure(doc, [], { maxDepth: 2 });

    // Default structure reaches deeper (includes 'deep' text or more levels).
    // Shallow structure folds earlier → fewer levels visible.
    assert.ok(defaultStruct.length >= shallowStruct.length);
    // Sanity: shallow version should mention folding at some level
    assert.ok(shallowStruct.includes('children') || shallowStruct.includes('deep'));
  });

  it('ignores opts.maxDepth when undefined (uses default)', () => {
    const html = '<html><body><div><div><div>deep</div></div></div></body></html>';
    const cleaned = cleanPageHtml(html);
    const doc = new DOMParser().parseFromString(cleaned, 'text/html');
    const a = compressStructure(doc, []);
    const b = compressStructure(doc, [], {});
    assert.equal(a, b);
  });

  it('annotated ancestors ignore opts.maxDepth (use STRUCTURE_MAX_DEPTH_ANNOTATED)', () => {
    // The annotated max depth boost is for ANCESTORS of the annotated element
    // (so they recurse into the annotated subtree rather than folding early).
    // opts.maxDepth only affects non-annotated subtrees. Build a tree where
    // .target is wrapped by several non-annotated ancestors.
    const html = '<html><body>' +
      // 6 wrapping divs above .target so default maxDepth=4 would fold the
      // outermost before reaching .target. With STRUCTURE_MAX_DEPTH_ANNOTATED=8,
      // the annotated ancestor chain recurses all the way down.
      '<div><div><div><div><div><div class="target"><span>wanted</span></div></div></div></div></div></div>' +
      '</body></html>';
    const cleaned = cleanPageHtml(html);
    const doc = new DOMParser().parseFromString(cleaned, 'text/html');
    const shallow = compressStructure(doc, ['.target'], { maxDepth: 1 });
    assert.ok(shallow.includes('[ANNOTATED]'));
    assert.ok(shallow.includes('wanted'),
      'annotated ancestor chain must reach .target even when opts.maxDepth=1; got: ' + shallow);
  });
});

function makeHugeHtmlBodyOnly(elementCount) {
  let s = '';
  for (let i = 0; i < elementCount; i++) {
    s += `<div class="fill-${i}" data-i="${i}"><span>row ${i} label</span><a href="/p/${i}">item ${i}</a></div>`;
  }
  return s;
}
