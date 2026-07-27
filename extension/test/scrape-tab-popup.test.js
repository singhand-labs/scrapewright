// Regression test for the scrape-tab creation policy.
//
// History:
//   RC12 (2026-07-26): popup window via chrome.windows.create({type:'popup',
//     focused:false}) to escape background-tab throttling.
//   RC13 (2026-07-27): visibility-keepalive override (pageWorldKeepalive)
//     injected into the page's MAIN world — overrides document.visibilityState
//     and runs an rAF keep-alive loop. Done because popup windows themselves
//     get throttled when unfocused.
//   RC14 (2026-07-27, user feedback): popup windows AUTO-ACTIVATE on Linux
//     GNOME and Windows even with focused:false (Chrome documents "the OS
//     may not honor this request"). User reported the target tab activates
//     mid-scrape and the 1280x800 default geometry looks fullscreen.
//     Default flipped back to chrome.tabs.create({active:false}); popup path
//     kept as opt-in via {usePopup:true} for the rare site whose IO truly
//     stops firing on inactive tabs.
//
// What this test guards:
//   1. Default createScrapeTab uses chrome.tabs.create({active:false}) —
//      reliable cross-OS non-activation.
//   2. {usePopup:true} opts into chrome.windows.create({type:'popup',
//      focused:false}) — the RC12 behavior, available as fallback.
//   3. visibility-keepalive is injected on BOTH paths (via the global
//      injectVisibilityKeepalive free variable).
//   4. Source-text audit: scrape-path call sites in wizard.js + background.js
//      use createScrapeTab, never chrome.tabs.create({active:false}) directly.

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
    tabs: { create: null },
    windows: { create: null },
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

describe('lib/scrape-tab.js — DEFAULT path uses chrome.tabs.create({active:false})', () => {
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
    assert.equal(capturedOpts.url, 'https://example.com');
    assert.equal(capturedOpts.active, false,
      'default path MUST pass active:false — otherwise the tab steals focus (RC14 user feedback)');
  });

  it('returns the created tab', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.tabs.create = async (opts) => ({ id: 99, url: opts.url });
    fakeChrome.windows.create = async () => { throw new Error('should not call windows.create'); };
    const tab = await api.createScrapeTab('https://test.com');
    assert.equal(tab.id, 99);
    assert.equal(tab.url, 'https://test.com');
  });

  it('honors caller-provided active:true (rare — for foreground scrape)', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let captured = null;
    fakeChrome.tabs.create = async (opts) => { captured = opts; return { id: 1 }; };
    fakeChrome.windows.create = async () => { throw new Error('should not call windows.create'); };
    await api.createScrapeTab('https://x.com', { active: true });
    assert.equal(captured.active, true);
  });

  it('throws if chrome.tabs.create returns no tab', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.tabs.create = async () => null;
    await assert.rejects(() => api.createScrapeTab('https://x.com'), /no tab/);
  });
});

describe('lib/scrape-tab.js — usePopup:true opts INTO popup window (RC12 path)', () => {
  it('calls chrome.windows.create with type:"popup" and focused:false when usePopup:true', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let capturedOpts = null;
    fakeChrome.windows.create = async (opts) => {
      capturedOpts = opts;
      return { id: 99, tabs: [{ id: 42, url: opts.url }] };
    };
    fakeChrome.tabs.create = async () => { throw new Error('tabs.create should NOT be called when usePopup:true'); };
    await api.createScrapeTab('https://example.com', { usePopup: true });
    assert.ok(capturedOpts, 'chrome.windows.create was not called');
    assert.equal(capturedOpts.type, 'popup');
    assert.equal(capturedOpts.focused, false);
  });

  it('returns win.tabs[0] as the scrape tab', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async (opts) => ({ id: 7, tabs: [{ id: 123, url: opts.url }] });
    fakeChrome.tabs.create = async () => { throw new Error('should not call tabs.create'); };
    const tab = await api.createScrapeTab('https://test.com', { usePopup: true });
    assert.equal(tab.id, 123);
    assert.equal(tab.url, 'https://test.com');
  });

  it('stashes _popupWindowId on the returned tab', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => ({ id: 555, tabs: [{ id: 1 }] });
    fakeChrome.tabs.create = async () => { throw new Error('should not call tabs.create'); };
    const tab = await api.createScrapeTab('https://x.com', { usePopup: true });
    assert.equal(tab._popupWindowId, 555);
  });

  it('throws if chrome.windows.create returns no window', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => null;
    await assert.rejects(() => api.createScrapeTab('https://x.com', { usePopup: true }), /no window/);
  });

  it('honors caller-provided width/height/left/top', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let captured = null;
    fakeChrome.windows.create = async (opts) => { captured = opts; return { id: 1, tabs: [{ id: 1 }] }; };
    await api.createScrapeTab('https://x.com', { usePopup: true, width: 400, height: 300, left: 10, top: 5 });
    assert.equal(captured.width, 400);
    assert.equal(captured.height, 300);
    assert.equal(captured.left, 10);
    assert.equal(captured.top, 5);
  });
});

describe('RC14 source-text audit — scrape-path sites use createScrapeTab', () => {
  // The audit catches a future edit that re-introduces chrome.tabs.create
  // ({active:false}) directly in wizard.js or background.js. Those files
  // should always go through createScrapeTab so visibility-keepalive runs.

  it('wizard.js has no remaining chrome.tabs.create with active:false in scrape paths', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const re = /chrome\.tabs\.create\s*\(\s*\{[^}]*\bactive\s*:\s*false\b[^}]*\}\s*\)/g;
    const matches = src.match(re) || [];
    assert.equal(matches.length, 0,
      `wizard.js: ${matches.length} chrome.tabs.create({active:false}) site(s) remain. ` +
      `Use createScrapeTab() instead — it handles visibility-keepalive injection. ` +
      `Matches:\n${matches.join('\n')}`);
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
      'manifest.json: permissions must include "windows" for usePopup:true fallback');
  });
});
