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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        chrome.runtime.sendMessage({
          type: 'EXECUTE_SCRIPT_TIMEOUT',
          tabId: this.tabId,
          _toOffscreen: true
        }).catch(() => {});
        reject(new Error('SCRIPT_TIMEOUT'));
      }, this.timeoutMs);

      const listener = (message) => {
        if (message.type === 'SCRIPT_RESULT' && message._fromOffscreen && message.tabId === this.tabId) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          if (message.error) {
            // Preserve subTabSnapshot threaded up from handleOpenTabExecute.
            // step-orchestrator reads err.subTabSnapshot to skip its default
            // main-tab capture (which would snapshot the wrong page).
            const err = new Error(message.error);
            if (message.subTabSnapshot) err.subTabSnapshot = message.subTabSnapshot;
            reject(err);
          } else {
            resolve(message.result);
          }
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({
        type: 'EXECUTE_SCRIPT_OFFSCREEN',
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
