// Auto-detect the loaded Scrapewright extension ID, so users don't have to
// copy it from chrome://extensions/. Used by `scrapewright setup --auto` / `scrapewright id`.
//
// PRIMARY method: parse <chrome-user-data>/<profile>/Secure Preferences →
// extensions.settings, filter location===4 (unpacked), read <path>/manifest.json
// and match name "Scrapewright".
//   - `Default/Preferences` is EMPTY for unpacked exts (must use Secure Preferences).
//   - Unpacked entries have manifest:null inline, only `path` → hence the readback.
// FALLBACK / liveness: <profile>/Local Extension Settings/<id>/*.log|*.ldb (LevelDB)
//   containing "nativeState"/"executionLogs" — confirms which candidate is active.
//
// Pure Node fs (no chrome runtime), safe to require from the CLI and from tests.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST_NAME = 'com.scrapewright.host';
const TARGET_NAME = 'Scrapewright';

function chromeUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, 'Google', 'Chrome', 'User Data');
  }
  // Linux
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'google-chrome')
    : path.join(home, '.config', 'google-chrome');
}

function listProfiles(chromeDir) {
  if (!fs.existsSync(chromeDir)) return [];
  try {
    return fs.readdirSync(chromeDir)
      .filter(d => d === 'Default' || /^Profile \d+$/.test(d));
  } catch {
    return [];
  }
}

function readManifestName(extPath) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
    return m && m.name ? m.name : null;
  } catch {
    return null;
  }
}

// Liveness: does this extension's LevelDB storage contain our app-specific keys?
function isLikelyActive(chromeDir, profile, id) {
  const dir = path.join(chromeDir, profile, 'Local Extension Settings', id);
  if (!fs.existsSync(dir)) return false;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.log$|\.ldb$/.test(f)) continue;
      try {
        const buf = fs.readFileSync(path.join(dir, f));
        if (buf.includes('nativeState') || buf.includes('executionLogs')) return true;
      } catch { /* keep scanning */ }
    }
  } catch { /* ignore */ }
  return false;
}

function scanProfile(chromeDir, profile) {
  const sp = path.join(chromeDir, profile, 'Secure Preferences');
  if (!fs.existsSync(sp)) return [];
  let prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch {
    return [];
  }
  const settings = prefs && prefs.extensions && prefs.extensions.settings;
  if (!settings || typeof settings !== 'object') return [];
  const found = [];
  for (const [id, v] of Object.entries(settings)) {
    if (!v || v.location !== 4 || !v.path) continue; // unpacked (LOAD) only
    if (readManifestName(v.path) === TARGET_NAME) {
      found.push({ id, profile, path: v.path, active: isLikelyActive(chromeDir, profile, id) });
    }
  }
  return found;
}

// Read the id baked into the installed manifest's allowed_origins, if any.
function manifestAllowedId(hostDir) {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', HOST_NAME + '.json'));
  } else if (process.platform === 'win32') {
    // Windows: manifest written next to host.js; registry points at it.
    if (hostDir) candidates.push(path.join(hostDir, HOST_NAME + '.json'));
  } else {
    candidates.push(path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', HOST_NAME + '.json'));
  }
  for (const p of candidates) {
    try {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      const orig = (m.allowed_origins || [])[0] || '';
      const match = orig.match(/^chrome-extension:\/\/([a-z]+)\//);
      if (match) return match[1];
    } catch { /* try next */ }
  }
  return null;
}

// opts: { chromeUserDataDir?, hostDir? }
// returns { id, profile, path, candidates[], manifestId, drift, chromeDir }
function detectExtensionId(opts = {}) {
  const chromeDir = opts.chromeUserDataDir || chromeUserDataDir();
  const profiles = listProfiles(chromeDir);
  const candidates = [];
  for (const profile of profiles) {
    candidates.push(...scanProfile(chromeDir, profile));
  }

  // Prefer an active (LevelDB-live) candidate; otherwise the first found.
  let chosen = null;
  if (candidates.length > 0) {
    const active = candidates.filter(c => c.active);
    chosen = active[0] || candidates[0];
  }

  const manifestId = opts.manifestId !== undefined ? opts.manifestId : manifestAllowedId(opts.hostDir);
  const drift = !!(manifestId && chosen && manifestId !== chosen.id);

  return {
    id: chosen ? chosen.id : null,
    profile: chosen ? chosen.profile : null,
    path: chosen ? chosen.path : null,
    candidates,
    manifestId,
    drift,
    chromeDir
  };
}

module.exports = {
  detectExtensionId,
  chromeUserDataDir,
  listProfiles,
  scanProfile,
  manifestAllowedId,
  HOST_NAME,
  TARGET_NAME
};
