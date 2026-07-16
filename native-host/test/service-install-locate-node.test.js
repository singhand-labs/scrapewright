const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { locateNode } = require('../lib/service-install/locate-node');

describe('locateNode', () => {
  const savedArg0 = process.argv[0];
  const savedPath = process.env.PATH;

  afterEach(() => {
    process.argv[0] = savedArg0;
    if (savedPath !== undefined) process.env.PATH = savedPath;
  });

  it('returns process.execPath when argv[0] resolves to a real node binary', () => {
    // process.execPath is always a real node binary in tests.
    const result = locateNode();
    assert.equal(result, process.execPath);
  });

  it('returns absolute path (no relative segments)', () => {
    const result = locateNode();
    assert.ok(path.isAbsolute(result), 'expected absolute path, got ' + result);
  });
});
