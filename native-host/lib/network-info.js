// Local IPv4 enumeration for the /health endpoint. The options-page API doc
// and the generated markdown use this list so curl examples can target the
// host from other machines on the LAN (localhost-only examples force manual
// IP substitution on every copy).
//
// Pure function over the os.networkInterfaces() shape so tests can feed
// deterministic fixtures.

function collectLocalIpv4(interfaces) {
  if (!interfaces || typeof interfaces !== 'object') return [];
  const seen = new Set();
  const out = [];
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!e || e.internal) continue;
      if (e.family !== 'IPv4' && e.family !== 4) continue;
      if (typeof e.address !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(e.address)) continue;
      if (seen.has(e.address)) continue; // bridges/VPN often mirror an address
      seen.add(e.address);
      out.push(e.address);
    }
  }
  return out;
}

module.exports = { collectLocalIpv4 };
