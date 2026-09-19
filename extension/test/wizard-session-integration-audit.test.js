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
    assert.ok(fnBody('handleSessionEvent').includes("'[session] ' + ev.type"), 'second-live-log D2: session events mirrored to console so exported logs show tool results');
    for (const id of ['btnSessionPause', 'btnSessionResume', 'btnSessionAbort', 'btnAnnotationFinish', 'btnAnnotationCancel']) {
      assert.ok(SRC.includes("getElementById('" + id + "')"), id + ' wired');
      assert.ok(HTML.includes('id="' + id + '"'), id + ' exists in HTML');
    }
  });

  it('sixteenth log: verify.run tool_result events mirror a compact VERIFY digest', () => {
    const body = fnBody('handleSessionEvent');
    assert.ok(body.includes("'[session] VERIFY'"), 'dedicated VERIFY mirror line');
    assert.ok(body.includes('ev.verify'), 'digest logged only when the engine attached one');
  });

  it('nineteenth/thirty-second log: console mirrors leave room for schemas and never clip payloads', () => {
    const body = fnBody('handleSessionEvent');
    // Thirty-second log: the tool-args mirror moved from mirrorClip(…, 1200)
    // to mirrorLines chunk-logging — full step scripts must reach the export.
    // 87th-round full-fidelity: the args mirror cap moved 8000 → Infinity.
    assert.ok(body.includes("mirrorLines('[session] TOOL ' + ev.tool, JSON.stringify(ev.args || {}), Infinity)"),
      'io.confirm/service.update args (schemas, full step scripts) chunk-log in full — a clip cut the v2-v5 postTime script exactly where the diagnosis needed it');
    assert.ok(body.includes("mirrorClip(String(ev.summary || ''), 600)"),
      'the UI one-liner summary keeps its 600-char head+tail form');
    assert.ok(body.includes("mirrorLines('[session] TOOL RESULT DETAIL ' + ev.tool, ev.detail, 12000)"),
      'thirty-second log RC-B: the engine-attached compact detail chunk-logs in full');
  });

  it('nineteenth log: LLM retries are visible in the research log (user directive)', () => {
    const body = fnBody('makeLlmAdapter');
    assert.ok(body.includes('onRetry'), 'adapter observes client retries');
    assert.match(body, /appendLog\('LLM call failed/, 'each retry lands in the execution log');
    assert.match(body, /' \+ info\.attempt \+ '\/' \+ info\.maxRetries/, 'log line shows attempt N/10');
    assert.ok(/\/\* logging must never break the call \*\//.test(body), 'UI logging is best-effort');
    const restateBody = fnBody('showRequirementRestatePanel');
    assert.ok(restateBody.includes('onRetry'), 'the restatement panel reports retry state in its note');
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
    // Nineteenth log: the classifier grew a second arg (sessionState) so an
    // artifact-less completion stays on phase 4 for Resume instead of
    // presenting a blank outcome.
    assert.ok(/sessionStopPresentsOutcome\(report\.stopped\.reason,\s*wizardSession\.state\(\)\.session\)/.test(srs.replace(/\n/g, ' ')),
      'the completed/maxTurns branch hands off to presentSessionCompletion (no bare goToPhase)');
  });

  it('L2b: the in-phase-4 Resume button presents the same outcome on completion', () => {
    const m = SRC.match(/btnSessionResume'\)\.addEventListener\('click',\s*async \(\) => \{([\s\S]*?)\}\);/);
    assert.ok(m, 'btnSessionResume handler found');
    assert.ok(m[1].includes('presentSessionCompletion('), 'completed run presents the result');
    assert.ok(!/goToPhase\(5\);\s*\}/.test(m[1]), 'no bare goToPhase(5) on completion');
  });

  it('L3: resume allows a maxTurns-stopped session (G5 promise: raise the knob, then Resume)', () => {
    const body = fnBody('resumeResearchSession');
    // Nineteenth log: the inline allowlist moved into the shared
    // sessionStopResumable helper — resumeResearchSession must delegate.
    assert.match(body, /sessionStopResumable\(st\)/, 'resume gate delegates to the shared resumability helper');
    const helper = fnBody('sessionStopResumable');
    assert.ok(/'maxTurns'/.test(helper), 'maxTurns is in the resumable allowlist');
    // 'completed' WITH an artifact still continues via the feedback panel —
    // the ONLY resumable completion is the artifact-less external wall
    // (nineteenth log), which the helper gates on artifactVersions.
    assert.match(helper, /reason === 'completed'[\s\S]{0,160}?artifactVersions/, 'completed resumability is gated on artifact production');
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

describe('ninth-log M1/M2/M5: feedback continuation budget + maxTurns presentation', () => {
  // Live evidence (rs-1788355496224): the user's feedback resumed the COMPLETED
  // session at turn 53/60 — the continuation inherited a nearly-exhausted
  // budget, fixed both fields, verified ok:true at turn 60, and then died
  // 'maxTurns' BEFORE it could finish — so presentSessionCompletion never ran
  // and phase 5 stayed blank again.

  it('M1: feedback continuation resets the budget segment (fresh turns, advisories, wall clock)', () => {
    const body = fnBody('sendSessionFeedback');
    assert.match(body, /st\.spend\s*=\s*\{\s*turns:\s*0/, 'turn counter reset to a fresh segment');
    assert.match(body, /st\.budgetAdvisories\s*=\s*\[\]/, 'advisory keys reset so pacing re-fires');
    assert.match(body, /st\.elapsedMs\s*=\s*0/, 'wall-clock segment reset');
    assert.match(body, /page\.open/, 'the fix-request text tells the model the research tab closed — reopen first');
  });

  it('M2: a maxTurns stop with a built+verified artifact presents the outcome too, not just completed', () => {
    assert.ok(SRC.includes('function sessionStopPresentsOutcome'), 'shared stop-reason classifier');
    const cls = fnBody('sessionStopPresentsOutcome');
    assert.ok(cls.includes("'completed'"), 'completed presents');
    assert.ok(cls.includes("'maxTurns'"), 'maxTurns presents (the turn budget dying is not a reason to hide the artifact)');
    assert.ok(!cls.includes("'paused'"), 'paused stays on phase 4 for Resume');
    assert.ok(!cls.includes("'aborted'"), 'aborted stays on phase 4 for Resume');
    const srs = fnBody('startResearchSession');
    assert.ok(/sessionStopPresentsOutcome\(/.test(srs), 'the start path classifies via the helper');
    const m = SRC.match(/btnSessionResume'\)\.addEventListener\('click',\s*async \(\) => \{([\s\S]*?)\}\);/);
    assert.ok(m && m[1].includes('sessionStopPresentsOutcome('), 'the resume button classifies via the helper');
    assert.match(srs, /'maxTurns'[^;]*appendLog|appendLog[^;]*max-turns|raise the max-turns/, 'maxTurns presentation carries a budget note');
  });

  it('M5: the shared presentation logs presentation-scoped labels, not testScript', () => {
    const body = fnBody('presentTestOutcome');
    assert.match(body, /presentTestOutcome (ok|failed)/, 'debug labels describe the presentation');
    assert.ok(!/testScript (success|failed)/.test(body), 'the session path is not a testScript run — labels must not mislead');
  });
});

describe('ninth-log follow-up: early I/O contract confirmation (io.confirm)', () => {
  it('phase-4 panel: schema pre blocks, revision textarea, confirm/revise buttons', () => {
    for (const id of ['ioConfirmPanel', 'ioConfirmNote', 'ioConfirmInput', 'ioConfirmOutput', 'ioConfirmFeedback', 'btnIoConfirm', 'btnIoRevise']) {
      assert.ok(HTML.includes('id="' + id + '"'), id + ' exists in HTML');
    }
    for (const id of ['btnIoConfirm', 'btnIoRevise']) {
      assert.ok(SRC.includes("getElementById('" + id + "')"), id + ' wired');
    }
  });

  it('thirty-first log: renegotiation renders the contract diff above the schemas, not raw JSON only', () => {
    assert.ok(HTML.includes('id="ioConfirmDiff"'), 'diff box exists in the panel');
    const body = fnBody('createWizardIoBridge');
    assert.match(body, /r\.diffLines/, 'the bridge reads diffLines from the request');
    assert.match(body, /CHANGES the confirmed contract/, 'the diff box names renegotiation explicitly');
    assert.match(body, /ioConfirmDiff[\s\S]*?classList\.(remove|add)\('hidden'\)/, 'the box hides when there is no prior contract');
  });

  it('createWizardIoBridge parks the engine turn on a promise; confirm/revise/cancel resolve it', () => {
    const body = fnBody('createWizardIoBridge');
    assert.match(body, /request\(req\)\s*\{\s*return new Promise/, 'request parks the engine turn on a pending promise');
    assert.ok(body.includes('confirmed: true'), 'confirm resolves approved');
    assert.ok(/confirmed:\s*false,\s*feedback/.test(body), 'revise returns the user text as feedback');
    assert.ok(body.includes('cancel'), 'cancel path exists for session stop');
    assert.ok(/JSON\.stringify\([^)]*,\s*null,\s*2\)/.test(body), 'schemas pretty-printed for human review');
  });

  it('the bridge is wired into the session tool bag and cancelled on stop', () => {
    const srs = fnBody('startResearchSession');
    assert.ok(/wizardIoBridge\s*=\s*createWizardIoBridge\(\)/.test(srs), 'bridge created at session start');
    assert.ok(/ioConfirmBridge:\s*wizardIoBridge/.test(srs), 'passed to createSessionTools deps');
    const hse = fnBody('handleSessionEvent');
    assert.match(hse, /'stopped'[\s\S]*?wizardIoBridge && wizardIoBridge\.cancel\(\)/, "the 'stopped' event cancels a pending confirmation");
  });

  it('session-tools carries the gate: marker + runtime flag, drift teaching', () => {
    const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
    assert.ok(ST.includes("'io.confirm': ioConfirm"), 'tool registered');
    assert.ok(ST.includes('I/O CONTRACT UNCONFIRMED'), 'gate error text');
    assert.ok(ST.includes('I/O CONTRACT DRIFT'), 'material-drift gate error text');
    assert.ok(ST.includes("const IO_LEDGER_MARKER = 'I/O CONTRACT CONFIRMED'"), 'ledger marker (survives seed resume + compaction)');
    assert.ok(ST.includes('provenance: \'user\''), 'marker entry is user-provenance so compaction keeps it');
    assert.match(ST, /EARLY contract confirmation/, 'methodology rule 9');
  });
});

describe('audit plan1: wizard lifecycle state machine (A1/A2/A3/A5/A6/A17/A18 + budget resume routing)', () => {
  it('A1: testScript resets sessionAbortRequested so an aborted session cannot poison manual tests', () => {
    const m = SRC.match(/async function testScript\(\) \{[\s\S]{0,900}?sessionAbortRequested = false;/);
    assert.ok(m, 'testScript body must reset sessionAbortRequested');
  });

  it('A2: the io panel has a Reject button wired to bridge.reject()', () => {
    assert.match(HTML, /id="btnIoReject"/);
    assert.match(SRC, /btnIoReject[\s\S]{0,200}wizardIoBridge && wizardIoBridge\.reject\(\)/);
    assert.match(SRC, /reject\(\) \{/);
    assert.match(SRC, /User rejected this contract proposal/);
  });

  it('A3: stopped shows Resume (budget continuation) and hides Pause/Abort; idle hides the bar', () => {
    const m = SRC.match(/function setSessionControls\(mode\) \{[\s\S]{0,700}?\n\}/);
    assert.ok(m, 'setSessionControls found');
    const body = m[0];
    assert.match(body, /mode === 'idle'[\s\S]{0,80}classList\.add\('hidden'\)/, 'idle hides the whole bar');
    assert.match(body, /btnSessionResume[\s\S]{0,120}mode !== 'paused' && mode !== 'stopped'/, 'stopped keeps Resume');
    assert.match(body, /btnSessionAbort[\s\S]{0,120}mode !== 'running' && mode !== 'paused'/, 'stopped hides Abort');
  });

  it('A5: manual test from phase 4/5 parks the session controls and hides bridge panels', () => {
    const m = SRC.match(/async function runTestFromStep5\(\) \{[\s\S]{0,2000}?await testScript\(\);/);
    assert.ok(m);
    assert.match(m[0], /setSessionControls\('idle'\)/);
    assert.match(m[0], /annPanel\) annPanel\.classList\.add\('hidden'\)/);
    assert.match(m[0], /ioPanel\) ioPanel\.classList\.add\('hidden'\)/);
  });

  it('A6: the paused notice explains an open bridge request keeps waiting (clock parked)', () => {
    const m = SRC.match(/case 'paused':[\s\S]{0,700}?break;/);
    assert.ok(m);
    assert.match(m[0], /still waiting/);
    assert.match(m[0], /does not consume the session clock/);
  });

  it('A17: startResearchSession hides the stale feedback panel', () => {
    const m = SRC.match(/async function startResearchSession\(seedOverride\) \{[\s\S]{0,5000}?goToPhase\(4\);/);
    assert.ok(m);
    assert.match(m[0], /sessionFeedbackPanel[\s\S]{0,60}add\('hidden'\)/);
  });

  it('A18/A19: Resume and annotation-finish buttons disable in flight', () => {
    // Window widened (nineteenth log): the Resume handler grew an
    // emptyCompleted branch before the first disable.
    assert.match(SRC, /btnSessionResume'\)\.addEventListener\('click', async \(\) => \{[\s\S]{0,1600}?disabled = true/);
    assert.match(SRC, /btnAnnotationFinish'\)\.addEventListener\('click', async \(\) => \{[\s\S]{0,300}?disabled = true/);
  });

  it('budget-class stops route Resume through a fresh engine (G5 truthfulness)', () => {
    const m = SRC.match(/btnSessionResume'\)\.addEventListener\('click', async \(\) => \{[\s\S]{0,2200}?return;\n  \}\);/);
    assert.ok(m);
    assert.match(m[0], /maxTurns/);
    assert.match(m[0], /resumeResearchSession\(\)/);
  });

  it('A5 carry-over: parking the panels cancels a pending bridge instead of orphaning it', () => {
    const body = fnBody('runTestFromStep5');
    assert.ok(body.includes('annotationRequestPanel'), 'annotation panel touched');
    assert.match(body, /wizardAnnotationBridge\) wizardAnnotationBridge\.cancel\(\)/, 'annotation bridge cancelled when panel visible');
    assert.match(body, /wizardIoBridge\) wizardIoBridge\.cancel\(\)/, 'io bridge cancelled when panel visible');
  });

  it('seed whitelist + resume guard accept budget-class stop reasons', () => {
    const wl = SRC.match(/saved\.session\.stopped\.reason === 'paused' \|\| saved\.session\.stopped\.reason === 'aborted'/);
    assert.ok(!wl, 'old two-reason whitelist replaced');
    assert.match(SRC, /'maxTurns'/);
    assert.match(SRC, /'wallClock'/);
    assert.match(SRC, /'tokenCap'/);
  });

  it('fourteenth log: llm-class stops (llm:error, llm:length) are resumable at EVERY whitelist site', () => {
    // Live evidence (rs-1788436400901, turn 38): the provider went down
    // (429 balance/rate-limit), the engine stopped llm:error, and the user's
    // Resume was a silent no-op — three separate gates all refused:
    //   resumeResearchSession (worse: wizardPersistence.clear() WIPED the
    //   session), the parked-session fallback inside startResearchSession,
    //   and the page-load resume-offer toast. All three must accept the
    //   external-condition stops: the transcript is intact and a fresh
    //   engine re-reads GET_LLM_CONFIG, so Resume after provider recovery
    //   is the designed continuation.
    // Nineteenth log: the inline whitelists that used to be duplicated at
    // every site were consolidated into the shared sessionStopResumable
    // helper — assert the helper carries the llm-class reasons AND that all
    // three historical gate sites (parked fallback, reload toast,
    // resumeResearchSession) delegate to it.
    const helper = fnBody('sessionStopResumable');
    assert.match(helper, /'llm:error'/, 'helper whitelist includes llm:error');
    assert.match(helper, /'llm:length'/, 'helper whitelist includes llm:length');
    const calls = SRC.match(/sessionStopResumable\(/g) || [];
    assert.ok(calls.length >= 3, 'parked-fallback + reload-toast + resumeResearchSession all gate via the helper (found ' + calls.length + ')');
    const resumeBody = fnBody('resumeResearchSession');
    assert.match(resumeBody, /sessionStopResumable\(st\)/, 'resumeResearchSession gate accepts llm:error via the helper');
    // 'completed' WITH an artifact stays non-resumable (feedback panel path).
    assert.match(helper, /reason === 'completed'[\s\S]{0,160}?artifactVersions/, 'completed resumability is gated on artifact production');
  });

  it('fourteenth log: the live-page Resume button routes llm-class stops to a fresh engine', () => {
    // With wizardSession still alive, wizardSession.run() no-ops on a
    // stopped!=paused session (engine loop guard) AND leaves the controls
    // stuck in 'running' chrome. An llm stop must take the same fresh-engine
    // path as budget stops — a new engine also re-reads the LLM config.
    const m = SRC.match(/btnSessionResume'\)\.addEventListener\('click',\s*async \(\) => \{([\s\S]*?)\n  \}\);/);
    assert.ok(m, 'btnSessionResume handler found');
    const body = m[1];
    assert.match(body, /llm:error/, 'llm stop recognized in the handler');
    assert.match(body, /resumeResearchSession\(\)/, 'routed to the fresh-engine resume path');
  });

  it('eighteenth log: protocol stops are resumable at EVERY whitelist site (fresh engine retries the turn)', () => {
    // Live evidence (rs-1788489824160, turn 45): the final artifact write was
    // cut off twice (glm tail degradation), the engine stopped 'protocol',
    // and resumeResearchSession treated it as terminal — worse, it WIPED the
    // persisted session, destroying 45 turns of research. A protocol stop is
    // an LLM-output failure, not a dead end: the transcript is intact and a
    // fresh engine retries the turn (now with the continuation-repair round).
    // Nineteenth log: whitelist sites consolidated into the shared
    // sessionStopResumable helper — 'protocol' lives in its allowlist.
    const helper = fnBody('sessionStopResumable');
    assert.match(helper, /'protocol'/, 'helper whitelist includes protocol');
    const calls = SRC.match(/sessionStopResumable\(/g) || [];
    assert.ok(calls.length >= 3, 'parked-fallback + reload-toast + resumeResearchSession all gate via the helper (found ' + calls.length + ')');
    const resumeBody = fnBody('resumeResearchSession');
    assert.match(resumeBody, /sessionStopResumable\(st\)/, 'resumeResearchSession gate accepts protocol via the helper');
    // The live-page Resume button must route protocol stops to the fresh
    // engine too — wizardSession.run() would no-op on the stopped session.
    const m = SRC.match(/btnSessionResume'\)\.addEventListener\('click',\s*async \(\) => \{([\s\S]*?)\n  \}\);/);
    assert.ok(m, 'btnSessionResume handler found');
    assert.match(m[1], /'protocol'/, 'protocol stop recognized in the live Resume handler');
    // And the user-facing copy must say what happened and what to do.
    const friendly = fnBody('friendlyStopReason');
    assert.match(friendly, /case 'protocol':/, 'friendlyStopReason maps protocol');
    assert.match(friendly, /Resume/, 'the copy points at Resume');
  });

  it('fourteenth log: friendlyStopReason explains llm-class stops actionably', () => {
    const body = fnBody('friendlyStopReason');
    assert.match(body, /case 'llm:error'/, 'llm:error mapped');
    assert.match(body, /case 'llm:length'/, 'llm:length mapped');
    const errIdx = body.indexOf("case 'llm:error'");
    const seg = body.slice(errIdx, errIdx + 220);
    assert.match(seg, /LLM|provider/i, 'copy names the LLM/provider');
    assert.match(seg, /[Rr]esume/, 'copy tells the user Resume works after recovery');
  });
});

describe('audit C3 (page epoch): wizard supplies watchTab + engine epochOf', () => {
  it('C3: makeWizardRail supplies a watchTab dep firing only on complete→loading of the same tab', () => {
    const body = fnBody('makeWizardRail');
    assert.match(body, /watchTab\s*:/, 'makeWizardRail deps include watchTab');
    assert.match(body, /onUpdated\.addListener/, 'wires chrome.tabs.onUpdated');
    assert.match(body, /removeListener/, 'returns an unwatch function');
    assert.match(body, /'complete'/);
    assert.match(body, /'loading'/);
    assert.match(body, /onReload\(\)/, 'fires the rail callback on the transition');
  });

  it('C3: createResearchSession config passes epochOf reading the rail epoch', () => {
    const m = SRC.match(/createResearchSession\(\{[\s\S]*?\}\)/);
    assert.ok(m, 'createResearchSession call found');
    assert.match(m[0], /epochOf\s*:/, 'epochOf wired into the engine config');
    assert.match(m[0], /wizardRail/);
  });
});

describe('audit C2 (pin): the runner signal includes the session abort flag', () => {
  it('getWizardRunner getSignal reads sessionAbortRequested', () => {
    assert.match(SRC, /getSignal: \(\) => \(\{[\s\S]{0,220}sessionAbortRequested/);
  });
});

describe('wizard.html library load order (source audit)', () => {
  it('page-tracker.js loads BEFORE step-orchestrator.js (thirtieth log: the verify rail reported pages:"0" structurally)', () => {
    // PageTrackerRef resolves at step-orchestrator LOAD time via a global
    // lookup — if page-tracker.js is absent (or loads later), the wizard
    // verify rail never wires a tracker and every verify report says
    // pages:"0" even while the tab opened and steps ran. The model then
    // reads the structural zero as "the page never even opened" and
    // misdiagnoses (thirtieth log t43: hydration-race theory, ~2 turns).
    const pt = HTML.indexOf('lib/page-tracker.js');
    const so = HTML.indexOf('lib/step-orchestrator.js');
    assert.ok(pt !== -1, 'page-tracker.js is loaded by wizard.html');
    assert.ok(so !== -1, 'step-orchestrator.js is loaded by wizard.html');
    assert.ok(pt < so, 'page-tracker.js loads before step-orchestrator.js (load-time global lookup)');
  });
});
