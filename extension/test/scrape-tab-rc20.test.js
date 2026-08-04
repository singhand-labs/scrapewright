// Regression test for the scrape-tab creation policy.
//
// === Current architecture (RC20) ===
//
// Scrape tabs are background tabs: chrome.tabs.create({active:false}). The
// user's keyboard focus stays in their editor. Brief tab activation during
// input-required DOM ops (lib/tab-activation.js) is the only layer that
// addresses Chrome's "compositor frames only for the active tab in the
// focused window" rule.
//
// === Removed in RC20 ===
//
// Popup-window path (chrome.windows.create({type:'popup', focused:false})):
// was RC12/RC17's attempt to get a visible tab. RC20 makes background tabs
// work via brief activation, so the popup path is dead code. The
// {usePopup:true} option is no longer supported.
//
// activateTabIfPermitted (RC18 Plan A — Page.setWebLifecycleState via
// chrome.debugger): was empirically "insufficient alone" — addresses page-
// lifecycle layer but not compositor frame production. RC20's brief
// activation makes lifecycle naturally ACTIVE during the window, so the call
// was pure overhead (debugger banner per scrape).
//
// What this test guards:
//   1. createScrapeTab uses chrome.tabs.create({active:false}) — no focus
//      steal, no popup window.
//   2. {usePopup:true} option is silently ignored (no popup window created).
//   3. afterTabOpen runs visibility-keepalive injection + verification.
//   4. closeScrapeTab just calls chrome.tabs.remove (idempotent).
//   5. Source-text audit: scrape-path call sites use createScrapeTab, never
//      chrome.tabs.create({active:false}) directly. No popup-window
//      references remain in production code.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRAPE_TAB_PATH = path.join(__dirname, '..', 'lib', 'scrape-tab.js');
const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');
const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');
const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');

function loadScrapeTabStandalone() {
  // Load lib/scrape-tab.js in a sandbox that fakes the chrome API + the
  // commonjs/window/self detection. Returns the { createScrapeTab } api.
  const calls = { tabsCreate: [], tabsRemove: [], inject: [], verify: [], warn: [], info: [] };
  const fakeChrome = {
    tabs: {
      create: async (opts) => {
        calls.tabsCreate.push(opts);
        return { id: 1, url: opts && opts.url };
      },
      remove: async (tabId) => { calls.tabsRemove.push(tabId); }
    }
  };
  const sandbox = {
    chrome: fakeChrome,
    module: { exports: {} },
    console: { log() {}, warn() {}, error() {} },
    debugLogger: {
      log(level, ns, msg, fields) {
        if (level === 'warn') calls.warn.push({ msg, fields });
        else calls.info.push({ msg, fields });
      }
    },
    injectVisibilityKeepalive: async (tabId) => {
      calls.inject.push(tabId);
      return { injected: true };
    },
    verifyVisibilityKeepalive: async (tabId) => {
      calls.verify.push(tabId);
      return { ok: true, visibilityState: 'visible' };
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(SCRAPE_TAB_PATH, 'utf8');
  vm.runInContext(src, sandbox);
  return { api: sandbox.module.exports, calls, fakeChrome };
}

describe('lib/scrape-tab.js — createScrapeTab uses background-tab path (RC20)', () => {
  it('chrome.tabs.create receives active:false by default', async () => {
    const { api, calls } = loadScrapeTabStandalone();
    await api.createScrapeTab('https://x.com');
    assert.equal(calls.tabsCreate.length, 1);
    assert.equal(calls.tabsCreate[0].active, false,
      'default path must create background tab — no focus steal');
    assert.equal(calls.tabsCreate[0].url, 'https://x.com');
  });

  it('{active:true} explicitly activates the tab when caller requests it', async () => {
    const { api, calls } = loadScrapeTabStandalone();
    await api.createScrapeTab('https://x.com', { active: true });
    assert.equal(calls.tabsCreate[0].active, true);
  });

  it('usePopup option is silently ignored (no popup window created)', async () => {
    // RC20 removed the popup path. Callers passing usePopup:true should not
    // crash; the option is just ignored.
    const { api, calls, fakeChrome } = loadScrapeTabStandalone();
    let windowsCreateCalled = false;
    fakeChrome.windows = { create: async () => { windowsCreateCalled = true; return { id: 99, tabs: [{ id: 1 }] }; } };
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    assert.equal(windowsCreateCalled, false,
      'popup path must not be invoked — usePopup option is no longer supported');
    assert.equal(calls.tabsCreate.length, 1,
      'must fall through to background-tab path');
    assert.equal(tab.id, 1);
  });

  it('afterTabOpen runs visibility-keepalive injection + verification', async () => {
    const { api, calls } = loadScrapeTabStandalone();
    await api.createScrapeTab('https://x.com');
    assert.equal(calls.inject.length, 1, 'injectVisibilityKeepalive must run');
    assert.equal(calls.verify.length, 1, 'verifyVisibilityKeepalive must run');
  });

  it('afterTabOpen logs warn (not crash) if injectVisibilityKeepalive is missing', async () => {
    const src = fs.readFileSync(SCRAPE_TAB_PATH, 'utf8');
    const sandbox = {
      chrome: { tabs: { create: async () => ({ id: 7 }) } },
      module: { exports: {} },
      console: { log() {}, warn() {}, error() {} },
      debugLogger: { log() {} }
      // injectVisibilityKeepalive intentionally NOT defined
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const api = sandbox.module.exports;
    const tab = await api.createScrapeTab('https://x.com');
    assert.equal(tab.id, 7, 'must still return the tab when keepalive is unavailable');
  });
});

describe('lib/scrape-tab.js — closeScrapeTab helper (RC20)', () => {
  it('calls chrome.tabs.remove with the tab id', async () => {
    const { api, calls } = loadScrapeTabStandalone();
    await api.closeScrapeTab({ id: 42 });
    assert.equal(calls.tabsRemove.length, 1);
    assert.equal(calls.tabsRemove[0], 42);
  });

  it('swallows errors when tab is already gone (idempotent cleanup)', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.tabs.remove = async () => { throw new Error('tab already gone'); };
    await api.closeScrapeTab({ id: 99 }); // must not throw
  });

  it('no-ops on null/undefined tab', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let called = false;
    fakeChrome.tabs.remove = async () => { called = true; };
    await api.closeScrapeTab(null);
    await api.closeScrapeTab(undefined);
    assert.equal(called, false, 'must not call chrome.tabs.remove for null/undefined');
  });
});

describe('RC20 source-text audit — scrape-path sites use createScrapeTab', () => {
  // The audit catches a future edit that re-introduces chrome.tabs.create
  // directly in wizard.js or background.js. Those files should always go
  // through createScrapeTab so the visibility-keepalive machinery runs.

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

  it('background.js has no popup-window references remaining', () => {
    const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    assert.ok(!/popupWindowsByTabId/.test(src),
      'background.js: popupWindowsByTabId must be removed — popup path is dead in RC20');
    assert.ok(!/_popupWindowId/.test(src),
      'background.js: _popupWindowId references must be removed');
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

  it('manifest.json declares "tabs" permission', () => {
    const src = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(src);
    assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes('tabs'),
      'manifest.json: permissions array must include "tabs"');
  });
});
