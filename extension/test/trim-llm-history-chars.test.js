const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

// Local reimplementation of the post-RC24 trimLlmHistory logic, for unit testing.
function trimLlmHistoryImpl(history, fingerprintsInHistory, maxChars = 150000) {
  let total = history.reduce((n, m) => n + (m.content?.length || 0), 0);
  let trimmed = false;
  while (total > maxChars && history.length > 4) {
    const removed = history.shift();
    total -= (removed.content?.length || 0);
    trimmed = true;
  }
  if (trimmed && fingerprintsInHistory) fingerprintsInHistory.clear();
  return { history, total, trimmed };
}

describe('trimLlmHistory by total chars (C4)', () => {
  it('source audit: wizard.js trimLlmHistory uses a char-based limit, not message count', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const withoutComments = src.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(withoutComments, /function trimLlmHistory[\s\S]*?reduce\(\(n,\s*m\)\s*=>\s*n\s*\+/,
      'trimLlmHistory must compute total chars via reduce');
    assert.doesNotMatch(withoutComments, /function trimLlmHistory[\s\S]*?\.slice\(-6\)/,
      'trimLlmHistory must not use slice(-6) (the old count-based pattern)');
  });

  it('source audit: trimLlmHistory clears htmlFingerprintsInHistory when it trims', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const fnStart = src.indexOf('function trimLlmHistory');
    const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
    assert.match(fnBody, /htmlFingerprintsInHistory\.clear\(\)/,
      'trimLlmHistory must clear htmlFingerprintsInHistory after trimming to prevent dangling references');
  });

  it('unit: trims history when total chars exceed maxChars', () => {
    const history = [
      { role: 'user', content: 'A'.repeat(60000) },
      { role: 'assistant', content: 'B'.repeat(60000) },
      { role: 'user', content: 'C'.repeat(60000) },
      { role: 'assistant', content: 'D'.repeat(10000) },
      { role: 'user', content: 'E'.repeat(10000) }
    ];
    const fps = new Set(['fp1', 'fp2']);
    const result = trimLlmHistoryImpl(history, fps, 150000);
    assert.ok(result.trimmed, 'should have trimmed');
    assert.ok(result.total <= 150000, 'total should be under limit');
    assert.ok(result.history.length >= 4 || result.history.length === history.length,
      'should keep at least 4 messages or all if already under limit');
    assert.equal(fps.size, 0, 'fingerprintsInHistory should be cleared');
  });

  it('unit: does not trim if already under limit', () => {
    const history = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'reply' }
    ];
    const fps = new Set(['fp1']);
    const result = trimLlmHistoryImpl(history, fps, 150000);
    assert.equal(result.trimmed, false);
    assert.equal(result.history.length, 2);
    assert.equal(fps.size, 1, 'fps set should be untouched when no trimming happens');
  });
});
