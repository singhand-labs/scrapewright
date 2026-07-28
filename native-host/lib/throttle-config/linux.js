'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { FLAGS, MARKER, hasFlagsInExec, addFlagsToExec, stripFlagsFromExec } = require('./flags');

// Locate the user-level Chrome .desktop file. We modify only user-level
// (~/.local/share/applications/), never system-level (/usr/share/applications/).
// If no user-level file exists yet, we copy from the system source so that
// our edits take precedence via XDG's user-overrides-system rule.
function findDesktopPaths() {
  const userDir = path.join(os.homedir(), '.local', 'share', 'applications');
  const userCandidates = ['google-chrome.desktop', 'com.google.Chrome.desktop'].map(f => path.join(userDir, f));
  for (const p of userCandidates) {
    if (fs.existsSync(p)) return { target: p, source: null };
  }
  const sysDir = '/usr/share/applications';
  const sysCandidates = ['google-chrome.desktop', 'com.google.Chrome.desktop'].map(f => path.join(sysDir, f));
  for (const p of sysCandidates) {
    if (fs.existsSync(p)) return { target: path.join(userDir, path.basename(p)), source: p };
  }
  return null;
}

function backupPath(target) {
  return target + '.scrapewright-backup';
}

function ensureUserCopy({ target, source }) {
  if (fs.existsSync(target)) return;
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  if (source) fs.copyFileSync(source, target);
  else throw new Error('no Chrome .desktop file found to modify');
}

function isModified(target) {
  if (!target || !fs.existsSync(target)) return false;
  const backup = backupPath(target);
  if (!fs.existsSync(backup)) return false;
  const content = fs.readFileSync(target, 'utf8');
  return content.includes(MARKER);
}

function enable() {
  const paths = findDesktopPaths();
  if (!paths) {
    return { ok: false, reason: 'no Chrome .desktop file found in /usr/share/applications or ~/.local/share/applications' };
  }
  ensureUserCopy(paths);
  const target = paths.target;
  if (isModified(target)) {
    return { ok: true, already: true, target };
  }
  const original = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(backupPath(target), original);
  const lines = original.split('\n');
  const out = [];
  let markerWritten = false;
  for (const line of lines) {
    if (line.startsWith('Exec=')) {
      out.push(addFlagsToExec(line));
      if (!markerWritten) {
        out.push(MARKER + ' — backup at ' + path.basename(backupPath(target)));
        markerWritten = true;
      }
    } else {
      out.push(line);
    }
  }
  if (!markerWritten) {
    return { ok: false, reason: 'no Exec= line in ' + target };
  }
  fs.writeFileSync(target, out.join('\n'));
  return { ok: true, target, flags: FLAGS };
}

function disable() {
  const paths = findDesktopPaths();
  if (!paths || !paths.target) {
    return { ok: false, reason: 'no Chrome .desktop file found' };
  }
  const target = paths.target;
  const backup = backupPath(target);
  if (!fs.existsSync(backup)) {
    if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(MARKER)) {
      return { ok: true, already: true, target };
    }
    return { ok: false, reason: 'no backup found — cannot restore; remove flags manually from ' + target };
  }
  fs.copyFileSync(backup, target);
  fs.unlinkSync(backup);
  return { ok: true, target };
}

function status() {
  const paths = findDesktopPaths();
  if (!paths) return { installed: false, reason: 'no Chrome .desktop file found' };
  let target = paths.target;
  if (!fs.existsSync(target) && paths.source) {
    target = paths.source;
  }
  const backup = backupPath(paths.target);
  const content = fs.existsSync(paths.target) ? fs.readFileSync(paths.target, 'utf8') : '';
  const execLines = content.split('\n').filter(l => l.startsWith('Exec='));
  const allFlagged = execLines.length > 0 && execLines.every(hasFlagsInExec);
  return {
    installed: allFlagged,
    target: paths.target,
    source: paths.source,
    hasBackup: fs.existsSync(backup),
    execLines,
    flagsPresent: FLAGS.filter(f => content.includes(f))
  };
}

module.exports = { enable, disable, status, _findDesktopPaths: findDesktopPaths };
