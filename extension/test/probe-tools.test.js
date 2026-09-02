// extension/test/probe-tools.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');

function makeTools(executorImpl, extra) {
  const observationLog = createObservationLog();
  const tools = createProbeTools(Object.assign({ executeDsl: executorImpl, observationLog }, extra || {}));
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

  it('attaches outerHTML for ANY index via the $extractList self-read path, when asked', async () => {
    const list = [
      { tagName: 'DIV', id: 'c0', className: '', textContent: '' },
      { tagName: 'DIV', id: 'c1', className: '', textContent: '' }
    ];
    const { tools } = makeTools(async (snippet) => {
      if (/return \$extractList\(/.test(snippet)) {
        // Empty-selector fieldMap → one record per match, h = that match's own outerHTML.
        assert.ok(snippet.includes('"attr":"outerHTML"') || snippet.includes("'attr'"), 'fieldMap reads outerHTML');
        return [{ h: '<div id="c0">a</div>' }, { h: '<div id="c1">b</div>' }];
      }
      assert.ok(/return \$list\(/.test(snippet));
      return list;
    });
    const r0 = await tools.sample('div.card', { wantHtml: true });
    assert.equal(r0.html, '<div id="c0">a</div>');
    const r1 = await tools.sample('div.card', { index: 1, wantHtml: true });
    assert.equal(r1.html, '<div id="c1">b</div>', 'nth-match HTML is addressable');
  });

  it('caps the attached HTML at 30000 chars', async () => {
    const { tools } = makeTools(async (snippet) => {
      if (/return \$extractList\(/.test(snippet)) return [{ h: 'x'.repeat(50000) }];
      return [{ tagName: 'DIV', id: 'c0', className: '', textContent: '' }];
    });
    const r = await tools.sample('div.card', { wantHtml: true });
    assert.equal(r.html.length, 30000);
  });

  it('clean:true routes the outerHTML through the cleaner before capping (page-cleaning gap)', async () => {
    const seen = [];
    const { tools } = makeTools(async (snippet) => {
      if (/return \$extractList\(/.test(snippet)) return [{ h: '<div><script>noise()</script><span>real</span></div>' }];
      return [{ tagName: 'DIV', id: 'c0', className: '', textContent: '' }];
    }, {
      cleanHtml: (h) => { seen.push(h); return '<div><span>real</span></div>'; }
    });
    const r = await tools.sample('div.card', { wantHtml: true, clean: true });
    assert.equal(seen.length, 1, 'cleaner invoked exactly once');
    assert.equal(seen[0], '<div><script>noise()</script><span>real</span></div>');
    assert.equal(r.html, '<div><span>real</span></div>');
  });

  it('clean:true without a wired cleaner still returns the raw HTML (graceful degradation)', async () => {
    const { tools } = makeTools(async (snippet) => {
      if (/return \$extractList\(/.test(snippet)) return [{ h: '<div>raw</div>' }];
      return [{ tagName: 'DIV', id: 'c0', className: '', textContent: '' }];
    });
    const r = await tools.sample('div.card', { wantHtml: true, clean: true });
    assert.equal(r.html, '<div>raw</div>');
  });

  it('clean:true against the REAL dom-cleaner consumes its {html} object shape (jsdom)', async () => {
    const jsdom = require('jsdom');
    const DC = require('../lib/dom-cleaner');
    const dom = new jsdom.JSDOM('', { url: 'https://example.com/page' });
    const saved = {};
    for (const g of ['DOMParser', 'NodeFilter', 'Node', 'CSS', 'document']) {
      saved[g] = global[g];
      global[g] = dom.window[g] || dom.window;
    }
    try {
      const { tools } = makeTools(async (snippet) => {
        if (/return \$extractList\(/.test(snippet)) return [{ h: '<div><script>noise()</script><span>real</span></div>' }];
        return [{ tagName: 'DIV', id: 'c0', className: '', textContent: '' }];
      }, { cleanHtml: DC.cleanHtmlForLLM });
      const r = await tools.sample('div.card', { wantHtml: true, clean: true });
      assert.ok(String(r.html).indexOf('noise()') === -1, 'script stripped');
      assert.ok(String(r.html).indexOf('real') !== -1, 'content kept');
    } finally {
      for (const g of Object.keys(saved)) {
        if (saved[g] === undefined) delete global[g]; else global[g] = saved[g];
      }
    }
  });

  it('out-of-range index reports notFound without throwing', async () => {
    const { tools } = makeTools(async () => [{ tagName: 'DIV', id: 'only', className: '', textContent: '' }]);
    const r = await tools.sample('div.card', { index: 5 });
    assert.equal(r.notFound, true);
  });

  it('surfaces a failed optional HTML leg as htmlError, keeping element data', async () => {
    const { tools } = makeTools(async (snippet) => {
      if (/return \$extractList\(/.test(snippet)) throw new Error('EXTRACT_FAILED');
      return [{ tagName: 'DIV', id: 'c0', className: '', textContent: '' }];
    });
    const r = await tools.sample('div.card', { wantHtml: true });
    assert.equal(r.htmlError, 'EXTRACT_FAILED');
    assert.equal(r.html, undefined);
    assert.equal(r.element.id, 'c0', 'element data survives the failed HTML leg');
  });

  it('htmlError (not silence) when the addressed match yields no outerHTML', async () => {
    const { tools } = makeTools(async (snippet) => {
      if (/return \$extractList\(/.test(snippet)) return [{ h: '<div>a</div>' }, { h: '' }];
      return [
        { tagName: 'DIV', id: 'c0', className: '', textContent: '' },
        { tagName: 'DIV', id: 'c1', className: '', textContent: '' }
      ];
    });
    const r = await tools.sample('div.card', { index: 1, wantHtml: true });
    assert.equal(r.html, undefined);
    assert.ok(/no outerHTML for match 1/.test(r.htmlError), 'explicit htmlError names the match');
    assert.equal(r.element.id, 'c1', 'element data still present');
  });
});

describe('probe.attrStats', () => {
  it('tallies attribute distribution across containers via $extractList', async () => {
    const { tools, observationLog } = makeTools(async (snippet) => {
      assert.ok(/return \$extractList\(/.test(snippet), 'composes the EXISTING rail');
      assert.ok(snippet.includes('"m":{"attr":"data-ad-rendering-role"}'),
        'empty-selector fieldMap = the container ITSELF carries the attr (first-live-log P-D self-read, not descendants)');
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

describe('probe.extract (sixth-log turn-sink: verify loop t26-t40)', () => {
  const FIELDS = { title: { selector: 'h2' }, href: { selector: 'a', attr: 'href' } };

  function records(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ title: i === 1 ? '' : 't' + i, href: i === 2 ? '' : '/p/' + i });
    return out;
  }

  it('dry-runs $extractList in the live tab: sampled records, empty-field census, receipts for container AND field selectors', async () => {
    const snippets = [];
    const { tools, observationLog } = makeTools(async (s) => { snippets.push(s); return records(5); });
    const r = await tools.extract({ containerSel: 'div.card', fieldMap: FIELDS });
    assert.ok(snippets[0].includes('return $extractList("div.card", {"title":{"selector":"h2"},"href":{"selector":"a","attr":"href"}});'),
      'fieldMap composed verbatim: ' + snippets[0]);
    assert.equal(r.total, 5);
    assert.equal(r.records.length, 3, 'context diet: 3 sampled records, total carries the real count');
    assert.deepEqual(r.emptyFields, { title: 1, href: 1 }, 'census names only fields that HAVE empties');
    assert.ok(observationLog.covers('div.card'), 'container receipt');
    assert.ok(observationLog.covers('h2'), 'field selector receipt — a later step fieldMap is grounded by this probe');
    assert.ok(observationLog.covers('a'));
  });

  it('multi:true runs $extractListMulti and allowEmpty forwards as opts', async () => {
    const snippets = [];
    const { tools } = makeTools(async (s) => { snippets.push(s); return [{ tags: ['a', 'b'] }]; });
    const r = await tools.extract({ containerSel: 'div.card', fieldMap: { tags: { selector: 'a' } }, multi: true, allowEmpty: true });
    assert.ok(snippets[0].includes('return $extractListMulti("div.card",'), 'multi flag selects the array-valued primitive');
    assert.ok(snippets[0].includes(', {"allowEmpty":true});'), 'allowEmpty forwarded: ' + snippets[0]);
    assert.deepEqual(r.records, [{ tags: ['a', 'b'] }]);
    assert.deepEqual(r.emptyFields, {});
  });

  it('caps long string field values so one outerHTML field cannot flood the transcript', async () => {
    const { tools } = makeTools(async () => [{ html: 'x'.repeat(5000) }]);
    const r = await tools.extract({ containerSel: 'div.card', fieldMap: { html: { attr: 'outerHTML' } } });
    assert.ok(r.records[0].html.length <= 500 + 20, 'long values capped ~500 with a truncation marker');
    assert.ok(/…|\[trunc/.test(r.records[0].html), 'cap is disclosed, not silent');
  });

  it('validates args and forwards executor errors without a receipt', async () => {
    const { tools, observationLog } = makeTools(async () => { throw new Error('SYNTAX_ERR: bad selector'); });
    assert.equal((await tools.extract({ fieldMap: FIELDS })).error, 'containerSel required');
    assert.equal((await tools.extract({ containerSel: 'div.card' })).error, 'fieldMap required — {field:{selector,attr?}} (a field without "selector" reads the container itself)');
    const r = await tools.extract({ containerSel: 'div[', fieldMap: FIELDS });
    assert.equal(r.error, 'SYNTAX_ERR: bad selector');
    assert.equal(observationLog.size(), 0, 'a failed extract is not an observation');
  });
});

describe('probe.scroll', () => {
  it('runs $scrollToBottom / $scrollBy over the rail and returns {scrolled,prevY,newY}', async () => {
    const snippets = [];
    const { tools } = makeTools(async (snippet) => {
      snippets.push(snippet);
      return { scrolled: true, prevY: 0, newY: 1200 };
    });
    const r = await tools.scroll({});
    assert.deepEqual(r, { scrolled: true, prevY: 0, newY: 1200 });
    assert.ok(snippets[0].includes('return $scrollToBottom();'), 'default is a window scroll-to-bottom: ' + snippets[0]);
    await tools.scroll({ mode: 'by', by: 600, sel: "div[role='feed']" });
    assert.ok(snippets[1].includes("return $scrollBy(600, \"div[role='feed']\")"), 'by-mode scrolls N px inside the container: ' + snippets[1]);
    await tools.scroll({ sel: "div[role='feed']" });
    assert.ok(snippets[2].includes("return $scrollToBottom(\"div[role='feed']\")"), 'container selector composes: ' + snippets[2]);
  });

  it('records the container selector as an observation receipt (grounds later $scrollToBottom(sel) step claims)', async () => {
    const { tools, observationLog } = makeTools(async () => ({ scrolled: true, prevY: 0, newY: 10 }));
    await tools.scroll({ sel: "div[role='feed']" });
    assert.ok(observationLog.covers("div[role='feed']"),
      'the scroll container selector must be grounded — step scripts claim it via $scrollToBottom(sel)');
  });

  it('validates mode/by args and forwards executor errors', async () => {
    const { tools, observationLog } = makeTools(async () => { throw new Error('SYNTAX_ERR'); });
    assert.equal((await tools.scroll({ mode: 'by' })).error, 'by (positive pixel count) required for mode:"by"');
    assert.equal((await tools.scroll({})).error, 'SYNTAX_ERR');
    assert.equal(observationLog.size(), 0, 'a failed scroll is not an observation');
  });
});

describe('probe.scroll receipt entry', () => {
  it('window scroll records an empty-selector receipt (trajectory, no claim)', async () => {
    const { tools, observationLog } = makeTools(async () => ({ scrolled: false, prevY: 5, newY: 5 }));
    const r = await tools.scroll({});
    assert.deepEqual(r, { scrolled: false, prevY: 5, newY: 5 });
    assert.equal(observationLog.size(), 1);
    assert.deepEqual(observationLog.serialize().entries[0].selectors, []);
  });
});

describe('probe.hover canonical popover receipt (sixth-live-log turns 17-24 deadlock)', () => {
  it('derives the canonical selector from the htmlSnippet opening tag, returns it, and records the receipt', async () => {
    const { tools, observationLog } = makeTools(async () => ({
      hovered: true,
      autoDiscovered: true,
      hoverDispatched: true,
      popoverSelector: '[auto-discovered popover]',
      htmlSnippet: '<div aria-label="Link preview" aria-modal="true" dir="ltr"><h2>x</h2></div>'
    }));
    const r = await tools.hover({ anchorSel: "div[role='feed'] h2 a" });
    assert.equal(r.popoverSelector, "div[aria-label='Link preview']",
      'canonical popoverSelector replaces the useless placeholder');
    assert.ok(/VERBATIM/.test(r.popoverSelectorNote || ''), 'note teaches verbatim reuse');
    assert.ok(observationLog.covers("div[aria-label='Link preview']"),
      'the canonical string is recorded as an observation receipt — popoverSel rewritten to it passes the gate');
    assert.ok(observationLog.covers("div[role='feed'] h2 a"), 'anchor receipt unchanged');
  });

  it('derives from observedPopover identity when htmlSnippet is absent (failed-capture mismatch path)', async () => {
    const { tools, observationLog } = makeTools(async () => ({
      hovered: false,
      reason: 'popover_timeout',
      observedPopover: { tag: 'DIV', role: 'dialog', ariaLabel: 'Link preview', id: '' }
    }));
    const r = await tools.hover({ anchorSel: 'a.author' });
    assert.equal(r.popoverSelector, "div[aria-label='Link preview'][role='dialog']");
    assert.ok(observationLog.covers("div[aria-label='Link preview'][role='dialog']"));
  });

  it('keeps the placeholder when nothing distinguishing is derivable (no weak receipts)', async () => {
    const { tools, observationLog } = makeTools(async () => ({
      hovered: true,
      autoDiscovered: true,
      popoverSelector: '[auto-discovered popover]',
      htmlSnippet: '<div class="x9f619"><span>y</span></div>'
    }));
    const r = await tools.hover({ anchorSel: 'a.q' });
    assert.equal(r.popoverSelector, '[auto-discovered popover]');
    assert.equal(r.popoverSelectorNote, undefined, 'no canonical → no verbatim note');
    assert.equal(observationLog.covers('div'), false, 'a bare tag is never a receipt');
    assert.ok(observationLog.covers('a.q'), 'anchor receipt still recorded');
  });

  it('a long aria-label is skipped rather than emitting a truncated (unmatchable) selector', async () => {
    const longLabel = 'L'.repeat(70);
    const { tools } = makeTools(async () => ({
      hovered: true,
      autoDiscovered: true,
      popoverSelector: '[auto-discovered popover]',
      htmlSnippet: '<section role="dialog" aria-label="' + longLabel + '">z</section>'
    }));
    const r = await tools.hover({ anchorSel: 'a.r' });
    assert.equal(r.popoverSelector, "section[role='dialog']", 'role token survives; over-long aria-label dropped');
  });
});

describe('probe.hover', () => {
  it('composes $hover over the rail, records the receipt, and diets the result', async () => {
    const { tools, observationLog } = makeTools(async (snippet) => {
      assert.ok(/^return \$hover\("a\.author", "div\[role=dialog\]", \{"index":0\}\);?$/.test(snippet),
        'anchorSel+popoverSel+opts composed in order: ' + snippet);
      return { hovered: true, htmlSnippet: 'x'.repeat(9000), popoverSelector: 'div[role=dialog]', autoDiscovered: false, hoverDispatched: true, hoverReason: null };
    });
    const r = await tools.hover({ anchorSel: 'a.author', popoverSel: 'div[role=dialog]', opts: { index: 0 } });
    assert.equal(r.hovered, true);
    assert.equal(r.htmlSnippet.length, 8000, 'popover HTML capped at the record-HTML 8000 precedent');
    assert.equal(r.popoverSelector, 'div[role=dialog]');
    assert.ok(observationLog.covers('a.author'), 'anchor selector grounded by the receipt');
    assert.ok(observationLog.covers('div[role=dialog]'), 'popover selector grounded too');
  });

  it('opts without popoverSel keeps opts in 3rd position via an explicit null', async () => {
    const { tools } = makeTools(async (snippet) => {
      assert.ok(snippet.includes('"a.x", null, {"timeoutMs":4500}'), 'null placeholder: ' + snippet);
      return { hovered: false, reason: 'no_hover_signal_early_exit', observedPopover: { role: 'dialog' } };
    });
    const r = await tools.hover({ anchorSel: 'a.x', opts: { timeoutMs: 4500 } });
    assert.equal(r.hovered, false);
    assert.equal(r.reason, 'no_hover_signal_early_exit');
    assert.deepEqual(r.observedPopover, { role: 'dialog' });
    assert.equal(r.htmlSnippet, null);
  });

  it('rejects a missing anchorSel and forwards executor errors', async () => {
    const { tools } = makeTools(async () => { throw new Error('ELEMENT_NOT_FOUND: a.z'); });
    assert.equal((await tools.hover({})).error, 'anchorSel required');
    const r = await tools.hover({ anchorSel: 'a.z' });
    assert.equal(r.error, 'ELEMENT_NOT_FOUND: a.z');
  });
});
