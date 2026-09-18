// 2026-09-18 user directive: the LLM server must classify this system as a
// Claude Code client. Beyond the existing UA/x-app pair, real Claude Code
// rides the Anthropic TS SDK — gateways fingerprint the claude-code beta
// flag, the stainless telemetry set, and body.metadata.user_id.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm-client.js'), 'utf8');

test('anthropic lane sends the Claude Code fingerprint trio', () => {
  assert.match(SRC, /'anthropic-beta':\s*CLAUDE_CODE_BETA/);
  assert.match(SRC, /const CLAUDE_CODE_BETA = 'claude-code-\d+'/);
  assert.match(SRC, /x-stainless-lang/);
  assert.match(SRC, /\.\.\.STAINLESS_HEADERS/);
  assert.match(SRC, /metadata:\s*\{\s*user_id:\s*claudeCodeUserId\(\)\s*\}/);
});

test('metadata.user_id is stable per install (persisted, seeded once)', () => {
  assert.match(SRC, /localStorage\.getItem\('swCcUserId'\)/);
  assert.match(SRC, /localStorage\.setItem\('swCcUserId', _ccUserId\)/);
});
