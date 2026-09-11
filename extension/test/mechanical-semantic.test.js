// 机械-语义分离 + 观测平权（设计 2026-09-11，spec 见
// docs/superpowers/specs/2026-09-11-mechanical-semantic-separation-design.md）。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function readSrc(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function sliceFn(src, a, b) {
  const s = src.indexOf(a); assert.ok(s > -1, 'marker ' + a);
  const e = src.indexOf(b, s); assert.ok(e > s, 'end ' + b);
  return src.slice(s, e);
}

function makeHoverDom() {
  const dom = new JSDOM(
    '<div id="card"><a class="a" href="/x">anchor</a></div>',
    { url: 'https://example.com/p' });
  const el = dom.window.document.querySelector('.a');
  el.getBoundingClientRect = function () { return { left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30 }; };
  return { dom, el };
}

// vm 工厂：切出 extractWithHoverRecords（content-script inline 版），注入依赖。
const CS = readSrc('content-script.js');
// createInlineListExtractOps IIFE 结束于下一个同级函数 getListExtractOps。
const INLINE_SLICE = sliceFn(CS, 'function createInlineListExtractOps()', '\n  function getListExtractOps()');
const RESOLVE_SLICE = sliceFn(CS, 'function resolveLabelledbyText(', '\n  async function domLabelledby');

function loadInline(dom) {
  const ctx = {
    document: dom.window.document,
    resolveLabelledbyText: (el, attr) => ({ text: ((el && el.textContent) || '').trim(), attr, refCount: 0, missingIds: [] }),
    capElementHtmlRead: (v) => v
  };
  vm.createContext(ctx);
  vm.runInContext(RESOLVE_SLICE + '\n' + INLINE_SLICE + '\nthis.__ops = createInlineListExtractOps();', ctx);
  return ctx.__ops;
}

describe('T1: hovercards[].popoverText（原文通道）', () => {
  it('成功的 hovercard 条目携带剥标签后的 popoverText 原文', async () => {
    const { dom } = makeHoverDom();
    const ops = loadInline(dom);
    const out = await ops.extractWithHoverRecords(
      [dom.window.document.getElementById('card')],
      { t: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => ({
        hovered: true,
        htmlSnippet: '<div role="tooltip"><div>Shared with Public</div><div>Friday, September 11, 2026 at 1:43 AM</div></div>'
      }),
      {}
    );
    assert.ok(Array.isArray(out));
    assert.equal(out[0].hovercards.length, 1);
    assert.equal(out[0].hovercards[0].popoverText, 'Shared with Public Friday, September 11, 2026 at 1:43 AM');
  });
  it('失败条目 popoverText 为 null（与 htmlSnippet=null 对齐）', async () => {
    const { dom } = makeHoverDom();
    const ops = loadInline(dom);
    const out = await ops.extractWithHoverRecords(
      [dom.window.document.getElementById('card')],
      { t: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => ({ hovered: false, htmlSnippet: null, reason: 'no_hover_signal_early_exit' }),
      {}
    );
    assert.strictEqual(out[0].hovercards[0].popoverText, null);
  });
  it('源审计：lib/list-extract-ops.js 镜像同步携带 popoverText', () => {
    const lib = readSrc('lib/list-extract-ops.js');
    assert.ok(/popoverText:/.test(lib), 'lib 镜像必须有 popoverText（漂移防护）');
  });
});

describe('T2: heuristicValue 降级（便捷默认认账）', () => {
  it('domTimestamp: heuristicValue 是正则便捷默认，value 保留为别名，candidates 原文一等公民', async () => {
    const TS_SLICE = sliceFn(CS, 'var TS_MAX_HOVER_ANCHORS', '\n  async function domExists(');
    const HARVEST = sliceFn(CS, 'function harvestAnchorLabel(', '\n  async function domHover(');
    const dom = new JSDOM('<div id="card"><a class="ts" href="?x">3 days ago</a></div>', { url: 'https://e.com/p' });
    const card = dom.window.document.getElementById('card');
    const ctx = {
      document: dom.window.document,
      querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
      notifyBackgroundDiagnostic: () => {}, sendDebugLog: () => {},
      domHover: async () => ({ hovered: false, htmlSnippet: null })
    };
    vm.createContext(ctx);
    vm.runInContext(HARVEST + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
    const r = await ctx.__ts('#card', { anchorSel: '.ts' });
    assert.equal(r.result.heuristicValue, '3 days ago');
    assert.equal(r.result.value, '3 days ago', '旧名别名保留一个版本周期');
    assert.ok(Array.isArray(r.result.candidates) && r.result.candidates.some((c) => c.value === '3 days ago'));
  });
  it('probe.timestamp: heuristicValue 同步（含绝对场景）', async () => {
    const { createProbeTools } = require('../lib/probe-tools');
    const tools = createProbeTools({ executeDsl: async () => [{
      __t_label: '2 hours ago', __t_aria: '', __t_text: '2 hours ago',
      hovercards: [{ labelledbyText: 'September 11, 2026 at 5:30 PM', anchorText: 'Sep 11',
        htmlSnippet: '<div>Shared · September 11, 2026 at 5:30 PM</div>' }]
    }] });
    const r = await tools.timestamp({ containerSel: 'div.card', index: 0 });
    assert.equal(r.heuristicValue, 'September 11, 2026 at 5:30 PM');
    assert.equal(r.value, r.heuristicValue, '同值别名');
    assert.equal(r.absolute, 'September 11, 2026 at 5:30 PM');
  });
  it('源审计：两处文档/工具 spec 标注 heuristicValue 的便捷默认性质', () => {
    const pt = readSrc('lib/probe-tools.js');
    const i = pt.indexOf("'probe.timestamp'");
    assert.ok(/heuristicValue/.test(pt.slice(i, i + 1200)), 'probe 实现处必须提及 heuristicValue');
    const st = readSrc('lib/session-tools.js');
    const j = st.indexOf("{ name: 'probe.timestamp'");
    assert.ok(/heuristicValue/.test(st.slice(j, j + 1200)), 'probe spec 必须提及 heuristicValue');
  });
});

describe('T3: 来源代数 read: + match（谓词零知识）', () => {
  it('read:hoverPopover + match：post-hover 填充，谓词只应用不解释（命中→原文，未命中→空串）', async () => {
    const { dom } = makeHoverDom();
    const ops = loadInline(dom);
    const out = await ops.extractWithHoverRecords(
      [dom.window.document.getElementById('card')],
      { postTime: { selector: '.a', read: 'hoverPopover', match: '\\d{4} at .*?(AM|PM)' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div>Shared · Friday, September 11, 2026 at 1:43 AM</div>' }),
      {}
    );
    // 谓词零知识：match 命中即取整个原文值（基建不截取子串），未命中才是空串。
    assert.equal(out[0].postTime, 'Shared · Friday, September 11, 2026 at 1:43 AM');
    assert.ok(out[0].hovercards[0].popoverText.includes('September 11, 2026'));
  });
  it('read:hoverPopoverHtml 保留标记原文；无 match 原样返回', async () => {
    const { dom } = makeHoverDom();
    const ops = loadInline(dom);
    const out = await ops.extractWithHoverRecords(
      [dom.window.document.getElementById('card')],
      { raw: { selector: '.a', read: 'hoverPopoverHtml' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div>x<b>y</b></div>' }),
      {}
    );
    assert.equal(out[0].raw, '<div>x<b>y</b></div>');
  });
  it('match 不命中 → 字段空 + 捕获原文仍在 hovercards（证据回环）', async () => {
    const { dom } = makeHoverDom();
    const ops = loadInline(dom);
    const out = await ops.extractWithHoverRecords(
      [dom.window.document.getElementById('card')],
      { postTime: { selector: '.a', read: 'hoverPopover', match: '^[0-9]+$' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div>September 11, 2026</div>' }),
      {}
    );
    assert.strictEqual(out[0].postTime, '');
    assert.ok(out[0].hovercards[0].popoverText.includes('September 11'));
  });
  it('纯 $extractList 传 hoverPopover 来源 → 教学性报错', async () => {
    const { dom } = makeHoverDom();
    const ops = loadInline(dom);
    await assert.rejects(
      async () => ops.extractListRecords([dom.window.document.getElementById('card')], { x: { selector: '.a', read: 'hoverPopover' } }, {}),
      /hoverPopover.*\$extractWithHover|extractWithHover.*hoverPopover/
    );
  });
  it('match 对普通 read 也生效（text + match 过滤语义）；非法正则报错教重写', () => {
    const { dom } = makeHoverDom();
    const ops = loadInline(dom);
    const out = ops.extractListRecords(
      [dom.window.document.getElementById('card')],
      { v: { selector: '.a', match: 'anch' } }, {});
    assert.equal(out[0].v, 'anchor');
    assert.throws(
      () => ops.extractListRecords([dom.window.document.getElementById('card')], { v: { selector: '.a', match: '(' } }, {}),
      /match.*正则|invalid match|Invalid regular expression/i
    );
  });
  it('源审计：lib 镜像同步 read:/match', () => {
    const lib = readSrc('lib/list-extract-ops.js');
    assert.ok(/read === 'hoverPopover'/.test(lib) || /'hoverPopover'/.test(lib));
    assert.ok(/compileMatch/.test(lib));
    assert.ok(/isHoverPopoverSpec/.test(lib));
  });
});

const { createVerifyRunner } = require('../lib/verify-runner');
const { createSessionTools } = require('../lib/session-tools');

function verifyRunnerWith(diagEntry, orchestrateImpl) {
  const deps = {
    orchestrate: orchestrateImpl || (async () => ({
      finalResult: { posts: [{ postId: '1', postTime: 'x' }] },
      steps: [{ stepId: 's3', stepName: 'x', result: { done: true } }], pages: []
    })),
    ensureLock: async () => {}, getSignal: () => null, log: () => {}, onEvent: () => {},
    createTab: async (u) => ({ id: 11, url: u }), removeTab: async () => {},
    waitForTabLoad: async () => {}, sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '' }), evaluateCondition: async () => true
  };
  const runner = createVerifyRunner(deps);
  return { runner, deps };
}

describe('T4: 未消费捕获普查（观测平权）', () => {
  const CAPTURED_DIAG = {
    api: 'extractWithHover', containerSelector: 'div.card', processedContainers: 3,
    anchorSel: '.a',
    hoverSummary: { anchorsFound: 5, hovercardsCaptured: 4, hoverFailures: 1 },
    capturedPopovers: { popoverReadFields: 0, samples: ['Shared · Friday, September 11, 2026 at 1:43 AM'] },
    perField: []
  };
  function runWithDiag(diag) {
    const deps = {
      orchestrate: async (service, input, orchDeps, options) => {
        options.onEvent({ type: 'STEP_START', stepId: 's3', maxIterations: 1 });
        options.onEvent({ type: 'STEP_ITERATION', stepId: 's3', iteration: 1, selectorDiagnostics: Array.isArray(diag) ? diag : [diag] });
        options.onEvent({ type: 'STEP_DONE', stepId: 's3', iterations: 1, resultPreview: 'ok' });
        return { finalResult: { posts: [{ postId: '1' }] }, steps: [{ stepId: 's3', stepName: 'x', result: { done: true } }], pages: [] };
      },
      ensureLock: async () => {}, getSignal: () => null, log: () => {}, onEvent: () => {},
      createTab: async (u) => ({ id: 11, url: u }), removeTab: async () => {},
      waitForTabLoad: async () => {}, sendMessage: async () => ({ pong: true }),
      executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
      captureSnapshot: async () => ({ html: '' }), evaluateCondition: async () => true
    };
    return createVerifyRunner(deps)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's3', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: {}, outputSchema: null });
  }
  it('verify 报告携带 unusedCaptures 普查（捕获>0 且 0 字段消费）', async () => {
    const out = await runWithDiag(CAPTURED_DIAG);
    const uc = out.report.detectors.unusedCaptures;
    assert.ok(uc, 'census present');
    assert.equal(uc.totalCaptured, 4);
    assert.ok(uc.samples.some((s) => s.includes('September 11, 2026')));
    assert.match(uc.note, /hoverPopover/);
  });
  it('字段已声明（popoverReadFields>0 且捕获>0）→ declaredButEmpty 教学普查（不再静默）', async () => {
    const out = await runWithDiag(Object.assign({}, CAPTURED_DIAG, {
      capturedPopovers: { popoverReadFields: 1, samples: [] }
    }));
    const uc = out.report.detectors.unusedCaptures;
    assert.ok(uc, 'declared+captured → census present');
    assert.equal(uc.declaredButEmpty, true);
    assert.match(uc.note, /match/);
  });
  it('逐调用门：一次消费调用不再洗白同轮的非消费调用（去重后不双计）', async () => {
    const consuming = Object.assign({}, CAPTURED_DIAG, {
      containerSelector: 'div.cardA',
      capturedPopovers: { popoverReadFields: 1, samples: [] }
    });
    const nonConsuming = Object.assign({}, CAPTURED_DIAG, {
      containerSelector: 'div.cardB',
      capturedPopovers: { popoverReadFields: 0, samples: ['Shared · Friday'] }
    });
    const out = await runWithDiag([nonConsuming, consuming]);
    const uc = out.report.detectors.unusedCaptures;
    assert.ok(uc, 'per-call gate fires');
    assert.equal(uc.popoverReadFields, 0);
    assert.equal(uc.totalCaptured, 8, 'both calls counted');
  });
  it('同一调用跨事件重复 → 只计最后一次（无重复计数）', async () => {
    const out = await runWithDiag([CAPTURED_DIAG, CAPTURED_DIAG]);
    const uc = out.report.detectors.unusedCaptures;
    assert.ok(uc);
    assert.equal(uc.totalCaptured, 4, 'identical diag events deduped to the last one');
  });
  it('diag.read kind unusedCaptures 透出', async () => {
    const { createSessionTools } = require('../lib/session-tools');
    const deps = {
      rail: { pageOpen: async () => ({ tabId: 1, url: 'u', ready: true }), pageState: async () => ({}), executeDsl: async () => 1, ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1 },
      runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 1, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null, unusedCaptures: { totalCaptured: 4, popoverReadFields: 0, samples: ['September 11, 2026 at 1:43 AM'], note: 'bind via read:hoverPopover' } }, steps: [], finalResult: { posts: [{}] }, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
      getDraftService: () => ({ name: 's', steps: [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }] }),
      applyArtifact: () => {}, getTestInput: () => ({}), getOutputSchema: () => null, getSteps: () => [],
      annotationBridge: null, ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    };
    const t = createSessionTools(deps);
    await t.tools['verify.run']({});
    const r = await t.tools['diag.read']({ kind: 'unusedCaptures' });
    assert.ok(r.unusedCaptures);
    assert.ok(r.unusedCaptures.samples[0].includes('September 11'));
  });
  it('domExtractWithHover 源审计：capturedPopovers 骑诊断通道', () => {
    assert.ok(/capturedPopovers/.test(CS), 'content-script 诊断必须携带 capturedPopovers');
    assert.ok(/popoverReadFields/.test(CS));
  });
});

describe('T5: 守则与文档', () => {
  it('DSL 指南：$extractWithHover 文档化 read:/match；$timestamp 文档化 heuristicValue 性质', () => {
    const g = readSrc('lib/wizard-utils.js');
    const eIdx = g.indexOf('$extractWithHover(containerSel, fieldMap, opts)');
    assert.ok(eIdx > -1);
    assert.match(g.slice(eIdx, eIdx + 6000), /read:\s*'hoverPopover'/);
    assert.match(g.slice(eIdx, eIdx + 6000), /match/);
    const tIdx = g.indexOf('$timestamp(containerSel, {anchorSel?, timeoutMs?, index?})');
    assert.match(g.slice(tIdx, tIdx + 1800), /heuristicValue/);
  });
  it('守则（universality guard 扩展）：语义正则必须伴随原文候选——$timestamp 与 probe.timestamp 的候选数组是契约', () => {
    assert.ok(/candidates: candidates/.test(CS), 'domTimestamp 必须返回候选原文');
    const pt = readSrc('lib/probe-tools.js');
    assert.ok(/candidates: candidates/.test(pt));
  });
  it('CLAUDE.md 与白皮书同步 heuristicValue/read:', () => {
    assert.match(readSrc('../CLAUDE.md'), /heuristicValue/);
    assert.match(readSrc('../CLAUDE.md'), /hoverPopover/);
    assert.match(readSrc('../docs/technical-whitepaper.en.md'), /heuristicValue|hoverPopover/);
    assert.match(readSrc('../docs/technical-whitepaper.md'), /hoverPopover/);
  });
});
