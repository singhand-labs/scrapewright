const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Load the module under test (declares globals as a fallback path).
require('../lib/record-shape-distribution');
const {
  computeFieldSignature,
  clusterRecordsByShape,
  formatShapeDistribution,
  formatShapeDistributionFromData,
} = require('../lib/record-shape-distribution');

describe('computeFieldSignature', () => {
  it('returns [] for null / undefined / non-object', () => {
    assert.deepEqual(computeFieldSignature(null), []);
    assert.deepEqual(computeFieldSignature(undefined), []);
    assert.deepEqual(computeFieldSignature('string'), []);
    assert.deepEqual(computeFieldSignature(42), []);
  });

  it('returns [] for empty object', () => {
    assert.deepEqual(computeFieldSignature({}), []);
  });

  it('emits flat field paths for populated scalar fields', () => {
    const r = { a: 'x', b: 1, c: true };
    assert.deepEqual(computeFieldSignature(r).sort(), ['a', 'b', 'c']);
  });

  it('skips empty string, null, undefined, empty array, empty object', () => {
    const r = { a: '', b: null, c: undefined, d: [], e: {}, f: 'present' };
    assert.deepEqual(computeFieldSignature(r), ['f']);
  });

  it('emits dotted paths for nested objects', () => {
    const r = {
      group: { name: 'A', url: '/g/1', empty: '' },
      account: { username: 'B' },
      time: '1h',
    };
    assert.deepEqual(
      computeFieldSignature(r).sort(),
      ['account.username', 'group.name', 'group.url', 'time']
    );
  });

  it('does not recurse into arrays (treats populated array as a single field)', () => {
    // Array-valued fields (media: [{url, type}, ...]) are common in extracted
    // output. We treat the array itself as the field — its element structure
    // is not part of the shape signature. This keeps signatures stable when
    // only one record happens to have a 2-element array and another has 3.
    const r = { tags: ['a', 'b'], media: [{ url: 'x' }], name: 'C' };
    assert.deepEqual(computeFieldSignature(r).sort(), ['media', 'name', 'tags']);
  });

  it('treats false and 0 as populated (not empty)', () => {
    // boolean false and number 0 are valid populated values — distinguishing
    // them from "field absent" matters for shape detection (e.g. isPublicPage).
    const r = { flag: false, count: 0, name: 'X' };
    assert.deepEqual(computeFieldSignature(r).sort(), ['count', 'flag', 'name']);
  });
});

describe('clusterRecordsByShape', () => {
  it('returns empty shapes for non-array input', () => {
    const r = clusterRecordsByShape(null);
    assert.equal(r.shapes.length, 0);
    assert.equal(r.totalRecords, 0);
  });

  it('returns empty shapes for fewer than minRecords (default 2)', () => {
    const r = clusterRecordsByShape([{ a: '1' }]);
    assert.equal(r.shapes.length, 0);
  });

  it('respects minRecords option', () => {
    const r = clusterRecordsByShape(
      [{ a: '1' }, { a: '2' }],
      { minRecords: 3 }
    );
    assert.equal(r.shapes.length, 0);
  });

  it('returns one shape when all records share the same populated-fields signature', () => {
    const records = [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
      { a: '5', b: '6' },
    ];
    const r = clusterRecordsByShape(records);
    assert.equal(r.shapes.length, 1);
    assert.equal(r.shapes[0].count, 3);
    assert.equal(r.totalRecords, 3);
  });

  it('clusters records into distinct shapes by field-population signature', () => {
    const records = [
      { group: 'A', time: '1h', content: 'x' },
      { account: 'B', time: '2h', content: 'y' },
      { group: 'C', time: '3h', content: 'z' },
      { account: 'D', time: '4h', content: 'w' },
    ];
    const r = clusterRecordsByShape(records);
    assert.equal(r.shapes.length, 2);
    // Most populous shape gets id 'A'
    assert.equal(r.shapes[0].count, 2);
    assert.equal(r.shapes[1].count, 2);
  });

  it('assigns SHAPE IDs A, B, C... in descending count order', () => {
    const records = [
      { a: 1 }, { a: 2 }, { a: 3 }, // shape with 3 records
      { b: 1 },                     // shape with 1 record
      { c: 1 }, { c: 2 },           // shape with 2 records
    ];
    const r = clusterRecordsByShape(records);
    assert.equal(r.shapes.length, 3);
    assert.equal(r.shapes[0].id, 'A');
    assert.equal(r.shapes[0].count, 3);
    assert.equal(r.shapes[1].id, 'B');
    assert.equal(r.shapes[1].count, 2);
    assert.equal(r.shapes[2].id, 'C');
    assert.equal(r.shapes[2].count, 1);
  });

  it('includes a sample record per shape (first record of that shape)', () => {
    const records = [
      { a: 'first' }, { a: 'second' },
      { b: 'third' },
    ];
    const r = clusterRecordsByShape(records);
    assert.equal(r.shapes[0].sample.a, 'first');
    assert.equal(r.shapes[1].sample.b, 'third');
  });
});

describe('formatShapeDistribution', () => {
  it('returns empty string when fewer than minRecords', () => {
    assert.equal(formatShapeDistribution([]), '');
    assert.equal(formatShapeDistribution([{}]), '');
  });

  it('returns empty string when only one distinct shape exists (no variance to surface)', () => {
    const records = [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ];
    assert.equal(formatShapeDistribution(records), '');
  });

  it('emits RECORD SHAPE DISTRIBUTION header when 2+ shapes detected', () => {
    const records = [
      { group: 'A', time: '1h', content: 'x' },
      { account: 'B', time: '2h', content: 'y' },
    ];
    const out = formatShapeDistribution(records);
    assert.match(out, /RECORD SHAPE DISTRIBUTION/);
    assert.match(out, /2 distinct shapes/);
  });

  it('lists each shape with its field signature and count', () => {
    const records = [
      { group: 'A', time: '1h', content: 'x' },
      { account: 'B', time: '2h', content: 'y' },
    ];
    const out = formatShapeDistribution(records);
    assert.match(out, /SHAPE A \(1 record/);
    assert.match(out, /SHAPE B \(1 record/);
    // Each shape line lists its populated fields
    assert.match(out, /group/);
    assert.match(out, /account/);
    assert.match(out, /time/);
    assert.match(out, /content/);
  });

  it('classifies fields as appearing in ALL shapes vs SOME shapes', () => {
    const records = [
      { group: 'A', time: '1h', content: 'x' },
      { account: 'B', time: '2h', content: 'y' },
    ];
    const out = formatShapeDistribution(records);
    // time and content appear in both shapes — universal
    assert.match(out, /fields appearing in ALL shapes:.*\btime\b/);
    assert.match(out, /fields appearing in ALL shapes:.*\bcontent\b/);
    // group and account appear in only one shape each — shape-dependent
    assert.match(out, /fields appearing in SOME shapes only:.*\bgroup\b/);
    assert.match(out, /fields appearing in SOME shapes only:.*\baccount\b/);
  });

  it('uses singular "record" when count is 1, plural otherwise', () => {
    const records = [
      { a: 1 },
      { b: 1 }, { b: 2 }, { b: 3 },
    ];
    const out = formatShapeDistribution(records);
    assert.match(out, /SHAPE A \(3 records\)/);
    assert.match(out, /SHAPE B \(1 record\)/);
  });

  it('uses generic terminology — no site-specific terms in output', () => {
    const records = [
      { group: 'A', account: 'B', time: '1h' },
      { group: 'C', account: 'D', time: '2h' },
    ];
    const out = formatShapeDistribution(records);
    // The output structure itself must be domain-agnostic — block labels
    // are RECORD SHAPE DISTRIBUTION / SHAPE A/B/C / OBSERVATION.
    // (Field values come from the records and may be site-specific; that's fine.)
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit/i.test(out),
      'block structure must not contain site-specific terms');
  });

  it('handles nested object fields in the signature output', () => {
    const records = [
      { group: { name: 'A', url: '/g/1' }, time: '1h' },
      { account: { username: 'B' }, time: '2h' },
    ];
    const out = formatShapeDistribution(records);
    assert.match(out, /group\.name/);
    assert.match(out, /group\.url/);
    assert.match(out, /account\.username/);
  });

  it('handles null-valued nested objects (treats as unpopulated)', () => {
    // Output schema often allows group: object | null. A null group means
    // the record doesn't have that shape.
    const records = [
      { group: null, account: { username: 'B' }, time: '1h' },
      { group: { name: 'A' }, account: null, time: '2h' },
    ];
    const out = formatShapeDistribution(records);
    assert.match(out, /RECORD SHAPE DISTRIBUTION/);
    assert.match(out, /group\.name/);
    assert.match(out, /account\.username/);
  });

  it('caps output length for very large record sets (avoid prompt bloat)', () => {
    // 200 records with 5 shapes — output should stay bounded.
    const records = [];
    for (let i = 0; i < 200; i++) {
      const shape = i % 5;
      if (shape === 0) records.push({ a: i, time: 't' });
      else if (shape === 1) records.push({ b: i, time: 't' });
      else if (shape === 2) records.push({ c: i, time: 't' });
      else if (shape === 3) records.push({ d: i, time: 't' });
      else records.push({ e: i, time: 't' });
    }
    const out = formatShapeDistribution(records);
    // Should mention all 5 shapes but not list 200 individual records.
    assert.ok(out.length < 5000, `output should be bounded, got ${out.length} chars`);
    assert.match(out, /200 records/);
    assert.match(out, /5 distinct shapes/);
  });
});

describe('formatShapeDistributionFromData', () => {
  it('returns empty string when data is not an object', () => {
    assert.equal(formatShapeDistributionFromData(null, { properties: {} }), '');
    assert.equal(formatShapeDistributionFromData([], { properties: {} }), '');
  });

  it('returns empty string when outputSchema has no array-of-objects field', () => {
    const data = { foo: 'bar' };
    const schema = { properties: { foo: { type: 'string' } } };
    assert.equal(formatShapeDistributionFromData(data, schema), '');
  });

  it('returns empty string when the array has fewer than 2 records', () => {
    const data = { items: [{ a: 1 }] };
    const schema = { properties: { items: { type: 'array', items: { type: 'object' } } } };
    assert.equal(formatShapeDistributionFromData(data, schema), '');
  });

  it('returns empty string when all records share one shape (no variance)', () => {
    const data = { items: [{ a: 1, b: 2 }, { a: 3, b: 4 }] };
    const schema = { properties: { items: { type: 'array', items: { type: 'object' } } } };
    assert.equal(formatShapeDistributionFromData(data, schema), '');
  });

  it('locates the array-of-objects field via outputSchema and emits block', () => {
    const data = {
      keyword: 'AI',
      posts: [
        { group: 'A', time: '1h', content: 'x' },
        { account: 'B', time: '2h', content: 'y' },
      ],
    };
    const schema = {
      properties: {
        keyword: { type: 'string' },
        posts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              group: { type: 'string' },
              account: { type: 'string' },
              time: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
      },
    };
    const out = formatShapeDistributionFromData(data, schema);
    assert.match(out, /Record collection: posts/);
    assert.match(out, /RECORD SHAPE DISTRIBUTION/);
    assert.match(out, /2 distinct shapes/);
  });

  it('skips array fields with non-object items (e.g. string arrays)', () => {
    const data = { tags: ['a', 'b', 'c'], items: [{ a: 1 }, { b: 2 }] };
    const schema = {
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        items: { type: 'array', items: { type: 'object' } },
      },
    };
    const out = formatShapeDistributionFromData(data, schema);
    assert.match(out, /Record collection: items/);
    assert.ok(!/Record collection: tags/.test(out));
  });

  it('uses the FIRST array-of-objects field with multi-shape variance', () => {
    // If a service has multiple record arrays, only emit distribution for
    // the first one with variance — keeps the prompt focused.
    const data = {
      primary: [{ a: 1 }, { a: 2 }], // single shape
      secondary: [{ x: 1 }, { y: 2 }], // multi shape
    };
    const schema = {
      properties: {
        primary: { type: 'array', items: { type: 'object' } },
        secondary: { type: 'array', items: { type: 'object' } },
      },
    };
    const out = formatShapeDistributionFromData(data, schema);
    assert.match(out, /Record collection: secondary/);
  });
});
