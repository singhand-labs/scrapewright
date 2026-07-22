(function() {
  'use strict';

  let isAnnotationMode = false;
  let selectedAnnotations = [];
  let annotationSchemas = { inputSchema: {}, outputSchema: {} };
  let annotationCounterPill = null;
  let activeMenuClose = null;
  let activeElementLabel = null;
  let sandboxIframe = null;
  let sandboxReady = false;
  const sandboxReadyCallbacks = [];
  let currentSenderTabId = null;

  // Intent dropdown presets — keep in sync with wizard-utils.js
  // ANNOTATION_PURPOSES / WAIT_CONDITIONS. The content-script cannot require
  // modules (it runs injected in the page), so the small preset list is
  // duplicated here. Update both together when adding a purpose/condition.
  const PURPOSES = [
    { value: 'submit', label: 'Submit' },
    { value: 'toggle', label: 'Toggle State' },
    { value: 'navigate', label: 'Navigate / Paginate' },
    { value: 'expand', label: 'Expand / Collapse' },
    { value: 'wait-for-load', label: 'Wait for Load' },
    { value: 'check-login', label: 'Check Login State' },
    { value: 'verify-state', label: 'Verify State' },
    { value: 'other', label: 'Other…' }
  ];
  const WAIT_CONDITIONS = [
    { value: 'appear', label: 'Element Appears' },
    { value: 'disappear', label: 'Element Disappears' },
    { value: 'textStable', label: 'Text Stabilizes' },
    { value: 'attributeChange', label: 'Attribute Changes' }
  ];
  // Annotation listener tracking — documents we've attached capture-phase
  // click/mouseover/keydown listeners to (top doc + same-origin iframe docs).
  let attachedAnnotationDocs = [];
  let iframeObserver = null;
  let hoverLogCounter = 0;
  let lastHoverTarget = null;

  function sendDebugLog(level, component, message, data) {
    try {
      const payload = { type: 'DEBUG_LOG', level, component, message, data };
      chrome.runtime.sendMessage(payload);
      console.log(`[${level}] [${component}] ${message}`, data || '');
    } catch (e) { /* no connection */ }
  }

  sendDebugLog('info', 'content-script', 'Content script loaded', { url: location.href, readyState: document.readyState });

  // ===== Sandbox =====
  function ensureSandbox() {
    sendDebugLog('info', 'content-script', 'ensureSandbox called', { hasIframe: !!sandboxIframe, hasBody: !!document.body, readyState: document.readyState });
    if (sandboxIframe) {
      sendDebugLog('info', 'content-script', 'ensureSandbox: iframe already exists');
      return;
    }
    if (!document.body) {
      sendDebugLog('warn', 'content-script', 'ensureSandbox: document.body not ready, retrying');
      setTimeout(ensureSandbox, 50);
      return;
    }

    // Log any CSP meta tags that might block our iframe
    const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (cspMeta) {
      sendDebugLog('warn', 'content-script', 'Page has CSP meta tag', { content: cspMeta.getAttribute('content') });
    }

    sandboxIframe = document.createElement('iframe');
    // Use visibility-off positioning instead of display:none to avoid
    // browsers deferring resource loads in hidden iframes.
    sandboxIframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    // sandbox.html is already declared as a sandbox page in manifest.json.
    // Adding sandbox="allow-scripts" here can conflict with the declared
    // sandbox and cause scripts inside to not execute on some sites.
    sandboxIframe.src = chrome.runtime.getURL('sandbox.html');

    sandboxIframe.onload = () => {
      sendDebugLog('info', 'content-script', 'Sandbox iframe onload fired', { src: sandboxIframe.src });
    };
    sandboxIframe.onerror = (err) => {
      sendDebugLog('error', 'content-script', 'Sandbox iframe onerror fired', { error: String(err) });
    };

    document.body.appendChild(sandboxIframe);
    sendDebugLog('info', 'content-script', 'Sandbox iframe appended to body', { src: sandboxIframe.src });

    // Warn if SANDBOX_READY not received within 5 seconds
    setTimeout(() => {
      if (!sandboxReady) {
        let iframeDocInfo = 'unknown';
        try {
          const doc = sandboxIframe.contentDocument;
          iframeDocInfo = {
            title: doc?.title,
            bodyLen: doc?.body?.innerHTML?.length,
            bodyPreview: doc?.body?.innerHTML?.slice(0, 300),
            scripts: Array.from(doc?.querySelectorAll('script')).map(s => ({ src: s.src, textLen: s.textContent?.length }))
          };
        } catch (e) {
          iframeDocInfo = { error: e.message };
        }
        sendDebugLog('error', 'content-script', 'SANDBOX_READY not received after 5s', {
          iframeInDom: !!document.body?.contains(sandboxIframe),
          iframeSrc: sandboxIframe?.src,
          iframeContentWindow: !!sandboxIframe?.contentWindow,
          iframeDocInfo,
          location: location.href
        });
      }
    }, 5000);

    window.addEventListener('message', (e) => {
      if (e.source !== sandboxIframe.contentWindow) return;
      if (e.data.type === 'SANDBOX_READY') {
        sandboxReady = true;
        sendDebugLog('info', 'content-script', 'Sandbox ready');
        while (sandboxReadyCallbacks.length) sandboxReadyCallbacks.shift()();
      } else if (e.data.type === 'DOM_REQUEST') {
        sendDebugLog('info', 'content-script', 'DOM_REQUEST from sandbox', { action: e.data.action, selector: e.data.selector });
        handleDomRequest(e.data).then(({ result, error, subTabSnapshot }) => {
          sendDebugLog(error ? 'error' : 'info', 'content-script', 'DOM_RESPONSE to sandbox', { action: e.data.action, selector: e.data.selector, error, resultType: typeof result, hasSubTabSnapshot: !!subTabSnapshot });
          sandboxIframe.contentWindow.postMessage({
            type: 'DOM_RESPONSE',
            id: e.data.id,
            result,
            error,
            subTabSnapshot
          }, '*');
        });
      } else if (e.data.type === 'EXECUTE_RESULT') {
        sendDebugLog('info', 'content-script', 'EXECUTE_RESULT from sandbox', { error: e.data.error, resultType: typeof e.data.result, hasSubTabSnapshot: !!e.data.subTabSnapshot });
        chrome.runtime.sendMessage({
          type: 'SCRIPT_RESULT',
          result: e.data.result,
          error: e.data.error,
          subTabSnapshot: e.data.subTabSnapshot,
          tabId: currentSenderTabId
        });
      } else if (e.data.type === 'DEBUG_LOG') {
        sendDebugLog(e.data.level, e.data.component, e.data.message, e.data.data);
      }
    });
  }

  function whenSandboxReady() {
    return new Promise((resolve, reject) => {
      if (sandboxReady) return resolve();
      sandboxReadyCallbacks.push(resolve);
      // Timeout to avoid hanging forever
      setTimeout(() => {
        if (sandboxReady) return;
        const errorMsg = 'SANDBOX_READY_TIMEOUT: sandbox iframe never signaled ready';
        sendDebugLog('error', 'content-script', errorMsg, {
          iframeInDom: !!document.body?.contains(sandboxIframe),
          hasIframe: !!sandboxIframe,
          iframeSrc: sandboxIframe?.src,
          location: location.href
        });
        reject(new Error(errorMsg));
      }, 10000);
    });
  }

  // Per-iteration DOM activity accumulator. StepOrchestrator RESETs at the start
  // of each iteration and GETs after executeScript returns, so it can include
  // the per-iteration selector/outcome summary in the STEP_ITERATION event.
  // Outside the wizard testScript path this state is unused (HTTP API jobs
  // never send RESET/GET messages).
  let domActivityLog = [];

  function recordDomActivity(method, selector, outcome, ms) {
    if (typeof selector !== 'string' || selector === '') return;
    domActivityLog.push({
      method,
      selector,
      outcome: typeof outcome === 'number' ? outcome : 0,
      ms: typeof ms === 'number' ? ms : 0
    });
  }

  async function handleDomRequest(data) {
    let result, error, subTabSnapshot;
    try {
      switch (data.action) {
        case 'querySelector': {
          const __t0 = Date.now();
          result = await domQuerySelector(data.selector);
          recordDomActivity('$', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'click': {
          const __t0 = Date.now();
          result = await domClick(data.selector);
          recordDomActivity('$click', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'type': {
          const __t0 = Date.now();
          result = await domType(data.selector, data.args[0]);
          recordDomActivity('$type', data.selector, 1, Date.now() - __t0);
          break;
        }
        case 'extract': {
          const __t0 = Date.now();
          result = await domExtract(data.selector, data.args[0], data.args[1]);
          recordDomActivity('$extract', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'wait': {
          const __t0 = Date.now();
          result = await domWait(data.selector, data.args[0]);
          recordDomActivity('$wait', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'check': {
          const __t0 = Date.now();
          result = await domCheck(data.selector, data.args[0]);
          recordDomActivity(
            '$check',
            data.selector,
            typeof result === 'boolean' ? (result ? 1 : 0) : 1,
            Date.now() - __t0
          );
          break;
        }
        case 'openTab':
          result = await domOpenTab(data.args[0], data.args[1]);
          break;
        case 'exists': {
          const __t0 = Date.now();
          result = await domExists(data.selector, data.args[0]);
          recordDomActivity('$exists', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        case 'count': {
          const __t0 = Date.now();
          result = await domCount(data.selector);
          recordDomActivity('$count', data.selector, typeof result === 'number' ? result : 0, Date.now() - __t0);
          break;
        }
        case 'list': {
          const __t0 = Date.now();
          result = domList(data.selector);
          recordDomActivity('$list', data.selector, Array.isArray(result) ? result.length : 0, Date.now() - __t0);
          break;
        }
        case 'waitForStable': {
          const __t0 = Date.now();
          result = await domWaitForStable(data.selector, data.args && data.args[0]);
          recordDomActivity('$waitForStable', data.selector, result ? 1 : 0, Date.now() - __t0);
          break;
        }
        default:
          error = 'Unknown DOM action: ' + data.action;
      }
    } catch (e) {
      error = e.message || String(e);
      if (e.subTabSnapshot) subTabSnapshot = e.subTabSnapshot;
    }
    return { result, error, subTabSnapshot };
  }

  // ===== Deep DOM Search (main doc + same-origin iframes) =====
  // Delegates to lib/iframe-selector.js (loaded as a content script before
  // content-script.js — see manifest.json). That library understands the
  // `iframe<css>::<inner-css>` selector syntax used to target elements inside
  // a specific iframe deterministically. Without a prefix, both functions
  // preserve the legacy "search top doc then iterate same-origin iframes"
  // behavior so existing services keep working.
  const IframeSelectorLib = (typeof window !== 'undefined' && window.IframeSelector) || null;

  function querySelectorDeep(sel) {
    if (IframeSelectorLib) {
      return IframeSelectorLib.querySelectorDeep(document, sel);
    }
    let el = document.querySelector(sel);
    if (el) return { element: el, doc: document };
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          el = doc.querySelector(sel);
          if (el) return { element: el, doc };
        }
      } catch { /* cross-origin */ }
    }
    return null;
  }

  function querySelectorAllDeep(sel) {
    if (IframeSelectorLib) {
      return IframeSelectorLib.querySelectorAllDeep(document, sel);
    }
    const results = [];
    function collectFromDoc(doc) {
      doc.querySelectorAll(sel).forEach(el => results.push(el));
    }
    try { collectFromDoc(document); } catch {}
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const doc = iframe.contentDocument;
        if (doc) collectFromDoc(doc);
      } catch { /* cross-origin */ }
    });
    return results;
  }

  // ===== DOM APIs =====
  function domQuerySelector(sel, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const found = querySelectorDeep(sel);
      if (found) {
        sendDebugLog('info', 'content-script', 'domQuerySelector found element immediately', { selector: sel, tagName: found.element.tagName, id: found.element.id, className: classStr(found.element).slice(0, 100) });
        return resolve(elToData(found.element));
      }
      sendDebugLog('info', 'content-script', 'domQuerySelector waiting for element', { selector: sel });
      const observers = [];
      const timer = setTimeout(() => {
        observers.forEach(o => o.disconnect());
        sendDebugLog('error', 'content-script', 'domQuerySelector timeout', { selector: sel, timeoutMs });
        reject(new Error('ELEMENT_NOT_FOUND: ' + sel));
      }, timeoutMs);

      function check() {
        const found = querySelectorDeep(sel);
        if (found) {
          clearTimeout(timer);
          observers.forEach(o => o.disconnect());
          sendDebugLog('info', 'content-script', 'domQuerySelector found element after wait', { selector: sel, tagName: found.element.tagName, id: found.element.id, className: classStr(found.element).slice(0, 100) });
          resolve(elToData(found.element));
        }
      }

      const mainObs = new MutationObserver(check);
      mainObs.observe(document.body, { childList: true, subtree: true });
      observers.push(mainObs);

      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          const doc = iframe.contentDocument;
          if (doc?.body) {
            const obs = new MutationObserver(check);
            obs.observe(doc.body, { childList: true, subtree: true });
            observers.push(obs);
          }
          iframe.addEventListener('load', () => {
            try {
              const d = iframe.contentDocument;
              if (d?.body) {
                const obs = new MutationObserver(check);
                obs.observe(d.body, { childList: true, subtree: true });
                observers.push(obs);
              }
            } catch { /* cross-origin */ }
            check();
          });
        } catch { /* cross-origin */ }
      });
    });
  }

  // SVG elements have className = SVGAnimatedString (an object, not a string).
  // Normalize to a plain string so .slice/.split and script-side consumers work.
  function classStr(el) {
    if (!el) return '';
    const c = el.className;
    return typeof c === 'string' ? c : (c?.baseVal || '');
  }

  function elToData(el) {
    return {
      tagName: el.tagName,
      id: el.id,
      className: classStr(el),
      textContent: el.textContent?.trim()?.slice(0, 50000) || '',
      value: el.value,
      href: el.href,
      src: el.src,
      checked: el.checked,
      disabled: el.disabled
    };
  }

  async function domClick(sel) {
    await domQuerySelector(sel);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    const el = found.element;
    sendDebugLog('info', 'content-script', 'domClick clicking element', { selector: sel, tagName: el.tagName, id: el.id, className: classStr(el).slice(0, 100) });
    el.click();
    return true;
  }

  async function domType(sel, text) {
    await domQuerySelector(sel);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    let el = found.element;
    let isInputtable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    sendDebugLog('info', 'content-script', 'domType checking element', { selector: sel, tagName: el.tagName, isContentEditable: el.isContentEditable, isInputtable });
    if (!isInputtable) {
      const child = el.querySelector('input, textarea, [contenteditable="true"]');
      if (child) {
        el = child;
        isInputtable = true;
        sendDebugLog('info', 'content-script', 'domType using inputtable child', { selector: sel, childTagName: el.tagName, childId: el.id });
      }
    }
    if (!isInputtable) {
      throw new Error('ELEMENT_NOT_INPUTTABLE: ' + sel + ' (found ' + el.tagName + ', id=' + (el.id || 'none') + ', class=' + (el.className || 'none') + ')');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = text;
    } else {
      el.innerText = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    sendDebugLog('info', 'content-script', 'domType value set', { selector: sel, textLength: text?.length });
    return true;
  }

  async function domExtract(sel, attr, timeoutMs) {
    // Extraction is "read this element" not "wait for element to appear" — a missing
    // element almost always means the wrong selector, so cap the wait short (default 5s)
    // instead of the full 30s. Waiting 30s here burns the whole step timeout → SCRIPT_TIMEOUT.
    await domQuerySelector(sel, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 5000);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    const el = found.element;
    const result = attr ? el.getAttribute(attr) : el.textContent.trim();
    sendDebugLog('info', 'content-script', 'domExtract result', { selector: sel, attr, resultPreview: result?.slice(0, 200), resultLength: result?.length });
    return result;
  }

  async function domWait(sel, ms) {
    if (sel) await domQuerySelector(sel);
    if (ms) {
      sendDebugLog('info', 'content-script', 'domWait sleeping', { delayMs: ms });
      await new Promise(r => setTimeout(r, ms));
    }
    return true;
  }

  async function domCheck(sel, prop) {
    await domQuerySelector(sel);
    const found = querySelectorDeep(sel);
    if (!found) throw new Error('ELEMENT_NOT_FOUND: ' + sel);
    const result = found.element[prop];
    sendDebugLog('info', 'content-script', 'domCheck result', { selector: sel, prop, result });
    return result;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  async function domExists(sel, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
      const found = querySelectorDeep(sel);
      if (found && isElementVisible(found.element)) {
        sendDebugLog('info', 'content-script', 'domExists found', { selector: sel });
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    sendDebugLog('info', 'content-script', 'domExists not found', { selector: sel, timeoutMs: timeoutMs || 5000 });
    return false;
  }

  // WS5: returns true once the element's text/attr stops changing across N
  // consecutive checks — a content-stability completion signal for streaming
  // content (AI answers, live feeds). Returns false on timeout (not stable).
  async function domWaitForStable(sel, opts) {
    opts = opts || {};
    const attr = opts.attr || null;
    const interval = opts.interval || 1500;
    const stableChecks = opts.stableChecks || 2;
    const maxMs = opts.maxMs || 20000;
    const deadline = Date.now() + maxMs;
    let lastVal = null;
    let stableCount = 0;
    while (Date.now() < deadline) {
      const found = querySelectorDeep(sel);
      let val = null;
      if (found && found.element) {
        val = attr ? found.element.getAttribute(attr) : (found.element.textContent || '').trim();
      }
      if (val && val.length > 0 && val === lastVal) {
        stableCount++;
        if (stableCount >= stableChecks) {
          sendDebugLog('info', 'content-script', 'domWaitForStable stable', { selector: sel, stableCount });
          return true;
        }
      } else {
        stableCount = 0;
        lastVal = val;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    sendDebugLog('info', 'content-script', 'domWaitForStable not stable within maxMs', { selector: sel, maxMs });
    return false;
  }

  function domCount(sel) {
    let count;
    try {
      count = querySelectorAllDeep(sel).length;
    } catch (err) {
      sendDebugLog('error', 'content-script', 'domCount invalid selector', { selector: sel, error: err.message });
      count = 0;
    }
    sendDebugLog('info', 'content-script', 'domCount result', { selector: sel, count });
    return count;
  }

  function domList(sel) {
    const results = [];
    try {
      querySelectorAllDeep(sel).forEach(el => results.push(elToData(el)));
    } catch (err) {
      sendDebugLog('error', 'content-script', 'domList invalid selector', { selector: sel, error: err.message });
    }
    sendDebugLog('info', 'content-script', 'domList result', { selector: sel, count: results.length });
    return results;
  }

  const openTabPending = new Map();
  let openTabCounter = 0;

  async function domOpenTab(url, fnStr) {
    return new Promise((resolve, reject) => {
      const reqId = ++openTabCounter;
      openTabPending.set(reqId, { resolve, reject });
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB_EXECUTE',
        reqId,
        url,
        script: fnStr,
        parentTabId: currentSenderTabId
      });
    });
  }

  // ===== Script Execution =====
  async function executeScript(scriptCode, input) {
    sendDebugLog('info', 'content-script', 'executeScript waiting for sandbox', { sandboxReady });
    await whenSandboxReady();
    sendDebugLog('info', 'content-script', 'Posting EXECUTE to sandbox', { scriptPreview: scriptCode?.slice(0, 500) });
    sandboxIframe.contentWindow.postMessage({
      type: 'EXECUTE',
      script: scriptCode,
      input
    }, '*');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ pong: true });
      return false;
    }
    if (message.type === 'EXECUTE_SCRIPT') {
      currentSenderTabId = sender.tab?.id;
      sendDebugLog('info', 'content-script', 'EXECUTE_SCRIPT received', { senderTabId: currentSenderTabId, scriptPreview: message.script?.slice(0, 500) });
      executeScript(message.script, message.input)
        .then(() => sendResponse({ ack: true }))
        .catch(error => {
          sendDebugLog('error', 'content-script', 'executeScript failed', { error: error.message });
          chrome.runtime.sendMessage({
            type: 'SCRIPT_RESULT',
            error: error.message || String(error),
            tabId: currentSenderTabId
          });
          sendResponse({ ack: true });
        });
      return true;
    }

    if (message.type === 'DOM_REQUEST' && message._fromOffscreen) {
      // Set currentSenderTabId so $openTab can send results back to this tab.
      // In the offscreen path, this is the only place we learn our tabId.
      if (message.tabId) currentSenderTabId = message.tabId;
      sendDebugLog('info', 'content-script', 'DOM_REQUEST from offscreen', { action: message.action, selector: message.selector, tabId: message.tabId });
      handleDomRequest(message).then(({ result, error, subTabSnapshot }) => {
        sendDebugLog(error ? 'error' : 'info', 'content-script', 'DOM_RESPONSE to offscreen', { action: message.action, selector: message.selector, error, resultType: typeof result, hasSubTabSnapshot: !!subTabSnapshot });
        chrome.runtime.sendMessage({
          type: 'DOM_RESPONSE',
          id: message.id,
          result,
          error,
          subTabSnapshot,
          _fromOffscreen: true
        });
      });
      return false;
    }

    if (message.type === 'START_ANNOTATION') {
      annotationSchemas = {
        inputSchema: message.inputSchema || {},
        outputSchema: message.outputSchema || {},
        // Precomputed by the wizard page (which has wizard-utils.js loaded).
        // Array of {value, label} including nested array-of-objects fields
        // (e.g. {value:'posts.group', label:'posts → group'}) so the user
        // can map a selector to a specific sub-field of each list item.
        outputFieldOptions: Array.isArray(message.outputFieldOptions) ? message.outputFieldOptions : null
      };
      startAnnotationMode();
      sendResponse({ ack: true });
      return true;
    }

    if (message.type === 'STOP_ANNOTATION') {
      stopAnnotationMode();
      sendResponse({ annotations: selectedAnnotations });
      return true;
    }

    if (message.type === 'CAPTURE_ANNOTATION') {
      stopAnnotationMode();
      let snapshot;
      try {
        snapshot = getDomSnapshot();
      } catch (e) {
        sendResponse({
          error: 'CAPTURE_SNAPSHOT_FAILED: ' + (e && e.message ? e.message : String(e)),
          url: location.href,
          title: document.title,
          annotations: selectedAnnotations || [],
          fullHtml: ''
        });
        return true;
      }
      sendResponse({
        url: location.href,
        title: document.title,
        annotations: selectedAnnotations || [],
        fullHtml: snapshot.html
      });
      return true;
    }

    if (message.type === 'RESET_DOM_ACTIVITY') {
      domActivityLog = [];
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GET_DOM_ACTIVITY') {
      sendResponse({ activities: domActivityLog });
      return true;
    }

    if (message.type === 'GET_DOM_SNAPSHOT') {
      sendResponse({ snapshot: getDomSnapshot(message.mode) });
      return true;
    }

    if (message.type === 'GET_ELEMENT_HTML') {
      sendResponse({ element: window.DomCleaner.getElementFullHtml(message.selector) });
      return true;
    }

    if (message.type === 'GET_ELEMENTS_HTML') {
      const elements = message.selectors.map(sel => window.DomCleaner.getElementFullHtml(sel));
      sendResponse({ elements });
      return true;
    }

    if (message.type === 'TAB_RESULT') {
      const pending = openTabPending.get(message.reqId);
      if (pending) {
        openTabPending.delete(message.reqId);
        if (message.error) {
          // Preserve subTabSnapshot captured by handleOpenTabExecute before
          // the sub-tab was destroyed. Threaded through the message chain so
          // autoFix can hand the LLM the actual failing page's DOM instead
          // of being forced to snapshot the main tab (which shows whatever
          // page was active before $openTab ran).
          const err = new Error(message.error);
          if (message.subTabSnapshot) err.subTabSnapshot = message.subTabSnapshot;
          pending.reject(err);
        } else {
          pending.resolve(message.result);
        }
      }
      sendResponse({ ack: true });
      return true;
    }
  });

  // ===== Annotation Mode =====
  function attachAnnotationListenersToDoc(doc) {
    doc.addEventListener('mouseover', onHover, true);
    doc.addEventListener('click', onAnnotationClick, true);
    doc.addEventListener('keydown', onKeyDown, true);
  }

  function detachAnnotationListenersFromDoc(doc) {
    try {
      doc.removeEventListener('mouseover', onHover, true);
      doc.removeEventListener('click', onAnnotationClick, true);
      doc.removeEventListener('keydown', onKeyDown, true);
    } catch (e) { /* iframe may have navigated away */ }
  }

  function registerAnnotationListeners() {
    // Top-level document
    attachAnnotationListenersToDoc(document);
    attachedAnnotationDocs = [document];

    // Same-origin iframes present at start time
    let sameOriginCount = 0;
    let crossOriginCount = 0;
    document.querySelectorAll('iframe').forEach(iframe => {
      let iframeDoc = null;
      try { iframeDoc = iframe.contentDocument; } catch (e) { /* cross-origin */ }
      if (iframeDoc) {
        attachAnnotationListenersToDoc(iframeDoc);
        attachedAnnotationDocs.push(iframeDoc);
        sameOriginCount++;
        sendDebugLog('info', 'content-script', 'annotation listeners attached to iframe', {
          src: iframe.getAttribute('src') || '(no src)',
          readyState: iframeDoc.readyState
        });
      } else {
        crossOriginCount++;
      }
    });

    // Watch for iframes added after start (SPA patterns)
    if (!iframeObserver && document.body) {
      iframeObserver = new MutationObserver(mutationList => {
        for (const mutation of mutationList) {
          for (const node of mutation.addedNodes) {
            if (node.tagName === 'IFRAME') {
              tryAttachIframe(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll('iframe').forEach(tryAttachIframe);
            }
          }
        }
      });
      iframeObserver.observe(document.body, { childList: true, subtree: true });
    }

    sendDebugLog('info', 'content-script', 'annotation mode started', {
      iframeCount: document.querySelectorAll('iframe').length,
      sameOriginIframes: sameOriginCount,
      crossOriginIframes: crossOriginCount
    });
  }

  function tryAttachIframe(iframe) {
    let iframeDoc = null;
    try { iframeDoc = iframe.contentDocument; } catch (e) { return; }
    if (!iframeDoc) return;
    if (attachedAnnotationDocs.indexOf(iframeDoc) !== -1) return;
    attachAnnotationListenersToDoc(iframeDoc);
    attachedAnnotationDocs.push(iframeDoc);
    sendDebugLog('info', 'content-script', 'annotation listeners attached to late-added iframe', {
      src: iframe.getAttribute('src') || '(no src)'
    });
  }

  function startAnnotationMode() {
    isAnnotationMode = true;
    selectedAnnotations = [];
    if (annotationCounterPill) {
      annotationCounterPill.remove();
      annotationCounterPill = null;
    }
    updateAnnotationCounter();
    registerAnnotationListeners();
  }

  function stopAnnotationMode() {
    const recorded = selectedAnnotations.length;
    const docsToClean = attachedAnnotationDocs;
    attachedAnnotationDocs = [];
    isAnnotationMode = false;
    docsToClean.forEach(detachAnnotationListenersFromDoc);
    if (iframeObserver) {
      iframeObserver.disconnect();
      iframeObserver = null;
    }
    if (activeMenuClose) {
      activeMenuClose();
      activeMenuClose = null;
    }
    if (activeElementLabel) {
      if (activeElementLabel.parentNode) activeElementLabel.remove();
      activeElementLabel = null;
    }
    clearHighlights();
    docsToClean.forEach(doc => {
      try {
        doc.querySelectorAll('[data-cc-annotated]').forEach(el => {
          el.removeAttribute('data-cc-annotated');
          el.style.outline = '';
          el.style.outlineOffset = '';
        });
      } catch (e) { /* iframe navigated away */ }
    });
    if (annotationCounterPill) {
      annotationCounterPill.remove();
      annotationCounterPill = null;
    }
    sendDebugLog('info', 'content-script', 'annotation mode stopped', {
      annotationsRecorded: recorded
    });
  }

  function onHover(e) {
    hoverLogCounter++;
    const target = resolveAnnotationTarget(e.target);
    const targetChanged = lastHoverTarget !== target;
    if (targetChanged || hoverLogCounter % 20 === 0) {
      lastHoverTarget = target;
      const rect = target?.getBoundingClientRect?.();
      sendDebugLog('debug', 'content-script', 'annotation hover', {
        nth: hoverLogCounter,
        targetChanged,
        rawTag: e.target?.tagName,
        snapped: target !== e.target,
        snappedTag: target?.tagName,
        snappedClass: classStr(target).slice(0, 80),
        ownerDocIsTop: target?.ownerDocument === document,
        rect: rect ? { top: rect.top, left: rect.left, w: rect.width, h: rect.height } : null,
        isAnnotationMode
      });
    }
    if (!isAnnotationMode) return;
    clearHighlights();
    if (target.hasAttribute && target.hasAttribute('data-cc-annotated')) return;
    target.style.outline = '3px solid #f59e0b';
    target.style.outlineOffset = '2px';
  }

  function onAnnotationClick(e) {
    const target = resolveAnnotationTarget(e.target);
    const snapped = target !== e.target;
    sendDebugLog('info', 'content-script', 'annotation click received', {
      rawTag: e.target?.tagName,
      rawClass: classStr(e.target).slice(0, 80),
      snapped,
      snappedTag: target?.tagName,
      snappedClass: classStr(target).slice(0, 80),
      ownerDocIsTop: target?.ownerDocument === document,
      eventPhase: e.eventPhase,
      isAnnotationMode,
      hasClosest: typeof target?.closest === 'function'
    });
    if (!isAnnotationMode) {
      sendDebugLog('warn', 'content-script', 'annotation click dropped: not in annotation mode');
      return;
    }
    // Don't re-trigger when the click lands inside our own annotation menu.
    // Without this guard, clicking a menu button fires onAnnotationClick
    // again (it's a document-level capture listener), stopPropagation halts
    // the event before it reaches the button, and the menu's own click
    // handler never runs — so a new menu is built on every click (loop).
    if (target.closest && target.closest('[data-cc-annotation-menu]')) {
      sendDebugLog('debug', 'content-script', 'annotation click dropped: inside own menu');
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const selector = generateSelector(target);
    const domPath = getDomPath(target);
    const text = target.textContent?.trim()?.slice(0, 100) || '';
    const tagLower = target.tagName.toLowerCase();

    // Element-confirm label: a small fixed-position badge near the clicked
    // element so the non-technical annotator visually confirms the pick.
    const elementLabel = document.createElement('div');
    elementLabel.setAttribute('data-cc-element-label', '');
    const rawRect = target.getBoundingClientRect?.() || {};
    // target's rect is iframe-viewport-relative when the click landed inside
    // an iframe; translate to top-level viewport so the label and menu render
    // at the right spot (they're appended to top-level document.body).
    const rect = translateRectToTopLevel(target, rawRect);
    const coords = clientCoordsToTopLevel(target, e.clientX, e.clientY);
    elementLabel.style.cssText =
      'position:fixed; z-index:999998; max-width:260px; padding:3px 7px;' +
      'background:#111827; color:#fff; font:12px/1.4 sans-serif;' +
      'border-radius:4px; pointer-events:none; white-space:nowrap;' +
      'overflow:hidden; text-overflow:ellipsis;';
    elementLabel.textContent = (text || '(no text)') + '  ·  <' + tagLower + '>';
    // Place just above the element; clamp into the viewport.
    let labelTop = (rect.top || 0) - 22;
    if (labelTop < 4) labelTop = (rect.bottom || 0) + 4;
    let labelLeft = (rect.left || 0);
    if (labelLeft > window.innerWidth - 200) labelLeft = window.innerWidth - 260;
    if (labelLeft < 4) labelLeft = 4;
    elementLabel.style.top = labelTop + 'px';
    elementLabel.style.left = labelLeft + 'px';
    document.body.appendChild(elementLabel);
    activeElementLabel = elementLabel;

    // Highlight the target while the menu is open.
    target.style.outline = '3px solid #f59e0b';
    target.style.outlineOffset = '2px';

    const menu = document.createElement('div');
    menu.setAttribute('data-cc-annotation-menu', '');
    menu.style.cssText =
      'position:fixed; left:-9999px; top:-9999px; background:white;' +
      'border:1px solid #ccc; padding:10px; z-index:999999;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.25); font-family:sans-serif;' +
      'font-size:13px; min-width:260px; max-width:320px; border-radius:6px;';
    document.body.appendChild(menu);

    // Shared close: removes menu, element label, and outside-click listener.
    let onOutside = null;
    const close = () => {
      menu.remove();
      if (elementLabel.parentNode) elementLabel.remove();
      if (activeElementLabel === elementLabel) activeElementLabel = null;
      if (onOutside) {
        document.removeEventListener('click', onOutside, true);
        onOutside = null;
      }
      if (activeMenuClose === close) activeMenuClose = null;
    };
    activeMenuClose = close;

    // ---- Step 1: type selection ----
    function renderStep1() {
      menu.innerHTML = `
        <div style="font-weight:600; margin-bottom:8px;">Choose Annotation Type</div>
        <div style="font-size:11px; color:#6b7280; margin-bottom:8px;">Element: ${(text || '(no text)').replace(/</g, '&lt;').slice(0, 60)} · &lt;${tagLower}&gt;</div>
        <button data-type="click" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">click — click element</button>
        <button data-type="input" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">input — input field</button>
        <button data-type="extract" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">extract — extract text/attribute</button>
        <button data-type="check" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">check — read attribute</button>
        <button data-type="wait" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">wait — wait for element</button>
        <hr style="margin:8px 0; border:none; border-top:1px solid #e5e7eb;">
        <button data-type="key" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #bfdbfe; background:#dbeafe; border-radius:3px;">key — field name (header)</button>
        <button data-type="value" style="display:block; width:100%; margin:2px 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #bbf7d0; background:#dcfce7; border-radius:3px;">value — field value (cell)</button>
        <button data-type="cancel" style="display:block; width:100%; margin:8px 0 0; padding:6px 8px; text-align:left; cursor:pointer; border:1px solid #e5e7eb; background:white; border-radius:3px;">Cancel</button>
      `;
      positionMenu(menu, coords.x, coords.y);
    }

    // Build a labelled <select> from a list of {value,label} options.
    function buildSelect(id, label, options, placeholder) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:6px 0;';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:11px; color:#374151; margin-bottom:3px;';
      lbl.textContent = label;
      wrap.appendChild(lbl);
      const sel = document.createElement('select');
      sel.id = id;
      sel.style.cssText = 'width:100%; padding:4px 6px; border:1px solid #d1d5db; border-radius:3px; font-size:13px; background:white;';
      if (placeholder) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = placeholder;
        sel.appendChild(opt);
      }
      options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      });
      wrap.appendChild(sel);
      return wrap;
    }

    // ---- Step 2: intent form (per type) ----
    function renderStep2(type) {
      menu.innerHTML = '';
      const header = document.createElement('div');
      header.style.cssText = 'font-weight:600; margin-bottom:8px;';
      header.textContent = 'Type: ' + type;
      menu.appendChild(header);

      // key/value types have no intent dropdowns — straight confirm.
      if (type !== 'key' && type !== 'value') {
        if (type === 'click' || type === 'check' || type === 'input') {
          menu.appendChild(buildSelect('cc-purpose', 'Intent (purpose)', PURPOSES, '— Select —'));
          const otherWrap = document.createElement('div');
          otherWrap.id = 'cc-purpose-other-wrap';
          otherWrap.style.cssText = 'margin:4px 0; display:none;';
          const otherInput = document.createElement('input');
          otherInput.type = 'text';
          otherInput.id = 'cc-purpose-other';
          otherInput.placeholder = 'Custom intent…';
          otherInput.style.cssText = 'width:100%; padding:4px 6px; border:1px solid #d1d5db; border-radius:3px; font-size:13px; box-sizing:border-box;';
          otherWrap.appendChild(otherInput);
          menu.appendChild(otherWrap);
        }
        if (type === 'check' || type === 'wait') {
          menu.appendChild(buildSelect('cc-wait', 'Wait condition', WAIT_CONDITIONS, '— Select —'));
        }
        if (type === 'extract') {
          // Prefer the precomputed options from the wizard (handles array-of
          // -objects outputs by descending into items.properties, e.g. posts →
          // posts.group, posts.username). Fall back to top-level keys for
          // older wizards that don't send outputFieldOptions.
          const outOptions = Array.isArray(annotationSchemas.outputFieldOptions) && annotationSchemas.outputFieldOptions.length
            ? annotationSchemas.outputFieldOptions
            : Object.keys(annotationSchemas.outputSchema?.properties || {}).map(k => ({ value: k, label: k }));
          if (outOptions.length) {
            menu.appendChild(buildSelect('cc-output', 'Output field',
              outOptions, '— Select —'));
          } else {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:11px; color:#9ca3af; margin:4px 0;';
            note.textContent = '(no outputSchema, outputField skipped)';
            menu.appendChild(note);
          }
        }
        if (type === 'input') {
          const inProps = Object.keys(annotationSchemas.inputSchema?.properties || {});
          if (inProps.length) {
            menu.appendChild(buildSelect('cc-input', 'Input field',
              inProps.map(k => ({ value: k, label: k })), '— Select —'));
          } else {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:11px; color:#9ca3af; margin:4px 0;';
            note.textContent = '(no inputSchema, inputField skipped)';
            menu.appendChild(note);
          }
        }
      }

      // Buttons: Confirm / Back / Cancel
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex; gap:6px; margin-top:10px;';
      const mkBtn = (label, kind) => {
        const b = document.createElement('button');
        b.textContent = label;
        const bg = { confirm: '#2563eb', back: '#f3f4f6', cancel: '#f3f4f6' }[kind];
        const fg = kind === 'confirm' ? '#fff' : '#374151';
        const border = kind === 'confirm' ? '#2563eb' : '#d1d5db';
        b.style.cssText = `flex:1; padding:6px 8px; cursor:pointer; border:1px solid ${border}; background:${bg}; color:${fg}; border-radius:3px; font-size:13px;`;
        b.dataset.action = kind;
        return b;
      };
      btnRow.appendChild(mkBtn('Confirm', 'confirm'));
      btnRow.appendChild(mkBtn('Back', 'back'));
      btnRow.appendChild(mkBtn('Cancel', 'cancel'));
      menu.appendChild(btnRow);
      positionMenu(menu, coords.x, coords.y);
    }

    function commit(type) {
      let purpose, waitCondition, outputField, inputField;
      if (type === 'click' || type === 'check' || type === 'input') {
        const sel = menu.querySelector('#cc-purpose');
        const chosen = sel ? sel.value : '';
        purpose = chosen === 'other'
          ? (menu.querySelector('#cc-purpose-other')?.value?.trim() || undefined)
          : (chosen || undefined);
      }
      if (type === 'check' || type === 'wait') {
        const sel = menu.querySelector('#cc-wait');
        waitCondition = sel ? (sel.value || undefined) : undefined;
      }
      // wait type = user is waiting for page completion — auto-assign purpose
      // so the LLM intent mapping fires (otherwise the annotation's
      // waitCondition is silently ignored and the LLM guesses its own signal).
      if (type === 'wait') {
        purpose = 'wait-for-load';
      }
      if (type === 'extract') {
        const sel = menu.querySelector('#cc-output');
        outputField = sel ? (sel.value || undefined) : undefined;
      }
      if (type === 'input') {
        const sel = menu.querySelector('#cc-input');
        inputField = sel ? (sel.value || undefined) : undefined;
      }

      selectedAnnotations.push({
        selector,
        domPath,
        elementType: tagLower,
        type,
        purpose,
        waitCondition,
        outputField,
        inputField,
        text,
        description: text.slice(0, 50),
        sampleText: text,
        html: target.outerHTML.slice(0, 500)
      });
      updateAnnotationCounter();

      const colors = { key: '#3b82f6', value: '#10b981' };
      target.setAttribute('data-cc-annotated', type);
      target.style.outline = '3px solid ' + (colors[type] || '#f59e0b');
      target.style.outlineOffset = '2px';

      sendDebugLog('info', 'content-script', 'annotation committed', {
        type, selector, purpose, waitCondition, outputField, inputField
      });
    }

    // Master click handler: handles both step-1 (data-type buttons) and
    // step-2 (data-action buttons + purpose <select> change).
    let currentType = null;
    menu.addEventListener('click', (ev) => {
      // Purpose <select> toggle of the free-text "other" input.
      const purposeSel = ev.target.closest && ev.target.closest('#cc-purpose');
      if (purposeSel) {
        const wrap = menu.querySelector('#cc-purpose-other-wrap');
        if (wrap) wrap.style.display = purposeSel.value === 'other' ? 'block' : 'none';
        ev.stopPropagation();
        return;
      }

      const btn = ev.target.closest('button');
      if (!btn) return;

      if (btn.dataset.type) {
        // Step 1 → step 2 (or cancel / direct-commit for key/value).
        const type = btn.dataset.type;
        if (type === 'cancel') { close(); return; }
        if (type === 'key' || type === 'value') { commit(type); close(); return; }
        currentType = type;
        renderStep2(type);
        return;
      }

      if (btn.dataset.action) {
        const action = btn.dataset.action;
        if (action === 'cancel') { close(); return; }
        if (action === 'back') {
          currentType = null;
          renderStep1();
          return;
        }
        if (action === 'confirm') {
          commit(currentType);
          close();
          return;
        }
      }
    });

    renderStep1();
    positionMenu(menu, coords.x, coords.y);

    sendDebugLog('info', 'content-script', 'annotation menu built', {
      selector,
      domPath,
      menuAppended: !!menu.parentNode
    });

    // Close on outside click (after a small delay so the current click doesn't trigger it)
    setTimeout(() => {
      if (!menu.parentNode) return;
      onOutside = (ev) => {
        if (!menu.contains(ev.target)) close();
      };
      document.addEventListener('click', onOutside, true);
    }, 100);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') stopAnnotationMode();
  }

  // Translate a getBoundingClientRect() (iframe-viewport-relative when the
  // target lives inside an iframe) into top-level-viewport coordinates by
  // walking up the iframe chain and adding each iframe element's offset.
  // Without this, the annotation menu / element label render at the wrong
  // position when the user clicks inside an iframe — the click's clientX/Y
  // and the target's rect are both iframe-viewport-relative, but the menu
  // is appended to the top-level document.body.
  function translateRectToTopLevel(target, rect) {
    if (!target || !rect) return rect || {};
    let ownerDoc = target.ownerDocument;
    if (!ownerDoc || ownerDoc === document) return rect;
    let top = rect.top, left = rect.left, bottom = rect.bottom, right = rect.right;
    while (ownerDoc && ownerDoc !== document) {
      const parentWin = ownerDoc.defaultView;
      if (!parentWin || parentWin === parentWin.parent) break;
      const parentDoc = parentWin.parent.document;
      let iframeEl = null;
      try {
        const candidates = parentDoc.querySelectorAll('iframe');
        for (const c of candidates) {
          if (c.contentWindow === parentWin) { iframeEl = c; break; }
        }
      } catch (e) { break; }
      if (!iframeEl) break;
      const offset = iframeEl.getBoundingClientRect();
      top += offset.top;
      left += offset.left;
      bottom += offset.top;
      right += offset.left;
      ownerDoc = parentDoc;
    }
    return { top, left, bottom, right, width: rect.width, height: rect.height };
  }

  function clientCoordsToTopLevel(target, clientX, clientY) {
    const rect = translateRectToTopLevel(target, { top: clientY, left: clientX, bottom: clientY, right: clientX, width: 0, height: 0 });
    return { x: rect.left, y: rect.top };
  }

  // Semantic clickable elements a user typically wants to annotate. When a
  // click lands on an inner icon (SVG/path/img inside a button), `closest()`
  // walks up to the nearest ancestor in this list — including the element
  // itself — so the annotation records the clickable parent, not the icon.
  // `[aria-haspopup]` covers div-based popup triggers that only expose
  // semantics via ARIA (e.g. doubao's mode-switch).
  const INTERACTIVE_SELECTOR = [
    'button',
    'a',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[aria-haspopup]',
    'summary',
    'input[type="checkbox"]',
    'input[type="radio"]'
  ].join(', ');

  function resolveAnnotationTarget(rawTarget) {
    if (!rawTarget || !rawTarget.closest) return rawTarget;
    // Don't snap to our own annotation UI.
    if (rawTarget.closest('[data-cc-annotation-menu]')) return rawTarget;
    return rawTarget.closest(INTERACTIVE_SELECTOR) || rawTarget;
  }

  function clearHighlights() {
    document.querySelectorAll('[style*="outline"]').forEach(el => {
      if (el.hasAttribute('data-cc-annotated')) return;
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
  }

  function updateAnnotationCounter() {
    if (!annotationCounterPill) {
      annotationCounterPill = document.createElement('div');
      annotationCounterPill.style.cssText =
        'position:fixed; top:12px; right:12px; z-index:999999;' +
        'background:#1f2937; color:white; padding:6px 12px; border-radius:999px;' +
        'font:13px sans-serif; box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
        'pointer-events:none;';
      document.body.appendChild(annotationCounterPill);
    }
    const n = selectedAnnotations.length;
    annotationCounterPill.textContent =
      '✓ ' + n + ' annotation' + (n === 1 ? '' : 's') + ' captured';
  }

  function positionMenu(menu, clickX, clickY) {
    const rect = menu.getBoundingClientRect();
    const menuW = rect.width;
    const menuH = rect.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = clickX;
    if (clickX > vw / 2) left = clickX - menuW;
    let top = clickY;
    if (clickY > vh / 2) top = clickY - menuH;
    left = Math.max(8, Math.min(left, vw - menuW - 8));
    top = Math.max(8, Math.min(top, vh - menuH - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function generateSelector(el) {
    // Delegate to lib/selector-generator.js. The full algorithm — stable
    // attribute preference, early-stop, leaf-only nth-of-type fallback —
    // lives there. content-script wraps it to prepend the iframe chain
    // (the lib module is iframe-agnostic; iframe context is added here
    // because that's where IframeSelectorLib lives).
    const inner = (typeof SelectorGenerator !== 'undefined' && SelectorGenerator)
      ? SelectorGenerator.generateSelector(el, el.ownerDocument || document)
      : (el && el.tagName ? el.tagName.toLowerCase() : 'body');
    if (!el || typeof IframeSelectorLib === 'undefined' || !IframeSelectorLib) return inner;
    const iframeChain = IframeSelectorLib.buildIframeChain(el, document);
    if (iframeChain.length === 0) return inner;
    return IframeSelectorLib.formatIframeSelector(iframeChain, inner);
  }

  function getDomPath(el) {
    // Unified with generateSelector — previously a duplicate implementation
    // that drifted from the main one. Both annotation.selector and
    // annotation.domPath now contain the same stable selector string.
    return generateSelector(el);
  }

  // ===== DOM Snapshot =====
  function getDomSnapshot(mode) {
    if (mode === 'compressed') {
      return window.DomCleaner.getCompressedSnapshot();
    }

    const clone = document.documentElement.cloneNode(true);

    // Remove tags that are never useful for scraping (but NOT iframe — processed separately)
    clone.querySelectorAll('script, style, link[rel="stylesheet"], link[rel="preload"], link[rel="icon"], video, audio, canvas, svg, noscript, template, meta, path, g, defs, use').forEach(el => el.remove());

    // Replace same-origin iframes with their content, mark cross-origin
    clone.querySelectorAll('iframe').forEach(el => {
      const src = el.getAttribute('src') || '';
      try {
        const liveIframes = document.querySelectorAll('iframe');
        let doc = null;
        let liveIframe = null;
        for (const iframe of liveIframes) {
          if (iframe.getAttribute('src') === src || iframe.src === el.getAttribute('src')) {
            doc = iframe.contentDocument;
            liveIframe = iframe;
            if (doc?.body) break;
          }
        }
        if (doc?.body && liveIframe) {
          const content = doc.body.cloneNode(true);
          content.querySelectorAll('script, style, link, video, audio, canvas, svg, noscript').forEach(c => c.remove());
          // Reuse the iframe element but mark it with the prefix and replace its
          // children with the inlined same-origin body. Keeps both snapshot paths
          // (compressed and full) emitting the same iframe marker.
          const prefix = window.DomCleaner.buildIframePrefix(liveIframe);
          el.setAttribute('data-iframe-prefix', prefix);
          while (el.firstChild) el.removeChild(el.firstChild);
          while (content.firstChild) el.appendChild(content.firstChild);
        } else {
          el.remove();
        }
      } catch {
        // Cross-origin iframe: leave the element in place but mark it so the LLM
        // sees the boundary. contentDocument access is blocked at runtime.
        el.setAttribute('data-cross-origin-iframe', src);
      }
    });

    // Remove hidden elements
    clone.querySelectorAll('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"]').forEach(el => el.remove());

    // Remove common noise containers (nav, sidebar, footer, cookie banners, tooltips, modals)
    clone.querySelectorAll('nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [class*="sidebar"], [class*="side-bar"], [class*="Sidebar"], [class*="toast"], [class*="modal-backdrop"], [class*="overlay"], [class*="cookie"], [class*="banner"], [class*="popup"], [class*="tooltip"], [class*="dropdown-menu"]').forEach(el => el.remove());

    // Remove comments
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(c => c.remove());

    // Clean attributes that bloat HTML but don't help selector identification
    clone.querySelectorAll('*').forEach(el => {
      // Remove inline event handlers
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on') || attr.name === 'style') {
          el.removeAttribute(attr.name);
        }
      });
      // Trim excessively long attribute values (data-*, class with hashes)
      Array.from(el.attributes).forEach(attr => {
        if (attr.value.length > 200) {
          el.setAttribute(attr.name, attr.value.slice(0, 200) + '...');
        }
      });
    });

    let html = clone.outerHTML;

    // Collapse whitespace
    html = html.replace(/\n\s*\n/g, '\n').replace(/>\s+</g, '><');

    // Only truncate if still extremely large after cleaning
    if (html.length > 80000) html = html.slice(0, 80000) + '\n... [truncated]';

    return {
      url: location.href,
      title: document.title,
      html: html,
      textContent: document.body.innerText.slice(0, 15000)
    };
  }

  // ===== Init =====
  // NOTE: The content-script no longer auto-creates a sandbox.html iframe.
  // Script execution migrated to the offscreen document (commit 3a567c4),
  // which hosts its own same-origin sandbox iframe that works. Embedding
  // chrome-extension://sandbox.html from a web page would require
  // web_accessible_resources, and even then may be blocked by page CSP.
  // The offscreen path is the canonical execution route.
})();
