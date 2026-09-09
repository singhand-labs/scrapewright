'use strict';
// Forty-seventh log (2026-09-09, console.log + result.json): green v3 ship
// (score 133) whose richest contract structure was faked or invisible —
//
//   posts[].hoverCards[].type  '' hardcoded 9/9 cards  (never flagged)
//   posts[].hoverCards[].htmlSnippet  52818-66956 chars (OUTPUT_FIELD_SIZE never fired)
//   posts.htmlSnippet == content.slice(0,500)          (text masquerading as DOM)
//
// Root cause: EVERY field-census detector walks depth-1 only. A record field
// whose value is an array of records (hoverCards) is treated as a scalar
// leaf — non-empty array ⇒ "not empty", never size-measured, its sub-fields
// never enumerated — so the exact structure the confirmed contract details
// (per-card classification, per-card markup) is the structure no gate can
// see. The 46th-log detectors fired precisely and only at depth-1
// (posts.location 3/3, posts.postTime 1/3 relative) while depth-2 carried
// the failure.
//
// F1 detectEmptyOutputFieldsByRatio / detectNeverExtractedFields /
//    detectOversizedFields recurse nested record arrays, paths 'a.b[].c'
// F2 REQUIRED_FIELD_EMPTY gate resolves nested paths against the DECLARING
//    array's items.required (posts.hoverCards[].type → hoverCards.items.required)
// F3 detectHtmlFieldsWithoutTags — markup-named fields shipping text with
//    zero '<' (a copy of a sibling field, not captured DOM) — report-only

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WU = require('../lib/wizard-utils');
const { createVerifyRunner } = require('../lib/verify-runner');

// ---------------------------------------------------------------------------
// Fixtures shaped like the incident (generic field names throughout).
const makeCards = (n, over) => Array.from({ length: n }, (_, i) => Object.assign({
  type: '',
  role: 'author',
  link: 'https://example.test/u' + i,
  htmlSnippet: '<div>card ' + i + '</div>'
}, over || {}));

const makePosts = (n, cardOver) => Array.from({ length: n }, (_, i) => ({
  index: i + 1,
  postId: 'https://example.test/p' + i,
  content: 'record body text ' + i,
  location: '',
  mediaUrls: ['https://img.example.test/' + i + '.jpg'],
  hoverCards: makeCards(3, cardOver)
}));

const SCHEMA_LOOSE_HOVER = {
  type: 'object', required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['postId', 'content'],
        properties: {
          postId: { type: 'string' },
          content: { type: 'string' },
          location: { type: 'string' },
          mediaUrls: { type: 'array', items: { type: 'string' } },
          hoverCards: { type: 'array' } // loose: no items declared — data-driven keys
        }
      }
    }
  }
};

const SCHEMA_TYPED_HOVER = {
  type: 'object', required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['postId', 'content'],
        properties: {
          postId: { type: 'string' },
          content: { type: 'string' },
          location: { type: 'string' },
          hoverCards: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string' },
                role: { type: 'string' },
                link: { type: 'string' },
                htmlSnippet: { type: 'string' },
                badge: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }
};

// ---------------------------------------------------------------------------
describe('F1: detectEmptyOutputFieldsByRatio nested record arrays', () => {
  it('flags a sub-field empty across ALL nested records with an a.b[].c path', () => {
    const out = WU.detectEmptyOutputFieldsByRatio({ posts: makePosts(3) }, SCHEMA_LOOSE_HOVER);
    const nestedType = out.find((e) => e.path === 'posts.hoverCards[].type');
    assert.ok(nestedType, 'posts.hoverCards[].type must be censused, got: ' + JSON.stringify(out.map(e => e.path)));
    assert.equal(nestedType.emptyCount, 9, '3 posts × 3 cards, all type:""');
    assert.equal(nestedType.totalCount, 9);
    assert.equal(nestedType.parentRecords, 3, 'discloses how many parent records carry the cards');
  });

  it('counts a schema-DECLARED nested key absent from the data as empty', () => {
    const posts = makePosts(2);
    const out = WU.detectEmptyOutputFieldsByRatio({ posts }, SCHEMA_TYPED_HOVER);
    const badge = out.find((e) => e.path === 'posts.hoverCards[].badge');
    assert.ok(badge, 'declared-but-absent nested key is 9/9-empty-able');
  });

  it('does NOT recurse arrays of primitives (mediaUrls stays a scalar leaf)', () => {
    const out = WU.detectEmptyOutputFieldsByRatio({ posts: makePosts(3) }, SCHEMA_LOOSE_HOVER);
    assert.ok(!out.some((e) => String(e.path).indexOf('mediaUrls') !== -1),
      'string arrays are not record arrays');
  });

  it('keeps depth-1 entries byte-identical (posts.location 3/3 survives beside nested ones)', () => {
    const out = WU.detectEmptyOutputFieldsByRatio({ posts: makePosts(3) }, SCHEMA_LOOSE_HOVER);
    const loc = out.find((e) => e.path === 'posts.location');
    assert.ok(loc && loc.emptyCount === 3 && loc.totalCount === 3);
    assert.equal(loc.parentRecords, undefined, 'depth-1 entries gain no nested context keys');
  });

  it('nested ratio below the threshold emits nothing; non-empty nested values become samples', () => {
    const posts = makePosts(3, { type: 'account' });
    posts[0].hoverCards[1].type = '';
    const out = WU.detectEmptyOutputFieldsByRatio({ posts }, SCHEMA_LOOSE_HOVER);
    assert.ok(!out.some((e) => e.path === 'posts.hoverCards[].type'), '1/9 empty is under 0.5');
    const role = out.find((e) => e.path === 'posts.hoverCards[].role');
    assert.ok(!role, 'role populated 9/9 is not censused');
  });

  it('an empty nested ARRAY on every parent is censused as the parent field empty', () => {
    const posts = makePosts(3).map((p) => Object.assign({}, p, { hoverCards: [] }));
    const out = WU.detectEmptyOutputFieldsByRatio({ posts }, SCHEMA_LOOSE_HOVER);
    const hc = out.find((e) => e.path === 'posts.hoverCards');
    assert.ok(hc, 'the array itself empty 3/3 is the depth-1 signal');
    assert.equal(hc.emptyCount, 3);
    assert.ok(!out.some((e) => String(e.path).startsWith('posts.hoverCards[]')),
      'no nested census over zero cards');
  });
});

describe('F1: detectNeverExtractedFields nested schema paths', () => {
  const STEPS = [{
    id: 's1', name: 'extract',
    script: "const raw = await $extractWithHover('.card', {});\n" +
      "const posts = raw.map((r) => ({\n" +
      "  content: r.content || '',\n" +
      "  hoverCards: (r.hovercards || []).map((h) => ({\n" +
      "    type: '',\n" +
      "    role: h.labelledbyText ? 'author' : 'group',\n" +
      "    link: h.anchorHref || ''\n" +
      "  }))\n" +
      "}));\n" +
      "return { posts };"
  }];

  it('flags a nested field that appears ONLY as a hardcoded string literal', () => {
    const out = WU.detectNeverExtractedFields(STEPS, SCHEMA_TYPED_HOVER);
    const t = out.find((f) => f.path === 'posts.hoverCards[].type');
    assert.ok(t, 'type:"" at depth 2 must be named, got: ' + JSON.stringify(out));
    assert.equal(t.field, 'type');
  });

  it('does not flag nested fields assigned from expressions', () => {
    const out = WU.detectNeverExtractedFields(STEPS, SCHEMA_TYPED_HOVER);
    assert.ok(!out.some((f) => f.path === 'posts.hoverCards[].role'), 'role comes from a ternary');
    assert.ok(!out.some((f) => f.path === 'posts.hoverCards[].link'), 'link from h.anchorHref');
  });

  it('depth-1 literal fields keep their existing path form', () => {
    const steps = [{ id: 's1', name: 'x', script: "return { posts: r.map(p => ({ location: '' })) };" }];
    const out = WU.detectNeverExtractedFields(steps, SCHEMA_TYPED_HOVER);
    assert.ok(out.some((f) => f.path === 'posts.location'));
  });
});

describe('F1: detectOversizedFields nested record arrays', () => {
  it('measures string sub-fields INSIDE nested record arrays', () => {
    const posts = makePosts(2, { htmlSnippet: 'x'.repeat(60000) });
    const out = WU.detectOversizedFields({ posts }, SCHEMA_LOOSE_HOVER);
    const nested = out.find((e) => e.field === 'posts.hoverCards[].htmlSnippet');
    assert.ok(nested, '52-67K card markup must trip OUTPUT_FIELD_SIZE, got: ' + JSON.stringify(out));
    assert.equal(nested.maxLen, 60000);
    assert.equal(nested.total, 6, 'nested record count, not parent count');
  });

  it('short nested strings and depth-1 oversized fields keep their behavior', () => {
    const posts = makePosts(2);
    posts[0].content = 'y'.repeat(30000);
    const out = WU.detectOversizedFields({ posts }, SCHEMA_LOOSE_HOVER);
    assert.ok(!out.some((e) => e.field === 'posts.hoverCards[].htmlSnippet'), '<div>card N</div> is small');
    assert.ok(out.some((e) => e.field === 'posts.content'));
  });
});

// ---------------------------------------------------------------------------
// F2: the REQUIRED_FIELD_EMPTY gate must resolve nested paths against the
// DECLARING array's items.required, not the top-level one.
function makeRunner(orchestrate) {
  const deps = {
    orchestrate,
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

const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };

function orchReturning(posts) {
  return async () => ({
    finalResult: { posts },
    steps: [{ stepId: 's1', stepName: 'one', result: { done: true } }],
    pages: []
  });
}

describe('F2: REQUIRED_FIELD_EMPTY gate on nested paths', () => {
  it('a nested REQUIRED sub-field empty in every card flips ok:false', async () => {
    const runner = makeRunner(orchReturning(makePosts(3)));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_TYPED_HOVER });
    assert.equal(out.report.ok, false, 'hoverCards[].type required + 9/9 empty is a contract violation');
    assert.match(out.report.error.message, /REQUIRED_FIELD_EMPTY/);
    assert.match(out.report.error.message, /posts\.hoverCards\[\]\.type/);
    assert.match(out.report.error.message, /9\/9/);
    assert.match(out.report.error.message, /io\.confirm/);
    assert.ok(out.report.events.includes('PARTIAL_EMPTY_FIELDS'));
  });

  it('nested empty on a NON-required sub-field stays advisory (ok:true, tag present)', async () => {
    const schema = JSON.parse(JSON.stringify(SCHEMA_TYPED_HOVER));
    schema.properties.posts.items.properties.hoverCards.items.required = [];
    const runner = makeRunner(orchReturning(makePosts(3)));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.error, null);
    assert.ok(out.report.events.includes('PARTIAL_EMPTY_FIELDS'));
    const pe = out.report.detectors.partialEmptyFields.find((e) => e.path === 'posts.hoverCards[].type');
    assert.ok(pe, 'advisory census still names the nested empty');
  });
});

// ---------------------------------------------------------------------------
describe('F3: detectHtmlFieldsWithoutTags (markup-named text masquerade)', () => {
  it('flags an html-named field whose non-empty value has no markup, naming the copied-from sibling', () => {
    const posts = makePosts(2).map((p) => Object.assign(p, {
      htmlSnippet: p.content.slice(0, 500)
    }));
    const out = WU.detectHtmlFieldsWithoutTags({ posts }, SCHEMA_LOOSE_HOVER);
    const m = out.find((e) => e.path === 'posts.htmlSnippet');
    assert.ok(m, 'content slice shipped as htmlSnippet must be named, got: ' + JSON.stringify(out));
    assert.equal(m.count, 2);
    assert.equal(m.copiedFrom, 'content', 'the masquerade source is disclosed');
  });

  it('real markup values are not flagged, nor are non-markup-named text fields', () => {
    const posts = makePosts(2).map((p) => Object.assign(p, {
      htmlSnippet: '<div>' + p.content + '</div>',
      summary: p.content.slice(0, 40)
    }));
    const out = WU.detectHtmlFieldsWithoutTags({ posts }, SCHEMA_LOOSE_HOVER);
    assert.equal(out.length, 0);
  });

  it('empty html-named values are left to the empty census (no zero-length masquerade noise)', () => {
    const posts = makePosts(2).map((p) => Object.assign(p, { htmlSnippet: '' }));
    const out = WU.detectHtmlFieldsWithoutTags({ posts }, SCHEMA_LOOSE_HOVER);
    assert.equal(out.length, 0);
  });

  it('walks nested record arrays too (a card-level markup-named text field)', () => {
    const posts = makePosts(2, { htmlSnippet: 'plain card label' });
    const out = WU.detectHtmlFieldsWithoutTags({ posts }, SCHEMA_LOOSE_HOVER);
    const m = out.find((e) => e.path === 'posts.hoverCards[].htmlSnippet');
    assert.ok(m, 'nested markup-named text must be caught, got: ' + JSON.stringify(out));
    assert.equal(m.count, 6);
  });

  it('verify wiring: report-only tag HTML_FIELD_NO_MARKUP fires without flipping ok', async () => {
    const posts = makePosts(3).map((p) => Object.assign(p, { htmlSnippet: p.content.slice(0, 500) }));
    const runner = makeRunner(orchReturning(posts));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_LOOSE_HOVER });
    assert.equal(out.report.ok, true, 'advisory by design — the contract may genuinely want it');
    assert.ok(out.report.events.includes('HTML_FIELD_NO_MARKUP'), 'tags: ' + JSON.stringify(out.report.events));
    assert.ok(out.report.detectors.htmlNoMarkup, 'detector census carried on the report');
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

  it('the new wizard-utils markers and gate text carry no site terms', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    for (const anchor of ['function detectHtmlFieldsWithoutTags', 'function schemaItemRequiredForPath']) {
      const start = src.indexOf(anchor);
      assert.ok(start > -1, anchor + ' must exist');
      const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
      assert.deepEqual(body.match(SITE_RE) || [], [], anchor + ' must stay generic');
    }
  });
});
