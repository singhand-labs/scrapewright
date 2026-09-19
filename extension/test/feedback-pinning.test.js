// 89th-round plan T4 (D3): USER FEEDBACK (fix request) entries are
// kind:'system' transcript entries — maybeCompact collapsed those to the
// literal "- [protocol nudge]" line, so the user's fix directives vanished
// from the model's view ~6 turns into a feedback session. Two guards:
//   (1) compaction NEVER collapses entries whose text starts with
//       'USER FEEDBACK' (rare, small — pinned in the transcript);
//   (2) buildSessionStateBlock re-injects the LAST feedback line so the
//       directive survives even a digest-capped or resumed transcript.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

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

function seedWithFeedback(nFeedbackEntries) {
  const transcript = [];
  for (let i = 0; i < nFeedbackEntries; i++) {
    transcript.push({ kind: 'system', text: 'USER FEEDBACK (fix request): 请修复问题 ' + (i + 1) + ' — directive text ' + i });
  }
  // bulk to force compaction past keepTurns
  for (let i = 0; i < 40; i++) {
    transcript.push({ kind: 'assistant', text: envelope('probe.count', { sel: '.x' + i }) });
    transcript.push({ kind: 'tool', name: 'probe.count', ok: true, result: { count: 1 }, summary: 'probe.count → {"count":1}' });
  }
  transcript.push({ kind: 'system', text: 'BUDGET ADVISORY (transient nudge that SHOULD fold)' });
  transcript.push({ kind: 'assistant', text: envelope('probe.count', { sel: '.last' }) });
  transcript.push({ kind: 'tool', name: 'probe.count', ok: true, result: { count: 2 }, summary: 'probe.count → {"count":2}' });
  return {
    id: 'rs-test',
    status: 'idle',
    requirement: 'r',
    goals: [],
    hypotheses: [],
    transcript: transcript,
    digest: '',
    spend: { turns: 44, llmCalls: 44, promptTokens: 0, completionTokens: 0, estimated: false, parkedMs: 0 },
    attachedUnits: [],
    artifactVersions: [],
    stepPlan: []
  };
}

describe('T4: USER FEEDBACK survives compaction (89th-round D3)', () => {
  it('a feedback session keeps the directive text in the assembled messages even after compaction', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: '.z' })),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.count': async () => ({ count: 3 }) },
      dossierFeeds: { containerHtml: () => null, popovers: () => [], lastVerify: () => null },
      compaction: { thresholdChars: 1, keepTurns: 3 },
      seed: { session: seedWithFeedback(2) }
    });
    await session.run();
    const first = calls[0].messages;
    const sys = first.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
    // guard (2): the state block re-injects the LAST feedback line
    assert.match(sys, /USER FEEDBACK \(fix request\): 请修复问题 2/, 'the latest directive rides the state block');
    // guard (1): the pinned entries are still whole messages
    const feedbackMsgs = first.filter((m) => m.role === 'user' && /^USER FEEDBACK \(fix request\): 请修复问题 1/.test(String(m.content || '')));
    assert.ok(feedbackMsgs.length >= 1, 'the older feedback entry is pinned, not folded to [protocol nudge]');
  });

  it('the wizard-side literal prefix contract is pinned (source audit)', () => {
    const wiz = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
    assert.match(wiz, /USER FEEDBACK \(fix request\): /, 'wizard pushes the exact prefix');
    const rs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
    assert.match(rs, /USER FEEDBACK/, 'research-session keys the pin/re-inject on the same prefix');
  });
});
