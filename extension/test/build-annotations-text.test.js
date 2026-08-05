const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// list-pattern.js defines deriveListPattern, which buildAnnotationsText calls.
// Load it first so the function is defined as a global when wizard-utils loads.
require('../lib/list-pattern');
require('../lib/annotation-cluster');
require('../lib/wizard-utils');
const { buildAnnotationsText } = require('../lib/wizard-utils');

describe('buildAnnotationsText derived-pattern emission', () => {
  it('emits derived $extractList template ABOVE per-annotation lines when pattern exists', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(1) a' },
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(2) a' },
    ];
    const text = buildAnnotationsText(annos);
    assert.match(text, /LIST EXTRACTION PATTERN/, 'derived header present');
    assert.match(text, /\$extractList\('div\[role="article"\]'/, 'derived template uses container');
    // Per-annotation lines must still appear (below the derived block)
    assert.match(text, /ANNOTATION\[0\]/);
    assert.match(text, /ANNOTATION\[1\]/);
    // Derived block must come BEFORE the first ANNOTATION line
    const derivedIdx = text.indexOf('LIST EXTRACTION PATTERN');
    const firstAnno = text.indexOf('ANNOTATION[0]');
    assert.ok(derivedIdx < firstAnno, 'derived block before per-annotation lines');
  });

  it('emits $clickInList template when expand annotations present', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.x', selector: 'div[role="article"] a' },
      { type: 'click', purpose: 'expand', selector: 'div[role="article"]:nth-of-type(1) button.expand' },
    ];
    const text = buildAnnotationsText(annos);
    assert.match(text, /\$clickInList\('div\[role="article"\]', 'button\.expand'/);
  });

  it('emits NO derived block when annotations have no dotted outputField', () => {
    const annos = [
      { type: 'extract', outputField: 'title', selector: 'h1' },
    ];
    const text = buildAnnotationsText(annos);
    assert.doesNotMatch(text, /LIST EXTRACTION PATTERN/);
    assert.match(text, /ANNOTATION\[0\]/);
  });

  it('regression: per-annotation lines unchanged when no pattern derived', () => {
    const annos = [
      { type: 'extract', outputField: 'title', selector: 'h1', text: 'Heading' },
    ];
    const text = buildAnnotationsText(annos);
    assert.match(text, /- ANNOTATION\[0\] type: extract/);
    assert.match(text, /text: "Heading"/);
    assert.match(text, /selector: h1/);
  });

  it('clusterAnnotationsByContainer is available as a global when wizard-utils loads', () => {
    // The wiring test: buildAnnotationsText will need clusterAnnotationsByContainer
    // to be defined as a free variable (browser globals pattern).
    assert.equal(typeof clusterAnnotationsByContainer, 'function');
  });
});

describe('buildAnnotationsText multi-sample dispatch', () => {
  it('emits ANNOTATION SAMPLES block when ≥2 samples cluster', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.title', selector: "div[aria-posinset='1'] h3",
        domPath: "div > div[aria-posinset='1'] > h3" },
      { type: 'extract', outputField: 'posts.title', selector: "div[aria-posinset='2'] h3",
        domPath: "div > div[aria-posinset='2'] > h3" },
    ];
    const text = buildAnnotationsText(annos);
    assert.match(text, /ANNOTATION SAMPLES/);
  });

  it('falls back to flat format when annotations have no domPath divergence (single sample)', () => {
    const annos = [
      { type: 'extract', outputField: 'title', selector: 'h1' },
    ];
    const text = buildAnnotationsText(annos);
    assert.doesNotMatch(text, /ANNOTATION SAMPLES/);
    assert.match(text, /ANNOTATION\[0\]/);
  });

  it('preserves LIST EXTRACTION PATTERN block for dotted-output single-sample annotations', () => {
    // Two annotations with same dotted outputField but same domPath — single
    // sample → existing flat path → LIST EXTRACTION PATTERN still emits.
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"] a' },
      { type: 'extract', outputField: 'posts.body', selector: 'div[role="article"] p' },
    ];
    const text = buildAnnotationsText(annos);
    assert.doesNotMatch(text, /ANNOTATION SAMPLES/);
    assert.match(text, /LIST EXTRACTION PATTERN/);
  });
});
