// Regression for bugx.log 2026-07-24: $scrollToBottom did a one-shot
// scrollTo(0, scrollHeight) that overshot FB's IntersectionObserver trigger
// zone and "stuck" the page at 6 articles. The fix splits the algorithm into
// a pure helper that increments scroll position, probes for scrollHeight
// growth, and returns a structured result the caller can branch on.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scrollToBottomIncremental } = require('../lib/scroll-ops');

// Minimal fake root that emulates the scroll-related properties/behaviors
// scrollToBottomIncremental touches. Grows scrollHeight on each scrollBy to
// simulate a lazy loader appending content.
function makeFakeRoot({ initialHeight = 1000, clientHeight = 500, growPerScroll = 600, maxScrolls = 0 }) {
  let scrollTop = 0;
  let scrollHeight = initialHeight;
  let scrollCount = 0;
  return {
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = Math.max(0, Math.min(v, scrollHeight - clientHeight)); },
    get scrollHeight() { return scrollHeight; },
    clientHeight,
    scrollBy(dx, dy) {
      scrollCount += 1;
      if (maxScrolls > 0 && scrollCount > maxScrolls) return;
      if (growPerScroll > 0 && scrollHeight < initialHeight + growPerScroll * 10) {
        scrollHeight += growPerScroll;
      }
      scrollTop = Math.max(0, Math.min(scrollTop + dy, scrollHeight - clientHeight));
    },
    scrollTo(x, y) {
      scrollTop = Math.max(0, Math.min(y, scrollHeight - clientHeight));
    }
  };
}

// sleep() that resolves immediately — the loop's wait is irrelevant for
// correctness tests; we only care about the scroll/growth accounting.
const noSleep = () => Promise.resolve();

describe('scrollToBottomIncremental — growth-probe loop', () => {
  it('scrolls in increments of ~0.85 * clientHeight (not one-shot)', async () => {
    const calls = [];
    const root = makeFakeRoot({ initialHeight: 3000, clientHeight: 500, growPerScroll: 0 });
    const origScrollBy = root.scrollBy.bind(root);
    root.scrollBy = (dx, dy) => { calls.push(dy); origScrollBy(dx, dy); };
    await scrollToBottomIncremental(root, { sleep: noSleep, maxAttempts: 3, noProgressLimit: 3 });
    // Each increment must be ~0.85 * 500 = 425, not a single jump to scrollHeight.
    assert.ok(calls.length >= 1, 'expected at least one scrollBy call');
    for (const dy of calls) {
      assert.ok(dy <= 450, `scrollBy delta ${dy} exceeded clientHeight*0.85 (one-shot regression)`);
    }
  });

  it('continues while scrollHeight grows (resets noProgress counter)', async () => {
    const root = makeFakeRoot({ initialHeight: 1000, clientHeight: 500, growPerScroll: 700 });
    const res = await scrollToBottomIncremental(root, { sleep: noSleep, maxAttempts: 10, noProgressLimit: 3 });
    // Growing content → not stalled.
    assert.equal(res.stalled, false);
    assert.ok(res.attempts >= 1);
    assert.ok(res.newScrollHeight > res.prevScrollHeight, 'expected scrollHeight to grow');
  });

  it('declares stalled after N consecutive no-progress scrolls', async () => {
    // No growth, no scroll movement possible (scrollHeight-clientHeight == 0).
    const root = makeFakeRoot({ initialHeight: 500, clientHeight: 500, growPerScroll: 0 });
    const res = await scrollToBottomIncremental(root, { sleep: noSleep, maxAttempts: 8, noProgressLimit: 3 });
    assert.equal(res.stalled, true);
    assert.equal(res.attempts, 3, 'expected stall to trigger exactly at noProgressLimit=3');
  });

  it('returns the documented shape (scrolled, prevY, newY, prevScrollHeight, newScrollHeight, scrollRoot, stalled, attempts)', async () => {
    const root = makeFakeRoot({ initialHeight: 2000, clientHeight: 500, growPerScroll: 0 });
    const res = await scrollToBottomIncremental(root, { sleep: noSleep, maxAttempts: 3, noProgressLimit: 3 });
    for (const k of ['scrolled', 'prevY', 'newY', 'prevScrollHeight', 'newScrollHeight', 'scrollRoot', 'stalled', 'attempts']) {
      assert.ok(k in res, `missing field "${k}" in result`);
    }
    assert.equal(res.scrollRoot, 'window');
  });

  it('scrolled:true iff position changed', async () => {
    const root = makeFakeRoot({ initialHeight: 2000, clientHeight: 500, growPerScroll: 0 });
    const res = await scrollToBottomIncremental(root, { sleep: noSleep, maxAttempts: 3, noProgressLimit: 3 });
    assert.equal(res.scrolled, res.newY !== res.prevY);
  });

  it('falls back to direct scrollTop mutation when root has no scrollBy method', async () => {
    // Defensive branch: some element-likes expose scrollTop but not scrollBy.
    // The helper must still make progress via the setter.
    const calls = [];
    const fakeRoot = {
      _y: 0,
      get scrollTop() { return this._y; },
      set scrollTop(v) { this._y = v; calls.push(v); },
      scrollHeight: 3000,
      clientHeight: 500
      // No scrollBy method.
    };
    const res = await scrollToBottomIncremental(fakeRoot, { sleep: noSleep, maxAttempts: 2, noProgressLimit: 5 });
    assert.ok(calls.length >= 1, 'expected setter to be invoked at least once');
    assert.ok(res.newY > 0, 'expected scroll position to advance via setter');
  });

  it('skips sleep entirely when settleMs is 0', async () => {
    let sleepCalls = 0;
    const sleep = () => { sleepCalls += 1; return Promise.resolve(); };
    const root = makeFakeRoot({ initialHeight: 3000, clientHeight: 500, growPerScroll: 0 });
    await scrollToBottomIncremental(root, { sleep, maxAttempts: 3, noProgressLimit: 3, settleMs: 0 });
    assert.equal(sleepCalls, 0, 'sleep must not be invoked when settleMs is 0');
  });
});
