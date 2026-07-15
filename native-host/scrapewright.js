#!/usr/bin/env node
// Unified Scrapewright CLI. Wraps the existing primitives (install-host.sh/ps1,
// host.js /health, logger paths) and adds extension-ID auto-detection, so a fresh
// machine goes from clone to connected with one command: ./bin/scrapewright setup --auto
//
// Subcommands: setup | doctor | status | restart | logs | id | uninstall | help
// Zero dependencies; Node >=18. Cross-platform (macOS/Linux/Windows).

const { spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectExtensionId } = require('./lib/detect-id');

const HOST_DIR = path.dirname(__filename);          // native-host/
const PORT = parseInt(process.env.SCRAPEWRIGHT_PORT, 10) || 8765;
const IS_WIN = process.platform === 'win32';

// --- printers (mirror install-host.sh style) --------------------------------

const C = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };
const useColor = process.stdout.isTTY;
const paint = (c, s) => (useColor ? c + s + C.reset : s);

const say  = m => console.log(m);
const info = m => console.log(`  ${paint(C.dim, '→')} ${m}`);
const ok   = m => console.log(`  ${paint(C.green, '✓')} ${m}`);
const warn = m => console.log(`  ${paint(C.yellow, '!')} ${m}`);
const fail = m => console.error(`  ${paint(C.red, '✗')} ${m}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- platform helpers -------------------------------------------------------

function installerPath() { return path.join(HOST_DIR, IS_WIN ? 'install-host.ps1' : 'install-host.sh'); }

// Run the installer with inherited stdio; returns its exit code.
function runInstaller(args) {
  let cmd, cmdArgs;
  if (IS_WIN) {
    cmd = 'powershell';
    cmdArgs = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', installerPath(), ...args];
  } else {
    cmd = 'bash';
    cmdArgs = [installerPath(), ...args];
  }
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

// GET localhost:PORT<path>; resolves {status, json} or null on error/timeout.
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

// Log path — duplicated from lib/logger.js (cannot require it: Logger opens the file at load).
function resolveLogPath() {
  if (process.env.SCRAPEWRIGHT_LOG_FILE) return process.env.SCRAPEWRIGHT_LOG_FILE;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Logs', 'scrapewright', 'host.log');
  if (process.platform === 'win32')  return path.join(process.env.LOCALAPPDATA || home, 'scrapewright', 'host.log');
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'scrapewright', 'host.log');
}

function findHostPids() {
  try {
    if (IS_WIN) {
      const ps = "Get-CronCrawler -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*host.js*' } | Select-Object -ExpandProperty ProcessId";
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      return (r.stdout || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
    }
    const r = spawnSync('pgrep', ['-f', 'node.*host\\.js'], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    return (r.stdout || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function killPids(pids) {
  if (IS_WIN) {
    spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pids.join(',')} -Force`], { stdio: 'inherit' });
  } else {
    spawnSync('kill', pids, { stdio: 'inherit' });
  }
}

// --- subcommands ------------------------------------------------------------

async function cmdId() {
  const d = detectExtensionId({ hostDir: HOST_DIR });
  if (!d.id) {
    fail('Scrapewright extension not found in any Chrome profile.');
    info('Load it unpacked at chrome://extensions/ (Developer Mode → Load unpacked → extension/).');
    info('Or supply it explicitly: scrapewright setup --id <id>');
    return 1;
  }
  ok(`extension id: ${d.id}`);
  info(`profile: ${d.profile}`);
  info(`loaded from: ${d.path}`);
  if (d.candidates.length > 1) {
    warn(`${d.candidates.length} Scrapewright instances loaded — picking the active one:`);
    for (const c of d.candidates) info(`  ${c.id} (${c.profile})${c.active ? ' [active]' : ''}`);
  }
  if (!d.manifestId) {
    info('no native-host manifest installed yet → run: scrapewright setup --auto');
  } else if (d.drift) {
    fail(`ID DRIFT: manifest allowed_origins = ${d.manifestId}, but loaded extension = ${d.id}`);
    info('Chrome is launching the host for the wrong extension. Fix: scrapewright setup --auto');
    return 1;
  } else {
    ok(`manifest allowed_origins matches (${d.manifestId})`);
  }
  return 0;
}

function parseSetupFlags(args) {
  const o = { id: null, auto: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') o.id = args[++i];
    else if (args[i] === '--auto') o.auto = true;
  }
  return o;
}

async function cmdSetup(opts) {
  let id = opts.id;
  if (!id) {
    say('Detecting extension id...');
    const d = detectExtensionId({ hostDir: HOST_DIR });
    if (!d.id) {
      fail('could not auto-detect the extension id.');
      info('load the extension in chrome://extensions/, then re-run; or: scrapewright setup --id <id>');
      return 1;
    }
    id = d.id;
    ok(`detected: ${id} (profile ${d.profile})`);
    if (d.drift) warn(`manifest currently allows ${d.manifestId} — will update to ${id}`);
  }
  say('');
  say('Installing native host...');
  const code = runInstaller(IS_WIN ? ['-ExtensionId', id] : [id]);
  if (code !== 0) { fail(`installer exited with code ${code}`); return code; }
  say('');
  say('Verifying...');
  runInstaller(IS_WIN ? ['-Doctor'] : ['--doctor']);
  say('');
  const h = await httpGet('/health');
  if (h && h.json) {
    ok(`host reachable — status=${h.json.status}, extensionConnected=${h.json.extensionConnected}`);
    if (!h.json.extensionConnected) info('reload the extension at chrome://extensions/ (or click Reconnect in options) to let Chrome launch the host.');
  } else {
    info('host not reachable yet — reload the extension so Chrome launches it via native messaging.');
  }
  return 0;
}

async function cmdDoctor() {
  runInstaller(IS_WIN ? ['-Doctor'] : ['--doctor']);
  say('');
  say(paint(C.dim, 'Health probe'));
  const h = await httpGet('/health');
  if (h && h.json) {
    ok(`/health → ${JSON.stringify(h.json)}`);
    return h.json.status === 'ok' ? 0 : 1;
  }
  fail(`host not reachable on :${PORT} (it only listens once Chrome launches it, or after 'node host.js')`);
  return 1;
}

async function cmdStatus() {
  const pids = findHostPids();
  if (pids.length) ok(`host process running (pid ${pids.join(', ')})`);
  else fail('no host process found');

  const h = await httpGet('/health');
  if (h && h.json) {
    ok(`/health: status=${h.json.status}, extensionConnected=${h.json.extensionConnected}, uptime=${h.json.uptime}s, queue=${h.json.queueLength}`);
    if (!h.json.extensionConnected) warn('extension not currently connected');
  } else {
    warn(`host not reachable on :${PORT}`);
  }

  const d = detectExtensionId({ hostDir: HOST_DIR });
  if (d.id && d.manifestId) {
    if (d.drift) fail(`ID drift: loaded=${d.id}, manifest=${d.manifestId} → run: scrapewright setup --auto`);
    else info(`extension id ${d.id} matches manifest`);
  } else if (d.id && !d.manifestId) {
    info(`extension loaded (${d.id}) but no manifest installed → run: scrapewright setup --auto`);
  }
  return 0;
}

async function cmdRestart() {
  const pids = findHostPids();
  if (!pids.length) { warn('no host process running — nothing to kill'); }
  else {
    say(`Killing host process(es): ${pids.join(', ')}`);
    killPids(pids);
    ok('killed');
  }
  // Give a short window for the host to come back on its own.
  say('Waiting briefly for the host to return...');
  let up = false;
  for (let i = 0; i < 5; i++) {          // 5 × 2s = 10s
    await sleep(2000);
    const h = await httpGet('/health');
    if (h && h.json) { up = true; ok(`host back up — uptime=${h.json.uptime}s`); break; }
  }
  if (up) return 0;

  // Native-messaging mode: Chrome does NOT auto-relaunch a killed host. The
  // extension falls back to long-polling (pollingActive=true), which probes
  // :8765 but does not restart the host process — and the keepalive alarm's
  // reconnect condition (!nativePort && !pollingActive) is blocked. A Reconnect
  // (or Chrome restart) is required to make the extension call connectNative()
  // again, which is what respawns the host. Useful after editing host.js.
  say('');
  warn('host did not come back on its own.');
  say('In native-messaging mode, Chrome will not auto-relaunch a killed host.');
  say('To relaunch it (picks up the current host.js code):');
  info('extension options page → Native Host Status → Reconnect  (or restart Chrome)');
  info('then verify: scrapewright status');
  return 1;
}

function parseLogsFlags(args) {
  return { follow: args.includes('-f') || args.includes('--follow') };
}

function cmdLogs(opts) {
  const logPath = resolveLogPath();
  if (!fs.existsSync(logPath)) {
    fail(`log file not found: ${logPath}`);
    info('the host has not written logs yet');
    return 1;
  }
  say(`Tailing ${logPath}${opts.follow ? ' (following)' : ''}`);
  if (IS_WIN) {
    const psCmd = `Get-Content -Tail 50${opts.follow ? ' -Wait' : ''} -LiteralPath '${logPath}'`;
    spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit' });
  } else {
    spawnSync('tail', ['-n', '50', ...(opts.follow ? ['-f'] : []), logPath], { stdio: 'inherit' });
  }
  return 0;
}

function cmdUninstall() {
  return runInstaller(IS_WIN ? ['-Uninstall'] : ['--uninstall']);
}

function cmdHelp() {
  say('Scrapewright CLI');
  say('');
  say('Usage: scrapewright <command> [options]');
  say('');
  say('Commands:');
  say('  setup [--id <id> | --auto]   Install native host. Auto-detects the extension id');
  say('                               from Chrome if not given, then verifies.');
  say('  doctor                       Diagnose install + probe host /health.');
  say('  status                       Show host process, /health, and id-drift check.');
  say('  restart                      Kill host; Chrome relaunches it (auto-reconnects ~24s).');
  say('  logs [-f]                    Tail the host log (follow with -f).');
  say('  id                           Detect the loaded extension id and check vs manifest.');
  say('  uninstall                    Remove the native-host manifest + wrapper.');
  say('  help                         Show this message.');
  say('');
  say(`Defaults: port ${PORT} (SCRAPEWRIGHT_PORT env). Log: ${resolveLogPath()}`);
  return 0;
}

// --- dispatch ---------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'id':          return cmdId();
    case 'setup':       return cmdSetup(parseSetupFlags(rest));
    case 'doctor':
    case 'dr':          return cmdDoctor();
    case 'status':
    case 'st':          return cmdStatus();
    case 'restart':
    case 'rs':          return cmdRestart();
    case 'logs':
    case 'log':         return cmdLogs(parseLogsFlags(rest));
    case 'uninstall':   return cmdUninstall();
    case 'help':
    case '--help':
    case '-h':
    case undefined:     return cmdHelp();
    default:
      fail(`unknown command: ${cmd}`);
      console.error('');
      cmdHelp();
      return 2;
  }
}

main()
  .then(code => process.exit(typeof code === 'number' ? code : 0))
  .catch(e => { fail(e.stack || e.message); process.exit(1); });
