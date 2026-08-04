// Regression test for lib/tab-activation.js (RC20, console.log 2026-07-30).
//
// Background: FB scrape completes 10 posts in foreground, stuck at 4 in
// background — even with all 4 Chrome throttle launch flags. Root cause:
// Chrome's renderer only produces compositor frames for the active tab;
// IntersectionObserver + CDP Input both depend on frame production. The
// fix is to briefly activate the scrape tab during scroll ops and restore
// the user's previous tab when done.
//
// These tests verify the activation logic via a chrome.tabs/windows sandbox.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'tab-activation.js');

function loadModule(sandboxOverrides) {
  const calls = {
    tabsGet: [],
    tabsQuery: [],
    tabsUpdate: [],
    windowsGetLastFocused: []
  };

  // Per-test chrome simulation. Tabs are stored in `tabsById`; windows in
  // `windowsById`. Tests mutate these directly to set up scenarios.
  const tabsById = new Map();
  const windowsById = new Map();
  let focusedWindowId = 1;

  const defaultChrome = {
    tabs: {
      get: (tabId) => {
        calls.tabsGet.push(tabId);
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        return Promise.resolve(tab);
      },
      query: (query) => {
        calls.tabsQuery.push(query);
        const matches = [];
        for (const tab of tabsById.values()) {
          if (query.active === true && !tab.active) continue;
          if (query.active === false && tab.active) continue;
          if (query.windowId !== undefined && tab.windowId !== query.windowId) continue;
          matches.push(tab);
        }
        return Promise.resolve(matches);
      },
      update: (tabId, props) => {
        calls.tabsUpdate.push({ tabId, props });
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        // Simulate active-tab exclusivity: setting one tab active in a window
        // deactivates the previously active tab in that window.
        if (props && props.active === true) {
          for (const t of tabsById.values()) {
            if (t.windowId === tab.windowId && t.active) t.active = false;
          }
          tab.active = true;
        }
        return Promise.resolve(tab);
      }
    },
    windows: {
      getLastFocused: () => {
        calls.windowsGetLastFocused.push(focusedWindowId);
        return Promise.resolve({ id: focusedWindowId });
      }
    },
    runtime: { lastError: undefined }
  };

  const chromeOverride = sandboxOverrides && sandboxOverrides.chrome !== undefined
    ? sandboxOverrides.chrome
    : defaultChrome;

  const sandbox = {
    chrome: chromeOverride,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    module: { exports: {} }
  };

  vm.createContext(sandbox);
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  vm.runInContext(src, sandbox, { filename: 'tab-activation.js' });

  return {
    api: sandbox.module.exports,
    calls,
    tabsById,
    windowsById,
    setFocusedWindow: (id) => { focusedWindowId = id; }
  };
}

describe('lib/tab-activation.js — module shape', () => {
  it('exposes the expected API surface', () => {
    const { api } = loadModule();
    assert.equal(typeof api.requestActivation, 'function');
    assert.equal(typeof api.releaseActivation, 'function');
    assert.equal(typeof api.withActivation, 'function');
    assert.ok(api._state instanceof Map || typeof api._state === 'object');
  });

  it('IIFE-wrapped — leading comment then (function', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    // Look for the IIFE pattern that prevents global lexical collisions
    // (RC13 precedent: scrape-tab.js var-after-const SyntaxError).
    assert.ok(/\(function\s*\(\s*global\s*\)\s*\{/.test(src),
      'tab-activation.js must be IIFE-wrapped to avoid lexical collisions in wizard.html');
  });
});

describe('lib/tab-activation.js — requestActivation', () => {
  it('returns activated:false (no-op) when scrape tab is already active', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    const result = await ctx.api.requestActivation(101);
    assert.equal(result.ok, true);
    assert.equal(result.activated, false);
    assert.match(result.reason, /already active/);
    // No tabs.update call — no flicker
    assert.equal(ctx.calls.tabsUpdate.length, 0);
    // No state saved
    assert.equal(ctx.api._state.size, 0);
  });

  it('activates scrape tab and saves restore state when not active', async () => {
    const ctx = loadModule();
    // User is on tab 100 (Gmail), scrape tab is 101 (FB)
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    const result = await ctx.api.requestActivation(101);
    assert.equal(result.ok, true);
    assert.equal(result.activated, true);
    // Verify activation happened
    assert.equal(ctx.calls.tabsUpdate.length, 1);
    assert.equal(ctx.calls.tabsUpdate[0].tabId, 101);
    // Compare by value+key count; deepStrictEqual fails on prototype mismatch
    // (objects created inside vm sandbox have a different Object.prototype)
    assert.equal(ctx.calls.tabsUpdate[0].props.active, true);
    assert.equal(Object.keys(ctx.calls.tabsUpdate[0].props).length, 1);
    // Verify state was saved with restore target = previous active (100)
    const saved = ctx.api._state.get(101);
    assert.ok(saved);
    assert.equal(saved.restoreTabId, 100);
    assert.equal(saved.restoreWindowId, 1);
    // Verify tab objects now reflect activation
    assert.equal(ctx.tabsById.get(101).active, true);
    assert.equal(ctx.tabsById.get(100).active, false);
  });

  it('returns ok:false (crossWindow:true) when scrape window is not focused', async () => {
    const ctx = loadModule();
    // Scrape tab in window 2, user's focus is on window 1
    ctx.setFocusedWindow(1);
    ctx.tabsById.set(101, { id: 101, windowId: 2, active: false });
    ctx.tabsById.set(200, { id: 200, windowId: 1, active: true });
    const result = await ctx.api.requestActivation(101);
    assert.equal(result.ok, false);
    assert.equal(result.crossWindow, true);
    assert.match(result.reason, /cross-window/);
    // No activation attempt
    assert.equal(ctx.calls.tabsUpdate.length, 0);
    // No state saved
    assert.equal(ctx.api._state.size, 0);
  });

  it('returns ok:false for invalid tabId', async () => {
    const ctx = loadModule();
    const r1 = await ctx.api.requestActivation(undefined);
    const r2 = await ctx.api.requestActivation(-1);
    const r3 = await ctx.api.requestActivation('not-a-number');
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(r3.ok, false);
  });

  it('returns ok:false when chrome.tabs is unavailable', async () => {
    const { api } = loadModule({ chrome: { runtime: {} } });
    const result = await api.requestActivation(101);
    assert.equal(result.ok, false);
    assert.match(result.reason, /chrome\.tabs unavailable/);
  });
});

describe('lib/tab-activation.js — releaseActivation', () => {
  it('restores the previous active tab when scrape tab is still active', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    await ctx.api.requestActivation(101);
    // Simulate: scrape completed, scrape tab still active
    // (requestActivation already flipped 101 to active)
    const result = await ctx.api.releaseActivation(101);
    assert.equal(result.ok, true);
    assert.equal(result.restored, true);
    // Restore target was tab 100
    assert.equal(ctx.calls.tabsUpdate.length, 2);  // activate + restore
    assert.equal(ctx.calls.tabsUpdate[1].tabId, 100);
    // Compare by value+key count; deepStrictEqual fails on prototype mismatch
    // (objects created inside vm sandbox have a different Object.prototype)
    assert.equal(ctx.calls.tabsUpdate[1].props.active, true);
    assert.equal(Object.keys(ctx.calls.tabsUpdate[1].props).length, 1);
    // State cleared
    assert.equal(ctx.api._state.size, 0);
  });

  it('refuses restore when user manually changed tabs during operation', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.tabsById.set(102, { id: 102, windowId: 1, active: false });
    await ctx.api.requestActivation(101);
    // User manually switched to tab 102 during the scrape operation
    ctx.tabsById.get(101).active = false;
    ctx.tabsById.get(102).active = true;
    const result = await ctx.api.releaseActivation(101);
    assert.equal(result.ok, true);
    assert.equal(result.restored, false);
    assert.match(result.reason, /user changed tabs/);
    // No restore attempted
    assert.equal(ctx.calls.tabsUpdate.length, 1);  // only the initial activate
  });

  it('returns ok+restored:false when no activation state exists', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    const result = await ctx.api.releaseActivation(101);
    assert.equal(result.ok, true);
    assert.equal(result.restored, false);
    assert.match(result.reason, /no activation state/);
  });

  it('returns ok:false for invalid tabId', async () => {
    const ctx = loadModule();
    const r1 = await ctx.api.releaseActivation(undefined);
    const r2 = await ctx.api.releaseActivation(-1);
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
  });
});

describe('lib/tab-activation.js — withActivation', () => {
  it('runs fn between request and release; releases even if fn throws', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    let fnRan = false;
    const result = await ctx.api.withActivation(101, async () => {
      fnRan = true;
      return 'fn-return-value';
    });
    assert.equal(fnRan, true);
    assert.equal(result, 'fn-return-value');
    // Both activate and restore should have happened
    assert.equal(ctx.calls.tabsUpdate.length, 2);
    // State cleared after release
    assert.equal(ctx.api._state.size, 0);
  });

  it('releases even when fn throws', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    await assert.rejects(
      ctx.api.withActivation(101, async () => { throw new Error('scrape blew up'); }),
      /scrape blew up/
    );
    // Release still ran
    assert.equal(ctx.calls.tabsUpdate.length, 2);
    assert.equal(ctx.api._state.size, 0);
  });

  it('skips release when request returned activated:false (already active)', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    const result = await ctx.api.withActivation(101, async () => 'ok');
    assert.equal(result, 'ok');
    // No tabs.update at all (no activate, no release)
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('skips fn-side effects when request returns ok:false (cross-window)', async () => {
    // withActivation still runs fn even if activation failed — graceful
    // degradation. The caller should still get fn's result; we just didn't
    // activate the tab.
    const ctx = loadModule();
    ctx.setFocusedWindow(1);
    ctx.tabsById.set(101, { id: 101, windowId: 2, active: false });
    let fnRan = false;
    const result = await ctx.api.withActivation(101, async () => {
      fnRan = true;
      return 'degraded';
    });
    assert.equal(fnRan, true);
    assert.equal(result, 'degraded');
    // No activation, no release
    assert.equal(ctx.calls.tabsUpdate.length, 0);
    assert.equal(ctx.api._state.size, 0);
  });
});
