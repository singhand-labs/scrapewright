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

describe('RC16 content-script snapshot — url + title fields', () => {
  // getDomSnapshot lives inside the content-script IIFE and touches `document`,
  // so it can't be unit-tested directly. Instead, pin the SHAPE CONTRACT: any
  // captureSnapshot result fed to PageTracker must carry url + title. The
  // step-orchestrator's deps.captureSnapshot returns whatever the content-script
  // sends back via GET_DOM_SNAPSHOT — these tests assert PageTracker reads
  // snapshot.url and snapshot.title without choking when they're present.
  it('PageTracker surfaces snapshot.url and snapshot.title on the page entry', () => {
    const t = new PageTracker();
    t.record(
      { html: '<html>x</html>', url: 'https://example.com/page', title: 'Example', textContent: '' },
      { sourceStepId: 's1' }
    );
    const page = t.list()[0];
    assert.equal(page.url, 'https://example.com/page');
    assert.equal(page.title, 'Example');
  });

  it('PageTracker tolerates missing url/title (defensive — older snapshots)', () => {
    const t = new PageTracker();
    t.record(
      { html: '<html>x</html>' }, // no url, no title
      { sourceStepId: 's1' }
    );
    const page = t.list()[0];
    assert.equal(page.url, '');
    assert.equal(page.title, '');
    assert.match(page.id, /^page_0001_/);
  });
});

describe('RC16 StepOrchestrator — PageTracker integration', () => {
  // Set up the test scaffolding the same way step-orchestrator.test.js does.
  global.debugLogger = { log: () => {} };
  const { StepOrchestrator } = require('../lib/step-orchestrator');
  const urlTemplate = require('../lib/url-template');
  global.UrlTemplate = urlTemplate;

  function mockDeps(snapshotSequence) {
    let i = 0;
    return {
      createTab: async (url) => ({ id: 1, url }),
      waitForTabLoad: async () => {},
      executeScript: async () => ({ result: { done: true } }),
      captureSnapshot: async () => {
        const snap = snapshotSequence[i++] || snapshotSequence[0];
        return snap;
      },
      removeTab: async () => {},
      evaluateCondition: async () => true,
      resetDomActivity: async () => {},
      getDomActivity: async () => []
    };
  }

  it('returns pages[] in the result envelope', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [{ id: 'a', name: 'A', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }],
      config: {}
    };
    const deps = mockDeps([{ html: '<html>page-1</html>', url: 'http://example.com', title: 'Example' }]);
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.ok(Array.isArray(result.pages), 'result.pages must be an array');
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].url, 'http://example.com');
    assert.equal(result.pages[0].sourceStepId, 'a');
    assert.match(result.pages[0].id, /^page_0001_/);
  });

  it('returns pagesTruncated count alongside pages[]', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [{ id: 'a', name: 'A', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }],
      config: {}
    };
    const deps = mockDeps([{ html: '<html>x</html>', url: 'http://example.com', title: '' }]);
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(typeof result.pagesTruncated, 'number');
    assert.equal(result.pagesTruncated, 0);
  });

  it('stamps sourcePageId on array-of-objects results', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [{
        id: 'extract', name: 'E', script: 'extract',
        onSuccess: 'TERMINATE', onFailure: 'TERMINATE'
      }],
      config: {}
    };
    const deps = {
      ...mockDeps([{ html: '<html>p</html>', url: 'http://example.com', title: '' }]),
      executeScript: async () => ({ result: { posts: [{ author: 'A' }, { author: 'B' }] } })
    };
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(result.finalResult.posts[0].sourcePageId, result.pages[0].id);
    assert.equal(result.finalResult.posts[1].sourcePageId, result.pages[0].id);
  });

  it('stamps sourcePageId on flat-object result', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [{
        id: 'extract', name: 'E', script: 'extract',
        onSuccess: 'TERMINATE', onFailure: 'TERMINATE'
      }],
      config: {}
    };
    const deps = {
      ...mockDeps([{ html: '<html>p</html>', url: 'http://example.com', title: '' }]),
      executeScript: async () => ({ result: { answer: '42', question: 'what' } })
    };
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(result.finalResult.sourcePageId, result.pages[0].id,
      'flat-object result must get a top-level sourcePageId');
  });

  it('does NOT overwrite a sourcePageId the script already set', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [{
        id: 'extract', name: 'E', script: 'extract',
        onSuccess: 'TERMINATE', onFailure: 'TERMINATE'
      }],
      config: {}
    };
    const deps = {
      ...mockDeps([{ html: '<html>p</html>', url: 'http://example.com', title: '' }]),
      executeScript: async () => ({ result: { posts: [{ author: 'A', sourcePageId: 'script-set' }] } })
    };
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(result.finalResult.posts[0].sourcePageId, 'script-set',
      'script-set sourcePageId must be preserved');
  });

  it('honors config.capturePages:false (no pages, no sourcePageId)', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [{
        id: 'extract', name: 'E', script: 'extract',
        onSuccess: 'TERMINATE', onFailure: 'TERMINATE'
      }],
      config: { capturePages: false }
    };
    const deps = {
      ...mockDeps([{ html: '<html>p</html>', url: 'http://example.com', title: '' }]),
      executeScript: async () => ({ result: { posts: [{ author: 'A' }] } })
    };
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.deepEqual(result.pages, []);
    assert.equal(result.pagesTruncated, 0);
    assert.equal(result.finalResult.posts[0].sourcePageId, undefined,
      'capturePages:false must skip sourcePageId stamping');
  });

  it('dedupes consecutive identical-content captures to one page entry', async () => {
    // A poll step that returns not-ready 3 times against the SAME page HTML
    // (i.e. nothing actually changed on the page) should produce ONE page
    // entry, not three.
    const results = [{ done: false }, { done: false }, { done: true }];
    let i = 0;
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'wait', name: 'Wait', script: 'w', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 5 },
        { id: 'extract', name: 'E', script: 'e', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = {
      ...mockDeps([
        { html: '<html>same</html>', url: 'http://example.com', title: '' },
        { html: '<html>same</html>', url: 'http://example.com', title: '' },
        { html: '<html>same</html>', url: 'http://example.com', title: '' },
        { html: '<html>same</html>', url: 'http://example.com', title: '' }
      ]),
      executeScript: async () => ({ result: results[i++] })
    };
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(result.pages.length, 1, 'identical-content captures must dedupe to one entry');
  });

  it('attaches pages[] and pagesTruncated to the error when the orchestrator throws', async () => {
    // The error path (catch block at the bottom of execute) must enrich the
    // thrown error with the same pages[] / pagesTruncated payload the success
    // path returns, so callers investigating a failure still get the trail of
    // pages the scraper saw before things blew up.
    //
    // We trigger POLL_EXHAUSTED via a step that always returns {done:false} and
    // routes its onFailure straight to TERMINATE — the same pattern used in
    // step-orchestrator.test.js (see the POLL_EXHAUSTED regression tests).
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'poll', name: 'Poll', script: 'p', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 2 },
        { id: 'extract', name: 'Extract', script: 'e', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = {
      ...mockDeps([{ html: '<html>p</html>', url: 'http://example.com', title: '' }]),
      executeScript: async () => ({ result: { done: false } })
    };
    await assert.rejects(
      StepOrchestrator.execute(service, {}, deps),
      (err) => {
        assert.ok(Array.isArray(err.pages), 'err.pages must be an array');
        assert.equal(typeof err.pagesTruncated, 'number', 'err.pagesTruncated must be a number');
        // The page captured before the failure must be present, proving the
        // tracker was recording even as the chain was about to throw.
        assert.ok(err.pages.length >= 1, 'page captured before failure must be included');
        assert.equal(err.pages[0].url, 'http://example.com');
        return true;
      }
    );
  });
});

describe('RC16 background.js — job envelope threading (structural test)', () => {
  // We can't easily require background.js (it's a service worker). This
  // test asserts the SHAPE CONTRACT on the job envelope by reading the
  // background.js source text and checking that the relevant fields are
  // threaded through. T10 (integration regression anchor) will exercise
  // the runtime; until then, these source-text checks guard the shape.
  //
  // We COUNT occurrences (not .test) so a future edit that drops pages
  // from one return site can't hide behind another site still matching.
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  function countMatches(regex) {
    return (SRC.match(regex) || []).length;
  }

  it('createJob initializes pages: [] on new jobs', () => {
    // Only one site: the createJob job object literal.
    const matches = countMatches(/pages:\s*\[\]/g);
    assert.ok(matches >= 1,
      'createJob must initialize pages: [] for shape consistency; got ' + matches);
  });

  it('processJob writes result.pages + result.pagesTruncated into the job on success', () => {
    // The success path: updateJob(jobId, { ..., pages: result.pages, pagesTruncated: result.pagesTruncated, ... })
    const pagesMatches = countMatches(/pages:\s*result\.pages\s*\|\|\s*\[\]/g);
    const truncMatches = countMatches(/pagesTruncated:\s*result\.pagesTruncated\s*\|\|\s*0/g);
    assert.ok(pagesMatches >= 1,
      'processJob must default pages to [] when orchestrator returned none; got ' + pagesMatches);
    assert.ok(truncMatches >= 1,
      'processJob must default pagesTruncated to 0 when missing; got ' + truncMatches);
  });

  it('handleExecute threads pages from orchestrator result on the success path', () => {
    // `result.pages || []` appears at multiple return sites:
    //   1. processJob success updateJob (covered above but counted here too)
    //   2. output-schema validation failure return
    //   3. success return
    // Require >=2 so removing it from any one return site is caught.
    const pagesMatches = countMatches(/pages:\s*result\.pages\s*\|\|\s*\[\]/g);
    const truncMatches = countMatches(/pagesTruncated:\s*result\.pagesTruncated\s*\|\|\s*0/g);
    assert.ok(pagesMatches >= 2,
      'handleExecute success path must thread pages: result.pages || [] at >=2 return sites; got ' + pagesMatches);
    assert.ok(truncMatches >= 2,
      'handleExecute success path must thread pagesTruncated: result.pagesTruncated || 0 at >=2 return sites; got ' + truncMatches);
  });

  it('handleExecute threads pages from the error envelope on catch-block returns', () => {
    // The catch path can't reference `result` (it doesn't exist there). It must
    // pull pages from the orchestrator's error object instead. Currently three
    // catch returns thread pages: LOGIN_REQUIRED, MISSING_URL_PARAM, and
    // POLL_EXHAUSTED. Accept both `error.pages` and `error?.pages` (optional
    // chaining) since both shapes appear in the source. Require >=2 so removing
    // pages from any one catch site is caught.
    const errorPagesMatches = countMatches(/pages:\s*error\??\.pages\s*\|\|\s*\[\]/g);
    const errorTruncMatches = countMatches(/pagesTruncated:\s*error\??\.pagesTruncated\s*\|\|\s*0/g);
    assert.ok(errorPagesMatches >= 2,
      'handleExecute catch path must thread pages: error.pages || [] at >=2 return sites; got ' + errorPagesMatches);
    assert.ok(errorTruncMatches >= 2,
      'handleExecute catch path must thread pagesTruncated: error.pagesTruncated || 0 at >=2 return sites; got ' + errorTruncMatches);
    // lastError fallback (final return after retries exhausted) must also thread.
    const lastErrMatches = countMatches(/pages:\s*lastError\?\.pages\s*\|\|\s*\[\]/g);
    assert.ok(lastErrMatches >= 1,
      'handleExecute final-fallback return must thread pages: lastError?.pages || [] at >=1 site; got ' + lastErrMatches);
  });
});

describe('RC16 background.js — sub-tab capture on $openTab success (structural)', () => {
  // T5: handleOpenTabExecute previously captured the sub-tab snapshot only on
  // the FAILURE path (for autoFix). For the pages-list feature, the same
  // snapshot must also be recorded into the tracker on the SUCCESS path so
  // detail-page scrapes (FB post comments, product reviews, etc.) appear in
  // pages[] with captureReason='subtab_pre_destroy'.
  //
  // The tracker is owned by StepOrchestrator internally. To share the same
  // instance with handleOpenTabExecute (which is invoked through the
  // OffscreenExecutor message chain, not a direct call from handleExecute),
  // background.js instantiates the tracker itself, passes it to the
  // orchestrator via options.tracker, and stashes it in a module-level
  // binding that handleOpenTabExecute reads.
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  it('exposes a module-level current-execution-tracker binding', () => {
    // The orchestrator-owned tracker must be reachable from
    // handleOpenTabExecute, which is invoked through the OffscreenExecutor
    // message chain (not a direct call from processJob). A module-level
    // binding set by handleExecute and read by handleOpenTabExecute is the
    // shared-state bridge.
    assert.ok(/let\s+currentExecutionTracker\s*=/.test(SRC),
      'background.js must declare a module-level currentExecutionTracker binding');
  });

  // Test #2 (success-path capture via file-wide regex) was deleted — see
  // Important #1 in the T5 review follow-up. The regex used non-greedy
  // `[\s\S]*?` across the whole file, which also matched via the
  // failure-path catch block; removing the success capture would still
  // have passed it. The order check below (test #3) is the load-bearing
  // assertion: it slices out just handleOpenTabExecute's body before
  // checking capture-before-remove, so it can only match the success
  // try-block.

  it('does not destroy the sub-tab BEFORE capturing on success', () => {
    // Order assertion: capture must come before remove on the success path.
    // We slice out just the body of handleOpenTabExecute (the function that
    // owns the success/catch split) — otherwise the regex picks up unrelated
    // try-blocks earlier in background.js (ExecutionQueue, processJob, etc.)
    // and the order check gets scrambled.
    //
    // Note: the success-path capture was previously a literal
    // GET_DOM_SNAPSHOT call inside handleOpenTabExecute. After T5 review
    // follow-up, both call sites share the captureSubTabSnapshot() helper,
    // so we now look for the helper invocation (with the 'on success' label
    // unique to the success path) instead of the literal GET_DOM_SNAPSHOT.
    const fnStart = SRC.indexOf('async function handleOpenTabExecute(');
    assert.ok(fnStart !== -1, 'handleOpenTabExecute must exist');
    // Slice up to the next top-level function def or end of file. The
    // function is the last one in background.js, so end-of-file is fine.
    const fnBody = SRC.slice(fnStart);
    // Within the success try-block (the FIRST try in handleOpenTabExecute),
    // captureSubTabSnapshot(..., 'on success') must appear before chrome.tabs.remove.
    const tryBlock = fnBody.match(/try\s*\{[\s\S]*?await\s+chrome\.tabs\.remove\(tab\.id\)\.catch\(\(\)\s*=>\s*\{\}\);[\s\S]*?catch\s*\(error\)/);
    assert.ok(tryBlock, 'could not locate the success try-block');
    const captureIdx = tryBlock[0].indexOf("captureSubTabSnapshot(tab.id, 'on success')");
    const removeIdx = tryBlock[0].indexOf('chrome.tabs.remove');
    assert.ok(captureIdx !== -1 && captureIdx < removeIdx,
      'sub-tab snapshot capture must occur BEFORE chrome.tabs.remove on the success path');
  });

  it('records the captured sub-tab snapshot into currentExecutionTracker', () => {
    // The capture alone isn't enough — it must also be recorded into the
    // shared tracker instance so it shows up in pages[] with the
    // 'subtab_pre_destroy' reason.
    const recordCalls = SRC.match(/currentExecutionTracker\.record\(/g) || [];
    assert.ok(recordCalls.length >= 2,
      'handleOpenTabExecute must record into currentExecutionTracker on both success and failure paths; got ' + recordCalls.length);
    assert.ok(/captureReason:\s*['"]subtab_pre_destroy['"]/.test(SRC),
      'recordings must tag captureReason as subtab_pre_destroy');
  });

  it('preserves subTabSnapshot in the failure-path TAB_RESULT payload (autoFix depends on it)', () => {
    // autoFix reads error.subTabSnapshot to regenerate the failing script.
    // The new tracker.record call must NOT displace it from the TAB_RESULT
    // message. Slice handleOpenTabExecute's body so the regex can't match
    // unrelated code elsewhere in background.js.
    const fnStart = SRC.indexOf('async function handleOpenTabExecute(');
    assert.ok(fnStart !== -1, 'handleOpenTabExecute function not found');
    const body = SRC.slice(fnStart);
    assert.ok(/TAB_RESULT[\s\S]{0,400}subTabSnapshot/.test(body),
      'failure-path TAB_RESULT payload must still include subTabSnapshot');
  });

  it('instantiates the tracker in handleExecute and passes it to StepOrchestrator via options.tracker', () => {
    // Tracker ownership moved from StepOrchestrator to handleExecute so the
    // same instance is shared with handleOpenTabExecute. handleExecute must
    // (a) construct a PageTracker, (b) stash it in currentExecutionTracker,
    // and (c) pass { tracker } as the 4th arg to StepOrchestrator.execute.
    assert.ok(/new\s+PageTracker\(/.test(SRC),
      'handleExecute must instantiate the PageTracker itself');
    assert.ok(/currentExecutionTracker\s*=\s*tracker/.test(SRC),
      'handleExecute must assign the tracker to currentExecutionTracker');
    assert.ok(/StepOrchestrator\.execute\([\s\S]*?\{[\s\S]*?tracker[\s\S]*?\}\s*\)/.test(SRC),
      'handleExecute must pass { tracker } as 4th arg to StepOrchestrator.execute');
  });

  it('clears currentExecutionTracker in a finally block to avoid leaking between executions', () => {
    // The binding is module-level — without a cleanup, a tracker from one
    // job could be referenced by handleOpenTabExecute in a later job. The
    // try/finally around the orchestrator call ensures it's cleared.
    assert.ok(/finally\s*\{[\s\S]*?currentExecutionTracker\s*=\s*null/.test(SRC),
      'handleExecute must clear currentExecutionTracker in a finally block');
  });

  it('imports lib/page-tracker.js so PageTracker is in scope', () => {
    // Without this importScripts entry, `new PageTracker(...)` throws
    // ReferenceError at runtime in the service worker.
    assert.ok(/['"]lib\/page-tracker\.js['"]/.test(SRC),
      "background.js importScripts list must include 'lib/page-tracker.js'");
  });
});

describe('RC16 wizard-utils — stripPagesFromLLMContext', () => {
  const { stripPagesFromLLMContext } = require('../lib/wizard-utils');

  it('returns input unchanged for non-objects', () => {
    assert.equal(stripPagesFromLLMContext(null), null);
    assert.equal(stripPagesFromLLMContext(undefined), undefined);
    assert.equal(stripPagesFromLLMContext('string'), 'string');
    assert.equal(stripPagesFromLLMContext(42), 42);
  });

  it('removes a top-level pages field', () => {
    const input = { data: { posts: [] }, pages: [{ id: 'p1', html: 'x' }], pagesTruncated: 0 };
    const out = stripPagesFromLLMContext(input);
    assert.equal(out.pages, undefined, 'pages must be stripped');
    assert.equal(out.pagesTruncated, undefined, 'pagesTruncated must be stripped');
    assert.deepEqual(out.data, { posts: [] });
  });

  it('recursively removes sourcePageId from records', () => {
    const input = {
      data: {
        posts: [
          { author: 'A', sourcePageId: 'page_0001_aaa' },
          { author: 'B', sourcePageId: 'page_0001_aaa' }
        ]
      },
      steps: [{ result: { posts: [{ sourcePageId: 'x' }] } }]
    };
    const out = stripPagesFromLLMContext(input);
    assert.equal(out.data.posts[0].sourcePageId, undefined);
    assert.equal(out.data.posts[1].sourcePageId, undefined);
    assert.equal(out.steps[0].result.posts[0].sourcePageId, undefined);
    // Non-provenance fields preserved.
    assert.equal(out.data.posts[0].author, 'A');
  });

  it('returns a deep clone — never mutates input', () => {
    const input = { data: { posts: [{ author: 'A', sourcePageId: 'p1' }] }, pages: [] };
    const out = stripPagesFromLLMContext(input);
    assert.notEqual(out, input);
    assert.notEqual(out.data, input.data);
    // Input is untouched.
    assert.equal(input.data.posts[0].sourcePageId, 'p1');
    assert.equal(input.pages.length, 0);
  });

  it('preserves arrays of primitives (does not add sourcePageId to strings)', () => {
    const input = { data: { tags: ['a', 'b', 'c'] } };
    const out = stripPagesFromLLMContext(input);
    assert.deepEqual(out.data.tags, ['a', 'b', 'c']);
  });

  it('summarizeFixIteration output contains no pages[] or sourcePageId', () => {
    // Code-review follow-up on T7 (commit 4c2aa6e): summarizeFixIteration in
    // lib/wizard-utils.js was JSON.stringifying testResult into llmHistory
    // without applying stripPagesFromLLMContext. This test guards against
    // regression — pages[] and sourcePageId must never reach the LLM history.
    const { summarizeFixIteration } = require('../lib/wizard-utils');
    const result = {
      steps: [
        { stepId: 'extract', result: { posts: [{ author: 'a', sourcePageId: 'page_0001_aaa' }] } }
      ],
      finalResult: { posts: [{ author: 'a', sourcePageId: 'page_0001_aaa' }] },
      pages: [{ id: 'page_0001_aaa', url: 'http://x', html: 'h'.repeat(100) }],
      pagesTruncated: 0
    };
    const out = summarizeFixIteration({
      stepId: 'extract',
      stepName: 'Extract',
      script: 'return 1',
      result
    });
    assert.equal(typeof out, 'string');
    assert.ok(out.indexOf('author') !== -1, 'non-provenance fields must survive');
    assert.ok(out.indexOf('sourcePageId') === -1, 'sourcePageId must be stripped');
    assert.ok(out.indexOf('pages') === -1, 'pages field must be stripped');
    assert.ok(out.indexOf('pagesTruncated') === -1, 'pagesTruncated must be stripped');
  });
});

describe('RC16 wizard.js — apply stripPagesFromLLMContext at every LLM site (structural)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

  it('wizard.js imports stripPagesFromLLMContext', () => {
    // Either via destructuring from wizard-utils, via window., or via a require.
    assert.ok(
      /stripPagesFromLLMContext/.test(SRC),
      'wizard.js must reference stripPagesFromLLMContext'
    );
  });

  it('every call to stripSnapshotsFromTestResult has a sibling call to stripPagesFromLLMContext', () => {
    // Strip line comments and block comments so the count reflects real code only.
    // (Earlier the test passed by coincidence: 2 real calls + 1 comment mention.)
    const noComments = SRC
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const snapCalls = (noComments.match(/stripSnapshotsFromTestResult/g) || []).length;
    const pagesCalls = (noComments.match(/stripPagesFromLLMContext/g) || []).length;
    assert.ok(pagesCalls >= snapCalls && snapCalls >= 1,
      `expected pages-strip calls (${pagesCalls}) to mirror snapshot-strip calls (${snapCalls}) in wizard.js`);
  });
});

// Same hardening for lib/wizard-utils.js since summarizeFixIteration lives there.
describe('RC16 lib/wizard-utils.js — apply stripPagesFromLLMContext at every LLM site (structural)', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  it('every stripSnapshotsFromTestResult call in lib/wizard-utils.js has a sibling stripPagesFromLLMContext', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    // Strip comments first so comment text doesn't pad the count.
    const noComments = SRC
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Then strip the function DEFINITIONS themselves so only CALL sites remain
    // (definitions are symmetric — both helpers defined — but the invariant we
    // want is "every call site pairs both helpers", which is cleaner to check).
    const callSitesOnly = noComments
      .replace(/function\s+stripSnapshotsFromTestResult\s*\([^)]*\)\s*\{[\s\S]*?^\}/gm, '')
      .replace(/function\s+stripPagesFromLLMContext\s*\([^)]*\)\s*\{[\s\S]*?^\}/gm, '');
    const snapCalls = (callSitesOnly.match(/stripSnapshotsFromTestResult/g) || []).length;
    const pagesCalls = (callSitesOnly.match(/stripPagesFromLLMContext/g) || []).length;
    // After def-stripping, every remaining stripSnapshotsFromTestResult reference
    // (call, export, window/self mount) must have a matching stripPagesFromLLMContext
    // reference. If a future edit pairs only one, this breaks.
    assert.ok(pagesCalls >= snapCalls && snapCalls >= 1,
      `expected pages-strip references (${pagesCalls}) to match snapshot-strip references (${snapCalls}) in wizard-utils.js call sites`);
  });
});

describe('RC16 wizard UI — pages viewer (structural)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
  const JS = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

  it('wizard.html has a pages-viewer container in the result section', () => {
    assert.ok(/id=["']pages-viewer["']|class=["'][^"']*\bpages-viewer\b/.test(HTML),
      'wizard.html must have a #pages-viewer (or .pages-viewer) element');
  });

  it('wizard.js renders pages into the viewer when testResult has pages', () => {
    assert.ok(/pages-viewer/.test(JS),
      'wizard.js must reference the pages-viewer element');
    assert.ok(/renderPagesViewer|populatePagesViewer|testResult\.pages/.test(JS),
      'wizard.js must have a function that renders pages[] into the viewer');
  });
});

// Byte-budget cap (storage quota defense). The default 2MB budget drops middle
// page entries when total html.length exceeds the threshold, keeping first +
// last so the user always has initial-state + most-recent captures. Set
// maxPagesBytes:0 to disable (count cap alone applies). Without this cap, 100
// retained jobs × ~4MB pages each could overflow chrome.storage.local even
// with unlimitedStorage permission.
describe('RC16 PageTracker — byte-budget cap (storage quota defense)', () => {
  const { enforceByteBudget } = require('../lib/page-tracker');

  it('enforceByteBudget returns input unchanged when under budget', () => {
    const pages = [
      { html: 'a'.repeat(50) },
      { html: 'b'.repeat(50) },
      { html: 'c'.repeat(50) }
    ];
    const out = enforceByteBudget(pages, 1000);
    assert.equal(out.pages.length, 3, 'no drops when total well under budget');
    assert.equal(out.dropped, 0);
  });

  it('enforceByteBudget drops middle entries to fit budget, keeps first + last', () => {
    const pages = [
      { html: 'first' },           // 5 bytes
      { html: 'x'.repeat(100) },   // 100 bytes — middle
      { html: 'y'.repeat(100) },   // 100 bytes — middle
      { html: 'last' }             // 4 bytes
    ];
    // Total = 209. Budget = 50. Must drop middle entries until ≤50.
    // After dropping both middle entries: 5+4=9 ≤ 50.
    const out = enforceByteBudget(pages, 50);
    assert.equal(out.pages.length, 2, 'should keep only first + last');
    assert.equal(out.pages[0].html, 'first');
    assert.equal(out.pages[out.pages.length - 1].html, 'last');
    assert.equal(out.dropped, 2);
  });

  it('enforceByteBudget never drops below 2 entries (always keeps endpoints)', () => {
    // Even when first + last alone exceed budget, they're kept — better to be
    // slightly over budget than to lose the initial-state or most-recent capture.
    const pages = [
      { html: 'x'.repeat(1000) },
      { html: 'y'.repeat(1000) },
      { html: 'z'.repeat(1000) }
    ];
    const out = enforceByteBudget(pages, 100); // budget way under any single page
    assert.equal(out.pages.length, 2, 'must keep first + last even if over budget');
    assert.equal(out.dropped, 1);
  });

  it('enforceByteBudget is a no-op for arrays of length <= 2', () => {
    const pages = [{ html: 'a'.repeat(1000) }, { html: 'b'.repeat(1000) }];
    const out = enforceByteBudget(pages, 10);
    assert.equal(out.pages.length, 2);
    assert.equal(out.dropped, 0);
  });

  it('PageTracker.listWithMeta drops middle pages when total html.length exceeds maxPagesBytes', () => {
    const t = new PageTracker({ maxPagesCaptured: 50, maxPagesBytes: 200 });
    // 5 entries x 80 bytes html each = 400 bytes total. Budget = 200.
    // Must drop middle entries until <= 200 bytes.
    for (let i = 0; i < 5; i++) {
      t.record(
        SAMPLE_SNAPSHOT('https://x.com/p' + i, 'h'.repeat(80) + i),
        { sourceStepId: 's' + i }
      );
    }
    const { pages, pagesTruncated } = t.listWithMeta();
    assert.ok(pages.length < 5, 'must drop some entries to fit byte budget');
    assert.ok(pages.length >= 2, 'must keep at least first + last');
    // First entry preserved (initial state for context)
    assert.equal(pages[0].url, 'https://x.com/p0');
    // Last entry preserved (most recent activity)
    assert.equal(pages[pages.length - 1].url, 'https://x.com/p4');
    // pagesTruncated counts byte-budget drops
    assert.equal(pagesTruncated, 5 - pages.length);
    // Total bytes within budget (or as close as possible with first+last kept)
    const totalBytes = pages.reduce((s, p) => s + (p.html ? p.html.length : 0), 0);
    const endpointsBytes = pages[0].html.length + pages[pages.length - 1].html.length;
    if (endpointsBytes <= 200) {
      assert.ok(totalBytes <= 200, 'total must be under budget when endpoints fit: ' + totalBytes);
    }
  });

  it('maxPagesBytes:0 disables byte-budget cap (count cap alone applies)', () => {
    const t = new PageTracker({ maxPagesCaptured: 50, maxPagesBytes: 0 });
    for (let i = 0; i < 5; i++) {
      t.record(
        SAMPLE_SNAPSHOT('https://y.com/p' + i, 'h'.repeat(80) + i),
        { sourceStepId: 's' + i }
      );
    }
    const { pages, pagesTruncated } = t.listWithMeta();
    assert.equal(pages.length, 5, 'all 5 entries kept when byte budget disabled');
    assert.equal(pagesTruncated, 0);
  });

  it('byte-budget stacks with count cap (both can drop entries)', () => {
    // 60 entries, count cap = 10, byte budget tight. Count cap drops 50 first
    // (keeps first 1 + last 9). Byte budget may drop more from those 10.
    const t = new PageTracker({ maxPagesCaptured: 10, maxPagesBytes: 200 });
    for (let i = 0; i < 60; i++) {
      t.record(
        SAMPLE_SNAPSHOT('https://z.com/p' + i, 'h'.repeat(80) + String(i).padStart(3, '0')),
        { sourceStepId: 's' + i }
      );
    }
    const { pages, pagesTruncated } = t.listWithMeta();
    // Count cap alone would leave 10. Byte budget should drop some of those 10.
    assert.ok(pages.length <= 10, 'count cap of 10 must hold');
    assert.ok(pages.length >= 2, 'byte budget keeps at least first + last');
    // pagesTruncated = count drops (50) + byte drops
    assert.ok(pagesTruncated >= 50, 'must include the 50 count-cap drops at minimum');
  });

  it('PageTracker default maxPagesBytes is 2MB (bounds storage growth)', () => {
    // Sanity: the default constructor wires the 2MB constant.
    const t = new PageTracker();
    assert.equal(t.maxPagesBytes, 2 * 1024 * 1024,
      'default byte budget must be 2MB so 100 jobs cap at ~200MB worst case');
  });
});

// Storage quota defense — manifest must declare unlimitedStorage, and
// background.js must thread config.maxPagesBytes into the PageTracker.
// Without unlimitedStorage, chrome.storage.local caps at ~10MB total, which
// a single 50-page x 80K job can blow past.
describe('RC16 storage quota — manifest + background wiring (structural)', () => {
  const fs = require('fs');
  const path = require('path');

  it('manifest.json declares unlimitedStorage permission', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
    );
    assert.ok(
      Array.isArray(manifest.permissions) && manifest.permissions.indexOf('unlimitedStorage') !== -1,
      'manifest.permissions must include "unlimitedStorage" — got: ' + JSON.stringify(manifest.permissions)
    );
  });

  it('background.js threads config.maxPagesBytes into PageTracker constructor', () => {
    const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    // Look for the PageTracker instantiation and verify maxPagesBytes is wired.
    const m = bg.match(/new\s+PageTracker\(\s*\{[^}]+\}\s*\)/);
    assert.ok(m, 'background.js must instantiate PageTracker');
    assert.ok(/maxPagesBytes:\s*service\.config\.maxPagesBytes/.test(m[0]),
      'PageTracker constructor must pass maxPagesBytes from service config — got: ' + m[0]);
  });
});

describe('RC16 integration — FB-shaped scroll+extract scenario', () => {
  // Regression anchor: the canonical FB search scrape. Scroll step polls
  // against a page whose HTML grows on each iteration (simulating FB's
  // virtualized feed). Extract step returns 3 posts. We assert:
  //   - each unique-content scroll state produces a distinct page entry
  //   - all posts are stamped with the LAST captured page ID
  //   - pages[] and sourcePageId round-trip through StepOrchestrator
  //
  // The assertions are GENERIC — no FB-specific terms. Any site where the
  // page grows during scroll and an array-of-records is extracted produces
  // the same shape.
  global.debugLogger = { log: () => {} };
  const { StepOrchestrator } = require('../lib/step-orchestrator');
  const urlTemplate = require('../lib/url-template');
  global.UrlTemplate = urlTemplate;

  it('produces N unique page entries for N distinct content states, stamps all records with the last', async () => {
    // Simulate a poll step that returns not-ready while the page grows.
    const readySequence = [
      { done: false },   // iteration 1: html has 1 post
      { done: false },   // iteration 2: html has 2 posts
      { done: false },   // iteration 3: html has 3 posts
      { done: true }     // iteration 4: ready, hand off to extract
    ];
    const snapshotSequence = [
      { html: '<html>post1</html>', url: 'https://example.com/search', title: 'Search' },
      { html: '<html>post1post2</html>', url: 'https://example.com/search', title: 'Search' },
      { html: '<html>post1post2post3</html>', url: 'https://example.com/search', title: 'Search' },
      { html: '<html>post1post2post3</html>', url: 'https://example.com/search', title: 'Search' },
      { html: '<html>post1post2post3-extracted</html>', url: 'https://example.com/search', title: 'Search' }
    ];
    let snapIdx = 0;
    let readyIdx = 0;
    const extractResult = {
      posts: [
        { author: '美食推薦官', likes: '4', comments: '', shares: '' },
        { author: 'UserB',     likes: '1', comments: '', shares: '' },
        { author: 'UserC',     likes: '294', comments: '', shares: '' }
      ]
    };

    const service = {
      targetUrl: 'https://example.com/search',
      steps: [
        { id: 'scroll', name: 'Scroll', script: 's', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 10 },
        { id: 'extract', name: 'Extract', script: 'e', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };

    const deps = {
      createTab: async (url) => ({ id: 1, url }),
      waitForTabLoad: async () => {},
      executeScript: async () => {
        // First 4 calls are scroll-step iterations (returns readySequence),
        // 5th call is extract-step (returns extractResult).
        if (readyIdx < readySequence.length) {
          return { result: readySequence[readyIdx++] };
        }
        return { result: extractResult };
      },
      captureSnapshot: async () => snapshotSequence[snapIdx++],
      removeTab: async () => {},
      evaluateCondition: async () => true,
      resetDomActivity: async () => {},
      getDomActivity: async () => []
    };

    const result = await StepOrchestrator.execute(service, {}, deps);

    // The 3 unique-content states (1 post, 2 posts, 3 posts) + 1 for the
    // extract-step capture = 4 page entries. The duplicate "3 posts" state
    // (iteration 4's snapshot equals iteration 3's) must dedupe.
    assert.equal(result.pages.length, 4,
      'expected 4 unique pages (3 growth states + extract); got: ' + result.pages.length);

    // All 3 post records must be stamped with the last captured page ID
    // (the extract-step's page).
    const lastPageId = result.pages[result.pages.length - 1].id;
    for (let i = 0; i < 3; i++) {
      assert.equal(result.finalResult.posts[i].sourcePageId, lastPageId,
        `posts[${i}].sourcePageId must be the last captured page ID`);
    }

    // pagesTruncated is 0 (under cap).
    assert.equal(result.pagesTruncated, 0);

    // No page entry should have html over 80K (FB pages are big, but the
    // test snapshots are tiny).
    for (const p of result.pages) {
      assert.ok(p.html.length <= 80000 || p.truncated === true,
        `page ${p.id} html over cap must be flagged truncated`);
    }
  });

  it('produces pages[] even when the orchestrator hits an error mid-execution', async () => {
    // Scroll step polls, then extract step throws. The error envelope must
    // still carry pages captured up to that point (mirrors the existing
    // behavior where error.steps preserves the trace).
    const service = {
      targetUrl: 'https://example.com',
      steps: [
        { id: 'scroll', name: 'Scroll', script: 's', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 5 },
        { id: 'extract', name: 'Extract', script: 'e', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    let iter = 0;
    const deps = {
      createTab: async (url) => ({ id: 1, url }),
      waitForTabLoad: async () => {},
      executeScript: async () => {
        iter++;
        if (iter <= 2) return { result: { done: false } };
        if (iter === 3) return { result: { done: true } };
        throw new Error('EXTRACT_FAILED');
      },
      captureSnapshot: async () => ({ html: '<html>state-' + iter + '</html>', url: 'https://example.com', title: '' }),
      removeTab: async () => {},
      evaluateCondition: async () => true,
      resetDomActivity: async () => {},
      getDomActivity: async () => []
    };

    let caught = null;
    try {
      await StepOrchestrator.execute(service, {}, deps);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'orchestrator must throw');
    assert.ok(Array.isArray(caught.pages), 'error envelope must carry pages[]');
    assert.ok(caught.pages.length >= 2, 'at least 2 page captures before the error');
    assert.equal(typeof caught.pagesTruncated, 'number');
  });
});
