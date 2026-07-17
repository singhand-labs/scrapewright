const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const spawnCalls = [];
const mockSpawn = (cmd, args, opts) => {
  spawnCalls.push({ cmd, args, opts });
  return { status: 0, stdout: String(process.getuid && process.getuid() || 501), stderr: '' };
};

const writtenFiles = {};
const fs = require('node:fs');
const fsWrite = fs.writeFileSync;
const fsMkdir = fs.mkdirSync;
fs.writeFileSync = (p, content) => { writtenFiles[p] = content; return undefined; };
fs.mkdirSync = () => undefined;

const childProc = require('child_process');
childProc.spawnSync = mockSpawn;

const { install, uninstall, start, stop, restart, isInstalled, readInstallSpec } = require('../lib/service-install/macos');

describe('macOS service-install', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    for (const k of Object.keys(writtenFiles)) delete writtenFiles[k];
  });

  describe('install', () => {
    it('writes the LaunchAgent plist with the right content', () => {
      install({
        nodePath: '/usr/local/bin/node',
        hostJsPath: '/Users/alice/scrapewright/native-host/host.js',
        port: 8765,
        homeDir: '/Users/alice',
        autostart: true
      });

      const plistPath = '/Users/alice/Library/LaunchAgents/com.scrapewright.host.plist';
      assert.ok(writtenFiles[plistPath], 'expected plist at ' + plistPath);
      const plist = writtenFiles[plistPath];
      assert.match(plist, /<key>Label<\/key>\s*<string>com\.scrapewright\.host<\/string>/);
      assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
      assert.match(plist, /<string>\/Users\/alice\/scrapewright\/native-host\/host\.js<\/string>/);
      assert.match(plist, /<string>--port=8765<\/string>/);
      assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
      assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    });

    it('calls launchctl bootstrap when autostart is true', () => {
      install({
        nodePath: '/usr/local/bin/node',
        hostJsPath: '/Users/alice/scrapewright/native-host/host.js',
        port: 8765,
        homeDir: '/Users/alice',
        autostart: true
      });
      const bootCall = spawnCalls.find(c => c.cmd === 'launchctl' && c.args[0] === 'bootstrap');
      assert.ok(bootCall, 'expected launchctl bootstrap, got: ' + JSON.stringify(spawnCalls));
      assert.match(bootCall.args[1], /^gui\/\d+$/);
    });

    it('skips bootstrap when autostart is false', () => {
      install({
        nodePath: '/usr/local/bin/node',
        hostJsPath: '/Users/alice/scrapewright/native-host/host.js',
        port: 8765,
        homeDir: '/Users/alice',
        autostart: false
      });
      const bootCall = spawnCalls.find(c => c.args[0] === 'bootstrap');
      assert.equal(bootCall, undefined);
    });
  });

  describe('uninstall', () => {
    it('calls bootout and removes the plist', () => {
      const fsUnlink = fs.unlinkSync;
      const removed = [];
      fs.unlinkSync = (p) => removed.push(p);
      try {
        uninstall({ homeDir: '/Users/alice' });
        const bootoutCall = spawnCalls.find(c => c.args[0] === 'bootout');
        assert.ok(bootoutCall, 'expected launchctl bootout');
        assert.deepEqual(removed, ['/Users/alice/Library/LaunchAgents/com.scrapewright.host.plist']);
      } finally {
        fs.unlinkSync = fsUnlink;
      }
    });
  });

  describe('start/stop/restart', () => {
    it('start calls launchctl kickstart gui/<uid>/com.scrapewright.host', () => {
      start();
      assert.equal(spawnCalls[0].cmd, 'launchctl');
      assert.equal(spawnCalls[0].args[0], 'kickstart');
      assert.match(spawnCalls[0].args[1], /^gui\/\d+\/com\.scrapewright\.host$/);
    });

    it('stop calls launchctl kill SIGTERM gui/<uid>/com.scrapewright.host', () => {
      stop();
      assert.equal(spawnCalls[0].cmd, 'launchctl');
      assert.equal(spawnCalls[0].args[0], 'kill');
      assert.equal(spawnCalls[0].args[1], 'SIGTERM');
    });

    it('restart calls kickstart -k', () => {
      restart();
      assert.equal(spawnCalls[0].args[0], 'kickstart');
      assert.equal(spawnCalls[0].args[1], '-k');
    });
  });

  describe('isInstalled', () => {
    it('returns true when plist exists', () => {
      const fsExists = fs.existsSync;
      fs.existsSync = (p) => p === '/Users/alice/Library/LaunchAgents/com.scrapewright.host.plist';
      try {
        assert.equal(isInstalled({ homeDir: '/Users/alice' }), true);
      } finally {
        fs.existsSync = fsExists;
      }
    });
  });

  describe('readInstallSpec', () => {
    it('parses node, host.js, and port from a written plist', () => {
      install({
        nodePath: '/usr/local/bin/node',
        hostJsPath: '/Users/alice/scrapewright/native-host/host.js',
        port: 8765,
        homeDir: '/Users/alice',
        autostart: false
      });
      const plistPath = '/Users/alice/Library/LaunchAgents/com.scrapewright.host.plist';
      const fsExists = fs.existsSync;
      const fsRead = fs.readFileSync;
      fs.existsSync = (p) => p === plistPath;
      fs.readFileSync = (p) => writtenFiles[p];
      try {
        const spec = readInstallSpec({ homeDir: '/Users/alice' });
        assert.equal(spec.nodePath, '/usr/local/bin/node');
        assert.equal(spec.hostJsPath, '/Users/alice/scrapewright/native-host/host.js');
        assert.equal(spec.port, 8765);
      } finally {
        fs.existsSync = fsExists;
        fs.readFileSync = fsRead;
      }
    });

    it('returns null when no plist exists', () => {
      const fsExists = fs.existsSync;
      fs.existsSync = () => false;
      try {
        const spec = readInstallSpec({ homeDir: '/nonexistent-' + Date.now() });
        assert.equal(spec, null);
      } finally {
        fs.existsSync = fsExists;
      }
    });
  });
});
