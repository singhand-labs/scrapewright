(function() {
  'use strict';

  const tabIdStack = [];
  let sandboxIframe = null;
  let sandboxReady = false;
  let sandboxReadyTimer = null;
  let sandboxRecreateCount = 0;
  const SANDBOX_MAX_RECREATES = 3;
  const pendingExecutes = [];
  const forwardedResponseIds = new Set();

  // Build the payload to postMessage to the sandbox iframe when a DOM_RESPONSE
  // arrives from background. Extracted as a named pure function so the
  // _diagnostics preservation contract has a unit test (regression for
  // bugx.log 2026-07-25: this hop previously dropped _diagnostics, which
  // silently broke the entire selector-diagnostics pipeline and produced
  // selectorDiagnosticCount: 0 on every STEP_ITERATION despite the
  // instrumentation being live in source).
  function buildSandboxForwardPayload(message) {
    return {
      type: 'DOM_RESPONSE',
      id: message.id,
      result: message.result,
      error: message.error,
      _diagnostics: message._diagnostics
    };
  }
  if (typeof self !== 'undefined') self.buildSandboxForwardPayload = buildSandboxForwardPayload;
  if (typeof window !== 'undefined') window.buildSandboxForwardPayload = buildSandboxForwardPayload;

  function sendDebugLog(level, component, message, data) {
    const prefix = '[' + level + '] [' + component + '] ' + message;
    if (level === 'error') console.error(prefix, data || '');
    else if (level === 'warn') console.warn(prefix, data || '');
    else console.log(prefix, data || '');
  }

  sendDebugLog('info', 'offscreen', 'Offscreen document script loaded');

  function clearSandboxReadyTimer() {
    if (sandboxReadyTimer) {
      clearTimeout(sandboxReadyTimer);
      sandboxReadyTimer = null;
    }
  }

  // When the sandbox iframe onload fires for the SECOND+ time on the SAME
  // iframe instance, the iframe was reloaded/navigated (e.g. an LLM-generated
  // script did window.location.href = ...). The iframe's contentWindow now
  // points at a different document; messages posted to it are silently dropped.
  // Reset readiness and wait for a fresh SANDBOX_READY. If none arrives within
  // 2s, recreate the iframe. See bugx.log 2026-07-24.
  //
  // IMPORTANT: the FIRST onload on a new iframe must NOT trigger this logic.
  // In Chrome, SANDBOX_READY arrives via postMessage BEFORE the iframe's load
  // event fires. Treating the first onload as a reload causes an infinite
  // loop (sandbox posts ready → onload fires → reset readiness → watchdog
  // recreates → new sandbox posts ready → ...).
  function armSandboxReadyWatchdog(reason) {
    clearSandboxReadyTimer();
    sandboxReadyTimer = setTimeout(() => {
      if (sandboxReady) return;
      if (sandboxRecreateCount >= SANDBOX_MAX_RECREATES) {
        sendDebugLog('error', 'offscreen',
          'Sandbox reload-recreate limit reached — giving up to avoid infinite loop. Test execution will fail with SCRIPT_TIMEOUT.',
          { recreateCount: sandboxRecreateCount, reason });
        return;
      }
      sandboxRecreateCount += 1;
      sendDebugLog('error', 'offscreen',
        'Sandbox did not re-send SANDBOX_READY after onload — assuming it was navigated away. Recreating iframe.',
        { reason, recreateCount: sandboxRecreateCount });
      try { if (sandboxIframe) sandboxIframe.remove(); } catch (e) { /* ignore */ }
      sandboxIframe = null;
      ensureSandbox();
    }, 2000);
  }

  function ensureSandbox() {
    if (sandboxIframe) return;
    sandboxIframe = document.createElement('iframe');
    sandboxIframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    sandboxIframe.src = chrome.runtime.getURL('sandbox.html');
    // Per-iframe flag: the FIRST onload on a fresh iframe is the normal load
    // (sandbox.js has already posted SANDBOX_READY by the time onload fires).
    // Only SUBSEQUENT onloads on the same iframe instance indicate a reload.
    let initialOnloadSeen = false;
    sandboxIframe.onload = () => {
      sendDebugLog('info', 'offscreen', 'Sandbox iframe onload fired', { initialOnloadSeen });
      if (!initialOnloadSeen) {
        initialOnloadSeen = true;
        return;
      }
      // A reload on the SAME iframe instance — navigation likely happened.
      sandboxReady = false;
      sendDebugLog('warn', 'offscreen',
        'Sandbox iframe reloaded after initial load — likely a navigation attempt (window.location.*) inside the sandbox. Resetting readiness.',
        {});
      armSandboxReadyWatchdog('post-initial-onload');
    };
    sandboxIframe.onerror = (err) => {
      sendDebugLog('error', 'offscreen', 'Sandbox iframe onerror fired', { error: String(err) });
    };
    document.body.appendChild(sandboxIframe);
    sendDebugLog('info', 'offscreen', 'Sandbox iframe appended', { src: sandboxIframe.src });

    setTimeout(() => {
      if (!sandboxReady) {
        sendDebugLog('error', 'offscreen', 'SANDBOX_READY not received after 5s', { iframeInDom: !!document.body?.contains(sandboxIframe) });
      }
    }, 5000);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== sandboxIframe?.contentWindow) return;

    if (e.data.type === 'SANDBOX_READY') {
      sandboxReady = true;
      sandboxRecreateCount = 0;  // healthy sandbox — reset the recreate budget
      clearSandboxReadyTimer();
      sendDebugLog('info', 'offscreen', 'Sandbox ready, processing pending executes', { count: pendingExecutes.length });
      while (pendingExecutes.length) {
        const { script, input } = pendingExecutes.shift();
        forwardExecute(script, input);
      }
    } else if (e.data.type === 'EXECUTE_RESULT') {
      const tabId = tabIdStack.pop() || null;
      sendDebugLog('info', 'offscreen', 'EXECUTE_RESULT from sandbox', { error: e.data.error, resultType: typeof e.data.result, hasSubTabSnapshot: !!e.data.subTabSnapshot, selectorDiagnosticCount: (e.data.selectorDiagnostics || []).length });
      chrome.runtime.sendMessage({
        type: 'SCRIPT_RESULT',
        result: e.data.result,
        error: e.data.error,
        subTabSnapshot: e.data.subTabSnapshot,
        selectorDiagnostics: e.data.selectorDiagnostics || [],
        tabId,
        _fromOffscreen: true
      });
    } else if (e.data.type === 'SYNTAX_CHECK_RESULT') {
      sendDebugLog('info', 'offscreen', 'SYNTAX_CHECK_RESULT from sandbox', { reqId: e.data.reqId, ok: e.data.ok });
      chrome.runtime.sendMessage({
        type: 'SYNTAX_CHECK_RESULT',
        reqId: e.data.reqId,
        ok: e.data.ok,
        error: e.data.error,
        _fromOffscreen: true
      });
    } else if (e.data.type === 'DOM_REQUEST') {
      const tabId = tabIdStack.length > 0 ? tabIdStack[tabIdStack.length - 1] : null;
      sendDebugLog('info', 'offscreen', 'DOM_REQUEST from sandbox', { id: e.data.id, action: e.data.action, selector: e.data.selector });
      chrome.runtime.sendMessage({
        type: 'DOM_REQUEST',
        id: e.data.id,
        action: e.data.action,
        selector: e.data.selector,
        args: e.data.args,
        tabId,
        _fromOffscreen: true
      });
    }
  });

  function forwardExecute(script, input) {
    if (sandboxIframe?.contentWindow) {
      sandboxIframe.contentWindow.postMessage({
        type: 'EXECUTE',
        script,
        input
      }, '*');
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'DOM_RESPONSE' && message._fromOffscreen) {
      // Deduplicate: content-script's sendMessage already reaches us directly,
      // and background.js rebroadcasts the same message. Only forward once.
      if (forwardedResponseIds.has(message.id)) return false;
      forwardedResponseIds.add(message.id);
      // Prevent unbounded growth
      if (forwardedResponseIds.size > 2000) {
        const toRemove = [...forwardedResponseIds].slice(0, 1000);
        toRemove.forEach(id => forwardedResponseIds.delete(id));
      }
      sendDebugLog('info', 'offscreen', 'DOM_RESPONSE forwarding to sandbox', { id: message.id });
      if (sandboxIframe?.contentWindow) {
        sandboxIframe.contentWindow.postMessage(buildSandboxForwardPayload(message), '*');
      }
      return false;
    }

    if (message.type === 'EXECUTE_SCRIPT_OFFSCREEN' && message._toOffscreen) {
      tabIdStack.push(message.tabId);
      sendDebugLog('info', 'offscreen', 'EXECUTE_SCRIPT_OFFSCREEN received', { tabId: message.tabId, scriptPreview: message.script?.slice(0, 2000), scriptLength: message.script?.length });
      if (sandboxReady) {
        forwardExecute(message.script, message.input);
      } else {
        sendDebugLog('info', 'offscreen', 'Sandbox not ready yet, queuing execute');
        pendingExecutes.push({ script: message.script, input: message.input });
      }
      return false;
    }

    if (message.type === 'SYNTAX_CHECK_OFFSCREEN' && message._toOffscreen) {
      sendDebugLog('info', 'offscreen', 'SYNTAX_CHECK_OFFSCREEN received', { reqId: message.reqId, scriptPreview: message.script?.slice(0, 200) });
      if (sandboxIframe?.contentWindow) {
        sandboxIframe.contentWindow.postMessage({
          type: 'SYNTAX_CHECK',
          reqId: message.reqId,
          script: message.script
        }, '*');
      } else {
        chrome.runtime.sendMessage({
          type: 'SYNTAX_CHECK_RESULT',
          reqId: message.reqId,
          ok: false,
          error: 'offscreen sandbox iframe not available',
          _fromOffscreen: true
        });
      }
      return false;
    }

    if (message.type === 'EXECUTE_SCRIPT_TIMEOUT' && message._toOffscreen) {
      const idx = tabIdStack.indexOf(message.tabId);
      if (idx !== -1) {
        tabIdStack.splice(idx, 1);
        sendDebugLog('warn', 'offscreen', 'Cleaned up timed-out tabId from stack', { tabId: message.tabId, remainingStack: tabIdStack.length });
      }
      return false;
    }
  });

  if (document.body) {
    ensureSandbox();
  } else {
    document.addEventListener('DOMContentLoaded', ensureSandbox);
  }

  sendDebugLog('info', 'offscreen', 'Offscreen initialized, sending OFFSCREEN_READY');
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY', _fromOffscreen: true });
})();
