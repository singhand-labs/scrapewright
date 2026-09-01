// extension/lib/session-persistence.js
//
// chrome.storage adapter for the ResearchSession engine's persistence hook
// (spec §4: session state persists to chrome.storage — SW-suspension-safe).
// The engine persists twice per turn (decision-before-tool, result-after);
// debouncing coalesces that burst into one storage.set per turn boundary.
//
// save() resolves IMMEDIATELY — the engine awaits persist() inside the turn
// loop, and awaiting a debounce window would tax every turn. The write lands
// on the trailing edge; flush() forces anything still pending (wizard calls
// it before unload and on session stop so nothing learned is lost).
//
// Storage-agnostic: the storage object is injected (chrome.storage.local in
// the wizard page, a fake in Node tests). IIFE-wrapped per RC30.

(function (global) {

  const DEFAULT_DEBOUNCE_MS = 400;
  const DEFAULT_KEY = 'wizardResearchSession';

  function createSessionPersistence(storage, key, opts) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new Error('createSessionPersistence requires a storage {get,set} object');
    }
    const k = typeof key === 'string' && key ? key : DEFAULT_KEY;
    const o = opts || {};
    const debounceMs = typeof o.debounceMs === 'number' ? o.debounceMs : DEFAULT_DEBOUNCE_MS;
    let timer = null;
    let pending = null;

    function writeNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      const data = pending;
      pending = null;
      if (data == null) return Promise.resolve();
      let payload;
      try {
        payload = JSON.parse(JSON.stringify(data));
      } catch (e) {
        // Unserializable state (cyclic tool result) is dropped, not stored —
        // the engine's dispatch boundary already sanitizes results, this is
        // the belt to that suspenders.
        return Promise.resolve();
      }
      const box = {};
      box[k] = payload;
      return new Promise((resolve) => storage.set(box, () => resolve()));
    }

    return {
      async save(state) {
        pending = state;
        if (debounceMs <= 0) return writeNow();
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; writeNow(); }, debounceMs);
      },
      async flush() { return writeNow(); },
      async load() {
        return new Promise((resolve) => {
          storage.get([k], (data) => {
            const v = data && data[k];
            resolve(v && typeof v === 'object' ? v : null);
          });
        });
      },
      async clear() {
        pending = null;
        if (timer) { clearTimeout(timer); timer = null; }
        return new Promise((resolve) => storage.remove(k, () => resolve()));
      }
    };
  }

  const api = { createSessionPersistence };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SessionPersistence = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
