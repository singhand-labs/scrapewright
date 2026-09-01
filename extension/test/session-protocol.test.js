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

  it('skips null/malformed members instead of throwing (boundary discipline)', () => {
    const p = Protocol.buildSystemPrompt({
      toolSpecs: [{ name: 'probe.count', args: '{sel}', returns: '{count}' }, null, { args: 'x' }],
      knowledgeIndex: [{ id: 'u1', title: 'T' }, null],
      attachedUnits: [null, { id: 'u1', title: 'T', body: 'B' }]
    });
    assert.ok(p.includes('probe.count'));
    assert.ok(p.includes('- u1: T'));
    assert.ok(p.includes('### u1 — T'));
    assert.doesNotThrow(() => Protocol.buildSystemPrompt({
      toolSpecs: [null], knowledgeIndex: [42], attachedUnits: ['x']
    }));
  });
});

describe('parseAssistantTurn', () => {
  it('parses a clean tool envelope and normalizes optionals', () => {
    const r = Protocol.parseAssistantTurn('{"think":"x","tool":"probe.count","args":{"sel":"div.card"}}');
    assert.ok(r.ok);
    assert.equal(r.turn.tool, 'probe.count');
    assert.deepEqual(r.turn.args, { sel: 'div.card' });
    assert.equal(r.turn.goalUpdates, null);
    assert.equal(r.turn.hypothesisUpdates, null);
    assert.equal(r.turn.finish, null);
  });

  it('defaults args to {} and tolerates missing think', () => {
    const r = Protocol.parseAssistantTurn('{"tool":"probe.text","args":{"sel":"h1"}}');
    assert.ok(r.ok);
    assert.deepEqual(r.turn.args, { sel: 'h1' });
    assert.equal(r.turn.think, '');
  });

  it('parses finish envelopes and normalizes missing summary', () => {
    const r = Protocol.parseAssistantTurn('{"finish":{}}');
    assert.ok(r.ok);
    assert.equal(r.turn.finish.summary, '');
    assert.equal(r.turn.tool, null);
  });

  it('extracts JSON from fenced code blocks and surrounding prose', () => {
    const fenced = 'Here is my plan:\n```json\n{"tool":"probe.count","args":{"sel":"a"}}\n```\nDone.';
    assert.ok(Protocol.parseAssistantTurn(fenced).ok);
    const prose = 'I will count first. {"tool":"probe.count","args":{"sel":"b"}} hope that works';
    assert.ok(Protocol.parseAssistantTurn(prose).ok);
  });

  it('survives trailing commas via the lenient parser fallback', () => {
    const sloppy = '{"think":"x","tool":"probe.count","args":{"sel":"div.card",},}';
    const r = Protocol.parseAssistantTurn(sloppy);
    assert.ok(r.ok, 'trailing-comma JSON must parse leniently: ' + JSON.stringify(r));
    assert.equal(r.turn.tool, 'probe.count');
  });

  it('rejects with precise violation codes', () => {
    assert.equal(Protocol.parseAssistantTurn('no json at all').violation, 'no-json');
    assert.equal(Protocol.parseAssistantTurn('[1,2,3]').violation, 'no-json');
    assert.equal(Protocol.parseAssistantTurn('{"think":"x"}').violation, 'missing-action');
    assert.equal(Protocol.parseAssistantTurn('{"tool":"a.b","finish":{}}').violation, 'ambiguous-action');
    assert.equal(Protocol.parseAssistantTurn('{"tool":"not a name!","args":{}}').violation, 'bad-tool-name');
    assert.equal(Protocol.parseAssistantTurn('{"tool":"probe.count","args":[1]}').ok, false);
  });

  it('normalizes goal/hypothesis updates leniently', () => {
    const r = Protocol.parseAssistantTurn(
      '{"goals":{"push":"find container"},"hypotheses":{"add":"feed is organic"},"tool":"probe.count","args":{}}');
    assert.deepEqual(r.turn.goalUpdates, { push: 'find container' });
    assert.deepEqual(r.turn.hypothesisUpdates, { add: 'feed is organic' });
    const r2 = Protocol.parseAssistantTurn(
      '{"goals":{"complete":"g1"},"hypotheses":{"resolve":{"n":2,"verdict":"refuted"}},"tool":"probe.count","args":{}}');
    assert.deepEqual(r2.turn.goalUpdates, { complete: 'g1' });
    assert.deepEqual(r2.turn.hypothesisUpdates, { resolve: { n: 2, verdict: 'refuted' } });
    const r3 = Protocol.parseAssistantTurn('{"goals":"nonsense","tool":"probe.count","args":{}}');
    assert.equal(r3.turn.goalUpdates, null);
  });
});

describe('summarizeToolResult', () => {
  it('renders name → capped json on one line', () => {
    const s = Protocol.summarizeToolResult('probe.count', { count: 8 }, 200);
    assert.ok(s.startsWith('probe.count → '));
    assert.ok(s.includes('"count":8'));
  });
  it('truncates long results with an explicit marker', () => {
    const big = { blob: 'x'.repeat(500) };
    const s = Protocol.summarizeToolResult('probe.sample', big, 50);
    assert.ok(s.length <= 50 + 40);
    assert.ok(s.includes('…[truncated]'));
  });
  it('never throws on non-serializable results', () => {
    const cyc = {}; cyc.self = cyc;
    assert.ok(typeof Protocol.summarizeToolResult('t', cyc, 50) === 'string');
  });
});
