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

// Fake root that stalls on scrollBy (no growth, no position movement) but
// whose scrollHeight can be mutated externally (by the fallback) to simulate
// "trusted wheel triggered lazy-load". Default initialHeight>clientHeight so
// the root HAS overflow — without that, the no-overflow early-exit fires
// before the loop ever invokes the fallback.
function makeStallingRoot({ initialHeight = 5000, clientHeight = 500 } = {}) {
  let scrollTop = 0;
  let scrollHeight = initialHeight;
  return {
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = v; },
    get scrollHeight() { return scrollHeight; },
    set scrollHeight(v) { scrollHeight = v; },
    clientHeight,
    scrollBy() { /* intentionally no-op — simulates a stalled page */ },
    scrollTo() {}
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
    // Root HAS overflow (scrollHeight>clientHeight) but scrollBy is a no-op,
    // so position never changes and height never grows. After noProgressLimit
    // iters of this, the loop declares stall. (Using makeFakeRoot with
    // initialHeight==clientHeight no longer works after the RC19 follow-up
    // early-exit, which correctly treats that as "no overflow, skip loop".)
    const root = makeStallingRoot({ initialHeight: 5000, clientHeight: 500 });
    const res = await scrollToBottomIncremental(root, { sleep: noSleep, maxAttempts: 8, noProgressLimit: 3 });
    assert.equal(res.stalled, true);
    assert.equal(res.attempts, 3, 'expected stall to trigger exactly at noProgressLimit=3');
  });

  it('RC19 follow-up (2026-07-29): no-overflow root exits immediately without invoking fallback', async () => {
    // The documented FB case: LLM picks div[role=main] whose clientHeight ===
    // scrollHeight (no overflow). Spinning the loop would only delayed-stall,
    // and worse, the stall would invoke trustedWheelFallback — which for
    // background tabs hangs ~60s on a CDP sendCommand that never calls back.
    // The early-exit returns immediately so the caller's inner-container
    // probe can find the real scroll root.
    let fallbackCalls = 0;
    const root = makeStallingRoot({ initialHeight: 500, clientHeight: 500 });
    const res = await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 8,
      noProgressLimit: 3,
      trustedWheelFallback: async () => { fallbackCalls += 1; return { dispatched: false }; }
    });
    assert.equal(res.noOverflow, true, 'no-overflow root must be flagged as such');
    assert.equal(res.scrolled, false);
    assert.equal(res.stalled, true);
    assert.equal(res.attempts, 0, 'no-overflow root must not enter the loop');
    assert.equal(fallbackCalls, 0, 'trustedWheelFallback must NEVER fire on a no-overflow root');
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

// ============================================================================
// RC19 (console.log 2026-07-28): trustedWheelFallback — when programmatic
// scrollBy stalls, the loop calls opts.trustedWheelFallback once before
// giving up. If the fallback reports dispatched:true, noProgress resets and
// the loop continues — giving OS-level wheel events a chance to trigger the
// page's lazy-load loader.
// ============================================================================

describe('scrollToBottomIncremental — trustedWheelFallback (RC19)', () => {
  // makeStallingRoot is now at module scope so the growth-probe describe
  // block can also use it for the "declares stalled" test.

  it('calls trustedWheelFallback once when stalled, before giving up', async () => {
    let fallbackCalls = 0;
    const root = makeStallingRoot();
    await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 10,
      noProgressLimit: 3,
      trustedWheelFallback: async () => { fallbackCalls += 1; return { dispatched: false }; }
    });
    assert.equal(fallbackCalls, 1, 'fallback must be called exactly once when stalled (default maxAttempts=3)');
  });

  it('resets noProgress and continues when fallback returns dispatched:true', async () => {
    // Simulate: trusted wheel triggers lazy-load → scrollHeight grows on the
    // next scrollBy → loop continues past the original stall point.
    let fallbackCalls = 0;
    const root = makeStallingRoot();
    // After fallback fires, mutate the root so the next scrollBy attempt
    // reports growth (heightGrew=true) — exactly what FB does after a real
    // wheel event triggers the loader.
    const fallback = async () => {
      fallbackCalls += 1;
      if (fallbackCalls === 1) {
        root.scrollHeight = 5000;  // simulate lazy-load adding content
        return { dispatched: true };
      }
      return { dispatched: false };
    };
    const res = await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 10,
      noProgressLimit: 3,
      maxTrustedWheelAttempts: 1,  // cap at 1 so a second stall doesn't re-invoke
      trustedWheelFallback: fallback
    });
    assert.ok(fallbackCalls >= 1, 'fallback must fire');
    assert.equal(res.trustedWheelAttempts, 1);
    assert.ok(res.newScrollHeight === 5000, 'expected scrollHeight growth to be observed after fallback');
  });

  it('respects maxTrustedWheelAttempts cap (default 3)', async () => {
    let fallbackCalls = 0;
    const root = makeStallingRoot();
    await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 50,    // plenty of room — only maxTrustedWheelAttempts caps us
      noProgressLimit: 3,
      trustedWheelFallback: async () => {
        fallbackCalls += 1;
        return { dispatched: true };  // claim success every time, but never grow
      }
    });
    assert.equal(fallbackCalls, 3, 'default maxTrustedWheelAttempts=3 must cap fallback invocations');
  });

  it('result includes trustedWheelAttempts when fallback provided', async () => {
    const root = makeStallingRoot();
    const res = await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 5,
      noProgressLimit: 3,
      trustedWheelFallback: async () => ({ dispatched: false })
    });
    assert.equal(typeof res.trustedWheelAttempts, 'number');
    assert.equal(res.trustedWheelAttempts, 1);
  });

  it('result omits trustedWheelAttempts when no fallback provided (backward compat)', async () => {
    const root = makeFakeRoot({ initialHeight: 5000, clientHeight: 500, growPerScroll: 0 });
    const res = await scrollToBottomIncremental(root, { sleep: noSleep, maxAttempts: 5, noProgressLimit: 3 });
    assert.equal(res.trustedWheelAttempts, undefined,
      'must not include trustedWheelAttempts when no fallback was provided — preserves pre-RC19 shape');
  });

  it('fallback receives { deltaY, attempt, scrollRoot } info', async () => {
    const seen = [];
    const root = makeStallingRoot();
    await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 5,
      noProgressLimit: 3,
      scrollRootLabel: 'inner',
      trustedWheelFallback: async (info) => {
        seen.push(info);
        return { dispatched: false };
      }
    });
    assert.equal(seen.length, 1);
    assert.equal(typeof seen[0].deltaY, 'number');
    assert.equal(seen[0].attempt, 1);
    assert.equal(seen[0].scrollRoot, 'inner');
  });

  it('catches fallback throws and treats them as dispatched:false', async () => {
    const root = makeStallingRoot();
    const res = await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 5,
      noProgressLimit: 3,
      trustedWheelFallback: async () => { throw new Error('network blew up'); }
    });
    assert.equal(res.stalled, true, 'thrown fallback must not crash the loop — treat as failed and break');
    assert.equal(res.trustedWheelAttempts, 1);
  });

  it('falls back to give-up behavior when Enhanced Mode off (dispatched:false)', async () => {
    // Simulate background returning dispatched:false because Enhanced Mode
    // flag is unset. The loop must break normally — same as pre-RC19 behavior.
    const root = makeStallingRoot();
    const res = await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 5,
      noProgressLimit: 3,
      trustedWheelFallback: async () => ({ dispatched: false, reason: 'debugger permission not granted' })
    });
    assert.equal(res.stalled, true);
    assert.equal(res.attempts, 3, 'must break at noProgressLimit=3 when fallback declines');
  });
});

// ============================================================================
// RC21 (2026-08-03): condition-based stall detection — fix for "scroll loop
// gives up before content arrives" (console.log 2026-08-03 10:52:44–46).
//
// Symptom: FB search scrape. RC20 tab-activation worked (frame production
// happened, IO fired once at iter 0 — height grew 2327→2434). But iters 1-4
// saw no further growth within the 350ms settle window. After 3 consecutive
// no-progress iters, the loop declared stalled and gave up. THEN the script's
// post-loop `await setTimeout(2000)` caught 5 more articles arriving — i.e.
// FB's network pipeline needed ~2s but the loop only waited ~1s.
//
// Fix: keep noProgressLimit (count-based, backward compat) AND add a parallel
// time-based signal — stallWindowMs (default 3000). Trigger stall when EITHER
// fires. Track lastGrowTime via injectable now() so tests can simulate wall
// clock. After trusted-wheel dispatched:true, reset BOTH counters.
// ============================================================================

describe('scrollToBottomIncremental — RC21 condition-based stall (stallWindowMs)', () => {
  // Fake clock helpers: tests need to simulate wall-clock advancing across
  // settle waits. now() returns current fake time; sleep(ms) advances it.
  function makeFakeClock() {
    let t = 1000;
    return {
      now: () => t,
      sleep: (ms) => { t += ms; return Promise.resolve(); }
    };
  }

  it('declares stalled via stallWindowMs even when noProgressLimit is large', async () => {
    // stallWindowMs=1000 with settleMs=200 should fire at iter ~5, not at
    // noProgressLimit=99 (which would never fire).
    const clock = makeFakeClock();
    const root = makeStallingRoot();
    const res = await scrollToBottomIncremental(root, {
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 50,
      noProgressLimit: 99,        // very high — count-based won't trigger
      stallWindowMs: 1000,
      settleMs: 200
    });
    assert.equal(res.stalled, true);
    assert.equal(res.stallReason, 'stall_window_elapsed');
    // ~5 iters at 200ms each to exceed 1000ms. Exact iter count isn't the
    // contract — just that it fires before maxAttempts and well below 99.
    assert.ok(res.attempts <= 8, 'time-based stall must fire before count-based, got ' + res.attempts);
  });

  it('does NOT stall while height keeps growing (resets lastGrowTime each growth)', async () => {
    // Each scrollBy grows height by 600. With stallWindowMs=500, the loop
    // must NOT stall because heightGrew resets lastGrowTime every iter.
    const clock = makeFakeClock();
    const root = makeFakeRoot({ initialHeight: 1000, clientHeight: 500, growPerScroll: 600 });
    const res = await scrollToBottomIncremental(root, {
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 5,
      stallWindowMs: 500,
      settleMs: 200
    });
    assert.equal(res.stalled, false, 'must not stall while content keeps arriving');
    assert.equal(res.attempts, 5, 'must exhaust maxAttempts (5) — every iter grew');
  });

  it('stall fires AFTER content stops growing, not before', async () => {
    // Scenario: height grows for first 2 iters, then stops. Stall window
    // must measure from the LAST growth, not from loop start.
    const clock = makeFakeClock();
    const root = makeFakeRoot({ initialHeight: 1000, clientHeight: 500, growPerScroll: 600, maxScrolls: 2 });
    const res = await scrollToBottomIncremental(root, {
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 30,
      stallWindowMs: 1000,
      settleMs: 200
    });
    assert.equal(res.stalled, true);
    // After 2 successful growthes (iters 0,1), height stops growing at iter 2.
    // lastGrowTime updates at iter 1 end. Stall window elapses ~5 iters later.
    assert.ok(res.attempts >= 5 && res.attempts <= 10,
      'expected stall ~5-10 iters after last growth, got ' + res.attempts);
  });

  it('onIter reports timeSinceGrowMs for diagnostics', async () => {
    const clock = makeFakeClock();
    const root = makeStallingRoot();
    const reports = [];
    await scrollToBottomIncremental(root, {
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 4,
      noProgressLimit: 99,
      stallWindowMs: 10000,  // large — don't actually stall
      settleMs: 250,
      onIter: (r) => reports.push(r)
    });
    assert.ok(reports.length > 0);
    assert.equal(typeof reports[0].timeSinceGrowMs, 'number');
    assert.equal(typeof reports[0].stallWindowMs, 'number');
    // timeSinceGrowMs should grow monotonically since no growth happens.
    assert.ok(reports[reports.length - 1].timeSinceGrowMs > reports[0].timeSinceGrowMs,
      'timeSinceGrowMs must advance across iters');
  });

  it('trusted-wheel success resets BOTH noProgress AND lastGrowTime', async () => {
    // Scenario: stall fires (count-based, noProgressLimit=3). Fallback
    // returns dispatched:true. After reset, loop must continue and not
    // immediately stall again on the next iter via time-based signal.
    const clock = makeFakeClock();
    const root = makeStallingRoot();
    let fallbackCalls = 0;
    const res = await scrollToBottomIncremental(root, {
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 50,
      noProgressLimit: 3,
      stallWindowMs: 500,
      settleMs: 100,
      maxTrustedWheelAttempts: 1,
      trustedWheelFallback: async () => {
        fallbackCalls += 1;
        // mutate root so next scrollBy reports growth — gives the reset a
        // chance to actually take effect (lastGrowTime updates again).
        if (fallbackCalls === 1) {
          root.scrollHeight = 8000;
          return { dispatched: true };
        }
        return { dispatched: false };
      }
    });
    assert.equal(fallbackCalls, 1, 'fallback must fire exactly once');
    assert.equal(res.trustedWheelAttempts, 1);
    assert.ok(res.newScrollHeight === 8000, 'post-fallback growth must be observed');
  });

  it('default stallWindowMs is 3000ms (matches RC21 design)', async () => {
    // Just verify the default is exposed in the result so callers can see it.
    const root = makeFakeRoot({ initialHeight: 1000, clientHeight: 500, growPerScroll: 0, maxScrolls: 0 });
    const res = await scrollToBottomIncremental(root, {
      sleep: noSleep,
      maxAttempts: 1,
      noProgressLimit: 99
    });
    assert.equal(res.stallWindowMs, 3000);
  });
});

const { findScrollableContainer } = require('../lib/scroll-ops');

function makeFakeElement({ scrollHeight = 0, clientHeight = 0, overflowY = 'auto', tag = 'div' }) {
  return {
    tagName: tag.toUpperCase(),
    scrollHeight: scrollHeight,
    clientHeight: clientHeight,
    style: {},
    _computedOverflowY: overflowY,
    // No methods needed — findScrollableContainer only reads properties.
  };
}

describe('findScrollableContainer', () => {
  it('returns null when no element has overflowY auto/scroll AND scrollHeight > clientHeight * 1.5', () => {
    const doc = {
      querySelectorAll: () => [
        makeFakeElement({ scrollHeight: 100, clientHeight: 90, overflowY: 'auto' }),    // ratio too small
        makeFakeElement({ scrollHeight: 100, clientHeight: 90, overflowY: 'visible' })  // not scrollable
      ],
      defaultView: { getComputedStyle: () => ({ overflowY: 'visible' }) }
    };
    assert.equal(findScrollableContainer(doc), null);
  });

  it('returns the element with the largest scrollHeight among scrollable candidates', () => {
    const small = makeFakeElement({ scrollHeight: 1000, clientHeight: 400, overflowY: 'auto' });
    const big = makeFakeElement({ scrollHeight: 5000, clientHeight: 400, overflowY: 'scroll' });
    const nonScrollable = makeFakeElement({ scrollHeight: 9999, clientHeight: 400, overflowY: 'hidden' });
    const doc = {
      querySelectorAll: () => [small, big, nonScrollable],
      defaultView: { getComputedStyle: (el) => ({ overflowY: el._computedOverflowY }) }
    };
    assert.equal(findScrollableContainer(doc), big);
  });

  it('skips elements whose scrollHeight is not at least 1.5x clientHeight', () => {
    const borderline = makeFakeElement({ scrollHeight: 600, clientHeight: 400, overflowY: 'auto' }); // 1.5x exactly — should NOT qualify
    const doc = {
      querySelectorAll: () => [borderline],
      defaultView: { getComputedStyle: (el) => ({ overflowY: el._computedOverflowY }) }
    };
    assert.equal(findScrollableContainer(doc), null);
  });

  it('returns null when doc has no defaultView (defensive)', () => {
    const doc = {
      querySelectorAll: () => [makeFakeElement({ scrollHeight: 5000, clientHeight: 400, overflowY: 'auto' })],
      defaultView: null
    };
    assert.equal(findScrollableContainer(doc), null);
  });
});
