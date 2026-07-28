'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { FLAGS, MARKER } = require('./flags');

// macOS: modifying Google Chrome.app/Contents/Info.plist would break the
// code signature, so we don't touch the app bundle. Instead we create a
// small wrapper AppleScript app at ~/Applications/Chrome-Scrapewright.app
// that launches Chrome with the throttle-disable flags. User pins this to
// their dock / uses it as their daily driver while scraping.
//
// This is opt-in: the user must explicitly use the wrapper. We don't
// override the main Chrome launcher.

function wrapperPath() {
  return path.join(os.homedir(), 'Applications', 'Chrome-Scrapewright.app');
}

function scriptPath() {
  return path.join(wrapperPath(), 'Contents', 'Resources', 'Scripts', 'main.scpt');
}

function infoPlistPath() {
  return path.join(wrapperPath(), 'Contents', 'Info.plist');
}

function enable() {
  const wrapper = wrapperPath();
  if (fs.existsSync(wrapper)) {
    return { ok: true, already: true, target: wrapper };
  }
  const dirs = [
    path.join(wrapper, 'Contents'),
    path.join(wrapper, 'Contents', 'Resources'),
    path.join(wrapper, 'Contents', 'Resources', 'Scripts')
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });

  // AppleScript source — saved as plain text; macOS compiles on first run.
  // The CFBundleName/CFBundleExecutable below let the .app show up in
  // Finder/Launchpad. We use osascript to compile to main.scpt.
  const applescript = [
    'do shell script "/Applications/Google\\\\ Chrome.app/Contents/MacOS/Google\\\\ Chrome ' + FLAGS.join(' ') + ' > /dev/null 2>&1 &"'
  ].join('\n');

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleName</key><string>Chrome (Scrapewright)</string>',
    '  <key>CFBundleExecutable</key><string>main.scpt</string>',
    '  <key>CFBundlePackageType</key><string>APPL</string>',
    '  <key>CFBundleSignature</key><string>scrp</string>',
    '  <key>LSMinimumSystemVersion</key><string>10.6</string>',
    '  <key>NSUIElement</key><true/>',
    '</dict>',
    '</plist>'
  ].join('\n');

  fs.writeFileSync(infoPlistPath(), plist);
  // AppleScript applets expect the executable at Contents/MacOS/<name>; we
  // sidestep by storing the script in Resources/Scripts/main.scpt and
  // setting CFBundleExecutable to that path. Pre-compile if osacompile is
  // available (it is on stock macOS), else fall back to source.
  const sourcePath = path.join(wrapper, 'Contents', 'Resources', 'Scripts', 'main.applescript');
  fs.writeFileSync(sourcePath, applescript);
  try {
    require('child_process').spawnSync('osacompile', ['-o', scriptPath(), sourcePath], { stdio: 'ignore' });
  } catch (e) {
    // osacompile missing — user can compile manually.
  }
  return { ok: true, target: wrapper, flags: FLAGS };
}

function disable() {
  const wrapper = wrapperPath();
  if (!fs.existsSync(wrapper)) {
    return { ok: true, already: true };
  }
  fs.rmSync(wrapper, { recursive: true, force: true });
  return { ok: true, target: wrapper };
}

function status() {
  const wrapper = wrapperPath();
  const exists = fs.existsSync(wrapper);
  return {
    installed: exists,
    target: wrapper,
    note: exists
      ? 'wrapper installed — launch Chrome via this app while scraping'
      : 'not installed — run `scrapewright throttle on` to create wrapper at ~/Applications/Chrome-Scrapewright.app'
  };
}

module.exports = { enable, disable, status };
