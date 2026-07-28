// extension/lib/visibility-keepalive.js
//
// Forces the target page to behave as if it is always visible + focused,
// even when the popup window loses focus or Chrome throttles the renderer.
//
// WHY THIS EXISTS (RC13, console.log 2026-07-27 01:55):
// RC12 fixed background-tab throttling by opening scrape tabs in a popup
// window (lib/scrape-tab.js). That works when the popup is foreground, but
// as soon as the user switches to another window/app or runs parallel scrape
// tasks, Chrome deprioritizes the popup renderer — IntersectionObserver
// callbacks don't fire, requestAnimationFrame is throttled to ~1 Hz, and
// visibilityState flips to 'hidden'. The page stops loading new content
// even though our scroll loop is still running. Symptom signature in logs:
// postCount smaller than a foreground run, uniqueCount flat across
// iterations, r.scrolled=false from iter 2 onward.
//
// This module is the GENERAL, non-FB-specific fix. It works for any site
// that gates behavior on:
//   - document.visibilityState / document.hidden (FB feed, Twitter,
//     infinite-scroll SPAs, lazy-load images, analytics, ad refresh)
//   - visibilitychange event listeners
//   - requestAnimationFrame cadence (some sites use rAF as a proxy for
//     "is the user looking")
//
// It does NOT solve IntersectionObserver throttling directly — IO callbacks
// are based on actual layout intersection, which depends on the renderer
// producing frames. But combined with the popup window (which has a real
// viewport) + the rAF keep-alive loop below, the renderer stays active
// enough for IO to fire.
//
// INJECTION: chrome.scripting.executeScript with world:'MAIN'. The page's
// own JS reads document.visibilityState via the same getter we override, so
// the trick is transparent to page code. Injected as `func` (not `files`)
// to keep the deployment story simple — no web_accessible_resources entry
// needed, no separate script file the page could detect + block.
//
// RC13 note: this file is wrapped in an IIFE for the same reason scrape-tab.js
// is — top-level `const api = ...` collides with list-pattern.js's same-named
// top-level `const` in the wizard.html shared global lexical environment.

(function (global) {
  // The function body injected into the page's MAIN world. MUST be
  // self-contained (no closure over outer-scope variables, no imports).
  // `injectVisibilityKeepalive` (below) passes this to chrome.scripting.
  function pageWorldKeepalive() {
    if (typeof window === 'undefined') return 'no-window';
    // Idempotency: a re-injection (e.g., after a tab reload) shouldn't stack
    // another interval/rAF loop. The flag survives same-document reinjects
    // but not navigations — which is exactly what we want.
    if (window.__SCRAPEWRIGHT_VISIBILITY_KEEPALIVE__) return 'already-injected';
    window.__SCRAPEWRIGHT_VISIBILITY_KEEPALIVE__ = true;
    // Record injection timestamp for diagnostic read-back. verifyVisibility-
    // Keepalive probes this to confirm the function actually ran in the page.
    window.__SCRAPEWRIGHT_VISIBILITY_KEEPALIVE_INJECTED_AT__ = Date.now();

    const defineGetter = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, {
          configurable: true,
          get: () => value
        });
      } catch (e) {
        // Some engines refuse to redefine certain properties. Failing
        // silently is fine — visibilityState is the highest-leverage one,
        // and we want to keep going for the others.
      }
    };

    // Force the page to read 'visible' regardless of actual tab/window state.
    defineGetter(document, 'visibilityState', 'visible');
    defineGetter(document, 'hidden', false);
    defineGetter(document, 'webkitVisibilityState', 'visible');
    defineGetter(document, 'webkitHidden', false);
    defineGetter(document, 'mozHidden', false);
    defineGetter(document, 'msHidden', false);

    // Fake focus state — pages often pair visibility + focus checks.
    // document.hasFocus() is a method, not a property; override the method.
    try {
      document.hasFocus = () => true;
    } catch (e) {}

    // Dispatch synthetic visibilitychange events periodically. Some sites
    // don't poll visibilityState directly but react to the event to
    // resume paused work. ~1 Hz is enough — visibility-gated work typically
    // doesn't need higher granularity, and a tighter loop would burn cycles.
    setInterval(() => {
      try {
        const ev = new Event('visibilitychange');
        Object.defineProperty(ev, 'target', { value: document });
        document.dispatchEvent(ev);
      } catch (e) {}
    }, 1000);

    // rAF keep-alive: a self-perpetuating rAF loop forces the renderer to
    // keep producing frames. Chrome's heuristic throttles rAF when it thinks
    // the tab is idle; an active rAF loop signals "this tab is doing work"
    // and lifts the throttle for the whole renderer.
    const keepAlive = () => {
      requestAnimationFrame(keepAlive);
    };
    requestAnimationFrame(keepAlive);
  }

  // injectVisibilityKeepalive(tabId): injects the page-world override into
  // the given tab. Best-effort — if injection fails (tab gone, permission
  // missing), we log and move on. The scrape still runs; it just doesn't
  // get the visibility boost.
  async function injectVisibilityKeepalive(tabId) {
    if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.executeScript) {
      return { ok: false, reason: 'chrome.scripting unavailable' };
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        injectImmediately: true,
        func: pageWorldKeepalive
      });
      // chrome.scripting.executeScript returns one result per frame; check
      // that at least one frame actually ran the function without throwing.
      // Capture the return value too — pageWorldKeepalive returns a sentinel
      // ('injected' / 'already-injected' / 'no-window') so we can tell from
      // logs whether the function actually ran vs. silently no-op'd (the
      // RC16 console.log 2026-07-27 incident: inject returned ok:true but the
      // page never saw the override — the function ran in a transient pre-
      // load context that got discarded when the page finished loading).
      const ok = Array.isArray(results) && results.length > 0 && !results[0].error;
      const returnValue = ok && results[0] ? results[0].result : null;
      return { ok, frameCount: Array.isArray(results) ? results.length : 0, returnValue };
    } catch (e) {
      return { ok: false, reason: e && e.message };
    }
  }

  // verifyVisibilityKeepalive(tabId): re-executes a probe in the page's MAIN
  // world to confirm: (a) the keepalive function actually ran (injection was
  // not silently rejected), and (b) the visibilityState override is in effect.
  // Used by scrape-tab.js afterTabOpen for diagnostic logging so the operator
  // can tell from the console log whether visibility-keepalive is working.
  //
  // Returns: { ok, injected, injectedAt, visibilityState, hidden, hasFocus }
  // ok=true means the probe itself ran. injected=true means pageWorldKeepalive
  // had also run. visibilityState='visible' means the override took effect.
  async function verifyVisibilityKeepalive(tabId) {
    if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.executeScript) {
      return { ok: false, reason: 'chrome.scripting unavailable' };
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        func: () => ({
          injected: !!window.__SCRAPEWRIGHT_VISIBILITY_KEEPALIVE__,
          injectedAt: window.__SCRAPEWRIGHT_VISIBILITY_KEEPALIVE_INJECTED_AT__ || null,
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null
        })
      });
      if (Array.isArray(results) && results.length > 0 && !results[0].error) {
        const r = results[0].result || {};
        return { ok: true, ...r };
      }
      return { ok: false, reason: 'verify probe returned no result' };
    } catch (e) {
      return { ok: false, reason: e && e.message };
    }
  }

  const api = {
    injectVisibilityKeepalive: injectVisibilityKeepalive,
    verifyVisibilityKeepalive: verifyVisibilityKeepalive,
    pageWorldKeepalive: pageWorldKeepalive
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.VisibilityKeepalive = api;
    // Expose injectVisibilityKeepalive as a free variable so scrape-tab.js
    // (also IIFE-wrapped) can reference it without `window.` qualification.
    window.injectVisibilityKeepalive = injectVisibilityKeepalive;
    window.verifyVisibilityKeepalive = verifyVisibilityKeepalive;
  }
  if (typeof self !== 'undefined') {
    self.VisibilityKeepalive = api;
    self.injectVisibilityKeepalive = injectVisibilityKeepalive;
    self.verifyVisibilityKeepalive = verifyVisibilityKeepalive;
  }
  if (typeof global !== 'undefined') {
    global.VisibilityKeepalive = api;
    global.injectVisibilityKeepalive = injectVisibilityKeepalive;
    global.verifyVisibilityKeepalive = verifyVisibilityKeepalive;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
