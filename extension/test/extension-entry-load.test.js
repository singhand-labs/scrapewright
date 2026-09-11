// extension/test/extension-entry-load.test.js
// Sixty-first incident: the user hit "Service worker registration failed.
// Status code: 2" at extension install. Forensics on HEAD found every file
// clean (node --check + a full mocked-chrome vm evaluation), so the shipped
// tree was loadable — but the investigation exposed a STRUCTURAL BLIND SPOT:
// the suite never PARSES the entry files (background.js, wizard.js,
// content-script.js, offscreen.js, options.js, popup.js, sandbox.js are only
// ever read as TEXT by source-audit tests). A syntax error in any of them —
// or a top-level runtime throw in the service worker chain — passes all 2548
// tests while the extension refuses to install. Two guards:
//   1. every shipped .js file must COMPILE (vm.Script: parse only, no execute)
//   2. background.js + its full importScripts chain must EVALUATE against a
//      mocked chrome.* surface with ZERO top-level throws — the exact
//      failure class behind SW registration status-code failures.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_ROOT = path.join(__dirname, '..');

function listJsFiles(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'test' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) listJsFiles(full, acc);
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
}

describe('extension entry-load guard (sixty-first log)', () => {
  it('every shipped .js file parses (vm.Script compile, no execute)', () => {
    const files = listJsFiles(EXT_ROOT);
    assert.ok(files.length >= 40, `sanity: walked a real tree (${files.length} files)`);
    const failures = [];
    for (const f of files) {
      try {
        new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
      } catch (e) {
        failures.push(`${path.relative(EXT_ROOT, f)}: ${e.message}`);
      }
    }
    assert.deepEqual(failures, [], 'all shipped JS must parse or the extension cannot load');
  });

  it('carries no NUL bytes anywhere in shipped source (exotic-loader risk)', () => {
    const files = listJsFiles(EXT_ROOT);
    const dirty = [];
    for (const f of files) {
      if (fs.readFileSync(f).includes(0)) dirty.push(path.relative(EXT_ROOT, f));
    }
    assert.deepEqual(dirty, [], 'literal NUL bytes in source are replaceable with \\u0000 escapes');
  });

  it('the service worker chain evaluates with no top-level throw (mocked chrome)', () => {
    const listeners = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
    const storageArea = () => {
      const store = {};
      return {
        get(args, cb) {
          let out = {};
          if (args == null) out = { ...store };
          else if (typeof args === 'string') { if (args in store) out[args] = store[args]; }
          else if (Array.isArray(args)) { for (const k of args) if (k in store) out[k] = store[k]; }
          else if (typeof args === 'object') { for (const k of Object.keys(args)) out[k] = k in store ? store[k] : args[k]; }
          if (typeof cb === 'function') { cb(out); return; }
          return Promise.resolve(out);
        },
        set(args, cb) {
          Object.assign(store, args);
          if (typeof cb === 'function') { cb(); return; }
          return Promise.resolve();
        },
        remove(args, cb) {
          for (const k of Array.isArray(args) ? args : [args]) delete store[k];
          if (typeof cb === 'function') { cb(); return; }
          return Promise.resolve();
        }
      };
    };
    const chromeMock = {
      runtime: {
        onMessage: listeners(), onInstalled: listeners(), onStartup: listeners(),
        sendMessage: (m, cb) => (typeof cb === 'function' ? cb(undefined) : Promise.resolve(undefined)),
        openOptionsPage() {}, getURL: (p) => 'chrome-extension://x/' + p, id: 'x', lastError: null
      },
      storage: { local: storageArea(), session: storageArea(), sync: storageArea(), onChanged: listeners() },
      tabs: {
        get: (id, cb) => cb && cb({ id, status: 'complete' }),
        create: (o, cb) => cb && cb({ id: 1, ...o }),
        update: (id, o, cb) => (typeof cb === 'function' ? cb({ id }) : Promise.resolve({ id })),
        remove: (id, cb) => cb && cb(),
        sendMessage: (id, m, cb) => (typeof cb === 'function' ? cb({ ok: true }) : Promise.resolve({ ok: true })),
        query: (q, cb) => cb && cb([]),
        onActivated: listeners(), onRemoved: listeners(), onUpdated: listeners()
      },
      windows: {
        update: (id, o, cb) => (typeof cb === 'function' ? cb({ id }) : Promise.resolve({ id })),
        get: (id, o, cb) => cb && cb({ id, focused: true, state: 'normal' }),
        getLastFocused: (cb) => cb && cb({ id: 1, focused: true }),
        onFocusChanged: listeners(), onCreated: listeners()
      },
      alarms: { create() {}, clear() {}, onAlarm: listeners() },
      action: { onClicked: listeners(), setBadgeText() {}, setBadgeBackgroundColor() {} },
      offscreen: { createDocument: () => Promise.resolve(), hasDocument: () => Promise.resolve(false), closeDocument: () => Promise.resolve() },
      scripting: { executeScript: () => Promise.resolve([{ result: null }]) },
      debugger: { attach() {}, detach() {}, sendCommand() {}, onEvent: listeners(), onDetach: listeners() }
    };
    const ctx = {
      chrome: chromeMock,
      console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      performance: { now: () => Date.now() },
      crypto: { randomUUID: () => 'u', getRandomValues: (a) => a },
      fetch: () => Promise.reject(new Error('offline')),
      URL, TextEncoder, TextDecoder, AbortController,
      navigator: { userAgent: 'test' },
      importScripts: (...files) => {
        for (const f of files) {
          vm.runInContext(fs.readFileSync(path.join(EXT_ROOT, f), 'utf8'), ctx, { filename: f });
        }
      }
    };
    ctx.self = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    assert.doesNotThrow(() => {
      vm.runInContext(fs.readFileSync(path.join(EXT_ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
    }, 'the SW chain must evaluate cleanly or registration fails at install');
  });
});
