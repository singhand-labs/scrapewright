'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const LABEL = 'com.scrapewright.host';

function plistPath(homeDir) {
  return path.join(homeDir || os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
}

function guiDomain() {
  return 'gui/' + (process.getuid ? process.getuid() : 501);
}

function buildPlistContent({ nodePath, hostJsPath, port }) {
  // Escape XML special chars so paths with &, <, > are safe inside <string>.
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(hostJsPath)}</string>
    <string>--port=${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SCRAPEWRIGHT_INVOKED_BY</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/scrapewright-host.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/scrapewright-host.err.log</string>
</dict>
</plist>
`;
}

function install({ nodePath, hostJsPath, port, autostart, homeDir }) {
  const target = plistPath(homeDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildPlistContent({ nodePath, hostJsPath, port }));

  if (autostart) {
    spawnSync('launchctl', ['bootstrap', guiDomain(), target], { stdio: 'inherit' });
  }
  return { plistPath: target };
}

function uninstall({ homeDir } = {}) {
  spawnSync('launchctl', ['bootout', guiDomain() + '/' + LABEL], { stdio: 'inherit' });
  const target = plistPath(homeDir);
  // Best-effort removal: if the plist is already gone we don't want to
  // fail the whole uninstall. Callers can re-run isInstalled() to verify.
  try { fs.unlinkSync(target); } catch (_) { /* already absent */ }
}

function start() {
  spawnSync('launchctl', ['kickstart', guiDomain() + '/' + LABEL], { stdio: 'inherit' });
}

function stop() {
  spawnSync('launchctl', ['kill', 'SIGTERM', guiDomain() + '/' + LABEL], { stdio: 'inherit' });
}

function restart() {
  spawnSync('launchctl', ['kickstart', '-k', guiDomain() + '/' + LABEL], { stdio: 'inherit' });
}

function isInstalled({ homeDir } = {}) {
  return fs.existsSync(plistPath(homeDir));
}

module.exports = { install, uninstall, start, stop, restart, isInstalled, plistPath, LABEL };
