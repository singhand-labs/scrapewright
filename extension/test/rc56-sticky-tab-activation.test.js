// RC56 behavioral tests: sticky tab activation + landing focus.
//
// RC56 replaced RC20's brief-activation model (activate -> op -> restore)
// with STICKY activation, per user request: requestActivation activates the
// scrape tab and KEEPS it active; the next DOM op re-activates if the user
// switched away (instead of restoring after every op, which caused
// activate/restore churn on back-to-back ops). When a scrape tab closes
// while it is its window's active tab, focus lands on the user's
// last-clicked tab (focusing its window if different).
//
// Mechanism under test:
//   - suppression Set: our own programmatic tabs.update triggers
//     chrome.tabs.onActivated too; tabIds are added before update and
//     matched/cleared on the event (plus a 1000ms safety timer in case the
//     event never arrives).
//   - storage.session persistence: the MV3 service worker can suspend
//     between a user click and the scrape-tab close (wizard LLM calls run
//     in page context with no SW traffic for minutes), so
//     lastUserTabId / activeByWindow persist to chrome.storage.session and
//     are hydrated once, lazily, before the first event is applied.
//
// Universality: abstract names only (scrape tab / user tab / window).
//
// Each test loads a FRESH module instance — module state (lastUserTabId,
// suppression set, hydratePromise) is module-level, so a shared instance
// would leak between tests.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'tab-activation.js');

// Fresh module + fresh chrome mock per test. Options:
//   storage: false      — omit chrome.storage entirely (in-memory fallback)
//   seed: {...}         — pre-seed the storage.session store
function loadModule(opts) {
  opts = opts || {};
  const calls = {
    tabsGet: [], tabsUpdate: [], windowsGetLastFocused: [], windowsUpdate: [],
    storageSet: [], storageGet: []
  };
  const tabsById = new Map();
  let focusedWindowId = 1;
  const activatedListeners = [];
  const removedListeners = [];

  const store = Object.assign({}, opts.seed || {});
  const chromeMock = {
    tabs: {
      get: (tabId) => {
        calls.tabsGet.push(tabId);
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        return Promise.resolve(tab);
      },
      update: (tabId, props) => {
        calls.tabsUpdate.push({ tabId, props });
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        if (props && props.active === true) {
          for (const t of tabsById.values()) {
            if (t.windowId === tab.windowId && t.active) t.active = false;
          }
          tab.active = true;
        }
        return Promise.resolve(tab);
      },
      onActivated: { addListener: (fn) => activatedListeners.push(fn) },
      onRemoved: { addListener: (fn) => removedListeners.push(fn) }
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
    runtime: {}
  };
  if (opts.storage !== false) {
    chromeMock.storage = {
      session: {
        get: (key) => {
          calls.storageGet.push(key);
          const out = {};
          if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          return Promise.resolve(out);
        },
        set: (obj) => {
          calls.storageSet.push(obj);
          Object.assign(store, obj);
          return Promise.resolve();
        }
      }
    };
  }

  // Manual clock: record timer callbacks instead of scheduling real time.
  const timers = [];
  let timerIdSeq = 0;
  const fakeSetTimeout = (fn, delay) => {
    const id = ++timerIdSeq;
    timers.push({ id, fn, delay: delay || 0 });
    return id;
  };
  const fakeClearTimeout = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const runExpired = (elapsedMs) => {
    for (const t of timers.filter((t) => t.delay <= elapsedMs)) {
      fakeClearTimeout(t.id);
      t.fn();
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), sandbox,
    { filename: 'tab-activation.js' });

  return {
    api: sandbox.module.exports,
    calls, tabsById, activatedListeners, removedListeners, store,
    timers, runExpired,
    setFocusedWindow: (id) => { focusedWindowId = id; },
    fireActivated: async (tabId, windowId) => {
      for (const fn of activatedListeners) await fn({ tabId, windowId });
    },
    fireRemoved: async (tabId, removeInfo) => {
      for (const fn of removedListeners) await fn(tabId, removeInfo);
    }
  };
}

function addTab(ctx, id, windowId, active) {
  ctx.tabsById.set(id, { id, windowId, active: !!active });
}

describe('RC56 — init', () => {
  it('1. init registers both onActivated and onRemoved; no-throw without chrome.tabs', () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    assert.equal(ctx.activatedListeners.length, 1);
    assert.equal(ctx.removedListeners.length, 1);
    // Absent chrome.tabs → safe no-throw
    const bare = loadModule({ storage: false });
    bare.api.initTabActivationListeners(); // no throw
    const sandbox = {
      chrome: { runtime: {} },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout, clearTimeout,
      module: { exports: {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), sandbox,
      { filename: 'tab-activation.js' });
    sandbox.module.exports.initTabActivationListeners(); // no chrome.tabs at all
  });
});

describe('RC56 — suppression set', () => {
  it('2. suppressed activation is not recorded as lastUserTabId', async () => {
    const ctx = loadModule();
    addTab(ctx, 100, 1, true);
    addTab(ctx, 5, 1, false);
    ctx.api.initTabActivationListeners();
    await ctx.api.requestActivation(5);
    await ctx.fireActivated(5, 1);
    const s = ctx.api._getUserState();
    assert.equal(s.lastUserTabId, null, 'own activation must not pollute lastUserTabId');
    assert.equal(s.activeByWindow.get(1), 5, 'activeByWindow still tracks every activation');
  });

  it('3. suppression safety timer: after ~1050ms the token expires', async () => {
    const ctx = loadModule();
    addTab(ctx, 5, 1, false);
    ctx.api.initTabActivationListeners();
    await ctx.api.requestActivation(5);
    // Never fire the event; advance the manual clock past the 1000ms safety
    // timer so the token expires, then fire onActivated.
    ctx.runExpired(1001);
    await ctx.fireActivated(5, 1);
    assert.equal(ctx.api._getUserState().lastUserTabId, 5,
      'after timer expiry the same activation is treated as user click');
  });

  it('4. user click on a DIFFERENT tab during pending suppression is recorded', async () => {
    const ctx = loadModule();
    addTab(ctx, 5, 1, false);
    ctx.api.initTabActivationListeners();
    await ctx.api.requestActivation(5); // token=5 pending, event not yet fired
    await ctx.fireActivated(9, 1);      // user clicks elsewhere
    assert.equal(ctx.api._getUserState().lastUserTabId, 9);
  });
});

describe('RC56 — user-click tracking + persistence', () => {
  it('5. user click recorded AND persisted to storage.session; latest wins', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(8, 1);
    await ctx.fireActivated(9, 1); // latest wins
    assert.equal(ctx.api._getUserState().lastUserTabId, 9);
    const last = ctx.calls.storageSet[ctx.calls.storageSet.length - 1];
    assert.ok(last && last.tabActivationState &&
      last.tabActivationState.lastUserTabId === 9,
      'persist() must write lastUserTabId to storage.session');
  });
});

describe('RC56 — landing on close', () => {
  async function landingSetup(ctx) {
    ctx.api.initTabActivationListeners();
    addTab(ctx, 9, 1, true);
    addTab(ctx, 5, 1, false);
    await ctx.fireActivated(9, 1);       // user's last click
    await ctx.api.requestActivation(5);  // programmatic (suppressed)
    await ctx.fireActivated(5, 1);       // 5 becomes window-1 active
  }

  it('6. closing the active scrape tab lands on last-clicked tab', async () => {
    const ctx = loadModule();
    await landingSetup(ctx);
    ctx.tabsById.delete(5);
    await ctx.fireRemoved(5, { windowId: 1, isWindowClosing: false });
    // update #1 = activation, update #2 = landing
    assert.equal(ctx.calls.tabsUpdate.length, 2);
    assert.equal(ctx.calls.tabsUpdate[1].tabId, 9);
    assert.equal(ctx.calls.tabsUpdate[1].props.active, true);
    assert.equal(ctx.api._getUserState().activeByWindow.get(1), 9);
  });

  it('7. landing skipped when closing tab was NOT the window active tab', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    addTab(ctx, 9, 1, true);
    addTab(ctx, 5, 1, false);
    await ctx.fireActivated(9, 1);
    await ctx.fireRemoved(5, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('8. landing skipped when lastUserTabId === closing tab (Chrome default)', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    addTab(ctx, 9, 1, true);
    addTab(ctx, 5, 1, false);
    await ctx.fireActivated(9, 1); // user clicked 9
    // Suppose active tab is 9 and it closes while lastUserTabId is also 9:
    // intended — Chrome's default adjacent-tab selection.
    ctx.tabsById.delete(9);
    await ctx.fireRemoved(9, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('9. stale lastUserTabId: tabs.get rejects → cleared, no update', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    addTab(ctx, 5, 1, true);
    await ctx.fireActivated(5, 1); // 5 active; lastUserTabId null here
    // Seed: user clicked 9 earlier, 9 now gone, 5 is active
    await ctx.fireActivated(9, 1); // recorded as user click
    await ctx.fireActivated(5, 1); // 5 active again (unsuppressed)
    ctx.tabsById.delete(5);
    ctx.tabsById.delete(9);
    await ctx.fireRemoved(5, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
    assert.equal(ctx.api._getUserState().lastUserTabId, null, 'stale id must be cleared');
  });

  it('10. isWindowClosing:true → no tabs.get/tabs.update, no state change', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    addTab(ctx, 9, 1, true);
    addTab(ctx, 5, 1, false);
    await ctx.fireActivated(9, 1);
    await ctx.api.requestActivation(5);
    await ctx.fireActivated(5, 1);
    const before = ctx.calls.tabsGet.length;
    ctx.tabsById.delete(5); ctx.tabsById.delete(9);
    await ctx.fireRemoved(5, { windowId: 1, isWindowClosing: true });
    assert.equal(ctx.calls.tabsGet.length, before, 'no tabs.get on window close');
    assert.equal(ctx.calls.tabsUpdate.length, 1); // only the original activation
    assert.equal(ctx.api._getUserState().activeByWindow.get(1), undefined,
      'window entry dropped');
  });

  it('11. no lastUserTabId → no-op on close of active tab', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    addTab(ctx, 5, 1, true);
    await ctx.api.requestActivation(5); // no-op (already active)
    ctx.tabsById.delete(5);
    await ctx.fireRemoved(5, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 0);
  });

  it('12. cross-window landing: activate tab AND focus its window', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    addTab(ctx, 9, 2, true);  // user tab in window 2
    addTab(ctx, 5, 1, false); // scrape tab in window 1
    await ctx.fireActivated(9, 2);
    ctx.setFocusedWindow(1);
    await ctx.api.requestActivation(5);
    await ctx.fireActivated(5, 1);
    ctx.tabsById.delete(5);
    await ctx.fireRemoved(5, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.calls.tabsUpdate.length, 2); // activation + landing
    assert.equal(ctx.calls.tabsUpdate[1].tabId, 9);
    assert.equal(ctx.calls.windowsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate[0].windowId, 2);
    assert.equal(ctx.calls.windowsUpdate[0].props.focused, true);
  });

  it('13. lastUserTabId cleared when IT closes', async () => {
    const ctx = loadModule();
    ctx.api.initTabActivationListeners();
    await ctx.fireActivated(9, 2);
    ctx.tabsById.delete(9); // not needed; mock get would reject anyway
    await ctx.fireRemoved(9, { windowId: 2, isWindowClosing: false });
    assert.equal(ctx.api._getUserState().lastUserTabId, null);
  });
});

describe('RC56 — hydration', () => {
  it('14. pre-seeded storage.session state survives as first events apply', async () => {
    const ctx = loadModule({
      seed: { tabActivationState: { lastUserTabId: 7, activeByWindow: [[1, 5]] } }
    });
    addTab(ctx, 5, 1, false);
    ctx.api.initTabActivationListeners();
    // Suppressed activation for 5 — must NOT overwrite hydrated lastUserTabId
    await ctx.api.requestActivation(5);
    await ctx.fireActivated(5, 1);
    const s = ctx.api._getUserState();
    assert.equal(s.lastUserTabId, 7, 'hydrated value preserved');
    assert.equal(s.activeByWindow.get(1), 5);
  });
});

describe('RC56 — requestActivation response shapes', () => {
  // Response shapes for already-active / cross-window / success are covered
  // in test/tab-activation.test.js ("requestActivation" suite). Only the
  // single-update sticky invariant is re-pinned here.
  it('15. success → {ok:true,activated:true} with exactly ONE tabs.update', async () => {
    const ctx = loadModule();
    addTab(ctx, 100, 1, true);
    addTab(ctx, 101, 1, false);
    const r = await ctx.api.requestActivation(101);
    assert.equal(r.ok, true);
    assert.equal(r.activated, true);
    assert.equal(ctx.calls.tabsUpdate.length, 1);
  });
});

describe('RC56 — storage-less fallback', () => {
  it('16. chrome.storage.session absent → in-memory tracking still works', async () => {
    const ctx = loadModule({ storage: false });
    ctx.api.initTabActivationListeners();
    addTab(ctx, 9, 1, true);
    addTab(ctx, 5, 1, false);
    await ctx.fireActivated(9, 1);
    await ctx.api.requestActivation(5);
    await ctx.fireActivated(5, 1);
    ctx.tabsById.delete(5);
    await ctx.fireRemoved(5, { windowId: 1, isWindowClosing: false });
    assert.equal(ctx.api._getUserState().lastUserTabId, 9);
    assert.equal(ctx.calls.tabsUpdate.length, 2);
    assert.equal(ctx.calls.tabsUpdate[1].tabId, 9, 'landing still fires without storage');
  });
});
