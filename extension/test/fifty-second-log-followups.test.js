// extension/test/fifty-second-log-followups.test.js
// Fifty-second log — the 60-turn budget-exhausted session shipped 5 posts
// with garbage-concat postTime ("m.meCat… Explained | Types…"), label-prefixed
// likes, query-blob permalinks, and hoverCards[].role 10/10 empty, after FIVE
// consecutive verifies with an IDENTICAL partial-empty signature. Root cause:
// the io.confirm outputSchema was MALFORMED — likes/comments/shares/
// htmlSnippet/hoverCards were declared at the items level OUTSIDE properties —
// and nothing rejected it: the stray declarations were invisible to the
// never-extracted lint (fields enumeration saw only 7 fields; the nested
// hoverCards recursion never ran, so `role: ''` sat through 7 artifact
// versions with no receipt naming it) and to every schema-driven gate.
// Amplifiers: (G2) five identical verify disclosures + zero research probes
// between updates burned the whole budget with no stagnation signal; (G3)
// postTime values with no date/time shape ("m.meCat…") were invisible to the
// relative/empty/junk censuses.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WU = require('../lib/wizard-utils');
const { createSessionTools } = require('../lib/session-tools');
const { createVerifyRunner } = require('../lib/verify-runner');
const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');

// The EXACT malformed schema from the fifty-second log (field declarations
// misplaced at the items level, siblings of properties).
const MALFORMED = {
  type: 'object', required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'postId', 'postTime', 'content', 'hoverCards'],
        properties: {
          index: { type: 'number' },
          postId: { type: 'string' },
          postTime: { type: 'string' },
          location: { type: 'string' },
          content: { type: 'string' },
          mediaUrls: { type: 'array', items: { type: 'string' } }
        },
        likes: { type: 'string' },
        comments: { type: 'string' },
        shares: { type: 'string' },
        htmlSnippet: { type: 'string' },
        hoverCards: {
          type: 'array',
          items: { type: 'object', properties: { role: { type: 'string' } } }
        }
      }
    }
  }
};

const WELL_FORMED = {
  type: 'object', required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          postId: { type: 'string' },
          hoverCards: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' } } } }
        }
      }
    }
  }
};

// ---------------------------------------------------------------------------
// F1: stray field declarations
describe('F1: detectStrayFieldDeclarations (fifty-second log)', () => {
  it('names the exact five misplaced declarations from the fifty-second log', () => {
    const out = WU.detectStrayFieldDeclarations(MALFORMED);
    assert.ok(out && out.length >= 1, 'detected');
    const strays = out.reduce((a, n) => a.concat(n.strays), []).sort();
    for (const f of ['likes', 'comments', 'shares', 'htmlSnippet', 'hoverCards']) {
      assert.ok(strays.includes(f), f + ' named among strays: ' + JSON.stringify(strays));
    }
  });

  it('a well-formed schema carries no strays', () => {
    assert.equal(WU.detectStrayFieldDeclarations(WELL_FORMED), null);
  });

  it('cosmetic keys (description/title) never trip it', () => {
    const s = JSON.parse(JSON.stringify(WELL_FORMED));
    s.properties.posts.items.description = 'a post record';
    s.title = 'posts schema';
    assert.equal(WU.detectStrayFieldDeclarations(s), null);
  });

  it('malformed input / non-schema objects → null, never throws', () => {
    assert.equal(WU.detectStrayFieldDeclarations(null), null);
    assert.equal(WU.detectStrayFieldDeclarations('x'), null);
    assert.equal(WU.detectStrayFieldDeclarations({ type: 'string' }), null);
  });

  it('io.confirm REJECTS the malformed schema with a pointed teaching error', async () => {
    const deps = makeDepsF1();
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: MALFORMED });
    assert.equal(r.confirmed, false, 'malformed contract rejected');
    assert.match(String(r.error), /SCHEMA_STRAY_FIELD_DECLS/);
    for (const f of ['likes', 'hoverCards']) {
      assert.ok(String(r.error).includes(f), f + ' named in the error');
    }
    assert.match(String(r.error), /properties/i, 'teaches the fix (move under properties)');
  });

  it('io.confirm accepts the well-formed schema', async () => {
    const deps = makeDepsF1();
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: WELL_FORMED });
    assert.equal(r.confirmed, true);
  });

  it('the never-extracted lint now sees role inside the well-formed schema (regression sanity)', () => {
    const steps = [{ id: 'x', script: "const hcs = rows.map(h => ({ type: 'account', role: '' })); return { posts: hcs };" }];
    const out = WU.detectNeverExtractedFields(steps, WELL_FORMED);
    assert.ok(out.some((f) => f.path === 'posts.hoverCards[].role'),
      'the 47th-log nested lint fires once the schema is well-formed: ' + JSON.stringify(out));
  });
});

function makeDepsF1() {
  return {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async () => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: { posts: [{ t: 1 }] }, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
    getDraftService: () => null,
    applyArtifact: () => {},
    getTestInput: () => null,
    getOutputSchema: () => null,
    getSteps: () => [],
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
  };
}

// ---------------------------------------------------------------------------
// F3: implausible time-field census
describe('F3: detectImplausibleTimeFields (fifty-second log)', () => {
  const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: {
    postId: { type: 'string' }, postTime: { type: 'string' }, createdAt: { type: 'string' }, title: { type: 'string' }
  } } } } };

  it('flags the m.me/J9BIhwx6i garbage concats while real and relative dates pass', () => {
    const data = { posts: [
      { postId: '1', postTime: 'm.meCatMachine Learning (ML) Explained | Types, Workflow & Algorithms', title: 'a' },
      { postId: '2', postTime: 'J9BIhwx6i.comCatMachine learning is easier to understand if you built a model', title: 'b' },
      { postId: '3', postTime: 'a day ago', title: 'c' },
      { postId: '4', postTime: 'June 25', title: 'd' },
      { postId: '5', postTime: 'August 9', title: 'e' }
    ] };
    const out = WU.detectImplausibleTimeFields(data, SCHEMA);
    assert.ok(out && out.length === 1, 'one time field flagged: ' + JSON.stringify(out));
    assert.equal(out[0].field, 'postTime');
    assert.equal(out[0].implausibleCount, 2, 'only the two garbage concats');
    assert.ok(out[0].sample.length > 0, 'carries a sample');
    assert.ok(/labelledby|anchor|date/i.test(out[0].note), 'note names the mechanism and the fix');
  });

  it('CJK time values (2026年6月25日 / 3小时前) are plausible', () => {
    const data = { posts: [
      { postId: '1', postTime: '2026年6月25日', title: 'a' },
      { postId: '2', postTime: '3小时前', title: 'b' },
      { postId: '3', postTime: '2026-06-25 14:30', title: 'c' }
    ] };
    assert.equal(WU.detectImplausibleTimeFields(data, SCHEMA), null);
  });

  it('non-time fields are invisible; empty values are the partial-empty census\'s business', () => {
    const data = { posts: [
      { postId: '', postTime: '', title: 'plain title with no date words at all just text' }
    ] };
    assert.equal(WU.detectImplausibleTimeFields(data, SCHEMA), null);
  });

  it('malformed input → null, never throws', () => {
    assert.equal(WU.detectImplausibleTimeFields(null, SCHEMA), null);
    assert.equal(WU.detectImplausibleTimeFields({ posts: [] }, null), null);
  });

  it('verify wiring: report-only tag TIME_FIELD_IMPLAUSIBLE on a green run', async () => {
    const data = { posts: [
      { postId: '1', postTime: 'm.meCatMachine Learning Explained', title: 'a' },
      { postId: '2', postTime: 'm.meCatAnother Title Here', title: 'b' },
      { postId: '3', postTime: 'June 25', title: 'c' }
    ] };
    const schema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
      postId: { type: 'string' }, postTime: { type: 'string' }
    } } } } };
    const runner = makeRunnerF3(async () => ({
      finalResult: data,
      steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
      pages: []
    }));
    const out = await runner({ service: SERVICE_F3, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, true, 'report-only');
    assert.ok(Array.isArray(out.report.detectors.implausibleTimeFields) && out.report.detectors.implausibleTimeFields.length === 1);
    assert.ok(out.report.events.includes('TIME_FIELD_IMPLAUSIBLE'), 'tags: ' + JSON.stringify(out.report.events));
  });

  it('knowledge unit time-field-implausible exists, keyed to the tag', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'time-field-implausible');
    assert.ok(u, 'unit exists');
    assert.ok(u.matchEvents.includes('TIME_FIELD_IMPLAUSIBLE'));
    assert.ok(/date-shape|shape/i.test(u.body), 'teaches filtering candidates by date shape');
  });
});

function makeRunnerF3(orchestrateImpl) {
  const deps = {
    orchestrate: orchestrateImpl,
    ensureLock: async () => {},
    getSignal: () => null,
    log: () => {},
    onEvent: () => {},
    createTab: async (url) => ({ id: 11, url }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true
  };
  return createVerifyRunner(deps);
}
const SERVICE_F3 = { targetUrl: 'https://example.com', steps: [
  { id: 'extract', name: 'extract', script: 'return 1', onSuccess: 'TERMINATE' }
], config: {} };

// ---------------------------------------------------------------------------
// F2: stagnation advisory (three identical consecutive verify disclosures)
describe('F2: stagnation advisory in session verify (fifty-second log)', () => {
  function makeSessionDeps() {
    const calls = { probes: 0, verifies: 0 };
    const deps = makeDepsF1();
    deps.getDraftService = () => ({ name: 's', steps: [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }] });
    deps.getOutputSchema = () => null;
    deps.getTestInput = () => ({});
    deps.runVerify = async () => {
      calls.verifies += 1;
      return {
        report: {
          ok: false, error: null, aborted: false, // 134th log: the stagnation census is RED-only — a green verify's stable disclosures are the accepted ship
          score: { score: 154, isData: true, breakdown: {} },
          schemaOk: true, schemaMissing: [],
          detectors: { emptyFields: [], duplicateFields: [], countShortfall: null,
            partialEmptyFields: [
              { field: 'location', path: 'posts.location', emptyCount: 5, totalCount: 5, emptyRatio: 1, sampleNonEmpty: null, emptyRecordSamples: [] },
              { field: 'role', path: 'posts.hoverCards[].role', emptyCount: 10, totalCount: 10, emptyRatio: 1, sampleNonEmpty: null, emptyRecordSamples: [] }
            ] },
          steps: [], finalResult: { posts: [{ postId: '1' }] }, pages: '1', eventCount: 1, events: []
        },
        events: [], raw: {}
      };
    };
    return { deps, calls };
  }

  it('the THIRD consecutive identical partial-empty signature appends the stagnation advisory + tag', async () => {
    const { deps } = makeSessionDeps();
    const t = createSessionTools(deps);
    const r1 = await t.tools['verify.run']({});
    assert.ok(!r1.stagnationNote, 'first verify: no advisory');
    const r2 = await t.tools['verify.run']({});
    assert.ok(!r2.stagnationNote, 'second verify: no advisory yet');
    const r3 = await t.tools['verify.run']({});
    assert.ok(r3.stagnationNote, 'third identical verify: advisory fires');
    assert.match(r3.stagnationNote, /posts\.location/);
    assert.match(r3.stagnationNote, /hoverCards\[\]\.role|role/);
    assert.match(r3.stagnationNote, /io\.confirm|renegotiat|probe/i, 'teaches the exits: probe the research tab / renegotiate / accept+disclose');
    assert.ok((r3.events || []).includes('STAGNANT_DISCLOSURES'), 'tag attached: ' + JSON.stringify(r3.events));
  });

  it('a CHANGED signature resets the counter (no false sticky advisory)', async () => {
    const { deps } = makeSessionDeps();
    const t = createSessionTools(deps);
    await t.tools['verify.run']({});
    await t.tools['verify.run']({});
    // third verify comes back with a DIFFERENT partial-empty set
    deps.runVerify = async () => ({
      report: { ok: false, error: null, aborted: false, score: { score: 160, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], // 134th log: the stagnation census is RED-only — a green verify's stable disclosures are the accepted ship
        detectors: { emptyFields: [], duplicateFields: [], countShortfall: null,
          partialEmptyFields: [{ field: 'location', path: 'posts.location', emptyCount: 2, totalCount: 5, emptyRatio: 0.4, sampleNonEmpty: 'x', emptyRecordSamples: [] }] },
        steps: [], finalResult: { posts: [{ postId: '1' }] }, pages: '1', eventCount: 1, events: [] },
      events: [], raw: {}
    });
    const r3 = await t.tools['verify.run']({});
    assert.ok(!r3.stagnationNote, 'signature changed — counter reset, no advisory');
  });

  it('verify events array is exposed on the result (tag plumbing)', async () => {
    const { deps } = makeSessionDeps();
    const t = createSessionTools(deps);
    const r = await t.tools['verify.run']({});
    assert.ok(Array.isArray(r.events), 'verify result carries events');
  });
});

// universality guard
describe('universality: fifty-second-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('new detectors + units stay generic', () => {
    const wuSrc = fs.readFileSync(path.join(__dirname, '../lib/wizard-utils.js'), 'utf8').replace(/\0/g, '');
    for (const marker of ['detectStrayFieldDeclarations', 'detectImplausibleTimeFields']) {
      const i = wuSrc.indexOf('function ' + marker);
      assert.ok(i > -1, marker + ' present');
      assert.ok(!FORBIDDEN.test(wuSrc.slice(i, i + 2500)), marker + ' generic');
    }
    for (const id of ['time-field-implausible', 'stagnant-disclosures']) {
      const u = KNOWLEDGE_UNITS.find((x) => x.id === id);
      assert.ok(u, id + ' unit exists');
      assert.ok(!FORBIDDEN.test(u.id + ' ' + u.title + ' ' + u.body + ' ' + u.matchEvents.join(' ')), id + ' generic');
    }
  });
});
