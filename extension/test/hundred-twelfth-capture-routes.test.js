// 112th log (user behavioral feedback, no re-run): "系统反反复复进行元素定位
// 触发…已经全部触发了，但是系统却又再次研究，而不是输出。如果是因为解析
// 抽取的问题…为何要反反复复去加载、触发、操作页面？不应该合理 plan 吗？
// 页面操作正确、回传数据正确了…聚焦于解决后续的解析和抽取问题？审查下有
// 没有任务规划（plan），定位困难或用户需求表述不完整时，有没有合理找用户
// 请求协助标注。"
//
// Audit answer: a STEP-level plan exists (dossier [STEP PLAN], §3.C) and
// ask-user tools exist (user.observe / annotate.request) — what is MISSING
// is EVIDENCE-ROUTE level bookkeeping: which capture routes (anchor →
// popover payload) are already PROVEN this session, so that
//   (a) re-triggering a proven route's page ops for what is now a
//       parsing/binding problem gets nudged toward reusing the captured
//       evidence (or probe.snippet);
//   (b) a route attempted repeatedly with NO capture escalates to
//       user.observe / annotate.request instead of another identical
//       dispatch.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const ED = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evidence-dossier.js'), 'utf8');
const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');

const { createSessionTools } = require('../lib/session-tools');
const DossierLib = require('../lib/evidence-dossier');

function makeTools(hoverImpl) {
  const rail = {
    executeDsl: async () => ({}),
    pageState: async () => ({}),
    epoch: 0
  };
  return createSessionTools({
    rail: rail,
    runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
    probeFactory: () => ({ hover: hoverImpl, timestamp: async () => ({ heuristicValue: 'x' }) }),
    getDraftService: () => null,
    applyArtifact: () => {},
    getTestInput: () => ({}),
    getOutputSchema: () => null,
    getSteps: () => []
  });
}

describe('112th-A: capture-route ledger nudges (session-tools functional)', () => {
  it('re-proving a PROVEN route in the same epoch carries the frugality routeNote; epoch reset after service.update', async () => {
    let n = 0;
    const impl = async () => ({ hovered: true, htmlSnippet: '<div>September 21, 2026 at 3:11 AM</div>', rejectedAddedTexts: [] });
    const tools = makeTools(impl);
    const r1 = await tools.tools['probe.hover']({ anchorSel: 'a span[aria-labelledby]' });
    assert.ok(!r1.routeNote, 'first proof carries no note');
    const r2 = await tools.tools['probe.hover']({ anchorSel: 'a span[aria-labelledby]' });
    assert.ok(r2.routeNote && /already proven/i.test(r2.routeNote), 'second proof in the same epoch nudges toward reuse');
    assert.match(r2.routeNote, /probe\.snippet|captured evidence/i);
  });
  it('repeated empty attempts escalate to the ask-user note (113rd round: two-strike)', async () => {
    const impl = async () => ({ hovered: false, htmlSnippet: null, reason: 'popover_timeout' });
    const tools = makeTools(impl);
    const k = { anchorSel: 'div.x span' };
    const r1 = await tools.tools['probe.hover'](k);
    const r2 = await tools.tools['probe.hover'](k);
    assert.ok(!r1.routeNote, 'first attempt stays quiet');
    assert.ok(r2.routeNote && /user\.observe|annotate\.request/.test(r2.routeNote), 'second empty attempt requires asking the user');
  });
});

describe('112th-B: dossier [CAPTURE ROUTES] block', () => {
  it('buildDossier renders PROVEN routes with samples, NO-capture routes, and the frugality policy line', () => {
    const text = DossierLib.buildDossier({
      captureRoutes: [
        { anchor: 'a span[aria-labelledby]', attempts: 3, proofs: 2, samples: ['September 21, 2026 at 3:11 AM'] },
        { anchor: 'div.x span', attempts: 3, proofs: 0, samples: [] }
      ]
    });
    assert.match(text, /\[CAPTURE ROUTES\]/);
    assert.match(text, /PROVEN ×2/);
    assert.match(text, /September 21, 2026 at 3:11 AM/);
    assert.match(text, /3 attempt\(s\), NO capture/);
    assert.match(text, /page-op frugality/i);
    assert.match(text, /annotate\.request — they mark the element/);
  });
});

describe('112th-C: wiring (source audits)', () => {
  it('session-tools exposes captureRoutes in dossierFeeds and bumps the epoch on service.update/verify', () => {
    assert.match(ST, /captureRoutes: \(\) =>/, 'dossier feed present');
    assert.match(ST, /captureRouteEpoch \+= 1/, 'epoch bump on artifact/verify changes');
  });
  it('research-session passes the captureRoutes feed into buildDossier', () => {
    assert.match(RS, /captureRoutes: \(typeof feeds\.captureRoutes === 'function'\) \? feeds\.captureRoutes\(\) : null/);
  });
  it('evidence-dossier block renders between popover captures and the verify census (runtime order)', () => {
    const text = DossierLib.buildDossier({
      captureRoutes: [{ anchor: 'a', attempts: 1, proofs: 1, samples: ['s'] }],
      popovers: [],
      lastVerify: { ok: true, detectors: {} }
    });
    const iP = text.indexOf('[POPOVER CAPTURES]');
    const iR = text.indexOf('[CAPTURE ROUTES]');
    const iC = text.indexOf('[LAST VERIFY CENSUS]');
    assert.ok(iP > -1 && iR > iP && iC > iR, 'ordering: popovers → capture routes → census');
  });
});

describe('113rd round (user request): two-strike escalation to annotation', () => {
  it('the SECOND empty attempt on a route already requires user annotation', async () => {
    const impl = async () => ({ hovered: false, htmlSnippet: null, reason: 'popover_timeout' });
    const tools = makeTools(impl);
    const k = { anchorSel: 'div.y span' };
    const r1 = await tools.tools['probe.hover'](k);
    const r2 = await tools.tools['probe.hover'](k);
    assert.ok(!r1.routeNote, 'first attempt stays quiet (one miss can be a timing flake)');
    assert.ok(r2.routeNote && /annotate\.request/.test(r2.routeNote), 'second miss requires user annotation — the user picks the element');
    assert.match(r2.routeNote, /user\.observe/);
  });
});
