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

  it('RC65: fetchLocalIps distinguishes down host from old host build', () => {
    const src = readSrc('options.js');
    // A reachable host running a pre-ips /health build must NOT be labeled
    // "Host unreachable" — the old shape collapsed fetch-throw, non-200,
    // and missing body.ips into one empty-array outcome and the hint blamed
    // the host being down. The result object must carry reachable/reported
    // so the hint can say WHY no LAN addresses are offered.
    assert.match(src, /reachable:\s*false/,
      'fetchLocalIps must report unreachable explicitly');
    assert.match(src, /reported/,
      'fetchLocalIps must report whether /health carried an ips array');
    assert.match(src, /function apiDocAddressHint/,
      'hint text must come from a dedicated helper so outcomes stay distinct');
  });

  it('RC65: address hint covers all four outcomes honestly', () => {
    const src = readSrc('options.js');
    const start = src.indexOf('function apiDocAddressHint');
    assert.ok(start !== -1, 'apiDocAddressHint not found');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    assert.match(body, /pick the one your caller can reach/,
      'ips detected → selection guidance');
    assert.match(body, /Host unreachable/,
      'unreachable → start-the-host guidance');
    assert.match(body, /older build/,
      'reachable but no ips field → old-build guidance');
    assert.match(body, /scrapewright restart/,
      'old-build guidance must name the fix command');
    assert.match(body, /no LAN IPv4 addresses/,
      'reachable, ips reported, but empty → honest empty-state guidance');
  });

  it('RC65: both fetchLocalIps call sites destructure the result object', () => {
    const src = readSrc('options.js');
    const uses = src.match(/await fetchLocalIps\(port\)/g) || [];
    assert.ok(uses.length >= 2, 'expected modal + markdown call sites');
    assert.match(src, /const\s+ips\s*=\s*ipInfo\.ips/,
      'modal site reads ipInfo.ips');
    assert.match(src, /const\s*\{\s*ips\s*\}\s*=\s*await fetchLocalIps\(port\)/,
      'markdown site destructures ips from the result object');
  });
});
