// lib/session-journal.js
//
// 158th round: three consecutive sessions (154/156/157) lost the middle
// hours of EVERY manual console capture — wizard page, service worker,
// and offscreen amputated identically (head minutes + tail minutes
// survived). The debug-logger is console-only by design, so the whole
// diagnostic trail trusted a DevTools save that demonstrably drops the
// turns where the model authors, verifies, and fails.
//
// This journal is the extension-owned replacement: a durable rolling
// buffer of every [session] mirror line (plus optional LLM bodies),
// persisted through page reloads (chrome.storage.local — the manifest
// carries unlimitedStorage) and exportable with one click merged with
// the service-worker ring (GET_DEBUG_JOURNAL).
//
// The backend is injectable: the default uses chrome.storage.local when
// present; tests pass an in-memory backend. Append is synchronous
// (in-memory array); flush is debounced and best-effort — losing the
// last debounce window to a hard reload is acceptable, losing four
// hours is not.

const JOURNAL_STORAGE_KEY = 'sessionJournalRolling';
const DEFAULT_MAX_LINES = 40000;
const DEFAULT_MAX_CHARS = 40 * 1024 * 1024;

function createSessionJournal(backend, opts) {
  const o = opts || {};
  const maxLines = typeof o.maxLines === 'number' ? o.maxLines : DEFAULT_MAX_LINES;
  const maxChars = typeof o.maxChars === 'number' ? o.maxChars : DEFAULT_MAX_CHARS;
  let lines = null; // null = not yet loaded
  let flushTimer = null;

  function totalChars(arr) {
    let n = 0;
    for (let i = 0; i < arr.length; i++) n += (arr[i].text || '').length + (arr[i].label || '').length;
    return n;
  }

  function trimInPlace() {
    let dropped = 0;
    while ((lines.length > maxLines || totalChars(lines) > maxChars) && lines.length > 1) {
      lines.shift();
      dropped += 1;
    }
    if (dropped > 0) {
      lines.unshift({ t: Date.now(), kind: 'marker', label: '[journal trimmed: ' + dropped + ' oldest line(s) dropped]', text: '' });
    }
  }

  function ensureLoaded() {
    if (lines === null) lines = [];
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush();
    }, o.flushDebounceMs || 2000);
  }

  function flush() {
    if (lines === null || !backend) return Promise.resolve();
    return backend.save(lines.slice()).catch(function () { /* best-effort persistence */ });
  }

  return {
    __hydrate: function (stored) {
      if (Array.isArray(stored) && (lines === null || stored.length >= lines.length)) lines = stored.slice();
    },
    append: function (kind, label, text) {
      ensureLoaded();
      lines.push({ t: Date.now(), kind: kind || 'mirror', label: String(label || ''), text: String(text == null ? '' : text) });
      trimInPlace();
      scheduleFlush();
    },
    markSessionStart: function (sessionId, resumed) {
      this.append('marker', '=== SESSION ' + String(sessionId) + ' START' + (resumed ? ' (resumed)' : '') + ' ===', '');
      flush();
    },
    all: function () {
      if (lines === null) lines = [];
      if (backend) return backend.load().then(function (stored) {
        if (Array.isArray(stored) && stored.length >= lines.length) lines = stored;
        return lines.slice();
      }).catch(function () { return lines.slice(); });
      return Promise.resolve(lines.slice());
    },
    flush: flush
  };
}

function createChromeStorageBackend() {
  const area = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  if (!area) return null;
  return {
    load: function () {
      return new Promise(function (resolve) {
        try {
          area.get(JOURNAL_STORAGE_KEY, function (res) {
            resolve(Array.isArray(res && res[JOURNAL_STORAGE_KEY]) ? res[JOURNAL_STORAGE_KEY] : []);
          });
        } catch (e) { resolve([]); }
      });
    },
    save: function (lines) {
      return new Promise(function (resolve, reject) {
        try {
          const bag = {};
          bag[JOURNAL_STORAGE_KEY] = lines;
          area.set(bag, function () {
            if (chrome.runtime && chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
          });
        } catch (e) { reject(e); }
      });
    }
  };
}

// Wizard page instance: load the persisted journal on boot so a reload
// (or a resumed session) continues the same rolling buffer.
function initDefaultSessionJournal() {
  const backend = createChromeStorageBackend();
  const j = createSessionJournal(backend || undefined);
  if (backend) {
    backend.load().then(function (stored) {
      // Hydration happens lazily on first append/all via the backend;
      // eager-load here so all() reflects history immediately.
      j.__hydrate(stored || []);
    }).catch(function () { /* best-effort */ });
  }
  return j;
}

const mod = {
  createSessionJournal: createSessionJournal,
  createChromeStorageBackend: createChromeStorageBackend,
  initDefaultSessionJournal: initDefaultSessionJournal,
  JOURNAL_STORAGE_KEY: JOURNAL_STORAGE_KEY
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = mod;
} else if (typeof window !== 'undefined') {
  window.SessionJournalMod = mod;
} else if (typeof self !== 'undefined') {
  self.SessionJournalMod = mod;
}
