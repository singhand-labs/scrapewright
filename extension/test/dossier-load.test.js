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

// Eighty-seventh-round meta-audit: the dossier was STILL absent from every
// production request (all six sections missing from the full-fidelity
// request-body logs) despite the tag above — because research-session.js
// resolves `const Dossier = resolveLib(...)` at IIFE LOAD TIME, and the
// evidence-dossier.js <script> sat AFTER research-session.js in wizard.html.
// Node tests resolve via require (order-independent) and stayed green while
// production silently ran dossier-less for every live session since.
test('wizard.html loads evidence-dossier BEFORE research-session (load-order dependency: the engine resolves the dossier lib at IIFE load time)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
  const iDossier = html.indexOf('lib/evidence-dossier.js');
  const iEngine = html.indexOf('lib/research-session.js');
  assert.ok(iDossier !== -1 && iEngine !== -1, 'both scripts loaded');
  assert.ok(iDossier < iEngine,
    'evidence-dossier.js must precede research-session.js — a later position leaves the engine\'s module-level Dossier const null for the page lifetime (87th-round live gap)');
});

test('research-session warns ONCE when the dossier lib is unresolved (the silent-null class must never hide again)', () => {
  const rs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
  const m = rs.match(/if \(!Dossier\)[\s\S]{0,220}console\.warn/);
  assert.ok(m, 'a !Dossier branch warns on the console');
});
