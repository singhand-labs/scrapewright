// extension/lib/scrape-tab.js
//
// Helper for opening a "scrape tab" — the browser tab we drive via
// chrome.scripting / chrome.tabs.sendMessage to actually run scrape steps.
//
// === History of this module (RC12 → RC17) ===
//
// RC12 (console.log 2026-07-26 16:30 BG vs 16:32 FG): introduced popup window
// via chrome.windows.create({type:'popup', focused:false}) because BG tabs
// (chrome.tabs.create({active:false})) landed only 3 posts vs FG's 10. The
// diagnosis was that Chrome throttles inactive-tab renderers, so Intersection-
// Observer-based lazy-load never fires.
//
// RC13 (console.log 2026-07-27): two compounding fixes.
//   (1) scrape-tab.js's top-level `var api` collided with list-pattern.js's
//       top-level `const api` in wizard.html's shared global lexical env, so
//       the entire file failed to parse — silently disabling RC12. IIFE-wrapped.
//   (2) Even with popup working, Chrome throttles UNFOCUSED popup windows.
//       Added lib/visibility-keepalive.js which injects pageWorldKeepalive
//       into the page's MAIN world via chrome.scripting.executeScript, over-
//       riding document.visibilityState / hidden / hasFocus + rAF keep-alive.
//
// RC14 (user feedback 2026-07-27): popup windows AUTO-ACTIVATE on Linux/GNOME
// and Windows even with focused:false — Chrome documents this as "the OS may
// not honor this request". Reverted to chrome.tabs.create({active:false}) as
// default, believing that visibility-keepalive alone would address the root
// cause. The popup-window path was preserved as opt-in via usePopup:true.
//
// RC16 (console.log 2026-07-27 16:44): the visibility-keepalive early-inject
// was found to be running in a TRANSIENT pre-load context that gets discarded
// on page load. Fixed by adding a post-load re-inject in step-orchestrator.js
// after waitForTabLoad completes. Verification probe confirmed override sticks.
//
// RC17 (console.log 2026-07-27 17:02–17:08): user reported that
// EVEN WITH successful visibility-keepalive override (verified: injected:true,
// visibilityState:"visible", hasFocus:true), scroll-iteration uniqueCount still
// flatlines (6 across 5 iterations → exhausted). Manual tab activation works.
// This is the decisive evidence: visibility-API override is NECESSARY but NOT
// SUFFICIENT. Chrome's renderer-level frame-production throttle for non-active
// tabs cannot be bypassed from JS — IntersectionObserver callbacks (which fire
// on layout-intersection computation, which requires frame production) never
// fire, so lazy-load never triggers.
//
// FRAMEWORK-LEVEL FIX ATTEMPT (RC17): default to popup-window path so the
// scrape tab is the active tab of a visible window. To mitigate the GNOME
// focus-stealing, immediately restore focus to user's previous window. This
// WORKED for some scenarios but had two flaws:
//   (a) Linux GNOME / Windows still steal focus briefly on popup creation,
//       violating "don't switch focus to target page" user requirement.
//   (b) When the popup gets occluded / minimized / closed mid-scrape, frame
//       production drops and IO-driven lazy-load stops firing again.
//
// RC18 (console.log 2026-07-28 — current): added two layers and reverted the
// default. Empirical finding: Plan A (chrome.debugger transient attach +
// Page.setWebLifecycleState({state:'active'})) is INSUFFICIENT on its own.
// The CDP command addresses Chrome's page-lifecycle layer (JS execution,
// timers, rAF) but NOT the compositor frame-production layer. IO callbacks
// depend on frame production, which for non-visible tabs requires process-
// level launch flags. Plan A reports ok:true while uniqueCount still flatlines.
//
// FINAL ARCHITECTURE (RC18):
//   - Default path: chrome.tabs.create({active:false}) — no focus steal.
//     Relies on Plan B'-1 (scrapewright throttle on → Chrome launch flags
//     --disable-renderer-backgrounding / --disable-backgrounding-occluded-
//     windows / --disable-features=CalculateNativeWinOcclusion) for renderer
//     frame production. Users who scrape lazy-load sites MUST run
//     `scrapewright throttle on` once and restart Chrome.
//   - visibility-keepalive still injected (handles page JS that reads
//     document.visibilityState directly).
//   - Plan A (chrome.debugger activation) still runs as a complementary
//     layer — opt-in via Enhanced Scraping Mode toggle. May help in scenarios
//     where page JS gates on lifecycle state, but does NOT fix frame
//     production. Detection-risk minimized: only Page.* CDP commands.
//   - Popup-window path survives as opt-in via {usePopup:true} for rare
//     cases that need physical visibility and accept the focus steal.

(function (global) {
  // Default geometry for the popup window. Modest — visible enough to get
  // compositor priority but small enough not to cover the user's work.
  var DEFAULT_POPUP_WIDTH = 480;
  var DEFAULT_POPUP_HEIGHT = 320;
  var DEFAULT_POPUP_LEFT = 16;
  var DEFAULT_POPUP_TOP = 16;

  // createScrapeTab(url, options?) → Promise<chrome.tabs.Tab>
  //
  // options:
  //   usePopup (default false) — pass true ONLY for the rare case where the
  //     caller needs the scrape tab to be the active tab of its own visible
  //     popup window. This steals OS focus on Linux/GNOME/Windows (Chrome
  //     documents focused:false as "OS may not honor") and is not the
  //     default. Background-tab default relies on Plan B'-1 (Chrome launch
  //     flags --disable-renderer-backgrounding etc., set via
  //     `scrapewright throttle on`) for renderer frame production on
  //     lazy-load sites (FB infinite scroll, virtualized feeds).
  //   restoreFocus (default true) — ignored unless usePopup:true. After
  //     creating the popup, immediately restore keyboard focus to the user's
  //     previously-focused window. This mitigates GNOME/Windows focus-
  //     stealing. Pass false only if you explicitly want the popup to take
  //     focus (rare — e.g., interactive wizard preview).
  //   active (default false) — for the default background-tab path, whether
  //     to activate the tab. Default false.
  //   width, height, left, top — window geometry for usePopup:true path
  //   focused — for usePopup:true path, default false (don't steal focus)
  //   type — for usePopup:true path, default 'popup'
  //
  // Returns the tab object. The tab carries _popupWindowId when usePopup path
  // was used; callers MUST prefer chrome.windows.remove(_popupWindowId) over
  // chrome.tabs.remove(tab.id) at cleanup sites so the empty window doesn't
  // linger on screen. Throws on window/tab creation failure.
  async function createScrapeTab(url, options) {
    options = options || {};
    if (options.usePopup === true) {
      return await createPopupTab(url, options);
    }
    return await createBackgroundTab(url, options);
  }

  // Background-tab path: chrome.tabs.create({active:false}). Opt-out via
  // {usePopup:false}. The tab is a non-active tab in the current window —
  // Chrome's renderer deeply throttles it, so IntersectionObserver-driven
  // lazy-load will NOT fire. visibility-keepalive override (which addresses
  // the JS-API layer) is still injected but is insufficient on its own.
  // Use this path only when no display is available (headless server) or for
  // sites that don't depend on renderer frame production.
  async function createBackgroundTab(url, options) {
    var tabOpts = {
      url: url,
      active: options.active === undefined ? false : !!options.active
    };
    var tab = await chrome.tabs.create(tabOpts);
    if (!tab) throw new Error('createScrapeTab: chrome.tabs.create returned no tab');
    return await afterTabOpen(tab);
  }

  // Default path: chrome.windows.create({type:'popup', focused:false}) +
  // immediate focus restoration. The scrape tab is the active tab in its own
  // popup window → renderer produces frames → IntersectionObserver fires →
  // lazy-load triggers. Focus restoration keeps user's keyboard in their
  // editor even on GNOME/Windows where focused:false is ignored.
  async function createPopupTab(url, options) {
    var restoreFocus = options.restoreFocus === undefined ? true : !!options.restoreFocus;

    // Capture user's currently-focused window BEFORE creating the popup, so we
    // can restore focus to it afterwards. This is the mitigation for GNOME/Win
    // focus-stealing: we accept that the OS may focus the popup on creation,
    // but we immediately pull focus back.
    var previousWindowId = null;
    if (restoreFocus && chrome.windows && typeof chrome.windows.getLastFocused === 'function') {
      try {
        var prev = await chrome.windows.getLastFocused({ populate: false });
        if (prev && typeof prev.id === 'number') previousWindowId = prev.id;
      } catch (e) {
        // getLastFocused is best-effort; if it fails we proceed without
        // restoration (popup still works, just may steal focus).
      }
    }

    var winOpts = {
      url: url,
      type: options.type || 'popup',
      focused: options.focused === undefined ? false : !!options.focused,
      width: options.width || DEFAULT_POPUP_WIDTH,
      height: options.height || DEFAULT_POPUP_HEIGHT,
      left: typeof options.left === 'number' ? options.left : DEFAULT_POPUP_LEFT,
      top: typeof options.top === 'number' ? options.top : DEFAULT_POPUP_TOP
    };
    if (options.state) winOpts.state = options.state;
    var win = await chrome.windows.create(winOpts);
    if (!win) throw new Error('createScrapeTab: chrome.windows.create returned no window');
    var tab = (win.tabs && win.tabs[0]) || null;
    if (!tab) throw new Error('createScrapeTab: popup window opened with no tab');
    tab._popupWindowId = win.id;
    tab._popupWindowRestoredFocus = false;

    if (restoreFocus && previousWindowId !== null &&
        chrome.windows && typeof chrome.windows.update === 'function') {
      try {
        await chrome.windows.update(previousWindowId, { focused: true });
        tab._popupWindowRestoredFocus = true;
      } catch (e) {
        // Restoration is best-effort. If it fails (rare — window closed in
        // the brief window between capture and restore), the popup remains
        // focused; user can manually refocus their window.
      }
    }

    return await afterTabOpen(tab);
  }

  // Common post-open hook: inject visibility-keepalive so the page's JS sees
  // visibilityState='visible' regardless of actual tab/window state. Necessary
  // even with the popup-window default — FB and similar sites read
  // document.visibilityState directly and gate further loading on it, so
  // without the override the page would stop loading content the moment it
  // sees the popup isn't the focused window.
  //
  // RC16: this early injection runs in a TRANSIENT pre-load context that gets
  // discarded on page load. The load-bearing injection is the post-load
  // re-inject in step-orchestrator.js (after waitForTabLoad). The early
  // injection here is best-effort coverage for sites whose page scripts run
  // before the load event.
  //
  // RC18 (Plan A — chrome.debugger transient activation): after visibility-
  // keepalive, optionally issue Page.setWebLifecycleState(active) via a
  // transient chrome.debugger attach. This lifts Chrome's renderer-level
  // intensive-throttling freeze that prevents IntersectionObserver from firing
  // on inactive popup tabs. Permission-gated (optional_permissions:'debugger')
  // — silently skips if user hasn't opted in. See lib/renderer-activation.js.
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

    if (typeof activateTabIfPermitted === 'function') {
      try {
        const activateResult = await activateTabIfPermitted(tab.id);
        if (activateResult && activateResult.ok) {
          logInfo(tab, 'Renderer activation via chrome.debugger', activateResult);
        } else if (activateResult && activateResult.reason === 'debugger permission not granted') {
          // Expected state for users who haven't opted in — silent.
        } else {
          logWarn(tab, 'Renderer activation failed (non-fatal — popup path still in effect)', activateResult);
        }
      } catch (e) {
        logWarn(tab, 'Renderer activation threw (non-fatal)', { error: e && e.message });
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

  // Helper for callers (background.js cleanup sites): close the scrape tab's
  // popup window if one was created, else remove the standalone tab. Idempotent
  // — failures (window/tab already gone) are swallowed.
  async function closeScrapeTab(tab) {
    if (!tab) return;
    if (tab._popupWindowId != null && chrome.windows && typeof chrome.windows.remove === 'function') {
      try { await chrome.windows.remove(tab._popupWindowId); }
      catch (e) { /* window may already be gone — swallow */ }
      return;
    }
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
    createBackgroundTab: createBackgroundTab,
    createPopupTab: createPopupTab,
    closeScrapeTab: closeScrapeTab,
    DEFAULT_POPUP_WIDTH: DEFAULT_POPUP_WIDTH,
    DEFAULT_POPUP_HEIGHT: DEFAULT_POPUP_HEIGHT,
    DEFAULT_POPUP_LEFT: DEFAULT_POPUP_LEFT,
    DEFAULT_POPUP_TOP: DEFAULT_POPUP_TOP
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
