// Regression for the two "Failed to create tab (10s timeout)" testScript
// failures (console.log 2026-08-31 17:25:31 and 2026-09-01 04:40:13).
//
// The 10s budget in wizard.js testScript wraps createScrapeTab, which is
// tabs.create + keepalive inject + keepalive VERIFY. The log timelines show
// the tab and the injection finished fast — what blew the budget was the
// VERIFY probe:
//
//   17:25:21.556 testScript start → 23.578 inject ok (2.0s) → 31.560
//   TIMEOUT (exactly 10s) → 33.473 verify completes (11.9s, AFTER the error)
//   04:40:03.746 start → 04.805 inject ok (1.1s) → 13.775 TIMEOUT →
//   14.007 verify completes (10.3s, again after the error)
//
// Why verify is slow: its chrome.scripting.executeScript call omitted
// injectImmediately, so the probe runs at document_idle — on a slow site in
// a throttled BACKGROUND tab that means "after the page finishes loading",
// which is exactly the site-dependent wait the 10s create budget was never
// meant to cover. (Both verifies also reported injected:false /
// visibilityState:'hidden' — by document_idle the tab had navigated past
// the transient pre-load context the early injection landed in, the known
// RC16 behavior; the probe was reading back a document the injection never
// survived to reach.)
//
// So the answer to "is 10s too short for slow sites?" is no: the budget is
// fine, it just contained a diagnostic that has no business being on the
// critical path. Fix:
//   1. scrape-tab.js afterTabOpen fires verify detached (log when it
//      lands, warn on rejection) instead of awaiting it.
//   2. visibility-keepalive.js verify probe carries injectImmediately:true
//      like the inject call — probes the context the injection actually
//      landed in, and never queues behind page load.
//   3. wizard.js testScript createTab dep closes a tab that arrives after
//      the timeout fired — both logged failures leaked an invisible
//      background tab (tabId 1761022768 / 1761022775 appear in exactly two
//      log lines each and never in a "Tab removed" line).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRAPE_TAB_PATH = path.join(__dirname, '..', 'lib', 'scrape-tab.js');
const VISIBILITY_PATH = path.join(__dirname, '..', 'lib', 'visibility-keepalive.js');
const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function loadScrapeTab({ verifyImpl }) {
  const calls = { tabsCreate: [], tabsRemove: [], inject: [], verify: [] };
  const sandbox = {
    chrome: {
      tabs: {
        create: async (opts) => {
          calls.tabsCreate.push(opts);
          return { id: 1, url: opts && opts.url };
        },
        remove: async (tabId) => { calls.tabsRemove.push(tabId); }
      }
    },
    module: { exports: {} },
    console: { log() {}, warn() {}, error() {} },
    debugLogger: { log() {} },
    injectVisibilityKeepalive: async (tabId) => {
      calls.inject.push(tabId);
      return { ok: true, frameCount: 1, returnValue: null };
    },
    verifyVisibilityKeepalive: (tabId) => {
      calls.verify.push(tabId);
      return verifyImpl(tabId);
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SCRAPE_TAB_PATH, 'utf8'), sandbox);
  return { api: sandbox.module.exports, calls };
}

describe('scrape-tab.js: verify is off the create critical path', () => {
  it('createScrapeTab resolves while verify is still pending (the logged failure shape)', async () => {
    // Never-resolving verify = the document_idle wait on a slow site that
    // blew the 10s budget. createScrapeTab must not wait for it.
    const { api } = loadScrapeTab({ verifyImpl: () => new Promise(() => {}) });
    const tab = await Promise.race([
      api.createScrapeTab('https://slow.example'),
      delay(500).then(() => {
        throw new Error('createScrapeTab blocked on verifyVisibilityKeepalive — the diagnostic is back on the critical path');
      })
    ]);
    assert.equal(tab.id, 1);
  });

  it('verify is still invoked exactly once (diagnostic preserved, just detached)', async () => {
    const { api, calls } = loadScrapeTab({ verifyImpl: () => delay(50) });
    await api.createScrapeTab('https://x.example');
    assert.equal(calls.verify.length, 1);
    assert.equal(calls.inject.length, 1);
  });

  it('a rejecting detached verify does not become an unhandled rejection', async () => {
    const { api } = loadScrapeTab({ verifyImpl: () => Promise.reject(new Error('probe failed')) });
    const tab = await api.createScrapeTab('https://x.example');
    await delay(50); // give the rejected detached promise a chance to surface
    assert.equal(tab.id, 1);
  });
});

describe('visibility-keepalive.js: verify probe runs immediately', () => {
  function loadVisibility() {
    const captured = [];
    const sandbox = {
      chrome: {
        scripting: {
          executeScript: async (options) => {
            captured.push(options);
            return [{ result: { injected: true, visibilityState: 'visible' } }];
          }
        }
      },
      module: { exports: {} },
      console: { log() {}, warn() {}, error() {} }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(VISIBILITY_PATH, 'utf8'), sandbox);
    return { api: sandbox.module.exports, captured };
  }

  it('verify probe carries injectImmediately:true (no document_idle queueing)', async () => {
    const { api, captured } = loadVisibility();
    await api.verifyVisibilityKeepalive(5);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].injectImmediately, true,
      'without injectImmediately the probe waits for document_idle — on a slow background tab that is site load time inside the tab-CREATE budget');
    assert.equal(captured[0].world, 'MAIN');
  });

  it('inject probe keeps injectImmediately:true (guard both directions)', async () => {
    const { api, captured } = loadVisibility();
    await api.injectVisibilityKeepalive(5);
    assert.equal(captured[0].injectImmediately, true);
    assert.equal(captured[0].world, 'MAIN');
  });
});

describe('wizard.js: timeout path closes a late-arriving tab', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');

  function createTabDepChunk() {
    const start = src.indexOf('createTab: async (url)');
    assert.ok(start > 0, 'createTab dep found in testScript');
    const end = src.indexOf('waitForTabLoad:', start);
    return src.slice(start, end);
  }

  it('a late-resolving createScrapeTab is closed instead of leaked', () => {
    const chunk = createTabDepChunk();
    assert.ok(/createTimedOut/.test(chunk),
      'the dep must track that the timeout fired');
    assert.ok(/closeScrapeTab\s*\(/.test(chunk),
      'a tab resolving after the timeout must be closed — both logged failures leaked an invisible background tab');
  });

  it('the create budget stays 10s and the wrapper is intact', () => {
    const chunk = createTabDepChunk();
    assert.ok(/withTimeout\(\s*\w+,\s*10000,\s*'Failed to create tab \(10s timeout\)'\s*\)/.test(chunk),
      'the 10s budget must remain — with verify detached it only covers site-independent work');
  });
});
