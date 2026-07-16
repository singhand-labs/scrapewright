const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Mock spawnSync before requiring the module under test.
const spawnCalls = [];
const mockSpawn = (cmd, args, opts) => {
  spawnCalls.push({ cmd, args, opts });
  return { status: 0, stdout: '', stderr: '' };
};
const writtenFiles = {};
const mockWrite = (p, content) => { writtenFiles[p] = content; return undefined; };
const mockMkdir = () => undefined;

// Mutate the real child_process namespace so the mock is visible regardless
// of whether the module under test uses `require('child_process')` or
// `require('node:child_process')` (builtins share one namespace object).
const cp = require('child_process');
cp.spawnSync = mockSpawn;

// Same for fs: mutate the shared builtin namespace directly. A cache-swap
// via `require.cache[require.resolve('fs')] = { exports: {...} }` would
// create a *separate* object that later test-body patches
// (`fs.unlinkSync = stub`, `fs.existsSync = stub`) would not reach.
const realFs = require('fs');
realFs.writeFileSync = mockWrite;
realFs.mkdirSync = mockMkdir;

// We require AFTER setting up the cache mock.
const { install, uninstall, start, stop, restart, isInstalled } = require('../lib/service-install/linux');

describe('linux service-install', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    for (const k of Object.keys(writtenFiles)) delete writtenFiles[k];
  });

  describe('install', () => {
    it('writes the systemd unit file with the right content', () => {
      const result = install({
        nodePath: '/usr/bin/node',
        hostJsPath: '/opt/scrapewright/native-host/host.js',
        port: 8765,
        autostart: true,
        homeDir: '/home/alice'
      });

      const unitPath = '/home/alice/.config/systemd/user/scrapewright.service';
      assert.ok(writtenFiles[unitPath], 'expected unit file written at ' + unitPath);
      const unit = writtenFiles[unitPath];
      assert.match(unit, /\[Unit\]/);
      assert.match(unit, /Description=Scrapewright host/);
      assert.match(unit, /\[Service\]/);
      assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/scrapewright\/native-host\/host\.js --port=8765/);
      assert.match(unit, /Restart=on-failure/);
      assert.match(unit, /Environment=SCRAPEWRIGHT_INVOKED_BY=systemd/);
    });

    it('calls systemctl --user enable --now when autostart is true', () => {
      install({
        nodePath: '/usr/bin/node',
        hostJsPath: '/opt/scrapewright/native-host/host.js',
        port: 8765,
        autostart: true,
        homeDir: '/home/alice'
      });
      const enableCall = spawnCalls.find(c => c.args.join(' ').includes('enable --now'));
      assert.ok(enableCall, 'expected systemctl --user enable --now, got: ' + JSON.stringify(spawnCalls));
      assert.equal(enableCall.cmd, 'systemctl');
      assert.deepEqual(enableCall.args.slice(0, 2), ['--user', 'enable']);
    });

    it('calls loginctl enable-linger for boot-time start', () => {
      install({
        nodePath: '/usr/bin/node',
        hostJsPath: '/opt/scrapewright/native-host/host.js',
        port: 8765,
        autostart: true,
        homeDir: '/home/alice',
        user: 'alice'
      });
      const lingerCall = spawnCalls.find(c => c.cmd === 'loginctl' && c.args.join(' ').includes('enable-linger'));
      assert.ok(lingerCall, 'expected loginctl enable-linger alice');
    });

    it('skips enable --now when autostart is false', () => {
      install({
        nodePath: '/usr/bin/node',
        hostJsPath: '/opt/scrapewright/native-host/host.js',
        port: 8765,
        autostart: false,
        homeDir: '/home/alice'
      });
      const enableCall = spawnCalls.find(c => c.args.join(' ').includes('enable'));
      assert.equal(enableCall, undefined);
    });
  });

  describe('uninstall', () => {
    it('disables the unit and removes the file', () => {
      const fsUnlink = fs.unlinkSync;
      const removed = [];
      fs.unlinkSync = (p) => removed.push(p);
      try {
        uninstall({ homeDir: '/home/alice' });
        const disableCall = spawnCalls.find(c => c.args.join(' ').includes('disable --now'));
        assert.ok(disableCall, 'expected disable --now');
        assert.deepEqual(removed, ['/home/alice/.config/systemd/user/scrapewright.service']);
      } finally {
        fs.unlinkSync = fsUnlink;
      }
    });
  });

  describe('start/stop/restart', () => {
    it('start calls systemctl --user start scrapewright', () => {
      start();
      assert.deepEqual(spawnCalls[0], { cmd: 'systemctl', args: ['--user', 'start', 'scrapewright'], opts: { stdio: 'inherit' } });
    });

    it('stop calls systemctl --user stop scrapewright', () => {
      stop();
      assert.deepEqual(spawnCalls[0], { cmd: 'systemctl', args: ['--user', 'stop', 'scrapewright'], opts: { stdio: 'inherit' } });
    });

    it('restart calls systemctl --user restart scrapewright', () => {
      restart();
      assert.deepEqual(spawnCalls[0], { cmd: 'systemctl', args: ['--user', 'restart', 'scrapewright'], opts: { stdio: 'inherit' } });
    });
  });

  describe('isInstalled', () => {
    it('returns true when unit file exists', () => {
      const fsExists = fs.existsSync;
      fs.existsSync = (p) => p === '/home/alice/.config/systemd/user/scrapewright.service';
      try {
        assert.equal(isInstalled({ homeDir: '/home/alice' }), true);
      } finally {
        fs.existsSync = fsExists;
      }
    });

    it('returns false when unit file is missing', () => {
      const fsExists = fs.existsSync;
      fs.existsSync = () => false;
      try {
        assert.equal(isInstalled({ homeDir: '/home/alice' }), false);
      } finally {
        fs.existsSync = fsExists;
      }
    });
  });
});
