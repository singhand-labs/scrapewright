// extension/test/knowledge-base.test.js — Part 1: units data
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');

const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;

describe('knowledge units seed data', () => {
  it('ships at least 10 units with the full unit shape', () => {
    assert.ok(KNOWLEDGE_UNITS.length >= 10);
    for (const u of KNOWLEDGE_UNITS) {
      assert.ok(u.id && typeof u.id === 'string', 'id required: ' + JSON.stringify(u).slice(0, 80));
      assert.ok(u.title && typeof u.title === 'string');
      assert.ok(u.body && u.body.length > 40, 'body must carry a real lesson');
      assert.ok(Array.isArray(u.matchEvents) && u.matchEvents.length > 0, 'signature matchEvents required');
      assert.ok(u.origin && typeof u.origin === 'string');
    }
  });

  it('has unique ids', () => {
    const ids = KNOWLEDGE_UNITS.map(u => u.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('carries no site tokens (universality)', () => {
    for (const u of KNOWLEDGE_UNITS) {
      assert.ok(!FORBIDDEN.test(u.id + ' ' + u.title + ' ' + u.body + ' ' + u.matchEvents.join(' ')),
        'unit ' + u.id + ' contains a site token');
    }
  });

  it('includes the seventh-log polarity lesson with its event signature', () => {
    const u = KNOWLEDGE_UNITS.find(x => x.id === 'card-polarity');
    assert.ok(u, 'card-polarity unit must exist');
    assert.ok(u.matchEvents.includes('COUNT_SHORTFALL'));
    assert.ok(/:has\(/.test(u.body), 'must show the inverted include form');
  });
});
