// extension/test/session-persistence.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionPersistence } = require('../lib/session-persistence');

function fakeStorage() {
  const store = {};
  let setCalls = 0;
  return {
    get: (keys, cb) => cb(Object.fromEntries(keys.map(k => [k, store[k]]))),
    set: (obj, cb) => { setCalls += 1; Object.assign(store, obj); cb(); },
    remove: (k, cb) => { delete store[k]; cb(); },
    _store: store,
    _setCalls: () => setCalls
  };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('createSessionPersistence', () => {
  it('requires a storage {get,set} object', () => {
    assert.throws(() => createSessionPersistence(null, 'k'), /storage \{get,set\}/);
    assert.throws(() => createSessionPersistence({ get: () => {} }, 'k'), /storage \{get,set\}/);
  });

  it('save resolves immediately (never delays the turn loop) and coalesces bursts into one set', async () => {
    const s = fakeStorage();
    const p = createSessionPersistence(s, 'sess', { debounceMs: 20 });
    let t0 = Date.now();
    await p.save({ a: 1 });
    assert.ok(Date.now() - t0 < 15, 'save() must not await the debounce window');
    await p.save({ a: 2 });
    await p.save({ a: 3 });
    await sleep(60);
    assert.equal(s._setCalls(), 1, 'burst of 3 saves → exactly 1 storage.set');
    assert.deepEqual(s._store.sess, { a: 3 }, 'last write wins');
  });

  it('debounceMs<=0 writes through synchronously', async () => {
    const s = fakeStorage();
    const p = createSessionPersistence(s, 'sess', { debounceMs: 0 });
    await p.save({ a: 1 });
    await p.save({ a: 2 });
    assert.equal(s._setCalls(), 2);
    assert.deepEqual(s._store.sess, { a: 2 });
  });

  it('load round-trips persisted state; null when absent', async () => {
    const s = fakeStorage();
    const p = createSessionPersistence(s, 'sess', { debounceMs: 0 });
    assert.equal(await p.load(), null);
    await p.save({ engine: 1, session: { id: 'rs-1' } });
    const v = await p.load();
    assert.equal(v.engine, 1);
    assert.equal(v.session.id, 'rs-1');
  });

  it('flush forces a pending debounced write; clear drops state and cancels the pending timer', async () => {
    const s = fakeStorage();
    const p = createSessionPersistence(s, 'sess', { debounceMs: 50 });
    await p.save({ a: 1 });
    await p.flush();
    assert.equal(s._setCalls(), 1);
    await p.save({ a: 2 });
    await p.clear();
    await sleep(80);
    assert.equal(s._setCalls(), 1, 'cleared pending write never lands');
    assert.equal(await p.load(), null);
  });

  it('serializes cyclic state defensively (a throw would emit persist_error every turn)', async () => {
    const s = fakeStorage();
    const p = createSessionPersistence(s, 'sess', { debounceMs: 0 });
    const cyc = { a: 1 }; cyc.self = cyc;
    await assert.doesNotReject(() => p.save(cyc));
    const v = await p.load();
    assert.equal(v, null, 'unserializable state is dropped, not stored as "undefined"');
  });
});
