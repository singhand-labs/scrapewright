// Regression for RC15 (console.log 2026-07-27 06:28:19 user feedback):
//
// User reported "为空的不正常，修复下抽取" (empty is abnormal, fix the extraction)
// on a Facebook scrape that returned 3 posts. The extracted JSON had:
//   post 1: likes="4",  comments="", shares=""
//   post 2: likes="1",  comments="", shares=""
//   post 3: likes="294", comments="", shares=""
//
// `comments` and `shares` were empty across ALL records, while `likes` and
// other fields were populated. glm-5.1 misread the ambiguous Chinese feedback
// as "not enough posts" and rewrote the SCROLL step instead of fixing the
// extraction selectors — because the prompt had NO data-driven signal naming
// the actual empty fields.
//
// RC13's RECORD HTML only shows the FIRST record. If that record happens to
// have no visible count spans (e.g., post 1 above-threshold for likes but
// below-threshold for comments/shares), the LLM has no example of where the
// missing values live when they ARE present. Even if the LLM read the prompt
// perfectly, RECORD HTML alone cannot show "this field is failing across the
// board" — that's a property of the OUTPUT, not of one record's DOM.
//
// Fix: detectEmptyOutputFieldsByRatio + formatEmptyOutputFieldsSignal — analyze
// the finalResult, find fields empty in ≥50% of records, surface them as a
// data-driven "EMPTY FIELDS IN OUTPUT" block in the autoFix prompt with
// contrastive non-empty examples from the same record set.
//
// This test uses the FB-shaped scenario (likes works, comments+shares don't)
// as a concrete anchor but the assertions are about generic behavior — any
// site, any field combination. The fix is FB-agnostic by design.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectEmptyOutputFieldsByRatio,
  formatEmptyOutputFieldsSignal
} = require('../lib/wizard-utils');

// Schema shaped like the FB incident: posts[] is an array of objects with
// several declared sub-fields. Some are populated by the script (author,
// publishTime, content, likes), others fail (comments, shares).
const FB_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['domHtml', 'author', 'publishTime', 'content', 'likes', 'comments', 'shares'],
        properties: {
          domHtml: { type: 'string' },
          author: { type: 'string' },
          publishTime: { type: 'string' },
          content: { type: 'string' },
          likes: { type: 'string' },
          comments: { type: 'string' },
          shares: { type: 'string' }
        }
      }
    }
  },
  required: ['posts']
};

// Reproduces the exact RC15 finalResult: 3 records with comments+shares empty
// across all of them, but likes populated with varying values. This is the
// data shape that detectEmptyOutputFieldsByRatio must flag.
const FB_FINAL_RESULT = {
  posts: [
    { domHtml: '<div>...</div>', author: '美食推薦官', publishTime: '2小时', content: 'lorem', likes: '4',   comments: '', shares: '' },
    { domHtml: '<div>...</div>', author: 'UserB',     publishTime: '5小时', content: 'ipsum', likes: '1',   comments: '', shares: '' },
    { domHtml: '<div>...</div>', author: 'UserC',     publishTime: '1天',   content: 'dolor', likes: '294', comments: '', shares: '' }
  ]
};

describe('RC15 — detectEmptyOutputFieldsByRatio finds partial-empty fields', () => {
  it('flags fields empty across ALL records when other fields in the same records are populated', () => {
    const out = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    const paths = out.map(f => f.path).sort();
    assert.deepEqual(paths, ['posts.comments', 'posts.shares'],
      'comments and shares must be flagged; got: ' + JSON.stringify(paths));
  });

  it('does NOT flag fields populated in ≥50% of records', () => {
    const out = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    assert.ok(!out.find(f => f.path === 'posts.likes'),
      'likes is populated in 100% of records — must not be flagged');
    assert.ok(!out.find(f => f.path === 'posts.author'),
      'author is populated in 100% of records — must not be flagged');
  });

  it('reports correct emptyCount / totalCount / emptyRatio', () => {
    const out = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    const comments = out.find(f => f.path === 'posts.comments');
    assert.equal(comments.emptyCount, 3);
    assert.equal(comments.totalCount, 3);
    assert.equal(comments.emptyRatio, 1);
  });

  it('includes contrastive sampleNonEmpty from neighboring fields when the flagged field has none', () => {
    // comments and shares are empty in ALL records — sampleNonEmpty should be
    // empty for those specific fields. (The formatEmptyOutputFieldsSignal
    // block uses neighboring-field examples instead — tested separately.)
    const out = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    const comments = out.find(f => f.path === 'posts.comments');
    assert.deepEqual(comments.sampleNonEmpty, [],
      'sampleNonEmpty must be [] when the field itself is empty in every record');
  });

  it('handles mixed-empty (field empty in MOST but not all records)', () => {
    // Suppose comments extraction works for ONE post but fails for the rest.
    // 2/3 empty = 0.67 ratio > 0.5 threshold → must still be flagged.
    // All other required fields are populated to ensure the detector focuses
    // only on comments and shares (the actually-empty ones).
    const data = {
      posts: [
        { domHtml: '<d/>', author: 'A', publishTime: '1h', content: 'a', likes: '1', comments: '5',  shares: '' },
        { domHtml: '<d/>', author: 'B', publishTime: '2h', content: 'b', likes: '2', comments: '',   shares: '' },
        { domHtml: '<d/>', author: 'C', publishTime: '3h', content: 'c', likes: '3', comments: '',   shares: '' }
      ]
    };
    const out = detectEmptyOutputFieldsByRatio(data, FB_SCHEMA);
    const paths = out.map(f => f.path).sort();
    assert.deepEqual(paths, ['posts.comments', 'posts.shares'],
      'comments empty in 2/3 records (67%) and shares empty in 3/3 — both must be flagged');

    // For comments, the one non-empty value must be in sampleNonEmpty.
    const comments = out.find(f => f.path === 'posts.comments');
    assert.deepEqual(comments.sampleNonEmpty, ['5']);
  });

  it('respects emptyRatioThreshold option (lower threshold catches more)', () => {
    // 1/3 empty = 0.33 ratio. Default threshold 0.5 → not flagged. Lower the
    // threshold to 0.3 → flagged. All other required fields populated.
    const data = {
      posts: [
        { domHtml: '<d/>', author: 'A', publishTime: '1h', content: 'a', likes: '1', comments: '5', shares: '1' },
        { domHtml: '<d/>', author: 'B', publishTime: '2h', content: 'b', likes: '2', comments: '6', shares: '' },
        { domHtml: '<d/>', author: 'C', publishTime: '3h', content: 'c', likes: '3', comments: '7', shares: '2' }
      ]
    };
    const defaultOut = detectEmptyOutputFieldsByRatio(data, FB_SCHEMA);
    assert.deepEqual(defaultOut.map(f => f.path), [],
      'with default threshold 0.5, shares (33% empty) is not flagged');

    const sensitiveOut = detectEmptyOutputFieldsByRatio(data, FB_SCHEMA, { emptyRatioThreshold: 0.3 });
    assert.deepEqual(sensitiveOut.map(f => f.path).sort(), ['posts.shares'],
      'with threshold 0.3, shares is flagged');
  });

  it('ignores arrays shorter than minRecords (default 2)', () => {
    // A single record can't establish a "pattern of emptiness".
    const data = { posts: [{ author: 'A', likes: '1', comments: '', shares: '' }] };
    const out = detectEmptyOutputFieldsByRatio(data, FB_SCHEMA);
    assert.deepEqual(out, [],
      'arrays of length 1 must be ignored — cannot establish a pattern');
  });

  it('returns [] for non-array-of-objects outputs (scalars / scalar arrays)', () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['title', 'tags']
    };
    const out = detectEmptyOutputFieldsByRatio({ title: '', tags: [] }, schema);
    assert.deepEqual(out, [],
      'scalar / scalar-array fields are not in scope — those are handled by findEmptyExtractionFields');
  });

  it('returns [] when schema is missing or has no array-of-objects', () => {
    assert.deepEqual(detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, null), []);
    assert.deepEqual(detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, { type: 'object' }), []);
    assert.deepEqual(detectEmptyOutputFieldsByRatio(null, FB_SCHEMA), []);
  });

  it('uses itemSchema.required when present, otherwise enumerates itemSchema.properties', () => {
    // Some services don't mark sub-fields required — the detector must still
    // enumerate them via properties. (Otherwise a missing `required` array
    // would silently disable detection.)
    const schemaNoRequired = {
      type: 'object',
      properties: {
        posts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              author: { type: 'string' },
              comments: { type: 'string' }
            }
            // no `required` array
          }
        }
      },
      required: ['posts']
    };
    const data = { posts: [{ author: 'A', comments: '' }, { author: 'B', comments: '' }] };
    const out = detectEmptyOutputFieldsByRatio(data, schemaNoRequired);
    assert.deepEqual(out.map(f => f.path), ['posts.comments'],
      'when itemSchema has no required array, must enumerate via properties');
  });

  it('treats whitespace-only strings as empty', () => {
    // Some scrapers leave "   " instead of "" — that's not a real value.
    // All non-target fields populated to ensure only comments+shares are flagged.
    const data = {
      posts: [
        { domHtml: '<d/>', author: 'A', publishTime: '1h', content: 'a', likes: '1', comments: '   ',  shares: '' },
        { domHtml: '<d/>', author: 'B', publishTime: '2h', content: 'b', likes: '2', comments: '\t\n', shares: '' }
      ]
    };
    const out = detectEmptyOutputFieldsByRatio(data, FB_SCHEMA);
    const paths = out.map(f => f.path).sort();
    assert.deepEqual(paths, ['posts.comments', 'posts.shares'],
      'whitespace-only strings must count as empty');
  });
});

describe('RC15 — formatEmptyOutputFieldsSignal renders prompt-ready block', () => {
  it('returns empty string when no fields are flagged', () => {
    assert.equal(formatEmptyOutputFieldsSignal([]), '');
    assert.equal(formatEmptyOutputFieldsSignal(null), '');
    assert.equal(formatEmptyOutputFieldsSignal(undefined), '');
  });

  it('emits EMPTY FIELDS IN OUTPUT header with data-driven framing', () => {
    const fields = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    const out = formatEmptyOutputFieldsSignal(fields);
    assert.ok(out.indexOf('EMPTY FIELDS IN OUTPUT') !== -1,
      'must include header so the LLM can locate the signal');
    assert.ok(out.indexOf('data-driven') !== -1,
      'must explain that the signal is empirical, not parsed from user words');
  });

  it('lists each flagged field with empty count and percentage', () => {
    const fields = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    const out = formatEmptyOutputFieldsSignal(fields);
    // comments: empty in 3/3 (100%)
    assert.ok(/posts\.comments: empty in 3\/3 records \(100%\)/.test(out),
      'must include count, total, and percentage: ' + out);
    assert.ok(/posts\.shares: empty in 3\/3 records \(100%\)/.test(out),
      'must include both flagged fields');
  });

  it('omits the contrastive-examples tail when sampleNonEmpty is empty', () => {
    // When the flagged field is empty in EVERY record, there are no non-empty
    // samples to show for that field. The "Other fields in the same records"
    // tail must be omitted, not show "Other fields produced values like: ".
    const fields = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    const out = formatEmptyOutputFieldsSignal(fields);
    const commentLine = out.split('\n').find(l => l.indexOf('posts.comments') !== -1);
    assert.ok(commentLine, 'must have a posts.comments line');
    assert.ok(!/Other fields in the same records produced values/.test(commentLine),
      'when sampleNonEmpty is empty, the contrastive tail must be omitted: ' + commentLine);
  });

  it('includes contrastive examples when the field is partially populated', () => {
    // 1/3 populated — sampleNonEmpty has the populated value, which the
    // formatter must surface to prove the container selector is correct.
    const data = {
      posts: [
        { domHtml: '<d/>', author: 'A', publishTime: '1h', content: 'a', likes: '1', comments: '5',  shares: '' },
        { domHtml: '<d/>', author: 'B', publishTime: '2h', content: 'b', likes: '2', comments: '',   shares: '' },
        { domHtml: '<d/>', author: 'C', publishTime: '3h', content: 'c', likes: '3', comments: '',   shares: '' }
      ]
    };
    const fields = detectEmptyOutputFieldsByRatio(data, FB_SCHEMA);
    const out = formatEmptyOutputFieldsSignal(fields);
    const commentLine = out.split('\n').find(l => l.indexOf('posts.comments') !== -1);
    assert.ok(commentLine.indexOf('"5"') !== -1,
      'comment line must include the non-empty sample "5": ' + commentLine);
    assert.ok(/Other fields in the same records produced values/.test(commentLine),
      'must include contrastive framing: ' + commentLine);
    assert.ok(/container selector is correct/.test(commentLine),
      'must explicitly tell LLM the container is fine, only sub-field selector is wrong');
  });
});

describe('RC15 — integration: the FB-shaped scenario produces a useful signal', () => {
  it('the full FB finalResult + schema produces a prompt-ready block naming comments and shares', () => {
    // This is the regression anchor. If a future refactor breaks the chain
    // (detect → format), the autoFix prompt loses its data-driven signal and
    // glm-5.1 goes back to misreading "为空的不正常" as "not enough posts".
    const fields = detectEmptyOutputFieldsByRatio(FB_FINAL_RESULT, FB_SCHEMA);
    const signal = formatEmptyOutputFieldsSignal(fields);
    assert.ok(signal.length > 0, 'signal must not be empty for the FB scenario');
    assert.ok(signal.indexOf('posts.comments') !== -1);
    assert.ok(signal.indexOf('posts.shares') !== -1);
    assert.ok(signal.indexOf('posts.likes') === -1,
      'likes is populated — must NOT appear in the empty-fields signal');
  });
});
