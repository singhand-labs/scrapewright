// Windows scheduled-task install (2026-09-18 user report from D:\temp): the
// generated PowerShell emitted the four New-ScheduledTask* commands as BARE
// statements — never assigning $action/$trigger/$settings/$principal — so
// Register-ScheduledTask bound $null to -Action ("The argument is null or
// empty"). Windows install never worked. buildInstallScript pins the fix.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInstallScript } = require('../lib/service-install/windows');

test('every New-* result is ASSIGNED to the variable Register-ScheduledTask references', () => {
  const s = buildInstallScript({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', hostJsPath: 'D:\\temp\\scrapewright\\native-host\\host.js', port: 8765, autostart: true });
  assert.match(s, /\$action = New-ScheduledTaskAction /);
  assert.match(s, /\$trigger = New-ScheduledTaskTrigger /);
  assert.match(s, /\$settings = New-ScheduledTaskSettingsSet /);
  assert.match(s, /\$principal = New-ScheduledTaskPrincipal /);
  // No bare statement form remains.
  assert.ok(!/\nNew-ScheduledTask/.test(s), 'no bare New-* statements');
  assert.match(s, /Register-ScheduledTask -TaskName 'ScrapewrightHost' -Action \$action/);
});

test('paths and port interpolate; --no-autostart flips the state flag', () => {
  const s = buildInstallScript({ nodePath: 'C:\\node\\node.exe', hostJsPath: 'D:\\x\\host.js', port: 9123, autostart: false });
  assert.ok(s.includes("'C:\\node\\node.exe'"));
  assert.ok(s.includes('-Argument \'"D:\\x\\host.js" --port=9123\''));
  assert.ok(s.includes('-State Disabled'));
});

test('CLI install with autostart starts the service immediately (Windows -AtLogOn asymmetry)', () => {
  const fs = require('fs');
  const path = require('path');
  const cli = fs.readFileSync(path.join(__dirname, '..', 'scrapewright.js'), 'utf8');
  const i = cli.indexOf("ok('service installed on port ' + port)");
  assert.ok(i > -1);
  const block = cli.slice(i, i + 900);
  assert.match(block, /serviceInstall\.start\(\)/, 'install(autostart) must start NOW — the Windows -AtLogOn trigger fires at NEXT logon, leaving the host down after install');
});
