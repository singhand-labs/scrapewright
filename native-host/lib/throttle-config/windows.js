'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { FLAGS, hasFlagsInExec, addFlagsToExec, stripFlagsFromExec } = require('./flags');

// Windows: Chrome shortcuts (.lnk) live in:
//   - %USERPROFILE%\Desktop\
//   - %APPDATA%\Microsoft\Windows\Start Menu\Programs\
// Modifying .lnk files requires a COM shell object (WScript.Shell). We drive
// it via PowerShell so we don't take a native dependency.

function findShortcuts() {
  const profile = os.homedir();
  const appdata = process.env.APPDATA || path.join(profile, 'AppData', 'Roaming');
  const candidates = [
    path.join(profile, 'Desktop', 'Chrome.lnk'),
    path.join(profile, 'Desktop', 'Google Chrome.lnk'),
    path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Chrome.lnk'),
    path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk')
  ];
  return candidates.filter(p => fs.existsSync(p));
}

function runPowerShell(script) {
  const { spawnSync } = require('child_process');
  const args = ['-NoProfile', '-Command', script];
  const r = spawnSync('powershell', args, { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function enable() {
  const links = findShortcuts();
  if (links.length === 0) {
    return { ok: false, reason: 'no Chrome .lnk shortcuts found in user Desktop or Start Menu' };
  }
  const results = [];
  let anyChanged = false;
  for (const lnk of links) {
    const ps = [
      `$ws = New-Object -ComObject WScript.Shell`,
      `$sc = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
      `$target = $sc.TargetPath`,
      `$args = $sc.Arguments`,
      `if (-not ($args -match '--disable-background-timer-throttling')) {`,
      `  $sc.Arguments = $args + ' ${FLAGS.join(' ')}'`,
      `  $sc.Save()`,
      `  Write-Output 'modified'`,
      `} else { Write-Output 'already' }`
    ].join('\n');
    const r = runPowerShell(ps);
    const changed = (r.stdout || '').includes('modified');
    if (changed) anyChanged = true;
    results.push({ lnk, changed, stdout: r.stdout.trim(), stderr: r.stderr.trim() });
  }
  return { ok: true, anyChanged, results };
}

function disable() {
  const links = findShortcuts();
  if (links.length === 0) {
    return { ok: false, reason: 'no Chrome .lnk shortcuts found' };
  }
  const flagPatterns = FLAGS.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const results = [];
  let anyChanged = false;
  for (const lnk of links) {
    const ps = [
      `$ws = New-Object -ComObject WScript.Shell`,
      `$sc = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
      `$args = $sc.Arguments`,
      `$changed = $false`,
      ...flagPatterns.flatMap(p => [
        `if ($args -match '${p}') {`,
        `  $args = ($args -replace '\\s*${p}', '')`,
        `  $changed = $true`,
        `}`
      ]),
      `if ($changed) { $sc.Arguments = $args; $sc.Save(); Write-Output 'modified' }`,
      `else { Write-Output 'already' }`
    ].join('\n');
    const r = runPowerShell(ps);
    const changed = (r.stdout || '').includes('modified');
    if (changed) anyChanged = true;
    results.push({ lnk, changed, stdout: r.stdout.trim(), stderr: r.stderr.trim() });
  }
  return { ok: true, anyChanged, results };
}

function status() {
  const links = findShortcuts();
  return {
    installed: false,
    shortcuts: links,
    note: links.length === 0
      ? 'no Chrome .lnk shortcuts found in user Desktop or Start Menu'
      : 'shortcuts found — run `scrapewright throttle on` to instrument them'
  };
}

module.exports = { enable, disable, status };
