'use strict';

function currentPlatform() {
  return process.platform;
}

function forCurrentPlatform() {
  if (process.platform === 'linux') return require('./linux');
  if (process.platform === 'darwin') return require('./macos');
  if (process.platform === 'win32') return require('./windows');
  throw new Error('Unsupported platform for service install: ' + process.platform + '. Use \'scrapewright run\' for foreground execution.');
}

function install(opts) { return forCurrentPlatform().install(opts); }
function uninstall(opts) { return forCurrentPlatform().uninstall(opts); }
function start() { return forCurrentPlatform().start(); }
function stop() { return forCurrentPlatform().stop(); }
function restart() { return forCurrentPlatform().restart(); }
function isInstalled(opts) { return forCurrentPlatform().isInstalled(opts); }

module.exports = { install, uninstall, start, stop, restart, isInstalled, currentPlatform };
