// Regression test for lib/renderer-activation.js (RC19 trusted-wheel fallback).
//
// === Current architecture (RC20) ===
//
// This module's ONLY remaining user of chrome.debugger is
// dispatchTrustedWheelScroll — the RC19 fix for sites whose lazy-load loader
// filters on event.isTrusted=true. Enhanced Mode (chrome.storage.local flag
// `enhancedModeEnabled`) gates availability of the trusted-wheel fallback.
//
// activateTabViaDebugger / activateTabIfPermitted (RC18 Plan A —
// Page.setWebLifecycleState) were removed in RC20 because brief tab
// activation (lib/tab-activation.js) makes lifecycle naturally ACTIVE during
// the brief window, making the call pure overhead.
//
// What this test guards:
//   1. The module loads cleanly + exposes the expected API surface
//   2. dispatchTrustedWheelScroll performs attach → mouseMoved → mouseWheel → detach
//   3. Detach happens even if sendCommand fails (no lingering yellow banner)
//   4. Only Input.dispatchMouseEvent command is sent (detection-risk guard)
//   5. hasDebuggerPermission / requestDebuggerPermission use chrome.storage
//   6. Falls back gracefully when chrome.debugger is unavailable (test sandbox)
//   7. Enhanced Mode opt-in gate: skip attach entirely when flag is unset
//   8. Each CDP step is wrapped in a 2s timeout (RC19 follow-up)
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
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
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
    assert.equal(typeof api.dispatchTrustedWheelScroll, 'function');
    assert.equal(api.DEBUGGER_PROTOCOL_VERSION, '1.3');
    assert.equal(api.CDP_STEP_TIMEOUT_MS, 2000);
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

describe('lib/renderer-activation.js — global free-variable exposure', () => {
  it('exposes dispatchTrustedWheelScroll + permission helpers as free variables', () => {
    const { sandbox } = loadModuleInSandbox();
    assert.equal(typeof sandbox.dispatchTrustedWheelScroll, 'function',
      'dispatchTrustedWheelScroll must be a global free variable — background.js references it');
    assert.equal(typeof sandbox.hasDebuggerPermission, 'function');
    assert.equal(typeof sandbox.requestDebuggerPermission, 'function');
    assert.equal(typeof sandbox.removeDebuggerPermission, 'function');
  });

  it('exposes RendererActivation module object', () => {
    const { sandbox } = loadModuleInSandbox();
    assert.equal(typeof sandbox.RendererActivation, 'object');
    assert.equal(typeof sandbox.RendererActivation.dispatchTrustedWheelScroll, 'function');
    assert.equal(typeof sandbox.RendererActivation.hasDebuggerPermission, 'function');
  });

  it('does NOT expose removed RC18-Plan-A functions (activateTabViaDebugger / activateTabIfPermitted)', () => {
    // RC20 removed these — guard against re-introduction.
    const { sandbox } = loadModuleInSandbox();
    assert.equal(sandbox.activateTabViaDebugger, undefined);
    assert.equal(sandbox.activateTabIfPermitted, undefined);
    assert.equal(sandbox.RendererActivation.activateTabViaDebugger, undefined);
    assert.equal(sandbox.RendererActivation.activateTabIfPermitted, undefined);
  });
});

// ============================================================================
// RC19 (console.log 2026-07-28): dispatchTrustedWheelScroll — CDP wheel event
//
// Tests guard:
//   1. Attach → mouseMoved → mouseWheel → detach in order
//   2. Detach always runs even if a sendCommand fails
//   3. Enhanced Mode opt-in gate: skip attach entirely when flag is unset
//   4. NEVER sends Runtime/Network/DOM commands (detection-risk guard)
//   5. Wheel params (x, y, deltaY) forwarded correctly
//   6. Invalid tabId / missing chrome.debugger fast-fail
// ============================================================================

describe('lib/renderer-activation.js — dispatchTrustedWheelScroll operation order', () => {
  it('attaches → mouseMoved → mouseWheel → detaches (Enhanced Mode on)', async () => {
    const { api, calls } = loadModuleInSandbox({ seedStore: { enhancedModeEnabled: true } });
    const result = await api.dispatchTrustedWheelScroll(123, { deltaY: 600, x: 250, y: 300 });
    assert.equal(calls.attach.length, 1);
    assert.equal(calls.attach[0].target.tabId, 123);
    assert.equal(calls.sendCommand.length, 2, 'exactly two sendCommands — mouseMoved then mouseWheel');
    assert.equal(calls.sendCommand[0].method, 'Input.dispatchMouseEvent');
    assert.equal(calls.sendCommand[0].params.type, 'mouseMoved');
    assert.equal(calls.sendCommand[0].params.x, 250);
    assert.equal(calls.sendCommand[0].params.y, 300);
    assert.equal(calls.sendCommand[1].method, 'Input.dispatchMouseEvent');
    assert.equal(calls.sendCommand[1].params.type, 'mouseWheel');
    assert.equal(calls.sendCommand[1].params.deltaX, 0);
    assert.equal(calls.sendCommand[1].params.deltaY, 600);
    assert.equal(calls.detach.length, 1);
    assert.equal(result.ok, true);
    assert.equal(result.attached, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.detached, true);
    assert.equal(result.deltaY, 600);
  });

  it('defaults deltaY=800, x=400, y=400 when opts omitted', async () => {
    const { api, calls } = loadModuleInSandbox({ seedStore: { enhancedModeEnabled: true } });
    await api.dispatchTrustedWheelScroll(1);
    assert.equal(calls.sendCommand[0].params.x, 400);
    assert.equal(calls.sendCommand[0].params.y, 400);
    assert.equal(calls.sendCommand[1].params.deltaY, 800);
  });

  it('NEVER sends Runtime/Network/DOM commands (detection-risk guard)', async () => {
    const { api, calls } = loadModuleInSandbox({ seedStore: { enhancedModeEnabled: true } });
    await api.dispatchTrustedWheelScroll(42);
    const forbidden = calls.sendCommand.filter(c =>
      c.method.startsWith('Runtime.') ||
      c.method.startsWith('Network.') ||
      c.method.startsWith('DOM.'));
    assert.equal(forbidden.length, 0,
      `Runtime/Network/DOM commands forbidden in wheel path. Found: ${JSON.stringify(forbidden)}`);
  });

  it('only sends Input.dispatchMouseEvent (single command family)', async () => {
    const { api, calls } = loadModuleInSandbox({ seedStore: { enhancedModeEnabled: true } });
    await api.dispatchTrustedWheelScroll(42);
    const methods = new Set(calls.sendCommand.map(c => c.method));
    assert.deepEqual([...methods], ['Input.dispatchMouseEvent']);
  });
});

describe('lib/renderer-activation.js — dispatchTrustedWheelScroll error recovery', () => {
  it('detaches even when mouseMoved sendCommand fails', async () => {
    let ctx;
    ctx = loadModuleInSandbox({
      seedStore: { enhancedModeEnabled: true },
      debuggerMethods: {
        sendCommand: (target, method, params, cb) => {
          if (params.type === 'mouseMoved') {
            ctx.sandbox.chrome.runtime.lastError = { message: 'mouseMoved failed' };
          }
          cb();
        }
      }
    });
    const result = await ctx.api.dispatchTrustedWheelScroll(7);
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.attached, true);
    assert.equal(result.detached, true, 'detach MUST still run even if wheel dispatch failed');
    assert.equal(ctx.calls.detach.length, 1);
    assert.match(result.reason, /wheel dispatch failed/);
  });

  it('detaches even when mouseWheel sendCommand fails (after mouseMoved succeeded)', async () => {
    let ctx;
    ctx = loadModuleInSandbox({
      seedStore: { enhancedModeEnabled: true },
      debuggerMethods: {
        sendCommand: (target, method, params, cb) => {
          if (params.type === 'mouseWheel') {
            ctx.sandbox.chrome.runtime.lastError = { message: 'mouseWheel failed' };
          }
          cb();
        }
      }
    });
    const result = await ctx.api.dispatchTrustedWheelScroll(7);
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.detached, true);
    assert.match(result.reason, /wheel dispatch failed/);
  });

  it('returns ok:false (no attach) when Enhanced Mode flag is unset', async () => {
    const { api, calls } = loadModuleInSandbox();
    const result = await api.dispatchTrustedWheelScroll(7);
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.equal(calls.attach.length, 0, 'must NOT attach without flag — fast-fail to avoid banner flicker');
    assert.equal(calls.sendCommand.length, 0);
    assert.equal(calls.detach.length, 0);
    assert.match(result.reason, /debugger permission not granted/);
  });

  it('returns ok:false when attach fails (e.g., another debugger attached)', async () => {
    // dispatchTrustedWheelScroll checks hasDebuggerPermission BEFORE attach,
    // so the chrome override must include storage.local with the flag set —
    // otherwise the test fast-fails with "permission not granted" instead of
    // reaching the attach attempt.
    const overrides = {
      chrome: {
        debugger: {
          attach: (target, v, cb) => {
            chrome.runtime.lastError = { message: 'Another debugger is already attached' };
            cb();
          },
          sendCommand: () => { throw new Error('sendCommand must NOT be called when attach failed'); },
          detach: (target, cb) => cb()
        },
        storage: {
          local: {
            get: (keys, cb) => cb({ enhancedModeEnabled: true }),
            set: (items, cb) => { if (cb) cb(); },
            remove: (keys, cb) => { if (cb) cb(); }
          }
        },
        runtime: { lastError: undefined }
      }
    };
    const { api, calls } = loadModuleInSandbox(overrides);
    const result = await api.dispatchTrustedWheelScroll(7);
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.equal(calls.sendCommand.length, 0);
    assert.equal(calls.detach.length, 0);
    assert.match(result.reason, /attach failed/);
  });

  it('returns ok:false when chrome.debugger is unavailable', async () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    const sandbox = {
      chrome: { runtime: {} }, // no debugger
      console: { log: () => {}, warn: () => {}, error: () => {} },
      module: { exports: {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'renderer-activation.js' });
    const result = await sandbox.module.exports.dispatchTrustedWheelScroll(7);
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.match(result.reason, /chrome\.debugger unavailable/);
  });

  it('returns ok:false for invalid tabId', async () => {
    const { api } = loadModuleInSandbox({ seedStore: { enhancedModeEnabled: true } });
    const r1 = await api.dispatchTrustedWheelScroll(undefined);
    const r2 = await api.dispatchTrustedWheelScroll(-1);
    const r3 = await api.dispatchTrustedWheelScroll('not-a-number');
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(r3.ok, false);
    assert.equal(r1.dispatched, false);
  });
});

describe('lib/renderer-activation.js — RC19 follow-up: CDP step timeout (2026-07-29)', () => {
  // console.log 2026-07-29: every trusted-wheel dispatch took exactly 60s
  // (matching the orchestrator's tab timeout) and returned "Detached while
  // handling command" — meaning the sendCommand callback NEVER fired on its
  // own; only the tab-close reject finally invoked it. For background tabs in
  // some throttled states, Chrome's input pipeline accepts Input.dispatch-
  // MouseEvent but never responds. Without a defensive timeout, the entire
  // 60s budget is wasted on a single hung dispatch.
  //
  // Each CDP step (attach / sendCommand / detach) is now wrapped in a 2s
  // Promise.race. These tests verify the dispatch returns within that cap
  // even when the underlying chrome.debugger callback never fires.

  it('returns within ~2s when sendCommand(mouseMoved) never calls back', async () => {
    const ctx = loadModuleInSandbox({
      seedStore: { enhancedModeEnabled: true },
      debuggerMethods: {
        sendCommand: (target, method, params, cb) => {
          if (params.type === 'mouseMoved') {
            // Intentionally never call cb() — simulates hung CDP callback on
            // a throttled background tab.
            return;
          }
          ctx.calls.sendCommand.push({ target, method, params });
          cb();
        }
      }
    });
    const t0 = Date.now();
    const result = await ctx.api.dispatchTrustedWheelScroll(42);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, 'dispatch must return within ~2s timeout, took ' + elapsed + 'ms');
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.match(result.reason, /wheel dispatch failed/);
    assert.match(result.reason, /timeout/);
    assert.equal(result.detached, true, 'detach MUST still run (it has its own timeout, but the default chrome.debugger.detach in the test harness calls back immediately)');
  });

  it('returns within ~2s when sendCommand(mouseWheel) never calls back', async () => {
    const ctx = loadModuleInSandbox({
      seedStore: { enhancedModeEnabled: true },
      debuggerMethods: {
        sendCommand: (target, method, params, cb) => {
          if (params.type === 'mouseWheel') {
            return; // never calls back
          }
          ctx.calls.sendCommand.push({ target, method, params });
          cb();
        }
      }
    });
    const t0 = Date.now();
    const result = await ctx.api.dispatchTrustedWheelScroll(42);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, 'dispatch must return within ~2s timeout, took ' + elapsed + 'ms');
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false, 'mouseWheel timed out — dispatched must be false');
    assert.match(result.reason, /timeout/);
  });

  it('returns within ~2s when attach never calls back', async () => {
    const overrides = {
      chrome: {
        debugger: {
          attach: (target, v, cb) => { /* never calls cb */ },
          sendCommand: () => { throw new Error('sendCommand must NOT be called when attach hung'); },
          detach: (target, cb) => cb()
        },
        storage: {
          local: {
            get: (keys, cb) => cb({ enhancedModeEnabled: true }),
            set: (items, cb) => { if (cb) cb(); },
            remove: (keys, cb) => { if (cb) cb(); }
          }
        },
        runtime: { lastError: undefined }
      }
    };
    const { api } = loadModuleInSandbox(overrides);
    const t0 = Date.now();
    const result = await api.dispatchTrustedWheelScroll(42);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, 'dispatch must return within ~2s timeout, took ' + elapsed + 'ms');
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.match(result.reason, /attach failed/);
    assert.match(result.reason, /timeout/);
  });
});
