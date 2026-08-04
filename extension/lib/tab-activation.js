// extension/lib/tab-activation.js
//
// RC20 (console.log 2026-07-30): wraps "input-required" DOM operations so
// the scrape tab is briefly the active tab during the operation.
//
// WHY THIS EXISTS
// After RC12-RC19 + their follow-ups, FB-style lazy-load still flatlined on
// background tabs even with all 4 Chrome throttle launch flags set. The
// disambiguating evidence: foreground tab gets 10 posts, background tab
// stuck at 4. Diagnostic in docs/console.log showed:
//   - scrollToBottom_iter posChanged:true on iter 0 (programmatic scrollBy works)
//   - heightGrew:false for all subsequent iters (FB's IO never fires)
//   - trustedWheel_request → "wheel.mouseMoved timeout after 2000ms"
//     (CDP Input.dispatchMouseEvent hangs for non-active tabs)
//
// ROOT CAUSE
// Chrome's renderer ONLY produces compositor frames for the active tab in
// the focused window. IntersectionObserver callbacks (which FB's lazy-load
// gates on) require a layout pass, which requires frame production. CDP
// Input.dispatchMouseEvent is delivered during frame production. So both
// signals — IO callback and CDP input — never fire for non-active tabs.
//
// The 4 launch flags disable various throttles but don't change Chrome's
// "no frames for hidden tabs" rule. visibility-keepalive overrides
// document.visibilityState but that only affects page JS, not Chrome's
// frame production decision. setWebLifecycleState marks the tab as active
// at the lifecycle layer but doesn't force frame production. All necessary,
// none sufficient.
//
// WHAT THIS MODULE DOES
// Accepts the rule and works within it: briefly activate the scrape tab,
// run the operation, restore the user's previous active tab. The user sees
// a brief tab-strip flicker per scroll; the scrape sees frames produced.
//
// SCOPE / SAFETY
//   - No-op if scrape tab is already active (common case: user kept it FG).
//   - Skip cross-window activation (scrape tab in window W1, user in W2).
//     Activating the tab without focusing the window doesn't help, and
//     focusing another window is more disruptive than tab flicker. Caller
//     gets ok:false with a stable reason and falls back gracefully.
//   - Restore-safety: only restore if scrape tab is still active. If the
//     user manually switched tabs during the operation, leave it alone —
//     don't fight the user.
//
// STATE
// Per-tab state Map so concurrent scrapes don't clobber each other. (Today
// Scrapewright serializes via ExecutionQueue, but the API is per-tab.)

(function (global) {
  // tabId → { restoreTabId, restoreWindowId }
  const state = new Map();

  function hasTabsApi() {
    return typeof chrome !== 'undefined' && chrome.tabs &&
      typeof chrome.tabs.get === 'function' &&
      typeof chrome.tabs.query === 'function' &&
      typeof chrome.tabs.update === 'function';
  }

  function hasWindowsApi() {
    return typeof chrome !== 'undefined' && chrome.windows &&
      typeof chrome.windows.getLastFocused === 'function';
  }

  // requestActivation(tabId) → { ok, activated?, restoreTabId?, reason? }
  //   ok:true, activated:false → tab was already active, no-op (no release needed)
  //   ok:true, activated:true  → activated; caller MUST call releaseActivation
  //   ok:false                 → couldn't activate; caller proceeds without activation
  async function requestActivation(tabId) {
    if (!hasTabsApi()) return { ok: false, reason: 'chrome.tabs unavailable' };
    if (typeof tabId !== 'number' || tabId <= 0) return { ok: false, reason: 'invalid tabId' };

    let scrapeTab;
    try {
      scrapeTab = await chrome.tabs.get(tabId);
    } catch (e) {
      return { ok: false, reason: 'tabs.get failed: ' + (e && e.message || String(e)) };
    }

    if (scrapeTab.active) {
      return { ok: true, activated: false, reason: 'already active' };
    }

    // Cross-window guard: if scrape tab's window isn't focused, activating
    // the tab alone doesn't produce frames. Focus steal across windows is
    // more disruptive than the value gained — log and let caller degrade.
    if (hasWindowsApi()) {
      let lastFocused;
      try {
        lastFocused = await chrome.windows.getLastFocused();
      } catch (e) { /* fall through to same-window assumption */ }
      if (lastFocused && scrapeTab.windowId !== lastFocused.id) {
        return {
          ok: false,
          crossWindow: true,
          reason: 'cross-window: scrape window ' + scrapeTab.windowId +
                  ' is not focused (focused=' + lastFocused.id + ')'
        };
      }
    }

    // Find current active tab in scrape tab's window — this is what we'll
    // restore to when the operation completes.
    let currentActive;
    try {
      const activeTabs = await chrome.tabs.query({
        active: true,
        windowId: scrapeTab.windowId
      });
      currentActive = activeTabs[0];
    } catch (e) {
      return { ok: false, reason: 'tabs.query failed: ' + (e && e.message || String(e)) };
    }

    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (e) {
      return { ok: false, reason: 'tabs.update failed: ' + (e && e.message || String(e)) };
    }

    state.set(tabId, {
      restoreTabId: currentActive ? currentActive.id : null,
      restoreWindowId: scrapeTab.windowId
    });

    return { ok: true, activated: true };
  }

  // releaseActivation(tabId) → { ok, restored?, reason? }
  //   Restores the previously active tab if (a) we saved state for this tab,
  //   (b) the user hasn't manually changed tabs during the operation.
  async function releaseActivation(tabId) {
    if (!hasTabsApi()) return { ok: false, reason: 'chrome.tabs unavailable' };
    if (typeof tabId !== 'number' || tabId <= 0) return { ok: false, reason: 'invalid tabId' };

    const saved = state.get(tabId);
    state.delete(tabId);
    if (!saved) return { ok: true, restored: false, reason: 'no activation state' };
    if (!saved.restoreTabId) return { ok: true, restored: false, reason: 'no restore tab id' };

    // Safety: only restore if scrape tab is still active. If the user
    // manually switched tabs mid-operation, they've expressed a preference —
    // don't override it.
    let currentScrapeTab;
    try {
      currentScrapeTab = await chrome.tabs.get(tabId);
    } catch (e) {
      return { ok: false, reason: 'tabs.get failed: ' + (e && e.message || String(e)) };
    }
    if (!currentScrapeTab.active) {
      return { ok: true, restored: false, reason: 'user changed tabs during operation' };
    }

    try {
      await chrome.tabs.update(saved.restoreTabId, { active: true });
    } catch (e) {
      return { ok: false, reason: 'tabs.update(restore) failed: ' + (e && e.message || String(e)) };
    }
    return { ok: true, restored: true };
  }

  // withActivation(tabId, fn) → fn's return value
  // Convenience wrapper for code with direct chrome.tabs access (background).
  // Content-scripts should use the message-passing wrappers (TAB_ACTIVATION_*
  // in background.js + withTabActivation in content-script.js).
  async function withActivation(tabId, fn) {
    const req = await requestActivation(tabId);
    try {
      return await fn();
    } finally {
      if (req.activated) await releaseActivation(tabId);
    }
  }

  const api = {
    requestActivation: requestActivation,
    releaseActivation: releaseActivation,
    withActivation: withActivation,
    _state: state
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.TabActivation = api;
  if (typeof self !== 'undefined') self.TabActivation = api;
  if (typeof window !== 'undefined') window.TabActivation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
