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

  it('A7: appendLog caps the log at 500 entries with a trimmed disclosure line', () => {
    const start = SRC.indexOf('function appendLog(');
    assert.ok(start !== -1, 'appendLog exists');
    let i = SRC.indexOf('{', start), depth = 0, end = start;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const body = SRC.slice(start, end);
    assert.ok(/LOG_MAX_ENTRIES\s*=\s*500/.test(body), 'cap constant 500');
    assert.ok(body.includes('log-trimmed'), 'disclosure line class');
    assert.ok(/earlier lines trimmed/.test(body), 'disclosure copy');
    assert.ok(/removeChild\(logEl\.firstChild\)|logEl\.removeChild/.test(body) || /firstElementChild/.test(body), 'oldest nodes are dropped');
  });

  it('A8: session crash surfaces a toast, not only a log line', () => {
    const idx = SRC.indexOf("'Session crashed: '");
    assert.ok(idx !== -1, 'crash log line exists');
    const region = SRC.slice(idx, idx + 600);
    assert.ok(/showToast\(/.test(region), 'crash path calls showToast');
    assert.ok(/'error'/.test(region), 'toast typed error');
  });

  it('A20: non-presenting stop reasons map to friendly copy', () => {
    const start = SRC.indexOf('function friendlyStopReason(');
    assert.ok(start !== -1, 'friendlyStopReason exists');
    let i = SRC.indexOf('{', start), depth = 0, end = start;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const body = SRC.slice(start, end);
    for (const pair of [['maxTurns', 'turn budget exhausted'], ['wallClock', 'time budget exhausted'], ['tokenCap', 'token budget exhausted'], ['aborted', 'you stopped it'], ['user', 'you stopped it']]) {
      assert.ok(body.includes("'" + pair[0] + "'"), 'maps ' + pair[0]);
      assert.ok(body.includes(pair[1]), 'copy for ' + pair[0]);
    }
    assert.ok(SRC.includes('friendlyStopReason(') && SRC.indexOf('function friendlyStopReason(') !== SRC.indexOf('friendlyStopReason('), 'mapping is used at the stop site');
  });

  it('A12: failure path hides the pages viewer instead of rendering stale pages', () => {
    // Locate the failure branch of presentTestOutcome: after the string
    // "'Error: ' + out.report.error.message" the viewer must be hidden, and
    // the failure branch must NOT contain renderPagesViewer(wizardState...).
    const idx = SRC.indexOf("'Error: ' + out.report.error.message");
    assert.ok(idx !== -1, 'failure branch found');
    const region = SRC.slice(idx, SRC.indexOf("updatePhaseUI('failure')", idx));
    assert.ok(!/renderPagesViewer\(wizardState\.testResult\)/.test(region), 'failure branch does not render wizardState.testResult');
    assert.ok(/renderPagesViewer\(null\)/.test(region), 'failure branch explicitly hides the viewer');
  });
});
