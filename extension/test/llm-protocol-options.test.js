// Thirty-fourth log followup (user directive): the Anthropic Messages
// protocol must stay wired end-to-end — Settings select, load/save mapping,
// and the agent client identity on the Messages path.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(extRoot, p), 'utf8');

describe('Anthropic protocol wiring (options UI + client identity)', () => {
  it('options.html offers exactly auto/anthropic/openai on #apiProtocol', () => {
    const html = read('options.html');
    const sel = /<select id="apiProtocol">([\s\S]*?)<\/select>/.exec(html);
    assert.ok(sel, 'select#apiProtocol exists');
    const values = [...sel[1].matchAll(/<option value="([a-z]+)">/g)].map((m) => m[1]);
    assert.deepEqual(values.sort(), ['anthropic', 'auto', 'openai']);
  });

  it('options.js load maps blank/legacy configs to auto and save whitelists the value', () => {
    const js = read('options.js');
    assert.match(js, /getElementById\('apiProtocol'\)\.value = \(proto === 'anthropic' \|\| proto === 'openai'\) \? proto : 'auto'/, "load defaults unknown → 'auto'");
    assert.match(js, /\['auto', 'anthropic', 'openai'\]\.includes\(document\.getElementById\('apiProtocol'\)\.value\)/, 'save whitelists');
  });

  it('llm-client sends the Claude Code agent signature on the Messages path', () => {
    const js = read('lib/llm-client.js');
    assert.match(js, /'user-agent': CLAUDE_CLI_USER_AGENT/, 'user-agent header');
    assert.match(js, /claude-cli\/.+ \(external, cli\)/, 'claude-cli signature constant');
    assert.match(js, /'anthropic-version': ANTHROPIC_VERSION/, 'anthropic-version header');
    assert.match(js, /'x-api-key': this\.apiKey/, 'x-api-key (native Anthropic auth)');
    assert.match(js, /'Authorization': `Bearer \$\{this\.apiKey\}`/, 'Bearer for bridges');
    assert.match(js, /'x-app': 'cli'/, 'x-app cli marker');
  });

  it('capability detection: 404/405 and OpenAI-shaped-200 both pin openai per base', () => {
    const js = read('lib/llm-client.js');
    assert.match(js, /response\.status === 404 \|\| response\.status === 405/, '404/405 fallback trigger');
    assert.match(js, /_markProtocol\(false\)/, 'sticky per-base marking');
    assert.match(js, /anthropicCapableByBase/, 'module-level capability cache');
  });
});
