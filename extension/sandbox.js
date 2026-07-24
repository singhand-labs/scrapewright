(function() {
  'use strict';

  // Log as early as possible — before any other code runs
  try {
    parent.postMessage({ type: 'DEBUG_LOG', level: 'info', component: 'sandbox', message: 'sandbox.js IIFE entered', data: { location: typeof location !== 'undefined' ? location.href : 'n/a' } }, '*');
  } catch (e) { /* no connection */ }

  let domRequestId = 0;
  const pendingDomRequests = new Map();

  // Module-scope accumulator for per-call selector diagnostics stripped from
  // DOM_RESPONSEs. Reset to [] after each execution so diagnostics don't leak
  // between calls (selector diagnostics — spec 2026-07-24 Task 3).
  let __selectorDiagnostics__ = [];

  function sendDebugLog(level, component, message, data) {
    try {
      parent.postMessage({ type: 'DEBUG_LOG', level, component, message, data }, '*');
      console.log(`[${level}] [${component}] ${message}`, data || '');
    } catch (e) { /* no connection */ }
  }

  function sendDomRequest(action, selector, args) {
    return new Promise((resolve, reject) => {
      const id = ++domRequestId;
      pendingDomRequests.set(id, { resolve, reject });
      sendDebugLog('info', 'sandbox', 'Sending DOM_REQUEST', { id, action, selector });
      parent.postMessage({
        type: 'DOM_REQUEST',
        id,
        action,
        selector,
        args: args || []
      }, '*');
    });
  }

  window.$ = (sel) => sendDomRequest('querySelector', sel);
  window.$click = (sel) => sendDomRequest('click', sel);
  window.$type = (sel, text) => sendDomRequest('type', sel, [text]);
  window.$extract = (sel, attr, timeoutMs) => sendDomRequest('extract', sel, [attr, timeoutMs]);
  window.$wait = (sel, ms) => sendDomRequest('wait', sel, [ms]);
  window.$check = (sel, prop) => sendDomRequest('check', sel, [prop]);
  window.$exists = (sel, timeoutMs) => sendDomRequest('exists', sel, [timeoutMs]);
  window.$count = (sel) => sendDomRequest('count', sel);
  window.$list = (sel) => sendDomRequest('list', sel);
window.$waitForStable = (sel, opts) => sendDomRequest('waitForStable', sel, [opts || {}]);
  window.$openTab = (url, fn) => sendDomRequest('openTab', null, [url, fn ? fn.toString() : '']);
  window.$extractList = (containerSel, fieldMap, opts) => sendDomRequest('extractList', containerSel, [fieldMap, opts || {}]);
  window.$clickInList = (containerSel, subSel, opts) => sendDomRequest('clickInList', containerSel, [subSel, opts || {}]);
  // Scroll DSL — see SCROLLING section in SCRIPT_DSL_GUIDE. Scrolls the target
  // tab (window or a matched scrollable element), NOT the sandbox iframe.
  // Returns { scrolled, prevY, newY } so loops can terminate when the position
  // stops changing (content exhausted). bugx.log 2026-07-24: step 2 had dead
  // `if (scrollable) { /* empty */ }` code because no scroll API existed.
  window.$scrollBy = (deltaY, selector) => sendDomRequest('scrollBy', selector || null, [deltaY]);
  window.$scrollToBottom = (selector) => sendDomRequest('scrollToBottom', selector || null);
  window.$scrollIntoView = (selector) => sendDomRequest('scrollIntoView', selector);

  window.addEventListener('message', (e) => {
    if (e.data.type === 'DOM_RESPONSE') {
      const pending = pendingDomRequests.get(e.data.id);
      if (!pending) return;
      pendingDomRequests.delete(e.data.id);
      sendDebugLog(e.data.error ? 'error' : 'info', 'sandbox', 'DOM_RESPONSE received', { id: e.data.id, error: e.data.error, resultType: typeof e.data.result });
      if (e.data.error) {
        const err = new Error(e.data.error);
        if (e.data.subTabSnapshot) err.subTabSnapshot = e.data.subTabSnapshot;
        pending.reject(err);
      } else {
        // Strip _diagnostics before resolving so the user-facing $ API value
        // stays unchanged (script promise resolves with e.data.result only).
        // Truthy check (not '_diagnostics' in e.data) because content-script
        // sends _diagnostics: undefined for non-target actions like $click.
        if (e.data._diagnostics) {
          __selectorDiagnostics__.push(e.data._diagnostics);
        }
        pending.resolve(e.data.result);
      }
    } else if (e.data.type === 'EXECUTE') {
      sendDebugLog('info', 'sandbox', 'EXECUTE received', { scriptPreview: e.data.script?.slice(0, 2000), scriptLength: e.data.script?.length });
      executeInSandbox(e.data.script, e.data.input);
    } else if (e.data.type === 'SYNTAX_CHECK') {
      try {
        // Mirror the wrapping used by executeInSandbox so we catch the same
        // failure modes (e.g. script missing a return statement would still
        // parse, but syntax errors will throw).
        // eslint-disable-next-line no-new
        new Function('__input__', '__stepResults__', '__lastResult__', `return ${e.data.script};`);
        parent.postMessage({ type: 'SYNTAX_CHECK_RESULT', reqId: e.data.reqId, ok: true }, '*');
      } catch (error) {
        parent.postMessage({
          type: 'SYNTAX_CHECK_RESULT',
          reqId: e.data.reqId,
          ok: false,
          error: error.message || String(error)
        }, '*');
      }
    }
  });

  // Scripts run inside this sandboxed iframe, NOT the target page. Any attempt
  // to navigate (window.location.href = ..., location.replace(...), etc.) destroys
  // the sandbox and silently breaks every subsequent operation. Catch it here and
  // return a clear error so the LLM learns — otherwise the failure looks like an
  // arbitrary 60s SCRIPT_TIMEOUT (see bugx.log 2026-07-24 root-cause analysis).
  const NAVIGATION_PATTERNS = [
    /\bwindow\s*\.\s*location\s*\.\s*href\s*=/,            // window.location.href = X
    /\bwindow\s*\.\s*location\s*\.\s*replace\s*\(/,        // window.location.replace(...)
    /\bwindow\s*\.\s*location\s*\.\s*assign\s*\(/,         // window.location.assign(...)
    /\bwindow\s*\.\s*location\s*=[^=]/,                    // window.location = X
    /\blocation\s*\.\s*href\s*=/,                          // location.href = X
    /\blocation\s*\.\s*replace\s*\(/,                      // location.replace(...)
    /\blocation\s*\.\s*assign\s*\(/                       // location.assign(...)
    // Note: bare `location = X` is intentionally NOT matched — it false-positives
    // on legitimate `const location = ...` declarations. The `window.location = X`
    // pattern above catches the navigation form; raw `location = X` (without
    // `window.`) is virtually never generated for navigation.
  ];
  function detectForbiddenNavigation(script) {
    if (typeof script !== 'string' || !script) return null;
    for (const p of NAVIGATION_PATTERNS) {
      const m = script.match(p);
      if (m) return m[0];
    }
    return null;
  }

  async function executeInSandbox(scriptCode, input) {
    // Reset before each execution — covers residue from prior failed runs
    // (the catch path does not reset, so without this a later successful
    // run would snapshot the previous run's diagnostics along with its own).
    __selectorDiagnostics__ = [];
    try {
      sendDebugLog('info', 'sandbox', 'Creating Function and executing script', { scriptLength: scriptCode?.length });
      const navMatch = detectForbiddenNavigation(scriptCode);
      if (navMatch) {
        const err = new Error(
          'FORBIDDEN_NAVIGATION: script contains "' + navMatch + '". ' +
          'Scripts run inside a sandboxed iframe — assigning window.location.* destroys the sandbox and ' +
          'breaks all subsequent operations. The target page URL is set by the service config ' +
          '(with {{placeholders}} resolved before page load); the script only does post-load operations. ' +
          'Remove all window.location.* / location.replace() / location.assign() usage.'
        );
        sendDebugLog('error', 'sandbox', 'Forbidden navigation detected — refusing to execute', { match: navMatch, scriptPreview: (scriptCode || '').slice(0, 500) });
        parent.postMessage({ type: 'EXECUTE_RESULT', error: err.message }, '*');
        return;
      }
      const fn = new Function('__input__', '__stepResults__', '__lastResult__', `return ${scriptCode};`);
      const result = await fn(input, input._stepResults || {}, input._lastResult || null);
      // Snapshot + reset the per-execution diagnostics accumulator. Diagnostics
      // only ride on the success path — error responses stay unchanged.
      const selectorDiagnostics = __selectorDiagnostics__;
      __selectorDiagnostics__ = [];
      sendDebugLog('info', 'sandbox', 'Script completed', { resultType: typeof result, resultPreview: JSON.stringify(result)?.slice(0, 500), selectorDiagnosticCount: selectorDiagnostics.length });
      parent.postMessage({ type: 'EXECUTE_RESULT', result, selectorDiagnostics }, '*');
    } catch (error) {
      sendDebugLog('error', 'sandbox', 'Script execution error', { error: error.message, stack: error.stack, scriptPreview: scriptCode?.slice(0, 2000), hasSubTabSnapshot: !!error.subTabSnapshot });
      parent.postMessage({ type: 'EXECUTE_RESULT', error: error.message || String(error), subTabSnapshot: error.subTabSnapshot || undefined }, '*');
    }
  }

  sendDebugLog('info', 'sandbox', 'Sandbox initialized, sending SANDBOX_READY');
  try {
    parent.postMessage({ type: 'SANDBOX_READY' }, '*');
    sendDebugLog('info', 'sandbox', 'SANDBOX_READY sent successfully');
  } catch (e) {
    try {
      parent.postMessage({ type: 'DEBUG_LOG', level: 'error', component: 'sandbox', message: 'SANDBOX_READY postMessage failed', data: { error: e.message } }, '*');
    } catch (e2) { /* no connection */ }
  }
})();
