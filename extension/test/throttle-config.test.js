// Unit tests for the throttle-config Linux module.
//
// These tests run against TEMP COPIES of .desktop files — never against the
// user's real ~/.local/share/applications/google-chrome.desktop. We mock
// os.homedir() to point at a temp directory so the module's path logic
// resolves into our sandbox.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const SAMPLE_DESKTOP = `[Desktop Entry]
Version=1.0
Name=Google Chrome
Exec=/usr/bin/google-chrome-stable %U
StartupNotify=true
Terminal=false
Icon=google-chrome
Type=Application
Categories=Network;WebBrowser;
Actions=new-window;new-private-window;

[Desktop Action new-window]
Name=New Window
Exec=/usr/bin/google-chrome-stable

[Desktop Action new-private-window]
Name=New Incognito Window
Exec=/usr/bin/google-chrome-stable --incognito
`;

let tempHome = null;
let origHomedir = null;

function loadLinuxFresh() {
  // Bump module cache: the linux.js module captures os.homedir at call time,
  // so a fresh require isn't strictly necessary, but we do it anyway to keep
  // tests independent of any cached state.
  const modPath = require.resolve('../../native-host/lib/throttle-config/linux.js');
  delete require.cache[modPath];
  return require(modPath);
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-throttle-'));
  // Make the temp home look like a Linux user dir: ~/.local/share/applications
  const appsDir = path.join(tempHome, '.local', 'share', 'applications');
  fs.mkdirSync(appsDir, { recursive: true });
  // Also fake /usr/share/applications with a system source file
  // (we cannot write to /usr/share, so we monkey-patch the candidate list)
  origHomedir = os.homedir;
  os.homedir = () => tempHome;
});

afterEach(() => {
  if (origHomedir) os.homedir = origHomedir;
  if (tempHome) {
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (e) {}
  }
});

function seedUserDesktop(content) {
  const target = path.join(tempHome, '.local', 'share', 'applications', 'google-chrome.desktop');
  fs.writeFileSync(target, content);
  return target;
}

describe('throttle-config/linux — enable', () => {
  it('appends flags to every Exec= line in the user-level file', () => {
    const target = seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    const r = linux.enable();
    assert.equal(r.ok, true);
    assert.equal(r.already, undefined, 'first call must report a change, not "already"');
    const after = fs.readFileSync(target, 'utf8');
    const execLines = after.split('\n').filter(l => l.startsWith('Exec='));
    assert.equal(execLines.length, 3);
    for (const line of execLines) {
      assert.ok(line.includes('--disable-background-timer-throttling'), line);
      assert.ok(line.includes('--disable-renderer-backgrounding'), line);
      assert.ok(line.includes('--disable-features=CalculateNativeWinOcclusion'), line);
    }
  });

  it('writes a marker comment + backup file on first enable', () => {
    const target = seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    linux.enable();
    const after = fs.readFileSync(target, 'utf8');
    assert.ok(after.includes('# scrapewright-throttle-flags'), 'marker must be present');
    assert.ok(fs.existsSync(target + '.scrapewright-backup'), 'backup must exist');
    const backup = fs.readFileSync(target + '.scrapewright-backup', 'utf8');
    assert.equal(backup, SAMPLE_DESKTOP, 'backup preserves original byte-for-byte');
  });

  it('is idempotent — second enable() returns ok+already without re-modifying', () => {
    seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    const r1 = linux.enable();
    assert.equal(r1.ok, true);
    assert.equal(r1.already, undefined);
    const r2 = linux.enable();
    assert.equal(r2.ok, true);
    assert.equal(r2.already, true, 'second call must report already:true');
  });

  it('preserves the original %U placeholder and other tokens', () => {
    const target = seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    linux.enable();
    const after = fs.readFileSync(target, 'utf8');
    const main = after.split('\n').find(l => l.startsWith('Exec=') && l.includes('%U'));
    assert.ok(main, 'main Exec with %U must survive');
    assert.match(main, /--disable-features=CalculateNativeWinOcclusion %U$/);
  });
});

describe('throttle-config/linux — disable', () => {
  it('restores the original file from backup and removes the backup', () => {
    const target = seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    linux.enable();
    const r = linux.disable();
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), SAMPLE_DESKTOP);
    assert.ok(!fs.existsSync(target + '.scrapewright-backup'), 'backup removed');
  });

  it('is idempotent — second disable() reports already:true', () => {
    seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    linux.enable();
    const r1 = linux.disable();
    assert.equal(r1.ok, true);
    assert.equal(r1.already, undefined);
    const r2 = linux.disable();
    assert.equal(r2.ok, true);
    assert.equal(r2.already, true);
  });

  it('fails cleanly when there is no backup and no marker (never enabled)', () => {
    seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    const r = linux.disable();
    assert.equal(r.ok, true);
    assert.equal(r.already, true, 'unmodified file reports already rather than failing');
  });
});

describe('throttle-config/linux — status', () => {
  it('reports installed:false on a stock file', () => {
    seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    const s = linux.status();
    assert.equal(s.installed, false);
    assert.equal(s.hasBackup, false);
    assert.deepEqual(s.flagsPresent, []);
  });

  it('reports installed:true after enable()', () => {
    seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    linux.enable();
    const s = linux.status();
    assert.equal(s.installed, true);
    assert.equal(s.hasBackup, true);
    assert.equal(s.flagsPresent.length, 4);
  });

  it('reports installed:false after disable()', () => {
    seedUserDesktop(SAMPLE_DESKTOP);
    const linux = loadLinuxFresh();
    linux.enable();
    linux.disable();
    const s = linux.status();
    assert.equal(s.installed, false);
    assert.equal(s.hasBackup, false);
  });
});

describe('throttle-config/flags — helper purity', () => {
  const { addFlagsToExec, stripFlagsFromExec, hasFlagsInExec } = require('../../native-host/lib/throttle-config/flags');

  it('addFlagsToExec is a no-op when all flags already present', () => {
    const line = 'Exec=/usr/bin/google-chrome-stable --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion %U';
    const out = addFlagsToExec(line);
    assert.equal(out, line, 'must not duplicate when all four flags already present');
  });

  it('addFlagsToExec adds all four flags when only some are present', () => {
    const line = 'Exec=/usr/bin/google-chrome-stable --disable-renderer-backgrounding %U';
    const out = addFlagsToExec(line);
    assert.ok(out.includes('--disable-background-timer-throttling'), 'must add missing flag');
    assert.ok(out.includes('--disable-features=CalculateNativeWinOcclusion'), 'must add missing flag');
    // The already-present flag should still appear exactly once (the new flags
    // are inserted right after the binary path).
    const count = (out.match(/--disable-renderer-backgrounding/g) || []).length;
    assert.equal(count, 1, 'must not duplicate already-present flag');
  });

  it('stripFlagsFromExec removes only the known flags', () => {
    const line = 'Exec=/usr/bin/google-chrome-stable --foo=bar --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion %U';
    const out = stripFlagsFromExec(line);
    assert.equal(out, 'Exec=/usr/bin/google-chrome-stable --foo=bar %U');
  });

  it('hasFlagsInExec requires ALL four flags', () => {
    const partial = 'Exec=/usr/bin/google-chrome-stable --disable-renderer-backgrounding';
    const full = 'Exec=/usr/bin/google-chrome-stable --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion';
    assert.equal(hasFlagsInExec(partial), false);
    assert.equal(hasFlagsInExec(full), true);
  });
});
