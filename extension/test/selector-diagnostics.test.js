// Regression for bugx.log 2026-07-24: autoFix prompt had no empirical
// selector-match data, so the LLM iterated blindly on FB publishTime
// (proposed `:not([href*="facebook.com/"])` — excluded the timestamp
// link itself). These pure helpers compute the diagnostics that will
// flow through DOM_RESPONSE → sandbox → EXECUTE_RESULT → STEP_ITERATION
// → summarizeAllStepDiagnostics → autoFix prompt.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeExtractListDiagnostics,
  computeSimpleSelectorDiagnostics
} = require('../lib/list-extract-ops');

function makeEl({ text = '', href = null, attrs = {} } = {}) {
  const el = {
    textContent: text,
    getAttribute: (name) => (name in attrs ? attrs[name] : (name === 'href' ? href : null))
  };
  return el;
}

function makeContainer(childrenByField) {
  // childrenByField: { fieldName: element|null }
  return {
    querySelector: () => null,  // overridden per-field via the spec map in test
    _childrenByField: childrenByField
  };
}

// Helper that returns a fake container whose querySelector(subSel) returns
// the element bound to that subSel string.
function makeFakeContainer(bindings) {
  // bindings: { subSelectorString: element|null }
  return {
    querySelector: (sel) => (sel in bindings ? bindings[sel] : null)
  };
}

describe('computeExtractListDiagnostics', () => {
  it('returns container count + per-field match count + 3 sample texts/hrefs', () => {
    const containers = [
      makeFakeContainer({
        'h3 a': makeEl({ text: 'Alice', href: '/alice' }),
        'a.time': makeEl({ text: '5分钟', href: '/posts/1' })
      }),
      makeFakeContainer({
        'h3 a': makeEl({ text: 'Bob', href: '/bob' }),
        'a.time': makeEl({ text: '6分钟', href: '/posts/2' })
      }),
      makeFakeContainer({
        'h3 a': makeEl({ text: 'Carol', href: '/carol' }),
        'a.time': makeEl({ text: '7分钟', href: '/posts/3' })
      }),
      makeFakeContainer({
        'h3 a': makeEl({ text: 'Dave', href: '/dave' }),
        'a.time': null  // publishTime missing on 4th post
      })
    ];
    const fieldMap = { author: 'h3 a', publishTime: 'a.time' };
    const diag = computeExtractListDiagnostics(containers, fieldMap, 'div[role="article"]');

    assert.equal(diag.api, 'extractList');
    assert.equal(diag.containerSelector, 'div[role="article"]');
    assert.equal(diag.containerMatches, 4);

    const author = diag.perField.find(f => f.field === 'author');
    assert.equal(author.matchCount, 4);
    assert.deepEqual(author.sampleTexts, ['Alice', 'Bob', 'Carol']);
    assert.deepEqual(author.sampleHrefs, ['/alice', '/bob', '/carol']);

    const time = diag.perField.find(f => f.field === 'publishTime');
    assert.equal(time.matchCount, 3);  // 4th container had null
    assert.deepEqual(time.sampleTexts, ['5分钟', '6分钟', '7分钟']);
    assert.deepEqual(time.sampleHrefs, ['/posts/1', '/posts/2', '/posts/3']);
  });

  it('caps sample arrays at 3 elements', () => {
    const containers = [];
    for (let i = 0; i < 10; i++) {
      containers.push(makeFakeContainer({ 'a.x': makeEl({ text: 't' + i, href: '/h' + i }) }));
    }
    const diag = computeExtractListDiagnostics(containers, { f: 'a.x' }, 'c');
    const f = diag.perField[0];
    assert.equal(f.matchCount, 10);
    assert.equal(f.sampleTexts.length, 3);
    assert.equal(f.sampleHrefs.length, 3);
  });

  it('truncates sample text to 80 chars and href to 120 chars', () => {
    const longText = 'x'.repeat(200);
    const longHref = '/'.repeat(200);
    const containers = [makeFakeContainer({ 'a.x': makeEl({ text: longText, href: longHref }) })];
    const diag = computeExtractListDiagnostics(containers, { f: 'a.x' }, 'c');
    const f = diag.perField[0];
    assert.equal(f.sampleTexts[0].length, 80);
    assert.equal(f.sampleHrefs[0].length, 120);
  });

  it('respects attr spec — no href sample when attr is set', () => {
    const containers = [makeFakeContainer({
      'a.x': makeEl({ text: 'hello', href: '/ignore', attrs: { 'data-id': '42' } })
    })];
    const fieldMap = { f: { selector: 'a.x', attr: 'data-id' } };
    const diag = computeExtractListDiagnostics(containers, fieldMap, 'c');
    const f = diag.perField[0];
    assert.equal(f.attr, 'data-id');
    assert.deepEqual(f.sampleTexts, []);  // no text sample when attr is read
    assert.deepEqual(f.sampleHrefs, []);  // no href sample when attr is set
  });

  it('handles empty containers array (allowEmpty=true case)', () => {
    const diag = computeExtractListDiagnostics([], { f: 'a.x' }, 'c');
    assert.equal(diag.containerMatches, 0);
    assert.equal(diag.perField.length, 1);
    assert.equal(diag.perField[0].matchCount, 0);
    assert.deepEqual(diag.perField[0].sampleTexts, []);
  });

  it('handles missing fieldMap gracefully', () => {
    const diag = computeExtractListDiagnostics([], null, 'c');
    assert.equal(diag.perField.length, 0);
  });
});

describe('computeSimpleSelectorDiagnostics', () => {
  it('returns matchCount + 3 sample texts/hrefs for $list-style call', () => {
    const els = [
      makeEl({ text: 'one', href: '/1' }),
      makeEl({ text: 'two', href: '/2' }),
      makeEl({ text: 'three', href: '/3' }),
      makeEl({ text: 'four', href: '/4' })
    ];
    const diag = computeSimpleSelectorDiagnostics(els, 'a.foo');
    assert.equal(diag.api, 'list');
    assert.equal(diag.selector, 'a.foo');
    assert.equal(diag.matchCount, 4);
    assert.deepEqual(diag.sampleTexts, ['one', 'two', 'three']);
    assert.deepEqual(diag.sampleHrefs, ['/1', '/2', '/3']);
  });

  it('for $extract (single element) returns 0-or-1 matchCount', () => {
    const el = makeEl({ text: 'only', href: '/x' });
    const diag = computeSimpleSelectorDiagnostics([el], 'h1', 'extract');
    assert.equal(diag.api, 'extract');
    assert.equal(diag.matchCount, 1);
    assert.deepEqual(diag.sampleTexts, ['only']);
  });

  it('for $count returns only matchCount (no samples)', () => {
    const els = [makeEl(), makeEl(), makeEl()];
    const diag = computeSimpleSelectorDiagnostics(els, 'div.x', 'count');
    assert.equal(diag.api, 'count');
    assert.equal(diag.matchCount, 3);
    assert.deepEqual(diag.sampleTexts, []);
    assert.deepEqual(diag.sampleHrefs, []);
  });

  it('empty matches array produces matchCount 0 + empty samples', () => {
    const diag = computeSimpleSelectorDiagnostics([], 'a.x');
    assert.equal(diag.matchCount, 0);
    assert.deepEqual(diag.sampleTexts, []);
  });
});
