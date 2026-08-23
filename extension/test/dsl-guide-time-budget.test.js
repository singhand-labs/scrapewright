// Regression for console.log 2026-08-23 (FB search wizard session), two
// generation-time knowledge gaps that burned 2 test runs + 2 autoFixes:
//
// 1. Step 4's $extractWithHover batch of 5 containers × ~10-14s/containers
//    hit the 60s per-step ceiling deterministically. The guide only said
//    "total time scales as containers × anchors" — no concrete arithmetic,
//    no batch-width ceiling.
// 2. Steps 1-2: FB search renders div[role='feed'] with 0 articles until a
//    CONTAINER-scoped scroll. The generated wait step polled passively for
//    20 iterations; autoFix v2 nudged with window-level $scrollBy (a no-op
//    when the page scrolls an inner container). Only $scrollToBottom(sel)
//    triggered the first render.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT_DSL_GUIDE } = require('../lib/wizard-utils');

describe('SCRIPT_DSL_GUIDE — hover pipeline time budget', () => {
  it('teaches the concrete per-anchor cost (timeout burn even with no popover)', () => {
    assert.match(SCRIPT_DSL_GUIDE, /HOVER PIPELINE TIME BUDGET/);
    assert.match(SCRIPT_DSL_GUIDE, /even when no popover appears/);
  });

  it('gives the containers × anchors arithmetic and a safe batch width', () => {
    assert.match(SCRIPT_DSL_GUIDE, /containers . anchors/i);
    assert.match(SCRIPT_DSL_GUIDE, /containerRange/);
  });

  it('states that $extractWithHover services get the ceiling auto-raised to 120s', () => {
    assert.match(SCRIPT_DSL_GUIDE, /extractWithHover[\s\S]{0,200}120s|120s[\s\S]{0,200}extractWithHover/);
  });
});

describe('SCRIPT_DSL_GUIDE — first content needs a scroll', () => {
  it('warns that a present container with 0 items means viewport-gated rendering', () => {
    assert.match(SCRIPT_DSL_GUIDE, /FIRST CONTENT MAY NEED A SCROLL/);
    assert.match(SCRIPT_DSL_GUIDE, /0 items/);
  });

  it('forbids passive polling and window-level $scrollBy nudges for this case', () => {
    assert.match(SCRIPT_DSL_GUIDE, /window-level \$scrollBy/);
    assert.match(SCRIPT_DSL_GUIDE, /no-op/);
  });

  it('teaches the container-scoped nudge inside the poll step', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\$scrollToBottom\('div\[role="feed"\]'\)/);
  });
});
