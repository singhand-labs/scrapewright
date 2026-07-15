class DebugLogger {
  constructor() {
    this.inMemory = [];
    this.maxInMemory = 500;
    this.maxDays = 3;
  }

  log(level, component, message, data = null) {
    const entry = {
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      level,
      component,
      message,
      data
    };
    this.inMemory.push(entry);
    if (this.inMemory.length > this.maxInMemory) {
      this.inMemory.shift();
    }
    const prefix = `[${entry.iso}] [${component}] ${message}`;
    if (level === 'error') console.error(prefix, data || '');
    else if (level === 'warn') console.warn(prefix, data || '');
    else console.log(prefix, data || '');
  }

  async persist() {
    const key = `debugLogs_${new Date().toISOString().slice(0, 10)}`;
    const existing = (await chrome.storage.local.get(key))[key] || [];
    const merged = existing.concat(this.inMemory);
    const trimmed = merged.slice(-2000);
    await chrome.storage.local.set({ [key]: trimmed });
    this.inMemory = [];

    // Auto-clean logs older than maxDays
    await this.pruneOldLogs();

    return key;
  }

  async pruneOldLogs() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.maxDays);
    const cutoffKey = `debugLogs_${cutoff.toISOString().slice(0, 10)}`;

    const all = await chrome.storage.local.get();
    const oldKeys = Object.keys(all).filter(k =>
      k.startsWith('debugLogs_') && k < cutoffKey
    );
    if (oldKeys.length) {
      await chrome.storage.local.remove(oldKeys);
    }
  }

  async exportAll() {
    const all = await chrome.storage.local.get();
    const logs = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('debugLogs_')) logs[k] = v;
    }
    return logs;
  }

  async clear() {
    const all = await chrome.storage.local.get();
    const keys = Object.keys(all).filter(k => k.startsWith('debugLogs_'));
    if (keys.length) await chrome.storage.local.remove(keys);
  }
}

const debugLogger = new DebugLogger();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DebugLogger, debugLogger };
} else if (typeof window !== 'undefined') {
  window.DebugLogger = DebugLogger;
  window.debugLogger = debugLogger;
}
