// extension/test/findings-ledger.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFindingsLedger } = require('../lib/findings-ledger');

describe('FindingsLedger', () => {
  it('adds entries with provenance and selectors', () => {
    const led = createFindingsLedger();
    const e = led.add({
      finding: 'popover mounts as role=tooltip, ~1.2s dwell',
      evidence: 'probe.attrStats distribution + hover diag',
      confidence: 'high',
      provenance: 'probe',
      selectors: ["div[role='tooltip']"]
    });
    assert.ok(e.id);
    assert.ok(e.createdAt > 0);
    assert.equal(led.size(), 1);
  });

  it('dedupes identical findings, keeping the newest entry', () => {
    const led = createFindingsLedger();
    led.add({ finding: 'ads carry data-x', evidence: 'v1', confidence: 'low', provenance: 'probe' });
    led.add({ finding: 'ads carry data-x', evidence: 'v2 attrStats 8/100', confidence: 'high', provenance: 'probe' });
    assert.equal(led.size(), 1, 'same finding text merges into one entry');
    assert.equal(led.serialize().entries[0].evidence, 'v2 attrStats 8/100');
  });

  it('compact() never drops user-provenance entries', () => {
    const led = createFindingsLedger();
    for (let i = 0; i < 6; i++) led.add({ finding: 'probe fact #' + i, evidence: 'e', confidence: 'low', provenance: 'probe' });
    led.add({ finding: 'user ground truth', evidence: 'user picked these cards', confidence: 'high', provenance: 'user' });
    const compacted = led.compact({ maxEntries: 3 });
    const findings = compacted.entries.map(e => e.finding);
    assert.ok(findings.includes('user ground truth'));
    assert.ok(compacted.entries.length <= 3);
  });

  it('compact() prefers high confidence and recency', () => {
    const led = createFindingsLedger();
    led.add({ finding: 'low conf old', evidence: 'e', confidence: 'low', provenance: 'probe' });
    led.add({ finding: 'high conf', evidence: 'e', confidence: 'high', provenance: 'probe' });
    const compacted = led.compact({ maxEntries: 1 });
    assert.deepEqual(compacted.entries.map(e => e.finding), ['high conf']);
  });

  it('selectors field feeds grounding receipts; serialize/restore roundtrip', () => {
    const led = createFindingsLedger();
    led.add({ finding: 'organic card selector', evidence: 'probe.count=12', confidence: 'high', provenance: 'probe', selectors: ["div[role='feed'] article:not(:has([data-ad-rendering-role]))"] });
    const restored = createFindingsLedger(led.serialize());
    assert.deepEqual(restored.serialize().entries[0].selectors, ["div[role='feed'] article:not(:has([data-ad-rendering-role]))"]);
  });
});
