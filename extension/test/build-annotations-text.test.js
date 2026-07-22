const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// list-pattern.js defines deriveListPattern, which buildAnnotationsText calls.
// Load it first so the function is defined as a global when wizard-utils loads.
require('../lib/list-pattern');
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
});
