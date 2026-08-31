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
//
// Chrome DevTools itself truncates console STRING arguments at ~5000 chars —
// silently, mid-JSON, with no marker. Fourth-session log (2026-08-31): the
// testScript success line carried finalResult for 5 posts and DevTools cut it
// inside post 1; third-session log: postHtml had to be hand-recovered from
// the amputated head. Since the cut is inevitable, cut HERE first with a
// head+tail split and the original length disclosed — both ends of every
// payload survive and the cut point is visible.
const MAX_SUFFIX_CHARS = 4600; // stays under DevTools' ~5000 line cut incl. prefix

function truncateForConsole(s) {
  if (typeof s !== 'string' || s.length <= MAX_SUFFIX_CHARS) return s;
  const tail = 1400;
  const head = MAX_SUFFIX_CHARS - tail - 60; // marker budget
  return s.slice(0, head) +
    ' …[console log truncated; original ' + s.length + ' chars, middle cut]… ' +
    s.slice(s.length - tail);
}

class DebugLogger {
  log(level, component, message, data = null) {
    const prefix = '[' + new Date().toISOString() + '] [' + component + '] ' + message;
    let suffix = '';
    if (data != null) {
      suffix = typeof data === 'string' ? data : (() => {
        try { return JSON.stringify(data); } catch { return String(data); }
      })();
    }
    suffix = truncateForConsole(suffix);
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
