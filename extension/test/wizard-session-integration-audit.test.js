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

  it('Research/Ctrl+Enter resumes a parked session after reload (advertised resume is reachable)', () => {
    const body = fnBody('startResearchSession');
    // Empty requirement box + parked persisted session => resume seed, not a fresh session.
    assert.ok(body.includes("'wizardResearchSession'"), 'loads the parked session from persistence');
    assert.ok(/seed\s*=\s*\{\s*session:\s*saved\.session/.test(body), 'parked record becomes the seed');
    // The empty-box validation must not block a resume (the seed carries the requirement).
    assert.ok(body.includes('!(seed && seed.session)'), 'empty box only errors when not resuming');
    // targetUrl is not part of the engine state — recovered from the last successful page.open.
    assert.ok(body.includes("'page.open'"), 'targetUrl recovered from the transcript');
    // Typed requirements win over the parked session (fresh start is still possible).
    assert.ok(/!seed\s*&&\s*!pageOps/.test(body), 'fallback only when the box is empty');
  });

  it('the requirement block carries the Target URL (first-live-log P-C: sessions must not start blind)', () => {
    const body = fnBody('startResearchSession');
    // Both the fresh and the resume-fallback description build pass the URL —
    // without it the LLM misused annotate.request to ask for the site.
    const passes = body.match(/buildRequirementsBlock\(wizardState\.requirements,\s*wizardState\.targetUrl\)/g) || [];
    assert.equal(passes.length, 2, 'fresh branch AND resume-fallback branch both pass wizardState.targetUrl');
    assert.ok(body.indexOf('wizardState.targetUrl = document') < body.indexOf('buildRequirementsBlock(wizardState.requirements, wizardState.targetUrl)'),
      'targetUrl is captured from the URL box before the description is built');
  });
});
