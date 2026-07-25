// Thin console-only logger. Previously this class also accumulated entries in
// chrome.storage.local and the options page exposed Export/Clear buttons —
// that parallel infrastructure duplicated what the browser's devtools console
// already does better, so it was removed (bugx.log 2026-07-25 cleanup).
// All existing debugLogger.log() call sites continue to work unchanged; they
// just emit to console.error/warn/log directly.
//
// Objects are JSON.stringified before being passed to console so Chrome
// devtools "Save All as Log" doesn't collapse them to "Object" — without
// that, fields like selectorDiagnosticCount are invisible in exported logs.

class DebugLogger {
  log(level, component, message, data = null) {
    const prefix = '[' + new Date().toISOString() + '] [' + component + '] ' + message;
    let suffix = '';
    if (data != null) {
      suffix = typeof data === 'string' ? data : (() => {
        try { return JSON.stringify(data); } catch { return String(data); }
      })();
    }
    if (level === 'error') console.error(prefix, suffix);
    else if (level === 'warn') console.warn(prefix, suffix);
    else console.log(prefix, suffix);
  }
}

const debugLogger = new DebugLogger();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DebugLogger, debugLogger };
} else if (typeof window !== 'undefined') {
  window.DebugLogger = DebugLogger;
  window.debugLogger = debugLogger;
} else if (typeof self !== 'undefined') {
  self.DebugLogger = DebugLogger;
  self.debugLogger = debugLogger;
}
