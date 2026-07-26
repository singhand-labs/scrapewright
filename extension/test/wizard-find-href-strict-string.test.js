// Regression test for wizard.js findHrefInObject. Extracts the function from
// wizard.js source text and exercises it against fixtures. The function used
// to return ANY truthy value for item.href/link/url — including function
// references — which crashed chrome.tabs.create with "Invalid type: expected
// string, found function" when the LLM-generated step result happened to have
// a non-string truthy `href`/`link`/`url` field somewhere in its tree.
//
// wizard.js can't be loaded directly in Node (it uses chrome.* APIs and DOM
// globals), so we extract the function source via a regex and evaluate it in
// a sandboxed Function. If wizard.js's findHrefInObject ever moves or changes
// shape, the regex below will fail to match and the test will surface that.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

function loadFindHrefInObject() {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');
  // findHrefInObject is followed by restoreBestAttempt in wizard.js — use
  // that as the trailing sentinel. (`findSampleDetailUrl` is BEFORE
  // findHrefInObject, not after, so it can't serve as the end marker.)
  const m = src.match(/function\s+findHrefInObject\s*\([\s\S]*?\nfunction\s+restoreBestAttempt\s*\(/);
  assert.ok(m, 'wizard.js: findHrefInObject function not found — has it been renamed or moved?');
  // Slice off the trailing `\nfunction restoreBestAttempt(` marker.
  const fnSrc = m[0].replace(/\nfunction\s+restoreBestAttempt\s*\($/, '');
  // eslint-disable-next-line no-new-func
  return new Function(fnSrc + '\nreturn findHrefInObject;')();
}

describe('findHrefInObject strict-string enforcement', () => {
  const findHrefInObject = loadFindHrefInObject();

  it('returns a string href from array items', () => {
    const obj = { posts: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }] };
    assert.equal(findHrefInObject(obj), 'https://example.com/a');
  });

  it('returns null when href/link/url fields are functions (regression)', () => {
    // This is the exact failure mode from the user's autoFix crash: an
    // LLM-generated result had a function-typed `url` field somewhere in the
    // tree, and the old `if (item?.url) return item.url;` returned it raw.
    const obj = {
      posts: [
        { author: 'alice', url: () => 'https://example.com/a' },
        { author: 'bob', link: function () { return 'https://example.com/b'; } }
      ]
    };
    assert.equal(findHrefInObject(obj), null);
  });

  it('returns null when href/link/url fields are objects or numbers', () => {
    const obj = {
      items: [
        { href: { toString: () => 'https://example.com' } },
        { link: 42 },
        { url: ['https://example.com'] }
      ]
    };
    assert.equal(findHrefInObject(obj), null);
  });

  it('still finds a real string url alongside non-string truthy siblings', () => {
    const obj = {
      items: [
        { url: () => 'skipped' },        // function — must be skipped
        { link: { not: 'a string' } },   // object — must be skipped
        { url: 'https://example.com/real' } // string — must be found
      ]
    };
    assert.equal(findHrefInObject(obj), 'https://example.com/real');
  });

  it('returns a string value that starts with http directly on the object', () => {
    const obj = { sourceUrl: 'https://example.com/list', posts: [] };
    assert.equal(findHrefInObject(obj), 'https://example.com/list');
  });

  it('recurses into nested objects (depth-bounded)', () => {
    const obj = { outer: { inner: { deep: [{ url: 'https://example.com/deep' }] } } };
    assert.equal(findHrefInObject(obj), 'https://example.com/deep');
  });

  it('returns null on null/undefined/non-object input', () => {
    assert.equal(findHrefInObject(null), null);
    assert.equal(findHrefInObject(undefined), null);
    assert.equal(findHrefInObject('string'), null);
    assert.equal(findHrefInObject(42), null);
  });
});

describe('findHrefInObject chrome.tabs.create guard', () => {
  it('every chrome.tabs.create({ url: detailUrl }) site is type-guarded', () => {
    // Structural check: there are THREE call sites that pass detailUrl to
    // chrome.tabs.create (generateStepsWithSelectors, improveStep,
    // runFixIteration). Each must be guarded so a non-string detailUrl never
    // reaches the Chrome API. The guards live in different shapes per site
    // (early-return / if-else branch / typeof check) — what matters is that
    // SOME form of typeof-string check appears in the 1500 chars before the
    // call, since all three sites use `if (typeof detailUrl ...)` immediately
    // before the create call.
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const probe = 'chrome.tabs.create({ url: detailUrl';
    let cursor = 0;
    const sites = [];
    while (true) {
      const idx = src.indexOf(probe, cursor);
      if (idx === -1) break;
      sites.push(idx);
      cursor = idx + probe.length;
    }
    assert.ok(sites.length >= 3, `wizard.js: expected ≥3 chrome.tabs.create({ url: detailUrl }) sites, found ${sites.length}`);

    for (const idx of sites) {
      // Look at the 1500 chars preceding the call — that contains the
      // enclosing if/else branch with the typeof guard.
      const preceding = src.slice(Math.max(0, idx - 1500), idx);
      assert.ok(
        /typeof\s+detailUrl\s*!==\s*['"]string['"]/.test(preceding) ||
        /typeof\s+detailUrl\s*===\s*['"]string['"]/.test(preceding),
        `wizard.js: chrome.tabs.create({ url: detailUrl }) at offset ${idx} has no typeof detailUrl === 'string' guard in preceding 1500 chars`
      );
    }
  });
});
