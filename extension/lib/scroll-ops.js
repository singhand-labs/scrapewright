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
var DEFAULT_MAX_ATTEMPTS = 8;        // hard cap on scrollBy calls per invocation
var DEFAULT_NO_PROGRESS_LIMIT = 3;   // consecutive no-growth + no-position-change attempts before stalled
var DEFAULT_SETTLE_MS = 350;         // wait between scrollBy calls for lazy-load to fire

function defaultSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// scrollToBottomIncremental(root, opts) → { scrolled, prevY, newY,
//   prevScrollHeight, newScrollHeight, scrollRoot, stalled, attempts }
//
// root: an element-like with scrollTop (get/set), scrollHeight (get),
//   clientHeight (get), and scrollBy(dx, dy) / scrollTo(x, y) methods.
// opts: { sleep?, maxAttempts?, noProgressLimit?, settleMs?, scrollRootLabel? }
//   All optional. sleep defaults to setTimeout-based; pass `() => Promise.resolve()`
//   in tests to skip waits.
function scrollToBottomIncremental(root, opts) {
  opts = opts || {};
  var sleep = opts.sleep || defaultSleep;
  var maxAttempts = (typeof opts.maxAttempts === 'number') ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  var noProgressLimit = (typeof opts.noProgressLimit === 'number') ? opts.noProgressLimit : DEFAULT_NO_PROGRESS_LIMIT;
  var settleMs = (typeof opts.settleMs === 'number') ? opts.settleMs : DEFAULT_SETTLE_MS;
  var scrollRootLabel = opts.scrollRootLabel || 'window';

  var prevY = root.scrollTop || 0;
  var prevScrollHeight = root.scrollHeight || 0;
  var noProgress = 0;
  var attempts = 0;
  var lastScrollTop = prevY;
  var lastScrollHeight = prevScrollHeight;

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

      if (heightGrew || posChanged) {
        noProgress = 0;
      } else {
        noProgress += 1;
        if (noProgress >= noProgressLimit) break;
      }
    }

    var newY = root.scrollTop || 0;
    var newScrollHeight = root.scrollHeight || 0;
    // `scrolled` reflects VIEWPORT MOVEMENT ONLY (backward-compat with the
    // legacy $scrollToBottom contract: { scrolled, prevY, newY }). It does NOT
    // flip on scrollHeight growth alone. The stall detector above is stricter
    // — it treats heightGrew OR posChanged as progress — so callers that need
    // the "did anything happen" signal should read `stalled` (false = making
    // progress) or compare prevScrollHeight/newScrollHeight directly.
    return {
      scrolled: newY !== prevY,
      prevY: prevY,
      newY: newY,
      prevScrollHeight: prevScrollHeight,
      newScrollHeight: newScrollHeight,
      scrollRoot: scrollRootLabel,
      stalled: noProgress >= noProgressLimit,
      attempts: attempts
    };
  })();
}

var api = { scrollToBottomIncremental: scrollToBottomIncremental,
            DEFAULT_MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,
            DEFAULT_NO_PROGRESS_LIMIT: DEFAULT_NO_PROGRESS_LIMIT,
            DEFAULT_SETTLE_MS: DEFAULT_SETTLE_MS,
            SCROLL_INCREMENT_RATIO: SCROLL_INCREMENT_RATIO };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ScrollOps = api;
if (typeof self !== 'undefined') self.ScrollOps = api;
