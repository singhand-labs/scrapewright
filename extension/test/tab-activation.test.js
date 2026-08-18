// Regression test for lib/tab-activation.js (RC56 sticky activation).
//
// RC56 replaces RC20's brief-activation model (activate → op → restore)
// with STICKY activation, per user request:
//   - requestActivation switches to the scrape tab and KEEPS it active.
//     No auto-restore: back-to-back ops no longer cause activate/restore
//     churn; the next op just re-activates if the user switched away.
//   - chrome.tabs.onActivated tracks the user's last manually-clicked tab.
//     Our own programmatic activations are distinguished by a suppression
//     token (suppressActivatedTabId) set just before tabs.update.
//   - chrome.tabs.onRemoved: when a tab closes while it is the active tab
//     of its window (scrape tab auto-close), focus lands on the
//     last-clicked tab (focusing its window if different). No valid
//     target → Chrome's default behavior.
//   - State persists to chrome.storage.session: the MV3 service worker can
//     suspend between a user click and the scrape-tab close.
//
// These tests verify the activation logic via a chrome.tabs/windows
// sandbox.

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
    windowsGetLastFocused: [],
    windowsUpdate: []
  };

  // Per-test chrome simulation. Tabs are stored in `tabsById`; windows in
  // `windowsById`. Tests mutate these directly to set up scenarios.
  const tabsById = new Map();
  const windowsById = new Map();
  let focusedWindowId = 1;

  const activatedListeners = [];
  const removedListeners = [];

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
      },
      onActivated: {
        addListener: (fn) => activatedListeners.push(fn)
      },
      onRemoved: {
        addListener: (fn) => removedListeners.push(fn)
      }
    },
    windows: {
      getLastFocused: () => {
        calls.windowsGetLastFocused.push(focusedWindowId);
        return Promise.resolve({ id: focusedWindowId });
      },
      update: (windowId, props) => {
        calls.windowsUpdate.push({ windowId, props });
        return Promise.resolve({ id: windowId });
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
    activatedListeners,
    removedListeners,
    setFocusedWindow: (id) => { focusedWindowId = id; },
    // Simulate Chrome firing onActivated after a tabs.update. Mirrors the
    // real event ordering: listener receives { tabId, windowId }.
    fireActivated: async (tabId, windowId) => {
      for (const fn of activatedListeners) await fn({ tabId, windowId });
    },
    // Simulate Chrome firing onRemoved. removeInfo: { windowId, isWindowClosing }.
    fireRemoved: async (tabId, removeInfo) => {
      for (const fn of removedListeners) await fn(tabId, removeInfo);
    }
  };
}

describe('lib/tab-activation.js — module shape', () => {
  it('exposes the expected API surface', () => {
    const { api } = loadModule();
    assert.equal(typeof api.requestActivation, 'function');
    assert.equal(typeof api.initTabActivationListeners, 'function');
    assert.equal(typeof api.withActivation, 'function');
    assert.equal(typeof api._getUserState, 'function');
    const userState = api._getUserState();
    assert.ok(userState && typeof userState === 'object');
    // Cross-realm note: Map created inside the vm sandbox fails node's
    // instanceof check, so verify duck-typed Map surface.
    assert.ok(userState.activeByWindow &&
      typeof userState.activeByWindow.get === 'function' &&
      typeof userState.activeByWindow.set === 'function' &&
      typeof userState.activeByWindow.size === 'number');
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
  });

  it('activates scrape tab and KEEPS it active (sticky, no restore state)', async () => {
    const ctx = loadModule();
    // User is on tab 100, scrape tab is 101
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
    // Verify tab objects now reflect activation — and stay activated (sticky)
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

  it('returns ok:false when tabs.get fails (tab closed)', async () => {
    const ctx = loadModule();
    const result = await ctx.api.requestActivation(999);
    assert.equal(result.ok, false);
    assert.match(result.reason, /tabs\.get failed/);
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

});

describe('lib/tab-activation.js — tabs.update failure path', () => {
  it('returns ok:false when tabs.update throws', async () => {
    const calls = { tabsGet: [], tabsUpdate: [] };
    const chrome = {
      tabs: {
        get: (tabId) => {
          calls.tabsGet.push(tabId);
          return Promise.resolve({ id: tabId, windowId: 1, active: false });
        },
        update: () => Promise.reject(new Error('update rejected'))
      },
      windows: {
        getLastFocused: () => Promise.resolve({ id: 1 })
      },
      runtime: {}
    };
    const sandbox = {
      chrome,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout, clearTimeout,
      module: { exports: {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), sandbox, { filename: 'tab-activation.js' });
    const result = await sandbox.module.exports.requestActivation(101);
    assert.equal(result.ok, false);
    assert.match(result.reason, /tabs\.update failed/);
  });
});

describe('lib/tab-activation.js — user-click tracking (onActivated)', () => {
  it('initTabActivationListeners registers both listeners', () => {
    const ctx = loadModule();
    assert.equal(ctx.activatedListeners.length, 0);
    assert.equal(ctx.removedListeners.length, 0);
    ctx.api.initTabActivationListeners();
    assert.equal(ctx.activatedListeners.length, 1);
    assert.equal(ctx.removedListeners.length, 1);
  });

  it('user click updates lastUserTabId and activeByWindow', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1);
    const s = ctx.api._getUserState();
    assert.equal(s.lastUserTabId, 100);
    assert.equal(s.activeByWindow.get(1), 100);
  });

  it('suppressed (programmatic) activation does NOT update lastUserTabId', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1); // user was on 100
    // Scrape activates 101 (sets suppression token), Chrome fires onActivated
    await ctx.api.requestActivation(101);
    await ctx.fireActivated(101, 1);
    const s = ctx.api._getUserState();
    assert.equal(s.lastUserTabId, 100, 'programmatic activation must not overwrite lastUserTabId');
    assert.equal(s.activeByWindow.get(1), 101, 'activeByWindow still tracks every activation');
  });

  it('concurrent suppressions: overlapping requestActivation calls do not leak each other\'s onActivated into lastUserTabId', async () => {
    // RC56 review Fix 1: two overlapping requestActivation calls (wizard
    // research tab + service execution tab) with a single suppression token
    // meant the first call's onActivated missed the match and got recorded
    // as a user click. Per-tab suppression set must cover both.
    const ctx = loadModule();
    ctx.tabsById.set(5, { id: 5, windowId: 1, active: false });
    ctx.tabsById.set(6, { id: 6, windowId: 1, active: false });
    ctx.api.initTabActivationListeners();
    await ctx.api.requestActivation(5);
    await ctx.api.requestActivation(6);
    // Both programmatic activations arrive — neither may be recorded
    await ctx.fireActivated(5, 1);
    await ctx.fireActivated(6, 1);
    assert.equal(ctx.api._getUserState().lastUserTabId, null,
      'neither scrape tab may pollute lastUserTabId');
    // A genuine user click afterwards IS recorded
    ctx.tabsById.set(9, { id: 9, windowId: 1, active: false });
    await ctx.fireActivated(9, 1);
    assert.equal(ctx.api._getUserState().lastUserTabId, 9);
  });

  it('unsuppressed activation after ours IS treated as a user click', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1);
    // A later activation with no suppression token (user clicked 102)
    await ctx.fireActivated(102, 1);
    assert.equal(ctx.api._getUserState().lastUserTabId, 102);
  });
});

describe('lib/tab-activation.js — scrape-tab close lands on last-clicked tab', () => {
  it('closing the ACTIVE scrape tab re-activates the last-clicked tab', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1); // user's last click was tab 100
    // Scrape activates 101 (sets suppression token), Chrome fires onActivated
    await ctx.api.requestActivation(101);
    await ctx.fireActivated(101, 1);
    const before = ctx.calls.tabsUpdate.length;
    await ctx.fireRemoved(101, { windowId: 1, isWindowClosing: false });
    // One update: re-activate tab 100
    assert.equal(ctx.calls.tabsUpdate.length, before + 1);
    assert.equal(ctx.calls.tabsUpdate[ctx.calls.tabsUpdate.length - 1].tabId, 100);
    assert.equal(ctx.calls.tabsUpdate[ctx.calls.tabsUpdate.length - 1].props.active, true);
    assert.equal(ctx.api._getUserState().activeByWindow.get(1), 100);
  });

  it('closing a NON-active tab does nothing', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1);
    // Tab 101 close: activeByWindow[1] is 100, not 101
    await ctx.fireRemoved(101, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('window-closing removal does nothing (all tabs going away)', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1);
    await ctx.fireRemoved(100, { windowId: 1, isWindowClosing: true });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('no last-clicked target → Chrome default (no update call)', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(101, 1);
    // lastUserTabId is null (101 was suppressed or never user-clicked)
    await ctx.fireRemoved(101, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('stale last-clicked tab id is cleared when tabs.get fails', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1); // user clicked 100... which is already gone
    await ctx.fireActivated(101, 1);
    await ctx.fireRemoved(101, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
    assert.equal(ctx.api._getUserState().lastUserTabId, null);
  });

  it('cross-window last-clicked tab gets its window focused', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 2, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 2); // user's last click in window 2
    // Scrape tab 101 activated programmatically (suppression token set)
    ctx.setFocusedWindow(1);
    await ctx.api.requestActivation(101);
    await ctx.fireActivated(101, 1); // suppressed → lastUserTabId stays 100
    const before = ctx.calls.tabsUpdate.length;
    await ctx.fireRemoved(101, { windowId: 1, isWindowClosing: false });
    // Re-activate 100 AND focus window 2
    assert.equal(ctx.calls.tabsUpdate.length, before + 1);
    assert.equal(ctx.calls.tabsUpdate[ctx.calls.tabsUpdate.length - 1].tabId, 100);
    assert.equal(ctx.calls.windowsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate[0].windowId, 2);
    assert.equal(ctx.calls.windowsUpdate[0].props.focused, true);
  });

  it('closing the last-clicked tab itself clears it', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(100, 1);
    await ctx.fireRemoved(100, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.api._getUserState().lastUserTabId, null);
  });
});

describe('lib/tab-activation.js — withActivation (sticky)', () => {
  it('runs fn after request; does NOT restore after fn (sticky)', async () => {
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
    // Only the single activation — sticky, no restore update
    assert.equal(ctx.calls.tabsUpdate.length, 1);
    assert.equal(ctx.tabsById.get(101).active, true);
  });

  it('propagates fn rejection', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    await assert.rejects(
      ctx.api.withActivation(101, async () => { throw new Error('scrape blew up'); }),
      /scrape blew up/
    );
  });

  it('skips activation when request returned activated:false (already active)', async () => {
    const ctx = loadModule();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    const result = await ctx.api.withActivation(101, async () => 'ok');
    assert.equal(result, 'ok');
    // No tabs.update at all
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('still runs fn when request returns ok:false (cross-window)', async () => {
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
    // No activation
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });
});
