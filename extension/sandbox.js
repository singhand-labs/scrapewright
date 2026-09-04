(function() {
  'use strict';

  // Log as early as possible — before any other code runs
  console.log('[info] [sandbox] sandbox.js IIFE entered', { location: typeof location !== 'undefined' ? location.href : 'n/a' });

  let domRequestId = 0;
  const pendingDomRequests = new Map();

  // Module-scope accumulator for per-call selector diagnostics stripped from
  // DOM_RESPONSEs. Reset to [] after each execution so diagnostics don't leak
  // between calls (selector diagnostics — spec 2026-07-24 Task 3).
  let __selectorDiagnostics__ = [];

  function sendDebugLog(level, component, message, data) {
    const prefix = '[' + level + '] [' + component + '] ' + message;
    if (level === 'error') console.error(prefix, data || '');
    else if (level === 'warn') console.warn(prefix, data || '');
    else console.log(prefix, data || '');
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
  window.$click = (sel, timeoutMs) => sendDomRequest('click', sel, timeoutMs !== undefined ? [timeoutMs] : []);
  window.$type = (sel, text, timeoutMs) => sendDomRequest('type', sel, [text, timeoutMs]);
  window.$extract = (sel, attr, timeoutMs) => sendDomRequest('extract', sel, [attr, timeoutMs]);
  window.$wait = (sel, ms) => sendDomRequest('wait', sel, [ms]);
  window.$check = (sel, prop) => sendDomRequest('check', sel, [prop]);
  window.$exists = (sel, timeoutMs) => sendDomRequest('exists', sel, [timeoutMs]);
  window.$labelledby = (sel, attr, timeoutMs) => sendDomRequest('labelledby', sel, [attr, timeoutMs]);
  window.$count = (sel) => sendDomRequest('count', sel);
  window.$list = (sel) => sendDomRequest('list', sel);
window.$waitForStable = (sel, opts) => sendDomRequest('waitForStable', sel, [opts || {}]);
  window.$openTab = (url, fn) => sendDomRequest('openTab', null, [url, fn ? fn.toString() : '']);
  window.$extractList = (containerSel, fieldMap, opts) => sendDomRequest('extractList', containerSel, [fieldMap, opts || {}]);
  // Multi-match variant: each field returns Array of ALL matches (not just first).
  // Use when CSS alone can't disambiguate which match is the right one (e.g.
  // a[role=link] inside an FB post matches BOTH author and timestamp links —
  // pick by text/attribute regex in JS). Regression for console.log 2026-07-26 RC4.
  window.$extractListMulti = (containerSel, fieldMap, opts) => sendDomRequest('extractListMulti', containerSel, [fieldMap, opts || {}]);
  // $extractWithHover: container-scoped extract-then-hover. Extracts fields
  // per container AND hovers every anchor inside each container in one call,
  // returning records with a hovercards[] array (variable length per record).
  // Eliminates the post-hovercard alignment bug that the manual
  // $hover(..., { index: i }) loop pattern has when containers hold variable
  // numbers of anchors. See $EXTRACT-WITH-HOVER in SCRIPT_DSL_GUIDE.
  window.$extractWithHover = (containerSel, fieldMap, opts) => sendDomRequest('extractWithHover', containerSel, [fieldMap, opts || {}]);
  window.$clickInList = (containerSel, subSel, opts) => sendDomRequest('clickInList', containerSel, [subSel, opts || {}]);
  // Scroll DSL — see SCROLLING section in SCRIPT_DSL_GUIDE. Scrolls the target
  // tab (window or a matched scrollable element), NOT the sandbox iframe.
  // Returns { scrolled, prevY, newY } so loops can terminate when the position
  // stops changing (content exhausted). bugx.log 2026-07-24: step 2 had dead
  // `if (scrollable) { /* empty */ }` code because no scroll API existed.
  window.$scrollBy = (deltaY, selector) => sendDomRequest('scrollBy', selector || null, [deltaY]);
  window.$scrollToBottom = (selector) => sendDomRequest('scrollToBottom', selector || null);
  window.$scrollIntoView = (selector) => sendDomRequest('scrollIntoView', selector);
  // $hover: dispatch a trusted mouseMoved at the anchor's bounding-box center
  // via CDP, wait for the popover selector to appear, return its outerHTML as
  // htmlSnippet. Use for hovercard/link-preview enrichment — fields not in the
  // list DOM but present in the page's hover popover. Prefer this over $openTab
  // for hovercards: $openTab opens a new tab (slow, navigation lifecycle);
  // $hover stays in-page and reuses the already-loaded page JS. See
  // HOVER ENRICHMENT in SCRIPT_DSL_GUIDE.
  window.$hover = (anchorSel, popoverSel, opts) => sendDomRequest('hover', anchorSel, [popoverSel, opts || {}]);

  window.addEventListener('message', (e) => {
    if (e.data.type === 'DOM_RESPONSE') {
      const pending = pendingDomRequests.get(e.data.id);
      if (!pending) return;
      pendingDomRequests.delete(e.data.id);
      sendDebugLog(e.data.error ? 'error' : 'info', 'sandbox', 'DOM_RESPONSE received', { id: e.data.id, error: e.data.error, resultType: typeof e.data.result });
      if (e.data.error) {
        const err = new Error(e.data.error);
        if (e.data.subTabSnapshot) err.subTabSnapshot = e.data.subTabSnapshot;
        // B2: keep diagnostics on the rejected Error too — script-level
        // catch handlers can then read why the call failed.
        if (e.data._diagnostics) err._diagnostics = e.data._diagnostics;
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
      executeInSandbox(e.data.script, e.data.input, e.data.execId);
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
          error: enrichSyntaxErrorMessage(error, e.data.script)
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

  // Twentieth log: a SyntaxError thrown by the Function constructor carries
  // NO position (V8 compiles the string without a source URL), so a one-char
  // typo — html:{selector':'', attr:...}, a stray quote — surfaced to the
  // model as a bare "Unexpected string" over a 2000-char script and it spent
  // four turns guessing at wrappers. locateSyntaxFailure finds the offset by
  // prefix-scanning: the smallest prefix whose compile error message EQUALS
  // the full script's message. Prefixes ending mid-token or mid-string fail
  // with different messages ("Invalid or unexpected token", "Unexpected end
  // of input"), so the first message-equal prefix lands on the token that
  // starts the fatal parse. Only runs on the compile-failure path.
  const WRAP_PREFIX = '(async function(__input__) {';
  const WRAP_SUFFIX = '})(__input__);';
  const SYNTAX_LOCATOR_MAX_CHARS = 20000;

  function unwrapForDiagnostics(scriptCode) {
    // Production scripts arrive wrapped by OffscreenExecutor.wrapScript —
    // report positions in the step script the model authored, not the
    // wrapper. The prefix contains no newline, so line numbers are
    // identical either way; this keeps column numbers honest too.
    if (typeof scriptCode === 'string' &&
        scriptCode.indexOf(WRAP_PREFIX) === 0 &&
        scriptCode.slice(-WRAP_SUFFIX.length) === WRAP_SUFFIX) {
      return scriptCode.slice(WRAP_PREFIX.length, scriptCode.length - WRAP_SUFFIX.length);
    }
    return scriptCode;
  }

  function compileProbe(code) {
    // eslint-disable-next-line no-new
    new Function('__input__', '__stepResults__', '__lastResult__', 'return (async function(__input__) {' + code + '})(__input__);');
  }

  function locateSyntaxFailure(script) {
    if (typeof script !== 'string' || !script || script.length > SYNTAX_LOCATOR_MAX_CHARS) return null;
    let target = null;
    try { compileProbe(script); } catch (e) { target = e && e.message; }
    if (!target) return null;
    for (let i = 1; i <= script.length; i++) {
      try { compileProbe(script.slice(0, i)); } catch (e) {
        if (e && e.message === target) return { offset: i - 1, message: target };
      }
    }
    return null;
  }

  function enrichSyntaxErrorMessage(error, scriptCode) {
    const inner = unwrapForDiagnostics(scriptCode);
    let msg = 'SYNTAX_ERROR: ' + ((error && error.message) || String(error));
    const located = locateSyntaxFailure(inner);
    if (!located) {
      return msg + ' (no position located — check quote/brace/bracket balance across the whole script)';
    }
    const offset = located.offset;
    let line = 1;
    let lastNl = -1;
    for (let i = 0; i < offset; i++) {
      if (inner.charCodeAt(i) === 10) { line += 1; lastNl = i; }
    }
    const col = offset - lastNl;
    const start = Math.max(0, offset - 70);
    const end = Math.min(inner.length, offset + 70);
    const snippet = inner.slice(start, offset) + '>>><<<' + inner.slice(offset, end);
    return msg + ' at line ' + line + ', column ' + col + ' of the step script (char ' + offset + '/' + inner.length +
      '). Near: ' + snippet +
      " — the parser choked at the marked (>>><<<) position; check the quotes, braces, and brackets right there (a stray quote before a colon, e.g. selector':, or an unbalanced bracket, is the usual cause).";
  }

  async function executeInSandbox(scriptCode, input, execId) {
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
        parent.postMessage({ type: 'EXECUTE_RESULT', execId: execId, error: err.message }, '*');
        return;
      }
      let fn;
      try {
        fn = new Function('__input__', '__stepResults__', '__lastResult__', `return ${scriptCode};`);
      } catch (error) {
        // Twentieth log: compile failures carried no position — enrich with
        // the located offset so the model (and diag.read) can see WHERE.
        const msg = enrichSyntaxErrorMessage(error, scriptCode);
        sendDebugLog('error', 'sandbox', 'Script failed to compile', { error: msg });
        parent.postMessage({ type: 'EXECUTE_RESULT', execId: execId, error: msg }, '*');
        return;
      }
      const result = await fn(input, input._stepResults || {}, input._lastResult || null);
      // Snapshot + reset the per-execution diagnostics accumulator. Diagnostics
      // only ride on the success path — error responses stay unchanged.
      const selectorDiagnostics = __selectorDiagnostics__;
      __selectorDiagnostics__ = [];
      sendDebugLog('info', 'sandbox', 'Script completed', { resultType: typeof result, resultPreview: JSON.stringify(result)?.slice(0, 500), selectorDiagnosticCount: selectorDiagnostics.length });
      parent.postMessage({ type: 'EXECUTE_RESULT', execId: execId, result, selectorDiagnostics }, '*');
    } catch (error) {
      sendDebugLog('error', 'sandbox', 'Script execution error', { error: error.message, stack: error.stack, scriptPreview: scriptCode?.slice(0, 2000), hasSubTabSnapshot: !!error.subTabSnapshot });
      // B2: diagnostics ride the error path too — the failing call's own
      // diagnostics (attached to the Error) plus any accumulated before it.
      const errorDiags = __selectorDiagnostics__.slice();
      if (error && error._diagnostics) errorDiags.push(error._diagnostics);
      __selectorDiagnostics__ = [];
      parent.postMessage({ type: 'EXECUTE_RESULT', execId: execId, error: error.message || String(error), subTabSnapshot: error.subTabSnapshot || undefined, selectorDiagnostics: errorDiags }, '*');
    }
  }

  sendDebugLog('info', 'sandbox', 'Sandbox initialized, sending SANDBOX_READY');
  try {
    parent.postMessage({ type: 'SANDBOX_READY' }, '*');
    sendDebugLog('info', 'sandbox', 'SANDBOX_READY sent successfully');
  } catch (e) {
    console.error('[error] [sandbox] SANDBOX_READY postMessage failed', { error: e.message });
  }
})();
