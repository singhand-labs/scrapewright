(function() {
  'use strict';

  // Log as early as possible — before any other code runs
  try {
    parent.postMessage({ type: 'DEBUG_LOG', level: 'info', component: 'sandbox', message: 'sandbox.js IIFE entered', data: { location: typeof location !== 'undefined' ? location.href : 'n/a' } }, '*');
  } catch (e) { /* no connection */ }

  let domRequestId = 0;
  const pendingDomRequests = new Map();

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

  async function executeInSandbox(scriptCode, input) {
    try {
      sendDebugLog('info', 'sandbox', 'Creating Function and executing script', { scriptLength: scriptCode?.length });
      const fn = new Function('__input__', '__stepResults__', '__lastResult__', `return ${scriptCode};`);
      const result = await fn(input, input._stepResults || {}, input._lastResult || null);
      sendDebugLog('info', 'sandbox', 'Script completed', { resultType: typeof result, resultPreview: JSON.stringify(result)?.slice(0, 500) });
      parent.postMessage({ type: 'EXECUTE_RESULT', result }, '*');
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
