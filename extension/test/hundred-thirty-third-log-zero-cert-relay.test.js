// extension/test/hundred-thirty-third-log-zero-cert-relay.test.js
//
// 133rd live log (fourth session on the same FB search target; 80/80
// maxTurns, v5 mid-fix when the budget died). Two infrastructure defects:
//
// (A) $collectUntil CERTIFIED EXHAUSTION AT ZERO: two receipts read
//     {collected:0, target:6, certifiedExhaustion:true} — the certification
//     never required the unique count to have been POSITIVE. A counter that
//     never rose above 0 is the fourth-log zero-trap class: it cannot
//     prove exhaustion, only that the selector matched nothing (the feed
//     may render items under a different shape). The 118th primitive now
//     refuses to certify at never-positive and discloses a selector-blind
//     note teaching the population census instead. One of the incident
//     receipts also burned 110948ms reaching the degenerate verdict.
//
// (B) DOM_REQUEST RELAY WITH tabId NULL: the background retried
//     chrome.tabs.sendMessage(null, ...) four times with 1s sleeps before
//     answering ("No matching signature" — offscreen's routing stack had
//     been cleaned by a timed-out execution). The relay now answers
//     immediately for a null tabId, naming the lost routing.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function sliceFn(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i > -1, marker + ' found');
  let depth = 0, j = i;
  for (j = i; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(i, j + 1);
}

describe('133rd log — $collectUntil refuses to certify exhaustion at never-positive', () => {
  const CSRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

  function makeCtx(counts) {
    let rounds = 0;
    const ctx = {
      setTimeout, clearTimeout,
      querySelectorAllDeep: () => {
        const n = counts[Math.min(rounds, counts.length - 1)];
        return Array.from({ length: n }, (_, k) => ({ element: { getAttribute: (a) => a === 'href' ? '/p' + k : null } }));
      },
      getScrollOps: () => ({ scrollToBottomIncremental: async () => { rounds += 1; return { stalled: rounds >= 2, newScrollHeight: 1000, attempts: 1 }; } }),
      withTabActivation: async (l, fn) => fn(),
      resolveScrollTarget: () => null,
      sendDebugLog: () => {},
      notifyBackgroundDiagnostic: () => {},
      // 138th log: domCollectUntil consults the outer-deadline guard
      // (no deadline in these tests -> always null).
      outerDeadlineExceeded: () => null,
      setTimeoutGlobal: null
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn(CSRC, 'async function domCollectUntil') + '\nthis.__f = domCollectUntil;', ctx);
    return ctx;
  }

  it('unique count stuck at 0 + stalled scroll → NOT certified; selector-blind note teaches the census', async () => {
    const ctx = makeCtx([0, 0, 0, 0]);
    const r = await ctx.__f('div.card', { targetCount: 4, idAttr: 'href', settleMs: 5 });
    assert.equal(r.satisfied, false);
    assert.equal(r.collected, 0);
    assert.ok(!r.exhaustion || r.exhaustion.certified !== true,
      'a never-positive counter cannot certify exhaustion — got ' + JSON.stringify(r.exhaustion));
    assert.ok(r.selectorBlind && /never rose above 0/.test(String(r.selectorBlind.note || r.selectorBlind)),
      'the receipt names the zero-trap diagnosis');
    assert.match(String(r.selectorBlind.note || r.selectorBlind), /census|differential|broader parent/i,
      'the note teaches the population check');
  });

  it('unique count stuck at a POSITIVE value + stalled scroll → certification stands (exhaustion is provable)', async () => {
    const ctx = makeCtx([2, 2, 2, 2]);
    const r = await ctx.__f('div.card', { targetCount: 4, idAttr: 'href', settleMs: 5 });
    assert.equal(r.satisfied, false);
    assert.equal(r.collected, 2);
    assert.ok(r.exhaustion && r.exhaustion.certified === true, 'a positive frozen population certifies as before');
    assert.ok(!r.selectorBlind, 'no blind note on a positive population');
  });

  it('growth then freeze still certifies (the population demonstrably exists)', async () => {
    const ctx = makeCtx([1, 2, 2, 2]);
    const r = await ctx.__f('div.card', { targetCount: 4, idAttr: 'href', settleMs: 5 });
    assert.equal(r.collected, 2);
    assert.ok(r.exhaustion && r.exhaustion.certified === true);
  });
});

describe('133rd log — DOM_REQUEST relay answers a null tabId immediately', () => {
  function loadBackground() {
    const listeners = [];
    const noopL = { addListener: () => {}, removeListener: () => {} };
    const sentRuntime = [];
    const tabsCalls = [];
    const chrome = {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
        onInstalled: noopL, onStartup: noopL,
        sendMessage: async (m) => { sentRuntime.push(m); },
        getContexts: async () => [],
        getURL: (p) => 'x/' + p,
        lastError: undefined
      },
      tabs: {
        onRemoved: noopL, onActivated: noopL, onUpdated: noopL, onCreated: noopL,
        sendMessage: async (tabId) => { tabsCalls.push(tabId); throw new Error('Error in invocation of tabs.sendMessage(integer tabId, any message, optional object options, optional function callback): No matching signature.'); },
        create: async () => ({ id: 1 }), query: async () => [], update: async () => ({}), get: async () => ({})
      },
      storage: {
        local: { get: async () => ({}), set: async () => {}, onChanged: noopL },
        session: { get: async () => ({}), set: async () => {}, onChanged: noopL },
        onChanged: noopL
      },
      offscreen: { createDocument: async () => {}, hasDocument: async () => false },
      scripting: { executeScript: async () => [] },
      action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, onClicked: noopL },
      alarms: { create: () => {}, onAlarm: noopL, clear: () => {} },
      windows: { onFocusChanged: noopL, getAll: async () => [], update: async () => ({}), onCreated: noopL, onRemoved: noopL },
      debugger: { attach: () => {}, sendCommand: () => {}, detach: () => {}, onDetach: noopL },
      webNavigation: { onCompleted: noopL, onHistoryStateUpdated: noopL },
      notifications: { create: () => {} }
    };
    const sandbox = {
      chrome,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      setTimeout, clearTimeout, setInterval, clearInterval,
      crypto, URL, URLSearchParams, TextEncoder, TextDecoder,
      navigator: {}, performance, Date, Promise, structuredClone,
      location: { href: 'chrome-extension://x/background.js' }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.importScripts = (...files) => {
      for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
    return { listeners, sentRuntime, tabsCalls };
  }

  it('a null-tabId DOM_REQUEST gets an immediate RELAY_FAILED naming the lost routing — no 4x retry, no 3s stall', async () => {
    const { listeners, sentRuntime, tabsCalls } = loadBackground();
    const t0 = Date.now();
    listeners[listeners.length - 1](
      { type: 'DOM_REQUEST', _fromOffscreen: true, id: 't-null', action: 'extractList', tabId: null },
      { tab: null },
      () => {}
    );
    await new Promise((r) => setTimeout(r, 150));
    const resp = sentRuntime.find((m) => m && m.type === 'DOM_RESPONSE' && m.id === 't-null');
    assert.ok(resp, 'a DOM_RESPONSE came back — got ' + JSON.stringify(sentRuntime.map((m) => m.type)));
    assert.match(String(resp.error), /no target tab|RELAY_FAILED/i);
    assert.match(String(resp.error), /routing|timed-out|cleaned/i, 'names the lost-routing cause');
    assert.equal(tabsCalls.length, 0, 'chrome.tabs.sendMessage was never called with a null tabId');
    assert.ok(Date.now() - t0 < 1000, 'answered fast — no retry ladder against an invalid tabId');
  });
});
