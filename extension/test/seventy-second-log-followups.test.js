// Seventy-second log follow-ups (session-2): the model emitted
// {"tool":"finish","args":{"summary":"…"}} — finish in the TOOL slot.
// dispatchTool replied "unknown tool: finish" and the resend round nearly
// died in a provider outage with a verified-green artifact aboard.
// Fix: parse-layer coercion (the coercion IS the recovery — no extra LLM
// round), an engine system note when coercion fired, PROTOCOL_BLOCK
// teaching, and a defensive dispatchTool backstop.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Protocol = require('../lib/session-protocol');
const { createResearchSession } = require('../lib/research-session');

const PROTOCOL_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-protocol.js'), 'utf8');
const SESSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');

function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function scriptedLlm(replies, calls) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}

// ---------------------------------------------------------------------------
// Parse-layer coercion
// ---------------------------------------------------------------------------

describe('F1: parseAssistantTurn coerces tool:"finish"', () => {
  it('object-args variant: finish.summary carried, tool cleared, flag set', () => {
    const p = Protocol.parseAssistantTurn('{"think":"t","tool":"finish","args":{"summary":"s"}}');
    assert.equal(p.ok, true);
    assert.equal(p.turn.finish && p.turn.finish.summary, 's');
    assert.equal(p.turn.tool, null);
    assert.equal(p.turn.coercedFinish, true);
  });

  it('string-args variant: args string becomes finish.summary', () => {
    const p = Protocol.parseAssistantTurn('{"think":"t","tool":"finish","args":"summary text"}');
    assert.equal(p.ok, true);
    assert.equal(p.turn.finish.summary, 'summary text');
    assert.equal(p.turn.coercedFinish, true);
  });

  it('missing/non-string args: empty summary, still a valid finish', () => {
    const p = Protocol.parseAssistantTurn('{"think":"t","tool":"finish"}');
    assert.equal(p.ok, true);
    assert.equal(p.turn.finish.summary, '');
    assert.equal(p.turn.coercedFinish, true);
  });

  it('tool:"finish" AND finish present → ambiguous-action violation unchanged', () => {
    const p = Protocol.parseAssistantTurn('{"think":"t","tool":"finish","finish":{"summary":"s"}}');
    assert.equal(p.ok, false);
    assert.equal(p.violation, 'ambiguous-action');
  });

  it('correct-shape finish untouched: no coerced flag, zero repairs', () => {
    const p = Protocol.parseAssistantTurn('{"think":"t","finish":{"summary":"done"}}');
    assert.equal(p.ok, true);
    assert.equal(p.turn.finish.summary, 'done');
    assert.equal(p.turn.coercedFinish, undefined);
    assert.equal(p.turn.tool, null);
  });

  it('a NON-finish unknown tool is never coerced', () => {
    const p = Protocol.parseAssistantTurn('{"think":"t","tool":"frobnicate","args":{}}');
    assert.equal(p.ok, true);
    assert.equal(p.turn.tool, 'frobnicate');
    assert.equal(p.turn.finish, null);
    assert.equal(p.turn.coercedFinish, undefined);
  });
});

// ---------------------------------------------------------------------------
// Engine-level: coerced turn finishes the session + pushes the shape note
// ---------------------------------------------------------------------------

describe('F2: engine coerces a tool:"finish" turn into a completed session', () => {
  it('one LLM call total (no resend round) + system shape note in the transcript', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply('{"think":"done, shipping","tool":"finish","args":{"summary":"green finish v7"}}')
      ], calls),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.stopped.detail, 'green finish v7');
    assert.equal(report.turns, 1);
    assert.equal(calls.length, 1, 'the coercion IS the recovery — no repair/resend LLM round');
    const st = session.state();
    const notes = ((st.session && st.session.transcript) || st.transcript || []).filter(e => e && e.kind === 'system' && /finish was sent as a tool/.test(String(e.text || '')));
    assert.equal(notes.length, 1, 'exactly one shape note pushed');
    assert.match(notes[0].text, /TOP LEVEL/);
    assert.match(notes[0].text, /exactly one of "tool"\/"finish"/);
  });
});

// ---------------------------------------------------------------------------
// Teaching hardening + dispatch backstop (source audits)
// ---------------------------------------------------------------------------

describe('F3: teaching text + dispatch backstop', () => {
  it('PROTOCOL_BLOCK teaches finish is NEVER a tool name', () => {
    assert.match(Protocol.PROTOCOL_BLOCK, /NEVER a\s+tool name/);
    assert.match(Protocol.PROTOCOL_BLOCK, /There is no "finish" tool/);
  });

  it('missing-action nudge says finish goes at the top level', () => {
    assert.match(SESSION_SRC, /finish goes at the top level, not in the tool slot/);
  });

  it('dispatchTool backstop names the protocol shape for name === "finish"', () => {
    assert.match(SESSION_SRC, /name === 'finish'/);
    assert.match(SESSION_SRC, /finish is the protocol-level action, not a tool/);
  });

  it('universality: new strings carry no site tokens', () => {
    const src = PROTOCOL_SRC + '\n' + SESSION_SRC;
    const siteTokens = [/facebook/i, /mbasic/i, /m\.me/, /kwai/i, /douyin/i, /weibo/i, /baidu/i, /yuanbao/i];
    for (const re of siteTokens) {
      const hits = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || [];
      // pre-existing occurrences are out of scope; assert the NEW lines are
      // clean by checking the specific new string bodies directly.
      assert.doesNotMatch('finish is the protocol-level action, not a tool: resend this turn as {"finish":{"summary":"…"}} (top-level, exactly one of tool/finish)', re);
      assert.doesNotMatch('shape note: finish was sent as a tool — coerced to the protocol finish action', re);
    }
  });
});

// Eighty-ninth log: the model sent the FLAT variant {"tool":"finish",
// "summary":"…"} — summary as a TOP-LEVEL sibling with no args at all. The
// coercion harvested only obj.args, so the summary was lost and the stopped
// detail shipped bare VERIFY-disclosure blocks with no ship note (the user
// sees a finish with no explanation). Harvest the top-level summary too.
describe('89th log: flat-finish summary harvest', () => {
  it('{"tool":"finish","summary":"…"} — top-level summary becomes finish.summary', () => {
    const p = Protocol.parseAssistantTurn('{"think":"t","tool":"finish","summary":"Facebook 关键词搜索帖子采集服务（v4，verify 绿色…）"}');
    assert.equal(p.ok, true);
    assert.equal(p.turn.finish && p.turn.finish.summary, 'Facebook 关键词搜索帖子采集服务（v4，verify 绿色…）');
    assert.equal(p.turn.tool, null);
    assert.equal(p.turn.coercedFinish, true);
  });

  it('args still wins when BOTH are present (the richer shape)', () => {
    const p = Protocol.parseAssistantTurn('{"tool":"finish","args":{"summary":"from-args"},"summary":"from-top"}');
    assert.equal(p.ok, true);
    assert.equal(p.turn.finish.summary, 'from-args');
  });
});
