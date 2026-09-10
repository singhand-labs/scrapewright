// extension/test/fifty-ninth-log-followups.test.js
// Fifty-ninth log — glm-5.1, 37+ turns, exported MID-SESSION (no stopped
// event, zero verifies). The good news first: probe.timestamp was CALLED and
// returned the ABSOLUTE "October 27, 2024" in one call (the fifty-sixth-round
// tool + fifty-eighth-round knowledge-unit routing both work — the timestamp
// wall is crossed). The bug: the model's CONTRACT RENEGOTIATION carried
// "postId": {"type": "type", "description": "placeholder"} — a literal
// unfilled stub — and io.confirm's validation accepted it, surfacing the
// garbage in the USER's confirm panel. The user rejected it twice (correctly)
// and the session burned turns re-proposing. The user must never be the lint
// layer: placeholder-shaped schemas are rejected at BOTH admission gates.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionTools } = require('../lib/session-tools');
const WU = require('../lib/wizard-utils');

// The exact renegotiation schema shape from this log (abridged to the stub).
const STUB_SCHEMA = {
  type: 'object', required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'content', 'postTime', 'htmlSnippet'],
        properties: {
          index: { type: 'integer', description: '序号' },
          postId: { type: 'type', description: 'placeholder' },
          postTime: { type: 'string', description: '发帖时间' },
          content: { type: 'string' },
          htmlSnippet: { type: 'string' }
        }
      }
    }
  }
};

const CLEAN_SCHEMA = {
  type: 'object', required: ['posts'],
  properties: {
    posts: { type: 'array', items: { type: 'object', properties: {
      postId: { type: 'string', description: 'the post id from the permalink' },
      postTime: { type: 'string' }
    } } }
  }
};

describe('F1: detectSchemaPlaceholderFields (fifty-ninth log)', () => {
  it('names the exact "type":"type" + "placeholder" stub from this log', () => {
    const out = WU.detectSchemaPlaceholderFields(STUB_SCHEMA);
    assert.ok(out && out.length === 1, 'one stub field: ' + JSON.stringify(out));
    assert.equal(out[0].field, 'postId');
    assert.ok(/posts\.items\.postId$/.test(out[0].path), 'path names the field location: ' + out[0].path);
    assert.ok(out[0].problems.length >= 2, 'invalid type + placeholder description both named');
  });

  it('invalid type values outside the JSON-Schema enum fail; the legal set passes', () => {
    for (const bad of ['type', 'str', 'text', 'foo', 'num']) {
      const s = { type: 'object', properties: { a: { type: 'object', properties: { x: { type: bad } } } } };
      assert.ok(WU.detectSchemaPlaceholderFields(s), 'type ' + bad + ' rejected');
    }
    for (const good of ['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']) {
      const s = { type: 'object', properties: { a: { type: 'object', properties: { x: { type: good } } } } };
      assert.equal(WU.detectSchemaPlaceholderFields(s), null, 'type ' + good + ' legal');
    }
  });

  it('placeholder-ish descriptions fail (placeholder/TODO/tbd/.../xxx), real descriptions pass', () => {
    for (const bad of ['placeholder', 'TODO fill', 'TBD', '...', 'xxx']) {
      const s = { type: 'object', properties: { a: { type: 'string', description: bad } } };
      assert.ok(WU.detectSchemaPlaceholderFields(s), 'description ' + bad + ' rejected');
    }
    assert.equal(WU.detectSchemaPlaceholderFields(CLEAN_SCHEMA), null);
  });

  it('malformed input → null, never throws', () => {
    assert.equal(WU.detectSchemaPlaceholderFields(null), null);
    assert.equal(WU.detectSchemaPlaceholderFields('x'), null);
    assert.equal(WU.detectSchemaPlaceholderFields({ type: 'string' }), null);
  });

  it('io.confirm REJECTS the stub schema with a pointed error — the user never sees it', async () => {
    const t = createSessionTools(makeDeps59());
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: STUB_SCHEMA });
    assert.equal(r.confirmed, false, 'rejected before the panel');
    assert.match(String(r.error), /placeholder/i);
    assert.ok(String(r.error).includes('postId'), 'the stub field is named');
    assert.match(String(r.error), /"string"|"number"|valid type/i, 'teaches the legal type set');
  });

  it('io.confirm accepts the clean schema', async () => {
    const t = createSessionTools(makeDeps59());
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: CLEAN_SCHEMA });
    assert.equal(r.confirmed, true);
  });

  it('service.update with an explicit stub schema is rejected too', async () => {
    const deps = makeDeps59();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: CLEAN_SCHEMA });
    const r = await t.tools['service.update']({ outputSchema: STUB_SCHEMA }, ctx59());
    assert.match(String(r.error), /placeholder/i, 'explicit-schema path gated: ' + JSON.stringify(r).slice(0, 200));
  });
});

function makeDeps59() {
  return {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async () => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: {}, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
    getDraftService: () => ({ name: 's', steps: [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }] }),
    applyArtifact: () => {},
    getTestInput: () => null,
    getOutputSchema: () => null,
    getSteps: () => [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }],
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
  };
}
function ctx59() {
  return { session: { state: () => ({ session: { artifactVersions: [] } }) } };
}

// universality
describe('universality: fifty-ninth-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('the placeholder detector stays generic', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../lib/wizard-utils.js'), 'utf8').replace(/\0/g, '');
    const i = src.indexOf('function detectSchemaPlaceholderFields');
    assert.ok(i > -1, 'detector present');
    assert.ok(!FORBIDDEN.test(src.slice(i, i + 1800)));
  });
});
