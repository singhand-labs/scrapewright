const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSchemaFields, buildIORenderString, validateTestInput, cleanLLMResponse, buildResearchPrompt, buildFixPrompt, validateSteps, validateForExecution, validateChain, appendGlobalContextBlock, buildAutoFixSystemMessage, fillEntryUrlDefaults, appendStepWithChainLink, removeStepWithRelink, relinkChainToArray, normalizeStepTopology, DEFAULT_POLL_MAX_ITERATIONS, buildRequirementsBlock, suggestServiceName, SCRIPT_DSL_GUIDE, truncateSnapshotForLLM } = require('../lib/wizard-utils');

describe('parseSchemaFields', () => {
  it('returns field names with types', () => {
    const schema = { properties: { query: { type: 'string' }, count: { type: 'number' } } };
    assert.equal(parseSchemaFields(schema), 'query (string), count (number)');
  });

  it('returns "none" for empty schema', () => {
    assert.equal(parseSchemaFields({}), 'none');
    assert.equal(parseSchemaFields({ type: 'object' }), 'none');
  });

  it('handles missing type with "?"', () => {
    const schema = { properties: { foo: {} } };
    assert.equal(parseSchemaFields(schema), 'foo (?)');
  });

  it('handles single field', () => {
    const schema = { properties: { name: { type: 'string' } } };
    assert.equal(parseSchemaFields(schema), 'name (string)');
  });
});

describe('buildIORenderString', () => {
  it('combines input and output fields', () => {
    const input = { properties: { q: { type: 'string' } } };
    const output = { properties: { answer: { type: 'string' } } };
    assert.equal(buildIORenderString(input, output), 'Input: q (string) | Output: answer (string)');
  });

  it('handles null schemas', () => {
    assert.equal(buildIORenderString(null, null), 'Input: none | Output: none');
  });
});

describe('validateTestInput', () => {
  it('parses valid JSON', () => {
    const result = validateTestInput('{"type":"object"}', '{"type":"object"}', '{"q":"hi"}');
    assert.equal(result.valid, true);
    assert.deepEqual(result.testInput, { q: 'hi' });
  });

  it('returns error for invalid JSON', () => {
    const result = validateTestInput('bad', '{"type":"object"}', '{}');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });
});

describe('cleanLLMResponse', () => {
  it('strips ```json blocks', () => {
    const raw = '```json\n{"findings":"test"}\n```';
    assert.equal(cleanLLMResponse(raw), '{"findings":"test"}');
  });

  it('strips ``` blocks without json tag', () => {
    const raw = '```\n{"findings":"test"}\n```';
    assert.equal(cleanLLMResponse(raw), '{"findings":"test"}');
  });

  it('returns plain JSON unchanged', () => {
    const raw = '{"findings":"test"}';
    assert.equal(cleanLLMResponse(raw), '{"findings":"test"}');
  });
});

describe('buildResearchPrompt', () => {
  it('includes URL and description', () => {
    const prompt = buildResearchPrompt('https://example.com', 'get data', '<html>', 'text');
    assert.ok(prompt.includes('https://example.com'));
    assert.ok(prompt.includes('get data'));
    assert.ok(prompt.includes('inputSchema'));
    assert.ok(prompt.includes('outputSchema'));
    assert.ok(prompt.includes('sampleInput'));
  });
});

describe('buildFixPrompt', () => {
  it('includes error and script', () => {
    const prompt = buildFixPrompt('elm not found', 'https://x.com', 'scrape', 'await $()', '', '', [], null);
    assert.ok(prompt.includes('elm not found'));
    assert.ok(prompt.includes('await $()'));
    assert.ok(prompt.includes('fix the script'));
  });

  it('includes feedback when provided', () => {
    const prompt = buildFixPrompt('err', 'url', 'desc', 'code', '', '', [], 'click faster');
    assert.ok(prompt.includes('click faster'));
  });
});

describe('validateSteps', () => {
  it('rejects empty steps array', () => {
    const r = validateSteps([]);
    assert.equal(r.valid, false);
  });  it('rejects step with missing script when needsAnnotation is false', () => {
    const r = validateSteps([{ id: '1', script: '', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }]);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('script'));
  });

  it('rejects whitespace-only script when needsAnnotation is false', () => {
    const r = validateSteps([{ id: '1', script: '   \n  \t ', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }]);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('script'));
  });

  it('accepts step with empty script when needsAnnotation is true', () => {
    const r = validateSteps([{ id: '1', script: '', needsAnnotation: true, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }]);
    assert.equal(r.valid, true);
  });

  it('accepts step with PENDING_ANNOTATION placeholder', () => {
    const r = validateSteps([{ id: '1', script: '// PENDING_ANNOTATION', needsAnnotation: true, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }]);
    assert.equal(r.valid, true);
  });

  it('rejects duplicate step ids', () => {
    const r = validateSteps([
      { id: '1', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
      { id: '1', script: 'return 2;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('Duplicate'));
  });

  it('rejects maxIterations less than 1', () => {
    const r = validateSteps([{ id: '1', script: 'return 1;', maxIterations: 0, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }]);
    assert.equal(r.valid, false);
  });

  it('accepts valid normal steps', () => {
    const r = validateSteps([{ id: '1', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }]);
    assert.equal(r.valid, true);
  });
});

describe('validateForExecution', () => {
  it('rejects placeholder scripts that validateSteps allows for needsAnnotation', () => {
    const steps = [{ id: '1', script: '', needsAnnotation: true, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    assert.equal(validateSteps(steps).valid, true);
    assert.equal(validateForExecution(steps).valid, false);
    assert.ok(validateForExecution(steps).error.includes('pending annotation'));
  });

  it('rejects // PENDING_ANNOTATION placeholder at deploy time', () => {
    const steps = [{ id: '1', script: '// PENDING_ANNOTATION', needsAnnotation: true, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    assert.equal(validateForExecution(steps).valid, false);
  });

  it('accepts steps with real scripts', () => {
    const steps = [
      { id: '1', script: 'return await $extract("h1");', onSuccess: '2', onFailure: 'TERMINATE', maxIterations: 1 },
      { id: '2', script: 'return { title: __lastResult__ };', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
    ];
    assert.equal(validateForExecution(steps).valid, true);
  });

  it('rejects whitespace-only scripts even with needsAnnotation', () => {
    const steps = [{ id: '1', script: '   \n  ', needsAnnotation: true, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    assert.equal(validateForExecution(steps).valid, false);
  });
});

describe('validateChain', () => {
  it('accepts single step terminating chain', () => {
    const r = validateChain([{ id: 'a', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }]);
    assert.equal(r.valid, true);
  });

  it('accepts linear multi-step chain', () => {
    const r = validateChain([
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'c', onFailure: 'TERMINATE' },
      { id: 'c', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, true);
  });

  it('rejects the legacy SELF sentinel (no longer supported)', () => {
    // SELF was the old self-loop marker. Under Model A it is rejected loudly at
    // validation rather than silently mis-executing as a literal step id.
    const r = validateChain([
      { id: 'wait', onSuccess: 'SELF', onFailure: 'extract', maxIterations: 20 },
      { id: 'extract', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('no longer supported'), 'error should explain SELF is rejected');
  });

  it('accepts a poll/wait step (maxIterations>1, forward onSuccess)', () => {
    // The Model A poll pattern: onSuccess points FORWARD to the extraction step,
    // maxIterations>1 enables retry, and the script returns { done: false } to retry.
    const r = validateChain([
      { id: 'wait', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 20 },
      { id: 'extract', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, true);
  });

  it('accepts branch where onFailure points to a different step', () => {
    const r = validateChain([
      { id: 'check', onSuccess: 'success', onFailure: 'fallback' },
      { id: 'success', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
      { id: 'fallback', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, true);
  });

  it('accepts missing onFailure (orchestrator defaults to TERMINATE)', () => {
    const r = validateChain([
      { id: 'a', onSuccess: 'b' },
      { id: 'b', onSuccess: 'TERMINATE' }
    ]);
    assert.equal(r.valid, true);
  });

  it('rejects empty steps array', () => {
    const r = validateChain([]);
    assert.equal(r.valid, false);
    assert.ok(r.error);
  });

  it('rejects dangling onSuccess pointer', () => {
    const r = validateChain([
      { id: 'a', onSuccess: 'nonexistent', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('nonexistent'), 'error should name the missing target');
  });

  it('rejects dangling onFailure pointer', () => {
    const r = validateChain([
      { id: 'a', onSuccess: 'TERMINATE', onFailure: 'ghost' }
    ]);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('ghost'));
  });

  it('rejects unreachable step (the original chain-link bug)', () => {
    // steps[1] exists but nothing in the chain points to it. This is exactly
    // what addStep() used to produce before appendStepWithChainLink.
    const r = validateChain([
      { id: 'a', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
      { id: 'orphan', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('orphan'), 'error should name the unreachable step');
  });

  it('rejects first step missing id', () => {
    const r = validateChain([
      { onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ]);
    assert.equal(r.valid, false);
  });

  it('does not mutate the input steps', () => {
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const snapshot = JSON.stringify(steps);
    validateChain(steps);
    assert.equal(JSON.stringify(steps), snapshot, 'input must not be mutated');
  });
});

describe('validateForExecution integrates chain check', () => {
  it('rejects unreachable steps at deploy time even with valid scripts', () => {
    const steps = [
      { id: 'a', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
      { id: 'orphan', script: 'return 2;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    assert.equal(validateSteps(steps).valid, true);
    assert.equal(validateForExecution(steps).valid, false);
    assert.ok(validateForExecution(steps).error.includes('orphan'));
  });
});

describe('appendGlobalContextBlock', () => {
  it('returns base unchanged when description is empty (no-op branch)', () => {
    const base = 'You are a web scraping expert.';
    assert.equal(appendGlobalContextBlock(base, ''), base);
    assert.equal(appendGlobalContextBlock(base, undefined), base);
    assert.equal(appendGlobalContextBlock(base, null), base);
  });

  it('returns base unchanged when description is whitespace-only', () => {
    const base = 'You are a web scraping expert.';
    assert.equal(appendGlobalContextBlock(base, '   \n\t  '), base);
  });

  it('appends GLOBAL CONTEXT block when description is present', () => {
    const base = 'You are a web scraping expert.';
    const result = appendGlobalContextBlock(base, 'get company info');
    assert.ok(result.startsWith(base));
    assert.ok(result.includes('[GLOBAL CONTEXT]'));
    assert.ok(result.includes('[/GLOBAL CONTEXT]'));
    assert.ok(result.includes('get company info'));
  });

  it('trims surrounding whitespace from description before embedding', () => {
    const result = appendGlobalContextBlock('base', '  padded description  ');
    assert.ok(result.includes('"padded description"'));
    assert.ok(!result.includes('"  padded description  "'));
  });
});

describe('buildAutoFixSystemMessage', () => {
  it('returns base fixer prompt when description is empty', () => {
    const result = buildAutoFixSystemMessage('');
    assert.ok(result.includes('web scraping script fixer'));
    assert.ok(result.includes('Return only JavaScript code'));
    assert.ok(!result.includes('[GLOBAL CONTEXT]'));
  });

  it('appends GLOBAL CONTEXT when description is present', () => {
    const result = buildAutoFixSystemMessage('scrape company registrations');
    assert.ok(result.includes('web scraping script fixer'));
    assert.ok(result.includes('[GLOBAL CONTEXT]'));
    assert.ok(result.includes('scrape company registrations'));
  });

  it('does not mutate base prompt text across calls (pure)', () => {
    const a = buildAutoFixSystemMessage('');
    const b = buildAutoFixSystemMessage('desc');
    assert.ok(a.includes('Do not change the step flow logic.'));
    assert.ok(b.includes('Do not change the step flow logic.'));
  });
});

describe('fillEntryUrlDefaults', () => {
  it('fills missing entryUrl with default', () => {
    const steps = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', entryUrl: 'https://keep.example' }];
    const out = fillEntryUrlDefaults(steps, 'https://default.example');
    assert.equal(out[0].entryUrl, 'https://default.example');
    assert.equal(out[1].entryUrl, 'https://keep.example');
  });

  it('does not override existing entryUrl (even empty-string)', () => {
    const steps = [{ id: 'a', entryUrl: '' }];
    const out = fillEntryUrlDefaults(steps, 'https://default.example');
    // empty string is "set" — but the helper treats empty as missing and fills it
    // (this matches the wizard's user-facing semantics: empty means "not specified")
    assert.equal(out[0].entryUrl, 'https://default.example');
  });

  it('returns steps unchanged when defaultUrl is empty', () => {
    const steps = [{ id: 'a' }];
    const out = fillEntryUrlDefaults(steps, '');
    assert.deepEqual(out, steps);
  });

  it('returns [] when steps is null or undefined', () => {
    assert.deepEqual(fillEntryUrlDefaults(null, 'https://x.example'), []);
    assert.deepEqual(fillEntryUrlDefaults(undefined, 'https://x.example'), []);
  });

  it('does not mutate input steps', () => {
    const steps = [{ id: 'a' }];
    const out = fillEntryUrlDefaults(steps, 'https://default.example');
    assert.equal(steps[0].entryUrl, undefined);
    assert.equal(out[0].entryUrl, 'https://default.example');
  });
});

describe('appendStepWithChainLink', () => {
  it('relinks previous TERMINATE step to new step id so the new step is reachable', () => {
    // Repro for "manually-added step never runs": the orchestrator follows
    // onSuccess pointers, not array position. The LLM-generated final step
    // has onSuccess='TERMINATE'. addStep() used to just push, leaving the
    // new step unreachable dead code.
    const steps = [
      { id: '1', onSuccess: '2', onFailure: 'TERMINATE' },
      { id: '2', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const newStep = { id: '3', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' };
    appendStepWithChainLink(steps, newStep);
    assert.equal(steps.length, 3);
    assert.equal(steps[1].onSuccess, '3', 'previous TERMINATE should be relinked to new step id');
    assert.equal(steps[2].onSuccess, 'TERMINATE', 'new step is now the terminator');
  });

  it('preserves a non-TERMINATE previous-last pointer (do not clobber a forward edge)', () => {
    // Under Model A there is no SELF; a poll step points onSuccess forward to the
    // extraction step. appendStepWithChainLink relinks only a TERMINATE predecessor,
    // so the poll step's forward pointer is left untouched.
    const steps = [
      { id: 'wait', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 20 },
      { id: 'extract', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const newStep = { id: 'final', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' };
    appendStepWithChainLink(steps, newStep);
    assert.equal(steps[0].onSuccess, 'extract', 'forward pointer preserved (not clobbered)');
    assert.equal(steps[1].onSuccess, 'final', 'extract (the actual terminator) is relinked to new step');
    assert.equal(steps[2].id, 'final');
  });

  it('preserves non-TERMINATE non-SELF branch pointers on previous last step', () => {
    // If the previous last step already branches somewhere (rare but possible),
    // don'\''t guess — leave it alone. User can wire manually.
    const steps = [
      { id: 'router', onSuccess: 'fallback', onFailure: 'TERMINATE' }
    ];
    const newStep = { id: 'extra', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' };
    appendStepWithChainLink(steps, newStep);
    assert.equal(steps[0].onSuccess, 'fallback', 'non-TERMINATE pointer must be preserved');
    assert.equal(steps.length, 2);
  });

  it('appends without linking when steps array is empty', () => {
    const steps = [];
    const newStep = { id: '1', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' };
    appendStepWithChainLink(steps, newStep);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, '1');
  });

  it('relinks across multiple sequential appends (simulates Add Step x N)', () => {
    const steps = [{ id: '1', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    appendStepWithChainLink(steps, { id: '2', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' });
    appendStepWithChainLink(steps, { id: '3', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' });
    assert.equal(steps[0].onSuccess, '2', 'step 1 relinked to step 2');
    assert.equal(steps[1].onSuccess, '3', 'step 2 (now prevLast on 2nd call) relinked to step 3');
    assert.equal(steps[2].onSuccess, 'TERMINATE', 'step 3 remains terminator');
    assert.equal(steps.length, 3);
  });

  it('returns the steps array (mutates in place, like addStep expects)', () => {
    const steps = [{ id: '1', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const newStep = { id: '2', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' };
    const returned = appendStepWithChainLink(steps, newStep);
    assert.equal(returned, steps, 'should return the same array reference');
    assert.equal(steps.length, 2, 'should push the new step');
    assert.equal(steps[1], newStep, 'new step should be at the end');
  });
});

describe('removeStepWithRelink', () => {
  it('redirects inbound onSuccess pointer to the deleted step\'s successor (skip-over)', () => {
    // a → b → c. Delete b. a should now point directly to c.
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'c', onFailure: 'TERMINATE' },
      { id: 'c', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'b');
    assert.equal(steps.length, 2);
    assert.equal(steps[0].onSuccess, 'c', 'predecessor should skip over deleted step');
    assert.deepEqual(steps.map(s => s.id), ['a', 'c']);
  });

  it('redirects inbound onFailure pointer to the deleted step\'s successor', () => {
    const steps = [
      { id: 'router', onSuccess: 'happy', onFailure: 'recovery' },
      { id: 'happy', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
      { id: 'recovery', onSuccess: 'final', onFailure: 'TERMINATE' },
      { id: 'final', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'recovery');
    assert.equal(steps[0].onFailure, 'final', 'router.onFailure should now point to recovery\'s successor');
    assert.deepEqual(steps.map(s => s.id), ['router', 'happy', 'final']);
  });

  it('redirects to the deleted poll step\'s forward onSuccess', () => {
    // Under Model A a poll step points onSuccess forward to the step that runs
    // once it finishes. Deleting the poll step wires its predecessor to that
    // forward successor (the deleted step's own onSuccess).
    const steps = [
      { id: 'pre', onSuccess: 'wait', onFailure: 'TERMINATE' },
      { id: 'wait', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 20 },
      { id: 'extract', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'wait');
    assert.equal(steps[0].onSuccess, 'extract', 'predecessor wired to the deleted poll step\'s forward onSuccess');
    assert.deepEqual(steps.map(s => s.id), ['pre', 'extract']);
  });

  it('redirects to TERMINATE when deleted step was a terminal with no onFailure', () => {
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'b');
    assert.equal(steps[0].onSuccess, 'TERMINATE', 'predecessor should now terminate directly');
    assert.equal(steps.length, 1);
  });

  it('deletes first step cleanly (new first step is whatever was at idx 1)', () => {
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'a');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, 'b', 'b is now the head (orchestrator starts at steps[0])');
  });

  it('leaves other steps\' unrelated pointers untouched', () => {
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'c' },
      { id: 'b', onSuccess: 'c', onFailure: 'TERMINATE' },
      { id: 'c', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'b');
    assert.equal(steps[0].onFailure, 'c', 'unrelated onFailure pointer preserved');
    assert.equal(steps[0].onSuccess, 'c', 'onSuccess rewired through deleted step');
  });

  it('returns the steps array (mutates in place)', () => {
    const steps = [
      { id: 'a', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const returned = removeStepWithRelink(steps, 'b');
    assert.equal(returned, steps);
  });

  it('is a no-op when id is not found', () => {
    const steps = [
      { id: 'a', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'nonexistent');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, 'a');
  });

  it('produces a validateChain-valid result for the linear-chain case', () => {
    // After delete, the remaining chain must still be traversal-valid.
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'c', onFailure: 'TERMINATE' },
      { id: 'c', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    removeStepWithRelink(steps, 'b');
    assert.equal(validateChain(steps).valid, true);
  });
});

describe('relinkChainToArray', () => {
  it('rewires onSuccess to match array order after a move-to-head', () => {
    // User's actual bug: step-4 was appended at the tail (onSuccess: TERMINATE),
    // then moved to index 0 via 3 btn-step-up clicks. Without relink, the
    // orchestrator reads steps[0] = step-4, sees onSuccess TERMINATE, runs only
    // step-4 and stops. The chain pointers from before the move never updated.
    const steps = [
      { id: 'step-1', onSuccess: 'step-2', onFailure: 'TERMINATE' },
      { id: 'step-2', onSuccess: 'step-3', onFailure: 'TERMINATE' },
      { id: 'step-3', onSuccess: 'step-4', onFailure: 'TERMINATE' },
      { id: 'step-4', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    // Simulate the 3 non-rewired array swaps the wizard used to do.
    const moved = steps.pop();
    steps.unshift(moved);
    // Array is now [step-4, step-1, step-2, step-3] but pointers are unchanged.
    relinkChainToArray(steps);
    assert.equal(steps[0].id, 'step-4');
    assert.equal(steps[0].onSuccess, 'step-1', 'new head points to old head');
    assert.equal(steps[1].onSuccess, 'step-2');
    assert.equal(steps[2].onSuccess, 'step-3');
    assert.equal(steps[3].onSuccess, 'TERMINATE', 'new tail terminates');
  });

  it('produces a validateChain-valid result after relink', () => {
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'c', onFailure: 'TERMINATE' },
      { id: 'c', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const moved = steps.pop();
    steps.unshift(moved);
    relinkChainToArray(steps);
    assert.equal(validateChain(steps).valid, true);
  });

  it('preserves a poll step\'s maxIterations (retry semantics survive reordering)', () => {
    // Under Model A polling is expressed by maxIterations + { done: false }, not
    // by a self-pointing onSuccess. relinkChainToArray rewrites onSuccess to match
    // array order but must NOT touch maxIterations — that is what makes the step
    // a poller. Here the forward pointer already matches array order, so onSuccess
    // is unchanged and maxIterations is preserved.
    const steps = [
      { id: 'wait', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 60 },
      { id: 'extract', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    relinkChainToArray(steps);
    assert.equal(steps[0].maxIterations, 60, 'maxIterations preserved (poll semantics intact)');
    assert.equal(steps[0].onSuccess, 'extract', 'onSuccess still points forward');
    assert.equal(steps[1].onSuccess, 'TERMINATE');
  });

  it('does not touch onFailure (branch/error paths are independent of array order)', () => {
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'recover' },
      { id: 'b', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    relinkChainToArray(steps);
    assert.equal(steps[0].onFailure, 'recover', 'onFailure untouched');
    assert.equal(steps[0].onSuccess, 'b', 'head still points to next array step');
    assert.equal(steps[1].onSuccess, 'TERMINATE', 'last step terminates');
  });

  it('handles a single-step array', () => {
    const steps = [{ id: 'only', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    relinkChainToArray(steps);
    assert.equal(steps[0].onSuccess, 'TERMINATE');
  });

  it('is a no-op on an empty array', () => {
    const steps = [];
    relinkChainToArray(steps);
    assert.equal(steps.length, 0);
  });

  it('handles adjacent middle-swap (move up from idx 2 to idx 1)', () => {
    const steps = [
      { id: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
      { id: 'b', onSuccess: 'c', onFailure: 'TERMINATE' },
      { id: 'c', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    // Swap b and c in array order; execution order should now be a → c → b.
    [steps[1], steps[2]] = [steps[2], steps[1]];
    relinkChainToArray(steps);
    assert.equal(steps[0].onSuccess, 'c');
    assert.equal(steps[1].onSuccess, 'b');
    assert.equal(steps[2].onSuccess, 'TERMINATE');
  });
});

describe('normalizeStepTopology', () => {
  // Model A deterministic heal: a step whose script emits a poll signal but left
  // maxIterations unset was clearly intended to poll — generation couldn't know
  // the page needed it. Boost it to a default budget instead of asking the LLM
  // again (it already failed to set it at generation time).

  it('boosts maxIterations on a poll-signaling step that left maxIterations unset', () => {
    const steps = [
      { id: 'wait', script: 'const r = await $exists(".x", 3000); return { done: !r };', onSuccess: 'extract', onFailure: 'TERMINATE' },
      { id: 'extract', script: 'return { a: 1 };', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const report = normalizeStepTopology(steps);
    assert.equal(steps[0].maxIterations, DEFAULT_POLL_MAX_ITERATIONS, 'poll step gets a default retry budget');
    assert.equal(steps[1].maxIterations, undefined, 'non-signaling step untouched');
    assert.equal(report.changed.length, 1);
    assert.equal(report.changed[0].id, 'wait');
  });

  it('respects an explicitly-set maxIterations (even 1)', () => {
    // The author set it deliberately — even if it looks wrong, don't override.
    const steps = [
      { id: 'wait', script: 'return { done: false };', maxIterations: 1, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    normalizeStepTopology(steps);
    assert.equal(steps[0].maxIterations, 1, 'explicit maxIterations must not be overridden');
  });

  it('leaves an already-configured poll step alone', () => {
    const steps = [
      { id: 'wait', script: 'return { done: false };', maxIterations: 20, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    normalizeStepTopology(steps);
    assert.equal(steps[0].maxIterations, 20);
  });

  it('does not touch a normal step whose result has no poll signal', () => {
    const steps = [
      { id: 'extract', script: 'return { answer: await $extract(".a") };', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const report = normalizeStepTopology(steps);
    assert.equal(steps[0].maxIterations, undefined, 'no signal → nothing injected');
    assert.equal(report.changed.length, 0);
  });

  it('recognizes all reserved poll-signal variants', () => {
    const variants = [
      'return { done: false };',
      'return { ready: false };',
      'return { complete: false };',
      'return { finished: false };',
      'return { responseReady: false };',
      'return { generating: true };',
      'return { loading: true };',
      'return { done: true };'
    ];
    for (const script of variants) {
      const steps = [{ id: 'w', script, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
      normalizeStepTopology(steps);
      assert.equal(steps[0].maxIterations, DEFAULT_POLL_MAX_ITERATIONS, 'should boost for: ' + script);
    }
  });

  it('boosts the realistic computed-signal pattern (done: !stillLoading)', () => {
    // The common real-world poll step negates/computes the signal rather than
    // returning a literal boolean. Detection keys on the reserved KEY, not the
    // value form. Over-detection is harmless: a higher cap goes unused if the
    // step's result never carries a top-level not-ready signal.
    const steps = [
      { id: 'wait', script: 'const stillLoading = await $exists(".spin", 3000); return { done: !stillLoading };', onSuccess: 'extract', onFailure: 'TERMINATE' }
    ];
    const report = normalizeStepTopology(steps);
    assert.equal(steps[0].maxIterations, DEFAULT_POLL_MAX_ITERATIONS);
    assert.equal(report.changed.length, 1);
  });

  it('does not match a reserved key embedded in another identifier', () => {
    // isDone / pendingReady are field names that merely CONTAIN a reserved word;
    // the word-boundary anchor must prevent a false positive.
    const steps = [
      { id: 'd', script: 'return { isDone: true, pendingReady: 0, items: [] };', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    normalizeStepTopology(steps);
    assert.equal(steps[0].maxIterations, undefined, 'embedded reserved word must not trigger a boost');
  });

  it('returns an empty changed list for a non-array input', () => {
    assert.deepEqual(normalizeStepTopology(null), { changed: [] });
    assert.deepEqual(normalizeStepTopology(undefined), { changed: [] });
  });
});

describe('buildRequirementsBlock', () => {
  test('formats a fully-specified requirements object as a labeled block', () => {
    const block = buildRequirementsBlock({ inputParams: 'keyword', pageOps: 'search and extract title', outputStruct: '{ title }' });
    assert.equal(block, [
      '## User Requirements',
      '- Input parameters: keyword',
      '- Page operations & data to collect: search and extract title',
      '- Output structure: { title }'
    ].join('\n'));
  });

  test('uses default markers when output structure is empty', () => {
    const block = buildRequirementsBlock({ inputParams: 'keyword', pageOps: 'search', outputStruct: '' });
    assert.ok(block.includes('- Output structure: (unspecified — infer)'));
  });

  test('uses default markers when input params and page ops are empty', () => {
    const block = buildRequirementsBlock({ inputParams: '', pageOps: '', outputStruct: '' });
    assert.ok(block.includes('- Input parameters: (none specified)'));
    assert.ok(block.includes('- Page operations & data to collect: (unspecified)'));
  });

  test('handles null/undefined gracefully', () => {
    const block = buildRequirementsBlock(null);
    assert.ok(block.startsWith('## User Requirements'));
    assert.ok(block.includes('(none specified)'));
  });
});

describe('suggestServiceName', () => {
  it('returns hostname without www prefix', () => {
    assert.equal(suggestServiceName('https://www.example.com/search'), 'example.com');
  });

  it('returns hostname without path', () => {
    assert.equal(suggestServiceName('https://news.ycombinator.com/item?id=1'), 'news.ycombinator.com');
  });

  it('handles URL without protocol', () => {
    assert.equal(suggestServiceName('example.com'), 'example.com');
  });

  it('returns empty string for invalid URL', () => {
    assert.equal(suggestServiceName('not a url'), '');
    assert.equal(suggestServiceName(''), '');
    assert.equal(suggestServiceName(null), '');
    assert.equal(suggestServiceName(undefined), '');
  });
});

describe('findEmptyExtractionFields', () => {
  const { findEmptyExtractionFields } = require('../lib/wizard-utils');
  const schema = { required: ['posts'] };

  it('flags an array of fully-empty objects', () => {
    const data = { posts: [{ 小组: '', 用户名: '', 内容: '', 插图url: [] }] };
    const empty = findEmptyExtractionFields(data, schema);
    assert.deepEqual(empty, ['posts']);
  });

  it('does not flag when at least one object has a non-empty value', () => {
    const data = { posts: [{ 小组: '', 用户名: '', 内容: 'hello' }] };
    const empty = findEmptyExtractionFields(data, schema);
    assert.deepEqual(empty, []);
  });

  it('does not flag scalar fields that are non-empty', () => {
    const data = { keyword: 'shoes' };
    const empty = findEmptyExtractionFields(data, { required: ['keyword'] });
    assert.deepEqual(empty, []);
  });

  it('does not flag arrays of primitives with values', () => {
    const data = { tags: ['a', 'b'] };
    const empty = findEmptyExtractionFields(data, { required: ['tags'] });
    assert.deepEqual(empty, []);
  });

  it('returns [] when outputSchema is missing/empty', () => {
    assert.deepEqual(findEmptyExtractionFields({ posts: [] }, null), []);
    assert.deepEqual(findEmptyExtractionFields({ posts: [] }, { required: [] }), []);
  });

  it('returns [] when data is not an object', () => {
    assert.deepEqual(findEmptyExtractionFields(null, schema), []);
    assert.deepEqual(findEmptyExtractionFields([1, 2], schema), []);
  });
});

describe('getOutputFieldOptions', () => {
  const { getOutputFieldOptions } = require('../lib/wizard-utils');

  it('returns top-level scalar keys as value+label pairs', () => {
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        question: { type: 'string' }
      },
      required: ['question', 'answer']
    };
    assert.deepEqual(getOutputFieldOptions(schema), [
      { value: 'answer', label: 'answer' },
      { value: 'question', label: 'question' }
    ]);
  });

  it('descends into array-of-objects and exposes inner fields as dotted values', () => {
    const schema = {
      type: 'object',
      properties: {
        posts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              group: { type: 'string' },
              username: { type: 'string' },
              content: { type: 'string' }
            }
          }
        }
      },
      required: ['posts']
    };
    const options = getOutputFieldOptions(schema);
    assert.deepEqual(options, [
      { value: 'posts.group', label: 'posts → group' },
      { value: 'posts.username', label: 'posts → username' },
      { value: 'posts.content', label: 'posts → content' }
    ]);
  });

  it('handles a mix of scalar fields and array-of-objects', () => {
    const schema = {
      type: 'object',
      properties: {
        totalCount: { type: 'number' },
        posts: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' } }
          }
        }
      }
    };
    const options = getOutputFieldOptions(schema);
    assert.deepEqual(options, [
      { value: 'totalCount', label: 'totalCount' },
      { value: 'posts.title', label: 'posts → title' }
    ]);
  });

  it('treats array-of-scalars as a plain top-level field (no descent)', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } }
      }
    };
    const options = getOutputFieldOptions(schema);
    assert.deepEqual(options, [{ value: 'tags', label: 'tags' }]);
  });

  it('returns [] for missing or malformed schema', () => {
    assert.deepEqual(getOutputFieldOptions(null), []);
    assert.deepEqual(getOutputFieldOptions({}), []);
    assert.deepEqual(getOutputFieldOptions({ properties: 'not-an-object' }), []);
  });
});

describe('buildAnnotationsText dotted outputField', () => {
  const { buildAnnotationsText } = require('../lib/wizard-utils');

  it('expands arrayName.subField into explicit per-item guidance', () => {
    const text = buildAnnotationsText([
      { type: 'extract', selector: '.post-group', outputField: 'posts.group' }
    ]);
    assert.match(text, /posts\.group/);
    assert.match(text, /"group" field of EACH item in the "posts" array/);
    assert.match(text, /NOT into a literal dotted key/);
  });

  it('leaves plain scalar outputField alone', () => {
    const text = buildAnnotationsText([
      { type: 'extract', selector: '.answer', outputField: 'answer' }
    ]);
    assert.match(text, /outputField: answer \(extract using the selector above into this field\)/);
  });
});

describe('SCRIPT_DSL_GUIDE regression', () => {
  it('warns about the :nth-of-type(N) trap on compound selectors', () => {
    assert.ok(typeof SCRIPT_DSL_GUIDE === 'string');
    assert.match(SCRIPT_DSL_GUIDE, /:nth-of-type\(N\)/);
    assert.match(SCRIPT_DSL_GUIDE, /CSS TRAP/i);
  });

  it('teaches parallel-array list extraction', () => {
    assert.match(SCRIPT_DSL_GUIDE, /LIST EXTRACTION/);
  });

  it('teaches empty-list early bailout', () => {
    assert.match(SCRIPT_DSL_GUIDE, /EMPTY-LIST BAILOUT/);
  });
});

describe('truncateSnapshotForLLM', () => {
  it('returns the snapshot unchanged when all fields are within budget', () => {
    const snap = { html: 'a'.repeat(100), textContent: 'b'.repeat(50), structure: 'c'.repeat(50), textSummary: 'short' };
    const out = truncateSnapshotForLLM(snap, 1000);
    assert.equal(out.html, 'a'.repeat(100));
    assert.equal(out.textContent, 'b'.repeat(50));
    assert.equal(out.structure, 'c'.repeat(50));
    assert.equal(out.textSummary, 'short');
    assert.ok(!out.html.startsWith('[TRUNCATED'));
  });

  it('truncates html to budget chars and prepends the TRUNCATED marker', () => {
    const big = 'x'.repeat(1000);
    const out = truncateSnapshotForLLM({ html: big }, 100);
    assert.equal(out.html.length, 100);
    assert.ok(out.html.startsWith('[TRUNCATED'));
    assert.ok(out.html.includes('original 1000 chars'));
  });

  it('allocates floor(budget/3) to textContent and structure independently', () => {
    const out = truncateSnapshotForLLM(
      { html: 'h'.repeat(1000), textContent: 't'.repeat(1000), structure: 's'.repeat(1000) },
      300
    );
    assert.equal(out.html.length, 300);
    assert.equal(out.textContent.length, 100);
    assert.equal(out.structure.length, 100);
  });

  it('does not mutate the input snapshot', () => {
    const original = { html: 'h'.repeat(500), textContent: 't'.repeat(500) };
    const originalHtmlLen = original.html.length;
    const originalTextLen = original.textContent.length;
    const _out = truncateSnapshotForLLM(original, 100);
    assert.equal(original.html.length, originalHtmlLen);
    assert.equal(original.textContent.length, originalTextLen);
  });

  it('handles missing fields gracefully (no throw)', () => {
    const out = truncateSnapshotForLLM({}, 1000);
    assert.deepEqual(out, {});
  });

  it('honors a custom budget override', () => {
    const out = truncateSnapshotForLLM({ html: 'h'.repeat(5000) }, 2000);
    assert.equal(out.html.length, 2000);
    assert.ok(out.html.startsWith('[TRUNCATED'));
  });
});
