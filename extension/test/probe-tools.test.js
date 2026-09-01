// extension/test/probe-tools.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');

function makeTools(executorImpl) {
  const observationLog = createObservationLog();
  const tools = createProbeTools({ executeDsl: executorImpl, observationLog });
  return { tools, observationLog };
}

describe('probe.count', () => {
  it('returns {count} and logs the observation receipt', async () => {
    const { tools, observationLog } = makeTools(async (snippet) => {
      assert.ok(/return \$count\(/.test(snippet), 'must run the $count DSL primitive');
      return 7;
    });
    const r = await tools.count("div[role='feed'] div[role='article']");
    assert.deepEqual(r, { count: 7 });
    assert.ok(observationLog.covers("div[role='feed'] div[role='article']"),
      'probe results must auto-record observation receipts');
  });

  it('propagates executor errors as structured failures', async () => {
    const { tools } = makeTools(async () => { throw new Error('SYNTAX_ERR: invalid selector'); });
    const r = await tools.count('div[');
    assert.equal(r.error, 'SYNTAX_ERR: invalid selector');
    assert.equal(r.count, undefined);
  });

  it('records exactly one receipt per probe, with the real count (no phantom entries)', async () => {
    const { tools, observationLog } = makeTools(async () => 0);
    const r = await tools.count('div.zero');
    assert.deepEqual(r, { count: 0 });
    assert.equal(observationLog.size(), 1, 'one probe = one receipt (count=0 is still an observation)');
    assert.equal(observationLog.serialize().entries[0].summary, 'count=0');
    assert.ok(observationLog.covers('div.zero'));
  });

  it('executor errors record no receipt', async () => {
    const { tools, observationLog } = makeTools(async () => { throw new Error('X'); });
    const r = await tools.count('div.bad');
    assert.equal(r.error, 'X');
    assert.equal(observationLog.size(), 0, 'a failed snippet is not an observation');
  });
});

describe('probe.text', () => {
  it('returns capped visible-text items from $list element data', async () => {
    const list = [];
    for (let i = 0; i < 30; i++) list.push({ tagName: 'DIV', textContent: 'card text ' + i + ' '.repeat(300) });
    const { tools } = makeTools(async (snippet) => {
      assert.ok(/return \$list\(/.test(snippet));
      return list;
    });
    const r = await tools.text('div.card');
    assert.equal(r.total, 30);
    assert.ok(r.items.length <= 20, 'item count capped at 20');
    assert.ok(r.items[0].length <= 220, 'each text capped ~200 chars');
    assert.ok(r.items[0].startsWith('card text 0'));
  });

  it('records a receipt only on success', async () => {
    const okTools = makeTools(async () => [{ tagName: 'DIV', textContent: 't' }]);
    const r = await okTools.tools.text('div.ok');
    assert.equal(r.total, 1);
    assert.ok(okTools.observationLog.covers('div.ok'));

    const errTools = makeTools(async () => { throw new Error('Y'); });
    const re = await errTools.tools.text('div.no');
    assert.equal(re.error, 'Y');
    assert.equal(errTools.observationLog.size(), 0);
  });
});
