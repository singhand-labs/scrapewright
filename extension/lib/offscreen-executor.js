let EXEC_SEQ = 0; // B5: per-execution identity — disambiguates interleaved runs on the same tab

class OffscreenExecutor {
  constructor(tabId) {
    this.tabId = tabId;
    this.timeoutMs = 30000;
  }

  async ensureOffscreenDocument() {
    if (await this.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'Execute user-generated scraping scripts with eval'
    });
  }

  async hasDocument() {
    if (typeof chrome.runtime.getContexts !== 'function') return false;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    return contexts.length > 0;
  }

  async closeDocument() {
    if (typeof chrome.offscreen.closeDocument === 'function') {
      await chrome.offscreen.closeDocument();
    }
  }

  wrapScript(code) {
    return `(async function(__input__) { ${code} })(__input__);`;
  }

  async execute(scriptCode, input) {
    await this.ensureOffscreenDocument();

    const execId = 'exec-' + Date.now() + '-' + (++EXEC_SEQ);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        chrome.runtime.sendMessage({
          type: 'EXECUTE_SCRIPT_TIMEOUT',
          tabId: this.tabId,
          _toOffscreen: true
        }).catch(() => {});
        reject(new Error(`SCRIPT_TIMEOUT: script exceeded the ${this.timeoutMs}ms per-step execution budget and was killed. If this step batches $extractWithHover/$hover over multiple containers (each hovered anchor burns ~5-10s even when no popover appears), narrow the batch (containerRange/maxContainers) or slice it across maxIterations>1 + { done: false } iterations. For long waits, poll via retry iterations instead of in-script sleeps.`));
      }, this.timeoutMs);

      const listener = (message) => {
        // B5: match by execId — strictly stronger than the tabId check.
        // Two interleaved executions on the SAME tab would cross-wire
        // under tabId-only matching.
        if (message.type === 'SCRIPT_RESULT' && message._fromOffscreen && message.execId === execId) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          if (message.error) {
            // Preserve subTabSnapshot threaded up from handleOpenTabExecute.
            // step-orchestrator reads err.subTabSnapshot to skip its default
            // main-tab capture (which would snapshot the wrong page).
            const err = new Error(message.error);
            if (message.subTabSnapshot) err.subTabSnapshot = message.subTabSnapshot;
            if (message.selectorDiagnostics) err.selectorDiagnostics = message.selectorDiagnostics;
            reject(err);
          } else {
            // Resolve with an envelope so step-orchestrator can read
            // selectorDiagnostics captured inside the sandbox. Legacy
            // callers that only need the result go through a compat shim
            // at the orchestrator site.
            resolve({ result: message.result, selectorDiagnostics: message.selectorDiagnostics || [] });
          }
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({
        type: 'EXECUTE_SCRIPT_OFFSCREEN',
        execId,
        script: this.wrapScript(scriptCode),
        input,
        tabId: this.tabId,
        _toOffscreen: true
      });
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OffscreenExecutor };
} else if (typeof window !== 'undefined') {
  window.OffscreenExecutor = OffscreenExecutor;
}
