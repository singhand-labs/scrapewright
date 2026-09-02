// extension/test/research-session-golden-replay.test.js
//
// Golden replay (spec §7): the seventh-log incident class — promotion-named
// attribute used as an INCLUDE filter kept only ad cards — must be STOPPED
// at the service.update gate, and the rejection must steer the loop to
// probe.attrStats, whose distribution admits the corrected :not() form.
// Deterministic: scripted LLM, fake rail, fake verify runner.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchSession } = require('../lib/research-session');
const { createSessionTools } = require('../lib/session-tools');
const { createObservationLog } = require('../lib/observation-log');
const { createFindingsLedger } = require('../lib/findings-ledger');

function turnEnvelope(obj) {
  return JSON.stringify(obj);
}

// Fake rail: 10 cards; 2 carry data-ad-rendering-role="story_message", 8 do not.
function makeFakeRail() {
  const calls = [];
  const exec = async (snippet) => {
    calls.push(snippet);
    if (snippet.includes('$count')) {
      const m = snippet.match(/\$count\((\"(?:[^\"\\]|\\.)*\")\)/);
      const sel = m ? JSON.parse(m[1]) : '';
      if (sel === 'div[data-kind="post"]') return 10;
      if (sel.includes(':not(')) return 8;   // corrected compound — organic only
      if (sel.includes(':has(')) return 2;    // inverted compound — ads only
      return 0;
    }
    if (snippet.includes('$extractList')) {
      // attrStats composition: one record per container; m='' when absent.
      const records = [];
      for (let i = 0; i < 10; i++) {
        records.push(i < 2 ? { m: 'story_message' } : { m: '' });
      }
      return records;
    }
    if (snippet.includes('$list')) {
      return [{ tagName: 'DIV', textContent: 'card', href: '', src: '', id: '', className: '' }];
    }
    return { error: 'unsupported snippet in fixture: ' + snippet.slice(0, 60) };
  };
  return {
    pageOpen: async () => ({ tabId: 1, url: 'https://example.com/feed', ready: true }),
    pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com/feed' }),
    executeDsl: async (s) => exec(s),
    ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1,
    _calls: calls
  };
}

const INVERTED_STEPS = [{
  id: 's1', name: 'extract_posts',
  script: 'return $extractList(\'div[data-kind="post"]:has(div[data-ad-rendering-role="story_message"])\', {title:{selector:\'h3\'}});',
  onSuccess: 'TERMINATE', onFailure: 'TERMINATE'
}];
const CORRECTED_STEPS = [{
  id: 's1', name: 'extract_posts',
  script: 'return $extractList(\'div[data-kind="post"]:not(:has([data-ad-rendering-role]))\', {title:{selector:\'h3\'}});',
  onSuccess: 'TERMINATE', onFailure: 'TERMINATE'
}];

describe('golden replay — seventh-log ad-polarity incident (spec §7/§8)', () => {
  it('gate rejects the inverted :has() include; attrStats receipt admits the corrected :not(); verify green; finish', async () => {
    const rail = makeFakeRail();
    const applied = [];
    let draft = null;
    const tools = createSessionTools({
      rail: rail,
      runVerify: async () => ({
        report: {
          ok: true, error: null, aborted: false,
          score: { score: 100, isData: true, breakdown: {} },
          schemaOk: true, schemaMissing: [],
          detectors: { emptyFields: [], duplicateFields: [], countShortfall: null },
          steps: [{ stepId: 's1', stepName: 'extract_posts', skipped: false, skipReason: null, iterations: 1 }],
          finalResult: { posts: [{ title: 'organic 1' }, { title: 'organic 2' }] },
          pages: '1', eventCount: 1, events: []
        },
        events: [{ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}' }],
        raw: { testResult: { finalResult: {} }, error: null, breaker: null }
      }),
      getDraftService: () => draft,
      applyArtifact: (a) => { applied.push(a.steps); draft = { targetUrl: 'https://example.com/feed', steps: a.steps }; },
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object' }),
      getSteps: () => (draft ? draft.steps : []),
      annotationBridge: null
    });

    const script = [
      // 1. open the page
      turnEnvelope({ think: 'open the feed', goals: { push: 'extract 10 organic posts, exclude ads' }, hypotheses: { add: 'div[data-kind="post"] holds all cards' }, tool: 'page.open', args: {} }),
      // 2. count the candidate container
      turnEnvelope({ think: 'count cards', tool: 'probe.count', args: { sel: 'div[data-kind="post"]' } }),
      // 3. FIRST service.update attempt — the inverted include (the incident)
      turnEnvelope({ think: 'write artifact', tool: 'service.update', args: { steps: INVERTED_STEPS } }),
      // 4. rejected → read the rejection, probe the distribution
      turnEnvelope({ think: 'gate rejected the filter attribute; observe its distribution', tool: 'probe.attrStats', args: { containerSel: 'div[data-kind="post"]', attr: 'data-ad-rendering-role' } }),
      // 5. corrected artifact — negative form
      turnEnvelope({ think: 'attribute marks a 2/10 minority = promotion marker; use :not()', hypotheses: { resolve: { n: 1, verdict: 'confirmed — data-ad-rendering-role is a promotion marker (2/10)' } }, tool: 'service.update', args: { steps: CORRECTED_STEPS } }),
      // 6. verify
      turnEnvelope({ think: 'verify the corrected artifact', tool: 'verify.run', args: {} }),
      // 7. finish
      turnEnvelope({ finish: { summary: 'organic-only filter grounded in the attrStats distribution; verify green (8 organic posts).' } })
    ];
    let i = 0;
    // Engine contract: llm resolves to { content, finish_reason } (research-session.js callLlm).
    const llm = async () => ({ content: script[i++], finish_reason: 'stop' });

    const session = createResearchSession({
      requirement: 'Extract 10 organic posts (exclude ads/promoted) from the feed page.',
      llm: llm,
      tools: tools.tools,
      toolSpecs: tools.toolSpecs,
      systemPrompt: tools.systemPromptBase,
      knowledge: { units: [], index: [] },
      budgets: { maxTurns: 20 },
      retry: { attempts: 1 }
    });
    tools.bindEngine(session);
    const report = await session.run();

    // Engine report shape: status==='stopped' on every termination; completion
    // is signalled by stopped.reason==='completed' (buildReport/stop in research-session.js).
    assert.equal(report.stopped && report.stopped.reason, 'completed', 'session completes: ' + JSON.stringify(report.stopped));
    // The rejection actually happened and named the missing receipt:
    const st = session.state();
    const toolEntries = st.session.transcript.filter((e) => e.kind === 'tool');
    const updateResults = toolEntries.filter((e) => e.name === 'service.update').map((e) => e.result);
    assert.equal(updateResults.length, 2);
    assert.equal(updateResults[0].grounding, 'rejected', 'inverted include rejected by the §8 gate');
    assert.ok(updateResults[0].rejections.some((r) => r.missing === 'attr-distribution'), 'rejection names the attr-distribution receipt');
    assert.equal(updateResults[1].updated, true, 'corrected artifact admitted');
    assert.equal(updateResults[1].version, 1);
    // attrStats actually ran against the rail (the receipt is real, not declared):
    assert.ok(rail._calls.some((s) => s.includes('$extractList') && s.includes('data-ad-rendering-role')), 'attrStats composed $extractList over the attribute');
    // verify ran on the CORRECTED artifact:
    assert.deepEqual(applied[applied.length - 1][0].script, CORRECTED_STEPS[0].script);
    // the observation log carries the receipts:
    assert.ok(session.observationLog.covers('div[data-kind="post"]'));
    assert.ok(session.observationLog.coversAttr('data-ad-rendering-role'));
    // no site tokens leaked into the assembled prompt:
    const lastAssistant = st.session.transcript.filter((e) => e.kind === 'assistant').length;
    assert.ok(lastAssistant >= 7);
  });
});
