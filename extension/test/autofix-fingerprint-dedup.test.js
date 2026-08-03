const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// This is a source-text audit test because the dedup logic lives inline in
// wizard.js prompt assembly — not a separately exported function. We verify
// the wiring by asserting key code patterns are present.
const fs = require('node:fs');
const path = require('node:path');
const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

describe('autoFix HTML fingerprint dedup wiring', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');

  it('wizardState declares htmlFingerprintsInHistory set', () => {
    assert.match(src, /htmlFingerprintsInHistory\s*[:=]\s*new Set\(\)/,
      'wizardState must have htmlFingerprintsInHistory = new Set()');
  });

  it('prompt assembly checks htmlFingerprintsInHistory.has(currentFp)', () => {
    assert.match(src, /htmlFingerprintsInHistory\.has\(/,
      'prompt assembly must check if fingerprint is already in history');
  });

  it('prompt assembly adds new fingerprint to the set before pushing history', () => {
    assert.match(src, /htmlFingerprintsInHistory\.add\(/,
      'prompt assembly must add new fingerprint to the set');
  });

  it('summarizeFixIteration call passes htmlContext parameter', () => {
    assert.match(src, /summarizeFixIteration\([\s\S]*?htmlContext\s*:/,
      'llmHistory.push must pass htmlContext to summarizeFixIteration');
  });

  it('when fingerprint is already in history, prompt uses UNCHANGED reference marker', () => {
    assert.match(src, /UNCHANGED from a prior round/,
      'deduped HTML section must contain the UNCHANGED reference marker');
  });
});
