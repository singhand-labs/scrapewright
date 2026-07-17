const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dispatcher = require('../lib/service-install/index');

describe('service-install dispatcher', () => {
  it('exposes install/uninstall/start/stop/restart/isInstalled', () => {
    assert.equal(typeof dispatcher.install, 'function');
    assert.equal(typeof dispatcher.uninstall, 'function');
    assert.equal(typeof dispatcher.start, 'function');
    assert.equal(typeof dispatcher.stop, 'function');
    assert.equal(typeof dispatcher.restart, 'function');
    assert.equal(typeof dispatcher.isInstalled, 'function');
  });

  it('exposes readInstallSpec', () => {
    assert.equal(typeof dispatcher.readInstallSpec, 'function');
  });

  it('detects the current platform via process.platform', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      assert.equal(dispatcher.currentPlatform(), 'linux');
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
