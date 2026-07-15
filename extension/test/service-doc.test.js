const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateExampleFromSchema, schemaFieldsTable, generateServiceMarkdown } = require('../lib/service-doc');

describe('schemaFieldsTable', () => {
  it('renders type, required flag, and description per field', () => {
    const schema = {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'a question' },
        n: { type: 'integer' }
      },
      required: ['q']
    };
    const t = schemaFieldsTable(schema);
    assert.match(t, /\| `q` \| string \| yes \| a question \|/);
    assert.match(t, /\| `n` \| integer \| no \|/);
  });

  it('escapes pipes inside descriptions', () => {
    const t = schemaFieldsTable({ type: 'object', properties: { f: { type: 'string', description: 'a|b' } } });
    assert.match(t, /a\\\|b/);
  });

  it('returns a placeholder when there are no properties', () => {
    assert.match(schemaFieldsTable(null), /No fields/);
    assert.match(schemaFieldsTable({ type: 'object' }), /No fields/);
  });
});

describe('generateExampleFromSchema', () => {
  it('uses sensible per-type defaults', () => {
    const ex = generateExampleFromSchema({
      type: 'object',
      properties: {
        s: { type: 'string' },
        n: { type: 'number' },
        i: { type: 'integer' },
        b: { type: 'boolean' },
        a: { type: 'array' },
        o: { type: 'object', properties: { x: { type: 'string' } } }
      }
    });
    assert.deepEqual(ex, { s: '', n: 0, i: 0, b: false, a: [], o: { x: '' } });
  });

  it('honors examples[0] when present', () => {
    const ex = generateExampleFromSchema({ type: 'object', properties: { s: { type: 'string', examples: ['hi'] } } });
    assert.equal(ex.s, 'hi');
  });
});

describe('generateServiceMarkdown', () => {
  const svc = {
    name: 'ai',
    displayName: 'AI Service',
    targetUrl: 'https://example.com',
    userDescription: 'An AI Q&A scraper.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'a question' } }, required: ['q'] },
    outputSchema: { type: 'object', properties: { a: { type: 'string', description: 'the answer' } } },
    sampleInput: { q: 'hello' },
    steps: [
      { id: '1', name: 'submit', onSuccess: '2' },
      { id: '2', name: 'extract', onSuccess: 'TERMINATE', condition: 'document.querySelector(".done")' }
    ]
  };
  const md = generateServiceMarkdown(svc, 8765);

  it('includes the endpoint with the resolved port', () => {
    assert.match(md, /POST http:\/\/localhost:8765\/api\/v1\/services\/ai\/execute/);
  });

  it('includes the curl submit example', () => {
    assert.match(md, /curl -X POST/);
    assert.match(md, /X-API-Key: dev-key/);
  });

  it('renders input and output field tables', () => {
    assert.match(md, /\| `q` \| string \| yes \| a question \|/);
    assert.match(md, /\| `a` \| string \| no \| the answer \|/);
  });

  it('documents the error catalog', () => {
    assert.match(md, /ELEMENT_NOT_FOUND/);
    assert.match(md, /LOGIN_REQUIRED/);
    assert.match(md, /SCRIPT_TIMEOUT/);
  });

  it('renders the step flow with successors', () => {
    assert.match(md, /\*\*submit\*\* → `2`/);
    assert.match(md, /\*\*extract\*\* → `TERMINATE`/);
  });

  it('notes the SCRAPEWRIGHT_API_KEY override', () => {
    assert.match(md, /SCRAPEWRIGHT_API_KEY/);
  });
});
