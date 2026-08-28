const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveOpenTabUrl } = require('../lib/open-tab-url');

describe('$openTab URL normalization', () => {
  it('preserves an absolute HTTPS URL', () => {
    assert.equal(
      resolveOpenTabUrl('https://example.com/items/1', 'https://parent.test/list'),
      'https://example.com/items/1'
    );
  });

  it('resolves a root-relative URL against the parent origin', () => {
    assert.equal(
      resolveOpenTabUrl('/owner/repository', 'https://github.com/search?q=test'),
      'https://github.com/owner/repository'
    );
  });

  it('resolves a path-relative URL against the parent page', () => {
    assert.equal(
      resolveOpenTabUrl('../details/1', 'https://example.com/results/page/'),
      'https://example.com/results/details/1'
    );
  });

  it('rejects a relative URL when no parent URL is available', () => {
    assert.throws(
      () => resolveOpenTabUrl('/owner/repository', null),
      /relative URL requires a parent page URL/
    );
  });

  for (const unsafe of ['javascript:alert(1)', 'data:text/html,hello', 'chrome://settings', 'file:///tmp/x']) {
    it(`rejects unsafe destination ${unsafe.split(':')[0]}:`, () => {
      assert.throws(
        () => resolveOpenTabUrl(unsafe, 'https://example.com/list'),
        /only HTTP\(S\) destinations are allowed/
      );
    });
  }
});

describe('$openTab background wiring', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  it('imports the URL-normalization helper', () => {
    assert.match(background, /['"]lib\/open-tab-url\.js['"]/);
  });

  it('resolves the URL before creating the scrape tab', () => {
    const start = background.indexOf('async function handleOpenTabExecute');
    const end = background.indexOf('\nasync function ', start + 20);
    const body = background.slice(start, end === -1 ? undefined : end);
    const resolveAt = body.indexOf('OpenTabUrl.resolveOpenTabUrl');
    const createAt = body.indexOf('createScrapeTab(resolvedUrl)');
    assert.ok(resolveAt >= 0, 'handleOpenTabExecute must normalize the destination');
    assert.ok(createAt > resolveAt, 'normalization must happen before tab creation');
  });

  it('prefers the browser-authenticated sender tab for parent context', () => {
    assert.match(
      background,
      /const openTabParentId = sender\.tab\?\.id \|\| message\.parentTabId;/,
      'OPEN_TAB_EXECUTE must not trust a message-provided parent ID when sender.tab.id is available'
    );
    assert.match(background, /handleOpenTabExecute\(message\.url, message\.script, openTabParentId, message\.reqId\)/);
  });
});
