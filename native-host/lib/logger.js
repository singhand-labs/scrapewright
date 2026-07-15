// Logger that writes to stderr AND a log file. The log file is the critical
// piece — when Chrome launches this host, stderr goes nowhere the user can
// see. The log file is the only trail for diagnosing "Native host has exited".
//
// Path precedence:
//   1. SCRAPEWRIGHT_LOG_FILE env var (set explicitly)
//   2. Platform default:
//      macOS:   ~/Library/Logs/scrapewright/host.log
//      Linux:   ${XDG_CACHE_HOME:-~/.cache}/scrapewright/host.log
//      Windows: %LOCALAPPDATA%\scrapewright\host.log
//
// Log rotation: when the file exceeds ROTATE_BYTES, it's renamed to
// host.log.old and a fresh file starts. One historical file is kept.
// Anything older is overwritten on the next rotation.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROTATE_BYTES = 1024 * 1024; // 1 MB

function resolveLogPath() {
  if (process.env.SCRAPEWRIGHT_LOG_FILE) return process.env.SCRAPEWRIGHT_LOG_FILE;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Logs', 'scrapewright', 'host.log');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'scrapewright', 'host.log');
  }
  const cache = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(cache, 'scrapewright', 'host.log');
}

class Logger {
  constructor() {
    this.filePath = resolveLogPath();
    this.stream = null;
    this.disabled = false;
    this.bytesWritten = 0;
    this._open();
  }

  _open() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Check size for rotation.
      try {
        const st = fs.statSync(this.filePath);
        if (st.size > ROTATE_BYTES) this._rotate();
      } catch { /* file doesn't exist yet — fine */ }
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
      this.stream.on('error', () => { this.disabled = true; });
    } catch {
      this.disabled = true;
    }
  }

  _rotate() {
    try {
      const old = this.filePath + '.old';
      try { fs.unlinkSync(old); } catch {}
      try { fs.renameSync(this.filePath, old); } catch {}
    } catch { /* best-effort */ }
  }

  _write(level, message, fields) {
    const ts = new Date().toISOString();
    const line = `${ts} [${level}] ${message}` + (fields ? ' ' + safeStringify(fields) : '') + '\n';
    // Always go to stderr too — it's the lifeline when running interactively
    // (./host.js from a terminal) and harmless when Chrome-launched.
    process.stderr.write(line);
    if (this.disabled || !this.stream) return;
    try {
      this.stream.write(line);
      this.bytesWritten += line.length;
      if (this.bytesWritten > ROTATE_BYTES) {
        this.bytesWritten = 0;
        this.stream.end(() => {
          this._rotate();
          this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
          this.stream.on('error', () => { this.disabled = true; });
        });
      }
    } catch { /* swallow — logging must never kill the host */ }
  }

  info(message, fields) { this._write('info', message, fields); }
  warn(message, fields) { this._write('warn', message, fields); }
  error(message, fields) { this._write('error', message, fields); }
}

function safeStringify(value) {
  if (value instanceof Error) {
    return JSON.stringify({ message: value.message, stack: value.stack });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const logger = new Logger();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { logger, resolveLogPath };
}
