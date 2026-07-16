#!/usr/bin/env node
// Unified Scrapewright CLI — HTTP-only world.
//
// The host runs as a per-OS background service (systemd/launchd/scheduled-task)
// installed by `scrapewright install`. The extension polls the host over HTTP.
// There is no Native Messaging transport anywhere.
//
// Subcommands: install | uninstall | start | stop | restart | run | status | doctor | logs | help

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST_DIR = path.dirname(__filename);
const HOST_JS = path.join(HOST_DIR, 'host.js');
const PORT = parseInt(process.env.SCRAPEWRIGHT_PORT, 10) || 8765;
const IS_WIN = process.platform === 'win32';

const serviceInstall = require('./lib/service-install');
const migration = require('./lib/migration');
const { locateNode } = require('./lib/service-install/locate-node');

// --- printers ---------------------------------------------------------------

const C = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };
const useColor = process.stdout.isTTY;
const paint = (c, s) => (useColor ? c + s + C.reset : s);

const say  = m => console.log(m);
const info = m => console.log(`  ${paint(C.dim, '→')} ${m}`);
const ok   = m => console.log(`  ${paint(C.green, '✓')} ${m}`);
const warn = m => console.log(`  ${paint(C.yellow, '!')} ${m}`);
const fail = m => console.error(`  ${paint(C.red, '✗')} ${m}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- helpers ----------------------------------------------------------------

function hostJsPath() { return HOST_JS; }
function nodePath() { return locateNode(); }

function httpGet(p) {
  return new Promise(resolve => {
    const req = http.get({ hostname: 'localhost', port: PORT, path: p, timeout: 3000 }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function resolveLogPath() {
  if (process.env.SCRAPEWRIGHT_LOG_FILE) return process.env.SCRAPEWRIGHT_LOG_FILE;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Logs', 'scrapewright', 'host.log');
  if (process.platform === 'win32')  return path.join(process.env.LOCALAPPDATA || home, 'scrapewright', 'host.log');
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'scrapewright', 'host.log');
}

// --- subcommands ------------------------------------------------------------

function parseInstallFlags(args) {
  const o = { port: null, autostart: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') o.port = parseInt(args[++i], 10);
    else if (args[i].startsWith('--port=')) o.port = parseInt(args[i].split('=')[1], 10);
    else if (args[i] === '--no-autostart') o.autostart = false;
    else if (args[i] === '--autostart') o.autostart = true;
  }
  return o;
}

function cmdInstall(opts) {
  const port = opts.port || PORT;

  // Migration safety net — surface and remove any leftover Native Messaging artifacts.
  const artifacts = migration.findLegacyArtifacts({});
  if (artifacts.files.length || artifacts.registryKeys.length) {
    warn('Legacy Native Messaging artifacts detected:');
    for (const f of artifacts.files) info('  ' + f);
    for (const k of artifacts.registryKeys) info('  ' + k);
    say('Removing...');
    const removed = migration.removeLegacyArtifacts({});
    for (const f of removed.removedFiles) ok('removed ' + f);
    for (const k of removed.removedKeys) ok('removed registry ' + k);
    say('');
  }

  say('Installing Scrapewright service...');
  try {
    const result = serviceInstall.install({
      nodePath: nodePath(),
      hostJsPath: hostJsPath(),
      port,
      autostart: opts.autostart,
      homeDir: os.homedir(),
      user: os.userInfo().username
    });
    ok('service installed on port ' + port);
    if (opts.autostart) {
      ok('auto-start enabled');
    } else {
      info('auto-start disabled; start manually with: scrapewright start');
    }
    say('');
    say('Extension: open the options page and set the port field to ' + port + ' to match.');
    return 0;
  } catch (e) {
    fail('install failed: ' + e.message);
    return 2;
  }
}

function cmdUninstall() {
  say('Uninstalling Scrapewright service...');
  try {
    serviceInstall.uninstall({ homeDir: os.homedir() });
    ok('service removed');
    const leftover = migration.findLegacyArtifacts({});
    if (leftover.files.length || leftover.registryKeys.length) {
      migration.removeLegacyArtifacts({});
      ok('legacy Native Messaging artifacts cleaned');
    }
    return 0;
  } catch (e) {
    fail('uninstall failed: ' + e.message);
    return 2;
  }
}

function cmdStart() {
  try { serviceInstall.start(); ok('service started'); return 0; }
  catch (e) { fail(e.message); return 2; }
}

function cmdStop() {
  try { serviceInstall.stop(); ok('service stopped'); return 0; }
  catch (e) { fail(e.message); return 2; }
}

function cmdRestart() {
  try { serviceInstall.restart(); ok('service restarted'); return 0; }
  catch (e) { fail(e.message); return 2; }
}

function parseRunFlags(args) {
  const o = { port: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') o.port = parseInt(args[++i], 10);
    else if (args[i].startsWith('--port=')) o.port = parseInt(args[i].split('=')[1], 10);
  }
  return o;
}

function cmdRun(opts) {
  const port = opts.port || PORT;
  say('Running host in foreground on port ' + port + ' (Ctrl+C to stop)');
  const args = ['--port=' + port];
  const child = spawn(nodePath(), [hostJsPath(), ...args], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code || 0));
  return 0; // reached only if spawn fails synchronously
}

async function cmdStatus(jsonOut) {
  const installed = serviceInstall.isInstalled({ homeDir: os.homedir() });
  const health = await httpGet('/health');
  const out = {
    installed,
    health: health && health.json ? health.json : null,
    healthReachable: !!(health && health.json),
    port: PORT
  };
  if (jsonOut) {
    console.log(JSON.stringify(out, null, 2));
    return out.healthReachable ? 0 : 1;
  }
  say('Scrapewright service');
  if (installed) ok('service installed');
  else fail('service not installed — run: scrapewright install');
  if (health && health.json) {
    ok('/health: ' + JSON.stringify(health.json));
  } else {
    warn('host not reachable on :' + PORT);
  }
  return out.healthReachable ? 0 : 1;
}

async function cmdDoctor(jsonOut) {
  const diagnostics = [];

  const installed = serviceInstall.isInstalled({ homeDir: os.homedir() });
  diagnostics.push({ check: 'service_installed', ok: installed, detail: installed ? 'yes' : 'not installed' });

  const health = await httpGet('/health');
  const reachable = !!(health && health.json);
  diagnostics.push({ check: 'host_reachable', ok: reachable, detail: reachable ? 'OK' : 'cannot reach :'+PORT });

  const artifacts = migration.findLegacyArtifacts({});
  const clean = artifacts.files.length === 0 && artifacts.registryKeys.length === 0;
  diagnostics.push({ check: 'no_legacy_native_messaging', ok: clean, detail: clean ? 'clean' : 'legacy artifacts present' });

  if (jsonOut) {
    console.log(JSON.stringify({ diagnostics, healthy: diagnostics.every(d => d.ok) }, null, 2));
  } else {
    say('Scrapewright diagnostics');
    for (const d of diagnostics) {
      const f = d.ok ? ok : fail;
      f(d.check + ': ' + d.detail);
    }
    if (artifacts.files.length || artifacts.registryKeys.length) {
      warn('Legacy Native Messaging artifacts detected — removing:');
      for (const f of artifacts.files) info('  ' + f);
      for (const k of artifacts.registryKeys) info('  ' + k);
      const removed = migration.removeLegacyArtifacts({});
      for (const f of removed.removedFiles) ok('removed ' + f);
      for (const k of removed.removedKeys) ok('removed registry ' + k);
    }
  }
  const healthy = diagnostics.every(d => d.ok);
  return healthy ? 0 : (installed || reachable ? 1 : 2);
}

function parseLogsFlags(args) {
  return { follow: args.includes('-f') || args.includes('--follow') };
}

function cmdLogs(opts) {
  const logPath = resolveLogPath();
  if (!fs.existsSync(logPath)) {
    fail('log file not found: ' + logPath);
    info('the host has not written logs yet');
    return 1;
  }
  say('Tailing ' + logPath + (opts.follow ? ' (following)' : ''));
  if (IS_WIN) {
    const psCmd = `Get-Content -Tail 50${opts.follow ? ' -Wait' : ''} -LiteralPath '${logPath}'`;
    spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit' });
  } else {
    spawnSync('tail', ['-n', '50', ...(opts.follow ? ['-f'] : []), logPath], { stdio: 'inherit' });
  }
  return 0;
}

function cmdHelp() {
  say('Scrapewright CLI');
  say('');
  say('Usage: scrapewright <command> [options]');
  say('');
  say('Commands:');
  say('  install [--port=N] [--no-autostart]');
  say('                               Install the host as an OS background service.');
  say('                               --port pins the port (default ' + PORT + ').');
  say('                               --autostart is the default; --no-autostart opts out.');
  say('  uninstall                    Stop and remove the OS service.');
  say('  start                        Start the service.');
  say('  stop                         Stop the service.');
  say('  restart                      Restart the service (picks up host.js changes).');
  say('  run [--port=N]               Run host in the foreground (for debugging).');
  say('  status [--json]              Show service state + /health.');
  say('  doctor [--json]              Diagnose install / reachability / migration state.');
  say('  logs [-f]                    Tail host log (follow with -f).');
  say('  help                         Show this message.');
  say('');
  say('Defaults: port ' + PORT + ' (SCRAPEWRIGHT_PORT env). Log: ' + resolveLogPath());
  return 0;
}

// --- dispatch ---------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const jsonOut = rest.includes('--json');
  switch (cmd) {
    case 'install':     return cmdInstall(parseInstallFlags(rest));
    case 'uninstall':   return cmdUninstall();
    case 'start':       return cmdStart();
    case 'stop':        return cmdStop();
    case 'restart':
    case 'rs':          return cmdRestart();
    case 'run':         return cmdRun(parseRunFlags(rest));
    case 'status':
    case 'st':          return cmdStatus(jsonOut);
    case 'doctor':
    case 'dr':          return cmdDoctor(jsonOut);
    case 'logs':
    case 'log':         return cmdLogs(parseLogsFlags(rest));
    case 'help':
    case '--help':
    case '-h':
    case undefined:     return cmdHelp();
    default:
      fail('unknown command: ' + cmd);
      console.error('');
      cmdHelp();
      return 2;
  }
}

main()
  .then(code => process.exit(typeof code === 'number' ? code : 0))
  .catch(e => { fail(e.stack || e.message); process.exit(1); });
