// extension/lib/tab-activation.js
//
// RC56: sticky tab activation. Replaces RC20's brief-activation (activate →
// op → restore), which caused activate/restore churn on back-to-back ops.
//
// New model:
//   - requestActivation switches to the scrape tab and KEEPS it active.
//   - The user's last manually-clicked tab is tracked via
//     chrome.tabs.onActivated; our own programmatic activations are
//     distinguished by a suppression set (tabIds of pending tabs.update)
//     recorded before each tabs.update.
//   - When a tab closes while it is the active tab of its window (scrape
//     tab auto-close), focus lands back on the last-clicked tab (focusing
//     its window if different). No valid target → Chrome default.
//   - State persists to chrome.storage.session: the MV3 service worker can
//     suspend between a user click and the scrape-tab close (wizard LLM
//     calls run in the page context with no SW traffic for minutes).
(function (global) {
  let lastUserTabId = null;           // user-clicked tab (survives our activations)
  let activeByWindow = new Map();     // windowId -> active tabId (every onActivated)
  const suppressTabs = new Set();     // tabIds of our own pending activations
  const suppressTimers = new Map();   // tabId -> safety timer
  let hydratePromise = null;          // once-only storage.session hydrate

  function hasTabsApi() {
    return typeof chrome !== 'undefined' && chrome.tabs &&
      typeof chrome.tabs.get === 'function' &&
      typeof chrome.tabs.update === 'function';
  }
  function hasWindowsApi() {
    return typeof chrome !== 'undefined' && chrome.windows &&
      typeof chrome.windows.getLastFocused === 'function';
  }
  function hasStorageSession() {
    return typeof chrome !== 'undefined' && chrome.storage &&
      typeof chrome.storage.session === 'object' &&
      chrome.storage.session !== null;
  }

  function persist() {
    if (!hasStorageSession()) return; // in-memory fallback (tests, old Chrome)
    try {
      Promise.resolve(chrome.storage.session.set({
        tabActivationState: {
          lastUserTabId: lastUserTabId,
          activeByWindow: Array.from(activeByWindow.entries())
        }
      })).catch(function () { /* fire-and-forget */ });
    } catch (e) { /* fire-and-forget */ }
  }

  function hydrate() {
    if (!hydratePromise) {
      hydratePromise = (async function () {
        if (!hasStorageSession()) return;
        try {
          const got = await chrome.storage.session.get('tabActivationState');
          const saved = got && got.tabActivationState;
          if (saved) {
            if (typeof saved.lastUserTabId === 'number') lastUserTabId = saved.lastUserTabId;
            if (Array.isArray(saved.activeByWindow)) activeByWindow = new Map(saved.activeByWindow);
          }
        } catch (e) { /* stay in-memory */ }
      })();
    }
    return hydratePromise;
  }

  async function handleTabActivated(activeInfo) {
    await hydrate();
    activeByWindow.set(activeInfo.windowId, activeInfo.tabId);
    if (suppressTabs.has(activeInfo.tabId)) {
      suppressTabs.delete(activeInfo.tabId);    // our own activation — not a user click
      const t = suppressTimers.get(activeInfo.tabId);
      if (t) { clearTimeout(t); suppressTimers.delete(activeInfo.tabId); }
      persist();
      return;
    }
    lastUserTabId = activeInfo.tabId;             // user (or untracked) activation
    persist();
  }

  async function handleTabRemoved(tabId, removeInfo) {
    await hydrate();
    if (removeInfo && removeInfo.isWindowClosing) {
      // The window is gone — its activeByWindow entry is stale.
      if (activeByWindow.delete(removeInfo.windowId)) persist();
      return;
    }
    const windowId = removeInfo && removeInfo.windowId;
    if (windowId === undefined) return;
    if (lastUserTabId === tabId) { lastUserTabId = null; persist(); }
    if (activeByWindow.get(windowId) !== tabId) return; // closing tab wasn't active
    const target = lastUserTabId;
    if (target === null || target === undefined || target === tabId) return; // Chrome default
    let tab;
    try { tab = await chrome.tabs.get(target); }
    catch (e) { lastUserTabId = null; persist(); return; } // stale id
    try { await chrome.tabs.update(target, { active: true }); }
    catch (e) { return; }
    if (tab.windowId !== windowId && chrome.windows &&
        typeof chrome.windows.update === 'function') {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    }
    activeByWindow.set(tab.windowId, target);
    persist();
  }

  function initTabActivationListeners() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    if (chrome.tabs.onActivated && typeof chrome.tabs.onActivated.addListener === 'function') {
      chrome.tabs.onActivated.addListener(handleTabActivated);
    }
    if (chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
      chrome.tabs.onRemoved.addListener(handleTabRemoved);
    }
  }

  async function requestActivation(tabId) {
    if (!hasTabsApi()) return { ok: false, reason: 'chrome.tabs unavailable' };
    if (typeof tabId !== 'number' || tabId <= 0) return { ok: false, reason: 'invalid tabId' };

    let scrapeTab;
    try { scrapeTab = await chrome.tabs.get(tabId); }
    catch (e) { return { ok: false, reason: 'tabs.get failed: ' + (e && e.message || String(e)) }; }

    if (scrapeTab.active) return { ok: true, activated: false, reason: 'already active' };

    if (hasWindowsApi()) {
      let lastFocused;
      try { lastFocused = await chrome.windows.getLastFocused(); } catch (e) {}
      if (lastFocused && scrapeTab.windowId !== lastFocused.id) {
        return { ok: false, crossWindow: true,
          reason: 'cross-window: scrape window ' + scrapeTab.windowId +
                  ' is not focused (focused=' + lastFocused.id + ')' };
      }
    }

    // Suppression set: onActivated fires for our own tabs.update too.
    suppressTabs.add(tabId);
    const oldTimer = suppressTimers.get(tabId);
    if (oldTimer) clearTimeout(oldTimer);
    suppressTimers.set(tabId, setTimeout(function () {
      suppressTabs.delete(tabId); suppressTimers.delete(tabId);
    }, 1000)); // safety: update no-op'd / event never arrived

    try { await chrome.tabs.update(tabId, { active: true }); }
    catch (e) {
      suppressTabs.delete(tabId);
      const t = suppressTimers.get(tabId);
      if (t) { clearTimeout(t); suppressTimers.delete(tabId); }
      return { ok: false, reason: 'tabs.update failed: ' + (e && e.message || String(e)) };
    }
    return { ok: true, activated: true }; // sticky: no restore
  }

  const api = {
    requestActivation: requestActivation,
    initTabActivationListeners: initTabActivationListeners,
    _getUserState: function () { return { lastUserTabId: lastUserTabId, activeByWindow: activeByWindow }; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.TabActivation = api;
  if (typeof self !== 'undefined') self.TabActivation = api;
  if (typeof window !== 'undefined') window.TabActivation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
