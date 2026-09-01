// extension/test/grounding-gate.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractSelectorClaims, extractFilterAttributes } = require('../lib/grounding-gate');

describe('extractSelectorClaims', () => {
  it('extracts first-arg selectors from $ API calls in step scripts', () => {
    const steps = [{ id: '2', script: `
      const c = await $count("div[role='feed'] div[role='article']");
      const t = await $extract('h3.title', 'textContent');
      const w = await $wait(\`.loading\`);
      return { done: true };
    ` }];
    const claims = extractSelectorClaims(steps);
    const sels = claims.map(c => c.selector);
    assert.ok(sels.includes("div[role='feed'] div[role='article']"));
    assert.ok(sels.includes('h3.title'));
    assert.ok(sels.includes('.loading'));
    assert.ok(claims.every(c => c.stepIds.includes('2')));
  });

  it('extracts hover config keys and classifies popoverSel as dynamic', () => {
    const steps = [{ id: '4', script: `
      return $extractWithHover('div.card', fields, { anchorSel: 'a.profile', popoverSel: 'div[role="tooltip"]' });
    ` }];
    const claims = extractSelectorClaims(steps);
    const pop = claims.find(c => c.selector === 'div[role="tooltip"]');
    assert.ok(pop, 'popoverSel extracted');
    assert.equal(pop.kind, 'dynamic', 'popover mounts on hover — static count is meaningless');
    const anchor = claims.find(c => c.selector === 'a.profile');
    assert.equal(anchor.kind, 'static');
  });

  it('carries the stepId and dedupes identical claims', () => {
    const steps = [
      { id: '2', script: "await $count('div.card');" },
      { id: '3', script: "await $extract('div.card', 'id');" }
    ];
    const claims = extractSelectorClaims(steps);
    const cardClaims = claims.filter(c => c.selector === 'div.card');
    assert.equal(cardClaims.length, 1);
    assert.ok(cardClaims[0].stepIds.includes('2'));
    assert.ok(cardClaims[0].stepIds.includes('3'));
  });

  it('ignores strings that are not selector positions (urls, field names)', () => {
    const steps = [{ id: '1', script: `
      const u = 'https://example.com/page';
      const name = 'postingTime';
      return { done: $exists('.feed') };
    ` }];
    const claims = extractSelectorClaims(steps);
    const sels = claims.map(c => c.selector);
    assert.ok(!sels.includes('https://example.com/page'));
    assert.ok(!sels.includes('postingTime'));
    assert.ok(sels.includes('.feed'));
  });
});

describe('extractFilterAttributes', () => {
  it('finds attributes inside :has() and :not() pseudo-functions', () => {
    const attrs = extractFilterAttributes("div[role='feed'] article:not(:has([data-ad-rendering-role]))");
    assert.deepEqual(attrs, ['data-ad-rendering-role']);
    const attrs2 = extractFilterAttributes('div.card:has(div[data-ad-rendering-role="story_message"])');
    assert.deepEqual(attrs2, ['data-ad-rendering-role']);
  });

  it('does not flag attributes outside filter clauses', () => {
    const attrs = extractFilterAttributes('div[data-testid="card"] h3.title');
    assert.deepEqual(attrs, []);
  });
});
