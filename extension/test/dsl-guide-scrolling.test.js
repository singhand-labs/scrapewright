// Regression for bugx.log 2026-07-24: step 2's script had dead scroll code
// because the DSL guide never mentioned any scroll function. The LLM knew
// scrolling was needed (it wrote `if (scrollable)`) but had no API to call
// inside the branch. These tests verify the SCROLLING section now teaches
// the LLM about $scrollBy / $scrollToBottom / $scrollIntoView and the
// poll-load pattern that terminates when the position stops changing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT_DSL_GUIDE } = require('../lib/wizard-utils');

describe('SCRIPT_DSL_GUIDE — scrolling section', () => {
  it('lists $scrollBy / $scrollToBottom / $scrollIntoView in AVAILABLE API FUNCTIONS', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\$scrollBy\(deltaY/);
    assert.match(SCRIPT_DSL_GUIDE, /\$scrollToBottom\(selector\?\)/);
    assert.match(SCRIPT_DSL_GUIDE, /\$scrollIntoView\(selector\)/);
  });

  it('has a dedicated SCROLLING section', () => {
    assert.match(SCRIPT_DSL_GUIDE, /SCROLLING \(infinite feeds/);
  });

  it('documents the return shape { scrolled, prevY, newY }', () => {
    assert.match(SCRIPT_DSL_GUIDE, /scrolled: bool/);
    assert.match(SCRIPT_DSL_GUIDE, /prevY/);
    assert.match(SCRIPT_DSL_GUIDE, /newY/);
  });

  it('documents the POLL-LOAD PATTERN (scroll until exhausted loop)', () => {
    assert.match(SCRIPT_DSL_GUIDE, /POLL-LOAD PATTERN/);
    // The pattern must use maxIterations>1 + return { done: false } — the
    // canonical poll-step shape. Without this guidance, the LLM emits
    // single-shot scrolls that don't iterate.
    assert.match(SCRIPT_DSL_GUIDE, /maxIterations:\s*20/);
    assert.match(SCRIPT_DSL_GUIDE, /return \{ done: false, postCount \}/);
  });

  it('names position-unchanged as the only reliable exhausted-feed signal', () => {
    // bugx.log: the LLM declared "exhausted" after one batch with no scroll
    // ever happening. The fix is to teach it that r.scrolled === false is
    // THE signal, not a post-count heuristic.
    assert.match(SCRIPT_DSL_GUIDE, /position did not change/);
    assert.match(SCRIPT_DSL_GUIDE, /r\.scrolled === false/);
  });

  it('mentions the scroll-container case (inner overflow:auto elements)', () => {
    // Facebook uses window scroll, but Twitter / LinkedIn / gov sites often
    // scroll an inner element. The LLM must know to try the container
    // selector when window-scroll yields nothing.
    assert.match(SCRIPT_DSL_GUIDE, /SCROLL CONTAINER/);
    assert.match(SCRIPT_DSL_GUIDE, /overflow:auto\/scroll/);
  });

  it('ties $scrollIntoView to the "reveal See more / Load more" use case', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\$scrollIntoView/);
    assert.match(SCRIPT_DSL_GUIDE, /See more/i);
  });
});
