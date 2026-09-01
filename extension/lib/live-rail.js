// extension/lib/live-rail.js
//
// The session's live page rail (spec §2): ONE scrape tab plus the wizard
// page's exec lock, both owned here. The lock is acquired lazily on first
// rail use and held across turns — per-call acquire/release would let API
// jobs interleave between our OffscreenExecutor uses and cross-contaminate
// the shared offscreen tabIdStack (background.js's ACQUIRE_EXEC_LOCK
// resolves a single _wizardResolve slot, so exactly-once is structural:
// a second acquire before release leaks a permanent queue blocker).
//
// Release points live with the session lifecycle (pause/stop/dispose) and
// the annotation bridge (user interaction windows), not with each probe.
//
// All environment access is injected. IIFE-wrapped per RC30.
// Optional deps (getTab, pingReady) are read at call time — callers may swap them after construction.

(function (global) {

  const REQUIRED = ['createTab', 'removeTab', 'waitForTabLoad', 'execute', 'acquireLock', 'releaseLock'];

  function createLiveRail(deps) {
    const d = deps || {};
    for (const k of REQUIRED) {
      if (typeof d[k] !== 'function') throw new Error('createLiveRail requires a ' + k + '() function');
    }
    const defaultUrl = typeof d.defaultUrl === 'string' ? d.defaultUrl : '';
    const log = typeof d.log === 'function' ? d.log : function () {};

    let currentTab = null;
    let lockHeld = false;
    let opening = null;

    async function ensureLock() {
      if (lockHeld) return;
      try {
        await d.acquireLock();
        lockHeld = true;
      } catch (e) {
        log('warn', 'Could not acquire exec lock (background may be unavailable): ' + String((e && e.message) || e));
      }
    }

    async function releaseLock() {
      if (!lockHeld) return;
      try {
        await d.releaseLock();
        lockHeld = false;
      } catch (e) {
        log('warn', 'Could not release exec lock (background may be unavailable); will retry on next release/dispose');
      }
    }

    async function closeTab() {
      if (!currentTab) return;
      const t = currentTab;
      currentTab = null;
      try { await d.removeTab(t.id); } catch (e) { /* idempotent close */ }
    }

    async function pageOpen(args) {
      const a = args && typeof args === 'object' ? args : {};
      const url = (typeof a.url === 'string' && a.url.trim()) ? a.url.trim() : defaultUrl;
      if (!url) return { error: 'url required (no default target URL configured)' };
      if (!/^https?:\/\//i.test(url)) return { error: 'url must be http(s)' };
      if (opening) return { error: 'page open already in progress — wait for it to finish, then retry' };
      opening = (async () => {
        await closeTab();
        await ensureLock();
        let tab = null;
        try {
          tab = await d.createTab(url);
        } catch (e) {
          return { error: 'tab creation failed: ' + String((e && e.message) || e) };
        }
        currentTab = { id: tab.id, url: url };
        let warning = null;
        try {
          await d.waitForTabLoad(tab.id);
        } catch (e) {
          warning = 'load timeout: ' + String((e && e.message) || e);
        }
        let ready = true;
        if (typeof d.pingReady === 'function') {
          try { ready = await d.pingReady(tab.id); }
          catch (e) { ready = false; }
        }
        const out = { tabId: tab.id, url: url, ready: !!ready };
        if (warning) out.warning = warning;
        else if (!ready) out.warning = 'content script not responding yet';
        return out;
      })();
      try {
        return await opening;
      } finally {
        opening = null;
      }
    }

    async function pageState() {
      if (!currentTab) return { open: false, hint: 'no page open — call page.open first' };
      if (!d.getTab) return { open: true, tabId: currentTab.id, url: currentTab.url };
      let t = null;
      try { t = await d.getTab(currentTab.id); } catch (e) { t = null; }
      if (!t) {
        currentTab = null;
        return { open: false, hint: 'tab closed — re-open via page.open, then replay from ledger findings instead of re-discovering the page' };
      }
      return {
        open: true,
        tabId: t.id,
        url: String(t.url || currentTab.url),
        title: String(t.title || ''),
        status: String(t.status || '')
      };
    }

    async function executeDsl(snippet) {
      if (typeof snippet !== 'string' || !snippet.trim()) return { error: 'snippet required' };
      if (!currentTab) return { error: 'no page open — call page.open first' };
      await ensureLock();
      // best-effort: if the lock could not be taken, background is usually unreachable and execute() will fail with its own error
      try {
        return await d.execute(currentTab.id, snippet);
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }

    async function dispose() {
      if (opening) { try { await opening; } catch (e) { /* opening resolves to result objects; guard anyway */ } }
      await closeTab();
      await releaseLock();
    }

    return {
      pageOpen: pageOpen,
      pageState: pageState,
      executeDsl: executeDsl,
      ensureLock: ensureLock,
      releaseLock: releaseLock,
      dispose: dispose,
      get tabId() { return currentTab ? currentTab.id : null; }
    };
  }

  const api = { createLiveRail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LiveRail = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
