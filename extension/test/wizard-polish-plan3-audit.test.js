// extension/test/wizard-polish-plan3-audit.test.js
//
// Source-text audit for audit-remediation Plan 3 (wizard polish).
// wizard.js cannot load in Node (chrome.* APIs) — pin exact code shape.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'wizard.css'), 'utf8');

describe('Plan 3: wizard polish', () => {
  it('A4: btnRetryTest wraps testScript in showLoading/hideLoading (try/finally)', () => {
    const start = SRC.indexOf("getElementById('btnRetryTest').addEventListener");
    assert.ok(start !== -1, 'btnRetryTest handler exists');
    const region = SRC.slice(start, SRC.indexOf('});', start) + 3);
    assert.ok(/showLoading\('Running test/.test(region), 'shows the loading overlay');
    assert.ok(region.includes('await testScript()'), 'still awaits testScript');
    assert.ok(/finally\s*\{\s*hideLoading\(\)/.test(region), 'hides the overlay on success AND failure');
  });
});
