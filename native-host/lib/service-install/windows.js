'use strict';

const childProcess = require('node:child_process');

const TASK_NAME = 'ScrapewrightHost';

function runPowerShell(script) {
  return childProcess.spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { stdio: 'pipe', encoding: 'utf8' });
}

function install({ nodePath, hostJsPath, port, autostart }) {
  // Unregister any existing task so re-install is idempotent.
  runPowerShell(`Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`);

  const action = `New-ScheduledTaskAction -Execute '${nodePath}' -Argument '"${hostJsPath}" --port=${port}'`;
  const trigger = `New-ScheduledTaskTrigger -AtLogOn`;
  const settings = `New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`;
  const stateFlag = autostart ? '' : ' -State Disabled';

  // Use the current user; no UAC needed.
  const principal = `New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive`;

  const script = `
${action}
${trigger}
${settings}
${principal}
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal${stateFlag}
`.trim();

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

module.exports = { install, uninstall, start, stop, restart, isInstalled, TASK_NAME };
