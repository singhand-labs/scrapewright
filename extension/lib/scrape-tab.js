// extension/lib/scrape-tab.js
//
// Helper for opening a "scrape tab" — the browser tab we drive via
// chrome.scripting / chrome.tabs.sendMessage to actually run scrape steps.
//
// WHY THIS EXISTS (RC12, console.log 2026-07-26 16:30-16:32):
// The straightforward approach is chrome.tabs.create({ url, active: false }).
// That works for static pages but BREAKS on sites that lazy-load content via
// IntersectionObserver (Facebook feed, Twitter, infinite-scroll feeds, etc.):
//
//   - Background tabs (active: false) are render-deferred by Chrome. The
//     renderer doesn't produce compositor frames at full rate, and
//     IntersectionObserver callbacks either fire with isIntersecting:false
//     or don't fire at all.
//   - Symptom in logs: postCount lower than foreground (7 vs 13 on the same
//     FB search), scroll loop's uniqueCount stays flat across iterations
//     (4 → 4 → 4 ...), r.scrolled flips to false after the first iteration
//     (scrollHeight isn't growing because the page isn't loading more posts).
//   - Foreground tab (user activates it manually): everything works.
//
// The fix is to open the URL in a popup window (chrome.windows.create with
// type: 'popup'). Popup windows are rendered normally even when not focused,
// so IntersectionObserver fires correctly. The user's keyboard focus stays
// on whatever they were doing — focused: false prevents focus steal.
//
// This module is intentionally tiny and side-effect-free. Callers still use
// chrome.tabs.* APIs (sendMessage, executeScript, remove) on the returned
// tab — popup-window tabs behave identically to normal tabs for those APIs.
// When the tab is removed via chrome.tabs.remove(tabId), Chrome auto-closes
// the popup window if that was the only tab.

var DEFAULT_POPUP_WIDTH = 1280;
var DEFAULT_POPUP_HEIGHT = 800;
var DEFAULT_POPUP_LEFT = 0;
var DEFAULT_POPUP_TOP = 0;

// createScrapeTab(url, options?) → Promise<chrome.tabs.Tab>
//
// options:
//   width, height, left, top   — window geometry (default 1280x800 at 0,0)
//   focused                     — default false (don't steal keyboard focus)
//   type                        — default 'popup' (no browser chrome, smaller)
//
// Returns the tab object. Throws on chrome.windows.create failure or if the
// window has no tab (defensive — shouldn't happen with type:'popup' + url).
async function createScrapeTab(url, options) {
  options = options || {};
  var winOpts = {
    url: url,
    type: options.type || 'popup',
    focused: options.focused === undefined ? false : !!options.focused,
    width: options.width || DEFAULT_POPUP_WIDTH,
    height: options.height || DEFAULT_POPUP_HEIGHT,
    left: typeof options.left === 'number' ? options.left : DEFAULT_POPUP_LEFT,
    top: typeof options.top === 'number' ? options.top : DEFAULT_POPUP_TOP
  };
  var win = await chrome.windows.create(winOpts);
  if (!win) throw new Error('createScrapeTab: chrome.windows.create returned no window');
  var tab = (win.tabs && win.tabs[0]) || null;
  if (!tab) throw new Error('createScrapeTab: popup window opened with no tab');
  // Stash the windowId on the returned tab so callers that want to close
  // the entire popup window (not just the tab) can do so. chrome.tabs.remove
  // on the tab id will also close the popup window if it's the only tab,
  // so most callers don't need this — it's for diagnostics + explicit cleanup.
  tab._popupWindowId = win.id;
  return tab;
}

var api = {
  createScrapeTab: createScrapeTab,
  DEFAULT_POPUP_WIDTH: DEFAULT_POPUP_WIDTH,
  DEFAULT_POPUP_HEIGHT: DEFAULT_POPUP_HEIGHT,
  DEFAULT_POPUP_LEFT: DEFAULT_POPUP_LEFT,
  DEFAULT_POPUP_TOP: DEFAULT_POPUP_TOP
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ScrapeTab = api;
if (typeof self !== 'undefined') self.ScrapeTab = api;
