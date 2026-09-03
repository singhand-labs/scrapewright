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

describe('UI polish: live session badge', () => {
  it('badge markup lives next to the phase-4 heading, outside the h2', () => {
    assert.ok(HTML.includes('<div class="phase4-header">'), 'flex wrapper');
    assert.ok(HTML.includes('<span id="sessionStatusBadge" class="status-badge hidden">'), 'badge span');
    const wrap = HTML.indexOf('<div class="phase4-header">');
    const h2 = HTML.indexOf('<h2 id="phase4Title">');
    const badge = HTML.indexOf('id="sessionStatusBadge"');
    assert.ok(wrap !== -1 && h2 > wrap && badge > h2, 'wrapper → h2 → badge order');
  });

  it('setSessionBadge implements the five states + tab-title sync', () => {
    const start = SRC.indexOf('function setSessionBadge(');
    assert.ok(start !== -1, 'setSessionBadge exists');
    let i = SRC.indexOf('{', start), depth = 0, end = start;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const body = SRC.slice(start, end);
    for (const s of ['is-running', 'is-waiting', 'is-paused', 'is-done', 'is-crashed']) {
      assert.ok(body.includes(s), 'state class ' + s);
    }
    assert.ok(body.includes("'is-' + state"), 'state class composition');
    assert.ok(body.includes("'● researching… — ' + BASE_DOC_TITLE"), 'running tab title');
    assert.ok(body.includes("'‖ paused — ' + BASE_DOC_TITLE"), 'paused tab title');
    assert.ok(/const BASE_DOC_TITLE = /.test(SRC), 'base title captured at load');
  });

  it('session events drive the badge', () => {
    assert.ok(SRC.includes("setSessionBadge('running', 'starting…')"), 'session_start');
    assert.ok(SRC.includes("setSessionBadge('running', 'turn ' + ev.turn + ' — thinking…')"), 'turn_start');
    assert.ok(SRC.includes("setSessionBadge('running', 'tool: ' + ev.tool)"), 'tool_call');
    assert.ok(SRC.includes("if (!sessionPanelOpen()) setSessionBadge('running', 'thinking…')"), 'tool_result respects open panels');
    assert.ok(SRC.includes("setSessionBadge('paused', 'paused — Resume when ready')"), 'paused');
    assert.ok(SRC.includes("setSessionBadge('done', ev.reason === 'completed' ? 'done' : 'stopped — ' + friendlyStopReason(ev.reason))"), 'stopped reuses the A20 mapping');
    assert.ok(SRC.includes("setSessionBadge('crashed', 'crashed')"), 'crash path');
  });

  it('annotation/io panels flip the badge to waiting and back', () => {
    assert.ok(SRC.includes("setSessionBadge('waiting', 'waiting for your annotations')"));
    assert.ok(SRC.includes("setSessionBadge('waiting', 'waiting for contract confirmation')"));
    assert.ok(/function badgeAfterPanelClose\(\)/.test(SRC), 'panel-close restore helper');
    assert.ok(/function sessionPanelOpen\(\)/.test(SRC), 'panel-open probe');
  });

  it('CSS renders the dot with per-state colors and pulse', () => {
    assert.ok(/\.status-badge \.dot \{/.test(CSS), 'dot rule');
    assert.ok(/\.status-badge\.is-running \.dot \{/.test(CSS), 'running color');
    assert.ok(/\.status-badge\.is-crashed \.dot \{/.test(CSS), 'crashed color');
    assert.ok(/@keyframes badge-pulse/.test(CSS), 'pulse animation');
    assert.ok(/@keyframes badge-breathe/.test(CSS), 'breathe animation');
    assert.ok(/\.phase4-header \{/.test(CSS), 'header flex row');
  });
});

describe('UI polish: phase-1 guard + empty state', () => {
  it('Research disables on a blank target URL, with a tooltip hint', () => {
    assert.ok(/function updateResearchButtonState\(\)/.test(SRC), 'guard function exists');
    assert.ok(SRC.includes("'Enter a target URL first'"), 'disabled tooltip copy');
    assert.ok(/btn\.disabled = empty/.test(SRC), 'disabled assignment');
    const input = SRC.indexOf("getElementById('targetUrl').addEventListener('input'");
    assert.ok(input !== -1, 'targetUrl input listener exists');
    const region = SRC.slice(input, SRC.indexOf('});', input) + 3);
    assert.ok(region.includes('updateResearchButtonState()'), 'input listener refreshes the button');
    const calls = SRC.split('updateResearchButtonState()').length - 1;
    assert.ok(calls >= 5, 'wired at init, on input, in showPhase(1), and after programmatic restores (found ' + calls + ')');
  });

  it('renderStepList shows a guiding empty state instead of blank space', () => {
    const start = SRC.indexOf('function renderStepList(');
    assert.ok(start !== -1, 'renderStepList exists');
    let i = SRC.indexOf('{', start), depth = 0, end = start;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const body = SRC.slice(start, end);
    assert.ok(/wizardState\.steps\.length/.test(body), 'length check');
    assert.ok(body.includes('No steps yet — Research will generate them'), 'guiding copy');
    assert.ok(body.includes('empty-state'), 'empty-state class');
    assert.ok(/\.empty-state \{/.test(CSS), 'empty-state styled');
  });
});
