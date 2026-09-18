// Eighty-sixth-round audit ask: the user reviews the research steering, but
// the console capture only retains the FIRST 8000 chars of each LLM request
// (llm-client logContentChunks cap) — the entire control layer rides the
// elided tail: the rebuilt-per-turn EVIDENCE DOSSIER ([STEP PLAN] included),
// the USER FEEDBACK (fix request) transcript entries, knowledge-unit
// attachments, and engine system notes. Three user feedback rounds in one
// log file were unrecoverable for review.
//
// Fix: assembleMessages emits ONE compact `prompt_digest` console line per
// turn — prompt size, message count, system-section headers, the [STEP PLAN]
// block verbatim, and the last system-note first-lines — so future console
// captures make the steering layer auditable without logging 100K-char
// prompts.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createResearchSession } = require(path.join(__dirname, '..', 'lib', 'research-session.js'));

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

describe('86th-round F3: per-turn prompt_digest audit line', () => {
  it('every LLM call is preceded by a compact digest carrying [STEP PLAN] + note heads', async () => {
    const digests = [];
    const origLog = console.log;
    console.log = function (...a) {
      const s = String(a[0] || '');
      if (s.indexOf('[session] prompt_digest ') === 0) digests.push(s);
    };
    try {
      const script1 = "return await $extractList('div.card', { title: { selector: 'h3' } })";
      const calls = [];
      const session = createResearchSession({
        requirement: 'r',
        llm: scriptedLlm([
          reply(envelope('probe.count', { sel: 'div.card' })),
          reply(envelope('service.update', { steps: [{ id: 's1', name: 'extract cards', script: script1 }] })),
          reply(envelope('verify.run', {})),
          reply(finishEnvelope())
        ], calls),
        tools: {
          'probe.count': async () => ({ count: 5 }),
          'service.update': async () => ({ updated: true }),
          'verify.run': async () => ({ ok: true, steps: [{ stepId: 's1', result: { posts: [1, 2] } }] })
        },
        dossierFeeds: { containerHtml: () => null, popovers: () => [], lastVerify: () => null }
      });
      await session.run();
    } finally { console.log = origLog; }
    assert.ok(digests.length >= 3, 'one digest per LLM call, got ' + digests.length);
    const withPlan = digests.filter((d) => d.indexOf('[STEP PLAN]') !== -1);
    assert.ok(withPlan.length >= 2, 'the plan rides the digest after service.update');
    assert.match(withPlan[withPlan.length - 1], /s1 \(extract cards\): tested/);
    for (const d of digests) {
      assert.ok(d.length <= 2600, 'digest stays compact (≤2600 chars), got ' + d.length);
      assert.match(d, /"promptChars":\d+/);
      assert.match(d, /"msgCount":\d+/);
    }
  });

  it('the digest surfaces the last system-note head (USER FEEDBACK / nudges) without the full text', async () => {
    const digests = [];
    const origLog = console.log;
    console.log = function (...a) {
      const s = String(a[0] || '');
      if (s.indexOf('[session] prompt_digest ') === 0) digests.push(s);
    };
    try {
      const calls = [];
      const session = createResearchSession({
        requirement: 'r',
        llm: scriptedLlm([
          reply(envelope('probe.count', { sel: 'div.card' })),
          reply(envelope('probe.count', { sel: 'div.card' })),
          reply(finishEnvelope())
        ], calls),
        tools: { 'probe.count': async () => ({ count: 5 }) },
        dossierFeeds: { containerHtml: () => null, popovers: () => [], lastVerify: () => null }
      });
      await session.run();
    } finally { console.log = origLog; }
    assert.ok(digests.length >= 3);
    assert.match(digests[digests.length - 1], /"sysNotes"/);
  });
});
