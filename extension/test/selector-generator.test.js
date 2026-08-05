const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildSegment } = require('../lib/selector-generator');

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  global.CSS = dom.window.CSS;
  return dom;
}

describe('buildSegment', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('returns "#id" when element has an id', () => {
    const el = document.createElement('div');
    el.id = 'main';
    assert.equal(buildSegment(el), '#main');
  });

  it('returns tag + [role] when no id but role present', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'article');
    assert.equal(buildSegment(el), 'div[role="article"]');
  });

  it('returns tag + [aria-posinset="N"] when present', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-posinset', '2');
    assert.equal(buildSegment(el), 'div[aria-posinset="2"]');
  });

  it('skips auto-generated React className (x-prefix hash)', () => {
    const el = document.createElement('div');
    el.className = 'x9f619 x1n2onr6';
    assert.equal(buildSegment(el), 'div');
  });

  it('skips html-* and _-prefix classes', () => {
    const el = document.createElement('h3');
    el.className = 'html-h3 _a58j';
    assert.equal(buildSegment(el), 'h3');
  });

  it('skips base36 Facebook-style classes (xjp7ctv, xjbqb8w)', () => {
    // Real Facebook classes use base36 hashes, not hex — this was a regression that
    // caused selectors to bloat with auto-gen classes and break LCP-based pattern derivation.
    const el = document.createElement('a');
    el.className = 'xjp7ctv xjbqb8w xpdmqnj xyri2b';
    assert.equal(buildSegment(el), 'a');
  });

  it('keeps semantic className (no auto-gen pattern)', () => {
    const el = document.createElement('div');
    el.className = 'post-card featured';
    assert.equal(buildSegment(el), 'div.post-card.featured');
  });

  it('returns bare tag when nothing else available', () => {
    const el = document.createElement('span');
    assert.equal(buildSegment(el), 'span');
  });

  it('stacks multiple stable attributes', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'article');
    el.setAttribute('aria-posinset', '3');
    el.setAttribute('data-testid', 'post');
    assert.equal(
      buildSegment(el),
      'div[role="article"][aria-posinset="3"][data-testid="post"]'
    );
  });

  it('escapes quotes in attribute values', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-label', 'she said "hi"');
    // CSS.escape wraps in quotes and escapes inner quotes
    const result = buildSegment(el);
    assert.ok(result.startsWith('div[aria-label='), 'should start with attr name');
    assert.ok(result.includes('she said'), 'should contain the value');
  });
});

const { generateSelector } = require('../lib/selector-generator');

describe('generateSelector', () => {
  it('returns "body" for null input', () => {
    assert.equal(generateSelector(null, document), 'body');
  });

  it('returns "body" for detached element with no ownerDoc', () => {
    setupDOM('<!DOCTYPE html><html><body><div id="x"></div></body></html>');
    const el = document.createElement('span');
    assert.equal(generateSelector(el, document), 'span');
  });

  it('returns "#id" when element has an id', () => {
    setupDOM('<!DOCTYPE html><html><body><div id="main"></div></body></html>');
    const el = document.getElementById('main');
    assert.equal(generateSelector(el, document), '#main');
  });

  it('returns short stable selector when role uniquely identifies', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<main><div role="article"></div></main>' +
      '</body></html>'
    );
    const el = document.querySelector('div[role="article"]');
    assert.equal(generateSelector(el, document), 'div[role="article"]');
  });

  it('appends leaf :nth-of-type when siblings share stable attrs', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div role="article"></div>' +
      '<div role="article"></div>' +
      '<div role="article"></div>' +
      '</body></html>'
    );
    // Click on the 3rd article. Siblings share identical stable attrs
    // (role="article"), so the only way to disambiguate is positional
    // :nth-of-type on the leaf.
    const articles = document.querySelectorAll('div[role="article"]');
    const target = articles[2];
    const sel = generateSelector(target, document);
    assert.ok(sel.includes('nth-of-type(3)'), `expected nth-of-type(3) in "${sel}"`);
    assert.ok(sel.includes('role="article"'), `expected role attr in "${sel}"`);
    // Should NOT contain a long chain of nth-of-type segments.
    const nthCount = (sel.match(/:nth-of-type/g) || []).length;
    assert.equal(nthCount, 1, `expected exactly 1 nth-of-type, got ${nthCount} in "${sel}"`);
  });

  it('walks up to find uniqueness when leaf is ambiguous', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<section id="posts"><div role="row"></div><div role="row"></div></section>' +
      '<section id="comments"><div role="row"></div></section>' +
      '</body></html>'
    );
    // First row in #posts — ambiguous at leaf, but section#posts disambiguates.
    const target = document.querySelectorAll('#posts div[role="row"]')[0];
    const sel = generateSelector(target, document);
    assert.ok(sel.includes('#posts'), `expected #posts in "${sel}"`);
    assert.ok(sel.includes('role="row"'), `expected role=row in "${sel}"`);
  });

  it('produces no chain for top-level unique element', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<button aria-label="Like"></button>' +
      '</body></html>'
    );
    const el = document.querySelector('button[aria-label]');
    const sel = generateSelector(el, document);
    assert.equal(sel, 'button[aria-label="Like"]');
  });

  it('does not emit auto-generated className in the chain', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div class="x9f619 x1n2onr6"><span class="xeuugli">hi</span></div>' +
      '</body></html>'
    );
    const el = document.querySelector('span');
    const sel = generateSelector(el, document);
    assert.ok(!/\.x[0-9a-f]+/i.test(sel), `should not contain auto-gen class in "${sel}"`);
    assert.ok(sel.startsWith('span'), `should start with tag in "${sel}"`);
  });

  // Regression: bugx.log showed annotation selectors like
  //   #mount_0_0_UD > div > div > div > div > div > div ... > a[role="link"]
  // across 4 wizard runs with mount IDs UD, 0G, ey — each a different random
  // suffix. Facebook's React mount point id changes per page load, so any
  // selector anchored on it breaks across reloads and doesn't match sibling
  // list items. The generator must walk PAST random ids to find a stable
  // semantic anchor.
  it('does not anchor on Facebook-style mount_0_0_<suffix> random ids', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div id="mount_0_0_UD">' +
        '<div><div><div>' +
          '<div role="article"><h3><a role="link">Name</a></h3></div>' +
          '<div role="article"><h3><a role="link">Other</a></h3></div>' +
        '</div></div></div>' +
      '</div>' +
      '</body></html>'
    );
    // Click the first <a role="link">. Two siblings share [role="link"], so
    // the generator walks up. It must NOT stop at #mount_0_0_UD — that id
    // is random per page load. Expected: anchor on div[role="article"].
    const el = document.querySelectorAll('a[role="link"]')[0];
    const sel = generateSelector(el, document);
    assert.ok(!/mount_0_0/i.test(sel), `should not anchor on mount_0_0 id, got "${sel}"`);
    assert.ok(sel.includes('role="link"'), `should keep role=link on leaf, got "${sel}"`);
  });

  it('does not anchor on react-aria or headlessui random ids', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div id="react-aria-:r3:">' +
        '<button aria-label="Like">Like</button>' +
        '<button aria-label="Like">Other</button>' +
      '</div>' +
      '</body></html>'
    );
    // Two buttons share aria-label="Like", so generator walks up. Must not
    // stop at react-aria id.
    const el = document.querySelectorAll('button[aria-label="Like"]')[0];
    const sel = generateSelector(el, document);
    assert.ok(!/react-aria/i.test(sel), `should not anchor on react-aria id, got "${sel}"`);
  });

  it('still anchors on semantic (hyphen-separated) ids when leaf is ambiguous', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div id="post-list"><span class="title">Hello</span><span class="title">World</span></div>' +
      '<div id="comment-list"><span class="title">Other</span></div>' +
      '</body></html>'
    );
    // Multiple span.title across containers — generator must walk up to
    // disambiguate. Semantic id #post-list is fine to anchor on.
    const el = document.querySelectorAll('#post-list span.title')[0];
    const sel = generateSelector(el, document);
    assert.ok(sel.includes('#post-list'), `should anchor on semantic id, got "${sel}"`);
  });
});

const { generateFullDomPath } = require('../lib/selector-generator');

describe('generateFullDomPath', () => {
  it('returns "body" for null input', () => {
    assert.equal(generateFullDomPath(null, document), 'body');
  });

  it('returns the tag name when element is detached from body', () => {
    setupDOM('<!DOCTYPE html><html><body><div id="x"></div></body></html>');
    const el = document.createElement('span');
    assert.equal(generateFullDomPath(el, document), 'span');
  });

  it('returns the full ancestry chain for a deeply nested element', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div role="main">' +
        '<div role="feed">' +
          '<div role="article" aria-posinset="1">' +
            '<h3><span><a aria-label="alice" href="/user/alice">Alice</a></span></h3>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</body></html>'
    );
    const el = document.querySelector('a[aria-label="alice"]');
    const full = generateFullDomPath(el, document);
    // Full path must include the parent article container — that's the whole
    // point of generateFullDomPath (vs generateSelector which early-stops).
    assert.ok(full.includes('div[role="article"][aria-posinset="1"]'),
      `full domPath should include parent article context, got "${full}"`);
    assert.ok(full.includes('a[aria-label="alice"]'),
      `full domPath should include the leaf, got "${full}"`);
    // Sanity: must be longer than the early-stop selector.
    const short = generateSelector(el, document);
    assert.ok(full.split(' > ').length >= short.split(' > ').length,
      `full path (${full.split(' > ').length} segs) should be >= short (${short.split(' > ').length} segs)`);
  });

  it('does NOT early-stop at a globally-unique aria-label (the regression case)', () => {
    // Mirrors the FB "group name link" case from console.log 2026-08-05:
    // each post has a unique aria-label on its author link, so generateSelector
    // returns just 'a[role="link"][aria-label="..."]' (1 segment). The clusterer
    // then sees no item-level marker and falls through to single-sample.
    // generateFullDomPath must NOT short-circuit — it must walk to the article.
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div role="main">' +
        '<div role="feed">' +
          '<div role="article" aria-posinset="1">' +
            '<h3><a role="link" aria-label="alice" href="/user/alice">Alice</a></h3>' +
          '</div>' +
          '<div role="article" aria-posinset="2">' +
            '<h3><a role="link" aria-label="bob" href="/user/bob">Bob</a></h3>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</body></html>'
    );
    const aliceLink = document.querySelector('a[aria-label="alice"]');
    const short = generateSelector(aliceLink, document);
    const full = generateFullDomPath(aliceLink, document);
    // Confirm the test setup actually triggers the early-stop on the short side.
    assert.equal(short.split(' > ').length, 1,
      `expected short selector to early-stop at depth 1, got "${short}"`);
    // Confirm the full path walks past the early-stop.
    assert.ok(full.includes('div[role="article"][aria-posinset="1"]'),
      `full domPath must include article context despite unique aria-label, got "${full}"`);
  });

  it('does not append :nth-of-type(N) disambiguation (full path is for context, not execution)', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div role="feed">' +
        '<div role="article" aria-posinset="1"><span class="title">A</span></div>' +
        '<div role="article" aria-posinset="2"><span class="title">B</span></div>' +
      '</div>' +
      '</body></html>'
    );
    const el = document.querySelectorAll('span.title')[0];
    const full = generateFullDomPath(el, document);
    assert.ok(!/:nth-of-type/.test(full),
      `full domPath should not contain :nth-of-type, got "${full}"`);
  });
});

describe('generateFullDomPath + clusterAnnotationsByContainer integration', () => {
  // The actual user scenario: clicking unique-label links inside multiple
  // list items. Phase 1 clustering fell through to single-sample because
  // annotation.domPath aliased annotation.selector (early-stop). With
  // generateFullDomPath, the clusterer should now correctly branch.
  beforeEach(() => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div role="main">' +
        '<div role="feed">' +
          '<div role="article" aria-posinset="1">' +
            '<h3><a role="link" aria-label="groupA" href="/groups/1">Group A</a></h3>' +
            '<div><a role="link" aria-label="userA" href="/user/1">User A</a></div>' +
          '</div>' +
          '<div role="article" aria-posinset="2">' +
            '<h3><a role="link" aria-label="groupB" href="/groups/2">Group B</a></h3>' +
            '<div><a role="link" aria-label="userB" href="/user/2">User B</a></div>' +
          '</div>' +
          '<div role="article" aria-posinset="3">' +
            '<h3><a role="link" aria-label="userC" href="/user/3">User C</a></h3>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</body></html>'
    );
  });

  it('clusters unique-label annotations into separate samples when given full domPaths', () => {
    const { clusterAnnotationsByContainer } = require('../lib/annotation-cluster');
    // Simulate the user's clicks: 3 group/user annotations across 3 posts.
    // Each annotation.selector is short (early-stopped), but each .domPath
    // is the full chain (from generateFullDomPath).
    const targets = [
      { label: 'groupA', field: 'posts.group.name' },
      { label: 'groupB', field: 'posts.group.name' },
      { label: 'userC', field: 'posts.account.username' },
    ];
    const annotations = targets.map(t => {
      const el = document.querySelector(`a[aria-label="${t.label}"]`);
      return {
        type: 'extract',
        outputField: t.field,
        selector: generateSelector(el, document),
        domPath: generateFullDomPath(el, document),
      };
    });
    // Sanity: confirm selectors are short (early-stop fired).
    assert.ok(annotations.every(a => a.selector.split(' > ').length === 1),
      'test setup: selectors should be 1 segment each');
    // The fix: domPaths are long enough to include the article-posinset context.
    const r = clusterAnnotationsByContainer(annotations);
    assert.equal(r.samples.length, 3,
      `should branch into 3 samples (one per aria-posinset), got ${r.samples.length}`);
    assert.ok(r.samples.every(s => s.confidence === 'high'),
      'all samples should be HIGH confidence (article-posinset is item-level)');
  });
});
