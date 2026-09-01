// extension/test/grounding-gate.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractSelectorClaims, extractFilterAttributes, validateGrounding } = require('../lib/grounding-gate');
const { createObservationLog } = require('../lib/observation-log');
const { createFindingsLedger } = require('../lib/findings-ledger');

describe('extractSelectorClaims', () => {
  it('extracts first-arg selectors from $ API calls in step scripts', () => {
    const steps = [{ id: '2', script: `
      const c = await $count("div[role='feed'] div[role='article']");
      const t = await $extract('h3.title', 'textContent');
      const w = await $wait(\`.loading\`);
      return { done: true };
    ` }];
    const claims = extractSelectorClaims(steps);
    const sels = claims.map(c => c.selector);
    assert.ok(sels.includes("div[role='feed'] div[role='article']"));
    assert.ok(sels.includes('h3.title'));
    assert.ok(sels.includes('.loading'));
    assert.ok(claims.every(c => c.stepIds.includes('2')));
  });

  it('extracts hover config keys and classifies popoverSel as dynamic', () => {
    const steps = [{ id: '4', script: `
      return $extractWithHover('div.card', fields, { anchorSel: 'a.profile', popoverSel: 'div[role="tooltip"]' });
    ` }];
    const claims = extractSelectorClaims(steps);
    const pop = claims.find(c => c.selector === 'div[role="tooltip"]');
    assert.ok(pop, 'popoverSel extracted');
    assert.equal(pop.kind, 'dynamic', 'popover mounts on hover — static count is meaningless');
    const anchor = claims.find(c => c.selector === 'a.profile');
    assert.equal(anchor.kind, 'static');
  });

  it('carries the stepId and dedupes identical claims', () => {
    const steps = [
      { id: '2', script: "await $count('div.card');" },
      { id: '3', script: "await $extract('div.card', 'id');" }
    ];
    const claims = extractSelectorClaims(steps);
    const cardClaims = claims.filter(c => c.selector === 'div.card');
    assert.equal(cardClaims.length, 1);
    assert.ok(cardClaims[0].stepIds.includes('2'));
    assert.ok(cardClaims[0].stepIds.includes('3'));
  });

  it('ignores strings that are not selector positions (urls, field names)', () => {
    const steps = [{ id: '1', script: `
      const u = 'https://example.com/page';
      const name = 'postingTime';
      return { done: $exists('.feed') };
    ` }];
    const claims = extractSelectorClaims(steps);
    const sels = claims.map(c => c.selector);
    assert.ok(!sels.includes('https://example.com/page'));
    assert.ok(!sels.includes('postingTime'));
    assert.ok(sels.includes('.feed'));
  });

  it('extracts selectors from the scroll/stability DSL surface', () => {
    const steps = [{ id: '5', script: `
      await $scrollBy('div[role="feed"]', 800);
      await $waitForStable('.loading');
    ` }];
    const claims = extractSelectorClaims(steps);
    const sels = claims.map(c => c.selector);
    assert.ok(sels.includes('div[role="feed"]'), '$scrollBy first arg is a selector claim');
    assert.ok(sels.includes('.loading'), '$waitForStable first arg is a selector claim');
  });
});

describe('extractFilterAttributes', () => {
  it('finds attributes inside :has() and :not() pseudo-functions', () => {
    const attrs = extractFilterAttributes("div[role='feed'] article:not(:has([data-ad-rendering-role]))");
    assert.deepEqual(attrs, ['data-ad-rendering-role']);
    const attrs2 = extractFilterAttributes('div.card:has(div[data-ad-rendering-role="story_message"])');
    assert.deepEqual(attrs2, ['data-ad-rendering-role']);
  });

  it('does not flag attributes outside filter clauses', () => {
    const attrs = extractFilterAttributes('div[data-testid="card"] h3.title');
    assert.deepEqual(attrs, []);
  });
});

describe('claim extraction hardening', () => {
  it('unescapes string-literal escapes in captured selectors', () => {
    const claims = extractSelectorClaims([{ id: '1', script: "$count('div[class=\\'x\\']');" }]);
    assert.deepEqual(claims.map(c => c.selector), ["div[class='x']"]);
  });

  it('quote-aware span walk: parens inside quoted attr values do not truncate the span', () => {
    const attrs = extractFilterAttributes(':not([dir="f)"] [data-x])');
    assert.deepEqual(attrs, ['data-x']);
    const balanced = extractFilterAttributes('[aria-label="Close (X)"] :is([data-keep])');
    assert.deepEqual(balanced, ['data-keep']);
  });

  it('semantic global attrs (title/href/name/type) still demand distribution receipts', () => {
    assert.deepEqual(extractFilterAttributes('div.card:has([title="Sponsored"])'), ['title']);
    assert.deepEqual(extractFilterAttributes('a:not([href*="/p/"][name="x"])'), ['href', 'name']);
    assert.deepEqual(extractFilterAttributes('[type="button"][data-k]'), [], 'direct compound attrs are NOT filter attrs — selector receipt covers them');
  });

  it('does not match $-suffixed identifiers as API calls', () => {
    const claims = extractSelectorClaims([{ id: '1', script: "my$count('.weird');" }]);
    assert.deepEqual(claims, []);
  });
});

function session(receipts) {
  const observationLog = createObservationLog();
  const ledger = createFindingsLedger();
  for (const r of receipts || []) {
    if (r.type === 'attr') {
      observationLog.record({ tool: 'probe.attrStats', selectors: [r.scope], attrs: [{ selector: r.scope, attr: r.attr }], summary: 'x' });
    } else if (r.type === 'ledger') {
      ledger.add({ finding: r.finding, evidence: 'e', confidence: 'high', provenance: r.provenance || 'probe', selectors: r.selectors || [] });
    } else if (r.type === 'user') {
      ledger.add({ finding: r.finding, evidence: 'user pick', confidence: 'high', provenance: 'user', selectors: r.selectors || [] });
    } else {
      observationLog.record({ tool: 'probe.count', selectors: [r.sel], summary: 'count>0' });
    }
  }
  return { observationLog, ledger };
}

describe('validateGrounding — receipt sources', () => {
  const steps = [{ id: '4', script: 'return $extractWithHover(\'div.card\', f, { anchorSel: \'a.p\', popoverSel: \'div[role="tooltip"]\' });' }];

  it('accepts selectors covered by session observations', async () => {
    const s = session([{ sel: 'div.card' }, { sel: 'a.p' }, { sel: 'div[role="tooltip"]' }]);
    const r = await validateGrounding({ steps, observationLog: s.observationLog, ledger: s.ledger });
    assert.equal(r.ok, true);
  });

  it('accepts prior-session ledger entries and user annotations as receipts', async () => {
    const s = session([
      { type: 'ledger', finding: 'card selector settled', selectors: ['div.card'] },
      { type: 'ledger', finding: 'anchor settled', selectors: ['a.p'] },
      { type: 'user', finding: 'user picked the popover', selectors: ['div[role="tooltip"]'] }
    ]);
    const r = await validateGrounding({ steps, observationLog: s.observationLog, ledger: s.ledger });
    assert.equal(r.ok, true);
  });

  it('auto-verifies uncovered static selectors via probe.count when provided', async () => {
    const s = session([]);
    const autoVerified = [];
    const r = await validateGrounding({
      steps, observationLog: s.observationLog, ledger: s.ledger,
      autoVerify: async (sel) => { autoVerified.push(sel); return sel === 'div.card' ? 5 : 0; }
    });
    assert.deepEqual(autoVerified, ['div.card', 'a.p'], 'derived/uncovers statics get one cheap probe each');
    assert.equal(r.ok, false, 'a.p matched 0 — rejected');
    assert.ok(r.rejections.some(x => x.selector === 'a.p' && x.missing === 'observation'));
  });

  it('dynamic selectors never auto-verify: rejection points at diag/annotation', async () => {
    const s = session([{ sel: 'div.card' }, { sel: 'a.p' }]);
    const r = await validateGrounding({
      steps, observationLog: s.observationLog, ledger: s.ledger,
      autoVerify: async () => 99
    });
    assert.equal(r.ok, false);
    const rej = r.rejections.find(x => x.selector === 'div[role="tooltip"]');
    assert.ok(rej);
    assert.equal(rej.missing, 'dynamic-evidence');
    assert.ok(/diag|annotat/i.test(rej.suggestion), 'rejection teaches the right next probe');
  });

  it('a throwing autoVerify probe rejects the selector instead of crashing the gate', async () => {
    const s = session([]);
    let r;
    await assert.doesNotReject(async () => {
      r = await validateGrounding({
        steps: [{ id: '1', script: "await $count('div.card');" }],
        observationLog: s.observationLog, ledger: s.ledger,
        autoVerify: async () => { throw new Error('TAB_CLOSED'); }
      });
    });
    assert.equal(r.ok, false);
    assert.ok(r.rejections.some(x => x.selector === 'div.card' && x.missing === 'observation'));
  });

  it('default-deny with no observationLog at all (filter attrs reject too)', async () => {
    const sel = 'div.card:has([data-k])';
    const steps = [{ id: '1', script: 'return $extractList(' + JSON.stringify(sel) + ', { c: \'.t\' });' }];
    const r = await validateGrounding({ steps, ledger: createFindingsLedger() });
    assert.equal(r.ok, false);
    assert.ok(r.rejections.some(x => x.missing === 'observation'));
    assert.ok(r.rejections.some(x => x.missing === 'attr-distribution'));
  });

  it('human overrides admit any selector and are reported', async () => {
    const s = session([{ sel: 'div.card' }, { sel: 'a.p' }]);
    const r = await validateGrounding({
      steps, observationLog: s.observationLog, ledger: s.ledger,
      overrides: ['div[role="tooltip"]']
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.overrideReceipts, ['div[role="tooltip"]']);
  });
});

describe('validateGrounding — filter attributes need distribution receipts', () => {
  it('THE seventh-log regression: ad attribute as :has() include without attrStats is rejected', async () => {
    const steps = [{ id: '4', script: 'return $extractList("div[role=\'feed\'] article:has(div[data-ad-rendering-role=\'story_message\'])", { c: \'.t\' });' }];
    const s = session([{ sel: "div[role='feed'] article:has(div[data-ad-rendering-role='story_message'])" }]);
    const r = await validateGrounding({
      steps, observationLog: s.observationLog, ledger: s.ledger,
      autoVerify: async () => 8
    });
    assert.equal(r.ok, false, 'count>0 is NOT enough for filter attributes');
    const rej = r.rejections.find(x => x.missing === 'attr-distribution');
    assert.ok(rej, 'must demand the attrStats distribution receipt');
    assert.equal(rej.attr, 'data-ad-rendering-role');
    assert.ok(/attrStats/i.test(rej.suggestion));
  });

  it('a title= filter is rejected without an attrStats receipt (no global-attr bypass)', async () => {
    const sel = 'div.card:has([title="Sponsored"])';
    const steps = [{ id: '4', script: 'return $extractList(' + JSON.stringify(sel) + ', { c: \'.t\' });' }];
    const s = session([{ sel: sel }]);
    const r = await validateGrounding({ steps, observationLog: s.observationLog, ledger: s.ledger });
    assert.equal(r.ok, false);
    assert.equal(r.rejections.find(x => x.missing === 'attr-distribution').attr, 'title');
  });

  it('attrStats receipt admits the filter; user annotation does not substitute for it', async () => {
    const selWithFilter = "div[role='feed'] article:not(:has([data-ad-rendering-role]))";
    const steps = [{ id: '4', script: 'return $extractList(' + JSON.stringify(selWithFilter) + ", { c: '.t' });" }];
    const withAttrStats = session([
      { sel: selWithFilter },
      { type: 'attr', scope: 'article', attr: 'data-ad-rendering-role' }
    ]);
    const okR = await validateGrounding({ steps, observationLog: withAttrStats.observationLog, ledger: withAttrStats.ledger });
    assert.equal(okR.ok, true);

    const withUser = session([
      { sel: selWithFilter },
      { type: 'user', finding: 'user confirmed organic cards', selectors: [selWithFilter] }
    ]);
    const userR = await validateGrounding({ steps, observationLog: withUser.observationLog, ledger: withUser.ledger });
    assert.equal(userR.ok, false, 'v1: user receipt is SELECTOR-scoped, attribute distribution still required — the user must annotate through the attrStats-approved flow or an override');
  });

  it('override admits the selector but NOT the filter-attr distribution demand', async () => {
    const sel = 'div.card:has([title="Sponsored"])';
    const steps = [{ id: '4', script: 'return $extractList(' + JSON.stringify(sel) + ', { c: \'.t\' });' }];
    const s = session([{ sel: sel }]);
    const r = await validateGrounding({
      steps, observationLog: s.observationLog, ledger: s.ledger, overrides: [sel]
    });
    assert.equal(r.ok, false, 'override covers the selector receipt; the attr still needs attrStats');
    assert.equal(r.rejections.find(x => x.missing === 'attr-distribution').attr, 'title');
    assert.deepEqual(r.overrideReceipts, [sel]);
    assert.ok(Array.isArray(r.claims) && r.claims.length === 1, 'claims returned for callers');
  });
});
