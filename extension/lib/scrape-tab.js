// extension/lib/scrape-tab.js
//
// Helper for opening a "scrape tab" — the browser tab we drive via
// chrome.scripting / chrome.tabs.sendMessage to actually run scrape steps.
//
// === History of this module (RC12 → RC14) ===
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
// RC14 (this version, user feedback 2026-07-27): popup windows AUTO-ACTIVATE
// on Linux/GNOME and Windows even with focused:false — Chrome documents this
// as "the operating system may not honor this request". A 1280x800 popup
// landing at (0,0) looks fullscreen and steals keyboard focus. User reports
// the tab activates mid-scrape, disrupting their work.
//
// INSIGHT: the RC12 failure mode ("BG tab loads only 3 posts") is now under-
// stood to be caused by page JS reading document.visibilityState==='hidden'
// and gating further loading on it — NOT by Chrome throttling Intersection-
// Observer itself (IO is layout-driven and continues to fire on inactive
// tabs). RC13's visibility-keepalive override already addresses the real root
// cause. So we can safely default back to chrome.tabs.create({active:false}),
// which:
//   - Reliably does NOT activate the tab (no OS will ignore active:false)
//   - Opens in the CURRENT window as a normal-looking tab (no fullscreen popup)
//   - Lets visibility-keepalive keep the page JS loading content as if visible
//
// The popup-window path is preserved as opt-in via options.usePopup=true,
// for sites where the background-tab + visibility-override combination turns
// out to be insufficient (rare — would manifest as scroll loop's uniqueCount
// staying flat across iterations).

(function (global) {
  // Default geometry for the popup-window fallback path. Kept modest so that
  // even when usePopup:true is set, the window doesn't look fullscreen.
  var DEFAULT_POPUP_WIDTH = 1024;
  var DEFAULT_POPUP_HEIGHT = 600;
  var DEFAULT_POPUP_LEFT = 80;
  var DEFAULT_POPUP_TOP = 80;

  // createScrapeTab(url, options?) → Promise<chrome.tabs.Tab>
  //
  // options:
  //   usePopup (default false) — opt into the popup-window path. The default
  //     background-tab path is preferred (doesn't steal focus, no fullscreen).
  //     Set to true only if you have evidence the background tab is being
  //     throttled in a way visibility-keepalive can't override.
  //   active (default false) — for the background-tab path, whether to active:
  //     the tab. Default false (don't switch focus to it).
  //   width, height, left, top — window geometry for usePopup:true path
  //   focused — for usePopup:true path, default false (don't steal focus)
  //   type — for usePopup:true path, default 'popup'
  //
  // Returns the tab object. Throws on window/tab creation failure.
  async function createScrapeTab(url, options) {
    options = options || {};
    if (options.usePopup) {
      return await createPopupTab(url, options);
    }
    return await createBackgroundTab(url, options);
  }

  // Default path: chrome.tabs.create({active:false}). Does not steal focus,
  // does not look fullscreen — just a normal inactive tab in the current
  // window. visibility-keepalive is injected afterwards so the page keeps
  // loading lazy content as if it were visible.
  async function createBackgroundTab(url, options) {
    var tabOpts = {
      url: url,
      active: options.active === undefined ? false : !!options.active
    };
    var tab = await chrome.tabs.create(tabOpts);
    if (!tab) throw new Error('createScrapeTab: chrome.tabs.create returned no tab');
    return await afterTabOpen(tab);
  }

  // Fallback path: chrome.windows.create({type:'popup', focused:false}).
  // Used when caller passes usePopup:true. Popup windows get rendered even
  // when not focused, which is the original RC12 win for sites that genuinely
  // need an active compositor. Caveat: many OSes ignore focused:false and
  // activate the popup anyway — prefer the default background-tab path.
  async function createPopupTab(url, options) {
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
    return await afterTabOpen(tab);
  }

  // Common post-open hook: inject visibility-keepalive so the page's JS sees
  // visibilityState='visible' regardless of actual tab/window state. Without
  // this, FB/Twitter/Reddit/SPA-infinite-scroll would stop loading more
  // content the moment the tab becomes inactive.
  //
  // Fire-and-forget: we don't want to block tab creation on injection. If
  // injection fails (rare), the scrape still runs, just without the override.
  async function afterTabOpen(tab) {
    if (typeof injectVisibilityKeepalive === 'function') {
      Promise.resolve(injectVisibilityKeepalive(tab.id)).catch(function () {});
    }
    return tab;
  }

  var api = {
    createScrapeTab: createScrapeTab,
    createBackgroundTab: createBackgroundTab,
    createPopupTab: createPopupTab,
    DEFAULT_POPUP_WIDTH: DEFAULT_POPUP_WIDTH,
    DEFAULT_POPUP_HEIGHT: DEFAULT_POPUP_HEIGHT,
    DEFAULT_POPUP_LEFT: DEFAULT_POPUP_LEFT,
    DEFAULT_POPUP_TOP: DEFAULT_POPUP_TOP
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ScrapeTab = api;
  if (typeof self !== 'undefined') self.ScrapeTab = api;
  // Expose createScrapeTab as a top-level free variable so wizard.js's
  // `await createScrapeTab(url)` call sites work without qualification.
  if (typeof global !== 'undefined') {
    global.createScrapeTab = createScrapeTab;
    global.ScrapeTab = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
