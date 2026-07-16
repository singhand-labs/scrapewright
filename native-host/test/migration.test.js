const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const childProc = require('child_process');
const realSpawnSync = childProc.spawnSync;
// Mock spawnSync so Windows registry probes succeed deterministically on any host.
const spawnCalls = [];
const mockSpawn = (cmd, args, opts) => {
  spawnCalls.push({ cmd, args, opts });
  return { status: 0, stdout: '', stderr: '' };
};
childProc.spawnSync = mockSpawn;

const { findLegacyArtifacts, removeLegacyArtifacts } = require('../lib/migration');

describe('migration safety net', () => {
  const fakeFiles = new Set();
  const fakeDirs = new Set();

  const fsExists = fs.existsSync;
  const fsUnlink = fs.unlinkSync;
  const fsRmdir = fs.rmSync;

  beforeEach(() => {
    fakeFiles.clear();
    fakeDirs.clear();
    fs.existsSync = (p) => fakeFiles.has(p) || fakeDirs.has(p);
    fs.unlinkSync = (p) => { fakeFiles.delete(p); };
    fs.rmSync = (p, opts) => {
      if (fakeFiles.has(p)) fakeFiles.delete(p);
      if (fakeDirs.has(p)) fakeDirs.delete(p);
    };
    spawnCalls.length = 0;
  });

  afterEach(() => {
    fs.existsSync = fsExists;
    fs.unlinkSync = fsUnlink;
    fs.rmSync = fsRmdir;
  });

  describe('findLegacyArtifacts', () => {
    it('returns the Linux manifest path when it exists', () => {
      const p = '/home/alice/.config/google-chrome/NativeMessagingHosts/com.scrapewright.host.json';
      fakeFiles.add(p);
      const result = findLegacyArtifacts({ homeDir: '/home/alice', platform: 'linux' });
      assert.deepEqual(result.files, [p]);
      assert.deepEqual(result.registryKeys, []);
    });

    it('returns the macOS manifest path when it exists', () => {
      const p = '/Users/alice/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.scrapewright.host.json';
      fakeFiles.add(p);
      const result = findLegacyArtifacts({ homeDir: '/Users/alice', platform: 'darwin' });
      assert.deepEqual(result.files, [p]);
    });

    it('returns the Windows registry key on win32', () => {
      const result = findLegacyArtifacts({ homeDir: 'C:\\Users\\alice', platform: 'win32' });
      assert.deepEqual(result.registryKeys, ['HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.scrapewright.host']);
    });

    it('returns empty when nothing exists', () => {
      const result = findLegacyArtifacts({ homeDir: '/home/alice', platform: 'linux' });
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.registryKeys, []);
    });
  });

  describe('removeLegacyArtifacts', () => {
    it('removes files and returns what it removed', () => {
      const p = '/home/alice/.config/google-chrome/NativeMessagingHosts/com.scrapewright.host.json';
      fakeFiles.add(p);
      const result = removeLegacyArtifacts({ homeDir: '/home/alice', platform: 'linux' });
      assert.deepEqual(result.removedFiles, [p]);
      assert.ok(!fakeFiles.has(p), 'file should have been removed');
    });
  });
});
