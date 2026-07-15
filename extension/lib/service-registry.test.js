const { ServiceRegistry } = require('./service-registry');

global.chrome = {
  storage: {
    local: {
      data: {},
      async get(keys) {
        if (typeof keys === 'string') {
          return { [keys]: this.data[keys] };
        }
        if (Array.isArray(keys)) {
          const result = {};
          for (const key of keys) {
            result[key] = this.data[key];
          }
          return result;
        }
        return { ...this.data };
      },
      async set(items) {
        Object.assign(this.data, items);
      },
      async remove(keys) {
        if (typeof keys === 'string') {
          delete this.data[keys];
        } else if (Array.isArray(keys)) {
          for (const key of keys) {
            delete this.data[key];
          }
        }
      }
    }
  }
};

async function testServiceRegistry() {
  const registry = new ServiceRegistry();

  await registry.clear();

  const service = {
    id: 'test-1',
    name: 'test-service',
    displayName: 'Test',
    targetUrl: 'https://example.com',
    steps: [{ id: 'main', name: 'Main', script: 'return 42;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: [],
    config: { enabled: true, timeoutMs: 30000, maxRetries: 2, autoCloseTab: true },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await registry.save(service);
  const found = await registry.getByName('test-service');
  if (found.name !== 'test-service') throw new Error('getByName failed');

  const all = await registry.getAll();
  if (all.length !== 1) throw new Error('getAll length failed');

  await registry.delete('test-1');
  const afterDelete = await registry.getByName('test-service');
  if (afterDelete !== null) throw new Error('delete failed');

  // save() now refuses services with broken step chains. This is the
  // backstop that catches the "manually-added step never runs" bug at
  // every persistence path (wizard deploy, options toggle, import, auto-fix).
  const brokenService = {
    id: 'broken-1',
    name: 'broken',
    displayName: 'Broken',
    targetUrl: 'https://example.com',
    // step 'orphan' exists but nothing points to it
    steps: [
      { id: 'main', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
      { id: 'orphan', script: 'return 2;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ],
    config: { enabled: true }
  };

  let threwForBrokenChain = false;
  try {
    await registry.save(brokenService);
  } catch (e) {
    threwForBrokenChain = e.message.includes('broken step chain') && e.message.includes('orphan');
  }
  if (!threwForBrokenChain) throw new Error('save() should reject broken chain with named step');

  // Services without steps (legacy or in-progress) are still allowed.
  const stepsless = { id: 'empty-1', name: 'empty', displayName: 'Empty', targetUrl: 'https://example.com', config: {} };
  await registry.save(stepsless);

  // Service with valid chain still saves cleanly.
  const valid = {
    id: 'valid-1',
    name: 'valid',
    displayName: 'Valid',
    targetUrl: 'https://example.com',
    steps: [
      { id: 'a', script: 'return 1;', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', script: 'return 2;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ],
    config: {}
  };
  await registry.save(valid);

  console.log('All ServiceRegistry tests passed');
}

testServiceRegistry().catch(err => {
  console.error(err);
  process.exit(1);
});
