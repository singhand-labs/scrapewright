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

  it('A11/A14: .toast.warn and .btn-secondary CSS rules exist', () => {
    assert.ok(/\.toast\.warn\s*\{[^}]*border-left-color:\s*#fbbf24/.test(CSS), '.toast.warn amber rule');
    assert.ok(/\.btn-secondary\s*\{/.test(CSS), '.btn-secondary rule exists');
    // A14 sanity: the class is actually used in HTML (session feedback button)
    assert.ok(HTML.includes('btn-secondary'), 'btn-secondary used in HTML');
  });

  it('A9: dead <pre id="currentScript"> removed from HTML and CSS', () => {
    assert.ok(!HTML.includes('id="currentScript"'), 'element gone from HTML');
    assert.ok(!/#currentScript\s*\{/.test(CSS), 'CSS rule gone');
    assert.ok(!SRC.includes("getElementById('currentScript')"), 'no JS reads it (verified none existed)');
  });

  it('A15: pages-viewer uses the .hidden class, not the hidden attribute', () => {
    assert.ok(!/id="pages-viewer"[^>]*\shidden[>\s]/.test(HTML), 'no bare hidden attribute on pages-viewer');
    assert.ok(/class="pages-viewer hidden"/.test(HTML), 'starts hidden via class');
    const start = SRC.indexOf('function renderPagesViewer(');
    assert.ok(start !== -1);
    const region = SRC.slice(start, start + 900);
    assert.ok(!/\.hidden\s*=/.test(region), 'renderPagesViewer no longer assigns the hidden property');
    assert.ok(/classList\.(add|remove)\('hidden'\)/.test(region), 'toggles the .hidden class');
    assert.ok(!/pages-viewer\[hidden\]/.test(CSS), '[hidden] CSS fallback dropped');
  });

  it('A16: btnDeployAnyway no longer calls goToPhase(5) redundantly', () => {
    const start = SRC.indexOf("getElementById('btnDeployAnyway').addEventListener");
    assert.ok(start !== -1);
    const region = SRC.slice(start, SRC.indexOf('});', start) + 3);
    assert.ok(!region.includes('goToPhase(5)'), 'redundant phase call removed');
    assert.ok(region.includes('confirmDeploy('), 'still deploys');
  });

  it('A10: session annotation panel says Submit Annotations; step-card keeps Finish Annotation', () => {
    const btnLine = HTML.split('\n').find((l) => l.includes('id="btnAnnotationFinish"'));
    assert.ok(btnLine, 'btnAnnotationFinish in HTML');
    assert.ok(/Submit Annotations/.test(btnLine), 'session panel relabeled');
    assert.ok(SRC.includes('btn-step-complete-annotation" data-index'), 'step-card button still rendered');
    assert.ok(/btn-step-complete-annotation[^<]*Finish Annotation/.test(SRC), 'step-card keeps its label');
    // Session-flow toast references the NEW label only.
    assert.ok(!/press Finish Annotation/.test(SRC), 'session-flow toast no longer says "press Finish Annotation"');
    assert.ok(/press Submit Annotations/.test(SRC), 'session-flow toast uses the new label');
  });

  it('13a/13b: message style unified + Research button tooltip', () => {
    assert.ok(SRC.includes("'Session is already starting — please wait.'"), 'starting message uses the em-dash style');
    assert.ok(!SRC.includes('Session is already starting…'), 'ellipsis variant gone');
    assert.ok(/id="btnPhase1Research"[^>]*title="[^"]*research session/i.test(HTML), 'Research button carries a tooltip mentioning the research session');
  });

  it('parkedMs: spend line appends paused time when parkedMs > 0', () => {
    const start = SRC.indexOf('function updateSessionSpendLine(');
    assert.ok(start !== -1);
    let i = SRC.indexOf('{', start), depth = 0, end = start;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const body = SRC.slice(start, end);
    assert.ok(body.includes("sp.turns + '/' + wizardMaxTurns"), 'existing pinned shape survives');
    assert.ok(/parkedMs/.test(body), 'reads parkedMs');
    assert.ok(/excl\./.test(body), 'discloses excluded paused time');
    assert.ok(/updateSessionSpendLine\(wizardSession\.state\(\),\s*report\s*&&\s*report\.spend\s*&&\s*report\.spend\.parkedMs\)/.test(SRC), 'post-run call passes report.spend.parkedMs');
  });
});
