// extension/lib/scrape-tab.js
//
// Helper for opening a "scrape tab" — the browser tab we drive via
// chrome.scripting / chrome.tabs.sendMessage to actually run scrape steps.
//
// === Current architecture (RC20) ===
//
// Scrape tabs are background tabs: chrome.tabs.create({active:false}). The
// user's keyboard focus stays in their editor. For IntersectionObserver-
// driven lazy-load sites (FB feeds, infinite scroll, virtualized lists),
// the scrape works because of the FIVE-LAYER stack documented in CLAUDE.md:
//
//   1. visibility-keepalive (this file's afterTabOpen injects it)
//   2. Enhanced Scraping Mode toggle (gates trusted-wheel availability;
//      previously also ran Page.setWebLifecycleState, removed RC20-rtag —
//      redundant after layer 5)
//   3. Chrome launch flags (`scrapewright throttle on`)
//   4. Trusted-wheel fallback (CDP Input.dispatchMouseEvent via chrome.debugger)
//   5. Brief tab activation (lib/tab-activation.js wraps input-required DOM
//      ops; this is the only layer that addresses Chrome's hard rule that
//      compositor frames are produced only for the active tab in the
//      focused window)
//
// === Removed in RC20 ===
//
// Popup-window path (chrome.windows.create({type:'popup', focused:false})):
// was the pre-RC20 attempt to get a visible tab. RC20 makes background tabs
// work via brief activation during input ops, so the popup path is dead
// code. The {usePopup:true} option is no longer supported.
//
// setWebLifecycleState at tab creation (RC18 Plan A): was empirically
// "insufficient alone" — addresses page-lifecycle layer but not compositor
// frame production. With RC20 forcing frame production via activation,
// lifecycle is naturally ACTIVE during the brief window, so the call was
// pure overhead (chrome.debugger yellow banner per scrape). Trusted-wheel
// keeps its OWN chrome.debugger attach when it fires, so removing this
// doesn't compromise the isTrusted bypass.

(function (global) {
  // createScrapeTab(url, options?) → Promise<chrome.tabs.Tab>
  //
  // options:
  //   active (default false) — whether to activate the tab. Default false
  //     (background tab). RC20's lib/tab-activation.js handles brief
  //     activation during input-required DOM ops; you should NOT set
  //     active:true for normal scrapes.
  //
  // Returns the tab object. Throws on tab creation failure.
  async function createScrapeTab(url, options) {
    options = options || {};
    var tabOpts = {
      url: url,
      active: options.active === undefined ? false : !!options.active
    };
    var tab = await chrome.tabs.create(tabOpts);
    if (!tab) throw new Error('createScrapeTab: chrome.tabs.create returned no tab');
    return await afterTabOpen(tab);
  }

  // Common post-open hook: inject visibility-keepalive so the page's JS sees
  // visibilityState='visible' regardless of actual tab state. Necessary for
  // sites that read document.visibilityState directly and gate further
  // loading on it (FB and similar).
  //
  // RC16: this early injection runs in a TRANSIENT pre-load context that
  // gets discarded on page load. The load-bearing injection is the post-
  // load re-inject in step-orchestrator.js (after waitForTabLoad). The
  // early injection here is best-effort coverage for sites whose page
  // scripts run before the load event.
  async function afterTabOpen(tab) {
    if (typeof injectVisibilityKeepalive !== 'function') {
      logWarn(tab, 'injectVisibilityKeepalive unavailable — visibility-keepalive skipped');
    } else {
      try {
        const injectResult = await injectVisibilityKeepalive(tab.id);
        logInfo(tab, 'Visibility keepalive injection', injectResult);
        const verifyResult = await verifyVisibilityKeepaliveWithFallback(tab.id);
        logInfo(tab, 'Visibility keepalive verification', verifyResult);
      } catch (e) {
        logWarn(tab, 'Visibility keepalive injection threw', { error: e && e.message });
      }
    }
    return tab;
  }

  // Defensive: verifyVisibilityKeepalive may be unavailable if visibility-
  // keepalive.js failed to load. Treat that as a verification failure rather
  // than crashing the tab-opening path.
  async function verifyVisibilityKeepaliveWithFallback(tabId) {
    if (typeof verifyVisibilityKeepalive !== 'function') {
      return { ok: false, reason: 'verifyVisibilityKeepalive unavailable' };
    }
    return await verifyVisibilityKeepalive(tabId);
  }

  // Helper for callers (background.js cleanup sites): remove the scrape tab.
  // Idempotent — failures (tab already gone) are swallowed.
  async function closeScrapeTab(tab) {
    if (!tab) return;
    if (chrome.tabs && typeof chrome.tabs.remove === 'function') {
      try { await chrome.tabs.remove(tab.id); }
      catch (e) { /* tab may already be gone — swallow */ }
    }
  }

  function logInfo(tab, msg, fields) {
    if (typeof debugLogger !== 'undefined' && debugLogger && debugLogger.log) {
      try {
        debugLogger.log('info', 'scrape-tab', msg, Object.assign({ tabId: tab && tab.id }, fields || {}));
      } catch (e) {}
    }
  }
  function logWarn(tab, msg, fields) {
    if (typeof debugLogger !== 'undefined' && debugLogger && debugLogger.log) {
      try {
        debugLogger.log('warn', 'scrape-tab', msg, Object.assign({ tabId: tab && tab.id }, fields || {}));
      } catch (e) {}
    }
  }

  var api = {
    createScrapeTab: createScrapeTab,
    closeScrapeTab: closeScrapeTab
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ScrapeTab = api;
  if (typeof self !== 'undefined') self.ScrapeTab = api;
  // Expose createScrapeTab / closeScrapeTab as top-level free variables so
  // background.js / wizard.js call sites work without qualification.
  if (typeof global !== 'undefined') {
    global.createScrapeTab = createScrapeTab;
    global.closeScrapeTab = closeScrapeTab;
    global.ScrapeTab = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
