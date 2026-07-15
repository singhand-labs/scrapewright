// Legacy iframe-based script executor. Kept for backward compatibility (e.g. $openTab).
// Primary execution now goes through OffscreenExecutor which uses Chrome's Offscreen API.
class ScriptExecutor {
  constructor(tabId) {
    this.tabId = tabId;
    this.timeoutMs = 30000;
  }

  async execute(scriptCode, input) {
    const wrappedScript = this.wrapScript(scriptCode);
    debugLogger.log('info', 'script-executor', 'execute called', {
      tabId: this.tabId,
      timeoutMs: this.timeoutMs,
      scriptPreview: scriptCode.slice(0, 500)
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        debugLogger.log('error', 'script-executor', 'SCRIPT_TIMEOUT fired', { tabId: this.tabId, timeoutMs: this.timeoutMs });
        reject(new Error('SCRIPT_TIMEOUT'));
      }, this.timeoutMs);

      const listener = (message, sender) => {
        if (sender.tab?.id !== this.tabId) return;
        if (message.type !== 'SCRIPT_RESULT') return;

        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);

        if (message.error) {
          debugLogger.log('error', 'script-executor', 'SCRIPT_RESULT with error', { tabId: this.tabId, error: message.error });
          reject(new Error(message.error));
        } else {
          debugLogger.log('info', 'script-executor', 'SCRIPT_RESULT received', { tabId: this.tabId, resultType: typeof message.result, resultPreview: JSON.stringify(message.result)?.slice(0, 500) });
          resolve(message.result);
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      debugLogger.log('info', 'script-executor', 'Sending EXECUTE_SCRIPT', { tabId: this.tabId });
      chrome.tabs.sendMessage(this.tabId, {
        type: 'EXECUTE_SCRIPT',
        script: wrappedScript,
        input
      }).catch(err => {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        debugLogger.log('error', 'script-executor', 'sendMessage failed', { tabId: this.tabId, error: err.message });
        reject(err);
      });
    });
  }

  wrapScript(code) {
    return `(async function(__input__) { ${code} })(__input__);`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ScriptExecutor };
} else if (typeof window !== 'undefined') {
  window.ScriptExecutor = ScriptExecutor;
}
