const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectExtensionId } = require('../lib/detect-id');

const TARGET_NAME = 'Scrapewright';

// Each test gets its own isolated chrome user-data dir (detectExtensionId scans
// ALL profiles, so a shared dir would let fixtures leak across tests).
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-detect-'));
}

// Build <dir>/<profile>/Secure Preferences with the given extensions.
// exts: [{ id, location, path, name }]  (name omitted => no manifest.json written)
function setupProfile(dir, profile, exts) {
  const profDir = path.join(dir, profile);
  fs.mkdirSync(profDir, { recursive: true });
  const settings = {};
  for (const e of exts) {
    if (e.name) {
      fs.mkdirSync(e.path, { recursive: true });
      fs.writeFileSync(path.join(e.path, 'manifest.json'),
        JSON.stringify({ name: e.name, manifest_version: 3 }));
    }
    settings[e.id] = { location: e.location, path: e.path, manifest: null };
  }
  fs.writeFileSync(path.join(profDir, 'Secure Preferences'),
    JSON.stringify({ extensions: { settings } }));
}

describe('detect-id', () => {
  it('detects a single unpacked Scrapewright extension', () => {
    const dir = freshDir();
    const id = 'a'.repeat(32);
    const extPath = path.join(dir, 'ext');
    setupProfile(dir, 'Default', [{ id, location: 4, path: extPath, name: TARGET_NAME }]);
    const r = detectExtensionId({ chromeUserDataDir: dir });
    assert.equal(r.id, id);
    assert.equal(r.profile, 'Default');
    assert.equal(r.path, extPath);
  });

  it('ignores other unpacked extensions and packed extensions', () => {
    const dir = freshDir();
    const ccPath = path.join(dir, 'cc');
    const otherPath = path.join(dir, 'other');
    const packedPath = path.join(dir, 'packed');
    setupProfile(dir, 'Default', [
      { id: 'b'.repeat(32), location: 4, path: ccPath, name: TARGET_NAME },
      { id: 'c'.repeat(32), location: 4, path: otherPath, name: 'Some Other Ext' },
      { id: 'd'.repeat(32), location: 1, path: packedPath, name: TARGET_NAME }, // packed — skipped even if name matches
    ]);
    const r = detectExtensionId({ chromeUserDataDir: dir });
    assert.equal(r.id, 'b'.repeat(32));
    assert.equal(r.candidates.length, 1);
  });

  it('reports drift when manifest id differs from loaded id', () => {
    const dir = freshDir();
    const id = 'e'.repeat(32);
    setupProfile(dir, 'Default', [{ id, location: 4, path: path.join(dir, 'ext'), name: TARGET_NAME }]);
    const drifted = detectExtensionId({ chromeUserDataDir: dir, manifestId: 'z'.repeat(32) });
    assert.equal(drifted.id, id);
    assert.equal(drifted.drift, true);
    const matched = detectExtensionId({ chromeUserDataDir: dir, manifestId: id });
    assert.equal(matched.drift, false);
  });

  it('marks a candidate active when LevelDB storage contains nativeState', () => {
    const dir = freshDir();
    const id = 'f'.repeat(32);
    setupProfile(dir, 'Default', [{ id, location: 4, path: path.join(dir, 'ext'), name: TARGET_NAME }]);
    const lesDir = path.join(dir, 'Default', 'Local Extension Settings', id);
    fs.mkdirSync(lesDir, { recursive: true });
    fs.writeFileSync(path.join(lesDir, '000003.log'), 'garbage...nativeState...garbage');
    const r = detectExtensionId({ chromeUserDataDir: dir });
    const c = r.candidates.find(x => x.id === id);
    assert.equal(c.active, true);
  });

  it('returns null id when no Scrapewright is loaded', () => {
    const dir = freshDir();
    setupProfile(dir, 'Default',
      [{ id: 'x'.repeat(32), location: 4, path: path.join(dir, 'z'), name: 'Not Scrapewright' }]);
    const r = detectExtensionId({ chromeUserDataDir: dir });
    assert.equal(r.id, null);
    assert.equal(r.candidates.length, 0);
  });
});
