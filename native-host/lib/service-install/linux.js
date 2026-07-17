'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

function unitPath(homeDir) {
  return path.join(homeDir || os.homedir(), '.config', 'systemd', 'user', 'scrapewright.service');
}

function buildUnitContent({ nodePath, hostJsPath, port }) {
  return `[Unit]
Description=Scrapewright host (HTTP server for the Chrome extension)
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${hostJsPath} --port=${port}
Restart=on-failure
RestartSec=3
Environment=SCRAPEWRIGHT_INVOKED_BY=systemd

[Install]
WantedBy=default.target
`;
}

function install({ nodePath, hostJsPath, port, autostart, homeDir, user }) {
  const target = unitPath(homeDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildUnitContent({ nodePath, hostJsPath, port }));

  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });

  if (autostart) {
    spawnSync('systemctl', ['--user', 'enable', '--now', 'scrapewright'], { stdio: 'inherit' });
    if (user) {
      spawnSync('loginctl', ['enable-linger', user], { stdio: 'inherit' });
    }
  }
  return { unitPath: target };
}

function uninstall({ homeDir } = {}) {
  spawnSync('systemctl', ['--user', 'disable', '--now', 'scrapewright'], { stdio: 'inherit' });
  const target = unitPath(homeDir);
  // Best-effort removal: if the unit file is already gone we don't want to
  // fail the whole uninstall. Callers can re-run isInstalled() to verify.
  try { fs.unlinkSync(target); } catch (_) { /* already absent */ }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
}

function start() {
  spawnSync('systemctl', ['--user', 'start', 'scrapewright'], { stdio: 'inherit' });
}

function stop() {
  spawnSync('systemctl', ['--user', 'stop', 'scrapewright'], { stdio: 'inherit' });
}

function restart() {
  spawnSync('systemctl', ['--user', 'restart', 'scrapewright'], { stdio: 'inherit' });
}

function isInstalled({ homeDir } = {}) {
  return fs.existsSync(unitPath(homeDir));
}

function readInstallSpec({ homeDir } = {}) {
  const target = unitPath(homeDir);
  if (!fs.existsSync(target)) return null;
  const text = fs.readFileSync(target, 'utf8');
  // Parse ExecStart=/path/to/node /path/to/host.js --port=N
  const m = text.match(/ExecStart=(\S+)\s+(\S+)\s+--port=(\d+)/);
  if (!m) return null;
  return { nodePath: m[1], hostJsPath: m[2], port: parseInt(m[3], 10) };
}

module.exports = { install, uninstall, start, stop, restart, isInstalled, readInstallSpec, unitPath };
