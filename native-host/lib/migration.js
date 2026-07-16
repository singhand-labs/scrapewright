'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const MANIFEST_NAME = 'com.scrapewright.host';

function manifestPath(homeDir, platform) {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', MANIFEST_NAME + '.json');
  }
  if (platform === 'win32') {
    return null; // Windows uses registry, not a file
  }
  // linux & other unix
  return path.join(homeDir, '.config', 'google-chrome', 'NativeMessagingHosts', MANIFEST_NAME + '.json');
}

function registryKey() {
  return 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + MANIFEST_NAME;
}

function findLegacyArtifacts({ homeDir, platform } = {}) {
  const home = homeDir || os.homedir();
  const plat = platform || process.platform;
  const files = [];
  const registryKeys = [];

  if (plat === 'win32') {
    // Probe registry for the key's existence
    const r = spawnSync('reg', ['query', registryKey()], { stdio: 'pipe', encoding: 'utf8' });
    if (r.status === 0) registryKeys.push(registryKey());
  } else {
    const p = manifestPath(home, plat);
    if (p && fs.existsSync(p)) files.push(p);
  }
  return { files, registryKeys };
}

function removeLegacyArtifacts(opts = {}) {
  const { files, registryKeys } = findLegacyArtifacts(opts);
  const removedFiles = [];
  const removedKeys = [];
  for (const f of files) {
    try {
      fs.rmSync(f);
      removedFiles.push(f);
    } catch (e) {
      // best-effort; surfaced via return value
    }
  }
  for (const k of registryKeys) {
    const r = spawnSync('reg', ['delete', k, '/f'], { stdio: 'pipe', encoding: 'utf8' });
    if (r.status === 0) removedKeys.push(k);
  }
  return { removedFiles, removedKeys };
}

module.exports = { findLegacyArtifacts, removeLegacyArtifacts, manifestPath, registryKey, MANIFEST_NAME };
