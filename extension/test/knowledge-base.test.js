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

  it('includes the seventeenth-log poll-exhaustion differential keyed to the honest POLL_EXHAUSTED tag', () => {
    const u = KNOWLEDGE_UNITS.find(x => x.id === 'poll-exhaustion-differential');
    assert.ok(u, 'poll-exhaustion-differential unit must exist');
    assert.ok(u.matchEvents.includes('POLL_EXHAUSTED'));
    assert.ok(/iteration preview|previews/i.test(u.body), 'must teach reading the iteration previews');
    assert.ok(/thin/i.test(u.body), 'must name the thin-content branch');
  });

  it('includes the eighteenth-log ad-marker polarity unit keyed to AD_MARKER_SELECTOR', () => {
    const u = KNOWLEDGE_UNITS.find(x => x.id === 'ad-marker-polarity');
    assert.ok(u, 'ad-marker-polarity unit must exist');
    assert.ok(u.matchEvents.includes('AD_MARKER_SELECTOR'));
    assert.ok(/polarity/i.test(u.body), 'must teach the polarity check');
    assert.ok(/:not/i.test(u.body), 'must distinguish the include form from the exclude :not() form');
    assert.ok(/thin content/i.test(u.body), 'must name the thin-content alternative');
  });
});

// Part 2: knowledge base operations
const { buildIndex, queryUnits, matchUnits, proposeUnit } = require('../lib/knowledge-base');

describe('KnowledgeBase', () => {
  it('buildIndex emits one compact line per unit, under budget', () => {
    const idx = buildIndex(KNOWLEDGE_UNITS);
    assert.equal(idx.length, KNOWLEDGE_UNITS.length);
    for (const line of idx) {
      assert.ok(line.id && line.title);
      assert.ok(JSON.stringify(line).length < 200, 'index lines must stay compact');
    }
  });

  it('queryUnits returns full bodies by id', () => {
    const got = queryUnits(KNOWLEDGE_UNITS, ['card-polarity', 'no-such-id']);
    assert.equal(got.length, 1);
    assert.equal(got[0].id, 'card-polarity');
    assert.ok(got[0].body.length > 100);
  });

  it('matchUnits intersects event tags with unit signatures', () => {
    const got = matchUnits(KNOWLEDGE_UNITS, ['COUNT_SHORTFALL']);
    assert.ok(got.some(u => u.id === 'card-polarity'));
    const none = matchUnits(KNOWLEDGE_UNITS, ['UNRELATED_EVENT']);
    assert.equal(none.length, 0);
  });

  it('proposeUnit validates shape, universality, and id uniqueness', () => {
    const okR = proposeUnit(KNOWLEDGE_UNITS, {
      id: 'new-lesson', title: 'T', body: 'A real generalized lesson body long enough to matter.',
      matchEvents: ['EMPTY_FIELDS'], origin: 'session 2026-09-01'
    });
    assert.equal(okR.ok, true);
    const badShape = proposeUnit(KNOWLEDGE_UNITS, { id: 'x', title: 'T', body: 'short', matchEvents: [], origin: '' });
    assert.equal(badShape.ok, false);
    assert.ok(badShape.errors.length >= 2, 'missing matchEvents + short body + empty origin');
    const dupe = proposeUnit(KNOWLEDGE_UNITS, {
      id: 'card-polarity', title: 'T', body: 'A real generalized lesson body long enough to matter.',
      matchEvents: ['EMPTY_FIELDS'], origin: 'x'
    });
    assert.equal(dupe.ok, false);
    assert.ok(dupe.errors.some(e => /id/.test(e)));
    const siteToken = proposeUnit(KNOWLEDGE_UNITS, {
      id: 'site-lesson', title: 'T', body: 'On facebook feeds do X — a real length body here.',
      matchEvents: ['EMPTY_FIELDS'], origin: 'x'
    });
    assert.equal(siteToken.ok, false);
    assert.ok(siteToken.errors.some(e => /site token/i.test(e)));
  });

  it('proposeUnit never throws on malformed candidates (LLM-input boundary)', () => {
    const cases = [
      { id: 'x', title: 'T', body: 'A real generalized lesson body long enough to matter.', matchEvents: 'EMPTY_FIELDS', origin: 'x' },
      { id: 'y', title: 'T', body: 'A real generalized lesson body long enough to matter.', matchEvents: [42], origin: 'x' },
      null
    ];
    for (const c of cases) {
      let r;
      assert.doesNotThrow(() => { r = proposeUnit(KNOWLEDGE_UNITS, c); }, 'malformed candidate must not crash: ' + JSON.stringify(c));
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    }
  });

  it('every seed unit matchEvents value is inside the documented vocabulary', () => {
    const VOCAB = new Set(['COUNT_SHORTFALL', 'EMPTY_EXTRACTION', 'EMPTY_FIELDS', 'POPOVER_TIMEOUT',
      'HOVER_NO_SIGNAL', 'COUNTER_FROZEN', 'DUPLICATE_RECORDS', 'SELECTOR_ZERO_MATCH',
      'FIELD_COLLISION', 'SCRIPT_TIMEOUT', 'CARD_POLICY', 'POLL_EXHAUSTED', 'SCHEMA_BLIND',
      'AD_MARKER_SELECTOR', 'SELECTOR_OVERFILTERED', 'OUTPUT_FIELD_SIZE', 'PARTIAL_EMPTY_FIELDS',
      'RELATIVE_TIMESTAMP', 'HTML_FIELD_NO_MARKUP', 'CLICK_CONTAINERS_TRANSIENT',
      'SCROLL_COUNT_FROZEN', 'DUPLICATE_ID_VALUES']);
    for (const u of KNOWLEDGE_UNITS) {
      for (const ev of u.matchEvents) {
        assert.ok(VOCAB.has(ev), u.id + ' has out-of-vocabulary event: ' + ev);
      }
    }
  });
});
