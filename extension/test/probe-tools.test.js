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

describe('probe.sample', () => {
  it('returns capped element data for any index via $list', async () => {
    const list = [
      { tagName: 'DIV', id: 'c0', className: 'x1 y2', textContent: 'T0', href: '', src: '' },
      { tagName: 'DIV', id: 'c1', className: 'x1', textContent: 'T1', href: '', src: '' }
    ];
    const { tools, observationLog } = makeTools(async (snippet) => {
      assert.ok(/return \$list\(/.test(snippet));
      return list;
    });
    const r = await tools.sample('div.card', { index: 1 });
    assert.equal(r.match, 1);
    assert.equal(r.element.id, 'c1');
    assert.ok(observationLog.covers('div.card'));
  });

  it('element fields are capped (className 120, text 300)', async () => {
    const list = [{ tagName: 'DIV', id: '', className: 'c'.repeat(500), textContent: 't'.repeat(1000) }];
    const { tools } = makeTools(async () => list);
    const r = await tools.sample('div.card');
    assert.ok(r.element.className.length <= 120);
    assert.ok(r.element.textContent.length <= 300);
  });

  it('attaches outerHTML only for index 0 via the $extract attr path, when asked', async () => {
    const { tools } = makeTools(async (snippet) => {
      if (/\$extract\(/.test(snippet)) return '<div class="cap">html</div>';
      return [{ tagName: 'DIV', id: 'c0', className: '', textContent: '' }];
    });
    const r0 = await tools.sample('div.card', { wantHtml: true });
    assert.equal(r0.html, '<div class="cap">html</div>');
    const r1 = await tools.sample('div.card', { index: 1, wantHtml: true });
    assert.equal(r1.html, undefined, 'nth-match HTML needs the live executor op (Plan 3)');
  });

  it('out-of-range index reports notFound without throwing', async () => {
    const { tools } = makeTools(async () => [{ tagName: 'DIV', id: 'only', className: '', textContent: '' }]);
    const r = await tools.sample('div.card', { index: 5 });
    assert.equal(r.notFound, true);
  });
});

describe('probe.attrStats', () => {
  it('tallies attribute distribution across containers via $extractList', async () => {
    const { tools, observationLog } = makeTools(async (snippet) => {
      assert.ok(/return \$extractList\(/.test(snippet), 'composes the EXISTING rail');
      assert.ok(snippet.includes('data-ad-rendering-role'), 'fieldMap targets the requested attr');
      return [
        { m: 'story_message' }, { m: undefined }, { m: null }, { m: '' },
        { m: 'profile_name' }, { m: '' }, { m: '' }, { m: '' }, { m: '' }, { m: '' }
      ];
    });
    const r = await tools.attrStats('div.card', 'data-ad-rendering-role');
    assert.equal(r.totalCards, 10);
    assert.equal(r.values.length, 2, 'absent bucket is reported as absentPct, not a value row');
    assert.equal(r.values[0].value, 'story_message');
    assert.equal(r.values[0].cards, 1);
    assert.ok(Math.abs(r.values[0].pct - 10) < 0.01);
    assert.equal(r.absentPct, 80);
    assert.ok(observationLog.coversAttr('data-ad-rendering-role'),
      'attrStats must record the attribute receipt for the grounding gate');
    assert.ok(observationLog.covers('div.card'));
  });

  it('sorts value rows by frequency and caps the histogram', async () => {
    const records = [];
    for (let i = 0; i < 30; i++) records.push({ m: i < 12 ? 'a' : (i < 20 ? 'b' : 'c') });
    const { tools } = makeTools(async () => records);
    const r = await tools.attrStats('div.card', 'data-k');
    assert.deepEqual(r.values.map(v => v.value), ['a', 'c', 'b'], 'frequency-descending: a=12, c=10, b=8');
    assert.equal(r.values.length, 3);

    const many = [];
    for (let i = 0; i < 20; i++) many.push({ m: 'v' + i });
    const capped = await makeTools(async () => many).tools.attrStats('div.card', 'data-k');
    assert.equal(capped.values.length, 12, 'histogram capped at 12 rows');
  });

  it('tolerates a records-wrapped executor result (wrapper variation)', async () => {
    const { tools } = makeTools(async () => ({ records: [{ m: 'x' }, { m: 'x' }, {}] }));
    const r = await tools.attrStats('div.card', 'data-k');
    assert.equal(r.totalCards, 3);
    assert.equal(r.values[0].value, 'x');
    assert.equal(r.values[0].cards, 2);
    assert.equal(r.absentPct, Math.round(1 / 3 * 1000) / 10);
  });

  it('tolerates executor error shape', async () => {
    const { tools } = makeTools(async () => { throw new Error('BOOM'); });
    const r = await tools.attrStats('div.card', 'data-k');
    assert.equal(r.error, 'BOOM');
  });
});
