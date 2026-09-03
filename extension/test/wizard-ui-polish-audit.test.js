// extension/test/wizard-ui-polish-audit.test.js
//
// Source-text audit for the wizard UI polish round (stage renumbering, live
// session badge, stepper, phase-1 guard, empty states). wizard.js cannot
// load in Node (chrome.* APIs) — pin exact code shape, same pattern as
// wizard-polish-plan3-audit.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'wizard.css'), 'utf8');

describe('UI polish: stage renumbering', () => {
  it('PHASE_LABELS maps all five phase ids to the new display headings', () => {
    assert.ok(/const PHASE_LABELS = \{/.test(SRC), 'map exists');
    assert.ok(/1: \{ stage: 1, heading: 'Phase 1 · Requirements' \}/.test(SRC));
    assert.ok(/4: \{ stage: 2, heading: 'Phase 2 · AI Research' \}/.test(SRC));
    assert.ok(/5: \{ stage: 3, heading: 'Phase 3 · Review & Deploy' \}/.test(SRC));
    assert.ok(/2: \{ stage: 3, heading: 'Edit Steps' \}/.test(SRC));
    assert.ok(/3: \{ stage: 3, heading: 'Edit I\/O Schema & Test Input' \}/.test(SRC));
  });

  it('phase4Title assignment reads the map (single source of truth)', () => {
    assert.ok(SRC.includes('title.textContent = PHASE_LABELS[4].heading;'));
    assert.ok(!SRC.includes("title.textContent = 'Phase 4: Research Session'"));
  });

  it('HTML h2 headings use the new display titles', () => {
    assert.ok(HTML.includes('<h2>Phase 1 · Requirements</h2>'));
    assert.ok(HTML.includes('<h2 id="phase4Title">Phase 2 · AI Research</h2>'));
    assert.ok(HTML.includes('<h2>Phase 3 · Review & Deploy</h2>'));
    assert.ok(HTML.includes('<h2>Edit Steps</h2>'));
    assert.ok(HTML.includes('<h2>Edit I/O Schema & Test Input</h2>'));
    assert.ok(!/Phase [2-5]:/.test(HTML), 'no legacy numbered headings remain');
  });

  it('user-visible copy no longer references stale phase numbers', () => {
    assert.ok(HTML.includes('AI Research log'), 'Research tooltip reworded');
    assert.ok(!HTML.includes('Phase 4 session log'));
    assert.ok(SRC.includes('the results screen parked the session panels'));
    assert.ok(SRC.includes('refine manually in Edit Steps'));
    assert.ok(!SRC.includes('manually in Phase 2'));
    assert.ok(!SRC.includes('from Phase 5 parked'));
  });
});

describe('UI polish: stage stepper', () => {
  it('HTML has the three-step stage stepper under the h1', () => {
    const h1 = HTML.indexOf('<h1 id="pageTitle">');
    const stepper = HTML.indexOf('<ol id="stageStepper"');
    assert.ok(h1 !== -1 && stepper !== -1 && stepper > h1, 'stepper sits under the h1');
    assert.ok(/<li>Requirements<\/li>\s*<li>AI Research<\/li>\s*<li>Review & Deploy<\/li>/.test(HTML), 'three stages in order');
  });

  it('showPhase drives the stepper and h1 through PHASE_LABELS', () => {
    const start = SRC.indexOf('function showPhase(');
    assert.ok(start !== -1, 'showPhase exists');
    let i = SRC.indexOf('{', start), depth = 0, end = start;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const body = SRC.slice(start, end);
    assert.ok(body.includes('updateStageChrome(n)'), 'showPhase updates stage chrome');
    assert.ok(/function updateStageChrome\(n\)/.test(SRC), 'updateStageChrome exists');
    assert.ok(SRC.includes("document.querySelectorAll('#stageStepper li')"), 'stepper items selected');
    assert.ok(SRC.includes("li.classList.toggle('is-current'"), 'is-current toggled');
    assert.ok(SRC.includes("li.classList.toggle('is-done'"), 'is-done toggled');
    assert.ok(SRC.includes("h1.textContent = label ? label.heading : 'Create New Service'"), 'h1 mirrors the phase heading');
  });

  it('initial load highlights stage 1', () => {
    assert.ok(/updateStageChrome\(1\);/.test(SRC), 'init call pins stage 1');
  });

  it('CSS styles the stepper pills and states', () => {
    assert.ok(/#stageStepper \{/.test(CSS), 'stepper base rule');
    assert.ok(/#stageStepper li\.is-current \{/.test(CSS), 'current state');
    assert.ok(/#stageStepper li\.is-done \{/.test(CSS), 'done state');
  });
});
