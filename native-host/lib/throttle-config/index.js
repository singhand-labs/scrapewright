'use strict';

function forCurrentPlatform() {
  if (process.platform === 'linux') return require('./linux');
  if (process.platform === 'darwin') return require('./macos');
  if (process.platform === 'win32') return require('./windows');
  throw new Error('Unsupported platform for throttle config: ' + process.platform);
}

function enable() { return forCurrentPlatform().enable(); }
function disable() { return forCurrentPlatform().disable(); }
function status() { return forCurrentPlatform().status(); }

module.exports = { enable, disable, status };
