// 2026-09-18 15:22 log audit: EVIDENCE DOSSIER appeared 0× in production
// despite probe.skeleton working — evidence-dossier.js was never added to
// wizard.html, so resolveLib's global fallback found nothing (node tests
// passed via require — the RC30 load-as-global class again).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
test('wizard.html loads every lib the engine resolveLibs as a global', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
  const rs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
  const libs = [...rs.matchAll(/resolveLib\('([^']+)',\s*'([A-Za-z]+)'\)/g)];
  assert.ok(libs.length >= 5, 'found resolveLib calls');
  for (const [, file, globalName] of libs) {
    const base = path.basename(file);
    assert.ok(html.includes(`lib/${base}.js`), `${base} must be <script>-loaded in wizard.html (resolveLib global ${globalName} has no browser source otherwise)`);
  }
});
