// Fix 3 for console.log 2026-08-23: services using $extractWithHover burn
// ~10s per hovered anchor (time-bounded waits, not network), so the default
// 60s ceiling deterministically kills a 5-container batch mid-pipeline.
// hoverAwareTimeoutMs raises the per-step ceiling to 120s for such services;
// max() semantics keep any existing higher config intact.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hoverAwareTimeoutMs, buildTimeoutGuidance } = require('../lib/wizard-utils');

describe('hoverAwareTimeoutMs', () => {
  it('returns the base when no step uses $extractWithHover', () => {
    const steps = [
      { id: '1', script: 'const n = await $count("div[role=article]"); return { done: n > 0 };' },
      { id: '2', script: 'const r = await $extractList("li.item", { t: "a" }); return { done: true, r };' }
    ];
    assert.equal(hoverAwareTimeoutMs(steps, 60000), 60000);
  });

  it('raises to 120000 when a step calls $extractWithHover', () => {
    const steps = [
      { id: '1', script: 'await $exists("div") ; return { done: true };' },
      { id: '2', script: 'const r = await $extractWithHover("li", {}, { hover: {} }); return { done: true, r };' }
    ];
    assert.equal(hoverAwareTimeoutMs(steps, 60000), 120000);
  });

  it('never lowers an explicit higher config', () => {
    const steps = [{ id: '1', script: 'await $extractWithHover("li", {}, {}); return { done: true };' }];
    assert.equal(hoverAwareTimeoutMs(steps, 180000), 180000);
  });

  it('handles empty/missing steps and bogus base', () => {
    assert.equal(hoverAwareTimeoutMs([], 60000), 60000);
    assert.equal(hoverAwareTimeoutMs(undefined, 0), 30000);
    assert.equal(hoverAwareTimeoutMs([{ id: '1', script: '' }], 60000), 60000);
  });
});

describe('buildTimeoutGuidance reflects the raised ceiling', () => {
  it('states 120s / 120000ms when given the hover-aware budget', () => {
    const g = buildTimeoutGuidance(120000);
    assert.match(g.text, /120s/);
    assert.match(g.text, /120000ms/);
  });
});
