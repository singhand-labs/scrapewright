// extension/test/live-rail.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveRail } = require('../lib/live-rail');

function makeDeps(overrides) {
  const d = Object.assign({
    defaultUrl: 'https://example.com/list',
    createTab: async (url) => ({ id: 7, url }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    getTab: async (id) => ({ id, url: 'https://example.com/list', title: 'List', status: 'complete' }),
    pingReady: async () => true,
    execute: async (tabId, snippet) => ({ result: 42, snippet }),
    acquireLock: async () => { d.lockAcquires += 1; },
    releaseLock: async () => { d.lockReleases += 1; },
    log: () => {},
    lockAcquires: 0,
    lockReleases: 0
  }, overrides || {});
  return d;
}

describe('createLiveRail', () => {
  it('requires the core dep functions', () => {
    assert.throws(() => createLiveRail({}), /createTab/);
  });

  it('pageOpen creates the tab, waits for load, pings readiness, returns tabId', async () => {
    const d = makeDeps();
    const rail = createLiveRail(d);
    const r = await rail.pageOpen({});
    assert.deepEqual(Object.keys(r).sort(), ['ready', 'tabId', 'url']);
    assert.equal(r.tabId, 7);
    assert.equal(r.url, 'https://example.com/list');
    assert.equal(r.ready, true);
    assert.equal(d.lockAcquires, 1, 'opening a page takes the exec lock');
  });

  it('pageOpen falls back to defaultUrl, rejects non-http urls', async () => {
    const d = makeDeps();
    const rail = createLiveRail(d);
    const r = await rail.pageOpen({ url: 'file:///etc/passwd' });
    assert.ok(/http/.test(r.error));
    const r2 = await rail.pageOpen({});
    assert.equal(r2.tabId, 7);
  });

  it('pageOpen closes the previous tab first (single-tab model)', async () => {
    const closed = [];
    const d = makeDeps({ removeTab: async (id) => closed.push(id), createTab: async (url) => ({ id: url.length, url }) }); // tab ids = url lengths (19, 20) — distinct, so the close/reopen order is observable
    const rail = createLiveRail(d);
    await rail.pageOpen({ url: 'https://example.com' });
    await rail.pageOpen({ url: 'https://example.co/a' });
    assert.deepEqual(closed, [19], 'first tab closed before second opens');
    assert.equal(rail.tabId, 20);
  });

  it('pageOpen survives load timeout with a warning instead of an error', async () => {
    const d = makeDeps({ waitForTabLoad: async () => { throw new Error('60s exceeded'); } });
    const rail = createLiveRail(d);
    const r = await rail.pageOpen({});
    assert.equal(r.tabId, 7);
    assert.match(r.warning, /60s exceeded/);
  });

  it('pageState reports open tab; dead tab self-heals to open:false with re-open hint', async () => {
    const d = makeDeps();
    const rail = createLiveRail(d);
    assert.match(JSON.stringify(await rail.pageState()), /no page open/);
    await rail.pageOpen({});
    const s = await rail.pageState();
    assert.equal(s.open, true);
    assert.equal(s.url, 'https://example.com/list');
    d.getTab = async () => null;
    const s2 = await rail.pageState();
    assert.equal(s2.open, false);
    assert.match(s2.hint, /page\.open/);
  });

  it('executeDsl requires an open page and routes to the tab; errors degrade to {error}', async () => {
    const d = makeDeps();
    const rail = createLiveRail(d);
    const r0 = await rail.executeDsl('return 1;');
    assert.match(r0.error, /page\.open/);
    await rail.pageOpen({});
    const r = await rail.executeDsl('return $count("div");');
    assert.deepEqual(r, { result: 42, snippet: 'return $count("div");' });
    d.execute = async () => { throw new Error('RELAY_FAILED'); };
    const r2 = await rail.executeDsl('return 1;');
    assert.match(r2.error, /RELAY_FAILED/);
  });

  it('exec lock is exactly-once across ensureLock calls (single _wizardResolve slot)', async () => {
    const d = makeDeps();
    const rail = createLiveRail(d);
    await rail.pageOpen({});
    await rail.ensureLock();
    await rail.ensureLock();
    await rail.ensureLock();
    assert.equal(d.lockAcquires, 1, 'idempotent ensure — second acquire would leak a queue blocker in background.js');
    await rail.releaseLock();
    await rail.releaseLock();
    assert.equal(d.lockReleases, 1);
    await rail.ensureLock();
    assert.equal(d.lockAcquires, 2, 're-acquire after release works');
    await rail.dispose();
    assert.equal(d.lockReleases, 2, 'dispose releases');
  });

  it('dispose closes tab and releases lock; safe when nothing open', async () => {
    const closed = [];
    const d = makeDeps({ removeTab: async (id) => closed.push(id) });
    const rail = createLiveRail(d);
    await rail.dispose();
    assert.deepEqual(closed, []);
    assert.equal(d.lockReleases, 0);
    await rail.pageOpen({});
    await rail.dispose();
    assert.deepEqual(closed, [7]);
    assert.equal(d.lockReleases, 1);
  });

  it('concurrent pageOpen returns an error instead of aliasing the in-flight result', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const d = makeDeps({ waitForTabLoad: async () => { await gate; } });
    const rail = createLiveRail(d);
    const first = rail.pageOpen({});
    const second = await rail.pageOpen({ url: 'https://example.com/other' });
    assert.match(second.error, /already in progress/);
    release();
    const r = await first;
    assert.equal(r.tabId, 7);
  });

  it('pageOpen degrades a pingReady throw to ready:false + warning, never throws', async () => {
    const d = makeDeps({ pingReady: async () => { throw new Error('PING_FAILED'); } });
    const rail = createLiveRail(d);
    const r = await rail.pageOpen({});
    assert.equal(r.tabId, 7);
    assert.equal(r.ready, false);
    assert.match(r.warning, /content script not responding/);
  });

  it('dispose during an in-flight open waits, then closes the created tab', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const closed = [];
    const d = makeDeps({ waitForTabLoad: async () => { await gate; }, removeTab: async (id) => closed.push(id) });
    const rail = createLiveRail(d);
    const first = rail.pageOpen({});
    const done = rail.dispose();
    release();
    await first;
    await done;
    assert.deepEqual(closed, [7]);
  });

  it('releaseLock retries after a failed release (no leaked background blocker)', async () => {
    const d = makeDeps();
    let fail = true;
    d.releaseLock = async () => { if (fail) throw new Error('bg down'); d.lockReleases += 1; };
    const rail = createLiveRail(d);
    await rail.pageOpen({});
    await rail.releaseLock();
    assert.equal(d.lockReleases, 0, 'failed release keeps the lock held');
    fail = false;
    await rail.dispose();
    assert.equal(d.lockReleases, 1, 'dispose retries the release');
  });
});
