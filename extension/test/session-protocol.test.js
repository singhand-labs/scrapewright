// extension/test/session-protocol.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Protocol = require('../lib/session-protocol');

describe('PROTOCOL_BLOCK', () => {
  it('teaches the envelope shape and the grounding meta-rule', () => {
    const b = Protocol.PROTOCOL_BLOCK;
    assert.ok(b.includes('"tool"'));
    assert.ok(b.includes('"finish"'));
    assert.ok(/never guess a selector/i.test(b), 'anti-blind-guess meta-rule must be present (spec §8 spirit)');
    assert.ok(/probe\.attrStats|attrStats/.test(b), 'must point at the cheapest probes');
  });

  it('carries no site tokens (universality)', () => {
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(Protocol.PROTOCOL_BLOCK));
  });
});

describe('renderToolCatalog', () => {
  it('renders one line per spec and a catalog for the internal tools', () => {
    const c = Protocol.renderToolCatalog([
      { name: 'probe.count', args: '{sel}', returns: '{count}' },
      { name: 'ledger.add', args: '{finding}', returns: '{added}' }
    ]);
    assert.ok(c.includes('- probe.count({sel}) → {count}'));
    assert.ok(c.includes('- ledger.add({finding}) → {added}'));
  });

  it('handles empty spec lists', () => {
    assert.ok(Protocol.renderToolCatalog([]).includes('(none'));
  });
});

describe('buildSystemPrompt', () => {
  it('assembles base + protocol + catalog + knowledge index + attached units', () => {
    const p = Protocol.buildSystemPrompt({
      base: 'DSL CONTRACT TEXT',
      toolSpecs: [{ name: 'probe.count', args: '{sel}', returns: '{count}' }],
      knowledgeIndex: [{ id: 'card-polarity', title: 'Ad-named attrs are exclude signals' }],
      attachedUnits: [{ id: 'card-polarity', title: 'Ad-named attrs are exclude signals', body: 'BODY-TEXT' }]
    });
    assert.ok(p.indexOf('DSL CONTRACT TEXT') < p.indexOf('## Turn protocol'));
    assert.ok(p.includes('probe.count'));
    assert.ok(p.includes('- card-polarity: Ad-named attrs are exclude signals'));
    assert.ok(p.includes('BODY-TEXT'));
    assert.ok(p.includes('knowledge.query'));
  });

  it('omits knowledge sections when absent and works with no config', () => {
    const p = Protocol.buildSystemPrompt({});
    assert.ok(p.includes('## Turn protocol'));
    assert.ok(!p.includes('## Knowledge index'));
    assert.ok(!p.includes('## Knowledge (auto-attached'));
    assert.ok(typeof Protocol.buildSystemPrompt() === 'string');
  });
});
