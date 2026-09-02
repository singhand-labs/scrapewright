// extension/test/wizard-session-integration-audit.test.js
//
// Source-text audit of the wizard integration (wizard.js can't load in
// Node — chrome.* APIs). Pins the contract boundaries Task 8 establishes.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');

function fnBody(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists');
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

describe('wizard research-session integration (source audit)', () => {
  it('boots a ResearchSession from btnPhase1Research (startResearchSession wired)', () => {
    assert.ok(/btnPhase1Research[^;]*addEventListener\('click',\s*startResearchSession/.test(SRC), 'phase-1 button starts the session');
    assert.ok(SRC.includes('ResearchSessionLib.createResearchSession'));
    assert.ok(SRC.includes('SessionTools.createSessionTools'));
    assert.ok(SRC.includes('LiveRail.createLiveRail'));
    assert.ok(SRC.includes('VerifyRunner.createVerifyRunner'));
    assert.ok(SRC.includes('SessionPersistence.createSessionPersistence'));
  });

  it('the LLM adapter maps client empty+length errors onto the engine RC55 path', () => {
    const body = fnBody('makeLlmAdapter');
    assert.ok(body.includes('finish_reason'), 'finish_reason surfaced');
    assert.ok(body.includes('maxTokens'), 'maxTokens forwarded (RC53 config knob wins — no sub-8192 hardcode)');
    assert.ok(!/maxTokens:\s*\d{3,5}/.test(body), 'no hardcoded maxTokens literal in the adapter');
  });

  it('session budget takes the user maxOutputTokens knob', () => {
    assert.ok(/maxTokensPerCall:\s*\(config\.config\.maxOutputTokens[^)]*\)\s*\|\|\s*16384/.test(SRC), 'budgets.maxTokensPerCall = config knob || 16384');
  });

  it('session events stream into the log UI; pause/abort/resume buttons wired', () => {
    assert.ok(SRC.includes('function handleSessionEvent'));
    for (const ev of ['turn_start', 'tool_call', 'tool_result', 'knowledge_attached', 'artifact_version', 'paused', 'stopped']) {
      assert.ok(SRC.includes("'" + ev + "'"), 'event handled: ' + ev);
    }
    for (const id of ['btnSessionPause', 'btnSessionResume', 'btnSessionAbort', 'btnAnnotationFinish', 'btnAnnotationCancel']) {
      assert.ok(SRC.includes("getElementById('" + id + "')"), id + ' wired');
      assert.ok(HTML.includes('id="' + id + '"'), id + ' exists in HTML');
    }
  });

  it('the annotation bridge enters picks into the ledger with provenance user (spec §5/§8)', () => {
    const body = fnBody('createWizardAnnotationBridge');
    assert.ok(body.includes('START_ANNOTATION'));
    assert.ok(body.includes('CAPTURE_ANNOTATION'));
    assert.ok(/provenance:\s*'user'/.test(body));
  });

  it('deploy persists the findings ledger with the service (spec §3B)', () => {
    assert.ok(/findingsLedger/.test(fnBody('confirmDeploy')));
  });

  it('testScript runs over the shared verify-runner (no duplicated rail wiring)', () => {
    const body = fnBody('testScript');
    assert.ok(body.includes('getWizardRunner'));
    assert.ok(!body.includes('ACQUIRE_EXEC_LOCK'), 'lock acquisition lives in the rail');
    assert.ok(!body.includes('new OffscreenExecutor'), 'executor wiring lives in the runner env');
    assert.ok(!body.includes('detectClickInListTotalFailure'), 'detectors live in the runner');
  });

  it('the dead flow is gone: Round 1/2/3, exploration, autoFix, bestAttempt machinery', () => {
    for (const gone of [
      'function startResearch(', 'function continueResearch(', 'function getCandidateSelectors(',
      'function confirmSelectorsWithFullHtml(', 'function generateStepsWithSelectors(',
      'function generateExplorationScript(', 'function explorePageInteraction(',
      'function autoFix(', 'function runFixIteration(', 'function buildRegressionGuard(',
      'function showInterventionBanner(', 'function clearInterventionBanner('
    ]) {
      assert.ok(!SRC.includes(gone), gone + ' must be deleted');
    }
    assert.ok(!SRC.includes('bestAttempt'), 'bestAttempt machinery gone');
    assert.ok(!SRC.includes('autoFixing'), 'autoFixing flag gone');
    assert.ok(!SRC.includes('btnRunExploration'), 'exploration button gone');
    assert.ok(!HTML.includes('explorationPanel'), 'exploration panel gone from HTML');
  });

  it('resume path restores wizardState steps from the last artifact version', () => {
    assert.ok(SRC.includes('function resumeResearchSession'));
    const body = fnBody('resumeResearchSession');
    assert.ok(body.includes('artifactVersions'), 'steps restored from artifact stack');
    assert.ok(body.includes('persistence.load') || body.includes('.load()'));
  });
});
