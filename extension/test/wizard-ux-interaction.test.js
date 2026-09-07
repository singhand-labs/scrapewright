'use strict';
// Interaction UX (user request, 2026-09-07) — four wizard improvements:
//   1. the restatement LLM call shows an elapsed clock (a silent modal reads
//      as hung while the provider thinks or retries);
//   2. the restatement's follow-up questions are answerable INLINE — answers
//      ride into the confirmed requirement as Q/A pairs;
//   3. the AI-generated test input values are surfaced for review on the
//      review stage, editable and adoptable as the deploy-time default;
//   4. panels that need the user bring the wizard's own tab to the front.
// Source-audit pattern (wizard.js is chrome/DOM-heavy; see
// wizard-session-integration-audit.test.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
const WIZARD_JS = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const WIZARD_CSS = fs.readFileSync(path.join(__dirname, '..', 'wizard.css'), 'utf8');

function fnBody(name) {
  const start = WIZARD_JS.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must exist in wizard.js');
  return WIZARD_JS.slice(start, start + 8000);
}

describe('interaction UX: restatement LLM-call elapsed clock', () => {
  it('the modal carries a #restateTimer element', () => {
    assert.ok(/id="restateTimer"/.test(WIZARD_HTML), 'wizard.html needs the timer span');
    assert.ok(/restate-timer/.test(WIZARD_CSS), 'the timer needs its tabular-nums style');
  });

  it('showRequirementRestatePanel starts a 1s interval and freezes it in finally', () => {
    const body = fnBody('showRequirementRestatePanel');
    const t = body.indexOf('restateTimer');
    assert.ok(t > -1, 'the restatement call must touch the timer');
    const chunk = body.slice(t, t + 1200);
    assert.ok(/setInterval/.test(chunk), 'the clock ticks on an interval');
    assert.ok(/formatSessionElapsed/.test(chunk), 'reuses the session clock formatter');
    assert.ok(/finally\s*\{[\s\S]*?stopRestateTimer\(\)/.test(body),
      'the finally block freezes the clock whether the call lands or fails');
  });

  it('stopRestateTimer clears the interval (idempotent)', () => {
    const body = fnBody('stopRestateTimer');
    assert.ok(/clearInterval\(restateTimerInt\)/.test(body));
    assert.ok(/restateTimerInt = null/.test(body));
  });
});

describe('interaction UX: inline follow-up answers on the restatement', () => {
  it('each open question renders with an answer input carrying the question', () => {
    const body = fnBody('showRequirementRestatePanel');
    const chunk = body.slice(body.indexOf('norm.openQuestions.length'), body.indexOf('btnConfirm.disabled = false'));
    assert.ok(/createElement\('input'\)/.test(chunk), 'an input per question');
    assert.ok(/className = 'restate-answer'/.test(chunk));
    assert.ok(/dataset\.question = q/.test(chunk), 'the input remembers which question it answers');
    assert.ok(/Your answer \(optional\)/.test(chunk));
  });

  it('collectRestateAnswers keeps only non-empty answers as {q, a} pairs', () => {
    const body = fnBody('collectRestateAnswers');
    assert.ok(/#restateQuestions input\.restate-answer/.test(body));
    assert.ok(/dataset\.question/.test(body));
    assert.ok(/\.trim\(\)/.test(body));
  });

  it('Confirm AND Skip collect the answers before starting research', () => {
    const confirmIdx = WIZARD_JS.indexOf("getElementById('btnRestateConfirm').addEventListener");
    const skipIdx = WIZARD_JS.indexOf("getElementById('btnRestateSkip').addEventListener");
    assert.ok(confirmIdx > -1 && skipIdx > -1);
    assert.ok(WIZARD_JS.slice(confirmIdx, skipIdx).includes('collectRestateAnswers()'),
      'the Confirm handler collects inline answers');
    const skipChunk = WIZARD_JS.slice(skipIdx, skipIdx + 700);
    assert.ok(skipChunk.includes('collectRestateAnswers()'),
      'the Skip handler collects inline answers too');
    // Revise hands back to the requirement box — answers are NOT harvested
    // there (the user is changing the requirement itself). Slice only the
    // Revise handler itself, not far enough to reach the Skip handler.
    const reviseIdx = WIZARD_JS.indexOf("getElementById('btnRestateRevise').addEventListener");
    const reviseChunk = WIZARD_JS.slice(reviseIdx, WIZARD_JS.indexOf('addEventListener', reviseIdx + 40));
    assert.ok(reviseChunk.length > 0 && reviseChunk.length < 400);
    assert.ok(!reviseChunk.includes('collectRestateAnswers()'));
  });

  it('startResearchSession appends the answers to the FRESH requirement only', () => {
    const idx = WIZARD_JS.indexOf('Follow-up answers:');
    assert.ok(idx > -1, 'the fresh-start path appends the Q/A pairs');
    const chunk = WIZARD_JS.slice(idx - 700, idx + 300);
    assert.ok(/restateAnswers && restateAnswers\.length/.test(chunk), 'guarded on answers existing');
    assert.ok(/buildRequirementsBlock/.test(chunk), 'appended after the built requirement');
    assert.ok(/'Q: ' \+ x\.q \+ '\\nA: ' \+ x\.a/.test(chunk), 'structured Q/A pair per answer');
    // The resume path (engine state carries the requirement) must NOT append.
    const resumeIdx = WIZARD_JS.indexOf("resumeNote = 'Resuming the parked research session'");
    assert.ok(resumeIdx > -1 && resumeIdx < idx, 'the append lives on the fresh-start else branch');
  });
});

describe('interaction UX: generated test input needs user confirmation', () => {
  it('the review panel names the generated values and offers save-as-default', () => {
    assert.ok(/generated by the AI/i.test(WIZARD_HTML), 'the summary says where the values come from');
    assert.ok(/id="btnCustomTestSave"/.test(WIZARD_HTML), 'save-as-default button exists');
    assert.ok(/Save as Default Test Input/.test(WIZARD_HTML));
    assert.ok(/custom-test-hint/.test(WIZARD_HTML));
  });

  it('saveCustomTestInput adopts the edited values as BOTH defaults', () => {
    const body = fnBody('saveCustomTestInput');
    assert.ok(/collectCustomTestInput\(\)/.test(body));
    assert.ok(/wizardState\.testInput = custom/.test(body), 'the runtime default');
    assert.ok(/wizardState\.sampleInput = JSON\.parse\(JSON\.stringify\(custom\)\)/.test(body),
      'the persisted default (deploy saves sampleInput) — a deep copy');
    assert.ok(/=== null/.test(body.slice(0, body.indexOf('wizardState.testInput'))),
      'invalid JSON in the fallback textarea is refused, not saved');
  });

  it('the save button is wired', () => {
    const idx = WIZARD_JS.indexOf("getElementById('btnCustomTestSave').addEventListener");
    assert.ok(idx > -1);
    assert.ok(WIZARD_JS.slice(idx, idx + 200).includes('saveCustomTestInput()'));
  });

  it('renderCustomTestFields opens the panel when generated values exist', () => {
    const body = fnBody('renderCustomTestFields');
    const idx = body.indexOf("getElementById('customTestPanel')");
    assert.ok(idx > -1, 'the details panel is reachable');
    const chunk = body.slice(idx, idx + 600);
    assert.ok(/details\.open = !!hasValues/.test(chunk), 'auto-opens only when a value is non-empty');
    assert.ok(/String\(v\) !== ''/.test(chunk), 'empty-string values do not count as generated');
  });
});

describe('interaction UX: panels bring the wizard tab to the front', () => {
  it('focusWizardTab activates the tab and focuses its window, best-effort', () => {
    const body = fnBody('focusWizardTab');
    assert.ok(/chrome\.tabs\.getCurrent/.test(body));
    assert.ok(/tab\.active/.test(body), 'a no-op when the wizard tab is already front');
    assert.ok(/chrome\.tabs\.update\(tab\.id, \{ active: true \}/.test(body));
    assert.ok(/chrome\.windows\.update\(tab\.windowId, \{ focused: true \}/.test(body));
    assert.ok(/catch/.test(body), 'must never break the panel that called it');
  });

  it('is called by every wizard-side interaction moment', () => {
    for (const anchor of [
      'async function showRequirementRestatePanel',
      "const panel = document.getElementById('ioConfirmPanel')",
      'async function presentSessionCompletion',
      'Session crashed: '
    ]) {
      const idx = WIZARD_JS.indexOf(anchor);
      assert.ok(idx > -1, anchor + ' must exist');
      const chunk = WIZARD_JS.slice(idx, idx + 2500);
      assert.ok(chunk.includes('focusWizardTab()'), anchor + ' context must call focusWizardTab');
    }
  });

  it('is NOT called by the annotation request (the PAGE tab is the target there)', () => {
    const start = WIZARD_JS.indexOf('function createWizardAnnotationBridge');
    const end = WIZARD_JS.indexOf('function createWizardIoBridge');
    assert.ok(start > -1 && end > start);
    const bridge = WIZARD_JS.slice(start, end);
    assert.ok(/chrome\.tabs\.update\(tabId, \{ active: true \}\)/.test(bridge),
      'the annotation bridge activates the page tab');
    assert.ok(!bridge.includes('focusWizardTab'),
      'the wizard tab must not steal focus back from the annotation page');
  });
});
