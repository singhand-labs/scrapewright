// Regression test for lib/renderer-activation.js (RC17+ chrome.debugger
// transient activation — the "Plan A" framework-level anti-throttling layer).
//
// What this test guards:
//   1. The module loads cleanly + exposes the expected API
//   2. activateTabViaDebugger performs attach → sendCommand → detach in order
//   3. Detach happens even if sendCommand fails (no lingering yellow banner)
//   4. Only Page.setWebLifecycleState command is sent (detection-risk guard)
//   5. hasDebuggerPermission / requestDebuggerPermission use chrome.permissions
//   6. Falls back gracefully when chrome.debugger is unavailable (test sandbox)
//   7. activateTabIfPermitted suppresses silently when permission not granted
//
// Detection-risk guard (the user-stated priority):
// The test asserts that NO Runtime.* commands are issued. Runtime.evaluate
// is the most-detected CDP artifact per scrappey/scrapfly documentation.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'renderer-activation.js');

function loadModuleInSandbox(sandboxOverrides) {
  const calls = {
    attach: [], sendCommand: [], detach: [],
    storageGet: [], storageSet: [], storageRemove: []
  };
  // In-memory backing store for chrome.storage.local — survives across calls
  // within a single loadModuleInSandbox instance, mirroring real chrome.storage.
  const backingStore = Object.create(null);

  // Method-level overrides: callers can pass `debuggerMethods` and
  // `storageMethods` to replace individual function impls WITHOUT losing
  // the calls.* recording (which only the defaults do).
  const dbgOverride = (sandboxOverrides && sandboxOverrides.debuggerMethods) || {};
  const storageOverride = (sandboxOverrides && sandboxOverrides.storageMethods) || {};

  const defaultChrome = {
    debugger: {
      attach: dbgOverride.attach || ((target, version, cb) => {
        calls.attach.push({ target, version });
        cb();
      }),
      sendCommand: dbgOverride.sendCommand || ((target, method, params, cb) => {
        calls.sendCommand.push({ target, method, params });
        cb();
      }),
      detach: dbgOverride.detach || ((target, cb) => {
        calls.detach.push({ target });
        cb();
      })
    },
    storage: {
      local: {
        get: storageOverride.get || ((keys, cb) => {
          calls.storageGet.push(keys);
          const out = {};
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) {
            if (k in backingStore) out[k] = backingStore[k];
          }
          cb(out);
        }),
        set: storageOverride.set || ((items, cb) => {
          calls.storageSet.push(items);
          Object.assign(backingStore, items);
          if (cb) cb();
        }),
        remove: storageOverride.remove || ((keys, cb) => {
          calls.storageRemove.push(keys);
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete backingStore[k];
          if (cb) cb();
        })
      }
    },
    runtime: { lastError: undefined }
  };

  // Allow tests to seed the backing store before module load.
  if (sandboxOverrides && sandboxOverrides.seedStore) {
    Object.assign(backingStore, sandboxOverrides.seedStore);
  }

  // Full chrome replacement (for tests that need a totally different shape,
  // e.g., missing debugger property).
  const chromeOverride = sandboxOverrides && sandboxOverrides.chrome !== undefined
    ? sandboxOverrides.chrome
    : null;
  const sandbox = {
    chrome: chromeOverride || defaultChrome,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    module: { exports: {} }
  };
  if (sandboxOverrides) {
    for (const k of Object.keys(sandboxOverrides)) {
      if (k !== 'chrome' && k !== 'debuggerMethods' && k !== 'storageMethods' && k !== 'seedStore') {
        sandbox[k] = sandboxOverrides[k];
      }
    }
  }
  vm.createContext(sandbox);
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  vm.runInContext(src, sandbox, { filename: 'renderer-activation.js' });
  return { api: sandbox.module.exports, calls, sandbox, backingStore };
}

describe('lib/renderer-activation.js — module shape', () => {
  it('exposes the expected API surface', () => {
    const { api } = loadModuleInSandbox();
    assert.equal(typeof api.hasDebuggerPermission, 'function');
    assert.equal(typeof api.requestDebuggerPermission, 'function');
    assert.equal(typeof api.removeDebuggerPermission, 'function');
    assert.equal(typeof api.activateTabViaDebugger, 'function');
    assert.equal(typeof api.activateTabIfPermitted, 'function');
    assert.equal(api.DEBUGGER_PROTOCOL_VERSION, '1.3');
  });

  it('IIFE-wrapped — leading comment then (function', () => {
    // Mirror the RC13 IIFE-collision regression: this file MUST be IIFE-
    // wrapped so it can be loaded alongside other lib/*.js files in
    // wizard.html's shared global lexical environment without colliding
    // on `const api = ...` declarations.
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    // Allow leading // comments + blank lines, then `(function`
    assert.match(src, /\(function\s*\(\s*global\s*\)\s*\{/,
      'module must contain an IIFE `(function(global){...})(...)`');
    // Must NOT have a top-level `const api =` or `var api =` outside the IIFE.
    // Easiest check: there should be no top-level `module.exports = api`
    // (it's inside the IIFE).
    assert.match(src, /if \(typeof module[^)]+\) module\.exports = api/);
  });
});

describe('lib/renderer-activation.js — activateTabViaDebugger operation order', () => {
  it('attaches → sends Page.setWebLifecycleState(active) → detaches', async () => {
    const { api, calls } = loadModuleInSandbox();
    const result = await api.activateTabViaDebugger(123);
    assert.equal(calls.attach.length, 1);
    assert.equal(calls.attach[0].target.tabId, 123);
    assert.equal(calls.sendCommand.length, 1);
    assert.equal(calls.sendCommand[0].method, 'Page.setWebLifecycleState');
    assert.equal(calls.sendCommand[0].params.state, 'active');
    assert.equal(calls.sendCommand[0].target.tabId, 123);
    assert.equal(calls.detach.length, 1);
    assert.equal(calls.detach[0].target.tabId, 123);
    assert.equal(result.ok, true);
    assert.equal(result.attached, true);
    assert.equal(result.sendCommand, true);
    assert.equal(result.detached, true);
  });

  it('uses protocol version 1.3 for attach', async () => {
    const { api, calls } = loadModuleInSandbox();
    await api.activateTabViaDebugger(1);
    assert.equal(calls.attach[0].version, '1.3',
      'protocol version must be 1.3 — matches modern Chrome');
  });

  it('NEVER sends Runtime.* commands (detection-risk guard)', async () => {
    // Detection-risk minimization: Runtime.evaluate is the most-detected CDP
    // command per scrappey/scrapfly documentation. This module MUST only use
    // Page.* commands. If a future edit adds Runtime calls, this test fails.
    const { api, calls } = loadModuleInSandbox();
    await api.activateTabViaDebugger(42);
    const runtimeCalls = calls.sendCommand.filter(c => c.method.startsWith('Runtime.'));
    assert.equal(runtimeCalls.length, 0,
      `Runtime.* commands are forbidden (detection-risk guard). Found: ${JSON.stringify(runtimeCalls)}`);
  });

  it('NEVER sends Network.* or DOM.* commands (detection-risk guard)', async () => {
    const { api, calls } = loadModuleInSandbox();
    await api.activateTabViaDebugger(42);
    const forbidden = calls.sendCommand.filter(c =>
      c.method.startsWith('Network.') || c.method.startsWith('DOM.'));
    assert.equal(forbidden.length, 0,
      `Network.*/DOM.* commands are forbidden. Found: ${JSON.stringify(forbidden)}`);
  });

  it('sends exactly one sendCommand per activation (minimize attach window)', async () => {
    const { api, calls } = loadModuleInSandbox();
    await api.activateTabViaDebugger(1);
    assert.equal(calls.sendCommand.length, 1,
      'exactly one sendCommand — extras would extend the attach window');
  });
});

describe('lib/renderer-activation.js — error recovery (always detach)', () => {
  it('detaches even when sendCommand fails', async () => {
    // Simulate sendCommand failing via chrome.runtime.lastError. Override
    // ONLY sendCommand; keep default attach/detach (which record to calls.*)
    // so we can assert detach was still invoked. The override writes the
    // error onto the sandbox's chrome.runtime.lastError so the module reads
    // it at the sendCommand callback boundary.
    const { api, calls, sandbox } = loadModuleInSandbox({
      debuggerMethods: {
        sendCommand: (target, method, params, cb) => {
          sandbox.chrome.runtime.lastError = { message: 'tab closed' };
          cb();
        }
      }
    });
    const result = await api.activateTabViaDebugger(7);
    assert.equal(result.ok, false);
    assert.equal(result.attached, true, 'attach succeeded');
    assert.equal(result.sendCommand, false, 'sendCommand failed');
    assert.equal(result.detached, true, 'detach MUST still run — never leave banner visible');
    assert.equal(calls.detach.length, 1, 'detach called exactly once');
  });

  it('returns ok:false (no throw) when attach fails (e.g., another debugger attached)', async () => {
    const overrides = {
      chrome: {
        debugger: {
          attach: (target, v, cb) => {
            chrome.runtime.lastError = { message: 'Another debugger is already attached' };
            cb();
          },
          sendCommand: () => { throw new Error('sendCommand should NOT be called when attach failed'); },
          detach: (target, cb) => cb()
        },
        runtime: { lastError: undefined }
      }
    };
    const { api, calls } = loadModuleInSandbox(overrides);
    const result = await api.activateTabViaDebugger(7);
    assert.equal(result.ok, false);
    assert.equal(result.attached, false);
    assert.equal(calls.sendCommand.length, 0);
    assert.equal(calls.detach.length, 0,
      'detach must NOT be called when attach failed — would error');
    assert.match(result.reason, /attach failed/);
  });

  it('returns ok:false when chrome.debugger is unavailable (test sandbox / older Chrome)', async () => {
    // Pass a chrome with no debugger property. The merge logic shallow-
    // merges overrides.chrome over defaultChrome, so to test "no debugger"
    // we use a separate code path: bypass the merge by directly using a
    // custom sandbox.
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    const sandbox = {
      chrome: { runtime: {} }, // no debugger
      console: { log: () => {}, warn: () => {}, error: () => {} },
      module: { exports: {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'renderer-activation.js' });
    const result = await sandbox.module.exports.activateTabViaDebugger(7);
    assert.equal(result.ok, false);
    assert.match(result.reason, /chrome\.debugger unavailable/);
  });

  it('returns ok:false for invalid tabId', async () => {
    const { api } = loadModuleInSandbox();
    const r1 = await api.activateTabViaDebugger(undefined);
    const r2 = await api.activateTabViaDebugger(-1);
    const r3 = await api.activateTabViaDebugger('not-a-number');
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(r3.ok, false);
  });
});

describe('lib/renderer-activation.js — permission helpers', () => {
  it('hasDebuggerPermission returns false when chrome.storage.local is unavailable', async () => {
    const overrides = { chrome: { runtime: {} } };
    const { api } = loadModuleInSandbox(overrides);
    assert.equal(await api.hasDebuggerPermission(), false);
  });

  it('hasDebuggerPermission reads the enhancedModeEnabled flag from chrome.storage.local', async () => {
    const { api, calls } = loadModuleInSandbox();
    await api.hasDebuggerPermission();
    assert.equal(calls.storageGet.length, 1, 'must call storage.local.get exactly once');
    // The module requests by key name.
    const req = calls.storageGet[0];
    const keys = Array.isArray(req) ? req : [req];
    assert.ok(keys.includes('enhancedModeEnabled'),
      'must request the enhancedModeEnabled key; got: ' + JSON.stringify(req));
  });

  it('hasDebuggerPermission returns false when flag is unset (default)', async () => {
    const { api } = loadModuleInSandbox();
    assert.equal(await api.hasDebuggerPermission(), false);
  });

  it('hasDebuggerPermission returns true when flag is seeded in storage', async () => {
    const { api } = loadModuleInSandbox({ seedStore: { enhancedModeEnabled: true } });
    assert.equal(await api.hasDebuggerPermission(), true);
  });

  it('requestDebuggerPermission sets storage flag to true', async () => {
    const { api, calls, backingStore } = loadModuleInSandbox();
    const result = await api.requestDebuggerPermission();
    assert.equal(result.granted, true);
    assert.equal(result.reason, undefined);
    assert.equal(backingStore.enhancedModeEnabled, true, 'flag must be persisted');
    assert.equal(calls.storageSet.length, 1);
  });

  it('requestDebuggerPermission surfaces lastError when storage.set fails', async () => {
    // Simulate chrome.runtime.lastError being set on the storage.local.set
    // callback. We close over the ctx returned by loadModuleInSandbox so the
    // override can mutate ctx.sandbox.chrome.runtime.lastError.
    let ctx;
    ctx = loadModuleInSandbox({
      storageMethods: {
        set: (items, cb) => {
          ctx.sandbox.chrome.runtime.lastError = { message: 'storage quota exceeded' };
          if (cb) cb();
        }
      }
    });
    const result = await ctx.api.requestDebuggerPermission();
    assert.equal(result.granted, false);
    assert.match(result.reason, /storage quota exceeded/);
  });

  it('removeDebuggerPermission clears the storage flag', async () => {
    const { api, backingStore } = loadModuleInSandbox({ seedStore: { enhancedModeEnabled: true } });
    assert.equal(backingStore.enhancedModeEnabled, true);
    const removed = await api.removeDebuggerPermission();
    assert.equal(removed, true);
    assert.equal(backingStore.enhancedModeEnabled, undefined, 'flag must be cleared');
  });
});

describe('lib/renderer-activation.js — activateTabIfPermitted fallback', () => {
  it('skips activation silently when storage flag not set', async () => {
    const { api, calls } = loadModuleInSandbox();
    // Default sandbox has storage.local.get returning {} → flag unset
    const result = await api.activateTabIfPermitted(99);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'debugger permission not granted');
    assert.equal(calls.attach.length, 0, 'must NOT attach without flag set');
  });

  it('runs activation when storage flag IS set', async () => {
    // Seed the storage flag so hasDebuggerPermission returns true, and let
    // the default recording mocks for chrome.debugger populate calls.*.
    const { api, calls } = loadModuleInSandbox({
      seedStore: { enhancedModeEnabled: true }
    });
    const result = await api.activateTabIfPermitted(99);
    assert.equal(result.ok, true);
    assert.equal(calls.attach.length, 1);
    assert.equal(calls.detach.length, 1);
  });
});

describe('lib/renderer-activation.js — global free-variable exposure', () => {
  it('exposes activateTabIfPermitted as a free variable for scrape-tab.js', () => {
    const { sandbox } = loadModuleInSandbox();
    assert.equal(typeof sandbox.activateTabIfPermitted, 'function',
      'activateTabIfPermitted must be a global free variable — scrape-tab.js references it unqualified');
    assert.equal(typeof sandbox.hasDebuggerPermission, 'function');
    assert.equal(typeof sandbox.requestDebuggerPermission, 'function');
  });

  it('exposes RendererActivation module object', () => {
    const { sandbox } = loadModuleInSandbox();
    assert.equal(typeof sandbox.RendererActivation, 'object');
    assert.equal(typeof sandbox.RendererActivation.activateTabViaDebugger, 'function');
  });
});
