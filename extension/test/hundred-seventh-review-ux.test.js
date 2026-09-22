// 107th log — the user's three review-stage complaints:
//  1. service name missing in review (research-first flow skips phase 2's
//     suggestion — suggest at the review render too)
//  2. "部署候选为未验证版本 v12（最后验证通过：v5）——为啥不验证呢？":
//     v6-v11 had ALL verified green; the banner lost them because
//     lastVerified only synced on the completion path — aborted/mid-run
//     reviews showed a stale verifiedV. Fix: live sync on every session
//     tool_result + banner explains WHY + a re-verify button.
//  3. detector self-check rendered raw keys ("检测器 oversizedFields 有发现
//     (1 项)") — undecipherable. Fix: plain-language map with action/advisory
//     levels; advisories marked 无需处理 and collapsed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const vm = require('vm');

const WU = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const WJ = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

function sliceFnFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined');
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

describe('107th-A: syncLastVerifiedFromVerify (live lastVerified sync)', () => {
  const fnSrc = sliceFnFrom(WU, 'syncLastVerifiedFromVerify') + '\nthis.__fn = syncLastVerifiedFromVerify;';
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
  const fn = ctx.__fn;
  it('a fresh green verify blesses its version', () => {
    const state = { currentArtifactVersion: 11, artifactsByVersion: { 11: [{ id: 'a' }] } };
    const lv = { report: { ok: true, executedArtifactVersion: 11 } };
    const r = fn(state, lv);
    assert.ok(r && r.version === 11 && Array.isArray(r.steps));
  });
  it('a verify older than the current artifact does NOT bless (post-green rewrite stays unverified)', () => {
    const state = { currentArtifactVersion: 12, artifactsByVersion: { 11: [{ id: 'a' }], 12: [{ id: 'b' }] } };
    const lv = { report: { ok: true, executedArtifactVersion: 11 } };
    assert.equal(fn(state, lv), null, 'v12 must stay unverified — the banner exists for exactly this');
  });
  it('red verifies and missing version stamps never bless', () => {
    const state = { currentArtifactVersion: 11, artifactsByVersion: { 11: [] } };
    assert.equal(fn(state, { report: { ok: false } }), null);
    assert.equal(fn(state, { report: { ok: true } }), null);
    assert.equal(fn(state, null), null);
  });
});

describe('107th-B: explainDetectorFinding (plain-language detector verdicts)', () => {
  const src = sliceFnFrom(WU, 'explainDetectorFinding');
  function load() {
    const dom = new JSDOM('');
    const ctx = { window: dom.window };
    vm.createContext(ctx);
    // DETECTOR_PLAIN is a top-level const — slice it with the function.
    const declStart = WU.indexOf('const DETECTOR_PLAIN = {');
    const declEnd = WU.indexOf('function explainDetectorFinding');
    vm.runInContext(WU.slice(declStart, declEnd) + src + '\nthis.__fn = explainDetectorFinding;', ctx);
    return ctx.__fn;
  }
  it('oversizedFields reads as an advisory with an actionable explanation', () => {
    const fn = load();
    const r = fn('oversizedFields', [{ field: 'posts.htmlSnippet', count: 4, total: 4, maxLen: 50062, avgLen: 50061 }]);
    assert.equal(r.level, 'advisory');
    assert.match(r.detail, /htmlSnippet/);
    assert.match(r.detail, /No action needed|remove/i);
  });
  it('adMarkerSelectors explains BOTH polarities so the user can decide', () => {
    const fn = load();
    const r = fn('adMarkerSelectors', [{ stepId: 'collect', markers: ['data-ad-comet-preview'] }]);
    assert.match(r.detail, /exclusion form|structural marker/i);
  });
  it('partialEmptyFields is actionable with per-field counts', () => {
    const fn = load();
    const r = fn('partialEmptyFields', [{ field: 'location', path: 'posts.location', emptyCount: 4, totalCount: 4 }]);
    assert.equal(r.level, 'action');
    assert.match(r.detail, /posts\.location empty 4\/4/);
  });
  it('unknown detector keys fall back to a labeled advisory, never a bare key', () => {
    const fn = load();
    const r = fn('someFutureDetector', [1]);
    assert.equal(r.level, 'advisory');
    assert.match(r.detail, /未编目/);
  });
});

describe('107th-C: wizard review wiring (source audit)', () => {
  it('tool_result syncs lastVerified live', () => {
    const i = WJ.indexOf("case 'tool_result':");
    const block = WJ.slice(i, i + 900);
    assert.match(block, /syncLastVerifiedFromVerify/, 'live sync on every tool_result event');
  });
  it('the unverified banner explains WHY and offers a re-verify button', () => {
    assert.match(WJ, /has NOT been verified — it is a change made after the last verified version/, 'banner explains the post-green-rewrite cause');
    assert.match(WJ, /btnReverifyCurrent/, 're-verify button present');
    assert.match(WJ, /Verify current version/, 'button label is a clear action');
  });
  it('advisories render collapsed and marked as needing no action', () => {
    assert.match(WJ, /advisory note\(s\)/, 'collapsed advisory group');
    assert.match(WJ, /no action needed by default/, 'explicit no-action label');
  });
  it('review-stage name render suggests a name when the state has none', () => {
    const i = WJ.indexOf('document.activeElement !== nameInput');
    assert.ok(i > -1, 'review render site found');
    const block = WJ.slice(i - 200, i + 900);
    assert.match(block, /suggestServiceName/, 'suggestion also runs at the review render');
  });
});
