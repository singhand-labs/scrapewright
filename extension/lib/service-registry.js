class ServiceRegistry {
  constructor() {
    this.storageKey = 'services';
  }

  async getAll() {
    const result = await chrome.storage.local.get(this.storageKey);
    const services = result[this.storageKey] || [];
    // One-time migration of legacy config defaults (30s/2 retries → 60s/1) so
    // existing services pick up the new defaults without rebuilding.
    let changed = false;
    for (const s of services) {
      if (s && s.config) {
        if (s.config.timeoutMs === 30000) { s.config.timeoutMs = 60000; changed = true; }
        if (s.config.maxRetries === 2) { s.config.maxRetries = 1; changed = true; }
      }
    }
    if (changed) await chrome.storage.local.set({ [this.storageKey]: services });
    return services;
  }

  async getByName(name) {
    const services = await this.getAll();
    return services.find(s => s.name === name || s.displayName === name) || null;
  }

  async getById(id) {
    const services = await this.getAll();
    return services.find(s => s.id === id) || null;
  }

  async save(service) {
    // Validate chain topology so broken services can't be persisted. Catches
    // the "manually-added step never runs" bug class at every persistence
    // path (wizard deploy, options toggle, import, auto-fix). The wizard
    // already runs validateForExecution before its save; this is the
    // backstop for every other caller.
    if (Array.isArray(service.steps) && service.steps.length > 0) {
      // Resolve validateChain across environments: Node tests (require),
      // extension pages (window), service worker (self). If it genuinely
      // cannot be resolved, skip this backstop instead of crashing the
      // save — chain validity is also enforced at wizard deploy time.
      const validateChain = (typeof require === 'function')
        ? require('./wizard-utils').validateChain
        : (typeof window !== 'undefined' && window.validateChain)
          || (typeof self !== 'undefined' && self.validateChain)
          || null;
      if (validateChain) {
        const chainCheck = validateChain(service.steps);
        if (!chainCheck.valid) {
          throw new Error('Refusing to save service with broken step chain: ' + chainCheck.error);
        }
      }
    }
    const services = await this.getAll();
    const index = services.findIndex(s => s.id === service.id);
    service.updatedAt = Date.now();
    if (index >= 0) {
      services[index] = service;
    } else {
      services.push(service);
    }
    await chrome.storage.local.set({ [this.storageKey]: services });
    return service;
  }

  async delete(id) {
    const services = await this.getAll();
    const filtered = services.filter(s => s.id !== id);
    await chrome.storage.local.set({ [this.storageKey]: filtered });
  }

  async clear() {
    await chrome.storage.local.remove(this.storageKey);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ServiceRegistry };
} else if (typeof window !== 'undefined') {
  window.ServiceRegistry = ServiceRegistry;
}
