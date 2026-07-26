// Regression test for the RC12 background-tab render-throttling fix.
//
// console.log 2026-07-26 16:30 (background tab) vs 16:32 (foreground tab):
//   - BG: postCount=7 initially, uniqueCount stays at 4 across 16 scroll
//     iterations, r.scrolled=false from iter 2 onward → 3 posts extracted
//   - FG: postCount=13 initially, uniqueCount=10 on iter 1 → 10 posts
//
// Root cause: chrome.tabs.create({active:false}) leaves the renderer in a
// state where IntersectionObserver-based lazy-load (FB feed, Twitter,
// infinite scroll) doesn't fire. The scroll code itself was working
// correctly — the page just never loaded more posts to scroll to.
//
// Fix: replace all `chrome.tabs.create({url, active:false})` scrape-path
// sites with `createScrapeTab(url)` (lib/scrape-tab.js), which opens a
// popup window via chrome.windows.create({type:'popup', focused:false}).
// Popup windows render normally even when not focused, so lazy-load fires.
//
// This test guards TWO layers:
//   1. lib/scrape-tab.js API behavior — calls chrome.windows.create with
//      type:'popup' and focused:false, returns win.tabs[0]
//   2. All scrape-path call sites use createScrapeTab, not
//      chrome.tabs.create({active:false}) — source-text audit so a future
//      edit can't silently revert

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
  const fakeChrome = { windows: { create: null } };
  const sandbox = {
    chrome: fakeChrome,
    module: { exports: {} },
    console: { log: () => {} }
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function('chrome', 'module', 'console', src);
  factory(sandbox.chrome, sandbox.module, sandbox.console);
  return { api: sandbox.module.exports, fakeChrome };
}

describe('lib/scrape-tab.js — createScrapeTab behavior', () => {
  it('calls chrome.windows.create with type:"popup" and focused:false by default', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let capturedOpts = null;
    fakeChrome.windows.create = async (opts) => {
      capturedOpts = opts;
      return { id: 99, tabs: [{ id: 42, url: opts.url }] };
    };
    await api.createScrapeTab('https://example.com');
    assert.ok(capturedOpts, 'chrome.windows.create was not called');
    assert.equal(capturedOpts.type, 'popup');
    assert.equal(capturedOpts.focused, false);
    assert.equal(capturedOpts.url, 'https://example.com');
  });

  it('returns win.tabs[0] as the scrape tab', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async (opts) => ({
      id: 7,
      tabs: [{ id: 123, url: opts.url, pendingUrl: undefined }]
    });
    const tab = await api.createScrapeTab('https://test.com');
    assert.equal(tab.id, 123);
    assert.equal(tab.url, 'https://test.com');
  });

  it('stashes _popupWindowId on the returned tab for callers that want to close the window explicitly', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => ({ id: 555, tabs: [{ id: 1 }] });
    const tab = await api.createScrapeTab('https://x.com');
    assert.equal(tab._popupWindowId, 555);
  });

  it('throws if chrome.windows.create returns no window', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => null;
    await assert.rejects(() => api.createScrapeTab('https://x.com'), /no window/);
  });

  it('throws if the window has no tabs', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    fakeChrome.windows.create = async () => ({ id: 1, tabs: [] });
    await assert.rejects(() => api.createScrapeTab('https://x.com'), /no tab/);
  });

  it('honors caller-provided width/height/left/top', async () => {
    const { api, fakeChrome } = loadScrapeTabStandalone();
    let captured = null;
    fakeChrome.windows.create = async (opts) => { captured = opts; return { id: 1, tabs: [{ id: 1 }] }; };
    await api.createScrapeTab('https://x.com', { width: 1024, height: 768, left: 100, top: 50 });
    assert.equal(captured.width, 1024);
    assert.equal(captured.height, 768);
    assert.equal(captured.left, 100);
    assert.equal(captured.top, 50);
  });

  it('does NOT call chrome.tabs.create (the regression we are guarding against)', async () => {
    // The whole point of RC12: never go back to chrome.tabs.create({active:false}).
    // Fake the chrome object so any tabs.create call would crash the test.
    const src = fs.readFileSync(SCRAPE_TAB_PATH, 'utf8');
    const fakeChrome = {
      windows: { create: async (opts) => ({ id: 1, tabs: [{ id: 1, url: opts.url }] }) },
      tabs: { create: () => { throw new Error('REGRESSION: createScrapeTab called chrome.tabs.create'); } }
    };
    const sandbox = { chrome: fakeChrome, module: { exports: {} }, console: { log: () => {} } };
    // eslint-disable-next-line no-new-func
    const factory = new Function('chrome', 'module', 'console', src);
    factory(sandbox.chrome, sandbox.module, sandbox.console);
    const tab = await sandbox.module.exports.createScrapeTab('https://x.com');
    assert.equal(tab.id, 1);
  });
});

describe('RC12 source-text audit — no scrape-path site reverts to chrome.tabs.create({active:false})', () => {
  // The user's bug report (2026-07-26 16:30 background tab vs 16:32 foreground
  // tab) only manifested because every scrape-path call site used
  // chrome.tabs.create({active:false}). This audit fails loudly if a future
  // edit reintroduces that pattern in the scrape paths.
  //
  // Allowed remaining sites: chrome.tabs.create({ url, active: true }) in
  // wizard.js (the user-interactive "Open Tab for Annotation" button and
  // the post-deploy "open the result" button) — these are NOT scrape paths,
  // they're user-facing UI actions where activation is desired.

  it('wizard.js has no remaining chrome.tabs.create with active:false', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    // Match `chrome.tabs.create({ ... active: false ... })` allowing any
    // whitespace and any key order.
    const re = /chrome\.tabs\.create\s*\(\s*\{[^}]*\bactive\s*:\s*false\b[^}]*\}\s*\)/g;
    const matches = src.match(re) || [];
    assert.equal(matches.length, 0,
      `wizard.js: ${matches.length} chrome.tabs.create({active:false}) site(s) remain. ` +
      `RC12 replaced these with createScrapeTab() — see lib/scrape-tab.js. ` +
      `Matches:\n${matches.join('\n')}`);
  });

  it('background.js has no remaining chrome.tabs.create with active:false', () => {
    const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    const re = /chrome\.tabs\.create\s*\(\s*\{[^}]*\bactive\s*:\s*false\b[^}]*\}\s*\)/g;
    const matches = src.match(re) || [];
    assert.equal(matches.length, 0,
      `background.js: ${matches.length} chrome.tabs.create({active:false}) site(s) remain. ` +
      `RC12 replaced these with createScrapeTab(). Matches:\n${matches.join('\n')}`);
  });

  it('wizard.js scrape-path sites use createScrapeTab (testScript + research + detail)', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const count = (src.match(/\bcreateScrapeTab\s*\(/g) || []).length;
    // 1. testScript (wizard.js ~1734)
    // 2. research/annotation tab (wizard.js ~1588)
    // 3. detail-page snapshot during step generation (wizard.js ~1512)
    // 4. detail-page snapshot during improve() (wizard.js ~1962)
    // 5. detail-page snapshot during autoFix (wizard.js ~2489)
    assert.ok(count >= 5, `wizard.js: expected ≥5 createScrapeTab call sites, found ${count}`);
  });

  it('background.js scrape-path sites use createScrapeTab (production + $openTab)', () => {
    const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
    const count = (src.match(/\bcreateScrapeTab\s*\(/g) || []).length;
    // 1. StepOrchestrator createTab dep (background.js ~520)
    // 2. handleOpenTabExecute (background.js ~1001)
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

  it('manifest.json declares the "windows" permission (chrome.windows.create needs it)', () => {
    const src = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(src);
    assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes('windows'),
      'manifest.json: permissions array must include "windows" for chrome.windows.create');
  });
});
