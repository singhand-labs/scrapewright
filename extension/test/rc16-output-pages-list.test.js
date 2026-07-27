// Regression for RC16 (page-list refactor 2026-07-27):
//
// The HTTP API output now carries a `pages[]` list of every web page the
// scraper saw, plus an auto-attached `sourcePageId` on every extracted
// record. This file tests the PageTracker that owns page identity, dedup,
// and size-cap enforcement — the foundation of the feature.
//
// Tests are generic — no site-specific terms. The same PageTracker works
// for any site, any outputSchema.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PageTracker } = require('../lib/page-tracker');

describe('RC16 PageTracker — ID generation', () => {
  it('emits IDs in the format page_NNNN_HHHHHHHH (4-digit sequence + 8 hex)', () => {
    const t = new PageTracker();
    const id = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>a</html>'), { sourceStepId: 's1' });
    assert.match(id, /^page_0001_[0-9a-f]{8}$/,
      'first ID must be page_0001_<8hex>; got: ' + id);
  });

  it('increments the sequence counter across captures', () => {
    const t = new PageTracker();
    const id1 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>a</html>'), { sourceStepId: 's1' });
    const id2 = t.record(SAMPLE_SNAPSHOT('https://b.com', '<html>b</html>'), { sourceStepId: 's2' });
    assert.match(id1, /^page_0001_/);
    assert.match(id2, /^page_0002_/);
    assert.notEqual(id1, id2);
  });
});

describe('RC16 PageTracker — content-hash dedup', () => {
  it('returns the same ID when (url, normalizedHtml) matches an existing capture', () => {
    const t = new PageTracker();
    const snap = SAMPLE_SNAPSHOT('https://a.com', '<html><body>Hello</body></html>');
    const id1 = t.record(snap, { sourceStepId: 's1' });
    const id2 = t.record(snap, { sourceStepId: 's2' });
    assert.equal(id1, id2, 'identical (url, html) must dedupe to the same ID');
  });

  it('returns a new ID when URL differs (even if HTML is identical)', () => {
    const t = new PageTracker();
    const id1 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>x</html>'), { sourceStepId: 's1' });
    const id2 = t.record(SAMPLE_SNAPSHOT('https://b.com', '<html>x</html>'), { sourceStepId: 's2' });
    assert.notEqual(id1, id2, 'different URL → different ID');
  });

  it('returns a new ID when content differs (even if URL is identical)', () => {
    // This is the user's explicit requirement: "如果同一个页面有产生变化，就当作两个页面"
    // ("if the same page has changed, treat as two pages").
    const t = new PageTracker();
    const id1 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>state-1</html>'), { sourceStepId: 's1' });
    const id2 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>state-2</html>'), { sourceStepId: 's1' });
    assert.notEqual(id1, id2, 'same URL + different content → different ID');
  });

  it('normalizes whitespace before hashing so equivalent HTML dedupes', () => {
    const t = new PageTracker();
    const id1 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>\n  <body>Hi</body>\n</html>'), { sourceStepId: 's1' });
    const id2 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html> <body>Hi</body> </html>'), { sourceStepId: 's1' });
    assert.equal(id1, id2, 'whitespace-only differences must normalize away');
  });

  it('normalizes attribute order so equivalent elements dedupe', () => {
    const t = new PageTracker();
    const id1 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<div a="1" b="2"></div>'), { sourceStepId: 's1' });
    const id2 = t.record(SAMPLE_SNAPSHOT('https://a.com', '<div b="2" a="1"></div>'), { sourceStepId: 's1' });
    assert.equal(id1, id2, 'attribute order is not semantically meaningful');
  });

  it('strips HTML comments before hashing so timestamped comments do not break dedup', () => {
    const t = new PageTracker();
    const id1 = t.record(
      SAMPLE_SNAPSHOT('https://a.com', '<html><!-- built 2024-01-01 --><body>X</body></html>'),
      { sourceStepId: 's1' }
    );
    const id2 = t.record(
      SAMPLE_SNAPSHOT('https://a.com', '<html><!-- built 2024-01-02 --><body>X</body></html>'),
      { sourceStepId: 's1' }
    );
    assert.equal(id1, id2, 'HTML comment differences must not affect the hash');
  });
});

describe('RC16 PageTracker — list() shape and size cap', () => {
  it('list() returns entries with id, url, title, capturedAt, sourceStepId, captureReason, hash, html', () => {
    const t = new PageTracker();
    t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>x</html>', 'Page A'), { sourceStepId: 's1', captureReason: 'step_iteration' });
    const pages = t.list();
    assert.equal(pages.length, 1);
    const p = pages[0];
    assert.equal(p.url, 'https://a.com');
    assert.equal(p.title, 'Page A');
    assert.equal(p.sourceStepId, 's1');
    assert.equal(p.captureReason, 'step_iteration');
    assert.match(p.hash, /^[0-9a-f]{64}$/, 'hash must be full sha256 hex');
    assert.equal(p.html, '<html>x</html>');
    assert.equal(typeof p.capturedAt, 'number');
    assert.match(p.id, /^page_0001_/);
  });

  it('truncates html over 80000 chars and sets truncated:true', () => {
    const t = new PageTracker();
    const huge = '<html>' + 'x'.repeat(90000) + '</html>';
    t.record(SAMPLE_SNAPSHOT('https://a.com', huge), { sourceStepId: 's1' });
    const pages = t.list();
    assert.equal(pages[0].truncated, true);
    assert.ok(pages[0].html.length < huge.length, 'over-cap html must be truncated');
    assert.ok(pages[0].html.startsWith('[TRUNCATED'), 'truncated html must start with marker');
  });

  it('does not truncate html at exactly 80000 chars', () => {
    const t = new PageTracker();
    const exact = '<html>' + 'x'.repeat(80000 - 13) + '</html>'; // 80000 total
    t.record(SAMPLE_SNAPSHOT('https://a.com', exact), { sourceStepId: 's1' });
    const pages = t.list();
    assert.equal(pages[0].truncated, false);
    assert.equal(pages[0].html.length, exact.length);
  });

  it('caps the list at maxPagesCaptured (default 50), keeping first 5 + last 45', () => {
    const t = new PageTracker();
    for (let i = 0; i < 60; i++) {
      t.record(SAMPLE_SNAPSHOT('https://a.com/' + i, '<html>' + i + '</html>'), { sourceStepId: 's' + i });
    }
    const pages = t.list();
    assert.equal(pages.length, 50, 'must cap at 50 entries');
    // First 5 kept: a.com/0..a.com/4
    assert.equal(pages[0].url, 'https://a.com/0');
    assert.equal(pages[4].url, 'https://a.com/4');
    // Last 45 kept: a.com/15..a.com/59
    assert.equal(pages[5].url, 'https://a.com/15');
    assert.equal(pages[49].url, 'https://a.com/59');
  });

  it('honors maxPagesCaptured option', () => {
    const t = new PageTracker({ maxPagesCaptured: 10 });
    for (let i = 0; i < 20; i++) {
      t.record(SAMPLE_SNAPSHOT('https://a.com/' + i, '<html>' + i + '</html>'), { sourceStepId: 's' });
    }
    const pages = t.list();
    assert.equal(pages.length, 10);
    // With cap=10, the keep-first slice scales to ceil(10/10)=1, keep-last=9
    // (Formula: keepFirst = ceil(cap/10), keepLast = cap - keepFirst.)
    assert.equal(pages[0].url, 'https://a.com/0');
    assert.equal(pages[1].url, 'https://a.com/11');
    assert.equal(pages[9].url, 'https://a.com/19');
  });

  it('honors maxPagesCaptured: 0 (cap=0 means capture nothing; || would have swallowed 0)', () => {
    const t = new PageTracker({ maxPagesCaptured: 0 });
    assert.equal(t.maxPagesCaptured, 0,
      'constructor must preserve 0 — || would have rewritten to default');
    for (let i = 0; i < 5; i++) {
      t.record(SAMPLE_SNAPSHOT('https://a.com/' + i, '<html>' + i + '</html>'), { sourceStepId: 's' });
    }
    const { pages, pagesTruncated } = t.listWithMeta();
    assert.deepEqual(pages, [], 'cap=0 must return no pages');
    assert.equal(pagesTruncated, 5, 'cap=0 must report all 5 entries as truncated');
  });

  it('exposes pagesTruncated count via listWithMeta() return meta when over cap', () => {
    const t = new PageTracker();
    for (let i = 0; i < 60; i++) {
      t.record(SAMPLE_SNAPSHOT('https://a.com/' + i, '<html>' + i + '</html>'), { sourceStepId: 's' });
    }
    const { pages, pagesTruncated } = t.listWithMeta();
    assert.equal(pages.length, 50);
    assert.equal(pagesTruncated, 10);
  });
});

describe('RC16 PageTracker — opt-out and defensive guards', () => {
  it('capturePages:false disables capture entirely', () => {
    const t = new PageTracker({ capturePages: false });
    const id = t.record(SAMPLE_SNAPSHOT('https://a.com', '<html>x</html>'), { sourceStepId: 's1' });
    assert.equal(id, null, 'when capturePages:false, record() returns null');
    const { pages, pagesTruncated } = t.listWithMeta();
    assert.deepEqual(pages, []);
    assert.equal(pagesTruncated, 0);
  });

  it('record(null) returns null without producing an entry', () => {
    const t = new PageTracker();
    assert.equal(t.record(null, { sourceStepId: 's1' }), null);
    assert.equal(t.record(undefined, { sourceStepId: 's1' }), null);
    assert.equal(t.record('string-not-object', { sourceStepId: 's1' }), null);
    assert.deepEqual(t.list(), []);
  });

  it('record({}) returns null when snapshot.html is missing or empty', () => {
    const t = new PageTracker();
    assert.equal(t.record({}, { sourceStepId: 's1' }), null);
    assert.equal(t.record({ html: '', url: 'https://a.com' }, { sourceStepId: 's1' }), null);
    assert.equal(t.record({ html: undefined, url: 'https://a.com' }, { sourceStepId: 's1' }), null);
    assert.equal(t.record({ html: 123, url: 'https://a.com' }, { sourceStepId: 's1' }), null,
      'html must be a string; numbers rejected');
    assert.deepEqual(t.list(), []);
  });
});

// Helper: build a snapshot object shaped like content-script's getDomSnapshot output.
function SAMPLE_SNAPSHOT(url, html, title) {
  return { html, url, title: title || '', textContent: '', structure: '', textSummary: '' };
}
