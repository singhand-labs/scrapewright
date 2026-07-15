const SCRIPT_DSL_GUIDE = `You are writing JavaScript code for Scrapewright, a web scraping agent.

CRITICAL RULES:
1. Your code runs inside a sandboxed iframe (isolated from the target page). You CANNOT use document.querySelector, document.querySelectorAll, or any direct DOM access.
2. The ONLY way to interact with the target page is through the following async API functions:
3. $() and $list() return PLAIN DATA OBJECTS { tagName, textContent, ... }, NOT DOM Elements. You CANNOT call .closest(), .parentElement, .children, .querySelector(), .getElementsByClassName(), or any DOM method on them. Only the listed properties (tagName, id, className, textContent, value, href, src, checked, disabled) are available. To find a parent or related element, use a different CSS selector.

AVAILABLE API FUNCTIONS:
- $(selector): Wait up to 30s for element to appear, return { tagName, id, className, textContent, value, href, src, checked, disabled }. THROWS if element is not found within 30s. IMPORTANT: This returns a plain data object, NOT a DOM Element — no .closest(), .parentElement, or any DOM methods.
- $exists(selector, timeoutMs?): Check if a VISIBLE element exists (skips display:none / visibility:hidden / zero-size elements). Returns true immediately if found, false if not found within timeoutMs (default 5000ms). Use this for polling loops instead of $().
- $click(selector): Find element, click it. Returns true.
- $type(selector, text): Find element, set value, dispatch input/change events. Works on INPUT, TEXTAREA, and contenteditable elements. If selector matches a container, searches inside for an inputtable child. Returns true.
- $extract(selector, attribute?, timeoutMs?): Get textContent (or attribute if specified). Returns string. IMPORTANT: $extract waits only up to timeoutMs (default 5000ms, NOT 30s) for the element — if the selector is wrong it fails fast instead of burning the step's whole timeout. Prefer this over $() for reading known content; pass a longer timeoutMs only when you genuinely need to wait for content to render.
- $wait(selector, delayMs?): Wait for element (up to 30s via MutationObserver), then optional extra delay. Returns true. The selector is REQUIRED. If you only need a delay without waiting for an element, use 'await new Promise(r => setTimeout(r, ms))' instead.
- $check(selector, property): Read element property (e.g., 'checked', 'disabled'). Returns value.
- $openTab(url, functionBody): Open new tab at the given URL, wait for page load, then execute the function body (a string of JavaScript statements) in the new tab context. Returns whatever the function body returns. Use to scrape detail pages. Example: await $openTab(href, \`const title = await $extract('h1'); return { title };\`)
- $count(selector): Count elements matching selector (main document + same-origin iframes). Returns number. Do NOT use with :nth-child() to iterate — use $list() instead.
- $list(selector): Get ALL matching elements across main document + same-origin iframes. Returns array of { tagName, id, className, textContent, value, href, src, checked, disabled }. Use this for iterating multiple elements. Same data-object limitation as $().
- $waitForStable(selector, opts?): Poll the element's textContent (or opts.attr) every opts.interval ms (default 1500); return true after opts.stableChecks (default 2) consecutive unchanged + non-empty samples; false after opts.maxMs (default 20000). Prefer this for streaming-content completion (AI answers, live feeds) instead of guessing fragile loading-class selectors.

IMPORTANT: For waiting or polling scenarios (e.g., checking if AI has finished generating), do NOT use $() in a loop — it will throw after 30s if the element is not found. Instead:
- Use 'await new Promise(r => setTimeout(r, ms))' for fixed delays
- Use $exists(selector, timeoutMs) for quick existence checks in polling loops

IFRAME CONTENT:
Many websites load content dynamically inside iframes. All $ APIs automatically search inside same-origin iframes on the target page.
- The page snapshots include content from same-origin iframes — use selectors you see there
- $wait and $ APIs will find elements inside same-origin iframes automatically
- For $openTab detail pages, the snapshot includes the detail page content including any same-origin iframe content

INPUT DATA:
- The external program's input is available as the variable __input__ (an object).
- Example: await $type('#search', __input__.query);

STEP RESULTS (available in every step except the first):
- __lastResult__: The return value of the immediately preceding step (any type). Use for simple sequential flows.
- __stepResults__: Object mapping step IDs to their return values. Example: __stepResults__['2'] gives step 2's result. Use to access any prior step's data.

RETURN VALUE:
- Each step script must return a JSON-serializable value (string, number, boolean, object, array).
- This value becomes the step result and is passed to subsequent steps if needed.
- Use "return { ... }" to structure data for the final output.

CONDITIONS:
- The optional "condition" field of a step is evaluated ON the target page (not in sandbox), so it CAN use document.querySelector.
- Conditions determine whether the step runs or is skipped.

FLOW CONTROL (read carefully — getting this wrong is the #1 cause of broken services):
- Steps form a directed graph via onSuccess / onFailure step IDs.
- onSuccess: the step to run when THIS step succeeds (content ready / data extracted). Point it at the NEXT step. For a wait/poll step, point it at the extraction step that should run once the content is ready.
- onFailure: the step to run when this step fails or gives up (its condition is false, its retry budget is exhausted, or it returned { failed: true }). Usually 'TERMINATE' or an error-handling step.
- Use "TERMINATE" to end execution. Do NOT use "SELF" — it is no longer supported and will be rejected.
- POLLING / WAITING / ITERATING: a step that may need to repeat sets maxIterations>1 (e.g. 20-60) and returns a not-ready signal to retry itself. When it is done, it returns the extracted data (or { done: true }) and the orchestrator follows onSuccess to the next step.
  - Return { done: false } (or { ready: false }, { complete: false }, { generating: true }, { loading: true }) → the SAME step runs again, up to maxIterations times.
  - Return anything else (the real data, or { done: true }) → SUCCESS → orchestrator follows onSuccess.
  - Return { failed: true } (or { error: "message" }) → FAILURE → orchestrator follows onFailure.
- A step with maxIterations<=1 (the default) is a normal step: its result is pure data and ALWAYS follows onSuccess — it is never inspected for retry signals. Only set maxIterations>1 on steps that must retry.
- The system auto-detects back-edge loops and boosts maxIterations for their targets, but set it explicitly to be safe.
- The system has a global iteration limit (default: 50 total step executions) that prevents runaway loops.
- You do NOT need to handle navigation — the agent already opened the target URL.

EXAMPLE:
  await $type('input[name="q"]', __input__.query);
  await $click('button[type="submit"]');
  await $wait('.results', 2000);
  return {
    items: await $extract('.results')
  };

LIST ITEM ITERATION (use $list to get all matching elements):
  const items = await $list('li.item a.title');
  // $list returns array of { tagName, id, className, textContent, value, href, src, checked, disabled }
  const results = items.map(el => ({ title: el.textContent, href: el.href }));

ATTACHMENT ITERATION (use $list for elements that may be inside iframes):
  const links = await $list('div#attach a.ewb-enclosure');
  const attachments = links.map(el => ({ name: el.textContent, href: el.href }));

DO NOT use $count + :nth-child() loop to iterate elements — it breaks when elements span multiple iframes because $count sums across all documents but :nth-child() searches one document at a time.

DETAIL PAGE SCRAPING (use $openTab to scrape each item's detail page):
  const linkEl = await $('a.detail-link');
  const href = linkEl.href;
  const detail = await $openTab(href, \`
    await $wait('.detail-content', 3000);
    const title = await $extract('h1');
    const body = await $extract('.detail-content');
    return { title, body };
  \`);

AI CHAT / STREAMING RESPONSE (wait for content to finish generating):
  Create ONE wait step: onSuccess='extract-step' (the step that extracts the answer once ready), onFailure='TERMINATE', maxIterations=60. The wait step returns { done: false } while still generating, and { done: true } (or the extracted data) once finished — the orchestrator retries it up to maxIterations times, then follows onSuccess to extract. Do NOT use "SELF".

  CRITICAL: You MUST identify the correct completion signal. Check the page snapshot for specific loading/generating indicator elements and use their EXACT class names.
  The CORRECT approach is to check that a loading indicator DISAPPEARS (negative check):
    await new Promise(r => setTimeout(r, 3000));
    // Use ONLY specific class names from the page snapshot, NOT wildcard selectors
    const stillLoading = await $exists('.cosd-markdown-loading', 3000);
    return { done: !stillLoading };

  DO NOT check if the submit button EXISTS - on most AI chat sites the submit button is always visible regardless of generation state. Checking for submit button will cause premature {done: true}.
  DO NOT use wildcard attribute selectors like [class*="loading"] or [class*="generating"] - these match too many unrelated elements (lazy-load images, page placeholders, etc.) and cause infinite loops. Use ONLY specific class names found in the page snapshot.

  Alternative completion patterns:
    // Wait for a "stop generating" button to disappear
    const stopBtn = await $exists('.stop-generating-button', 2000);
    return { done: !stopBtn };
    // Wait for a completion status indicator to appear
    const hasComplete = await $exists('[data-status="COMPLETE"], .response-complete', 3000);
    return { done: !!hasComplete };

  IMPORTANT: Always use $exists() for polling - NEVER use $() in a loop. Use at least 3s delay between checks: await new Promise(r => setTimeout(r, 3000))

ROBUSTNESS RULES (MANDATORY — these prevent the most common silent failures):

1. TIME BUDGET: Every step has a HARD execution timeout (config.timeoutMs, default 30s). A step that runs longer is killed with SCRIPT_TIMEOUT and FAILS. NEVER write a single in-script loop that could exceed the timeout. For long waits, set maxIterations>1 and return { done: false } — each retry iteration is itself bounded by the same timeout and the orchestrator re-invokes the step. Keep each iteration's total sleep+poll well under the timeout.

2. CONTENT-STABILITY COMPLETION: A "done" signal must include CONTENT STABILITY, not just a loading class disappearing — a spinner can vanish while text is still streaming, yielding a truncated extraction. Prefer $waitForStable(selector) (returns true once the element's text stops changing). Or hand-roll: sample the text, sleep ~1.5s, sample again; done only when both samples are equal AND non-empty.

3. VERIFY AFTER INTERACTION: After a $click that is meant to change state (submit, toggle, expand, navigate), VERIFY the intended change happened before reporting done — read a distinguishing signal (results container appeared, attribute toggled, URL changed). If the change did not happen, return { done: false } so the step retries (requires maxIterations>1); do NOT proceed to extraction as if the click succeeded.

4. EXTRACTION MUST NOT RETURN EMPTY AS SUCCESS: An extraction step whose output feeds the final result must treat EMPTY output ('', null, [], or a required field missing) as NOT done — return { done: false } (with maxIterations>1) and retry until the content is present. Returning empty as success is the most common silent failure (the job reports success:true with garbage data).

5. OUTPUT SCHEMA CONFORMANCE (field names): The final extraction step's return object MUST use the EXACT field names declared in outputSchema.properties, and MUST include every field listed in outputSchema.required. Do NOT invent or rename fields. EXAMPLE: if outputSchema declares a field named "thinking", return { thinking: "..." } — NOT { thinkingProcess: "..." } or { think: "..." }. A field-name mismatch causes the job to be marked FAILED (REQUIRED_OUTPUT_MISSING) even when data was extracted, because external callers read the result by the schema's field names. ECHO-BACK: if outputSchema.required includes a field with the same name as an input field (e.g., question, query), the final return MUST include that field echoing the original input value (e.g., { question: __input__.question, ... }) — do NOT omit it just because it is not "extracted" from the page. Before writing the final return, list outputSchema.required and verify each one is present with the exact name.

ANNOTATION INTENT (use these hints verbatim — do not re-derive):

!!! SELECTOR FIDELITY RULE (CRITICAL — violating this is the #1 cause of broken scripts) !!!
Do NOT simplify, shorten, rewrite, or "improve" selectors from annotations. Use them VERBATIM (character for character, copy-paste into your code). The selector looks long because the page's DOM structure genuinely requires that path. "Simplifying" it to a shorter class-based selector WILL BREAK IT — the shortened version does not exist in the page DOM, causing permanent ELEMENT_NOT_FOUND or false negatives in $exists.
- CORRECT: const done = await $exists('div:nth-of-type(1) > div.\\n._chat-container_r2am5_1…i.cos-icon-copy');
- WRONG:   const done = await $exists('.cs-answer-hover-menu-container i.cos-icon-copy');  // ← invented, does not exist
If a selector contains nth-of-type, CSS module hashes (_xxxxx_N), or newlines, that is EXPECTED — copy it as-is.

CRITICAL: When an annotation has a selector AND a waitCondition, THAT selector is the user's hand-picked completion signal. The user chose it because they know it appears/disappears exactly when the content is ready. Use THAT selector — do NOT search the snapshot for a different loading indicator. This is far more reliable than guessing class names.
- waitCondition: appear → a poll step (maxIterations>1): return { done: await $exists(THE_ANNOTATED_SELECTOR) }. The annotated element appearing = done.
- waitCondition: disappear → a poll step (maxIterations>1): return { done: !await $exists(THE_ANNOTATED_SELECTOR) }. The annotated element vanishing = done.
- waitCondition: textStable → use $waitForStable(THE_ANNOTATED_SELECTOR) to confirm content stopped changing.
- outputField: X on an extract → $extract(THE_ANNOTATED_SELECTOR) and include key X in the return object. Direct mapping; do not rename or use a different selector.
- inputField: X on an input → $type(THE_ANNOTATED_SELECTOR, __input__.X).
- purpose: toggle/submit/navigate on a click → $click(THE_ANNOTATED_SELECTOR) then VERIFY the state changed (per ROBUSTNESS RULE 3).
- purpose: check-login → if the element is present, return { done:true, loginRequired:true } so the orchestrator can surface LOGIN_REQUIRED.`;

const ANNOTATION_PURPOSES = [
  { value: 'submit', label: '提交（submit）' },
  { value: 'toggle', label: '切换状态（如深度思考）' },
  { value: 'navigate', label: '导航/翻页' },
  { value: 'expand', label: '展开/折叠' },
  { value: 'wait-for-load', label: '等待加载完成' },
  { value: 'check-login', label: '检测登录态' },
  { value: 'verify-state', label: '验证状态' },
  { value: 'other', label: '其他（自由输入）…' }
];
const WAIT_CONDITIONS = [
  { value: 'appear', label: '元素出现' },
  { value: 'disappear', label: '元素消失' },
  { value: 'textStable', label: '文本停止变化' },
  { value: 'attributeChange', label: '属性变化' }
];

// Build the annotations block fed to the LLM. Emits intent fields only when
// present so legacy annotations (without intent) produce identical output.
// Each annotation with a selector gets a verbatim-use directive so the LLM
// does not rewrite/simplify it.
function buildAnnotationsText(annotations) {
  return (annotations || []).map((a, i) => {
    const tag = `ANNOTATION[${i}]`;
    const parts = ['- ' + tag + ' type: ' + a.type];
    if (a.text) parts.push('text: "' + a.text + '"');
    if (a.selector) parts.push('selector: ' + a.selector + '  ← USE THIS EXACT SELECTOR VERBATIM IN YOUR CODE (do NOT simplify/rewrite)');
    if (a.domPath) parts.push('domPath: ' + a.domPath);
    if (a.purpose) parts.push('purpose: ' + a.purpose);
    if (a.waitCondition) parts.push('waitCondition: ' + a.waitCondition + ' (USER-MARKED completion signal — use THIS selector, not a different loading indicator)');
    if (a.outputField) parts.push('outputField: ' + a.outputField + ' (extract using the selector above into this field)');
    if (a.inputField) parts.push('inputField: ' + a.inputField + ' (type into the selector above using __input__.' + a.inputField + ')');
    return parts.join(', ');
  }).join('\n');
}

// Post-generation check: verify that the LLM-generated script actually uses the
// annotated selectors verbatim. Returns { ok, mismatches: [{annotated, found}] }.
// "Uses" = the annotated selector string appears as a substring of the script.
// This catches the #1 failure mode: LLM rewriting/simplifying a selector that
// then doesn't match the page DOM.
function checkSelectorFidelity(script, annotations) {
  if (!script || !annotations || !annotations.length) return { ok: true, mismatches: [] };
  const mismatches = [];
  for (const a of annotations) {
    if (!a.selector) continue;
    // Normalize: strip whitespace/newlines from both for comparison
    const norm = s => (s || '').replace(/\s+/g, '').replace(/\\n/g, '');
    const annotatedNorm = norm(a.selector);
    const scriptNorm = norm(script);
    if (annotatedNorm.length > 10 && !scriptNorm.includes(annotatedNorm)) {
      mismatches.push({
        selector: a.selector,
        type: a.type,
        outputField: a.outputField,
        waitCondition: a.waitCondition,
        suggestion: 'The script does not contain this annotated selector. The LLM may have rewritten/simplified it, which typically breaks the selector. Use the verbatim annotated selector.'
      });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function parseSchemaFields(schema) {
  return Object.keys(schema.properties || {}).map(k => `${k} (${schema.properties[k].type || '?'})`).join(', ') || 'none';
}

// Single source of truth for the per-step timeout wording given to the LLM.
// Every generation/fix prompt calls this so generation, auto-fix, test, and deploy
// all agree on the ceiling (default 30s = deploy config.timeoutMs).
function buildTimeoutGuidance(timeoutMs) {
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
  const seconds = Math.floor(t / 1000);
  const iterBudget = Math.max(3, Math.floor((t * 0.75) / 3000));
  const iterSeconds = Math.min(iterBudget * 3, Math.floor(seconds * 0.75));
  return {
    ceilingMs: t,
    text: `CRITICAL TIME CONSTRAINT:
Each step script has a HARD execution timeout of ${seconds}s (${t}ms). The script MUST return before ${seconds}s; otherwise the executor kills it with SCRIPT_TIMEOUT and the step FAILS.
- NEVER write a single in-script loop that runs longer than ${seconds}s. For long waits, set maxIterations>1 and return { done: false } — each retry iteration is itself bounded by this same ${seconds}s ceiling and the orchestrator re-invokes the step.
- For polling inside one iteration: use at most ${iterBudget} checks with >=3s delays (total ~${iterSeconds}s), staying under ${seconds}s.
- Use $exists(selector, 1000) for quick existence checks; use $wait(selector) for one-shot waits up to 30s.
- If a logical unit genuinely needs longer than ${seconds}s, split it across retry iterations (maxIterations>1 + { done: false }) — do NOT raise the timeout by sleeping longer.`
  };
}

function buildIORenderString(inputSchema, outputSchema) {
  return 'Input: ' + parseSchemaFields(inputSchema || {}) + ' | Output: ' + parseSchemaFields(outputSchema || {});
}

function validateTestInput(inputStr, schemaStr, testInputStr) {
  try {
    return {
      valid: true,
      inputSchema: JSON.parse(inputStr),
      outputSchema: JSON.parse(schemaStr),
      testInput: JSON.parse(testInputStr)
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function cleanLLMResponse(raw) {
  let text = raw.trim();
  if (!text) return text;

  // Extract code from markdown fences — robust to the ways LLMs actually emit code:
  //   - closed:    ```js\ncode\n```
  //   - UNCLOSED:  ```js\ncode            (LLM forgot the closing fence — very common, previously broke auto-fix)
  //   - no newline after marker, optional ws/tab, \r\n — all tolerated
  // Takes the last non-empty fenced block.
  const allFences = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)(?:\r?\n?```|$)/g)];
  const withContent = allFences.filter(m => m[1].trim());
  if (withContent.length) {
    return withContent[withContent.length - 1][1].trim();
  }

  // No code fences — check if the entire response looks like JSON or code
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('//') ||
      text.startsWith('const ') || text.startsWith('let ') || text.startsWith('async ') || text.startsWith('await ')) {
    return text;
  }

  // Try to find JSON or code embedded in explanatory text
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[0].trim();
  }

  return text;
}

function buildResearchPrompt(url, description, html, text) {
  return `I need to create a web scraping script for this page.\n\nURL: ${url}\nRequirements: ${description}\n\nPage HTML (truncated):\n${html}\n\nPage text:\n${text}\n\nPlease analyze the page and return a JSON object with:\n- findings: string describing what you found\n- needsAnnotation: boolean, true if you need user to identify specific elements\n- draftScript: string with JavaScript code using $, $click, $type, $extract, $wait, $check, $openTab APIs\n- inputSchema: JSON Schema object describing the script's input parameters\n- outputSchema: JSON Schema object describing the script's output structure\n- sampleInput: a JSON object with example values matching inputSchema`;
}

function buildFixPrompt(error, url, description, script, html, text, annotations, feedback) {
  let prompt = `The following scraping script failed with error: ${error}\n\nTarget URL: ${url}\nOriginal requirement: ${description}\n\nCurrent script:\n${script}\n\nPage HTML (truncated):\n${html}\n\nPage text:\n${text}\n\nAnnotations: ${JSON.stringify(annotations)}`;
  if (feedback) prompt += '\n\nUser feedback: ' + feedback;
  prompt += '\n\nPlease fix the script. Return ONLY the fixed JavaScript code, no explanation.';
  return prompt;
}

// --- framework guardrails (WS3) ---------------------------------------------

// Coarse static estimate of a script's single-iteration wall-clock delay from
// literal setTimeout delays + explicit $exists/$wait timeouts. Conservative:
// dynamic delays (setTimeout(r, variable)) are invisible. Used to WARN only.
function estimateScriptTimeBudget(script) {
  if (!script) return 0;
  let total = 0;
  let m;
  const reSleep = /setTimeout\s*\(\s*[^,)]+\s*,\s*(\d+)\s*\)/g;
  while ((m = reSleep.exec(script)) !== null) total += parseInt(m[1], 10);
  const reWait = /\$(?:exists|wait)\s*\([^)]*,\s*(\d+)\s*\)/g;
  while ((m = reWait.exec(script)) !== null) total += parseInt(m[1], 10);
  return total;
}

// Validate external input against a service's inputSchema. {valid} or {valid:false, code, error}.
// Used at the host/execute boundary (WS2.3) so bad input is rejected before queueing.
const MAX_INPUT_CHARS = 500000;   // ~500KB overall payload guard (queue-abuse prevention)
const MAX_INPUT_STRING_LEN = 100000; // 100KB per string field
function validateInputAgainstSchema(input, inputSchema) {
  if (input === null || input === undefined) return { valid: false, code: 400, error: 'input is required' };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, code: 400, error: 'input must be a JSON object' };
  }
  // Overall payload size guard (rejects oversized inputs that would abuse the serial queue).
  let size = 0;
  try { size = JSON.stringify(input).length; } catch { size = 0; }
  if (size > MAX_INPUT_CHARS) {
    return { valid: false, code: 400, error: `Input too large (${size} chars > ${MAX_INPUT_CHARS})` };
  }
  // Per-field string length cap.
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v === 'string' && v.length > MAX_INPUT_STRING_LEN) {
      return { valid: false, code: 400, error: `Input '${k}' too long (${v.length} chars > ${MAX_INPUT_STRING_LEN})` };
    }
  }
  const required = (inputSchema && inputSchema.required) || [];
  const props = (inputSchema && inputSchema.properties) || {};
  for (const k of required) {
    if (input[k] === undefined || input[k] === null || input[k] === '') {
      return { valid: false, code: 400, error: `Missing required input: ${k}` };
    }
    const want = props[k] && props[k].type;
    if (want) {
      const got = Array.isArray(input[k]) ? 'array' : typeof input[k];
      if (got !== want) {
        return { valid: false, code: 400, error: `Input '${k}' must be ${want}, got ${got}` };
      }
    }
  }
  return { valid: true };
}

// Validate a job's final result against outputSchema.required. A required field
// is "missing" if '', null, undefined, or empty array. {ok} or {ok:false, missing, code}.
// Used at job completion (WS2.2) and the test step (WS4.2).
function validateOutputAgainstSchema(finalResult, outputSchema) {
  const data = finalResult && typeof finalResult === 'object' && 'data' in finalResult ? finalResult.data : finalResult;
  if (!outputSchema || !Array.isArray(outputSchema.required) || outputSchema.required.length === 0) {
    return { ok: true };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, missing: outputSchema.required.slice(), code: 'REQUIRED_OUTPUT_MISSING' };
  }
  const missing = outputSchema.required.filter(k =>
    data[k] === undefined || data[k] === null || data[k] === '' ||
    (Array.isArray(data[k]) && data[k].length === 0)
  );
  return missing.length === 0
    ? { ok: true }
    : { ok: false, missing, code: 'REQUIRED_OUTPUT_MISSING' };
}

function validateSteps(steps) {
  if (!Array.isArray(steps)) return { valid: false, error: 'steps must be an array' };
  if (steps.length === 0) return { valid: false, error: 'steps cannot be empty' };

  const ids = new Set();
  const warnings = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.id) return { valid: false, error: `Step ${i + 1} missing id` };
    const isPendingAnnotation = step.needsAnnotation === true && (!step.script || step.script.trim() === '' || step.script.trim() === '// PENDING_ANNOTATION');
    const hasScript = step.script && step.script.trim() !== '';
    if (!hasScript && !isPendingAnnotation) return { valid: false, error: `Step ${i + 1} (${step.id}) missing script` };
    if (ids.has(step.id)) return { valid: false, error: `Duplicate step id: ${step.id}` };
    ids.add(step.id);
    if (step.onSuccess && typeof step.onSuccess !== 'string') {
      return { valid: false, error: `Step ${step.id} onSuccess must be a string` };
    }
    if (step.onFailure && typeof step.onFailure !== 'string') {
      return { valid: false, error: `Step ${step.id} onFailure must be a string` };
    }
    if (step.maxIterations !== undefined && (!Number.isInteger(step.maxIterations) || step.maxIterations < 1)) {
      return { valid: false, error: `Step ${step.id} maxIterations must be >= 1` };
    }
    // WS3.1: warn if a step's literal delays likely exceed the timeout ceiling.
    const budget = estimateScriptTimeBudget(step.script);
    if (budget > 30000) {
      warnings.push(`Step ${step.id}: estimated single-iteration delay (~${budget}ms) exceeds the 30000ms timeout. Split the wait across retry iterations (set maxIterations>1 and return { done: false }).`);
    }
  }
  return warnings.length ? { valid: true, warnings } : { valid: true };
}

function validateForExecution(steps) {
  const base = validateSteps(steps);
  if (!base.valid) return base;
  const warnings = base.warnings ? base.warnings.slice() : [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const hasRealScript = step.script && step.script.trim() !== '' && step.script.trim() !== '// PENDING_ANNOTATION';
    if (!hasRealScript) {
      return {
        valid: false,
        error: `Step ${i + 1} (${step.id}) has a pending annotation placeholder. Annotate it before deploying.`
      };
    }
    // WS3.2: a poll/wait step (maxIterations>1) must emit a retry/done signal so
    // it can actually loop and terminate. Without one it runs once and advances
    // (no retry) — the most common silent misconfiguration under Model A.
    if ((step.maxIterations ?? 1) > 1) {
      const s = step.script || '';
      const hasSignal = /(done|ready|complete|finished|responseReady|generating|loading)\s*:/.test(s);
      if (!hasSignal) {
        warnings.push(`Step ${step.id} has maxIterations>1 (a poll/wait step) but its script returns no retry/done signal such as { done: false }. It will run once and advance without retrying — likely a misconfiguration.`);
      }
    }
  }
  const chain = validateChain(steps);
  if (!chain.valid) return chain;
  return warnings.length ? { valid: true, warnings } : { valid: true };
}

// Walks the onSuccess/onFailure pointer graph from the first step and verifies
// every pointer resolves to a real step id (or a valid sentinel). Catches the
// "manually-added step never runs" bug class: a step sitting in the array with
// no predecessor pointing to it is silent dead code in the orchestrator, which
// follows pointers rather than array order. Called from validateForExecution
// (deploy-time) and ServiceRegistry.save() (every persistence path).
function validateChain(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { valid: false, error: 'steps cannot be empty' };
  }
  const first = steps[0];
  if (!first || !first.id) {
    return { valid: false, error: 'first step must have an id' };
  }

  const ids = new Set(steps.map(s => s && s.id).filter(Boolean));

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || !step.id) {
      return { valid: false, error: `Step ${i + 1} must have an id` };
    }
    const checkPointer = (field) => {
      const target = step[field];
      if (!target || target === 'TERMINATE') return null;
      if (target === 'SELF') {
        // SELF was the old self-loop sentinel. Under Model A it is rejected loudly
        // (rather than silently treated as a literal step id → STEP_NOT_FOUND at
        // runtime). Polling is now maxIterations>1 + {done:false}; onSuccess points
        // to the next step. This surfaces any legacy SELF config at save/deploy.
        return `Step "${step.id}" uses ${field}:'SELF', which is no longer supported. For a poll/wait step, set maxIterations>1, return { done: false } to retry, and point ${field} to the next step id (or TERMINATE).`;
      }
      if (!ids.has(target)) {
        return `Step "${step.id}" ${field} points to "${target}", which doesn't exist`;
      }
      return null;
    };
    const err = checkPointer('onSuccess') || checkPointer('onFailure');
    if (err) return { valid: false, error: err };
  }

  const reachable = new Set();
  const queue = [first.id];
  while (queue.length > 0) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = steps.find(s => s.id === id);
    if (!step) continue;
    for (const target of [step.onSuccess, step.onFailure]) {
      if (target && target !== 'TERMINATE' && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const step of steps) {
    if (!reachable.has(step.id)) {
      return {
        valid: false,
        error: `Step "${step.id}" is unreachable from step "${first.id}". No predecessor's onSuccess/onFailure points to it.`
      };
    }
  }

  return { valid: true };
}

function buildStepIORenderString(steps) {
  if (!steps || steps.length === 0) return 'No steps';
  return steps.map((s, i) => `${i + 1}. ${s.name || s.id} → ${s.onSuccess}`).join('\n');
}

function appendGlobalContextBlock(baseSystemContent, description) {
  const desc = (description || '').trim();
  if (!desc) return baseSystemContent;
  return baseSystemContent + '\n\n[GLOBAL CONTEXT]\nThe user\'s original scraping requirement (apply to all your work):\n"' + desc + '"\n[/GLOBAL CONTEXT]';
}

function buildAutoFixSystemMessage(description) {
  const base = 'You are a web scraping script fixer. Return only JavaScript code. Do not change the step flow logic.';
  const desc = (description || '').trim();
  if (!desc) return base;
  return base + '\n\n[GLOBAL CONTEXT]\nThe user\'s original scraping requirement:\n"' + desc + '"\n[/GLOBAL CONTEXT]';
}

function buildRequirementsBlock(requirements) {
  const r = requirements || {};
  const inputParams = (r.inputParams || '').trim();
  const pageOps = (r.pageOps || '').trim();
  const outputStruct = (r.outputStruct || '').trim();
  return [
    '## User Requirements',
    '- Input parameters: ' + (inputParams || '(none specified)'),
    '- Page operations & data to collect: ' + (pageOps || '(unspecified)'),
    '- Output structure: ' + (outputStruct || '(unspecified — infer)')
  ].join('\n');
}

function fillEntryUrlDefaults(steps, defaultUrl) {
  if (!Array.isArray(steps) || !defaultUrl) return steps || [];
  return steps.map(step => {
    if (!step || step.entryUrl) return step;
    return { ...step, entryUrl: defaultUrl };
  });
}

// Default retry budget injected by normalizeStepTopology when a step clearly
// intends to poll but forgot to set maxIterations. Conservative: enough for most
// waits, low enough that a genuinely stuck loop is still bounded quickly.
const DEFAULT_POLL_MAX_ITERATIONS = 30;

// Deterministic topology heal (no LLM). Runs after generation and at the start
// of each auto-fix iteration. A step whose script emits a reserved poll signal
// (done/ready/complete/finished/responseReady/generating/loading as a returned
// key) but left maxIterations UNSET was intended to poll — generation couldn't
// know the page needed it. Boost it instead of asking the LLM again (it already
// failed to set it once). Detection keys on the reserved KEY (any value form —
// literal, computed like !stillLoading, or a call), because under Model A those
// keys are reserved polling signals. Over-detection is harmless: a higher cap is
// simply unused if the step's result never carries a top-level not-ready signal.
// Explicit maxIterations (including 1) is always respected.
function normalizeStepTopology(steps) {
  const changed = [];
  if (!Array.isArray(steps)) return { changed };
  const pollSignal = /\b(done|ready|complete|finished|responseReady|generating|loading)\s*:/;
  for (const step of steps) {
    if (!step) continue;
    if (step.maxIterations != null) continue;          // respect explicit (null/undefined only)
    if (pollSignal.test(step.script || '')) {
      step.maxIterations = DEFAULT_POLL_MAX_ITERATIONS;
      changed.push({ id: step.id, maxIterations: DEFAULT_POLL_MAX_ITERATIONS });
    }
  }
  return { changed };
}

function appendStepWithChainLink(steps, newStep) {
  if (steps.length > 0) {
    const prevLast = steps[steps.length - 1];
    if (prevLast && prevLast.onSuccess === 'TERMINATE') {
      prevLast.onSuccess = newStep.id;
    }
  }
  steps.push(newStep);
  return steps;
}

// Removes the step with the given id and rewires any inbound pointers to
// skip over it. The deleted step's own onSuccess becomes the new target for
// any predecessor that pointed at it (or its onFailure if it had no forward
// onSuccess). Without this rewiring, splice() leaves dangling onSuccess/
// onFailure pointers — the predecessor tries to follow them, hits
// STEP_NOT_FOUND, and the service dies at runtime. Pair with validateChain
// to verify the post-delete chain is still traversal-valid.
function removeStepWithRelink(steps, id) {
  const idx = steps.findIndex(s => s && s.id === id);
  if (idx < 0) return steps;
  const removed = steps[idx];
  const successor = (removed.onSuccess === 'TERMINATE' || !removed.onSuccess)
    ? (removed.onFailure || 'TERMINATE')
    : removed.onSuccess;  for (const step of steps) {
    if (step === removed) continue;
    if (step.onSuccess === id) step.onSuccess = successor;
    if (step.onFailure === id) step.onFailure = successor;
  }
  steps.splice(idx, 1);
  return steps;
}

// Rewrites onSuccess pointers so the chain topology matches the current
// array order. Used after array-only reorderings (btn-step-up/down) that
// would otherwise desync the chain from the display.
//
// The orchestrator starts at steps[0] and follows onSuccess. If a user
// moves a step into index 0 without relinking, that step's onSuccess
// (often 'TERMINATE' if it was the tail) terminates execution after one
// step — exactly the "only my new step runs" bug.
//
// Rules:
// - Each non-last step gets onSuccess = next array step's id
// - Last step gets onSuccess = 'TERMINATE'
// - onFailure is left alone — branch/error paths are independent of array order
//   (poll/wait steps express retry via maxIterations + {done:false}, not via a
//   self-pointing onSuccess, so there is no self-loop pointer to preserve.)
function relinkChainToArray(steps) {
  if (!Array.isArray(steps)) return steps;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || !step.id) continue;
    step.onSuccess = (i === steps.length - 1) ? 'TERMINATE' : steps[i + 1].id;
  }
  return steps;
}

const STEP_TEMPLATES = [
  {
    id: 'extract-list',
    name: 'Extract List',
    description: 'Extract a list of items from the current page',
    steps: [
      {
        id: 'extract',
        name: 'Extract Items',
        script: `const text = await $extract('.item-list') || await $extract('body');\nreturn { itemsText: text };`,
        condition: 'document.querySelectorAll(".item").length > 0',
        onSuccess: 'TERMINATE',
        onFailure: 'TERMINATE',
        maxIterations: 1
      }
    ]
  },
  {
    id: 'pagination',
    name: 'Pagination Loop',
    description: 'Extract items and click next page until no more pages',
    steps: [
      {
        id: 'extract',
        name: 'Extract Page Items',
        script: `const text = await $extract('.item-list') || '';\nreturn { pageItemsText: text };`,
        condition: 'document.querySelectorAll(".item").length > 0',
        onSuccess: 'next-page',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'next-page',
        name: 'Click Next Page',
        script: `await $click('.next-page');\nawait $wait('.item', 2000);`,
        condition: 'document.querySelector(".next-page") !== null',
        onSuccess: 'extract',
        onFailure: 'TERMINATE',
        maxIterations: 10
      }
    ]
  },
  {
    id: 'form-submit',
    name: 'Form Submit',
    description: 'Fill a form and submit it',
    steps: [
      {
        id: 'fill-form',
        name: 'Fill Form Fields',
        script: `await $type('input[name="q"]', __input__.query || '');`,
        onSuccess: 'submit',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'submit',
        name: 'Submit Form',
        script: `await $click('button[type="submit"]');\nawait $wait('.results', 3000);`,
        onSuccess: 'extract-results',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'extract-results',
        name: 'Extract Results',
        script: `const text = await $extract('.results') || '';\nreturn { resultsText: text };`,
        onSuccess: 'TERMINATE',
        onFailure: 'TERMINATE',
        maxIterations: 1
      }
    ]
  },
  {
    id: 'login-then-scrape',
    name: 'Login Then Scrape',
    description: 'Log in and then perform scraping',
    steps: [
      {
        id: 'login',
        name: 'Perform Login',
        script: `await $type('#username', __input__.username || '');\nawait $type('#password', __input__.password || '');\nawait $click('#login-btn');\nawait $wait('.dashboard', 5000);`,
        condition: 'document.querySelector("#login-btn") !== null',
        onSuccess: 'scrape',
        onFailure: 'TERMINATE',
        maxIterations: 1
      },
      {
        id: 'scrape',
        name: 'Scrape Data',
        script: `return await $extract('.dashboard') || '';`,
        onSuccess: 'TERMINATE',
        onFailure: 'TERMINATE',
        maxIterations: 1
      }
    ]
  }
];

function getStepTemplates() {
  return STEP_TEMPLATES;
}

function applyTemplate(templateId) {
  const tmpl = STEP_TEMPLATES.find(t => t.id === templateId);
  if (!tmpl) return null;
  return tmpl.steps.map(step => ({ ...step }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSchemaFields, buildTimeoutGuidance, estimateScriptTimeBudget, validateInputAgainstSchema, validateOutputAgainstSchema, buildIORenderString, validateTestInput, cleanLLMResponse, buildResearchPrompt, buildFixPrompt, validateSteps, validateForExecution, validateChain, buildStepIORenderString, getStepTemplates, applyTemplate, STEP_TEMPLATES, SCRIPT_DSL_GUIDE, appendGlobalContextBlock, buildAutoFixSystemMessage, fillEntryUrlDefaults, normalizeStepTopology, DEFAULT_POLL_MAX_ITERATIONS, appendStepWithChainLink, removeStepWithRelink, relinkChainToArray, ANNOTATION_PURPOSES, WAIT_CONDITIONS, buildAnnotationsText, checkSelectorFidelity, buildRequirementsBlock };
} else if (typeof window !== 'undefined') {
  window.buildTimeoutGuidance = buildTimeoutGuidance;
  window.estimateScriptTimeBudget = estimateScriptTimeBudget;
  window.validateInputAgainstSchema = validateInputAgainstSchema;
  window.validateOutputAgainstSchema = validateOutputAgainstSchema;
  window.getStepTemplates = getStepTemplates;
  window.applyTemplate = applyTemplate;
  window.STEP_TEMPLATES = STEP_TEMPLATES;
  window.SCRIPT_DSL_GUIDE = SCRIPT_DSL_GUIDE;
  window.appendGlobalContextBlock = appendGlobalContextBlock;
  window.buildAutoFixSystemMessage = buildAutoFixSystemMessage;
  window.buildRequirementsBlock = buildRequirementsBlock;
  window.fillEntryUrlDefaults = fillEntryUrlDefaults;
  window.normalizeStepTopology = normalizeStepTopology;
  window.DEFAULT_POLL_MAX_ITERATIONS = DEFAULT_POLL_MAX_ITERATIONS;
  window.validateForExecution = validateForExecution;
  window.validateChain = validateChain;
  window.appendStepWithChainLink = appendStepWithChainLink;
  window.removeStepWithRelink = removeStepWithRelink;
  window.relinkChainToArray = relinkChainToArray;
  window.ANNOTATION_PURPOSES = ANNOTATION_PURPOSES;
  window.WAIT_CONDITIONS = WAIT_CONDITIONS;
  window.buildAnnotationsText = buildAnnotationsText;
}

// Service worker has no `window` (global is `self`). Expose the same helpers
// so lib/service-registry.js can resolve validateChain when saving from the
// background context. (Top-level function declarations are already on self,
// but be explicit so this survives a future refactor to arrow-function consts.)
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.validateChain = validateChain;
  self.validateForExecution = validateForExecution;
  self.validateInputAgainstSchema = validateInputAgainstSchema;
  self.validateOutputAgainstSchema = validateOutputAgainstSchema;
  self.appendStepWithChainLink = appendStepWithChainLink;
  self.removeStepWithRelink = removeStepWithRelink;
  self.relinkChainToArray = relinkChainToArray;
  self.fillEntryUrlDefaults = fillEntryUrlDefaults;
  self.normalizeStepTopology = normalizeStepTopology;
  self.DEFAULT_POLL_MAX_ITERATIONS = DEFAULT_POLL_MAX_ITERATIONS;
}
