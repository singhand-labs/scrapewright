// Local IP enumeration for the /health endpoint and the options-page API
// doc. Users copy curl examples to call the host from OTHER machines on the
// LAN — localhost-only examples force manual IP substitution every time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { collectLocalIpv4 } = require('../lib/network-info');

describe('collectLocalIpv4', () => {
  it('returns non-internal IPv4 addresses from os.networkInterfaces() shape', () => {
    const ips = collectLocalIpv4({
      lo: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true }
      ],
      eth0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false }
      ]
    });
    assert.deepEqual(ips, ['192.168.1.5']);
  });

  it('dedupes identical addresses across interfaces (common with bridges/VPN)', () => {
    const ips = collectLocalIpv4({
      eth0: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
      br0: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
      wlan0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }]
    });
    assert.deepEqual(ips, ['10.0.0.7', '172.17.0.1']);
  });

  it('returns [] when there are no non-internal IPv4 addresses', () => {
    assert.deepEqual(collectLocalIpv4({}), []);
    assert.deepEqual(collectLocalIpv4(null), []);
    assert.deepEqual(collectLocalIpv4({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
    }), []);
  });

  it('against the real os.networkInterfaces() returns an array of IPv4 strings', () => {
    const ips = collectLocalIpv4(os.networkInterfaces());
    assert.ok(Array.isArray(ips));
    for (const ip of ips) {
      assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, 'IPv4 dotted-quad only: ' + ip);
    }
  });
});
