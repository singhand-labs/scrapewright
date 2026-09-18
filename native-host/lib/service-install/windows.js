'use strict';

const childProcess = require('node:child_process');

const TASK_NAME = 'ScrapewrightHost';

function runPowerShell(script) {
  return childProcess.spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { stdio: 'pipe', encoding: 'utf8' });
}

// Extracted for tests: the generated script must ASSIGN each New-* result to
// a variable — the day-one bug emitted them as bare statements, so
// Register-ScheduledTask received $null for -Action ("The argument is null
// or empty"; install never worked on Windows).
function buildInstallScript({ nodePath, hostJsPath, port, autostart }) {
  const action = `$action = New-ScheduledTaskAction -Execute '${nodePath}' -Argument '"${hostJsPath}" --port=${port}'`;
  const trigger = `$trigger = New-ScheduledTaskTrigger -AtLogOn`;
  const settings = `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`;
  const stateFlag = autostart ? '' : ' -State Disabled';

  // Use the current user; no UAC needed.
  // S4U (run-whether-logged-on, no password stored): launches in a
  // NON-INTERACTIVE session, so node.exe's console window never appears on
  // the desktop (the 2026-09-18 user report: a foreground window parked in
  // the taskbar for as long as the host lives). The host is a pure HTTP
  // long-poll service — it needs no interactive desktop, and localhost
  // listening + filesystem work identically under S4U.
  const principal = `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U`;

  return `
${action}
${trigger}
${settings}
${principal}
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal${stateFlag}
`.trim();
}

function install({ nodePath, hostJsPath, port, autostart }) {
  // Unregister any existing task so re-install is idempotent.
  runPowerShell(`Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`);

  const script = buildInstallScript({ nodePath, hostJsPath, port, autostart });

  const r = runPowerShell(script);
  if (r.status !== 0) {
    throw new Error('Register-ScheduledTask failed: ' + (r.stderr || '').trim());
  }
}

function uninstall() {
  runPowerShell(`Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`);
}

function start() {
  runPowerShell(`Start-ScheduledTask -TaskName '${TASK_NAME}'`);
}

function stop() {
  runPowerShell(`Stop-ScheduledTask -TaskName '${TASK_NAME}'`);
}

function restart() {
  stop();
  start();
}

function isInstalled() {
  const r = runPowerShell(`Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName`);
  return r.status === 0 && (r.stdout || '').includes(TASK_NAME);
}

function readInstallSpec() {
  // Query the scheduled task's action and parse out the Execute (node) and
  // Arguments ("host.js" --port=N). Returns null if the task is missing or
  // the output is unparseable.
  const r = runPowerShell(
    `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).Actions | ForEach-Object { "$($_.Execute)|$($_.Arguments)" }`
  );
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  const line = r.stdout.trim().split(/\r?\n/)[0];
  const [nodePath, argStr] = line.split('|');
  if (!nodePath || !argStr) return null;
  const portMatch = argStr.match(/--port=(\d+)/);
  if (!portMatch) return null;
  // hostJsPath is the quoted path before --port (fall back to first .js token).
  const hostMatch = argStr.match(/"([^"]+\.js)"/) || argStr.match(/(\S+\.js)/);
  return {
    nodePath,
    hostJsPath: hostMatch ? hostMatch[1] : null,
    port: parseInt(portMatch[1], 10)
  };
}

module.exports = { install, uninstall, start, stop, restart, isInstalled, readInstallSpec, buildInstallScript, TASK_NAME };
