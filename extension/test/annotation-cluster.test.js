const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/annotation-cluster');
const { clusterAnnotationsByContainer } = require('../lib/annotation-cluster');

describe('annotation-cluster bootstrap', () => {
  it('returns empty samples and supplemental for empty input', () => {
    const r = clusterAnnotationsByContainer([]);
    assert.deepEqual(r.samples, []);
    assert.deepEqual(r.supplemental, []);
  });

  it('returns empty samples and supplemental for non-array input', () => {
    const r = clusterAnnotationsByContainer(null);
    assert.deepEqual(r.samples, []);
    assert.deepEqual(r.supplemental, []);
  });
});

const { parseDomPathSegments } = require('../lib/annotation-cluster');

describe('parseDomPathSegments', () => {
  it('splits a simple child-combinator path', () => {
    assert.deepEqual(parseDomPathSegments('div > div > span'), ['div', 'div', 'span']);
  });

  it('does not split on spaces inside attribute brackets', () => {
    const p = "div > div[role='article'][aria-posinset='3'] > h3 > a";
    assert.deepEqual(parseDomPathSegments(p), [
      'div',
      "div[role='article'][aria-posinset='3']",
      'h3',
      'a',
    ]);
  });

  it('returns [] for non-string input', () => {
    assert.deepEqual(parseDomPathSegments(null), []);
    assert.deepEqual(parseDomPathSegments(undefined), []);
    assert.deepEqual(parseDomPathSegments(42), []);
  });

  it('trims whitespace around segments', () => {
    assert.deepEqual(parseDomPathSegments('  div  >  span  '), ['div', 'span']);
  });

  it('handles single-segment path (no combinator)', () => {
    assert.deepEqual(parseDomPathSegments('div'), ['div']);
  });
});

const { normalizeSegment } = require('../lib/annotation-cluster');

describe('normalizeSegment', () => {
  it('strips the value from [attr="N"] (double-quote form)', () => {
    assert.equal(normalizeSegment('div[aria-posinset="3"]'), 'div[aria-posinset]');
  });

  it('strips the value from [attr=\'N\'] (single-quote form)', () => {
    assert.equal(normalizeSegment("div[aria-posinset='3']"), 'div[aria-posinset]');
  });

  it('strips the value from [data-index="42"]', () => {
    assert.equal(normalizeSegment('div[data-index="42"]'), 'div[data-index]');
  });

  it('collapses numeric-suffix ids to a stable marker', () => {
    assert.equal(normalizeSegment('div#post-7'), 'div[id]');
    assert.equal(normalizeSegment('div#item-42'), 'div[id]');
  });

  it('strips class numeric suffixes to a prefix pattern', () => {
    assert.equal(normalizeSegment('div.item-3'), 'div.item-');
    assert.equal(normalizeSegment('div.card7'), 'div.card');
  });

  it('drops :nth-of-type(N) and :nth-child(N)', () => {
    assert.equal(normalizeSegment('div:nth-of-type(3)'), 'div');
    assert.equal(normalizeSegment('li:nth-child(2)'), 'li');
  });

  it('preserves semantic attributes like role', () => {
    assert.equal(normalizeSegment("div[role='article']"), 'div[role]');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(normalizeSegment(''), '');
    assert.equal(normalizeSegment(null), '');
  });
});

const { isHighConfidence } = require('../lib/annotation-cluster');

describe('isHighConfidence', () => {
  it('returns true for [role="..."]', () => {
    assert.equal(isHighConfidence("div[role='article']"), true);
  });

  it('returns true for [aria-posinset] (value stripped or not)', () => {
    assert.equal(isHighConfidence("div[aria-posinset='3']"), true);
    assert.equal(isHighConfidence('div[aria-posinset]'), true);
  });

  it('returns true for [data-index], [data-item], [data-testid], [data-row], [data-cid], [data-id]', () => {
    assert.equal(isHighConfidence('div[data-index="42"]'), true);
    assert.equal(isHighConfidence('div[data-item="1"]'), true);
    assert.equal(isHighConfidence('div[data-testid="result"]'), true);
    assert.equal(isHighConfidence('div[data-row="7"]'), true);
    assert.equal(isHighConfidence('div[data-cid="abc"]'), true);
    assert.equal(isHighConfidence('div[data-id="x"]'), true);
  });

  it('returns true for li / tr / option tag', () => {
    assert.equal(isHighConfidence('li'), true);
    assert.equal(isHighConfidence('tr.item'), true);
    assert.equal(isHighConfidence('option[value="a"]'), true);
  });

  it('returns true for item-/post-/card-/row-/entry-/result-/product-N class patterns', () => {
    assert.equal(isHighConfidence('div.item-3'), true);
    assert.equal(isHighConfidence('div.post-7'), true);
    assert.equal(isHighConfidence("div.card-42[x='1']"), true);
    assert.equal(isHighConfidence('div.row7'), true);
    assert.equal(isHighConfidence('div.entry-1'), true);
    assert.equal(isHighConfidence('div.result-99'), true);
    assert.equal(isHighConfidence('div.product-5'), true);
  });

  it('returns false for a generic section without signals', () => {
    assert.equal(isHighConfidence('section'), false);
    assert.equal(isHighConfidence('div.wrapper'), false);
  });

  it('returns false for empty input', () => {
    assert.equal(isHighConfidence(''), false);
    assert.equal(isHighConfidence(null), false);
  });
});

describe('clusterAnnotationsByContainer branching detection', () => {
  it('detects branching at [role="article"][aria-posinset="N"]', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.title', selector: "div[role='article'][aria-posinset='1'] h3",
        domPath: "div > div[role='article'][aria-posinset='1'] > h3" },
      { type: 'extract', outputField: 'posts.title', selector: "div[role='article'][aria-posinset='2'] h3",
        domPath: "div > div[role='article'][aria-posinset='2'] > h3" },
      { type: 'extract', outputField: 'posts.title', selector: "div[role='article'][aria-posinset='3'] h3",
        domPath: "div > div[role='article'][aria-posinset='3'] > h3" },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 3, 'three samples — one per aria-posinset');
    assert.equal(r.supplemental.length, 0);
  });

  it('detects branching at li tag', () => {
    const annos = [
      { type: 'extract', outputField: 'items.name', selector: 'li:nth-of-type(1) span',
        domPath: 'ul > li:nth-of-type(1) > span' },
      { type: 'extract', outputField: 'items.name', selector: 'li:nth-of-type(2) span',
        domPath: 'ul > li:nth-of-type(2) > span' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 2);
  });

  it('detects branching at div.item-N class pattern', () => {
    const annos = [
      { type: 'extract', outputField: 'products.title', selector: 'div.item-1 .title',
        domPath: 'div > div.item-1 > .title' },
      { type: 'extract', outputField: 'products.title', selector: 'div.item-2 .title',
        domPath: 'div > div.item-2 > .title' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 2);
  });

  it('does NOT branch on depth-0 header/footer divergence (not list items)', () => {
    // Two annotations on completely separate roots (header, footer). Neither
    // is a list-item signal (no role, no positional attr, not li/tr/option,
    // no numeric-suffix class), and each "group" has only 1 annotation.
    // Correct behavior: do not branch — treat as a single sample.
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: 'header span', domPath: 'header > span' },
      { type: 'extract', outputField: 'x.y', selector: 'footer span', domPath: 'footer > span' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 1, 'header/footer is not item-level divergence');
    assert.equal(r.samples[0].annotations.length, 2);
  });

  it('does NOT branch on sibling-leaf divergence (h3 vs span under same parent)', () => {
    // Two annotations on sibling leaves of the SAME parent. Not item-level
    // divergence — this is the canonical "2 fields on 1 item" authoring
    // pattern. Should produce 1 sample with 2 annotations.
    const annos = [
      { type: 'extract', outputField: 'posts.title', selector: 'div h3', domPath: 'div > h3' },
      { type: 'extract', outputField: 'posts.author', selector: 'div span', domPath: 'div > span' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 1, 'sibling leaves on same parent = same sample');
    assert.equal(r.samples[0].annotations.length, 2);
  });

  it('branches when a custom (LOW-conf) segment has 2+ annotations per group', () => {
    // Two custom <section data-foo='a/b'> containers, each with 2 annotated
    // fields. Neither segment is HIGH confidence, but the multi-field-per-
    // group signal proves the user treated each as a container.
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: "section[data-foo='a'] h3",
        domPath: "section[data-foo='a'] > h3" },
      { type: 'extract', outputField: 'x.z', selector: "section[data-foo='a'] p",
        domPath: "section[data-foo='a'] > p" },
      { type: 'extract', outputField: 'x.y', selector: "section[data-foo='b'] h3",
        domPath: "section[data-foo='b'] > h3" },
      { type: 'extract', outputField: 'x.z', selector: "section[data-foo='b'] p",
        domPath: "section[data-foo='b'] > p" },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 2, 'multi-field-per-group triggers branching');
    assert.equal(r.samples[0].confidence, 'low');
  });
});

describe('clusterAnnotationsByContainer confidence assignment', () => {
  it('assigns HIGH confidence to [role="article"][aria-posinset]', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: "div[role='article'][aria-posinset='1'] h3",
        domPath: "div > div[role='article'][aria-posinset='1'] > h3" },
      { type: 'extract', outputField: 'x.y', selector: "div[role='article'][aria-posinset='2'] h3",
        domPath: "div > div[role='article'][aria-posinset='2'] > h3" },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].confidence, 'high');
    assert.equal(r.samples[1].confidence, 'high');
  });

  it('assigns HIGH confidence to li', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: 'li:nth-of-type(1) span', domPath: 'ul > li:nth-of-type(1) > span' },
      { type: 'extract', outputField: 'x.y', selector: 'li:nth-of-type(2) span', domPath: 'ul > li:nth-of-type(2) > span' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].confidence, 'high');
  });

  it('assigns HIGH confidence to div.item-N class pattern', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: 'div.item-1 .t', domPath: 'div > div.item-1 > .t' },
      { type: 'extract', outputField: 'x.y', selector: 'div.item-2 .t', domPath: 'div > div.item-2 > .t' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].confidence, 'high');
  });

  it('assigns LOW confidence to a custom branching segment with multi-field groups', () => {
    // section[data-foo='a/b'] is not in the HIGH-confidence list (no role,
    // no aria-posinset, no data-item/index/row/testid/cid/id, not li/tr/option,
    // no numeric-suffix class or id). But each branch has 2 annotations, so
    // branching fires and confidence is LOW.
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: "section[data-foo='a'] h3",
        domPath: "section[data-foo='a'] > h3" },
      { type: 'extract', outputField: 'x.z', selector: "section[data-foo='a'] p",
        domPath: "section[data-foo='a'] > p" },
      { type: 'extract', outputField: 'x.y', selector: "section[data-foo='b'] h3",
        domPath: "section[data-foo='b'] > h3" },
      { type: 'extract', outputField: 'x.z', selector: "section[data-foo='b'] p",
        domPath: "section[data-foo='b'] > p" },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].confidence, 'low');
    assert.equal(r.samples[1].confidence, 'low');
  });

  it('records containerSelector (raw) and containerTag (normalized) per sample', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: "div[role='article'][aria-posinset='1'] h3",
        domPath: "div > div[role='article'][aria-posinset='1'] > h3" },
      { type: 'extract', outputField: 'x.y', selector: "div[role='article'][aria-posinset='2'] h3",
        domPath: "div > div[role='article'][aria-posinset='2'] > h3" },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].containerSelector, "div[role='article'][aria-posinset='1']");
    assert.equal(r.samples[0].containerTag, 'div[role][aria-posinset]');
  });
});

describe('clusterAnnotationsByContainer selector cleanup', () => {
  it('strips aria-posinset value from per-annotation selectors', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: "div[aria-posinset='1'] h3 a",
        domPath: "div > div[aria-posinset='1'] > h3 > a" },
      { type: 'extract', outputField: 'x.y', selector: "div[aria-posinset='2'] h3 a",
        domPath: "div > div[aria-posinset='2'] > h3 > a" },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].annotations[0].selector, 'div[aria-posinset] h3 a');
    assert.equal(r.samples[1].annotations[0].selector, 'div[aria-posinset] h3 a');
  });

  it('drops :nth-of-type(N) from per-annotation selectors', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: 'li:nth-of-type(1) span',
        domPath: 'ul > li:nth-of-type(1) > span' },
      { type: 'extract', outputField: 'x.y', selector: 'li:nth-of-type(2) span',
        domPath: 'ul > li:nth-of-type(2) > span' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].annotations[0].selector, 'li span');
  });

  it('collapses numeric-suffix id to [id] marker', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: 'div#post-1 .t', domPath: 'div > div#post-1 > .t' },
      { type: 'extract', outputField: 'x.y', selector: 'div#post-2 .t', domPath: 'div > div#post-2 > .t' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples[0].annotations[0].selector, 'div[id] .t');
  });

  it('preserves the original annotation object except selector (no mutation of input)', () => {
    const orig = { type: 'extract', outputField: 'x.y', selector: "div[aria-posinset='1'] h3",
      domPath: "div > div[aria-posinset='1'] > h3" };
    const annos = [orig,
      { type: 'extract', outputField: 'x.y', selector: "div[aria-posinset='2'] h3",
        domPath: "div > div[aria-posinset='2'] > h3" }];
    clusterAnnotationsByContainer(annos);
    assert.equal(orig.selector, "div[aria-posinset='1'] h3", 'input not mutated');
  });
});

describe('clusterAnnotationsByContainer single-sample fallback', () => {
  it('returns one sample when all annotations share the same domPath (no branching)', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.title', selector: 'div h3', domPath: 'div > h3' },
      { type: 'extract', outputField: 'posts.author', selector: 'div span', domPath: 'div > span' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 1);
    assert.equal(r.samples[0].annotations.length, 2);
    assert.equal(r.supplemental.length, 0);
    assert.equal(r.samples[0].containerSelector, null);
    assert.equal(r.samples[0].containerTag, null);
    assert.equal(r.samples[0].confidence, 'low');
  });

  it('returns one sample when annotations all branch at depth 0 but only ONE branch has annotations', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: 'a span', domPath: 'a > span' },
      { type: 'extract', outputField: 'x.z', selector: 'a em', domPath: 'a > em' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 1);
    assert.equal(r.samples[0].annotations.length, 2);
  });
});

describe('clusterAnnotationsByContainer supplemental separation', () => {
  it('pushes annotations whose domPath is shorter than branching depth to supplemental', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.title', selector: "div[aria-posinset='1'] h3",
        domPath: "div > div[aria-posinset='1'] > h3" },
      { type: 'extract', outputField: 'posts.title', selector: "div[aria-posinset='2'] h3",
        domPath: "div > div[aria-posinset='2'] > h3" },
      { type: 'extract', outputField: 'global.subtitle', selector: 'header h2',
        domPath: 'header' }, // only 1 segment — too short to reach branching depth 1
    ];
    const r = clusterAnnotationsByContainer(annos);
    assert.equal(r.samples.length, 2);
    assert.equal(r.supplemental.length, 1);
    assert.equal(r.supplemental[0].outputField, 'global.subtitle');
  });

  it('includes all annotations in supplemental when none have domPath', () => {
    const annos = [
      { type: 'extract', outputField: 'x.y', selector: 'a' },
      { type: 'extract', outputField: 'x.z', selector: 'b' },
    ];
    const r = clusterAnnotationsByContainer(annos);
    // No domPaths → parsed segs are empty → branchingDepth stays -1 →
    // single-sample fallback applies (not supplemental).
    assert.equal(r.samples.length, 1);
    assert.equal(r.samples[0].annotations.length, 2);
  });
});
