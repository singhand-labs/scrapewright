// B6-B8/B15: documentation must match implementation. Pins the CLAUDE.md
// DSL section against the real primitive set and the whitepaper figures
// against the real constants.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CLAUDE_MD = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const WP_ZH = fs.readFileSync(path.join(ROOT, 'docs', 'technical-whitepaper.md'), 'utf8');
const WP_EN = fs.readFileSync(path.join(ROOT, 'docs', 'technical-whitepaper.en.md'), 'utf8');

const PRIMITIVES = [
  '$(', '$click', '$type', '$extract', '$wait', '$check', '$exists', '$count', '$list',
  '$openTab', '$scrollBy', '$scrollToBottom', '$scrollIntoView', '$hover',
  '$extractList', '$extractListMulti', '$clickInList', '$extractWithHover', '$waitForStable',
  '$labelledby', '$timestamp'
];

describe('B6: CLAUDE.md DSL section lists all 21 primitives', () => {
  it('every primitive appears in the Script DSL section', () => {
    const m = CLAUDE_MD.match(/### Script DSL \(\$ API\)[\s\S]*?(?=\n### |\n## )/);
    assert.ok(m, 'Script DSL section found');
    for (const p of PRIMITIVES) {
      // '$(' is the only primitive whose own name already ends in '(' —
      // appending another would search for the impossible "`$((".
      const token = p === '$(' ? '`$(' : '`' + p + '(';
      assert.ok(m[0].includes(token), p + ' documented in CLAUDE.md DSL section');
    }
  });

  it('timeout notes match implementation (5s extract / 10s click+type / WAIT_SELECTOR_EMPTY / $exists 0)', () => {
    const m = CLAUDE_MD.match(/### Script DSL \(\$ API\)[\s\S]*?(?=\n### |\n## )/);
    assert.match(m[0], /fail-fast default 5s/);
    assert.match(m[0], /10s/);
    assert.match(m[0], /WAIT_SELECTOR_EMPTY/);
    assert.match(m[0], /one immediate query/);
  });
});

describe('B7/B8/B15: whitepaper figures match implementation', () => {
  it('hover timeout documented as 4500ms with the 3000ms early exit (both languages)', () => {
    for (const wp of [WP_ZH, WP_EN]) {
      const row = wp.split('\n').find((l) => l.includes('`$hover('));
      assert.ok(row, '$hover row present');
      assert.match(row, /4500/, '4500ms default timeout documented');
      assert.doesNotMatch(row, /default 3000ms|默认 3000ms/);
    }
  });

  it('ElementData textContent documented as 50000 chars (both languages)', () => {
    for (const wp of [WP_ZH, WP_EN]) {
      const idx = wp.indexOf('interface ElementData');
      assert.ok(idx !== -1, 'ElementData block present');
      const block = wp.slice(idx, idx + 600);
      assert.match(block, /50000/, 'textContent cap documented as 50000');
    }
  });

  it('$click/$type rows carry the 10s element-wait default (both languages)', () => {
    for (const wp of [WP_ZH, WP_EN]) {
      const clickRow = wp.split('\n').find((l) => l.includes('`$click('));
      const typeRow = wp.split('\n').find((l) => l.includes('`$type('));
      assert.ok(clickRow && typeRow, 'rows present');
      assert.match(clickRow + typeRow, /10s|10 秒/);
    }
  });
});
