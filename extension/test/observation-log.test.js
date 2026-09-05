// extension/test/observation-log.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createObservationLog } = require('../lib/observation-log');

describe('ObservationLog', () => {
  it('records observations with auto-incremented ids', () => {
    const log = createObservationLog();
    const e1 = log.record({ tool: 'probe.count', selectors: ['div.a'], summary: 'count=3' });
    const e2 = log.record({ tool: 'probe.count', selectors: ['div.b'], summary: 'count=0' });
    assert.equal(e1.id, 1);
    assert.equal(e2.id, 2);
    assert.equal(log.size(), 2);
  });

  it('covers exactly the recorded selector strings (no fuzzy matching)', () => {
    const log = createObservationLog();
    log.record({ tool: 'probe.count', selectors: ["div[role='feed'] div[role='article']"], summary: 'count=8' });
    assert.ok(log.covers("div[role='feed'] div[role='article']"));
    assert.ok(!log.covers("div[role='feed']"), 'ancestor/scope strings are NOT covered — derived selectors must go through auto-verify');
    assert.ok(!log.covers('div.nothing'));
  });

  it('twenty-sixth log: CSS-equivalent quote style matches (div[role="none"] ≡ div[role=\'none\'])', () => {
    const log = createObservationLog();
    log.record({ tool: 'probe.hover', selectors: ["div[role='none']"], summary: 'observed popover' });
    assert.ok(log.covers('div[role="none"]'), 'double-quoted variant of a single-quoted receipt is the SAME CSS selector');
    log.record({ tool: 'probe.count', selectors: ['[data-x="a"]'], summary: 'count=1' });
    assert.ok(log.covers("[data-x='a']"), 'and the reverse direction');
    assert.ok(!log.covers("div[role='menu']"), 'quote folding must not make different selectors match');
  });

  it('quote-normalized matching still honors the epoch filter', () => {
    const log = createObservationLog();
    log.record({ tool: 'probe.hover', selectors: ["div[role='none']"], summary: 'observed popover', epoch: 3 });
    assert.ok(log.covers('div[role="none"]', 3), 'normalized match within the same epoch');
    assert.ok(!log.covers('div[role="none"]', 4), 'stale epoch stays stale under normalization');
  });

  it('covers attribute names observed via attrStats', () => {
    const log = createObservationLog();
    log.record({
      tool: 'probe.attrStats',
      selectors: ['div.card'],
      attrs: [{ selector: 'div.card', attr: 'data-ad-rendering-role' }],
      summary: '8/100 cards carry the attr'
    });
    assert.ok(log.coversAttr('data-ad-rendering-role'));
    assert.ok(!log.coversAttr('data-other'));
  });

  it('serializes and restores losslessly', () => {
    const log = createObservationLog();
    log.record({ tool: 'probe.count', selectors: ['a.x'], summary: 'count=1' });
    const restored = createObservationLog(log.serialize());
    assert.ok(restored.covers('a.x'));
    assert.equal(restored.size(), 1);
    const e = restored.record({ tool: 'probe.count', selectors: ['a.y'] });
    assert.equal(e.id, 2, 'seq survives restore');
  });

  it('is immune to caller mutation of returned entries (receipt integrity)', () => {
    const log = createObservationLog();
    const e = log.record({ tool: 'probe.count', selectors: ['a.x'], summary: 'count=1' });
    e.selectors.push('guessed-selector');
    assert.ok(!log.covers('guessed-selector'), 'mutating a returned entry must not affect the log');
    const snap = log.serialize();
    snap.entries[0].selectors.push('also-guessed');
    assert.ok(!log.covers('also-guessed'), 'mutating serialize() output must not affect the log');
    assert.ok(log.serialize().entries[0].selectors.length === 1, 'internal state unchanged');
  });

  it('drops empty/non-string selectors and tolerates malformed input', () => {
    const log = createObservationLog();
    log.record({ tool: 'x', selectors: ['', null, 'ok.sel', 42], attrs: [null, { attr: 'data-v' }, { selector: 's' }] });
    const e = log.serialize().entries[0];
    assert.deepEqual(e.selectors, ['ok.sel']);
    assert.deepEqual(e.attrs, [{ selector: '', attr: 'data-v' }]);
  });

  it('C3: entries carry an epoch; covers/coversAttr honor the current epoch only', () => {
    const log = createObservationLog();
    log.record({ tool: 'probe.count', selectors: ['div.a'], attrs: [{ selector: 'div.a', attr: 'data-k' }], summary: 'count=3', epoch: 1 });
    assert.equal(log.covers('div.a'), true, 'legacy call (no epoch) filters nothing');
    assert.equal(log.covers('div.a', 1), true);
    assert.equal(log.covers('div.a', 2), false, 'page reloaded — the epoch-1 receipt is stale');
    assert.equal(log.coversAttr('data-k'), true);
    assert.equal(log.coversAttr('data-k', 2), false);
    log.record({ tool: 'probe.count', selectors: ['div.a'], summary: 'count=5', epoch: 2 });
    assert.equal(log.covers('div.a', 2), true, 're-probed in the new epoch');
    const ser = log.serialize();
    assert.equal(ser.entries[0].epoch, 1);
    assert.equal(ser.entries[1].epoch, 2);
    const revived = createObservationLog(ser);
    assert.equal(revived.covers('div.a', 2), true, 'epoch survives the serialize round-trip');
  });

  it('C3: epoch-less entries (legacy/unknown) never match an epoch-filtered query', () => {
    const log = createObservationLog();
    log.record({ tool: 'probe.count', selectors: ['div.b'], summary: 'count=1' });
    assert.equal(log.covers('div.b'), true);
    assert.equal(log.covers('div.b', 1), false);
    assert.equal(log.coversAttr('anything', 1), false);
  });
});
