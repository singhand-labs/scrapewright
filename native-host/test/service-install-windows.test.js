const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const spawnCalls = [];
const mockSpawn = (cmd, args, opts) => {
  spawnCalls.push({ cmd, args, opts });
  return { status: 0, stdout: '', stderr: '' };
};

const childProc = require('child_process');
childProc.spawnSync = mockSpawn;

const { install, uninstall, start, stop, restart, isInstalled, TASK_NAME } = require('../lib/service-install/windows');

function lastPwshCall() {
  // Return the last powershell invocation. (`.find` would return the first,
  // which is the idempotent unregister call during install, not the
  // registration we want to assert against.)
  let last = null;
  for (const c of spawnCalls) {
    if (c.cmd === 'powershell') last = c;
  }
  return last;
}

function extractPsScript(args) {
  // The PowerShell script is passed as the last arg in the array.
  return args[args.length - 1];
}

describe('Windows service-install', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  describe('install', () => {
    it('invokes powershell with a scheduled-task registration', () => {
      install({
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        hostJsPath: 'C:\\scrapewright\\native-host\\host.js',
        port: 8765,
        autostart: true
      });
      const pwsh = lastPwshCall();
      assert.ok(pwsh, 'expected powershell invocation');
      const script = extractPsScript(pwsh.args);
      assert.match(script, /Register-ScheduledTask/);
      assert.match(script, /-TaskName/);
      assert.match(script, new RegExp(TASK_NAME));
      assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
      assert.match(script, /C:\\Program Files\\nodejs\\node\.exe/);
      assert.match(script, /--port=8765/);
    });

    it('passes --no-autostart equivalent: trigger disabled', () => {
      install({
        nodePath: 'C:\\node\\node.exe',
        hostJsPath: 'C:\\scrapewright\\host.js',
        port: 9123,
        autostart: false
      });
      const pwsh = lastPwshCall();
      const script = extractPsScript(pwsh.args);
      // Even when autostart=false we register the task, but with -State Disabled.
      assert.match(script, /-State Disabled/);
    });
  });

  describe('uninstall', () => {
    it('invokes Unregister-ScheduledTask', () => {
      uninstall();
      const pwsh = lastPwshCall();
      const script = extractPsScript(pwsh.args);
      assert.match(script, /Unregister-ScheduledTask/);
      assert.match(script, new RegExp(TASK_NAME));
    });
  });

  describe('start/stop', () => {
    it('start calls Start-ScheduledTask', () => {
      start();
      const script = extractPsScript(lastPwshCall().args);
      assert.match(script, /Start-ScheduledTask/);
    });

    it('stop calls Stop-ScheduledTask', () => {
      stop();
      const script = extractPsScript(lastPwshCall().args);
      assert.match(script, /Stop-ScheduledTask/);
    });
  });

  describe('restart', () => {
    it('stop then start', () => {
      restart();
      const scripts = spawnCalls.filter(c => c.cmd === 'powershell').map(c => extractPsScript(c.args));
      const joined = scripts.join('\n');
      assert.match(joined, /Stop-ScheduledTask/);
      assert.match(joined, /Start-ScheduledTask/);
    });
  });

  describe('isInstalled', () => {
    it('returns true when scheduled task exists', () => {
      const mock = (cmd, args) => {
        spawnCalls.push({ cmd, args });
        return { status: 0, stdout: TASK_NAME };
      };
      childProc.spawnSync = mock;
      try {
        assert.equal(isInstalled(), true);
      } finally {
        childProc.spawnSync = mockSpawn;
      }
    });

    it('returns false when scheduled task is missing', () => {
      const mock = () => ({ status: 1, stdout: '' });
      childProc.spawnSync = mock;
      try {
        assert.equal(isInstalled(), false);
      } finally {
        childProc.spawnSync = mockSpawn;
      }
    });
  });
});
