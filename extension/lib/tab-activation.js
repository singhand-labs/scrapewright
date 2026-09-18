// extension/lib/tab-activation.js
//
// RC56: sticky tab activation. Replaces RC20's brief-activation (activate →
// op → restore), which caused activate/restore churn on back-to-back ops.
//
// New model:
//   - requestActivation switches to the scrape tab and KEEPS it active.
//   - Forty-ninth log: it ALSO re-asserts WINDOW focus (raising the window,
//     un-minimizing it) when the window lost OS focus — the user authorized
//     execution priority over manual focus, because scroll lazy-load froze
//     on active-but-unfocused-window tabs. The content script's
//     needsWindowFocus evidence (real visibilityState/hasFocus from the
//     isolated world) triggers this even when Chrome's getLastFocused
//     cannot see the occlusion/other-app focus.
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
  const escalatedTabs = new Set();    // tabIds upgraded to window focus (graduated activation)
  let hydratePromise = null;          // once-only storage.session hydrate

  // Graduated activation (spec §3.A, 2026-09-18): tier decision driven by the
  // content-script's once-per-tab lazy-load profile probe. The profile is a
  // UNIVERSAL feature measurement (page-height growth / MutationObserver feed
  // mount counts) — no site lists.
  //
  //   'static' → zero activation: background tabs complete reads/extracts fine
  //              (visibility-keepalive covers page-JS self-checks); activating
  //              here was pure focus-stealing noise on non-lazy pages.
  //   'lazy'   → frame need: current sticky activation + window-focus
  //              enforcement (the forty-ninth-log user authorization is
  //              RETAINED for the tier that actually needs compositor frames).
  //              hover need: tab activation WITHOUT the window-focus steal on
  //              the first attempt — CDP input needs the active tab, but the
  //              user keeps their OS focus unless evidence says otherwise.
  //   undefined (probe failed / not yet probed / legacy stubs) → conservative
  //              current behavior, exactly as before this layer existed.
  const HOVER_ESCALATE_ON = ['dispatch-timeout', 'cdp-contention'];

  function decideActivation(pageProfile, need) {
    if (pageProfile === 'static') {
      // Eighty-fourth log: CDP hover input requires the ACTIVE tab (the
      // RC20 architectural rule) even on a static page — the blanket skip
      // made every first dispatch deterministically time out (2000ms) and
      // ride the escalation ledger. Static graduates only the WINDOW
      // focus; frame-need reads still finish in the background.
      if (need === 'hover') {
        return { activate: true, focusWindow: false, escalateOn: HOVER_ESCALATE_ON.slice() };
      }
      return { activate: false, reason: 'static page' };
    }
    if (pageProfile === 'lazy') {
      if (need === 'hover') {
        return { activate: true, focusWindow: false, escalateOn: HOVER_ESCALATE_ON.slice() };
      }
      return { activate: true, focusWindow: true };
    }
    // Unknown profile: keep the pre-graduated default (activate + window
    // focus when cross-window/hidden-evidence demands it). This is the path
    // every pre-existing stub takes, so RC20/RC56/49th-log behavior is intact.
    return { activate: true, focusWindow: true };
  }

  // A hover dispatch-failure receipt escalates the SAME tab's NEXT hover-tier
  // request to full window focus. Only environmental contention shapes
  // (timeout / debugger attach contention) escalate; deterministic capability
  // gates ("enhanced mode disabled") teach no-retry, not escalation.
  function matchesEscalateReason(reason) {
    if (typeof reason !== 'string') return false;
    return /timeout/i.test(reason) ||
           /attach failed/i.test(reason) ||
           /chrome\.debugger/i.test(reason) ||
           /cdp contention/i.test(reason);
  }

  function noteHoverDispatchFailure(tabId, reason) {
    if (typeof tabId !== 'number') return false;
    if (!matchesEscalateReason(reason)) return false;
    escalatedTabs.add(tabId);
    return true;
  }

  function hasTabsApi() {
    return typeof chrome !== 'undefined' && chrome.tabs &&
      typeof chrome.tabs.get === 'function' &&
      typeof chrome.tabs.update === 'function';
  }
  function hasWindowsApi() {
    return typeof chrome !== 'undefined' && chrome.windows &&
      typeof chrome.windows.getLastFocused === 'function';
  }

  // Forty-ninth log (2026-09-09): focus the scrape WINDOW. A tab can be the
  // active tab of its window and still produce zero compositor frames —
  // the window lost OS focus (the user is working elsewhere) or is
  // minimized/occluded, and scroll-driven lazy-load froze exactly there
  // while every activation request answered "already active". The user
  // explicitly authorized execution priority over manual focus: switch to
  // the tab automatically whenever the work needs it. Focus alone does NOT
  // restore a minimized window, so state:'normal' rides along.
  async function focusScrapeWindow(windowId) {
    if (typeof chrome === 'undefined' || !chrome.windows ||
        typeof chrome.windows.update !== 'function') return null;
    let win = null;
    if (typeof chrome.windows.get === 'function') {
      try { win = await chrome.windows.get(windowId); } catch (e) { win = null; }
    }
    const props = { focused: true };
    if (win && win.state === 'minimized') props.state = 'normal';
    try {
      await chrome.windows.update(windowId, props);
      return props;
    } catch (e) { return null; }
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
    escalatedTabs.delete(tabId); // graduated activation: escalation dies with the tab
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

  async function requestActivation(tabId, opts) {
    if (!hasTabsApi()) return { ok: false, reason: 'chrome.tabs unavailable' };
    if (typeof tabId !== 'number' || tabId <= 0) return { ok: false, reason: 'invalid tabId' };

    // Graduated activation (§3.A): the content script's lazy-load profile
    // picks the tier. Escalation sources: a prior hover dispatch failure with
    // a contention/timeout reason (noteHoverDispatchFailure ledger), or a
    // frame-starvation receipt from a background-completed op (content-script
    // __scrapewrightFrameStarved flag → payload.upgrade). A wrong probe costs
    // one upgraded retry, not a lost run.
    const decision = decideActivation(opts && opts.pageProfile, opts && opts.need);
    const escalated = escalatedTabs.has(tabId) || !!(opts && opts.upgrade);
    if (!decision.activate && !escalated) {
      return {
        ok: true, activated: false,
        skippedActivation: true, reason: decision.reason,
        pageProfile: (opts && opts.pageProfile) || undefined
      };
    }
    // Window-focus tier: the decision's tier, upgraded when evidence demands.
    const allowWindowFocus = decision.focusWindow || escalated;
    const upgradedActivation = (!decision.focusWindow && allowWindowFocus) ? true : undefined;

    let scrapeTab;
    try { scrapeTab = await chrome.tabs.get(tabId); }
    catch (e) { return { ok: false, reason: 'tabs.get failed: ' + (e && e.message || String(e)) }; }

    let crossWindow = false;
    if (hasWindowsApi()) {
      let lastFocused;
      try { lastFocused = await chrome.windows.getLastFocused(); } catch (e) {}
      if (lastFocused && scrapeTab.windowId !== lastFocused.id) {
        // Thirteenth log Mode A (2026-09-03): a fresh verify tab whose scrape
        // window lost focus could NEVER render — the old refusal returned
        // before activating, so the tab got zero compositor frames (page
        // stayed a 169px shell) and every downstream op failed empty.
        // Activation proceeds within the window; the forty-ninth log adds
        // the missing half below (raising the window too).
        crossWindow = true;
      }
    }

    // Forty-ninth log: the content script can see what Chrome's window APIs
    // cannot — document.visibilityState / document.hasFocus() read from the
    // ISOLATED world report the REAL page state (the MAIN-world
    // visibility-keepalive override cannot touch that side), so an occluded
    // window or an OS focus held by another application surfaces here as
    // forceWindowFocus even when getLastFocused still names the scrape window.
    const forceWindowFocus = !!(opts && opts.forceWindowFocus);
    let focusedProps = null;

    if (!scrapeTab.active) {
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
      // Cross-window used to deliberately NOT raise the window (thirteenth
      // log: within-window activation only, user OS focus untouched). The
      // forty-ninth log supersedes that: frame production requires the
      // focused window, and the user explicitly authorized focus priority
      // for correct execution over manual focus.
      if ((crossWindow || forceWindowFocus) && allowWindowFocus) {
        focusedProps = await focusScrapeWindow(scrapeTab.windowId);
      }
      return {
        ok: true, activated: true, // sticky: no restore
        crossWindow: crossWindow || undefined,
        focusedWindow: focusedProps ? true : undefined,
        upgradedActivation: upgradedActivation
      };
    }

    // Tab already active in its window. Forty-ninth log: this used to return
    // "already active" unconditionally — but a tab whose WINDOW lost OS
    // focus produces no frames either; the forty-ninth-log hover ops kept
    // answering "already active" while the feed froze at count 2 then 8.
    // Re-assert window focus when the evidence says the page is not
    // visible/focused.
    if ((crossWindow || forceWindowFocus) && allowWindowFocus) {
      focusedProps = await focusScrapeWindow(scrapeTab.windowId);
      return {
        ok: true, activated: false,
        focusedWindow: focusedProps ? true : undefined,
        reason: focusedWindowReason(focusedProps),
        upgradedActivation: upgradedActivation
      };
    }
    return { ok: true, activated: false, reason: 'already active' };
  }

  function focusedWindowReason(focusedProps) {
    return focusedProps ? 'window focus re-asserted' : 'already active';
  }

  const api = {
    requestActivation: requestActivation,
    initTabActivationListeners: initTabActivationListeners,
    decideActivation: decideActivation,
    noteHoverDispatchFailure: noteHoverDispatchFailure,
    _getUserState: function () { return { lastUserTabId: lastUserTabId, activeByWindow: activeByWindow }; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.TabActivation = api;
  if (typeof self !== 'undefined') self.TabActivation = api;
  if (typeof window !== 'undefined') window.TabActivation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
