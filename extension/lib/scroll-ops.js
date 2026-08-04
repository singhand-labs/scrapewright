// extension/lib/scroll-ops.js
//
// Pure helpers for the scroll DSL ($scrollBy / $scrollToBottom /
// $scrollIntoView). content-script.js wraps these with element resolution and
// debug logging to produce the dom* functions invoked from sandbox.js.
//
// Extracted from content-script.js as part of the 2026-07-24 fix for
// bugx.log: the old domScrollToBottom did a one-shot scrollTo(0, scrollHeight)
// which overshot lazy-load (IntersectionObserver) trigger zones on Facebook,
// leaving the page stuck at 6 articles. The new algorithm increments the
// scroll position, watches scrollHeight for growth, and declares "stalled"
// only after N consecutive no-progress attempts.

var SCROLL_INCREMENT_RATIO = 0.85;   // fraction of clientHeight per scrollBy
var DEFAULT_MAX_ATTEMPTS = 15;        // hard cap on scrollBy calls per invocation (was 8; bumped RC21 to give stallWindowMs room to fire)
var DEFAULT_NO_PROGRESS_LIMIT = 3;   // consecutive no-growth + no-position-change attempts before stalled (legacy count-based signal)
var DEFAULT_SETTLE_MS = 350;         // wait between scrollBy calls for lazy-load to fire
var DEFAULT_STALL_WINDOW_MS = 3000;  // RC21: declare stalled if scrollHeight hasn't grown for this duration (primary signal)
var DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS = 3;  // RC19: caps trusted-wheel nudges per invocation

function defaultSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function defaultNow() {
  return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
}

// scrollToBottomIncremental(root, opts) → { scrolled, prevY, newY,
//   prevScrollHeight, newScrollHeight, scrollRoot, stalled, stallReason?,
//   attempts, stallWindowMs, trustedWheelAttempts? }
//
// root: an element-like with scrollTop (get/set), scrollHeight (get),
//   clientHeight (get), and scrollBy(dx, dy) / scrollTo(x, y) methods.
// opts: { sleep?, now?, maxAttempts?, noProgressLimit?, settleMs?,
//         stallWindowMs?, scrollRootLabel?, trustedWheelFallback?,
//         maxTrustedWheelAttempts? }
//   All optional. sleep defaults to setTimeout-based; pass `() => Promise.resolve()`
//   in tests to skip waits. now defaults to Date.now; pass a fake in tests
//   to control wall-clock advancement independently of sleep.
//
// RC19 (console.log 2026-07-28): when programmatic scrollBy stalls and
// opts.trustedWheelFallback is provided, the loop calls it once per stall
// event (up to maxTrustedWheelAttempts) before giving up. The fallback
// should dispatch a trusted wheel event via CDP Input.dispatchMouseEvent
// (see renderer-activation.js). If the fallback returns {dispatched:true},
// we reset noProgress and continue the loop — giving the OS-level wheel
// event a chance to trip the page's lazy-load loader (which often filters
// on event.isTrusted, ignoring JS-only scroll). Generic mechanism — works
// for any isTrusted-gated loader, no site-specific assumptions.
//
// RC21 (console.log 2026-08-03): dual-signal stall detection. The legacy
// count-based signal (noProgressLimit consecutive no-progress iters) was
// too aggressive — FB's network pipeline needs ~2s to deliver new content
// after a scroll, but 3 × 350ms settle = 1050ms triggered stall before
// content arrived. Added a parallel time-based signal (stallWindowMs of
// no height growth). Trigger stall when EITHER fires. After trusted-wheel
// dispatched:true, reset BOTH counters. The count-based signal is kept as
// backward-compat for callers that pass noProgressLimit explicitly.
function scrollToBottomIncremental(root, opts) {
  opts = opts || {};
  var sleep = opts.sleep || defaultSleep;
  var now = opts.now || defaultNow;
  var maxAttempts = (typeof opts.maxAttempts === 'number') ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  var noProgressLimit = (typeof opts.noProgressLimit === 'number') ? opts.noProgressLimit : DEFAULT_NO_PROGRESS_LIMIT;
  var settleMs = (typeof opts.settleMs === 'number') ? opts.settleMs : DEFAULT_SETTLE_MS;
  var stallWindowMs = (typeof opts.stallWindowMs === 'number') ? opts.stallWindowMs : DEFAULT_STALL_WINDOW_MS;
  var scrollRootLabel = opts.scrollRootLabel || 'window';
  var trustedWheelFallback = (typeof opts.trustedWheelFallback === 'function') ? opts.trustedWheelFallback : null;
  var maxTrustedWheelAttempts = (typeof opts.maxTrustedWheelAttempts === 'number')
    ? opts.maxTrustedWheelAttempts : DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS;
  // RC19 follow-up: per-iteration progress reporter. Caller may pass a
  // console/debugLogger-style function to get visibility into the loop. The
  // default is a no-op so existing tests/callers are unaffected. Report shape:
  //   { root, iter, delta, curTop, curHeight, heightGrew, posChanged,
  //     noProgress, timeSinceGrowMs, settleMs, stallWindowMs }
  var onIter = (typeof opts.onIter === 'function') ? opts.onIter : function () {};

  var prevY = root.scrollTop || 0;
  var prevScrollHeight = root.scrollHeight || 0;
  var lastScrollTop = prevY;
  var lastScrollHeight = prevScrollHeight;
  var lastGrowTime = now();
  var noProgress = 0;
  var attempts = 0;
  var trustedWheelAttempts = 0;
  var stallReason = null;

  // RC19 follow-up (console.log 2026-07-29): if the chosen root has no scroll
  // range (clientHeight >= scrollHeight), no amount of scrollBy or wheel-
  // dispatch will move it. Exit immediately with stalled:true so the caller's
  // inner-container probe can find the real scroll root. Without this, the
  // loop spins noProgressLimit times then invokes trustedWheelFallback, which
  // for background tabs hangs ~60s on a CDP sendCommand that never calls back
  // (Chrome's input pipeline throttles hidden tabs) — long enough for the
  // orchestrator to time out and close the tab. Site-agnostic: any page where
  // the LLM picks a non-scrolling wrapper (FB's div[role=main] is the
  // documented case) hits this.
  var rootClientHeight = root.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800);
  if (prevScrollHeight <= rootClientHeight) {
    return {
      scrolled: false,
      prevY: prevY,
      newY: prevY,
      prevScrollHeight: prevScrollHeight,
      newScrollHeight: prevScrollHeight,
      scrollRoot: scrollRootLabel,
      stalled: true,
      stallReason: 'no_overflow',
      attempts: 0,
      stallWindowMs: stallWindowMs,
      noOverflow: true
    };
  }

  return (async function loop() {
    for (var i = 0; i < maxAttempts; i++) {
      attempts += 1;
      var delta = Math.round((root.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800)) * SCROLL_INCREMENT_RATIO);
      if (root.scrollBy) {
        root.scrollBy(0, delta);
      } else {
        root.scrollTop = (root.scrollTop || 0) + delta;
      }
      if (settleMs > 0) await sleep(settleMs);

      var curTop = root.scrollTop || 0;
      var curHeight = root.scrollHeight || 0;
      var heightGrew = curHeight > lastScrollHeight;
      var posChanged = curTop !== lastScrollTop;
      lastScrollTop = curTop;
      lastScrollHeight = curHeight;

      // RC21: height growth is the primary "content arrived" signal — resets
      // both the count-based noProgress counter AND the time-based
      // lastGrowTime. posChanged without growth resets noProgress only
      // (legacy semantics — preserves backward compat with tests that
      // rely on posChanged restarting the count).
      if (heightGrew) {
        lastGrowTime = now();
        noProgress = 0;
      } else if (posChanged) {
        noProgress = 0;
      } else {
        noProgress += 1;
      }

      var timeSinceGrowMs = now() - lastGrowTime;
      var countStalled = noProgress >= noProgressLimit;
      var timeStalled = timeSinceGrowMs >= stallWindowMs;

      try {
        onIter({
          root: scrollRootLabel, iter: i, delta: delta,
          curTop: curTop, curHeight: curHeight,
          heightGrew: heightGrew, posChanged: posChanged,
          noProgress: noProgress,
          timeSinceGrowMs: timeSinceGrowMs,
          settleMs: settleMs,
          stallWindowMs: stallWindowMs
        });
      } catch (e) { /* diagnostic must not break the loop */ }

      if (countStalled || timeStalled) {
        // Stall: try trusted wheel fallback before declaring stalled.
        // Without a fallback (or after attempts exhausted), break.
        if (trustedWheelFallback && trustedWheelAttempts < maxTrustedWheelAttempts) {
          var wheelResult = null;
          try {
            wheelResult = await trustedWheelFallback({
              deltaY: delta,
              attempt: trustedWheelAttempts + 1,
              scrollRoot: scrollRootLabel
            });
          } catch (e) {
            wheelResult = { dispatched: false, reason: 'fallback threw: ' + (e && e.message || String(e)) };
          }
          trustedWheelAttempts += 1;
          if (wheelResult && wheelResult.dispatched) {
            // Give the trusted wheel event time to trigger lazy-load
            // before we measure again.
            if (settleMs > 0) await sleep(settleMs);
            // RC21: reset BOTH stall signals — count-based noProgress AND
            // time-based lastGrowTime. Without the time reset, the loop
            // would immediately re-stall via the time-based signal on the
            // next iter even though the wheel event just fired.
            lastGrowTime = now();
            noProgress = 0;
            continue;
          }
          // Fallback declined (Enhanced Mode off, attach failed, etc.) —
          // fall through and break.
          stallReason = timeStalled ? 'stall_window_elapsed' : 'no_progress_count_elapsed';
          if (wheelResult && wheelResult.reason) stallReason += ': ' + wheelResult.reason;
          break;
        }
        stallReason = timeStalled ? 'stall_window_elapsed' : 'no_progress_count_elapsed';
        break;
      }
    }

    var newY = root.scrollTop || 0;
    var newScrollHeight = root.scrollHeight || 0;
    var result = {
      scrolled: newY !== prevY,
      prevY: prevY,
      newY: newY,
      prevScrollHeight: prevScrollHeight,
      newScrollHeight: newScrollHeight,
      scrollRoot: scrollRootLabel,
      stalled: stallReason !== null,
      stallReason: stallReason,
      attempts: attempts,
      stallWindowMs: stallWindowMs
    };
    if (trustedWheelFallback) result.trustedWheelAttempts = trustedWheelAttempts;
    return result;
  })();
}

// findScrollableContainer(doc) → Element | null
//
// Enumerates all elements in `doc` whose computed overflowY is 'auto' or
// 'scroll' AND whose scrollHeight exceeds 1.5x their clientHeight. Returns
// the one with the largest scrollHeight, or null if none qualify.
//
// Used by domScrollToBottom's fallback path: when the document.scrollingElement
// makes zero progress (the page's scroll root is an inner container), this
// probes for the real scroll root.
function findScrollableContainer(doc) {
  if (!doc || !doc.defaultView) return null;
  var view = doc.defaultView;
  var all;
  try {
    all = doc.querySelectorAll('*');
  } catch (e) {
    return null;
  }
  var best = null;
  var bestHeight = 0;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var style;
    try { style = view.getComputedStyle(el); } catch (e) { continue; }
    if (!style) continue;
    var ov = style.overflowY;
    if (ov !== 'auto' && ov !== 'scroll') continue;
    var sh = el.scrollHeight || 0;
    var ch = el.clientHeight || 0;
    if (sh <= ch * 1.5) continue;
    if (sh > bestHeight) {
      bestHeight = sh;
      best = el;
    }
  }
  return best;
}

var api = { scrollToBottomIncremental: scrollToBottomIncremental,
            findScrollableContainer: findScrollableContainer,
            DEFAULT_MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,
            DEFAULT_NO_PROGRESS_LIMIT: DEFAULT_NO_PROGRESS_LIMIT,
            DEFAULT_SETTLE_MS: DEFAULT_SETTLE_MS,
            DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS: DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS,
            SCROLL_INCREMENT_RATIO: SCROLL_INCREMENT_RATIO };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ScrollOps = api;
if (typeof self !== 'undefined') self.ScrollOps = api;
