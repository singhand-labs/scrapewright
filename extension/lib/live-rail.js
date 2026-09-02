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
    // Audit C3: page epoch — 0 = no page open; 1 = fresh page.open; +1 for
    // every same-tab reload/navigation observed via deps.watchTab. Probe
    // receipts are stamped with this number; the grounding gate only honors
    // receipts from the current epoch, so a mid-session reload invalidates
    // all prior DOM evidence instead of silently admitting stale selectors.
    let epoch = 0;
    let unwatchTab = null;

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

    function disengageWatch() {
      if (unwatchTab) {
        try { unwatchTab(); } catch (e) { /* best-effort */ }
        unwatchTab = null;
      }
    }

    function engageWatch(tabId) {
      disengageWatch();
      if (typeof d.watchTab !== 'function') return;
      try {
        unwatchTab = d.watchTab(tabId, function onReload() {
          epoch += 1;
          log('warn', 'Research tab reloaded (same tabId) — page epoch is now ' + epoch +
            '; observation receipts recorded in earlier epochs no longer ground selectors.');
        });
      } catch (e) { /* watching is best-effort */ }
    }

    async function closeTab() {
      if (!currentTab) return;
      const t = currentTab;
      currentTab = null;
      epoch = 0;
      disengageWatch();
      try { await d.removeTab(t.id); } catch (e) { /* idempotent close */ }
    }

    async function pageOpen(args) {
      const a = args && typeof args === 'object' ? args : {};
      const url = (typeof a.url === 'string' && a.url.trim()) ? a.url.trim() : defaultUrl;
      if (!url) return { error: 'url required (no default target URL configured)' };
      if (!/^https?:\/\//i.test(url)) return { error: 'url must be http(s)' };
      // First-live-log P-E: the research tab shows the LITERAL placeholder —
      // the rail does no template substitution (verify.run does, from input).
      // Surfacing this once per open stops the LLM from treating the literal
      // as the real page contract.
      const tmpl = url.match(/\{\{\s*\w+\s*\}\}/g);
      const templateWarn = tmpl && tmpl.length
        ? 'url template parameter(s) unreplaced in the research tab (' + tmpl.join(', ') + ') — probes run against the literal placeholder; verify.run substitutes them from input'
        : null;
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
        epoch = 1;
        engageWatch(tab.id);
        let ready = true;
        if (typeof d.pingReady === 'function') {
          try { ready = await d.pingReady(tab.id); }
          catch (e) { ready = false; }
        }
        const out = { tabId: tab.id, url: url, ready: !!ready };
        if (warning) out.warning = warning;
        else if (templateWarn) out.warning = templateWarn;
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
        epoch = 0;
        disengageWatch();
        return { open: false, hint: 'tab closed — re-open via page.open, then replay from ledger findings instead of re-discovering the page' };
      }
      return {
        open: true,
        tabId: t.id,
        url: String(t.url || currentTab.url),
        title: String(t.title || ''),
        status: String(t.status || ''),
        epoch: epoch
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
      get tabId() { return currentTab ? currentTab.id : null; },
      get epoch() { return epoch; }
    };
  }

  const api = { createLiveRail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LiveRail = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
