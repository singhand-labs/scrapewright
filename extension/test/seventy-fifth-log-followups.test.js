// Seventy-fifth log (2026-09-18, cap-time unverified artifact): the session
// completed at turn 60 writing artifact v4 that was NEVER verified (the last
// verify ran against red v3), and presentSessionCompletion presented v3's
// verify outcome while the DEPLOY path bound wizardState.steps = the
// UNVERIFIED v4 — green-era results in the panel, unknown state on deploy.
//
// F1 — version bookkeeping: wizardState.currentArtifactVersion +
//      artifactsByVersion (last 3) updated on 'artifact_version'; a green
//      verify report (executedArtifactVersion stamp) records lastVerified.
// F2 — completion panel banner + one-click rollback to the verified steps.
// F3 — confirmDeploy names a never-verified artifact in its confirm gate.
//
// Pure helper `unverifiedArtifactState` unit-tested; the wizard wiring is
// source-audited (the DOM surface needs the full wizard page context).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unverifiedArtifactState } = require('../lib/wizard-utils');

const WIZ = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

// Universality guard: none of the new strings may carry site tokens.
const SITE_TOKEN_RE = /(facebook|mbasic|m\.facebook|instagram|twitter|weibo|baidu|taobao|jd\.com|zhihu)/i;

describe('75th log — unverifiedArtifactState helper', () => {
  it('flags a current artifact newer than the last verified version', () => {
    const r = unverifiedArtifactState({ currentArtifactVersion: 4, lastVerified: { version: 3, steps: [] } });
    assert.deepEqual(r, { unverified: true, currentV: 4, verifiedV: 3 });
  });

  it('green when current equals the verified version', () => {
    const r = unverifiedArtifactState({ currentArtifactVersion: 3, lastVerified: { version: 3, steps: [] } });
    assert.equal(r.unverified, false);
  });

  it('never-verified artifact is flagged with verifiedV 0', () => {
    const r = unverifiedArtifactState({ currentArtifactVersion: 2, lastVerified: null });
    assert.deepEqual(r, { unverified: true, currentV: 2, verifiedV: 0 });
  });

  it('no artifacts at all is not unverified (manual wizard flow)', () => {
    const r = unverifiedArtifactState({});
    assert.equal(r.unverified, false);
    assert.equal(unverifiedArtifactState(null).unverified, false);
  });

  it('missing/garbage fields degrade to 0 instead of throwing', () => {
    assert.equal(unverifiedArtifactState({ currentArtifactVersion: 'x' }).unverified, false);
    assert.equal(unverifiedArtifactState({ currentArtifactVersion: 2, lastVerified: {} }).unverified, true);
  });
});

function sliceBetween(src, a, b, label) {
  const s = src.indexOf(a); assert.ok(s > -1, 'marker ' + a + ' (' + label + ')');
  const e = src.indexOf(b, s); assert.ok(e > s, 'end marker ' + b + ' (' + label + ')');
  return src.slice(s, e);
}

describe('75th log — wizard wiring source audits', () => {
  it('F1a: artifact_version event stores the version and a steps snapshot (capped at 3)', () => {
    const caseSrc = sliceBetween(WIZ, "case 'artifact_version':", "appendLog('Artifact v'", 'artifact_version case');
    assert.match(caseSrc, /wizardState\.currentArtifactVersion = ev\.version/);
    assert.match(caseSrc, /wizardState\.artifactsByVersion\[ev\.version\]/);
    assert.match(caseSrc, /vKeys\.length > 3/);
  });

  it('F1b: a green verify report records lastVerified with its executed version', () => {
    const fnSrc = sliceBetween(WIZ, 'async function presentTestOutcome(out) {', 'wizardState.lastExecutionEvents', 'presentTestOutcome');
    assert.match(fnSrc, /rep\.ok === true/);
    assert.match(fnSrc, /rep\.executedArtifactVersion === 'number'/);
    assert.match(fnSrc, /wizardState\.lastVerified = \{/);
  });

  it('F1c: session resume rebuilds the version map and lastVerified; a fresh session resets them', () => {
    const seedFn = sliceBetween(WIZ, 'function seedArtifactVersionBookkeeping(st) {', '\nasync function startResearchSession', 'resume seed');
    assert.match(seedFn, /artifactsByVersion/);
    assert.match(seedFn, /st\.lastVerifyOk === true/);
    assert.match(seedFn, /lastVerifyArtifactVersion/);
    // The resume path actually calls the seeder; the fresh path resets.
    const startFn = sliceBetween(WIZ, 'async function startResearchSession(seedOverride) {', 'goToPhase(4);', 'startResearchSession');
    assert.match(startFn, /seedArtifactVersionBookkeeping\(st\)/);
    assert.match(startFn, /wizardState\.lastVerified = null/);
    assert.match(startFn, /wizardState\.currentArtifactVersion = 0/);
  });

  it('F2: the review panel prepends an unverified-artifact banner with a rollback button wired via addEventListener', () => {
    const fnSrc = sliceBetween(WIZ, 'function renderResultReview() {', 'const lv = (wizardToolsBag && typeof wizardToolsBag.getLastVerify', 'renderResultReview banner');
    assert.match(fnSrc, /unverifiedArtifactState\(wizardState\)/);
    // 107th log: the banner text was rewritten to EXPLAIN why the candidate
    // is unverified (post-green rewrite) and offer a re-verify button.
    assert.match(fnSrc, /还没跑过验证——它是最后一次通过验证/);
    assert.match(fnSrc, /从未通过任何验证/);
    assert.match(fnSrc, /btnRollbackToVerified/);
    assert.match(fnSrc, /btn\.addEventListener\('click'/);
    assert.match(fnSrc, /wizardState\.steps = JSON\.parse\(JSON\.stringify\(lv\.steps\)\)/);
    // The banner renders BEFORE the no-report early return so a
    // never-verified completion still sees it.
    const bannerIdx = fnSrc.indexOf('data-unverified-banner');
    assert.ok(bannerIdx > -1, 'banner attribute present');
  });

  it('F3: confirmDeploy names a never-verified artifact in its confirm gate', () => {
    const fnSrc = sliceBetween(WIZ, 'async function confirmDeploy() {', 'const registry = new ServiceRegistry()', 'confirmDeploy');
    assert.match(fnSrc, /unverifiedArtifactState\(wizardState\)/);
    assert.match(fnSrc, /从未验证（最后验证通过/);
  });

  it('universality: no site tokens in the new logic', () => {
    const bannerSrc = sliceBetween(WIZ, '// Seventy-fifth log: the completion panel presented', 'const lv = (wizardToolsBag && typeof wizardToolsBag.getLastVerify', 'banner block');
    const deploySrc = sliceBetween(WIZ, '// Seventy-fifth log: the deploy path binds wizardState.steps', 'if (deployReasons.length)', 'deploy gate');
    for (const s of [bannerSrc, deploySrc]) {
      assert.equal(SITE_TOKEN_RE.test(s), false, 'site token leaked: ' + s.match(SITE_TOKEN_RE));
    }
  });
});
