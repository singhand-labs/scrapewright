// Skeleton-dossier (2026-09-18 spec): skeletonView, evidence dossier,
// engine injection/compaction exemption, DSL-guide history dedup, and the
// 128K window budget warning.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;
global.NodeFilter = dom.window.NodeFilter;
global.Node = dom.window.Node;
global.document = dom.window.document;

const DomCleaner = require('../lib/dom-cleaner.js');
const Dossier = require('../lib/evidence-dossier.js');
const { createResearchSession, makeInstructionStripper } = require('../lib/research-session.js');

// ---------------------------------------------------------------------------
describe('skeletonView (spec §3.A)', () => {
  const html = [
    '<div class="card feed-card x y z" id="c1" role="article" data-post-id="p9">',
    '<script>tracker()</script>',
    '<style>.a{color:red}</style>',
    '<svg><path d="M0 0"/></svg>',
    '<div><div><span>anon wrapper text</span></div></div>',
    '<a href="/item/9" title="permalink">Open</a>',
    '<span id="tt1" aria-label="August 2, 2026" style="display:none">Aug 2</span>',
    '<div style="display:none"><span>truly hidden noise</span></div>',
    '</div>'
  ].join('');

  it('emits numbered nodes with hierarchical numbers', () => {
    const s = DomCleaner.skeletonView(html);
    assert.match(s, /\[n1\]/, 'root numbered');
    assert.match(s, /<div/);
    assert.match(s, /\[n1\.\d+\]/, 'children numbered hierarchically');
  });

  it('strips script/style/svg/path and hidden subtrees without aria carriers', () => {
    const s = DomCleaner.skeletonView(html);
    assert.ok(!/tracker\(\)/.test(s), 'script gone');
    assert.ok(!/color:\s*red/.test(s), 'style gone');
    assert.ok(!/<svg/.test(s), 'svg gone');
    assert.ok(!/truly hidden noise/.test(s), 'carrier-less hidden subtree dropped');
  });

  it('KEEPS hidden aria-carrier spans (the labelledby chain)', () => {
    const s = DomCleaner.skeletonView(html);
    assert.match(s, /tt1/, 'id kept');
    assert.match(s, /aria-label="August 2, 2026"/, 'aria-label kept');
    assert.match(s, /Aug 2/, 'hidden-but-readable text kept');
  });

  it('collapses anonymous wrappers (no line of their own, children hoisted)', () => {
    const s = DomCleaner.skeletonView(html);
    // The anon <div><div><span> chain collapses: 'anon wrapper text' rides
    // directly under the container's numbering, no intermediate div lines.
    assert.ok(!/\[n1\.\d+\] <div>/.test(s), 'no bare anonymous div lines');
    assert.match(s, /anon wrapper text/);
  });

  it('keeps only the first 3 classes and filters noise classes; caps text at maxTextLen', () => {
    const long = 'w'.repeat(500);
    const s = DomCleaner.skeletonView('<div class="keep1 keep2 keep3 drop4 _ng-abc css-hash1"><p>' + long + '</p></div>');
    assert.match(s, /class="keep1 keep2 keep3"/, 'first 3 kept');
    assert.ok(!/_ng-abc|css-hash1|drop4/.test(s), 'noise + overflow classes dropped');
    const t = s.match(/"w{1,210}/);
    assert.ok(t, 'text present');
    assert.ok(t[0].length <= 205, 'text capped near 200');
  });

  it('honors model-directed opts (maxTextLen, keepAttrs, stripTags)', () => {
    const s = DomCleaner.skeletonView('<div id="x" data-k="v"><p>abcdefghij</p><iframe src="a"></iframe></div>', {
      maxTextLen: 4,
      keepAttrs: ['id'],
      stripTags: ['script', 'style', 'noscript', 'template', 'svg', 'path', 'link', 'meta', 'iframe']
    });
    assert.match(s, /"abcd…"/, 'maxTextLen obeyed');
    assert.ok(!/data-k/.test(s), 'keepAttrs narrowed');
    assert.ok(!/<iframe/.test(s), 'iframe stripped');
  });

  it('caps at 8K per container / 20K full page with disclosed trim', () => {
    let big = '<div class="row">';
    for (let i = 0; i < 900; i++) big += '<div class="r' + i + '" data-i="' + i + '"><span>cell ' + i + ' padding text here</span></div>';
    big += '</div>';
    const c = DomCleaner.skeletonView(big);
    assert.ok(c.length <= 8400, 'container cap ~8K, got ' + c.length);
    assert.match(c, /skeleton trimmed at 8000/);
    const p = DomCleaner.skeletonView(big, { capChars: 20000 });
    assert.ok(p.length <= 20400, 'page cap ~20K');
    assert.match(p, /skeleton trimmed at 20000/);
  });

  it('source carries no site tokens (universality)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../lib/dom-cleaner.js'), 'utf8');
    const skel = src.slice(src.indexOf('skeletonView'));
    assert.doesNotMatch(skel, /facebook|weibo|twitter|xiaohongshu|m\.me/i);
  });
});

// ---------------------------------------------------------------------------
describe('evidence dossier (spec §3.B)', () => {
  it('builds all 5 sections within the 30K cap', () => {
    const txt = Dossier.buildDossier({
      containerHtml: '<div id="c"><span>hi</span></div>',
      popovers: [{ anchor: 'a[role=link]', text: 'August 2, 2026' }],
      lastVerify: { ok: false, error: { message: 'REQUIRED_FIELD_EMPTY: posts[].postId' }, detectors: { partialEmptyFields: [{ field: 'postId', emptyRatio: 1 }] } },
      artifactVersions: [{ version: 1, steps: [{ id: 's1', script: 'return 1;' }] }]
    });
    for (const sec of ['CONTAINER SKELETON', 'POPOVER CAPTURES', 'LAST VERIFY CENSUS', 'ARTIFACT LINEAGE', 'BUDGET']) {
      assert.ok(txt.includes('[' + sec + ']'), sec + ' present');
    }
    assert.ok(txt.length <= Dossier.DOSSIER_CAP_CHARS + 400, '≤ ~30K chars, got ' + txt.length);
  });

  it('popover LRU evicts at 15 and the eviction is disclosed', () => {
    const lru = [];
    for (let i = 0; i < 20; i++) Dossier.pushPopoverCapture(lru, { anchor: 'a#' + i, text: 'capture ' + i });
    assert.equal(lru.length, 15);
    assert.equal(lru.evicted, 5);
    const txt = Dossier.buildDossier({ popovers: lru, evictedPopovers: lru.evicted });
    assert.match(txt, /capture 19/, 'newest kept');
    assert.ok(!/capture 0</.test(txt), 'oldest evicted');
    assert.match(txt, /5 popover capture\(s\) evicted/);
  });

  it('FULL current scripts + old versions as one-liners (user directive)', () => {
    const script = 'const cards = await $extractList(\'div.card\', {id: {selector: \'[data-id]\', attr: \'data-id\'}});\nreturn {posts: cards};';
    const txt = Dossier.buildDossier({
      artifactVersions: [
        { version: 1, steps: [{ id: 's1', script: 'return 1;' }] },
        { version: 2, steps: [{ id: 'extract', script: script }] }
      ]
    });
    assert.ok(txt.includes(script), 'current version script carried IN FULL');
    assert.match(txt, /v1 \(1 steps: s1\)/, 'old version one-liner');
  });

  it('65th-log replay shape: a captured date popover is quotable from the dossier', () => {
    const lru = [];
    Dossier.pushPopoverCapture(lru, { anchor: 'abbr[data-sigil]', text: 'Posted August 2, 2026 at 9:14 AM' });
    const txt = Dossier.buildDossier({ popovers: lru });
    assert.match(txt, /Posted August 2, 2026 at 9:14 AM/);
  });

  it('trims oldest evidence first under budget pressure and discloses it', () => {
    const lru = [];
    for (let i = 0; i < 15; i++) lru.push({ anchor: 'a#' + i, text: 'cap ' + i + ' ' + ('x'.repeat(180)) });
    const txt = Dossier.buildDossier({
      popovers: lru,
      artifactVersions: [{ version: 1, steps: [{ id: 's1', script: 'y'.repeat(16000) }] }]
    });
    assert.ok(txt.length <= Dossier.DOSSIER_CAP_CHARS + 400, 'cap honored under pressure, got ' + txt.length);
    assert.match(txt, /trimmed/, 'trim disclosed');
  });
});

// ---------------------------------------------------------------------------
// Engine harness helpers (mirrors research-session.test.js).
function scriptedLlm(replies, calls) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}
function reply(content) { return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } }; }
function envelope(tool, args) { return JSON.stringify({ think: 't', tool, args: args || {} }); }
function finishEnvelope(s) { return JSON.stringify({ think: 'done', finish: { summary: s || 'done' } }); }

describe('engine dossier injection (spec §3.B wiring)', () => {
  it('injects a rebuilt-every-turn dossier message; feeds changes show next turn', async () => {
    const source = { containerHtml: '<div id="old"><span>old</span></div>', popovers: [] };
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: 'div' })),
        reply(envelope('probe.count', { sel: 'div' })),
        reply(finishEnvelope())
      ], calls),
      tools: {
        'probe.count': async () => {
          // Mutate the feed source mid-run (after the 2nd call was seen):
          // turn 3's dossier must reflect the NEW container, proving the
          // dossier is rebuilt from live feeds every turn, never cached.
          if (calls.length >= 2) source.containerHtml = '<div id="new"><span>new</span></div>';
          return { count: 1 };
        }
      },
      dossierFeeds: {
        containerHtml: () => source.containerHtml,
        popovers: () => source.popovers,
        lastVerify: () => null
      }
    });
    await session.run();
    const sys = calls.map(c => c.messages.filter(m => m.role === 'system' && m.content.includes('EVIDENCE DOSSIER')));
    assert.equal(sys.length, 3, 'dossier present every turn');
    assert.match(sys[0][0].content, /id="old"/, 'skeleton from first feed state');
    source.containerHtml = '<div id="new"><span>new</span></div>';
    assert.match(sys[2][0].content, /id="new"/, 'dossier REBUILT from live feed, not cached');
  });

  it('compaction exemption: forced compaction leaves the dossier block intact', async () => {
    const source = { containerHtml: '<div id="keep"><span>v</span></div>' };
    const calls = [];
    const big = 'x'.repeat(4000);
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.text', { sel: 'div' })),
        reply(envelope('probe.text', { sel: 'div' })),
        reply(envelope('probe.text', { sel: 'div' })),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.text': async () => ({ total: 1, items: [big] }) },
      compaction: { thresholdChars: 500, keepTurns: 2 },
      dossierFeeds: {
        containerHtml: () => source.containerHtml,
        popovers: () => [],
        lastVerify: () => null
      }
    });
    const events = [];
    session.on && null;
    await session.run();
    const last = calls[calls.length - 1].messages;
    const d = last.filter(m => m.role === 'system' && m.content.includes('EVIDENCE DOSSIER'));
    assert.equal(d.length, 1, 'exactly one dossier block after compaction');
    assert.match(d[0].content, /id="keep"/, 'dossier content survived compaction untouched');
  });

  it('no dossier message when feeds are not wired (legacy harness shape preserved)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], calls),
      tools: {}
    });
    await session.run();
    assert.ok(!calls[0].messages.some(m => m.role === 'system' && m.content.includes('EVIDENCE DOSSIER')));
  });
});

// ---------------------------------------------------------------------------
describe('DSL-guide history dedup (128K window directive)', () => {
  const GUIDE = 'You are writing JavaScript code for Scrapewright, a web scraping agent. ' + 'guide body '.repeat(80);

  it('makeInstructionStripper replaces known blocks with a one-line marker', () => {
    const strip = makeInstructionStripper([{ label: 'TEST_GUIDE', text: GUIDE }]);
    const hist = 'context before\n' + GUIDE + '\ncontext after';
    const out = strip(hist);
    assert.ok(!out.includes('guide body'));
    assert.match(out, /stripped instruction block: TEST_GUIDE/);
    assert.match(out, /context before/);
    assert.match(out, /context after/);
  });

  it('assembled messages carry the DSL guide EXACTLY ONCE (system prompt, not history)', async () => {
    const calls = [];
    // Seed a transcript whose system entry carries the guide (the pre-dedup
    // world: repeated instruction blocks riding history).
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], calls),
      tools: {},
      systemPrompt: 'BASE. ' + GUIDE,
      stripBlocks: [{ label: 'SCRIPT_DSL_GUIDE', text: GUIDE }],
      seed: { session: {
        transcript: [{ kind: 'system', text: 'note ' + GUIDE }],
        goals: [], hypotheses: [], digest: '', attachedUnits: [], budgetAdvisories: [], waivedSelectors: [],
        spend: { turns: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0 }, artifactVersions: []
      } }
    });
    await session.run();
    const msgs = calls[0].messages;
    let count = 0;
    for (const m of msgs) {
      let idx = 0, n = 0;
      while ((idx = m.content.indexOf('guide body', idx)) !== -1) { n++; idx += 10; }
      count += n;
    }
    // The system prompt carries it; the history copy is a marker. One
    // occurrence set total (the phrase repeats inside the guide — assert
    // against the unique opener instead).
    let openers = 0;
    for (const m of msgs) {
      let idx = 0;
      while ((idx = m.content.indexOf('You are writing JavaScript code for Scrapewright', idx)) !== -1) { openers++; idx += 5; }
    }
    assert.equal(openers, 1, 'guide opener appears exactly once across assembled messages');
    assert.ok(count >= 1, 'guide text present in the system prompt');
    assert.ok(msgs.some(m => m.content.includes('stripped instruction block: SCRIPT_DSL_GUIDE')), 'history copy stripped to marker');
  });

  it('window budget: a >512K-char assembled prompt warns inside the dossier', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], calls),
      tools: {},
      systemPrompt: 'z'.repeat(530000),
      dossierFeeds: { containerHtml: () => null, popovers: () => [], lastVerify: () => null }
    });
    await session.run();
    const d = calls[0].messages.filter(m => m.role === 'system' && m.content.includes('EVIDENCE DOSSIER'));
    assert.equal(d.length, 1);
    assert.match(d[0].content, /WINDOW WARNING/);
  });
});
