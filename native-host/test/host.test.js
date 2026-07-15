const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { server } = require('../host');

const TEST_PORT = 18765;

describe('HTTP Server', () => {
  before(() => {
    return new Promise((resolve) => {
      server.listen(TEST_PORT, resolve);
    });
  });

  after(() => {
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('should respond 401 without API key', async () => {
    const response = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/v1/services/test/execute',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, resolve);
      req.write(JSON.stringify({ input: {} }));
      req.end();
    });
    assert.strictEqual(response.statusCode, 401);
  });

  it('should respond 404 for unknown path', async () => {
    const response = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/v1/unknown',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'dev-key'
        }
      }, resolve);
      req.write(JSON.stringify({ input: {} }));
      req.end();
    });
    assert.strictEqual(response.statusCode, 404);
  });

  it('should respond 200 for /health without API key', { timeout: 10000 }, async () => {
    const response = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/health',
        method: 'GET'
      }, resolve);
      req.end();
    });
    assert.strictEqual(response.statusCode, 200);
    const body = await new Promise((resolve) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(JSON.parse(data)));
    });
    assert.strictEqual(typeof body.status, 'string');
    assert.strictEqual(typeof body.extensionConnected, 'boolean');
    assert.strictEqual(typeof body.uptime, 'number');
  });

  it('should respond 401 for step-CRUD endpoints without API key', async () => {
    for (const { path, method } of [
      { path: '/api/v1/services/foo/steps', method: 'POST' },
      { path: '/api/v1/services/foo/steps/step-1', method: 'PUT' },
      { path: '/api/v1/services/foo/steps/step-1', method: 'DELETE' }
    ]) {
      const response = await new Promise((resolve) => {
        const req = http.request({ hostname: 'localhost', port: TEST_PORT, path, method }, resolve);
        if (method !== 'DELETE') req.write('{}');
        req.end();
      });
      assert.strictEqual(response.statusCode, 401, method + ' ' + path);
    }
  });

  it('should respond 400 for step-add with non-object body', async () => {
    const response = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/v1/services/foo/steps',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' }
      }, resolve);
      req.write('[]');
      req.end();
    });
    assert.strictEqual(response.statusCode, 400);
    const body = await new Promise((resolve) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(JSON.parse(data)));
    });
    assert.match(body.error, /step object/i);
  });

  it('should respond 400 for step-update with malformed JSON', async () => {
    const response = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/v1/services/foo/steps/step-1',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' }
      }, resolve);
      req.write('not-json');
      req.end();
    });
    assert.strictEqual(response.statusCode, 400);
  });

  it('should respond 400 for execute with malformed JSON body', async () => {
    const response = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/v1/services/foo/execute',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' }
      }, resolve);
      req.write('not-json');
      req.end();
    });
    assert.strictEqual(response.statusCode, 400);
  });

  it('should respond 404 for step-CRUD routes not matching execute route', async () => {
    // /execute suffix must still hit the execute route, not get swallowed by /steps patterns.
    // Conversely, a path that doesn't match any route should 404.
    const response = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/v1/services/foo/steps/step-1/extra',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' }
      }, resolve);
      req.write('{}');
      req.end();
    });
    assert.strictEqual(response.statusCode, 404);
  });
});
