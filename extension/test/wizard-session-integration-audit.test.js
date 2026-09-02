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

  it('maxTurns is user-configurable (sixth-log G5: default raised to 60)', () => {
    assert.ok(HTML.includes('id="sessionMaxTurns"'), 'phase-1 max-turns input exists');
    assert.ok(/budgets:\s*\{[^}]*maxTurns:\s*getSessionMaxTurns\(\)/.test(SRC), 'budgets.maxTurns comes from the live knob');
    const body = fnBody('getSessionMaxTurns');
    assert.ok(body.includes('sessionMaxTurns'), 'reads the input');
    assert.ok(/chrome\.storage\.local\.set\(\{\s*wizardMaxTurns/.test(body), 'persisted to chrome.storage');
    assert.ok(/wizardMaxTurns\s*=\s*60/.test(SRC), 'default 60');
    assert.ok(fnBody('updateSessionSpendLine').includes("sp.turns + '/' + wizardMaxTurns"), 'spend line shows turns against the budget');
  });

  it('session events stream into the log UI; pause/abort/resume buttons wired', () => {
    assert.ok(SRC.includes('function handleSessionEvent'));
    for (const ev of ['turn_start', 'tool_call', 'tool_result', 'knowledge_attached', 'artifact_version', 'paused', 'stopped']) {
      assert.ok(SRC.includes("'" + ev + "'"), 'event handled: ' + ev);
    }
    assert.ok(fnBody('handleSessionEvent').includes("'[session]'"), 'second-live-log D2: session events mirrored to console so exported logs show tool results');
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

describe('ninth-log L1-L5: session completion hands back to the wizard flow', () => {
  // Live evidence (eighth log, rs-1788353172269-1): the session finished
  // 'completed' and the wizard jumped to a BLANK phase 5 — no result
  // confirmation, no feedback-driven repair continuation, no service-name
  // edit, no deploy. The completion path must reuse the same presentation
  // the manual test run uses.

  it('L1: the post-run presentation is a shared function both testScript and the session path call', () => {
    const pres = fnBody('presentTestOutcome');
    assert.ok(pres.includes('wizardState.testResult'), 'stores testResult');
    assert.ok(pres.includes('renderResultSummary'), 'renders the summary');
    assert.ok(pres.includes('updatePhaseUI'), 'drives the phase-5 buttons');
    assert.ok(pres.includes('goToPhase(5)'), 'lands on phase 5');
    const ts = fnBody('testScript');
    assert.ok(ts.includes('presentTestOutcome('), 'testScript delegates to the shared presentation');
    assert.ok(!ts.includes("document.getElementById('testResults').textContent = JSON.stringify"),
      'the presentation block moved out of testScript');
  });

  it('L2: completion presents the verified result instead of a blank phase 5', () => {
    const body = fnBody('presentSessionCompletion');
    assert.ok(body.includes('getLastVerify'), 'reads the session tools bag last verify');
    assert.ok(body.includes('staleArtifact'), 'a stale verify (artifact changed after it) is not trusted');
    assert.ok(body.includes('presentTestOutcome('), 'fresh verify is presented through the shared path');
    assert.ok(body.includes('testScript()'), 'stale/missing verify falls back to a fresh end-to-end run');
    const srs = fnBody('startResearchSession');
    assert.ok(/'completed'\)\s*\{\s*await presentSessionCompletion\(\)/.test(srs.replace(/\n/g, ' ')),
      'the completed branch hands off to presentSessionCompletion (no bare goToPhase)');
  });

  it('L2b: the in-phase-4 Resume button presents the same outcome on completion', () => {
    const m = SRC.match(/btnSessionResume'\)\.addEventListener\('click',\s*async \(\) => \{([\s\S]*?)\}\);/);
    assert.ok(m, 'btnSessionResume handler found');
    assert.ok(m[1].includes('presentSessionCompletion('), 'completed run presents the result');
    assert.ok(!/goToPhase\(5\);\s*\}/.test(m[1]), 'no bare goToPhase(5) on completion');
  });

  it('L3: resume allows a maxTurns-stopped session (G5 promise: raise the knob, then Resume)', () => {
    const body = fnBody('resumeResearchSession');
    assert.ok(/'maxTurns'/.test(body), 'maxTurns is in the resumable allowlist');
    // The allowlist must still block genuinely-ended sessions: 'completed'
    // continues via the feedback panel; llm:*/wallClock/tokenCap/protocol are
    // terminal engine states. (Comments stripped — the rationale mentions it.)
    const stripped = body.replace(/\/\/[^\n]*/g, '');
    const guard = stripped.match(/st\.stopped\.reason[^;]*;/g) || [];
    assert.ok(guard.length > 0, 'stop-reason guard present');
    assert.ok(!/'completed'/.test(stripped), "'completed' must NOT be resumable here — the feedback panel is its continuation");
  });

  it('L4: the feedback panel continues a completed session with a USER FEEDBACK transcript entry', () => {
    for (const id of ['sessionFeedbackPanel', 'sessionFeedbackText', 'btnSessionFeedback']) {
      assert.ok(HTML.includes('id="' + id + '"'), id + ' exists in HTML');
    }
    const body = fnBody('sendSessionFeedback');
    assert.ok(body.includes('USER FEEDBACK'), 'feedback enters the transcript as a system entry');
    assert.ok(body.includes('service.update'), 'the entry directs diagnose → fix artifact → re-verify');
    assert.ok(/transcript\.push\(/.test(body), 'pushed onto the persisted transcript');
    assert.ok(body.includes('flush()'), 'durably written before the engine boots');
    assert.ok(/startResearchSession\(seed\)/.test(body), 'restarts the engine from the seeded state');
  });

  it('L5: the service name is editable on phase 5 (deploy reads wizardState.serviceName)', () => {
    assert.ok(HTML.includes('id="serviceNameEdit"'), 'editable input exists');
    const up = fnBody('updatePhaseUI');
    assert.ok(up.includes('serviceNameEdit'), 'prefilled from wizardState.serviceName');
    const m = SRC.match(/serviceNameEdit'\)\.addEventListener\('input'[^)]*\)\s*=>\s*\{[^}]*wizardState\.serviceName\s*=/);
    assert.ok(m, 'typing updates wizardState.serviceName (generateUniqueSlug reads it at deploy)');
    assert.ok(!HTML.includes('id="serviceNameDisplay"'), 'the static display div is gone');
  });
});
