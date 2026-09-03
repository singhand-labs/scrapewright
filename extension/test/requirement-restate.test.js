// Requirement restatement gate (user request after the fourteenth log):
// before a FRESH research start, the wizard asks the LLM to understand and
// restate the requirement in the user's OWN language; the user confirms,
// revises, or skips BEFORE research begins. Users often believe they
// described the requirement clearly — the restatement + open questions
// surface the gaps while they are still cheap to fix.
//
// wizard.js cannot load in Node — behavior tests target the wizard-utils
// helpers; the wizard.js / wizard.html wiring is pinned by source audit.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildRequirementRestatePrompt, normalizeRestatement } = require('../lib/wizard-utils');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');

describe('requirement restatement: prompt + normalization (wizard-utils)', () => {
  it('buildRequirementRestatePrompt carries the raw requirement as the user message', () => {
    const p = buildRequirementRestatePrompt('搜索 facebook 关键词帖子，抓点赞数');
    assert.equal(p.user, '搜索 facebook 关键词帖子，抓点赞数');
    assert.ok(typeof p.system === 'string' && p.system.length > 100);
  });

  it('the system prompt demands the SAME language as the input', () => {
    const p = buildRequirementRestatePrompt('x');
    assert.match(p.system, /SAME language/i);
    assert.match(p.system, /Chinese|English/);
  });

  it('the system prompt demands the exact JSON reply shape', () => {
    const p = buildRequirementRestatePrompt('x');
    assert.match(p.system, /"restatement"/);
    assert.match(p.system, /"openQuestions"/);
    assert.match(p.system, /\{"language"/);
    assert.match(p.system, /ONLY with a JSON object/i);
  });

  it('the system prompt forbids inventing details and demands plain wording', () => {
    const p = buildRequirementRestatePrompt('x');
    assert.match(p.system, /do NOT invent/i);
    assert.match(p.system, /non-programmer|plain/i);
  });

  it('the system prompt caps open questions and allows an empty array when clear', () => {
    const p = buildRequirementRestatePrompt('x');
    assert.match(p.system, /at most 5/i);
    assert.match(p.system, /empty array/i);
  });
});

describe('requirement restatement: normalizeRestatement (wizard-utils)', () => {
  it('happy path passes through trimmed fields', () => {
    const n = normalizeRestatement({ language: 'zh', restatement: ' 目标：搜索帖子 ', openQuestions: [' 要几页？', ''] });
    assert.equal(n.language, 'zh');
    assert.equal(n.restatement, '目标：搜索帖子');
    assert.deepEqual(n.openQuestions, ['要几页？']);
  });

  it('missing openQuestions / language degrade safely', () => {
    const n = normalizeRestatement({ restatement: 'ok' });
    assert.equal(n.language, '');
    assert.deepEqual(n.openQuestions, []);
  });

  it('caps openQuestions at 5, each at 300 chars, drops non-strings', () => {
    const qs = [];
    for (let i = 0; i < 8; i++) qs.push(i === 3 ? 42 : 'q' + i + ' '.repeat(320));
    qs.push('kept');
    const n = normalizeRestatement({ restatement: 'ok', openQuestions: qs });
    assert.equal(n.openQuestions.length, 5);
    assert.ok(n.openQuestions.every(q => typeof q === 'string' && q.length <= 300));
  });

  it('returns null for missing/empty/non-string restatement (treated as failure)', () => {
    assert.equal(normalizeRestatement(null), null);
    assert.equal(normalizeRestatement({}), null);
    assert.equal(normalizeRestatement({ restatement: '   ' }), null);
    assert.equal(normalizeRestatement({ restatement: { a: 1 } }), null);
  });
});

describe('requirement restatement: wizard wiring (source audit)', () => {
  it('maybeRestateThenStart exists and gates the Research button', () => {
    assert.match(SRC, /async function maybeRestateThenStart\(/);
    assert.match(SRC, /btnPhase1Research'\)\.addEventListener\('click',\s*startResearchSessionFromClick\)/);
    assert.match(SRC, /startResearchSessionFromClick = \(\) => maybeRestateThenStart\(\)/);
  });

  it('Ctrl+Enter on the requirement box goes through the gate', () => {
    const m = SRC.match(/reqPageOps'\)\.addEventListener\('keydown'[\s\S]{0,200}?if \([^)]*\)\s*\n?\s*[^;]+;/);
    assert.ok(m, 'reqPageOps keydown handler found');
    assert.match(m[0], /maybeRestateThenStart\(\)/);
  });

  it('an empty requirement box bypasses the gate (parked-session resume path untouched)', () => {
    const body = SRC.slice(SRC.indexOf('async function maybeRestateThenStart('), SRC.indexOf('async function showRequirementRestatePanel('));
    assert.match(body, /if \(!pageOps\)\s*\{\s*await startResearchSession\(\);\s*return;/);
  });

  it('the gate key is the hash of the full requirement text — confirmed text does not re-ask', () => {
    const body = SRC.slice(SRC.indexOf('async function maybeRestateThenStart('), SRC.indexOf('async function showRequirementRestatePanel('));
    assert.match(body, /requirementGateKey\(\) === restateConfirmedKey/);
    assert.match(SRC, /function requirementGateKey\(\)[\s\S]{0,400}?hashString\(/);
  });

  it('the LLM reply is rendered with textContent (never innerHTML) — XSS-safe', () => {
    const body = SRC.slice(SRC.indexOf('async function showRequirementRestatePanel('), SRC.indexOf('async function startResearchSession('));
    assert.match(body, /body\.textContent\s*=\s*norm\.restatement/, 'restatement set via textContent');
    assert.match(body, /li\.textContent\s*=\s*q/, 'question items set via textContent');
    const assigns = body.match(/(?:body|li|note)\.innerHTML\s*=/g) || [];
    assert.equal(assigns.length, 0, 'no innerHTML assignment on LLM-derived nodes (note/questions innerHTML clears are on static containers only)');
  });

  it('the restatement LLM call carries no literal maxTokens (RC53 config knob)', () => {
    assert.ok(!/maxTokens:\s*\d+/.test(SRC), 'no literal maxTokens in wizard.js');
  });

  it('wizard.html carries the panel and all four buttons', () => {
    assert.match(HTML, /id="requirementRestatePanel"[^>]*class="exploration-panel hidden"/);
    for (const id of ['restateNote', 'restateBody', 'restateQuestions', 'btnRestateConfirm', 'btnRestateRevise', 'btnRestateSkip', 'btnRestateRetry']) {
      assert.ok(HTML.includes('id="' + id + '"'), id + ' present in wizard.html');
    }
  });

  it('all four panel buttons are wired in wizard.js', () => {
    for (const id of ['btnRestateConfirm', 'btnRestateRevise', 'btnRestateSkip', 'btnRestateRetry']) {
      assert.match(SRC, new RegExp(id + "'\\)\\.addEventListener\\('click'"), id + ' wired');
    }
    // Confirm/Skip record the gate key so the confirmed text does not re-ask.
    const confirmBody = SRC.match(/btnRestateConfirm'\)\.addEventListener\('click'[\s\S]{0,400}?\}\);/);
    assert.ok(confirmBody, 'confirm handler found');
    assert.match(confirmBody[0], /restateConfirmedKey = requirementGateKey\(\)/);
    assert.match(confirmBody[0], /startResearchSession\(\)/);
    // Revise closes the panel and focuses the requirement box for editing.
    const reviseBody = SRC.match(/btnRestateRevise'\)\.addEventListener\('click'[\s\S]{0,300}?\}\);/);
    assert.ok(reviseBody, 'revise handler found');
    assert.match(reviseBody[0], /reqPageOps'\)\.focus\(\)/);
  });
});
