// Regression test for the scrape-tab creation policy.
//
// History:
//   RC12 (2026-07-26): popup window via chrome.windows.create({type:'popup',
//     focused:false}) to escape background-tab throttling.
//   RC13 (2026-07-27): visibility-keepalive override (pageWorldKeepalive)
//     injected into the page's MAIN world — overrides document.visibilityState
//     and runs an rAF keep-alive loop.
//   RC14 (2026-07-27, user feedback): popup windows AUTO-ACTIVATE on Linux
//     GNOME and Windows even with focused:false. Default flipped back to
//     chrome.tabs.create({active:false}); popup path kept as opt-in.
//   RC17 (2026-07-27, console.log 17:02–17:08): visibility-keepalive override
//     alone is INSUFFICIENT — verification confirms override sticks but scroll
//     uniqueCount still flatlines. Default flipped BACK to popup window with
//     immediate focus restoration.
//   RC18 (2026-07-28, console.log 03:43–03:52, THIS VERSION): Plan A
//     (chrome.debugger transient attach + Page.setWebLifecycleState) reported
//     ok:true across 3 scrape runs but uniqueCount flatlined anyway —
//     9→9→9→9→9 (exhausted), 3→7→7→7→15 (partial), 2→2→2→2 (exhausted).
//     Plan A addresses the page-lifecycle layer but NOT the compositor frame-
//     production layer that gates IntersectionObserver. Default flipped BACK
//     to background tab. The actual fix for lazy-load sites is Plan B'-1
//     (scrapewright throttle on → Chrome launch flags --disable-renderer-
//     backgrounding etc.). Popup path survives as opt-in via usePopup:true.
//
// What this test guards:
//   1. Default createScrapeTab uses chrome.tabs.create({active:false}) — no
//      focus steal, relies on Plan B'-1 launch flags for frame production.
//   2. {usePopup:true} opts INTO popup-window path (chrome.windows.create)
//      for rare cases that need physical visibility.
//   3. On the popup path, chrome.windows.update(prevWinId, {focused:true})
//      restores focus to user's previous window (mitigates GNOME stealing).
//   4. closeScrapeTab helper closes the popup window when present, else the
//      standalone tab.
//   5. Source-text audit: scrape-path call sites use createScrapeTab, never
//      chrome.tabs.create({active:false}) directly.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRAPE_TAB_PATH = path.join(__dirname, '..', 'lib', 'scrape-tab.js');
const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');
const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');
const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');

function loadScrapeTabStandalone() {
  // Load lib/scrape-tab.js in a sandbox that fakes the chrome API + the
  // commonjs/window/self detection. Returns the { createScrapeTab } api.
  const src = fs.readFileSync(SCRAPE_TAB_PATH, 'utf8');
  const fakeChrome = {
    tabs: { create: null, remove: null },
    windows: { create: null, getLastFocused: null, update: null, remove: null },
    scripting: { executeScript: async () => [{ result: true }] }
  };
  const sandbox = {
    chrome: fakeChrome,
    module: { exports: {} },
    console: { log: () => {} }
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function('chrome', 'module', 'console', 'injectVisibilityKeepalive', src);
  factory(sandbox.chrome, sandbox.module, sandbox.console, async () => ({ ok: true }));
  return { api: sandbox.module.exports, fakeChrome };
}

describe('lib/scrape-tab.js — RC18 DEFAULT path uses chrome.tabs.create (background tab)', () => {
  it('calls chrome.tabs.create with active:false by default', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let capturedOpts = null;
    fakeChrome.tabs.create = async (opts) => {
      capturedOpts = opts;
      return { id: 42, url: opts.url };
    };
    fakeChrome.windows.create = async () => { throw new Error('windows.create should NOT be called by default'); };
    await api.createScrapeTab('https://example.com');
    assert.ok(capturedOpts, 'chrome.tabs.create was not called');
    assert.equal(capturedOpts.active, false,
      'default path MUST pass active:false — no focus steal; relies on Plan B\'-1 launch flags for frame production');
  });

  it('does NOT set _popupWindowId on the returned tab by default', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.tabs.create = async () => ({ id: 42 });
    fakeChrome.windows.create = async () => { throw new Error('should not call windows.create'); };
    const tab = await api.createScrapeTab('https://x.com');
    assert.equal(tab._popupWindowId, undefined,
      'default background-tab path must not stash _popupWindowId');
  });

  it('honors caller-provided active:true (rare — for foreground scrape)', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let captured = null;
    fakeChrome.tabs.create = async (opts) => { captured = opts; return { id: 1 }; };
    fakeChrome.windows.create = async () => { throw new Error('should not call windows.create'); };
    await api.createScrapeTab('https://x.com', { active: true });
    assert.equal(captured.active, true);
  });
});

describe('lib/scrape-tab.js — usePopup:true opts INTO popup-window path', () => {
  it('calls chrome.windows.create with type:"popup" and focused:false when usePopup:true', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let capturedOpts = null;
    fakeChrome.windows.create = async (opts) => {
      capturedOpts = opts;
      return { id: 99, tabs: [{ id: 42, url: opts.url }] };
    };
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    fakeChrome.windows.update = async () => ({});
    fakeChrome.tabs.create = async () => { throw new Error('tabs.create should NOT be called when usePopup:true'); };
    await api.createScrapeTab('https://example.com', { usePopup: true });
    assert.ok(capturedOpts, 'chrome.windows.create was not called');
    assert.equal(capturedOpts.type, 'popup',
      'popup path MUST use type:"popup" so the scrape tab is the active tab in its own window');
    assert.equal(capturedOpts.focused, false,
      'popup path MUST pass focused:false — focus is restored separately via chrome.windows.update');
  });

  it('stashes _popupWindowId on the returned tab when usePopup:true', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => ({ id: 555, tabs: [{ id: 1 }] });
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    fakeChrome.windows.update = async () => ({});
    fakeChrome.tabs.create = async () => { throw new Error('should not call tabs.create'); };
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    assert.equal(tab._popupWindowId, 555);
  });

  it('throws if chrome.windows.create returns no window', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => null;
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    await assert.rejects(() => api.createScrapeTab('https://x.com', { usePopup: true }), /no window/);
  });

  it('honors caller-provided width/height/left/top on popup path', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let captured = null;
    fakeChrome.windows.create = async (opts) => { captured = opts; return { id: 1, tabs: [{ id: 1 }] }; };
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    fakeChrome.windows.update = async () => ({});
    await api.createScrapeTab('https://x.com', { usePopup: true, width: 400, height: 300, left: 10, top: 5 });
    assert.equal(captured.width, 400);
    assert.equal(captured.height, 300);
    assert.equal(captured.left, 10);
    assert.equal(captured.top, 5);
  });
});

describe('lib/scrape-tab.js — popup focus restoration (mitigates GNOME focus-stealing)', () => {
  it('captures previous focused window BEFORE creating popup', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    const calls = [];
    fakeChrome.windows.getLastFocused = async () => { calls.push('getLastFocused'); return { id: 7 }; };
    fakeChrome.windows.create = async () => { calls.push('create'); return { id: 99, tabs: [{ id: 1 }] }; };
    fakeChrome.windows.update = async () => { calls.push('update'); };
    await api.createScrapeTab('https://x.com', { usePopup: true });
    assert.deepEqual(calls, ['getLastFocused', 'create', 'update'],
      'order MUST be: capture previous → create popup → restore previous. Got: ' + JSON.stringify(calls));
  });

  it('restores focus to the previously-focused window via chrome.windows.update', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let updateArgs = null;
    fakeChrome.windows.getLastFocused = async () => ({ id: 42 });
    fakeChrome.windows.create = async () => ({ id: 99, tabs: [{ id: 1 }] });
    fakeChrome.windows.update = async (winId, opts) => { updateArgs = { winId, opts }; };
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    assert.ok(updateArgs, 'chrome.windows.update was not called');
    assert.equal(updateArgs.winId, 42,
      'must restore focus to user\'s previous window (id 42), got: ' + updateArgs.winId);
    assert.deepEqual(updateArgs.opts, { focused: true });
    assert.equal(tab._popupWindowRestoredFocus, true);
  });

  it('skips focus restoration when restoreFocus:false', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let updateCalled = false;
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    fakeChrome.windows.create = async () => ({ id: 99, tabs: [{ id: 1 }] });
    fakeChrome.windows.update = async () => { updateCalled = true; };
    await api.createScrapeTab('https://x.com', { usePopup: true, restoreFocus: false });
    assert.equal(updateCalled, false,
      'chrome.windows.update must NOT be called when restoreFocus:false');
  });

  it('tolerates missing chrome.windows.getLastFocused (headless / sandbox)', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    delete fakeChrome.windows.getLastFocused;
    fakeChrome.windows.create = async () => ({ id: 99, tabs: [{ id: 1 }] });
    fakeChrome.windows.update = async () => ({});
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    assert.equal(tab.id, 1);
    assert.equal(tab._popupWindowRestoredFocus, false);
  });

  it('tolerates chrome.windows.update failure', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    fakeChrome.windows.create = async () => ({ id: 99, tabs: [{ id: 1 }] });
    fakeChrome.windows.update = async () => { throw new Error('window gone'); };
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    assert.equal(tab.id, 1,
      'popup creation succeeds even if focus restoration fails — restoration is best-effort');
    assert.equal(tab._popupWindowRestoredFocus, false);
  });
});

describe('lib/scrape-tab.js — closeScrapeTab helper closes popup window when present', () => {
  it('calls chrome.windows.remove when tab has _popupWindowId', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let removedWindow = null;
    let removedTab = null;
    fakeChrome.windows.create = async () => ({ id: 555, tabs: [{ id: 42 }] });
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    fakeChrome.windows.update = async () => ({});
    fakeChrome.windows.remove = async (winId) => { removedWindow = winId; };
    fakeChrome.tabs.remove = async (tabId) => { removedTab = tabId; };
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    await api.closeScrapeTab(tab);
    assert.equal(removedWindow, 555, 'must close popup window by its id');
    assert.equal(removedTab, null, 'must NOT call chrome.tabs.remove when popup window is present');
  });

  it('falls back to chrome.tabs.remove when tab has no _popupWindowId', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let removedWindow = null;
    let removedTab = null;
    fakeChrome.tabs.create = async () => ({ id: 42 });
    fakeChrome.windows.remove = async (winId) => { removedWindow = winId; };
    fakeChrome.tabs.remove = async (tabId) => { removedTab = tabId; };
    const tab = await api.createScrapeTab('https://x.com');
    await api.closeScrapeTab(tab);
    assert.equal(removedTab, 42, 'must close standalone tab by its id');
    assert.equal(removedWindow, null, 'must NOT call chrome.windows.remove when no popup window');
  });

  it('swallows errors when window is already gone (idempotent cleanup)', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => ({ id: 555, tabs: [{ id: 42 }] });
    fakeChrome.windows.getLastFocused = async () => ({ id: 7 });
    fakeChrome.windows.update = async () => ({});
    fakeChrome.windows.remove = async () => { throw new Error('window already gone'); };
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    await api.closeScrapeTab(tab); // should not throw
  });

  it('no-ops on null/undefined tab', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.remove = async () => { throw new Error('should not be called'); };
    fakeChrome.tabs.remove = async () => { throw new Error('should not be called'); };
    await api.closeScrapeTab(null);
    await api.closeScrapeTab(undefined);
  });
});

describe('RC18 source-text audit — scrape-path sites use createScrapeTab', () => {
  // The audit catches a future edit that re-introduces chrome.tabs.create
  // directly in wizard.js or background.js. Those files should always go
  // through createScrapeTab so the visibility-keepalive + (opt-in) Plan A
  // machinery runs.

  it('wizard.js has no remaining chrome.tabs.create with active:false in scrape paths', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const re = /chrome\.tabs\.create\s*\(\s*\{[^}]*\bactive\s*:\s*false\b[^}]*\}\s*\)/g;
    const matches = src.match(re) || [];
    assert.equal(matches.length, 0,
      `wizard.js: ${matches.length} chrome.tabs.create({active:false}) site(s) remain. ` +
      `Use createScrapeTab() instead. Matches:\n${matches.join('\n')}`);
  });

  it('background.js has no remaining chrome.tabs.create with active:false in scrape paths', () => {
    const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    const re = /chrome\.tabs\.create\s*\(\s*\{[^}]*\bactive\s*:\s*false\b[^}]*\}\s*\)/g;
    const matches = src.match(re) || [];
    assert.equal(matches.length, 0,
      `background.js: ${matches.length} chrome.tabs.create({active:false}) site(s) remain. ` +
      `Use createScrapeTab() instead.`);
  });

  it('wizard.js scrape-path sites use createScrapeTab (testScript + research + detail)', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const count = (src.match(/\bcreateScrapeTab\s*\(/g) || []).length;
    assert.ok(count >= 5, `wizard.js: expected ≥5 createScrapeTab call sites, found ${count}`);
  });

  it('background.js scrape-path sites use createScrapeTab (production + $openTab)', () => {
    const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    const count = (src.match(/\bcreateScrapeTab\s*\(/g) || []).length;
    assert.ok(count >= 2, `background.js: expected ≥2 createScrapeTab call sites, found ${count}`);
  });

  it('background.js handles popup window cleanup via closeScrapeTab or popupWindowsByTabId', () => {
    // Popup-window cleanup must close the host window, not just the tab.
    // Audit that background.js either uses closeScrapeTab OR the
    // popupWindowsByTabId Map at removeTab time.
    const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    const usesCloseHelper = /\bcloseScrapeTab\s*\(/.test(src);
    const usesPopupMap = /popupWindowsByTabId/.test(src);
    assert.ok(usesCloseHelper || usesPopupMap,
      'background.js: must handle popup-window cleanup — use closeScrapeTab(tab) or ' +
      'consult popupWindowsByTabId before falling back to chrome.tabs.remove.');
  });

  it('lib/scrape-tab.js is loaded by background.js (importScripts)', () => {
    const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    assert.ok(src.includes("'lib/scrape-tab.js'") || src.includes('"lib/scrape-tab.js"'),
      'background.js: importScripts must include lib/scrape-tab.js');
  });

  it('lib/scrape-tab.js is loaded by wizard.html (script tag)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
    assert.ok(/src=["']lib\/scrape-tab\.js["']/.test(src),
      'wizard.html: <script> tags must include lib/scrape-tab.js');
  });

  it('manifest.json declares both "windows" and "tabs" permissions', () => {
    const src = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(src);
    assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes('tabs'),
      'manifest.json: permissions array must include "tabs"');
    assert.ok(manifest.permissions.includes('windows'),
      'manifest.json: permissions must include "windows" (used by popup-window opt-in path)');
  });
});
