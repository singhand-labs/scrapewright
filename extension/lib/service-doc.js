// Generate a service's API documentation as Markdown — for sharing with humans
// and pasting into AI coding-agent contexts. Pure functions only (no chrome /
// document deps), so they're unit-testable and reusable from options.js.
//
// Content mirrors the in-app showApiDoc(svc) modal (options.js), plus field
// tables and an error catalog that the HTML version lacks.

const FENCE = '```';

// Build a concrete example object from a JSON Schema (examples[0] → type default).
// Moved here from options.js so options.js, showApiDoc, and the doc exporter
// share one implementation.
function generateExampleFromSchema(schema) {
  if (!schema || schema.type !== 'object') return {};
  const example = {};
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (prop.type === 'string') example[key] = prop.examples?.[0] || '';
    else if (prop.type === 'number' || prop.type === 'integer') example[key] = prop.examples?.[0] || 0;
    else if (prop.type === 'boolean') example[key] = prop.examples?.[0] || false;
    else if (prop.type === 'array') example[key] = [];
    else if (prop.type === 'object') example[key] = generateExampleFromSchema(prop);
    else example[key] = null;
  }
  return example;
}

// Render a JSON Schema {type:'object', properties, required} as a Markdown table.
function schemaFieldsTable(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return '_No fields defined._';
  }
  const required = new Set(schema.required || []);
  const rows = Object.entries(schema.properties).map(([key, prop]) => {
    const type = prop.type || 'any';
    const req = required.has(key) ? 'yes' : 'no';
    // Escape pipe + collapse newlines so the table cell stays single-line.
    const desc = (prop.description || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    return `| \`${key}\` | ${type} | ${req} | ${desc} |`;
  });
  return ['| Field | Type | Required | Description |',
          '|--------|------|----------|-------------|',
          ...rows].join('\n');
}

// Full Markdown API doc for a service. `port` is a parameter (caller resolves
// it via GET_SERVER_PORT) so this stays pure / testable.
function generateServiceMarkdown(svc, port) {
  const apiKey = 'dev-key';
  const base = `http://localhost:${port}/api/v1`;
  const execUrl = `${base}/services/${svc.name}/execute`;
  const sampleInput = svc.sampleInput || generateExampleFromSchema(svc.inputSchema);
  const sampleOutput = generateExampleFromSchema(svc.outputSchema);
  const displayName = svc.displayName || svc.name;
  const desc = svc.userDescription || `Scraping service targeting ${svc.targetUrl}`;

  const h = (key) => `-H "X-API-Key: ${apiKey}"`;
  const curlExec = `curl -X POST ${execUrl} \\\n  -H "Content-Type: application/json" \\\n  ${h()}\n  -d '${JSON.stringify({ input: sampleInput })}'`;
  const curlWait = `curl "${base}/jobs/<jobId>/wait?timeout=120" \\\n  ${h()}`;
  const curlStatus = `curl ${base}/jobs/<jobId> \\\n  ${h()}`;
  const curlCancel = `curl -X POST ${base}/jobs/<jobId>/cancel \\\n  ${h()}`;
  const curlJobs = `curl ${base}/jobs \\\n  ${h()}`;
  const curlServices = `curl ${base}/services \\\n  ${h()}`;

  const submitResp = JSON.stringify({ success: true, jobId: '<jobId>', status: 'queued', queuePosition: 1 }, null, 2);
  const completedResp = JSON.stringify({ success: true, job: { id: '<jobId>', status: 'completed', result: sampleOutput, error: null } }, null, 2);
  const failedResp = JSON.stringify({ success: true, job: { id: '<jobId>', status: 'failed', result: null, error: 'ELEMENT_NOT_FOUND: .item' } }, null, 2);
  const exampleBody = JSON.stringify({ input: sampleInput }, null, 2);

  const stepsSection = Array.isArray(svc.steps) && svc.steps.length
    ? svc.steps.map((s, i) => `${i + 1}. **${s.name || s.id}** → \`${s.onSuccess}\`${s.condition ? ` _(condition: \`${s.condition}\`)_` : ''}`).join('\n')
    : '_No steps defined._';

  const errorTable = [
    '| Error | Meaning | Auto-fixed? |',
    '|-------|---------|-------------|',
    '| `ELEMENT_NOT_FOUND: <selector>` | Element not found / wait timed out | Yes — LLM regenerates the step script |',
    '| `SCRIPT_ERROR: ...` | Step script threw or is empty | Yes — LLM regenerates |',
    '| `LOGIN_REQUIRED` | Page appears to require login | No — log in manually, then retry |',
    '| `SCRIPT_TIMEOUT` | Step exceeded `config.timeoutMs` | Retried up to `config.maxRetries` |',
    '| `STEP_NOT_FOUND` | Step graph followed a missing id | Fails (fix the step chain) |',
    '| `CONTENT_SCRIPT_NOT_READY` | Content script not injected in time | Retried |'
  ].join('\n');

  return `# ${displayName}

> ${desc}

- **Service name (route):** \`${svc.name}\`
- **Target URL:** ${svc.targetUrl}
- **Base URL:** \`${base}\`

## Authentication

Every request requires the \`X-API-Key\` header. The default key is \`dev-key\`; production deployments override it with the \`SCRAPEWRIGHT_API_KEY\` environment variable on the host process.

${FENCE}
Content-Type: application/json
X-API-Key: ${apiKey}
${FENCE}

## Endpoint

${FENCE}
POST ${execUrl}
${FENCE}

Execution is **asynchronous**: submitting a job returns a \`jobId\` immediately; poll or long-poll for the result.

## Request

### Input fields

${schemaFieldsTable(svc.inputSchema)}

### Example request body

${FENCE}json
${exampleBody}
${FENCE}

### Submit job (curl)

${FENCE}bash
${curlExec}
${FENCE}

### Response (202 Accepted)

${FENCE}json
${submitResp}
${FENCE}

## Wait for result (blocking)

${FENCE}
GET ${base}/jobs/<jobId>/wait?timeout=120
${FENCE}

Long-polls until the job finishes. \`?timeout=N\` is in seconds (max 300, default 120). On timeout the current status is returned with \`timedOut: true\`.

${FENCE}bash
${curlWait}
${FENCE}

## Result

### Output fields

${schemaFieldsTable(svc.outputSchema)}

### Completed response

${FENCE}json
${completedResp}
${FENCE}

### Failed response

${FENCE}json
${failedResp}
${FENCE}

## Other endpoints

| Action | Method & path |
|--------|---------------|
| Check status | \`GET ${base}/jobs/<jobId>\` |
| Cancel (queued only) | \`POST ${base}/jobs/<jobId>/cancel\` |
| List jobs | \`GET ${base}/jobs\` |
| List services | \`GET ${base}/services\` |

${FENCE}bash
# status
${curlStatus}
# cancel (queued jobs only)
${curlCancel}
# list jobs
${curlJobs}
# list services
${curlServices}
${FENCE}

## Error types

${errorTable}

## Execution flow (steps)

${stepsSection}
`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateExampleFromSchema, schemaFieldsTable, generateServiceMarkdown };
} else if (typeof window !== 'undefined') {
  window.generateExampleFromSchema = generateExampleFromSchema;
  window.schemaFieldsTable = schemaFieldsTable;
  window.generateServiceMarkdown = generateServiceMarkdown;
}
