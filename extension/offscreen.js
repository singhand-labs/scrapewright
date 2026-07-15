(function() {
  'use strict';

  const tabIdStack = [];
  let sandboxIframe = null;
  let sandboxReady = false;
  const pendingExecutes = [];
  const forwardedResponseIds = new Set();

  function sendDebugLog(level, component, message, data) {
    try {
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', level, component, message, data });
      console.log(`[${level}] [${component}] ${message}`, data || '');
    } catch (e) { /* no connection */ }
  }

  sendDebugLog('info', 'offscreen', 'Offscreen document script loaded');

  function ensureSandbox() {
    if (sandboxIframe) return;
    sandboxIframe = document.createElement('iframe');
    sandboxIframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    sandboxIframe.src = chrome.runtime.getURL('sandbox.html');
    sandboxIframe.onload = () => {
      sendDebugLog('info', 'offscreen', 'Sandbox iframe onload fired');
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
      sendDebugLog('info', 'offscreen', 'Sandbox ready, processing pending executes', { count: pendingExecutes.length });
      while (pendingExecutes.length) {
        const { script, input } = pendingExecutes.shift();
        forwardExecute(script, input);
      }
    } else if (e.data.type === 'EXECUTE_RESULT') {
      const tabId = tabIdStack.pop() || null;
      sendDebugLog('info', 'offscreen', 'EXECUTE_RESULT from sandbox', { error: e.data.error, resultType: typeof e.data.result, hasSubTabSnapshot: !!e.data.subTabSnapshot });
      chrome.runtime.sendMessage({
        type: 'SCRIPT_RESULT',
        result: e.data.result,
        error: e.data.error,
        subTabSnapshot: e.data.subTabSnapshot,
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
    } else if (e.data.type === 'DEBUG_LOG') {
      sendDebugLog(e.data.level, e.data.component, e.data.message, e.data.data);
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
        sandboxIframe.contentWindow.postMessage({
          type: 'DOM_RESPONSE',
          id: message.id,
          result: message.result,
          error: message.error
        }, '*');
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
