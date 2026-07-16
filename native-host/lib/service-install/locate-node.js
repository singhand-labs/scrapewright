'use strict';

const path = require('node:path');

// Resolve absolute path to the node binary that should run host.js.
// We trust process.execPath — Node sets it to the absolute path of the
// running binary, and the CLI is itself launched via node. Service files
// embed this path so they don't rely on PATH (which Chrome/osascript/
// systemd-user all set differently and often minimally).
function locateNode() {
  return process.execPath;
}

module.exports = { locateNode };
