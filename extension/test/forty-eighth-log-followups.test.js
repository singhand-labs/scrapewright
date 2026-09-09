'use strict';
// Forty-eighth log (2026-09-09 12:04-12:20, console.log 598KB): the session
// died at 60/60 turns with REQUIRED_FIELD_EMPTY posts.postId 2/4 — while the
// CORRECT id regex had sat inside the step since v7.
//
//   RC-1 (dominant) probe.extract accepts {multi:true} and returns arrays;
//        the SERVICE DSL fieldMap ($extractList/$extractWithHover via
//        extractListRecords) is first-match scalar. The model grounded the
//        right id regex through a multi probe (turn 54: photo posts carry
//        fbid=, reels /reel/N, stories /stories/N), wrote the SAME fieldMap
//        shape into the step (hrefs:{selector:"a[href]",attr:"href"}), got a
//        scalar string back, and its `for (const h of hrefs)` iterated
//        CHARACTERS — silent dead code shipped through three artifact
//        versions while every verify said 2/4.
//   RC-2 posts.postId was empty in exactly records #2/#4 across FIVE
//        verifies; partialEmptyFields carried sampleNonEmpty (a WORKING
//        sample) but never WHICH records were empty — five blind regex
//        rewrites, zero research-tab probes in between.
//   RC-3 v6's verify was vetoed by CLICK_CONTAINERS_EMPTY (the expand
//        step's $clickInList ran before the feed mounted: container matched
//        0) while the SAME run's extract step matched the SAME container
//        selector 4× — a mount-timing transient flipped a completed run
//        red AND the error path skipped every census, so that round
//        produced no field evidence at all.
//
// F1 fieldMap spec {multi:true} → all-matches arrays per field (probe↔DSL
//    parity restored at the shared ops layer)
// F2 detectEmptyOutputFieldsByRatio entries gain emptyRecordSamples
//    [{index, hint}] (nested: parentIndex/subIndex) and the
//    REQUIRED_FIELD_EMPTY message names the failing record indices
// F3 CLICK_CONTAINERS_EMPTY corroborated by a same-run later-step match on
//    the same container selector downgrades to advisory
//    CLICK_CONTAINERS_TRANSIENT, and report-only censuses run even when a
//    gate has flipped the run red

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const OPS = require('../lib/list-extract-ops');
const WU = require('../lib/wizard-utils');
const { createVerifyRunner } = require('../lib/verify-runner');

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

// ---------------------------------------------------------------------------
// F1: fieldMap {multi:true}
describe('F1: extractListRecords fieldMap multi:true', () => {
  it('returns ALL attr matches for a multi field while sibling scalars stay first-match', () => {
    setupDOM(`<!DOCTYPE html><html><body>
      <div class="card">
        <a href="/u/alice">alice</a>
        <a href="/photo/?fbid=111222333444555&amp;set=a.1">photo</a>
        <a href="/reel/999888777666">reel</a>
        <span class="title">hello</span>
      </div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const records = OPS.extractListRecords(containers, {
      firstLink: { selector: 'a', attr: 'href' },
      hrefs: { selector: 'a[href]', attr: 'href', multi: true },
      title: '.title'
    });
    assert.equal(records[0].firstLink, '/u/alice', 'scalar sibling unchanged');
    assert.equal(records[0].title, 'hello');
    assert.deepEqual(records[0].hrefs, [
      '/u/alice',
      '/photo/?fbid=111222333444555&set=a.1',
      '/reel/999888777666'
    ], 'multi field carries every match in document order');
  });

  it('multi textContent fields collect trimmed texts; zero matches yield []', () => {
    setupDOM(`<!DOCTYPE html><html><body>
      <div class="card"><span class="tag">a</span><span class="tag">b</span><i>x</i></div>
      <div class="card"><i>y</i></div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const records = OPS.extractListRecords(containers, {
      tags: { selector: '.tag', multi: true }
    });
    assert.deepEqual(records[0].tags, ['a', 'b']);
    assert.deepEqual(records[1].tags, [], 'no matches → empty array, not undefined');
  });

  it('multi + labelledby resolves the ARIA reference on EVERY match', () => {
    setupDOM(`<!DOCTYPE html><html><body>
      <div class="card">
        <span id="lbl-a">hidden value one</span>
        <span id="lbl-b">hidden value two</span>
        <a class="ref" aria-labelledby="lbl-a">x</a>
        <a class="ref" aria-labelledby="lbl-b">y</a>
      </div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const records = OPS.extractListRecords(containers, {
      labels: { selector: '.ref', labelledby: true, multi: true }
    });
    assert.deepEqual(records[0].labels, ['hidden value one', 'hidden value two']);
  });

  it('$extractWithHover carries multi fields beside hovercards (the 48th-log shape)', async () => {
    setupDOM(`<!DOCTYPE html><html><body>
      <div class="card">
        <span id="t-1">June 17 at 10:15 AM</span>
        <a class="anchor" aria-labelledby="t-1">ts</a>
        <a href="/photo/?fbid=111222333444555">permalink</a>
        <a href="/u/alice">author</a>
      </div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const records = await OPS.extractWithHoverRecords(
      containers,
      { hrefs: { selector: 'a[href]', attr: 'href', multi: true } },
      { anchorSel: '.anchor' },
      async () => ({ hovered: false, htmlSnippet: null, reason: 'no_popover' }),
      {}
    );
    assert.equal(records.length, 1);
    assert.ok(Array.isArray(records[0].hrefs), 'multi survives the hover pipeline');
    assert.deepEqual(records[0].hrefs, ['/photo/?fbid=111222333444555', '/u/alice']);
    assert.equal(records[0].hovercards.length, 1, 'anchor still harvested');
  });

  it('cold-tab re-read heals an all-empty multi labelledby field from the post-hover DOM', async () => {
    const dom = setupDOM(`<!DOCTYPE html><html><body>
      <div class="card"><a class="anchor">ts</a></div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const records = await OPS.extractWithHoverRecords(
      containers,
      { labels: { selector: '.anchor', labelledby: true, multi: true } },
      { anchorSel: '.anchor' },
      async () => {
        // The hover "mounts" the lazily-hydrated ARIA reference target.
        const span = document.createElement('span');
        span.id = 'mounted-lbl';
        span.textContent = 'September 3 at 8:00 AM';
        document.body.appendChild(span);
        containers[0].querySelector('.anchor').setAttribute('aria-labelledby', 'mounted-lbl');
        return { hovered: true, htmlSnippet: '<div>card</div>' };
      },
      {}
    );
    assert.deepEqual(records[0].labels, ['September 3 at 8:00 AM'],
      'all-empty multi labelledby array is re-read post-hover and filled');
    assert.equal(records[0].hovercards.length, 1);
    dom.window.close();
  });

  it('diagnostics: a multi field reports multi:true and samples every match of the first container', () => {
    setupDOM(`<!DOCTYPE html><html><body>
      <div class="card"><a href="/u/a">1</a><a href="/photo/?fbid=123">2</a><a href="/reel/456">3</a></div>
      <div class="card"><a href="/u/z">9</a></div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const diag = OPS.computeExtractListDiagnostics(containers, {
      hrefs: { selector: 'a[href]', attr: 'href', multi: true },
      first: { selector: 'a', attr: 'href' }
    }, '.card', false);
    const m = diag.perField.find((f) => f.field === 'hrefs');
    assert.equal(m.multi, true);
    assert.deepEqual(m.sampleValues, ['/u/a', '/photo/?fbid=123', '/reel/456'],
      'every match of the first container is sampled, not just the first');
    const s = diag.perField.find((f) => f.field === 'first');
    assert.equal(s.multi, undefined, 'scalar fields gain no multi flag');
  });

  it('content-script inline mirror carries the same multi routing and array-aware re-read', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
    const readField = src.slice(src.indexOf('function readField('), src.indexOf('function readFieldAll('));
    assert.ok(/multi/.test(readField), 'inline readField routes multi specs');
    const hover = src.slice(src.indexOf('function extractWithHoverRecords('), src.indexOf('function clickInListItems('));
    assert.ok(/multi/.test(hover), 'inline cold re-read is array-aware for multi fields');
  });

  it('the DSL guide teaches field-level multi:true beside $extractListMulti', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
    const listLine = src.split('\n').find((l) => l.includes('$extractList(containerSel'));
    assert.ok(listLine && /multi:\s*true/.test(listLine),
      '$extractList doc line must teach the per-field multi:true flag');
    const hoverLine = src.split('\n').find((l) => l.includes('$extractWithHover(containerSel'));
    assert.ok(hoverLine && /multi:\s*true/.test(hoverLine),
      '$extractWithHover doc line must teach the per-field multi:true flag');
  });
});

// ---------------------------------------------------------------------------
// F2: emptyRecordSamples
describe('F2: emptyRecordSamples fingerprints', () => {
  const SCHEMA = {
    type: 'object', required: ['posts'],
    properties: {
      posts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['postId'],
          properties: {
            postId: { type: 'string' },
            content: { type: 'string' },
            kind: { type: 'string' },
            cards: { type: 'array' }
          }
        }
      }
    }
  };

  const makePosts = () => [
    { postId: '111222333444555', content: 'video post body text', kind: 'video' },
    { postId: '', content: 'fall has officially arrived and the porch is ready', kind: 'photo' },
    { postId: '999888777666', content: 'reel body', kind: 'reel' },
    { postId: '', content: 'text only note to friends', kind: 'text' }
  ];

  it('names WHICH records are empty, with a content hint each', () => {
    const out = WU.detectEmptyOutputFieldsByRatio({ posts: makePosts() }, SCHEMA);
    const pid = out.find((e) => e.path === 'posts.postId');
    assert.ok(pid, 'postId 2/4 censused');
    assert.ok(Array.isArray(pid.emptyRecordSamples) && pid.emptyRecordSamples.length === 2,
      'one fingerprint per EMPTY record, got: ' + JSON.stringify(pid.emptyRecordSamples));
    assert.equal(pid.emptyRecordSamples[0].index, 2, '1-based record ordinal');
    assert.ok(/^fall has officially/.test(pid.emptyRecordSamples[0].hint));
    assert.equal(pid.emptyRecordSamples[1].index, 4);
  });

  it('caps hints at 60 chars and samples at 3 records', () => {
    const posts = Array.from({ length: 6 }, (_, i) => ({
      postId: i === 0 ? 'x' : '',
      content: 'c'.repeat(200)
    }));
    const out = WU.detectEmptyOutputFieldsByRatio({ posts }, SCHEMA);
    const pid = out.find((e) => e.path === 'posts.postId');
    assert.equal(pid.emptyRecordSamples.length, 3);
    for (const s of pid.emptyRecordSamples) assert.ok(s.hint.length <= 60);
  });

  it('nested census entries fingerprint the PARENT record and card ordinal', () => {
    const posts = [
      { postId: 'a1', content: 'parent one', cards: [{ type: 'ok' }, { type: 'ok' }] },
      { postId: 'b2', content: 'parent two', cards: [{ type: '' }, { type: '' }] }
    ];
    const out = WU.detectEmptyOutputFieldsByRatio({ posts }, SCHEMA);
    const t = out.find((e) => e.path === 'posts.cards[].type');
    assert.ok(t, 'nested census fired');
    assert.ok(Array.isArray(t.emptyRecordSamples) && t.emptyRecordSamples.length >= 1);
    const s = t.emptyRecordSamples[0];
    assert.equal(s.parentIndex, 2, 'the parent whose cards are empty');
    assert.equal(s.subIndex, 1, '1-based card ordinal inside the parent');
    assert.ok(/parent two/.test(s.hint), 'hint drawn from the parent record');
  });

  it('REQUIRED_FIELD_EMPTY message names the failing record indices', async () => {
    const deps = {
      orchestrate: async () => ({
        finalResult: { posts: makePosts() },
        steps: [{ stepId: 's1', stepName: 'one', result: { done: true } }],
        pages: []
      }),
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
    const runner = createVerifyRunner(deps);
    const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
    const out = await runner({ service: SERVICE, input: { count: 4 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /REQUIRED_FIELD_EMPTY/);
    assert.match(out.report.error.message, /#2/);
    assert.match(out.report.error.message, /#4/);
  });
});

// ---------------------------------------------------------------------------
// F3: container-zero corroboration + census on red runs
function evt(stepId, selectorDiagnostics) {
  return { type: 'STEP_ITERATION', stepId, selectorDiagnostics, resultPreview: '{}' };
}

const CONTAINER_SEL = 'div[role="feed"] article';

function eventsTransient() {
  return [
    evt('expand', [{ api: 'clickInList', containerSelector: CONTAINER_SEL, containerMatches: 0, subSelector: 'button.more' }]),
    evt('scroll', [{ api: 'count', selector: CONTAINER_SEL, matchCount: 4 }]),
    evt('extract', [{ api: 'extractWithHover', containerSelector: CONTAINER_SEL, containerMatches: 4, perField: [] }])
  ];
}

function eventsGenuine() {
  return [
    evt('expand', [{ api: 'clickInList', containerSelector: CONTAINER_SEL, containerMatches: 0, subSelector: 'button.more' }]),
    evt('extract', [{ api: 'extractWithHover', containerSelector: 'div.other', containerMatches: 3, perField: [] }])
  ];
}

function makeRunner(eventsToEmit, finalResult) {
  const deps = {
    orchestrate: async (service, input, orchDeps, options) => {
      for (const e of eventsToEmit) options.onEvent(e);
      return {
        finalResult,
        steps: [{ stepId: 'extract', stepName: '提取', result: { done: true } }],
        pages: []
      };
    },
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

const HEALTHY = { posts: [{ postId: 'a', content: 'body one' }, { postId: 'b', content: 'body two' }] };
const PARTIAL = { posts: [{ postId: 'a', content: 'body one' }, { postId: '', content: 'photo post body' }] };

const SERVICE = { targetUrl: 'https://example.com', steps: [
  { id: 'expand', name: '展开', script: 'return 1', onSuccess: 'scroll' },
  { id: 'scroll', name: '滚动', script: 'return 1', onSuccess: 'extract' },
  { id: 'extract', name: '提取', script: 'return 1', onSuccess: 'TERMINATE' }
], config: {} };

const SCHEMA_F3 = {
  type: 'object', required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: { postId: { type: 'string' }, content: { type: 'string' } } } } }
};

describe('F3: CLICK_CONTAINERS_EMPTY corroboration', () => {
  it('corroborateContainerZero finds the same-run later-step match on the same selector', () => {
    const agg = WU.detectClickInListEmptyContainers(eventsTransient());
    assert.ok(agg, 'detector still fires on the aggregate');
    const cor = WU.corroborateContainerZero(eventsTransient(), agg);
    assert.ok(cor && cor.length === 1, 'one corroborating diag');
    assert.equal(cor[0].stepId, 'extract');
    assert.equal(cor[0].containerMatches, 4);
    const none = WU.corroborateContainerZero(eventsGenuine(), WU.detectClickInListEmptyContainers(eventsGenuine()));
    assert.equal(none, null, 'a different selector corroborates nothing');
  });

  it('a corroborated transient stays green with the advisory tag, not a red error', async () => {
    const runner = makeRunner(eventsTransient(), HEALTHY);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_F3 });
    assert.equal(out.report.ok, true, 'the run completed; the zero-match was mount timing');
    assert.equal(out.report.error, null);
    assert.ok(out.report.events.includes('CLICK_CONTAINERS_TRANSIENT'), 'tags: ' + JSON.stringify(out.report.events));
    const cz = out.report.detectors.clickContainersTransient;
    assert.ok(cz && cz.corroborated === true && Array.isArray(cz.corroboratedBy));
    assert.ok(!out.report.events.includes('INPUT_VALUE_SUSPECT'),
      'the page HAS content — the input-value tag would be a false accusation');
  });

  it('an UNcorroborated zero-match still flips red (regression)', async () => {
    const runner = makeRunner(eventsGenuine(), HEALTHY);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_F3 });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /CLICK_CONTAINERS_EMPTY/);
  });

  it('a red run still carries the field census (evidence preserved)', async () => {
    const runner = makeRunner(eventsGenuine(), PARTIAL);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_F3 });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /CLICK_CONTAINERS_EMPTY/);
    assert.ok(Array.isArray(out.report.detectors.partialEmptyFields) && out.report.detectors.partialEmptyFields.length,
      'the census must not be skipped just because a gate went red');
    assert.ok(out.report.events.includes('PARTIAL_EMPTY_FIELDS'));
  });
});

// ---------------------------------------------------------------------------
describe('F-universality: no site-specific terms in the new surface', () => {
  const SITE_RE = /\b(facebook|twitter|linkedin|tiktok|reddit|instagram|weibo|zhihu|douyin)\b|\b(fb|ig)\b/i;

  it('this test file carries no site terms beyond the guard itself', () => {
    const self = fs.readFileSync(__filename, 'utf8')
      .replace(/const SITE_RE[^\n]*;/, '');
    assert.deepEqual(self.match(SITE_RE) || [], []);
  });

  it('the new wizard-utils and list-extract-ops markers stay generic', () => {
    const wu = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    const start = wu.indexOf('function corroborateContainerZero');
    assert.ok(start > -1, 'corroborateContainerZero must exist');
    const body = wu.slice(start, wu.indexOf('\nfunction ', start + 1));
    assert.deepEqual(body.match(SITE_RE) || [], []);
    const ops = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');
    const rf = ops.slice(ops.indexOf('function readField('), ops.indexOf('function readFieldAll('));
    assert.deepEqual(rf.match(SITE_RE) || [], []);
  });
});
