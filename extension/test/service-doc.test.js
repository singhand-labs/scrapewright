const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateExampleFromSchema, schemaFieldsTable, generateServiceMarkdown, buildCurlExamples } = require('../lib/service-doc');

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

describe('buildCurlExamples', () => {
  const ex = buildCurlExamples({
    base: 'http://192.168.1.5:8765/api/v1',
    apiKey: 'dev-key',
    serviceName: 'ai',
    sampleInput: { q: 'hi' }
  });

  it('unix dialect: multiline continuations, single-quoted JSON body', () => {
    assert.match(ex.unix.execute,
      /curl -X POST http:\/\/192\.168\.1\.5:8765\/api\/v1\/services\/ai\/execute \\/);
    assert.ok(ex.unix.execute.includes("-d '{\"input\":{\"q\":\"hi\"}}'"),
      'single-quoted compact JSON body, got: ' + ex.unix.execute);
    assert.ok(ex.unix.execute.includes('-H "X-API-Key: dev-key" \\\n'),
      'EVERY continued line ends in a backslash — a bare newline splits the command (copied-curl bug present since the first markdown exporter)');
    assert.ok(!/[^\\\\]\n\s+-d /.test(ex.unix.execute.replace(/\\\\\n/g, '')),
      'no non-continued line may precede -d');
  });

  it('windows dialect: curl.exe one-liner with escaped double-quoted JSON', () => {
    // cmd/PowerShell treat single quotes differently — body must be a
    // double-quoted arg with inner quotes escaped.
    assert.ok(ex.windows.execute.startsWith('curl.exe '));
    assert.ok(!ex.windows.execute.includes('\\\n'),
      'no bash line continuations in the Windows dialect');
    assert.ok(ex.windows.execute.includes('-d "{\\"input\\":{\\"q\\":\\"hi\\"}}"'),
      'escaped double-quoted JSON body, got: ' + ex.windows.execute);
    assert.ok(ex.windows.execute.includes('"http://192.168.1.5:8765/api/v1/services/ai/execute"'));
  });

  it('windows dialect covers the GET endpoints too', () => {
    assert.ok(ex.windows.wait.includes('curl.exe') && ex.windows.wait.includes('/jobs/<jobId>/wait'));
    assert.ok(ex.windows.status.includes('curl.exe'));
    assert.ok(ex.windows.cancel.includes('curl.exe'));
    assert.ok(ex.windows.jobs.includes('curl.exe'));
    assert.ok(ex.windows.services.includes('curl.exe'));
  });
});

describe('generateServiceMarkdown with local IPs', () => {
  const svc = {
    name: 'ai',
    displayName: 'AI Service',
    targetUrl: 'https://example.com',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    sampleInput: { q: 'hello' },
    steps: []
  };

  it('lists every detected LAN address so agents can pick a reachable base URL', () => {
    const md = generateServiceMarkdown(svc, 8765, { ips: ['192.168.1.5', '10.0.0.7'] });
    assert.match(md, /## Server addresses/);
    assert.ok(md.includes('http://192.168.1.5:8765'));
    assert.ok(md.includes('http://10.0.0.7:8765'));
    assert.ok(md.includes('http://localhost:8765'));
  });

  it('includes BOTH curl dialects for submit and wait', () => {
    const md = generateServiceMarkdown(svc, 8765, { ips: ['192.168.1.5'] });
    assert.ok(md.includes('curl -X POST'));
    assert.ok(md.includes('curl.exe'));
  });

  it('works without ips (backward compatible) and notes the localhost base', () => {
    const md = generateServiceMarkdown(svc, 8765);
    assert.match(md, /http:\/\/localhost:8765\/api\/v1/);
    assert.match(md, /## Server addresses/);
  });
});
