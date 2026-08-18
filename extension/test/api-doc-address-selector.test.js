// API doc modal address + platform selectors. The curl examples used to be
// hardcoded to localhost — fine locally, useless for the primary remote
// calling pattern (agents / other machines on the LAN). The options page now
// reads the host's non-internal IPv4s from /health, lets the user pick the
// address + shell dialect, and re-renders examples for direct copy-paste.
//
// Source-text audit: options.js is a plain script (no exports) — assert on
// wiring, not behavior.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('options.js API doc address selector', () => {
  it('fetches local IPs from the host /health endpoint', () => {
    const src = readSrc('options.js');
    assert.match(src, /fetch\(`http:\/\/localhost:\$\{port\}\/health`/);
    assert.match(src, /\.ips/, '/health response ips array is read');
  });

  it('offers localhost plus every detected IP in an address select', () => {
    const src = readSrc('options.js');
    assert.match(src, /apiDocAddress/,
      'address <select> with a stable id');
    assert.match(src, /localhost/,
      'localhost remains the default choice');
  });

  it('re-renders examples when the address or platform selection changes', () => {
    const src = readSrc('options.js');
    assert.match(src, /renderApiDocExamples/);
    assert.match(src, /addEventListener\('change'/,
      'change listeners drive the re-render');
  });

  it('builds curl examples through buildCurlExamples for both dialects', () => {
    const src = readSrc('options.js');
    assert.match(src, /buildCurlExamples\(\{/);
    assert.match(src, /platform === 'windows'/,
      'platform toggle selects the windows dialect');
  });

  it('passes detected IPs into the downloaded markdown', () => {
    const src = readSrc('options.js');
    assert.match(src, /generateServiceMarkdown\([^)]*ips/,
      'download doc must list the machine LAN addresses');
  });
});
