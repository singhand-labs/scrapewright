// extension/test/hundred-thirty-ninth-log-unique-count-quality.test.js
//
// 139th log — first green session on the 138-deadline-guard build (v7
// verified green, completed with honest disclosure) whose DELIVERABLE still
// carried four quality defects the report-only lanes surfaced but nothing
// enforced:
//
// A. COUNT INFLATION BY DUPLICATES: count=7 asked, 7 records delivered, but
//    only 4 UNIQUE posts — the feed served the same posts in repeated render
//    states (expanded + collapsed), three duplicate pairs {1,3}{2,4}{5,7}.
//    detectCountShortfall compared RECORD counts (7>=7 → pass). The model's
//    own id-keyed dedupe passed every empty-postId record through.
// B. URL-TOKEN BLINDNESS: the {2,4} pair carries the same pfbid permalink
//    with DIFFERENT per-render __cft__ query tokens — exact-string id
//    grouping caught the pair in one verify (v6) and missed it in the next
//    (v7), and the deployed output still contained it.
// C. LABEL-PREFIXED COUNT SHIP: likes shipped "Like: 129 people" on 7/7
//    behind a green verify; LABEL_PREFIXED_COUNT is report-only for optional
//    fields and the finish summary omitted it entirely.
// D. SYNTHETIC REQUIRED FIELD: the confirmed contract declared
//    items.required=[index,content,html] — the loop-generated bookkeeping
//    field as REQUIRED (rule 10 forbids declaring it; prompt-only teaching
//    did not stop the model). Media arrays also carried the same sprite URL
//    6x within one record and emoji assets across most records.
//
// Fixes under test:
//   A1. detectDuplicateIdValues: URL ids compared WITHOUT query tokens.
//   A2. content-signature lane (content head-40 + count value) catches
//       empty-id/mixed pairs as kind:'contentSignature'.
//   A3. countUniqueRecords: union-find over id-equality AND signature-
//       equality (transitive — either alone leaves a pair unmerged).
//   A4. detectCountShortfall: uniqueExtracted vs requested with the
//       KEEP COLLECTING UNIQUE disclosure (verify-runner preserves the note
//       across the provenance branches).
//   C1. LABEL_PREFIXED_COUNT_REQUIRED veto when the count field is REQUIRED.
//   C2. finish disclosure ladder carries label-prefixed counts and duplicate
//       items (research-session state harvest).
//   D1. media-array hygiene census (within-record dup URLs + cross-record
//       shared assets) — report-only.
//   D2. io.confirm panel warning + service.update staticLint advisory for
//       bookkeeping names in items.required.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const WU = require('../lib/wizard-utils');
const ST = require('../lib/session-tools');
const RS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
const VR_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['index', 'content', 'html'],
  properties: {
    index: { type: 'number' }, postId: { type: 'string' }, postTime: { type: 'string' },
    content: { type: 'string' }, likes: { type: 'string' },
    mediaUrls: { type: 'array', items: { type: 'string' } }, html: { type: 'string' }
  } } } } };

const SCHEMA_REQ_LIKES = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['content', 'likes'],
  properties: { postId: { type: 'string' }, content: { type: 'string' }, likes: { type: 'string' } } } } } };

const CFT = '?__cft__[0]=AZxyz';
const mk = (i, pid, c, t, l, media, html) => ({
  index: i, postId: pid, postTime: t, content: c, likes: l,
  mediaUrls: media || [], html: html || '<div/>'
});

// The incident's record shape: 7 records, 4 unique posts.
const INCIDENT_POSTS = () => ([
  mk(1, '', 'Learn Advanced Deep Learning- https://www.mltut.com/best-advanced-deep-learning-courses/@followers #deeplearning', '', 'Like: 129 people', ['https://cdn.example/sprite.png', 'https://cdn.example/photo1.jpg', 'https://cdn.example/sprite.png']),
  mk(2, 'https://social.example/alitheanalyst/posts/pfbid02ABC' + CFT + '1', 'Don’t Just Memorize Machine Learning Algorithms. Understand When to Use Them. full text', 'Sep 15', 'Like: 71 people', ['https://cdn.example/sprite.png', 'https://cdn.example/2705.png', 'https://cdn.example/2705.png']),
  mk(3, 'https://social.example/mltutblogs/posts/pfbid0DB1', 'Learn Advanced Deep Learning- https://www.mltut.com/best-advanced-deep-learning-courses/… See more', 'Sep 24', 'Like: 129 people', ['https://cdn.example/sprite.png']),
  mk(4, 'https://social.example/alitheanalyst/posts/pfbid02ABC' + CFT + '2', 'Don’t Just Memorize Machine Learning Algorithms. Understand When to Use Them.… See more', 'Sep 15', 'Like: 71 people', ['https://cdn.example/sprite.png', 'https://cdn.example/2705.png']),
  mk(5, '', '9 Machine Learning Algorithms You Must KnowMachine Learning becomes much easier once', 'Sep 23', 'Like: 15 people'),
  mk(6, '', 'What is Machine Learning? ML is a branch of AI intro text', 'Aug 24', 'Like: 5 people'),
  mk(7, '', '9 Machine Learning Algorithms You Must Know… See more', 'Sep 23', 'Like: 15 people')
]);

describe('139th log A — duplicate detection across identity surfaces', () => {
  it('URL ids are compared WITHOUT query tokens (the {2,4} pair collides across differing __cft__ tokens)', () => {
    const dups = WU.detectDuplicateIdValues({ posts: INCIDENT_POSTS() }, SCHEMA);
    const idLane = dups.find((d) => !d.kind && d.field === 'postId');
    assert.ok(idLane, 'id-lane entry present');
    assert.deepEqual(idLane.indices, [2, 4], 'the pfbid pair with different query tokens is one group');
    assert.match(idLane.note, /WITHOUT their query tokens/);
    assert.equal(WU.normalizeIdValueForIdentity('https://x/p?__cft__=1'), 'https://x/p');
    assert.equal(WU.normalizeIdValueForIdentity('plain-token-123'), 'plain-token-123');
  });

  it('the content-signature lane catches the empty-id and mixed pairs {1,3} and {5,7}', () => {
    const dups = WU.detectDuplicateIdValues({ posts: INCIDENT_POSTS() }, SCHEMA);
    const sigLanes = dups.filter((d) => d.kind === 'contentSignature');
    const idxSets = sigLanes.map((d) => d.indices.join(',')).sort();
    assert.ok(idxSets.indexOf('1,3') !== -1, 'mixed empty-id/id pair caught — got ' + idxSets.join(' | '));
    assert.ok(idxSets.indexOf('5,7') !== -1, 'both-empty-id pair caught');
    assert.match(sigLanes[0].note, /id-keyed dedupe passed it through/);
  });

  it('countUniqueRecords unions BOTH equalities (transitive): the incident shape is 4, not 5 or 7', () => {
    const itemProps = SCHEMA.properties.posts.items.properties;
    assert.equal(WU.countUniqueRecords(INCIDENT_POSTS(), itemProps), 4);
    // all-distinct records stay distinct
    const distinct = [mk(1, 'a1', 'content one', 't1', 'l1'), mk(2, 'a2', 'content two', 't2', 'l2'), mk(3, 'a3', 'content three', 't3', 'l3')];
    assert.equal(WU.countUniqueRecords(distinct, itemProps), 3);
  });
});

describe('139th log A4 — countShortfall counts UNIQUE items', () => {
  it('7 records / 4 unique vs count=7 → shortfall with uniqueExtracted + the keep-collecting teaching', () => {
    const cs = WU.detectCountShortfall({ posts: INCIDENT_POSTS() }, { keyword: 'machine learning', count: 7 }, SCHEMA);
    assert.ok(cs, 'shortfall detected');
    assert.equal(cs.extracted, 7);
    assert.equal(cs.uniqueExtracted, 4);
    assert.match(cs.note, /only 4 UNIQUE item/);
    assert.match(cs.note, /KEEP COLLECTING unique items/);
  });

  it('records meeting the ask with all-unique items → no shortfall', () => {
    const unique7 = [];
    for (let i = 1; i <= 7; i++) unique7.push(mk(i, 'id' + i, 'distinct content number ' + i, 't' + i, 'Like: ' + i));
    const cs = WU.detectCountShortfall({ posts: unique7 }, { count: 7 }, SCHEMA);
    assert.equal(cs, null);
  });

  it('the record-count shortfall branch is unchanged (5 records for count=7)', () => {
    const five = INCIDENT_POSTS().slice(0, 5);
    const cs = WU.detectCountShortfall({ posts: five }, { count: 7 }, SCHEMA);
    assert.equal(cs.extracted, 5);
    assert.equal(cs.uniqueExtracted, undefined, 'record-count branch carries no uniqueExtracted');
  });

  it('verify-runner preserves the unique note across the provenance branches (source audit)', () => {
    assert.match(VR_SRC, /uniqueShortfallNote/, 'the preserve variable exists');
    assert.ok(VR_SRC.indexOf('uniqueShortfallNote') < VR_SRC.indexOf("detectors.countShortfall.note = 'containers matched '"),
      'the unique note is captured BEFORE the branches can overwrite');
  });
});

describe('139th log C — LABEL_PREFIXED_COUNT promotion + finish disclosure', () => {
  it('a REQUIRED count field shipping the label prefix is a veto (verify-runner source audit + message shape)', () => {
    assert.match(VR_SRC, /LABEL_PREFIXED_COUNT_REQUIRED/);
    // the veto resolves required-ness through schemaItemRequiredForPath like the siblings
    const i = VR_SRC.indexOf('LABEL_PREFIXED_COUNT_REQUIRED');
    const region = VR_SRC.slice(i - 900, i);
    assert.match(region, /schemaItemRequiredForPath/);
  });

  it('the optional-field lane stays report-only (detectLabelPrefixedCounts unchanged behavior)', () => {
    const lpc = WU.detectLabelPrefixedCounts({ posts: INCIDENT_POSTS() }, SCHEMA);
    assert.ok(lpc && lpc.length === 1);
    assert.equal(lpc[0].field, 'likes');
    assert.equal(lpc[0].count, 7);
    assert.equal(lpc[0].parsedSample, '129');
  });

  it('finish disclosure harvests labelPrefixedCounts and duplicateIdValues into the shipped detail (source audit)', () => {
    assert.match(RS_SRC, /lastVerifyLabelPrefixedCounts/, 'label-prefix state harvested');
    assert.match(RS_SRC, /lastVerifyDuplicateIds/, 'duplicate-id state harvested');
    assert.match(RS_SRC, /VERIFY DUPLICATE-ITEMS/);
    assert.match(RS_SRC, /VERIFY LABEL-PREFIXED-COUNTS/);
    // both consumption sites: the coercion ladder and the finish detail
    const n = (RS_SRC.match(/VERIFY LABEL-PREFIXED-COUNTS/g) || []).length;
    assert.ok(n >= 2, 'both disclosure sites carry it (' + n + ')');
  });
});

describe('139th log D — media hygiene + synthetic-required warning', () => {
  it('detectMediaArrayHygiene flags within-record duplicate URLs and cross-record shared assets', () => {
    const mh = WU.detectMediaArrayHygiene({ posts: INCIDENT_POSTS() }, SCHEMA);
    assert.ok(mh, 'census fires on the incident shape');
    assert.ok(mh.duplicateInRecord.some((d) => d.record === 1 && /sprite\.png/.test(d.urls[0])), 'record 1 duplicated sprite flagged');
    assert.ok(mh.duplicateInRecord.some((d) => d.record === 2 && /2705\.png/.test(d.urls[0])), 'record 2 duplicated asset flagged');
    // sprite.png appears in records 1,2,3,4 = 4/7 >= 60%? no — threshold is ceil(0.6*7)=5.
    // Make a shared-asset case explicit:
    const shared = [];
    for (let i = 1; i <= 5; i++) shared.push(mk(i, 'id' + i, 'content ' + i, 't', 'l', ['https://cdn.example/emoji.png', 'https://cdn.example/p' + i + '.jpg']));
    const mh2 = WU.detectMediaArrayHygiene({ posts: shared }, SCHEMA);
    assert.ok(mh2.sharedAssets.some((a) => /emoji\.png/.test(a.url) && a.records === 5), 'a URL in 5/5 records is a shared page asset');
    assert.match(mh2.sharedAssets[0].note, /PAGE CHROME/);
  });

  it('verify-runner wires the census + tag (source audit)', () => {
    assert.match(VR_SRC, /detectors\.mediaHygiene = mh/);
    assert.match(VR_SRC, /add\('MEDIA_ARRAY_HYGIENE'\)/);
  });

  it('io.confirm warns when items.required carries a bookkeeping field; clean contracts carry no warning', async () => {
    const panels = [];
    const deps = {
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ ok: true }) }),
      getDraftService: () => null, applyArtifact: () => {},
      getTestInput: () => ({}), getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => { panels.push(p); return { confirmed: true }; } }
    };
    const tools = ST.createSessionTools(deps).tools;
    await tools['io.confirm']({ inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
        required: ['index', 'content', 'html'], properties: { index: { type: 'number' }, content: { type: 'string' }, html: { type: 'string' } } } } } },
      note: 'incident contract' });
    assert.ok(panels.length === 1);
    const warn = (panels[0].diffLines || []).find((l) => /SYNTHETIC REQUIRED FIELD/.test(l));
    assert.ok(warn, 'panel warning present');
    assert.match(warn, /index/);
    // clean contract: no warning
    await tools['io.confirm']({ inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
        required: ['postId', 'content'], properties: { postId: { type: 'string' }, content: { type: 'string' } } } } } },
      note: 'clean' });
    const warn2 = (panels[1].diffLines || []).find((l) => /SYNTHETIC REQUIRED FIELD/.test(l));
    assert.equal(warn2, undefined, 'no warning on a clean contract');
  });
});
