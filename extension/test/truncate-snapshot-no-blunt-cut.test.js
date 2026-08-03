const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');

describe('truncateSnapshotForLLM does not use substring truncation', () => {
  it('source code contains no substring(0, on the html field', () => {
    const src = fs.readFileSync(WIZARD_UTILS_PATH, 'utf8');
    // Extract the truncateSnapshotForLLM function body
    const startIdx = src.indexOf('function truncateSnapshotForLLM');
    assert.ok(startIdx > -1, 'truncateSnapshotForLLM must exist');
    // Find the end of the function (next 'function ' at column 0 or EOF)
    const rest = src.slice(startIdx);
    const endMatch = rest.match(/\nfunction |\n\/\/ ---|\nconst /);
    const fnBody = endMatch ? rest.slice(0, endMatch.index) : rest;

    // The function must NOT contain substring(0, ... — that is the abolished blunt-cut pattern.
    assert.doesNotMatch(fnBody, /\.substring\(0,\s*[^)]+\)/,
      'truncateSnapshotForLLM must not use substring(0, ...) — that is the abolished blunt-cut pattern. ' +
      'Delegate to DomCleaner.cleanHtmlForLLM for tiered structure-preserving degradation.');
  });

  it('source code does not emit the [TRUNCATED original marker', () => {
    const src = fs.readFileSync(WIZARD_UTILS_PATH, 'utf8');
    const startIdx = src.indexOf('function truncateSnapshotForLLM');
    const rest = src.slice(startIdx);
    const endMatch = rest.match(/\nfunction |\n\/\/ ---|\nconst /);
    const fnBody = endMatch ? rest.slice(0, endMatch.index) : rest;
    assert.doesNotMatch(fnBody, /TRUNCATED original/,
      'truncateSnapshotForLLM must not emit the legacy [TRUNCATED original N chars] marker');
  });
});
