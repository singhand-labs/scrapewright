// Single source of truth for the per-step timeout ceiling. Used by generation
// prompts, auto-fix prompts, the test harness, and deploy config so they all agree.
const DEPLOY_TIMEOUT_MS = 60000;

let wizardState = {
  phase: 1,
  targetUrl: '',
  description: '',
  requirements: { inputParams: '', pageOps: '', outputStruct: '' },
  userDescription: '',
  annotations: [],
  steps: [],
  serviceName: '',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  sampleInput: {},
  researchSampleInput: null,
  testInput: {},
  fixAttemptCount: 0,
  autoFixing: false,
  lastError: null,
  confirmedSelectors: [],
  editingServiceId: null,
  originalName: null,
  researchTabId: null,
  explorationData: null,
  llmHistory: [],
  stepAnnotationTabs: {},
  testAbortController: null,
  testAborted: false,
  bestAttempt: null,              // Spec 5: tracks highest-scoring attempt for restore-on-regression
  dismissedInterventions: null,   // Spec 5: Set<string> of intervention types dismissed this run
  // RC24 C3: HTML fingerprint dedup. The autoFix prompt hashes the current
  // page HTML and tracks fingerprints seen so far. When a fingerprint repeats
  // across iterations (page did not change), the prompt sends only a reference
  // marker instead of the full HTML body — saves substantial context tokens
  // without losing information (the LLM looks back at the prior message that
  // carried the full HTML). Annotations are ALWAYS sent fresh, tracked
  // separately from the fingerprint (user direction: "annotations另外，不在html里").
  htmlFingerprintsInHistory: new Set(),
  lastHtmlFingerprint: null,
  subtreeSelector: null,
  // No-op escalation (console.log 2026-08-05 07:13–07:22): the LLM returned
  // byte-identical responses across 3 iterations for similar feedback, and
  // [NO-OP DETECTED] in llmHistory alone wasn't enough to break the loop.
  // Track consecutive no-ops per feedback text so the CURRENT prompt can
  // carry a strong, cache-busting warning when the user repeats themselves.
  consecutiveNoOpCount: 0,
  lastNoOpFeedback: null
};

function buildSystemMessageWithGlobalContext(baseSystemContent) {
  const desc = (wizardState.userDescription || wizardState.description || '').trim();
  return appendGlobalContextBlock(baseSystemContent, desc);
}

// renderCleanedResult: produce the prompt-rendered form of whatever mode
// DomCleaner.cleanHtmlForLLM returned. Used by autoFix prompt assembly to
// stringify the cleaned-result object into a single text block for the LLM.
// Each mode carries different fields:
//   - 'full'         → just the cleaned HTML body
//   - 'annotated'    → annotated element contexts joined by newlines
//   - 'compressed'   → structure + optional annotated contexts
//   - 'needs_subtree_selection' → structureForSelection preview (the A4
//                       integration should normally have replaced this by
//                       prompt-render time; we fall back to the shallow
//                       structure if it somehow survives).
// Returns '' for null/undefined/non-object inputs so prompt templates can
// safely interpolate without extra guards.
function renderCleanedResult(cleanedResult) {
  if (!cleanedResult || typeof cleanedResult !== 'object') return '';
  switch (cleanedResult.mode) {
    case 'full':
      return cleanedResult.html || '';
    case 'annotated':
      return (cleanedResult.contexts || []).map(c => c.context).join('\n');
    case 'compressed':
      return (cleanedResult.structure || '') + (
        cleanedResult.contexts && cleanedResult.contexts.length
          ? '\n\nAnnotated element contexts:\n' + cleanedResult.contexts.map(c => c.context).join('\n')
          : ''
      );
    case 'needs_subtree_selection':
      // After A4 integration runs, this should have been replaced. If we get
      // here, fall back to the shallow structure preview.
      return cleanedResult.structureForSelection || cleanedResult.structure || '';
    default:
      return cleanedResult.html || cleanedResult.structure || '';
  }
}

// Parse LLM JSON output with lenient fallback. Tries strict JSON.parse first,
// then parseJsonLenient (strips JS comments, removes trailing commas). On
// failure, logs position context and saves the full output to
// chrome.storage.local so future failures are diagnosable.
//
// bugx.log 2026-07-24 02:47:40 showed the wizard aborting because
// generateStepsWithSelectors emitted 8206 chars of JSON that JSON.parse
// rejected at position 7108 ("Expected property name or '}'"). The previous
// log captured only the first 500 chars, making the exact bad char a guess.
// This wrapper fixes both: parseJsonLenient handles the most common LLM
// malformations, and the failure path captures the exact byte that broke.
function parseLLMJson(cleaned, contextLabel, rawResult) {
  const res = parseJsonLenient(cleaned);
  if (res.ok) {
    if (res.repairs.length) {
      debugLogger.log('info', 'wizard', 'LLM JSON parsed with repairs', {
        context: contextLabel, repairs: res.repairs, length: cleaned.length
      });
    }
    return res.value;
  }
  // Failure — extract the exact bad position from the error message and log
  // 100 chars of context on either side so the next iteration is informed.
  const posMatch = (res.error || '').match(/at position (\d+)/);
  const pos = posMatch ? parseInt(posMatch[1], 10) : null;
  let positionContext = null;
  let positionContextFlat = null;
  if (pos != null) {
    const start = Math.max(0, pos - 100);
    const end = Math.min(cleaned.length, pos + 100);
    const before = cleaned.slice(start, pos);
    const after = cleaned.slice(pos + 1, end);
    const charCode = cleaned.charCodeAt(pos);
    positionContext = {
      position: pos,
      char: cleaned[pos],
      charCode,
      before,
      after
    };
    // Flat one-line representation so it shows up in bugx.log dumps without
    // requiring DevTools expansion of the nested object. Uses ASCII markers
    // (⬅ here, ↳ after) that survive JSON.stringify.
    positionContextFlat =
      `pos=${pos} char="${cleaned[pos]}" code=${charCode} ` +
      `…before=${JSON.stringify(before)} ` +
      `⬅here↳ ` +
      `after=${JSON.stringify(after)}`;
  }
  debugLogger.log('error', 'wizard', 'LLM JSON parse failed (lenient)', {
    context: contextLabel,
    error: res.error,
    repairsAttempted: res.repairs,
    cleanedLength: cleaned.length,
    positionContext,
    positionContextFlat,
    cleanedPreview: cleaned.slice(0, 500)
  });
  // Also log the flat context as a standalone entry — debugLogger may
  // truncate large nested fields, but a short string always survives.
  if (positionContextFlat) {
    debugLogger.log('warn', 'wizard', 'LLM JSON bad position', {
      context: contextLabel,
      summary: positionContextFlat
    });
  }
  // Persist the FULL failed output for offline analysis (log only stores 500 chars).
  try {
    chrome.storage.local.get(['llmParseFailures'], (data) => {
      const failures = data.llmParseFailures || [];
      failures.unshift({
        context: contextLabel,
        cleaned,
        error: res.error,
        repairs: res.repairs,
        timestamp: Date.now()
      });
      while (failures.length > 5) failures.pop();
      chrome.storage.local.set({ llmParseFailures: failures });
    });
  } catch (e) { /* storage unavailable in some contexts */ }
  const err = new Error(`${contextLabel} returned malformed JSON: ${res.error}`);
  err.rawLLMOutput = cleaned.slice(0, 500);
  throw err;
}

function trimLlmHistory(maxChars) {
  // C4: trim by total chars, not message count. Preserves multi-round memory
  // for typical autoFix flows (which stay well under the limit) but caps
  // pathological growth (many rounds with page changes).
  const limit = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : 150000;
  let total = wizardState.llmHistory.reduce((n, m) => n + (m.content?.length || 0), 0);
  let trimmed = false;
  while (total > limit && wizardState.llmHistory.length > 4) {
    const removed = wizardState.llmHistory.shift();
    total -= (removed.content?.length || 0);
    trimmed = true;
  }
  // If we dropped any entries, invalidate the fingerprint cache. A trimmed
  // entry may have been the bearer of a fingerprint still in the set; if we
  // left the set as-is, the next round would send a "see prior message with
  // fingerprint X" reference to a message that no longer exists.
  if (trimmed && wizardState.htmlFingerprintsInHistory) {
    wizardState.htmlFingerprintsInHistory.clear();
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'service';
}

async function generateUniqueSlug(baseName, registry, excludeId) {
  let slug = slugify(baseName);
  const services = await registry.getAll();
  let suffix = 0;
  while (services.some(s => s.name === slug && s.id !== excludeId)) {
    suffix++;
    slug = slugify(baseName) + '-' + suffix;
  }
  return slug;
}

function showToast(message, type = 'info', duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(el._timer);
  el.innerHTML = '';
  const msg = document.createElement('span');
  msg.className = 'toast-message';
  msg.textContent = message;
  el.appendChild(msg);
  // Errors stay visible until the user dismisses them; success/info auto-hide.
  if (type === 'error') {
    const btn = document.createElement('button');
    btn.className = 'toast-close';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Close');
    btn.textContent = '×';
    btn.onclick = () => { clearTimeout(el._timer); el.className = 'toast hidden'; };
    el.appendChild(btn);
    el.className = 'toast ' + type + ' dismissible';
  } else {
    el.className = 'toast ' + type;
    el._timer = setTimeout(() => { el.className = 'toast hidden'; }, duration);
  }
}

function showLoading(text) {
  const el = document.getElementById('loading');
  if (!el) return;
  document.getElementById('loadingText').textContent = text || 'Processing...';
  el.classList.remove('hidden');
}

function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
}

function updateUrlTemplateHint(sampleInput) {
  const hintEl = document.getElementById('urlTemplateHint');
  if (!hintEl) return;
  const params = window.UrlTemplate
    ? window.UrlTemplate.extractTemplateParams(wizardState.targetUrl || '')
    : [];
  if (params.length === 0) {
    hintEl.classList.add('hidden');
    hintEl.innerHTML = '';
    return;
  }
  const paramsList = params.map(p => '<code>{{' + p + '}}</code>').join(', ');
  const sample = (sampleInput && typeof sampleInput === 'object') ? sampleInput : {};
  let preview;
  try {
    preview = window.UrlTemplate.resolveTargetUrl(
      wizardState.targetUrl,
      Object.fromEntries(params.map(p => [p, sample[p] != null ? sample[p] : '<' + p + '>']))
    );
  } catch (e) {
    preview = '(provide all parameters to preview)';
  }
  hintEl.innerHTML =
    '<span class="hint-label">URL template detected.</span> ' +
    paramsList + ' will be replaced with the matching input parameter at runtime. ' +
    'Sample preview: <code></code>';
  hintEl.lastElementChild.textContent = preview;
  hintEl.classList.remove('hidden');
}

function buildUrlTemplateNotice(targetUrl) {
  if (!window.UrlTemplate) return '';
  const params = window.UrlTemplate.extractTemplateParams(targetUrl || '');
  if (params.length === 0) return '';
  const list = params.map(p => `{{${p}}} (resolved from input.${p})`).join(', ');
  return `URL Template Notice. The target URL contains these placeholders: ${list}. They will be substituted BEFORE the page loads, so the page is already on the parameterized URL when your script runs. Do NOT generate $type / $click steps to enter these values into form fields. Generate only the post-load operations (scroll, extract, paginate by other means, etc.).\n\n`;
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadEditMode();
  showPhase(wizardState.phase);

  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((removedTabId) => {
      for (const stepId of Object.keys(wizardState.stepAnnotationTabs)) {
        if (wizardState.stepAnnotationTabs[stepId] === removedTabId) {
          delete wizardState.stepAnnotationTabs[stepId];
        }
      }
    });
  }

  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((updatedTabId, info) => {
      if (info.status !== 'loading') return;
      const trackedStepIds = Object.keys(wizardState.stepAnnotationTabs).filter(
        sid => wizardState.stepAnnotationTabs[sid] === updatedTabId
      );
      if (trackedStepIds.length === 0) return;
      showToast('Target tab reloaded — annotations cleared. Click Start Annotating again to re-select elements.', 'error', 6000);
    });
  }

  document.getElementById('btnPhase1Research').addEventListener('click', startResearch);
  document.getElementById('btnRunExploration')?.addEventListener('click', onRunExploration);
  document.getElementById('btnSkipExploration')?.addEventListener('click', onSkipExploration);
  document.getElementById('btnPhase2Next').addEventListener('click', () => goToPhase(3));
  document.getElementById('btnPhase2Back').addEventListener('click', () => goToPhase(1));
  document.getElementById('btnPhase3Test').addEventListener('click', runTestFromStep5);
  document.getElementById('btnPhase3Back').addEventListener('click', () => goToPhase(2));
  document.getElementById('btnPhase4Back').addEventListener('click', () => goToPhase(3));
  document.getElementById('btnPhase5Deploy').addEventListener('click', confirmDeploy);
  document.getElementById('btnPhase5Back').addEventListener('click', () => goToPhase(4));
  document.getElementById('btnPhase5EditSteps').addEventListener('click', () => goToPhase(2));
  document.getElementById('btnRetryTest').addEventListener('click', () => {
    wizardState.testAborted = false;
    testScript();
  });
  document.getElementById('btnAutoFix').addEventListener('click', () => {
    wizardState.testAborted = false;
    autoFix(document.getElementById('feedbackInput').value);
  });
  document.getElementById('btnDeployAnyway').addEventListener('click', () => {
    goToPhase(5);
    confirmDeploy();
  });
  document.getElementById('btnAddStep')?.addEventListener('click', addStep);
  document.getElementById('btnApplyTemplate')?.addEventListener('click', () => {
    const templateId = document.getElementById('templateSelect').value;
    if (!templateId) return;
    const steps = applyTemplate(templateId);
    if (steps) {
      wizardState.steps = steps;
      renderStepList();
      showToast('Template applied. Edit selectors to match your page.', 'success');
    }
  });
  document.getElementById('snapshotModal')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal') || e.target.classList.contains('modal-close')) {
      document.getElementById('snapshotModal').classList.add('hidden');
    }
  });
  initStepListDelegation();

  document.getElementById('targetUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('reqInputParams').focus();
  });
  document.getElementById('targetUrl').addEventListener('input', (e) => {
    wizardState.targetUrl = e.target.value;
    updateUrlTemplateHint(wizardState.researchSampleInput || null);
  });
  document.getElementById('reqPageOps').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) startResearch();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'EXECUTION_LOG') {
      appendLog(message.message, message.level || 'info');
    }
    // RC25 (console.log 2026-08-04): count trusted-wheel skips during the
    // current testScript run. Background broadcasts TRUSTED_WHEEL_SKIPPED
    // whenever a content-script emits a trustedWheel_skipped diagnostic
    // (Enhanced Mode off + scroll stall). After testScript, if count > 0,
    // surface a tip so the user knows to enable Enhanced Mode — without
    // this surfacing, the failure is silent (only visible in console logs).
    if (message.type === 'TRUSTED_WHEEL_SKIPPED') {
      wizardState.trustedWheelSkipCount = (wizardState.trustedWheelSkipCount || 0) + 1;
    }
  });
});

async function loadEditMode() {
  const params = new URLSearchParams(window.location.search);
  const editId = params.get('edit');
  if (!editId) return;

  const registry = new ServiceRegistry();
  const svc = await registry.getById(editId);
  if (!svc) return;

  wizardState.editingServiceId = svc.id;
  wizardState.originalName = svc.name;
  wizardState.targetUrl = svc.targetUrl;
  wizardState.description = svc.displayName || '';
  wizardState.userDescription = svc.userDescription || svc.displayName || '';
  wizardState.requirements = svc.requirements || {
    inputParams: '',
    pageOps: svc.userDescription || svc.displayName || '',
    outputStruct: ''
  };
  wizardState.description = buildRequirementsBlock(wizardState.requirements);
  wizardState.serviceName = svc.displayName || '';
  wizardState.steps = svc.steps || [];
  wizardState.inputSchema = svc.inputSchema || { type: 'object' };
  wizardState.outputSchema = svc.outputSchema || { type: 'object' };
  wizardState.annotations = svc.annotations || [];
  wizardState.sampleInput = svc.sampleInput || {};
  wizardState.llmHistory = [];
  wizardState.phase = 2;

  document.getElementById('targetUrl').value = svc.targetUrl;
  updateUrlTemplateHint(wizardState.researchSampleInput || wizardState.sampleInput || null);
  document.getElementById('reqInputParams').value = wizardState.requirements.inputParams || '';
  document.getElementById('reqPageOps').value = wizardState.requirements.pageOps || '';
  document.getElementById('reqOutputStruct').value = wizardState.requirements.outputStruct || '';
  document.getElementById('serviceName').value = svc.displayName || '';
  document.getElementById('pageTitle').textContent = 'Edit Service: ' + svc.displayName;
  renderStepList();
}

function showPhase(n) {
  wizardState.phase = n;
  document.querySelectorAll('.step').forEach(el => el.classList.add('hidden'));
  document.getElementById(`phase${n}`)?.classList.remove('hidden');
}

function updatePhaseUI(state) {
  const btnRetryTest = document.getElementById('btnRetryTest');
  const btnAutoFix = document.getElementById('btnAutoFix');
  const btnDeployAnyway = document.getElementById('btnDeployAnyway');
  const btnPhase5Deploy = document.getElementById('btnPhase5Deploy');
  const feedbackInput = document.getElementById('feedbackInput');
  const testStatus = document.getElementById('testStatus');

  [btnRetryTest, btnAutoFix, btnDeployAnyway, btnPhase5Deploy].forEach(b => b.classList.add('hidden'));
  testStatus.className = '';

  document.getElementById('serviceNameDisplay').textContent = 'Service: ' + (wizardState.serviceName || 'Unnamed');
  renderIOSummary();

  if (state === 'success') {
    testStatus.textContent = 'All steps passed!';
    testStatus.className = 'success';
    btnPhase5Deploy.classList.remove('hidden');
    btnAutoFix.classList.remove('hidden');
    feedbackInput.placeholder = 'Point out the problem with the extracted data — e.g. "createdAt is missing", "only 3 records extracted", "images should have multiple URLs"';
  } else if (state === 'empty-result') {
    testStatus.textContent = 'Test passed but extracted data is empty — extraction may not be working correctly.';
    testStatus.className = 'fixing';
    btnRetryTest.classList.remove('hidden');
    btnAutoFix.classList.remove('hidden');
    btnDeployAnyway.classList.remove('hidden');
    feedbackInput.placeholder = 'Point out the problem — e.g. "expected ~20 records but got 0", "the list selector is wrong", "the page needs more scroll time"';
    debugLogger.log('warn', 'wizard', 'Empty result detected, showing fix controls');
  } else if (state === 'failure') {
    const stepInfo = wizardState.lastErrorStepId ? ' (step: ' + wizardState.lastErrorStepId + ')' : '';
    testStatus.textContent = wizardState.lastError
      ? 'Test failed: ' + wizardState.lastError + stepInfo
      : 'Test failed';
    testStatus.className = 'failure';
    btnRetryTest.classList.remove('hidden');
    btnAutoFix.classList.remove('hidden');
    btnDeployAnyway.classList.remove('hidden');
    feedbackInput.placeholder = 'Point out the problem — e.g. "the selector timed out", "wrong element is being clicked", "the URL pattern changed"';
  } else if (state === 'fixing') {
    testStatus.textContent = 'Fixing step (attempt #' + (wizardState.fixAttemptCount + 1) + ')...';
    testStatus.className = 'fixing';
  }
}

function renderIOSummary() {
  document.getElementById('ioSummary').textContent = buildIORenderString(wizardState.inputSchema, wizardState.outputSchema);
}

function renderResultSummary(result) {
  const container = document.getElementById('resultSummary');
  if (!container) return;
  container.innerHTML = '';

  // Final result card (prominent)
  const finalResult = result.finalResult;
  if (finalResult !== undefined && finalResult !== null) {
    const card = document.createElement('div');
    card.className = 'result-card result-final';
    card.innerHTML = '<div class="result-label">Extraction Result</div>' +
      '<pre class="result-value">' + escapeHtml(JSON.stringify(finalResult, null, 2)) + '</pre>';
    container.appendChild(card);
  }

  // Step-by-step breakdown
  if (result.steps && result.steps.length > 0) {
    const stepsDiv = document.createElement('div');
    stepsDiv.className = 'result-steps';
    stepsDiv.innerHTML = '<div class="result-label">Steps</div>';

    result.steps.forEach((step, i) => {
      const stepDiv = document.createElement('div');
      stepDiv.className = 'result-step';

      const badge = step.skipped ? '⏭' : '✓';
      const statusClass = step.skipped ? 'step-skipped' : 'step-passed';
      const name = escapeHtml(step.stepName || ('Step ' + (i + 1)));

      let resultHtml = '';
      if (step.skipped) {
        resultHtml = '<span class="step-skip-reason">skipped: ' + escapeHtml(step.skipReason || '') + '</span>';
      } else if (step.result !== undefined) {
        const resultStr = typeof step.result === 'object'
          ? JSON.stringify(step.result, null, 2)
          : String(step.result);
        resultHtml = '<pre class="result-step-value">' + escapeHtml(resultStr) + '</pre>';
      }

      stepDiv.innerHTML = '<span class="step-badge ' + statusClass + '">' + badge + '</span> ' +
        '<span class="step-result-name">' + name + '</span>' + resultHtml;
      stepsDiv.appendChild(stepDiv);
    });

    container.appendChild(stepsDiv);
  }

  // Show raw output toggle
  document.getElementById('rawOutputDetails')?.classList.remove('hidden');
}

// RC16: render the pages[] (captured page list) into a read-only viewer.
// Each entry shows id, url, title, captureReason, and a collapsed HTML preview.
// DOM rendering is capped at 20 entries — the full list remains in the API
// response. No-op when there are no pages (e.g. older test runs).
function renderPagesViewer(testResult) {
  const viewer = document.getElementById('pages-viewer');
  if (!viewer) return;
  const pages = Array.isArray(testResult && testResult.pages) ? testResult.pages : [];
  const countEl = document.getElementById('pages-count');
  const listEl = document.getElementById('pages-list');
  if (pages.length === 0) {
    viewer.hidden = true;
    return;
  }
  viewer.hidden = false;
  if (countEl) countEl.textContent = String(pages.length);
  if (!listEl) return;
  // Cap DOM rendering at 20 entries to avoid browser slowdown on huge lists.
  // The full list is still available in the API response; the wizard UI just
  // caps what it renders.
  const rendered = pages.slice(0, 20);
  listEl.innerHTML = '';
  for (const page of rendered) {
    const item = document.createElement('div');
    item.className = 'page-entry';
    const header = document.createElement('div');
    header.className = 'page-entry__header';
    const idText = page && page.id != null ? String(page.id) : '(no id)';
    const urlText = page && page.url ? String(page.url) : '(no url)';
    const titleText = page && page.title ? String(page.title) : '';
    const reasonText = page && page.captureReason ? String(page.captureReason) : '';
    const truncated = !!(page && page.truncated);
    header.innerHTML =
      '<strong>' + escapeHtml(idText) + '</strong> ' +
      '<span class="page-entry__url">' + escapeHtml(urlText) + '</span>' +
      (titleText ? ' <span class="page-entry__title">' + escapeHtml(titleText) + '</span>' : '') +
      (reasonText ? ' <span class="page-entry__reason">' + escapeHtml(reasonText) + '</span>' : '') +
      (truncated ? ' <span class="page-entry__truncated">[truncated]</span>' : '');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const htmlLen = page && typeof page.html === 'string' ? page.html.length : 0;
    summary.textContent = 'HTML (' + htmlLen + ' chars)';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.className = 'page-entry__html';
    pre.textContent = (page && page.html) || '';
    details.appendChild(pre);
    item.appendChild(header);
    item.appendChild(details);
    listEl.appendChild(item);
  }
  if (pages.length > rendered.length) {
    const more = document.createElement('div');
    more.className = 'pages-list__more';
    more.textContent = '+ ' + (pages.length - rendered.length) + ' more — see API response';
    listEl.appendChild(more);
  }
}

function goToPhase(n) {
  if (wizardState.testAbortController && !wizardState.testAbortController.signal.aborted) {
    wizardState.testAbortController.abort();
    wizardState.testAborted = true;
    appendLog('Test aborted: you navigated away from the test.', 'info');
  }
  if (n === 2) {
    renderStepList();
    if (!document.getElementById('serviceName').value && wizardState.serviceName) {
      document.getElementById('serviceName').value = wizardState.serviceName;
    }
    if (!document.getElementById('serviceName').value && !wizardState.serviceName) {
      const suggested = suggestServiceName(wizardState.targetUrl);
      if (suggested) {
        document.getElementById('serviceName').value = suggested;
        wizardState.serviceName = suggested;
      }
    }
  }
  if (n === 3) {
    syncStepsFromEditor();
    wizardState.serviceName = document.getElementById('serviceName').value || wizardState.serviceName;
    document.getElementById('inputSchemaEditor').value = JSON.stringify(wizardState.inputSchema, null, 2);
    document.getElementById('outputSchemaEditor').value = JSON.stringify(wizardState.outputSchema, null, 2);
    document.getElementById('testInputEditor').value = JSON.stringify(wizardState.sampleInput || {}, null, 2);
  }
  showPhase(n);
}

function renderStepList() {
  const container = document.getElementById('stepList');
  if (!container) return;
  container.innerHTML = '';

  wizardState.steps.forEach((step, index) => {
    const div = document.createElement('div');
    div.className = 'step-card';
    const isPending = step.needsAnnotation === true && (!step.script || step.script.trim() === '' || step.script.trim() === '// PENDING_ANNOTATION');
    const statusLabel = isPending
      ? '<span class="step-status step-status-pending">⚠ Pending annotation</span>'
      : '<span class="step-status step-status-done">✓ Script generated</span>';
    div.innerHTML = `
      <div class="step-header">
        <span class="step-number">${index + 1}</span>
        <span class="step-name">${escapeHtml(step.name || 'Unnamed Step')}</span>
        ${statusLabel}
        ${(step.maxIterations && step.maxIterations > 1) ? `<span class="step-iterations" title="Max times this step can repeat itself (a poll/wait step). While it returns { done: false } it retries; once it returns the data or { done: true } it advances via On Success.">↻ max ${step.maxIterations}</span>` : ''}
        <button class="btn-step-edit" data-index="${index}">Edit</button>
        <button class="btn-step-improve" data-index="${index}">AI Improve</button>
        <button class="btn-step-del" data-index="${index}">Delete</button>
        ${index > 0 ? `<button class="btn-step-up" data-index="${index}">▲</button>` : ''}
        ${index < wizardState.steps.length - 1 ? `<button class="btn-step-down" data-index="${index}">▼</button>` : ''}
      </div>
      <div class="step-annotation-row">
        <label>Entry URL:
          <input type="url" class="step-entry-url" value="${escapeHtml(step.entryUrl || '')}" placeholder="(optional, for annotation)">
        </label>
        <button class="btn-step-open-webpage" data-index="${index}">Open Page</button>
        <button class="btn-step-start-annotation" data-index="${index}">Start Annotating</button>
        <button class="btn-step-complete-annotation" data-index="${index}">Finish Annotation</button>
      </div>
      ${(step.annotations && step.annotations.length)
        ? `<div class="step-annotation-list">
            ${step.annotations.map((a) => {
              const label = a.type ? `[${a.type}] ` : '';
              const sel = a.selector || '';
              const badges = annotationBadges(a);
              return `<div class="step-annotation-item">
                <span class="step-annotation-sel">${escapeHtml(label + sel)}</span>
                ${badges ? `<span class="step-annotation-badges">${escapeHtml(badges)}</span>` : ''}
              </div>`;
            }).join('')}
          </div>`
        : ''}
      <div class="step-detail hidden" data-step-id="${escapeHtml(step.id)}" data-index="${index}">
        <label>Name:<input type="text" class="step-name-input" value="${escapeHtml(step.name || '')}"></label>
        <label>Script:<textarea class="step-script-input" rows="4">${escapeHtml(step.script || '')}</textarea></label>
        <label>Condition (optional):<input type="text" class="step-condition-input" value="${escapeHtml(step.condition || '')}"></label>
        <label>On Success:<input type="text" class="step-success-input" value="${escapeHtml(step.onSuccess || 'TERMINATE')}"></label>
        <label>On Failure:<input type="text" class="step-failure-input" value="${escapeHtml(step.onFailure || 'TERMINATE')}"></label>
        <label>Max Iterations:<input type="number" class="step-maxiter-input" value="${step.maxIterations || 1}" min="1" title="How many times this step can repeat. A normal step is 1 (run once, advance). Set >1 (e.g. 20-30) for wait/poll steps: while the script returns { done: false } the step retries itself; when it returns the data or { done: true } it advances via On Success. If it exhausts this limit while still not ready, execution follows the On Failure branch."></label>
      </div>
      <div class="step-improve-panel hidden" data-index="${index}">
        <input type="text" class="step-improve-input" placeholder="Describe how to improve this step (e.g. &quot;wait for .answer instead of sleep&quot;)" style="width:calc(100% - 90px)">
        <button class="btn-step-improve-go" data-index="${index}">Send</button>
        <button class="btn-step-improve-cancel" data-index="${index}">Cancel</button>
      </div>
    `;
    container.appendChild(div);
  });
}

function initStepListDelegation() {
  const container = document.getElementById('stepList');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target;
    if (btn.classList.contains('btn-step-edit')) {
      const idx = btn.dataset.index;
      const detail = container.querySelector(`.step-detail[data-index="${idx}"]`);
      if (detail) detail.classList.toggle('hidden');
    } else if (btn.classList.contains('btn-step-improve')) {
      const idx = btn.dataset.index;
      const panel = container.querySelector(`.step-improve-panel[data-index="${idx}"]`);
      if (panel) {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
          panel.querySelector('.step-improve-input').focus();
        }
      }
    } else if (btn.classList.contains('btn-step-improve-go')) {
      const idx = parseInt(btn.dataset.index);
      const panel = container.querySelector(`.step-improve-panel[data-index="${idx}"]`);
      const feedback = panel?.querySelector('.step-improve-input')?.value?.trim();
      if (!feedback) { showToast('Please describe how to improve', 'error'); return; }
      improveStepWithAI(idx, feedback);
    } else if (btn.classList.contains('btn-step-improve-cancel')) {
      const idx = btn.dataset.index;
      const panel = container.querySelector(`.step-improve-panel[data-index="${idx}"]`);
      if (panel) panel.classList.add('hidden');
    } else if (btn.classList.contains('btn-step-del')) {
      const idx = parseInt(btn.dataset.index);
      const stepId = wizardState.steps[idx]?.id;
      if (stepId) {
        removeStepWithRelink(wizardState.steps, stepId);
      } else {
        wizardState.steps.splice(idx, 1);
      }
      renderStepList();
    } else if (btn.classList.contains('btn-step-up')) {
      const idx = parseInt(btn.dataset.index);
      [wizardState.steps[idx], wizardState.steps[idx - 1]] = [wizardState.steps[idx - 1], wizardState.steps[idx]];
      relinkChainToArray(wizardState.steps);
      renderStepList();
    } else if (btn.classList.contains('btn-step-down')) {
      const idx = parseInt(btn.dataset.index);
      [wizardState.steps[idx], wizardState.steps[idx + 1]] = [wizardState.steps[idx + 1], wizardState.steps[idx]];
      relinkChainToArray(wizardState.steps);
      renderStepList();
    } else if (btn.classList.contains('btn-step-open-webpage')) {
      const idx = parseInt(btn.dataset.index);
      openStepWebpage(idx);
    } else if (btn.classList.contains('btn-step-start-annotation')) {
      const idx = parseInt(btn.dataset.index);
      startStepAnnotation(idx);
    } else if (btn.classList.contains('btn-step-complete-annotation')) {
      const idx = parseInt(btn.dataset.index);
      completeStepAnnotation(idx);
    }
  });
}

const _inFlightStepGen = new Set();

async function openStepWebpage(stepIndex) {
  syncStepsFromEditor();
  const step = wizardState.steps[stepIndex];
  if (!step) return;
  const url = step.entryUrl || wizardState.targetUrl;
  if (!url) {
    showToast('Please set an entry URL for this step first', 'error');
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    showToast('Entry URL is not valid: ' + url, 'error');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    showToast('Entry URL must be http or https (got ' + parsed.protocol + ')', 'error');
    return;
  }
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    wizardState.stepAnnotationTabs[step.id] = tab.id;
    showToast('Tab opened. Navigate the page to the desired state, then click Start Annotating.', 'info');
  } catch (e) {
    showToast('Failed to open tab: ' + e.message, 'error');
  }
}

async function startStepAnnotation(stepIndex) {
  syncStepsFromEditor();
  const step = wizardState.steps[stepIndex];
  if (!step) return;
  const tabId = wizardState.stepAnnotationTabs[step.id];
  if (!tabId) {
    showToast('Please click Open Page first to open a tab for this step', 'error');
    return;
  }
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    showToast('The tab for this step was closed. Please click Open Page again.', 'error');
    delete wizardState.stepAnnotationTabs[step.id];
    return;
  }
  try {
    await sendMessageWithRetry(tabId, {
      type: 'START_ANNOTATION',
      inputSchema: wizardState.inputSchema,
      outputSchema: wizardState.outputSchema,
      outputFieldOptions: getOutputFieldOptions(wizardState.outputSchema)
    });
    showToast('Annotation mode on. Click elements, then click Finish Annotation when done.', 'info');
  } catch (e) {
    try {
      await chrome.tabs.reload(tabId);
      await waitForTabLoad(tabId);
      await sendMessageWithRetry(tabId, {
        type: 'START_ANNOTATION',
        inputSchema: wizardState.inputSchema,
        outputSchema: wizardState.outputSchema,
        outputFieldOptions: getOutputFieldOptions(wizardState.outputSchema)
      });
      showToast('Annotation mode on (after reload).', 'info');
    } catch (e2) {
      showToast('Page not ready. Wait for it to load and try again.', 'error');
    }
  }
}

async function completeStepAnnotation(stepIndex) {
  syncStepsFromEditor();
  const step = wizardState.steps[stepIndex];
  if (!step) return;
  if (_inFlightStepGen.has(step.id)) {
    showToast('Annotation already being generated for this step. Wait for it to finish.', 'info');
    return;
  }
  _inFlightStepGen.add(step.id);
  try {
    await _completeStepAnnotationInner(stepIndex, step);
  } finally {
    _inFlightStepGen.delete(step.id);
  }
}

async function _completeStepAnnotationInner(stepIndex, step) {
  const tabId = wizardState.stepAnnotationTabs[step.id];
  if (!tabId) {
    showToast('Please click Open Page and Start Annotating first', 'error');
    return;
  }
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    showToast('The tab for this step was closed. Please click Open Page and Start Annotating again.', 'error');
    delete wizardState.stepAnnotationTabs[step.id];
    return;
  }

  let captured;
  try {
    captured = await sendMessageWithRetry(tabId, { type: 'CAPTURE_ANNOTATION' });
  } catch (e) {
    showToast('Could not capture annotations: ' + e.message, 'error');
    return;
  }

  if (captured && captured.error) {
    showToast('Snapshot capture failed: ' + captured.error + '. Annotations preserved, but page HTML is unavailable for this generation attempt.', 'error');
    return;
  }

  if (!captured || !captured.annotations || captured.annotations.length === 0) {
    showToast('No annotations captured. Click Start Annotating and select elements first.', 'error');
    return;
  }

  const newEntryUrl = step.entryUrl || captured.url;

  showLoading('Generating step script with annotations...');
  try {
    const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
    if (!config.config) {
      showToast('LLM not configured. Set it in Options.', 'error');
      return;
    }

    const pageInfo = DomCleaner.cleanHtmlForLLM(captured.fullHtml, captured.annotations);

    const stepContext = {
      globalDescription: wizardState.userDescription || wizardState.description || '',
      previousStepsSchema: wizardState.steps.slice(0, stepIndex).map(s => `${s.id} (${s.name})`).join(', ') || '(none)',
      nextStepsDescription: wizardState.steps.slice(stepIndex + 1).map(s => `${s.id} (${s.name})`).join(', ') || '(none, terminal)'
    };

    const result = await generateStepScript(config.config, step, pageInfo, captured.annotations, stepContext, step.script);

    if (result && result.script) {
      step.script = result.script;
      step.needsAnnotation = false;
      step.annotations = (result.revisedAnnotations && Array.isArray(result.revisedAnnotations))
        ? result.revisedAnnotations
        : captured.annotations;
      step.entryUrl = newEntryUrl;

      // Brittleness check: warn the user when the annotation itself is
      // fragile (positional nth-of-type chain, no stable anchor, etc.).
      // Previously this was a verbatim-substring check that punished the LLM
      // for dropping brittle selectors — counterproductive. The LLM was doing
      // the right thing. Now we surface the root cause: the annotation.
      const annotationSelectors = (step.annotations || [])
        .map(a => a && a.selector)
        .filter(s => typeof s === 'string' && s.length > 0);
      const brittleness = scoreAnnotationChain(annotationSelectors);
      if (brittleness.score >= 50) {
        const reason = brittleness.reasons[0] || 'annotation may not generalize';
        showToast(
          `⚠ Brittle annotation (score ${brittleness.score}): ${reason}. Extraction may not generalize to other list items.`,
          'warn',
          10000
        );
        debugLogger.log('warn', 'wizard', 'Brittle annotation detected', {
          score: brittleness.score,
          reasons: brittleness.reasons,
          selectors: annotationSelectors,
        });
      }

      renderStepList();
      showToast('Step script generated', 'success');
    } else {
      showToast('LLM did not return a valid script. Try annotating more elements.', 'error');
    }
  } catch (e) {
    const detail = e.rawLLMOutput ? `${e.message} (output started with: "${e.rawLLMOutput.slice(0, 80)}...")` : e.message;
    showToast('Script generation failed: ' + detail, 'error');
  } finally {
    hideLoading();
  }
}

function syncStepsFromEditor() {
  const container = document.getElementById('stepList');
  if (!container) return;
  container.querySelectorAll('.step-detail').forEach(detail => {
    const stepId = detail.dataset.stepId;
    const step = wizardState.steps.find(s => s.id === stepId);
    if (!step) return;
    step.name = detail.querySelector('.step-name-input').value;
    step.script = detail.querySelector('.step-script-input').value;
    step.condition = detail.querySelector('.step-condition-input').value || null;
    step.onSuccess = detail.querySelector('.step-success-input').value;
    step.onFailure = detail.querySelector('.step-failure-input').value;
    step.maxIterations = parseInt(detail.querySelector('.step-maxiter-input').value) || 1;
    const card = detail.closest('.step-card');
    const entryUrlInput = card && card.querySelector('.step-entry-url');
    if (entryUrlInput) step.entryUrl = entryUrlInput.value;
  });
}

function addStep() {
  let id = 'step-' + (wizardState.steps.length + 1);
  const existingIds = new Set(wizardState.steps.map(s => s.id));
  while (existingIds.has(id)) {
    id = 'step-' + Math.floor(Math.random() * 10000);
  }
  appendStepWithChainLink(wizardState.steps, {
    id,
    name: 'New Step',
    script: '',
    onSuccess: 'TERMINATE',
    onFailure: 'TERMINATE',
    maxIterations: 1,
    entryUrl: wizardState.targetUrl || ''
  });
  renderStepList();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Build a compact badge string summarizing an annotation's captured intent
// fields (purpose / waitCondition / outputField / inputField). Returns '' when
// the annotation carries no intent metadata so callers can render an empty
// span without leaving stray separators. Display-only (read at pick time).
function annotationBadges(a) {
  if (!a) return '';
  const b = [];
  if (a.purpose) b.push('purpose=' + a.purpose);
  if (a.waitCondition) b.push('wait=' + a.waitCondition);
  if (a.outputField) b.push('→ ' + a.outputField);
  if (a.inputField) b.push('← ' + a.inputField);
  return b.join(' ');
}

function appendLog(message, level = 'info') {
  const logEl = document.getElementById('executionLog');
  if (!logEl) return;
  const line = document.createElement('div');
  line.className = 'log-line' + (level === 'error' ? ' error' : level === 'success' ? ' success' : '');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderExecutionProgress(evt) {
  if (!evt || !evt.type) return;
  const container = document.getElementById('executionProgress');
  const tbody = document.getElementById('executionProgressBody');
  if (!container || !tbody) return;

  switch (evt.type) {
    case 'EXECUTION_START': {
      container.classList.remove('hidden');
      tbody.innerHTML = '';
      const steps = wizardState.steps || [];
      for (let i = 0; i < steps.length; i++) {
        const tr = document.createElement('tr');
        tr.dataset.stepId = steps[i].id;
        tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(steps[i].name || steps[i].id)}</td><td>pending</td><td>-</td><td></td>`;
        tbody.appendChild(tr);
      }
      break;
    }
    case 'STEP_START': {
      const tr = tbody.querySelector(`tr[data-step-id="${evt.stepId}"]`);
      if (!tr) return;
      const maxIter = evt.maxIterations ?? 1;
      tr.children[2].textContent = 'running';
      tr.children[3].textContent = `0/${maxIter}`;
      break;
    }
    case 'STEP_ITERATION': {
      const tr = tbody.querySelector(`tr[data-step-id="${evt.stepId}"]`);
      if (!tr) return;
      const maxIter = evt.maxIterations ?? 1;
      tr.children[3].textContent = `${evt.iteration}/${maxIter}`;
      tr.children[4].textContent = formatDomActivitySummary(evt.domActivity);
      break;
    }
    case 'STEP_DONE': {
      const tr = tbody.querySelector(`tr[data-step-id="${evt.stepId}"]`);
      if (!tr) return;
      tr.children[2].textContent = evt.resultPreview && /skipped/i.test(evt.resultPreview) ? 'skipped' : 'done';
      tr.children[3].textContent = String(evt.iterations ?? 0);
      tr.children[4].textContent = evt.resultPreview || '';
      break;
    }
    case 'STEP_FAILED': {
      const tr = tbody.querySelector(`tr[data-step-id="${evt.stepId}"]`);
      if (!tr) return;
      tr.children[2].textContent = 'failed';
      tr.style.backgroundColor = '#fee';
      tr.children[4].textContent = evt.error || '(no error message)';
      break;
    }
    case 'EXECUTION_DONE': {
      // Container stays visible for post-mortem review.
      break;
    }
  }
}

function renderExecutionTimeline(steps) {
  const container = document.getElementById('executionTimeline');
  if (!container) return;
  container.innerHTML = '';

  const timeline = document.createElement('div');
  timeline.className = 'timeline';

  steps.forEach((step, idx) => {
    const node = document.createElement('div');
    let statusClass = 'success';
    if (step.skipped) statusClass = 'skipped';
    else if (wizardState.lastErrorStepId === step.stepId) statusClass = 'error';
    node.className = `timeline-node ${statusClass}`;
    node.innerHTML = `
      <div class="timeline-marker">${idx + 1}</div>
      <div class="timeline-content">
        <div class="timeline-title">${escapeHtml(step.stepName)}</div>
        <div class="timeline-meta">
          ${step.skipped ? `Skipped: ${step.skipReason}` : 'Completed'}
          ${step.result ? ' | Result: ' + JSON.stringify(step.result).slice(0, 60) + '...' : ''}
        </div>
        ${step.snapshot ? '<button class="btn-view-snapshot" data-idx="' + idx + '">View Snapshot</button>' : ''}
      </div>
    `;
    timeline.appendChild(node);
  });

  container.appendChild(timeline);

  timeline.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-view-snapshot')) {
      const idx = parseInt(e.target.dataset.idx);
      showSnapshot(steps[idx].snapshot);
    }
  });
}

function showSnapshot(snapshot) {
  const modal = document.getElementById('snapshotModal');
  const content = document.getElementById('snapshotContent');
  if (!modal || !content) return;
  content.textContent = JSON.stringify(snapshot, null, 2);
  modal.classList.remove('hidden');
}

async function getCandidateSelectors(config, pageInfo, postPageInfo) {
  const client = new LLMClient(config);
  let prompt = `Analyze this page and identify key elements needed for a scraping workflow.

URL: ${pageInfo.url}
Requirements: ${pageInfo.description}

Page compressed structure (initial state):
${pageInfo.structure}`;

  if (postPageInfo) {
    prompt += `

Page compressed structure (after interaction):
${postPageInfo.structure}

Note: The page state changes after interaction. Identify elements needed for BOTH the interaction steps (from initial state) and the extraction steps (from post-interaction state).`;
  }

  prompt += `

Return JSON with:
- candidateSelectors: array of { purpose, selector, confidence }
- needsAnnotation: boolean (true if any confidence < 0.7)`;

  const result = await client.chat([
    { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping expert. Return JSON only.') },
    { role: 'user', content: prompt }
  ], { jsonMode: true });

  const cleaned = cleanLLMResponse(result);
  let parsed;
  try {
    parsed = parseLLMJson(cleaned, 'getCandidateSelectors', result);
  } catch (e) {
    const err = new Error('getCandidateSelectors returned malformed JSON: ' + e.message);
    err.rawLLMOutput = cleaned.slice(0, 500);
    throw err;
  }
  return parsed;
}

async function confirmSelectorsWithFullHtml(tabId, config, candidates, pageInfo) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'GET_ELEMENTS_HTML',
    selectors: candidates.map(c => c.selector)
  });

  const client = new LLMClient(config);
  // RC54 (console.log 2026-08-14 13:51-13:5x): embedding raw outerHTML here
  // produced a 756,464-token prompt — container candidates repeat the whole
  // rendered feed, and attempt 1 timed out at 120s (attempt 2 survived at
  // ~78s by luck). formatElementsForPrompt caps each element (30K chars,
  // [TRUNCATED] marker) and the total section (200K chars, [SKIPPED] keeps
  // every selector listed).
  const prompt = `Confirm these selectors using the full element HTML.

URL: ${pageInfo.url}
Requirements: ${pageInfo.description}

Elements:
${formatElementsForPrompt(response.elements)}

Return JSON with:
- confirmedSelectors: array of { purpose, selector, status: "confirmed"|"revised", revisedSelector? }`;

  // RC52 (console.log 2026-08-14 12:59-13:04): this call embeds element
  // HTML for every candidate selector — among the largest prompts in the
  // wizard flow (136,953 tokens observed even before RC54). With the 4096
  // default the model burned the whole completion budget without emitting
  // parseable content (finish_reason: length, empty content), and the
  // deterministic failure retried 4x before surfacing LLMRetryExhausted.
  // RC53: no call-site budget — the completion budget is the Settings-page
  // maxOutputTokens config parameter, falling back to 8192 in llm-client
  // (options.maxTokens ?? config ?? 8192).
  const result = await client.chat([
    { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping expert. Return JSON only.') },
    { role: 'user', content: prompt }
  ], { jsonMode: true });

  const cleaned = cleanLLMResponse(result);
  let parsed;
  try {
    parsed = parseLLMJson(cleaned, 'confirmSelectorsWithFullHtml', result);
  } catch (e) {
    const err = new Error('confirmSelectorsWithFullHtml returned malformed JSON: ' + e.message);
    err.rawLLMOutput = cleaned.slice(0, 500);
    throw err;
  }
  return parsed;
}

async function generateStepsWithSelectors(config, pageInfo, confirmedSelectors, postPageInfo, detailPageInfo) {
  const client = new LLMClient(config);
  let prompt = `${buildUrlTemplateNotice(wizardState.targetUrl)}${SCRIPT_DSL_GUIDE}

Create a web scraping workflow for this page.

URL: ${pageInfo.url}
Requirements: ${pageInfo.description}

Confirmed element selectors:
${confirmedSelectors.map(s => `- ${s.purpose}: ${s.status === 'revised' ? s.revisedSelector : s.selector}`).join('\n')}

Page compressed structure (initial state):
${pageInfo.structure}`;

  if (postPageInfo) {
    prompt += `

Page compressed structure (after interaction):
${postPageInfo.structure}

IMPORTANT: The page changes after interaction. Generate steps that:
1. Use the INITIAL state for input/interaction steps (typing, clicking submit buttons)
2. Use the POST-INTERACTION state for wait/extract steps (waiting for results to appear, extracting answer content)
3. Include proper delays using 'await new Promise(r => setTimeout(r, ms))' when waiting for dynamic content`;
  }

  prompt += `

${buildTimeoutGuidance(DEPLOY_TIMEOUT_MS).text}

WAITING FOR DYNAMIC CONTENT:
When a step needs to wait for dynamic content (e.g., AI response, search results), make it a POLL step:
1. Set onSuccess to the NEXT step (e.g. the extraction step that runs once the content is ready) — NOT to itself.
2. Set maxIterations high enough (e.g., 20-30) to allow the content to appear.
3. Return { done: false } while the content is NOT ready — the orchestrator re-runs THIS step (up to maxIterations times).
4. Return the extracted data (or { done: true }) when ready — the orchestrator follows onSuccess to the next step.
5. Always return an object with a boolean flag; do NOT return false/null to mean "not ready".

CORRECT: a wait step with onSuccess: "extract", maxIterations: 30, returning { done: false } until ready, then { done: true } or the data.
Do NOT use "SELF" — it is no longer supported and will be rejected. Do NOT point onSuccess at the wait step itself.

AI CHAT COMPLETION DETECTION:
For AI chat sites (submit question, wait for streaming response), the wait step MUST detect when generation finishes.
Look at the page snapshot for specific loading/generating indicator class names (e.g., "generating-indicator", "my-spinner").
The correct pattern is to wait for these indicators to DISAPPEAR:
  const stillLoading = await $exists('.generating-indicator, .loading-spinner', 3000);
  return { done: !stillLoading };
DO NOT use "submit button exists" as a completion signal — the submit button is typically always visible on AI chat sites.
DO NOT use wildcard selectors like [class*="loading"] — they match unrelated page elements and cause infinite loops. Use only specific class names from the page snapshot.

Return JSON with:
- steps: array of { id, name, script, condition (optional), onSuccess, onFailure, maxIterations, entryUrl (URL string, optional) }
- inputSchema: JSON Schema object
- outputSchema: JSON Schema object
- sampleInput: JSON object with example values

JSON ESCAPING (CRITICAL — failures here abort the wizard):
The "script" field is a JSON string. Any " character INSIDE the JS code must be escaped as \". This applies even when the " is inside a JS single-quoted string — JSON does not care that JS treats '...' as a string.
CORRECT (note the backslashes before each inner "):
"script": "const c = await $count('li[data-id=\\\"item-1\\\"]'); return { done: c > 0 };"
WRONG (bare " inside the value — JSON.parse terminates the string at the first one):
"script": "const c = await $count('li[data-id=\"item-1\"]');"
Tip: when a CSS attribute value is a bare word (no spaces), prefer the unquoted form to sidestep the issue entirely — [data-id=item-1] instead of [data-id="item-1"].

Use "TERMINATE" to end. Do NOT use "SELF" (no longer supported). For loops/waits, set maxIterations>1 and return { done: false } to retry the same step.

LIST-TO-DETAIL PATTERN:
Scrape a list and visit each item's detail page using a single self-polling step that carries state across retries via __lastResult__:
1. Step A (collect): gather all item links → return { items: [{ href, text }, ...], index: 0, results: [] }
2. Step B (onSuccess: "TERMINATE", onFailure: "TERMINATE", maxIterations: N): each run reads __lastResult__; if index < items.length, take items[index], $openTab(item.href, async () => { ... }) to scrape that detail, append to results, increment index, and return { done: false, items, index, results } (the orchestrator retries → next item). Once index >= items.length, return { done: true, results } (or just results) → onSuccess ends the run.
Do NOT use __input__._state or closures for cross-step state — use __stepResults__ and __lastResult__.

OPTIONAL STEP FIELDS (new):
- entryUrl: URL to help reach the target page state during annotation (only include if determinable from current page; leave empty for pages requiring user navigation/clicks to reach)
- needsAnnotation: true if this step's target page was NOT seen during research and requires user annotation to generate accurate script. In that case, set script to "// PENDING_ANNOTATION" placeholder.`;

  if (detailPageInfo) {
    prompt += `

DETAIL PAGE STRUCTURE (for $openTab sub-scripts):
When using $openTab to scrape detail pages, the detail page has this structure:
${detailPageInfo.structure}

Detail page text:
${detailPageInfo.textSummary}

IMPORTANT: Use selectors from the DETAIL PAGE STRUCTURE above for any $openTab sub-scripts.
Do NOT guess selectors — use the exact class names, IDs, and tags you see in the detail page structure.`;
  }

  if (detailPageInfo && detailPageInfo.url) {
    prompt += `

Sample detail page URL (use as entryUrl for detail-page steps): ${detailPageInfo.url}`;
  }

  const result = await client.chat([
    { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping expert. Return JSON only.') },
    { role: 'user', content: prompt }
  ], { jsonMode: true });

  wizardState.llmHistory.push(
    { role: 'user', content: summarizeStepsGeneration({
        url: wizardState.targetUrl,
        description: wizardState.description,
        htmlFingerprint: (() => {
          const DomCleanerForFp = (typeof window !== 'undefined' && window.DomCleaner)
            || (typeof global !== 'undefined' && global.DomCleaner)
            || (typeof require === 'function' ? require('./lib/dom-cleaner.js') : null);
          const struct = (pageInfo && pageInfo.structure) || (postPageInfo && postPageInfo.structure) || '';
          return DomCleanerForFp && struct ? DomCleanerForFp.htmlFingerprint(struct) : '(unavailable)';
        })(),
        confirmedSelectors: confirmedSelectors || []
      }) },
    { role: 'assistant', content: summarizeGeneratedSteps(result) }
  );
  trimLlmHistory();

  const cleaned = cleanLLMResponse(result);
  let parsed;
  try {
    parsed = parseLLMJson(cleaned, 'generateStepsWithSelectors', result);
  } catch (e) {
    debugLogger.log('error', 'wizard', 'Step generation (generateStepsWithSelectors) failed', { error: e.message, stack: e.stack, rawLLMOutput: cleaned.slice(0, 500) });
    const err = new Error('generateStepsWithSelectors returned malformed JSON: ' + e.message);
    err.rawLLMOutput = cleaned.slice(0, 500);
    throw err;
  }
  return parsed;
}

async function generateStepScript(config, step, pageInfo, annotations, stepContext, currentScript = '') {
  // TRUST BOUNDARY: pageInfo (cleaned page HTML) and annotations are untrusted
  // data — they come from the target page. They are concatenated into the LLM
  // prompt below, and the LLM's response is run via new Function() in the
  // sandbox. A malicious target page could attempt prompt injection via its
  // HTML.
  //
  // Accepted risk: generated services are private to the user who created
  // them (never shared across users). The target page already has same-origin
  // access to itself in its own scripts, so prompt-injection only re-exfiltrates
  // data the page could already exfiltrate on its own. We do NOT currently
  // sanitize HTML before embedding or strip network calls from generated
  // scripts. If services ever become shareable across users, revisit this.
  const client = new LLMClient(config);

  const hasKeyValue = annotations.some(a => a.type === 'key' || a.type === 'value');

  const annotationsText = buildAnnotationsText(annotations);

  // Cap the snapshot before building the initial-generation prompt — the first
  // attempt is the most likely to overflow because it sends the full HTML.
  pageInfo = truncateSnapshotForLLM(pageInfo);

  let pageInfoBlock;
  if (pageInfo.mode === 'full') {
    pageInfoBlock = 'Full HTML (cleaned):\n' + pageInfo.html;
  } else {
    const contextsBlock = (pageInfo.contexts || []).map(c => '--- ' + (c.selector || 'unknown') + ' ---\n' + (c.context || '(no context)')).join('\n\n');
    pageInfoBlock = 'Annotated element contexts:\n' + contextsBlock + '\n\nGlobal structure summary:\n' + (pageInfo.structure || '');
  }

  // Framework prompts stay domain-agnostic. Concrete label/value examples
  // come from runtime annotations and LLM-generated site-specific scripts,
  // never from this template.
  const keyValueGuidance = hasKeyValue ? `

KEY/VALUE PAIRING (for table extraction):
Do NOT assume linear pairing. Infer key-value pairs using BOTH:
1. DOM structure (same row/group, position — same <tr> or <dl>)
2. Content semantics — does the value's text fit the key's implied type? (e.g., a count label pairs with a number; a date label pairs with a date-formatted value; a name label pairs with a proper noun)
Do not blindly pair nth key with nth value — verify via dual signals above.
` : '';

  // Re-annotation refinement (2026-08-05). When currentScript is non-empty,
  // the user is re-annotating a step that already has a script (possibly
  // refined via autoFix). Include it as a baseline so refinements are
  // preserved instead of silently overwritten. Empty (first-time annotation)
  // leaves the prompt unchanged.
  const currentScriptSection = currentScript
    ? `[CURRENT SCRIPT] (previous version — refine, don't blindly copy)
${currentScript}

`
    : '';

  const refinementGuide = currentScript
    ? `
Refine the current script:
- For fields the user did NOT re-annotate: keep existing extraction logic
- For fields the user DID re-annotate: update selectors to match new annotations
- For NEW annotations (no matching field in current script): ADD extraction
- If a current-script selector conflicts with a new annotation, the annotation wins

`
    : '';

  const prompt = `${buildUrlTemplateNotice(wizardState.targetUrl)}${SCRIPT_DSL_GUIDE}

Generate the script for a SINGLE step in an existing scraping workflow.

[STEP CONTEXT]
Step ID: ${step.id}
Step name: ${step.name || '(unnamed)'}
Entry URL (annotation start point): ${step.entryUrl || '(not set)'}

Position in workflow:
- Previous steps: ${stepContext.previousStepsSchema}
- Next steps depend on this step's output: ${stepContext.nextStepsDescription}

${currentScriptSection}[ANNOTATIONS]
User annotated the following elements on the current page:
${annotationsText}
${keyValueGuidance}
${refinementGuide}[CURRENT PAGE]
${pageInfoBlock}

Return JSON with:
- script: string (JavaScript code using $ API)
- revisedAnnotations: array (optional, only if selectors need adjustment based on actual page structure)

Only generate this step's script. Do not modify other steps.`;

  const globalContext = (stepContext.globalDescription || '').trim()
    ? `\n\n[GLOBAL CONTEXT]\nThe user's original scraping requirement:\n"${stepContext.globalDescription}"\n[/GLOBAL CONTEXT]`
    : '';

  const result = await client.chat([
    { role: 'system', content: 'You are a web scraping expert. Return JSON only.' + globalContext },
    { role: 'user', content: prompt }
  ], { jsonMode: true });

  wizardState.llmHistory.push(
    { role: 'user', content: (() => {
        const DomCleanerForFp = (typeof window !== 'undefined' && window.DomCleaner)
          || (typeof global !== 'undefined' && global.DomCleaner)
          || (typeof require === 'function' ? require('./lib/dom-cleaner.js') : null);
        const struct = (pageInfo && pageInfo.structure) || '';
        const fp = DomCleanerForFp && struct ? DomCleanerForFp.htmlFingerprint(struct) : '(unavailable)';
        // Reuse summarizeStepsGeneration shape; carry step id/name in description.
        return summarizeStepsGeneration({
          url: wizardState.targetUrl,
          description: '[Step Script Gen ' + step.id + '] ' + (step.name || '') + (stepContext && stepContext.globalDescription ? ' — ' + stepContext.globalDescription : ''),
          htmlFingerprint: fp,
          confirmedSelectors: (annotations || []).map(a => ({
            purpose: a.purpose || a.type || '(annotation)',
            selector: a.selector || a.revisedSelector || '',
            status: a.status || 'confirmed',
            revisedSelector: a.revisedSelector
          }))
        });
      })() },
    { role: 'assistant', content: summarizeGeneratedSteps(result) }
  );
  trimLlmHistory();

  const cleaned = cleanLLMResponse(result);
  let parsed;
  try {
    parsed = parseLLMJson(cleaned, 'generateStepScript', result);
  } catch (e) {
    const err = new Error('LLM returned malformed JSON: ' + e.message);
    err.rawLLMOutput = cleaned.slice(0, 500);
    throw err;
  }
  return parsed;
}

async function generateExplorationScript(config, pageInfo) {
  const client = new LLMClient(config);
  const prompt = `${SCRIPT_DSL_GUIDE}

Analyze this page and determine if interaction is needed to reach the desired content for scraping.

URL: ${pageInfo.url}
Requirements: ${pageInfo.description}

Page compressed structure:
${pageInfo.structure}

If the page requires interaction (typing input, clicking buttons, submitting forms, navigating, etc.) to reach the content the user wants to scrape, generate an exploration script.

The exploration script should:
1. Use the $ API ($type, $click, $wait, etc.) to interact with the page
2. ALWAYS include the COMPLETE interaction sequence: type input AND click submit/send button (or trigger submission). NEVER stop after just typing — you MUST submit the form/send the question.
3. Do NOT wait for full dynamic content to finish loading — the script must complete within 30 seconds
4. Use short fixed delays (2-5s) after interaction, not long polling loops
5. For chat/AI sites: type the question AND click the send/submit button. Do NOT skip the submit step.

Return JSON with:
- needsExploration: boolean (true if the page needs interaction to reach target content)
- explorationScript: string (JavaScript code using $ API, or empty string if not needed)
- sampleInput: object (example input values for exploration, e.g. { query: "What is 2+2?" })
- description: string (brief human-readable description of what the script does)
- targetUrlTemplate: string or null (see URL Template Detection below)

URL Template Detection (optional). If the user's Page Operations *explicitly* describe substituting part of the URL with an input parameter (e.g., "replace 'keyword' in the URL with the input keyword" or "open URL with parameter page=N"), return a targetUrlTemplate derived from the URL by replacing the relevant substring with {{paramName}} — where paramName matches the input parameter name from the requirements. Examples:
- URL https://example.com/search?q=keyword + user says "replace keyword with input keyword" → targetUrlTemplate: "https://example.com/search?q={{keyword}}"
- URL https://example.com/list?page=1 + user says "go to page N" → targetUrlTemplate: "https://example.com/list?page={{pageNumber}}"

Do NOT infer templates from implicit patterns like "search for keyword" or "show results for X" — only extract when the user *explicitly* describes URL rewriting. When in doubt, return null. Returning a wrong template breaks the service; returning null falls back to the safe type/click flow.`;

  // RC52/RC53: this prompt embeds the full DSL guide — a 4096 completion cap
  // can deterministically fail with finish_reason:length (see the
  // confirmSelectorsWithFullHtml note). Budget now comes from the Settings
  // maxOutputTokens config (llm-client fallback 8192).
  const result = await client.chat([
    { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping expert. Return JSON only.') },
    { role: 'user', content: prompt }
  ], { jsonMode: true });

  return parseLLMJson(cleanLLMResponse(result), 'generateExplorationScript', result);
}

async function explorePageInteraction(tabId, script, sampleInput) {
  const executor = new OffscreenExecutor(tabId);
  executor.timeoutMs = 60000;

  debugLogger.log('info', 'wizard', 'Starting exploration', { tabId, explorationScript: script, scriptLength: script?.length, sampleInput });

  try {
    await executor.execute(script, sampleInput);
    debugLogger.log('info', 'wizard', 'Exploration script completed, waiting for page to settle');
  } catch (e) {
    debugLogger.log('warn', 'wizard', 'Exploration script failed, continuing anyway', { error: e.message });
  }

  // RC58: poll-based settle wait (compressed snapshot key) replaces the old
  // fixed 30s sleep — settled pages continue in ~3s, worst case unchanged.
  showLoading('Waiting for page to settle (up to 30s)...');
  const settle = await waitForPageSettle(async () => {
    const r = await sendMessageWithRetry(tabId, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' }, 2);
    const s = r && r.snapshot;
    return (s && s.structure ? s.structure.length : 0) + ':' + (s && s.textSummary ? s.textSummary.length : 0);
  }, { maxMs: 30000, pollMs: 1500, stableCount: 2 });
  debugLogger.log('info', 'wizard', 'Post-exploration settle', { settled: settle.settled, polls: settle.polls });

  let response;
  try {
    response = await sendMessageWithRetry(tabId, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' }, 5);
  } catch (e) {
    debugLogger.log('error', 'wizard', 'Failed to capture post-interaction snapshot', { error: e.message });
    return null;
  }

  debugLogger.log('info', 'wizard', 'Post-interaction snapshot captured', {
    structureLength: response.snapshot?.structure?.length,
    textSummaryLength: response.snapshot?.textSummary?.length
  });

  return {
    url: wizardState.targetUrl,
    structure: response.snapshot.structure || '',
    textSummary: response.snapshot.textSummary || ''
  };
}

async function onRunExploration() {
  const exploration = wizardState.explorationData;
  if (!exploration) return;

  let sampleInput;
  try {
    sampleInput = JSON.parse(document.getElementById('explorationSampleInput').value);
  } catch (e) {
    showToast('Invalid JSON in sample input: ' + e.message, 'error');
    return;
  }

  document.getElementById('explorationPanel').classList.add('hidden');
  showLoading('Running exploration...');

  const tabId = wizardState.researchTabId;
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  const pageInfo = wizardState.researchPageInfo;

  let postPageInfo = null;
  try {
    postPageInfo = await explorePageInteraction(tabId, exploration.explorationScript, sampleInput);
  } catch (e) {
    console.error('Exploration failed:', e);
    showToast('Exploration failed: ' + e.message + '. Continuing with initial snapshot only.', 'error', 5000);
  }

  await continueResearch(tabId, config.config, pageInfo, postPageInfo);
}

async function onSkipExploration() {
  document.getElementById('explorationPanel').classList.add('hidden');
  const tabId = wizardState.researchTabId;
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  await continueResearch(tabId, config.config, wizardState.researchPageInfo, null);
}

async function continueResearch(tabId, config, pageInfo, postPageInfo) {
  showLoading('Researching page (Round 1/2)...');

  let round1;
  try {
    round1 = await getCandidateSelectors(config, pageInfo, postPageInfo);
    debugLogger.log('info', 'wizard', 'Round 1 candidate selectors', {
      needsAnnotation: round1.needsAnnotation,
      candidateCount: (round1.candidateSelectors || []).length,
      candidates: round1.candidateSelectors
    });
  } catch (e) {
    debugLogger.log('error', 'wizard', 'Round 1 (getCandidateSelectors) failed', {
      error: e.message, stack: e.stack, rawLLMOutput: e.rawLLMOutput
    });
    showToast('Research Round 1 failed: ' + e.message, 'error', 5000);
    hideLoading();
    return;
  }

  showLoading('Researching page (Round 2/2)...');

  let round2;
  try {
    round2 = await confirmSelectorsWithFullHtml(tabId, config, round1.candidateSelectors || [], pageInfo);
    debugLogger.log('info', 'wizard', 'Round 2 confirmed selectors', {
      confirmedCount: (round2.confirmedSelectors || []).length,
      confirmedSelectors: round2.confirmedSelectors
    });
  } catch (e) {
    debugLogger.log('error', 'wizard', 'Round 2 (confirmSelectorsWithFullHtml) failed', {
      error: e.message, stack: e.stack, rawLLMOutput: e.rawLLMOutput
    });
    showToast('Research Round 2 failed: ' + e.message, 'error', 5000);
    hideLoading();
    return;
  }

  const confirmedSelectors = (round2.confirmedSelectors || []).map(s => ({
    ...s,
    selector: s.status === 'revised' ? s.revisedSelector : s.selector
  }));
  wizardState.confirmedSelectors = confirmedSelectors;
  debugLogger.log('info', 'wizard', 'Confirmed selectors', { confirmedSelectors });

  // Detect list-to-detail pattern: if selectors include link/href elements,
  // capture a sample detail page snapshot so the LLM can generate correct selectors
  let detailPageInfo = null;
  const hasLinkSelector = confirmedSelectors.some(s =>
    s.purpose?.toLowerCase().includes('link') ||
    s.purpose?.toLowerCase().includes('href') ||
    s.purpose?.toLowerCase().includes('url') ||
    s.purpose?.toLowerCase().includes('detail')
  );

  if (hasLinkSelector) {
    try {
      const linkSelector = confirmedSelectors.find(s =>
        s.purpose?.toLowerCase().includes('link') ||
        s.purpose?.toLowerCase().includes('href') ||
        s.purpose?.toLowerCase().includes('url') ||
        s.purpose?.toLowerCase().includes('detail')
      );
      let detailUrl = null;
      // Primary: extract href directly from the tab's DOM
      if (linkSelector?.selector) {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (selector) => {
            const el = document.querySelector(selector);
            if (el) return el.getAttribute('href') || el.href || null;
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
              try {
                const doc = iframe.contentDocument;
                const found = doc?.querySelector(selector);
                if (found) return found.getAttribute('href') || found.href || null;
              } catch {}
            }
            return null;
          },
          args: [linkSelector.selector]
        });
        detailUrl = results?.[0]?.result;
      }
      // No fallback: previously we ran /href="([^"]+)"/ on pageInfo.structure
      // to grab "any href" as detailUrl. On most pages the first href in the
      // compressed structure is the homepage nav link, so the wizard opened
      // the homepage, captured its snapshot as the "detail page", and the
      // LLM generated selectors for the WRONG page (observed in bugx.log:
      // detailUrl='https://www.facebook.com/' for a search-results task). If
      // the link selector didn't resolve a real href, there is no reliable
      // detail URL — pass null and let generateStepsWithSelectors proceed
      // without a detail snapshot.
      if (detailUrl) {
        // Defensive guard: detailUrl came from a DOM result via
        // results?.[0]?.result — never trust the shape. Non-string values
        // would crash chrome.tabs.create ("Invalid type: expected string").
        if (typeof detailUrl !== 'string') {
          debugLogger.log('warn', 'wizard', 'Skipping detail snapshot in step-gen — detailUrl is not a string', {
            detailUrlType: typeof detailUrl,
            detailUrlPreview: String(detailUrl).slice(0, 100)
          });
          detailUrl = null;
        } else if (!detailUrl.startsWith('http')) {
          // Relative URL — resolve against the page's URL.
          try {
            detailUrl = new URL(detailUrl, pageInfo.url).href;
          } catch (_) {
            debugLogger.log('warn', 'wizard', 'Skipping detail snapshot — could not resolve relative detailUrl', {
              detailUrlPreview: detailUrl.slice(0, 100),
              base: pageInfo.url
            });
            detailUrl = null;
          }
        }
      }
      if (detailUrl) {
        showLoading('Capturing detail page structure...');
        const detailTab = await createScrapeTab(detailUrl);
        // RC58: poll-based settle wait (cap 10s) replaces a fixed 8s sleep.
        await waitForPageSettle(async () => {
          const r = await chrome.tabs.sendMessage(detailTab.id, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' });
          const s = r && r.snapshot;
          return (s && s.structure ? s.structure.length : 0) + ':' + (s && s.textSummary ? s.textSummary.length : 0);
        }, { maxMs: 10000, pollMs: 1000, stableCount: 2 });
        const detailResponse = await chrome.tabs.sendMessage(detailTab.id, {
          type: 'GET_DOM_SNAPSHOT', mode: 'compressed'
        });
        detailPageInfo = detailResponse?.snapshot;
        debugLogger.log('info', 'wizard', 'Captured detail page snapshot for step generation', {
          url: detailUrl, structureLength: detailPageInfo?.structure?.length
        });
        await chrome.tabs.remove(detailTab.id).catch(() => {});
      }
    } catch (e) {
      console.warn('Could not capture detail page snapshot:', e);
    }
  }

  showLoading('Generating steps...');

  try {
    const parsed = await generateStepsWithSelectors(config, pageInfo, confirmedSelectors, postPageInfo, detailPageInfo);
    debugLogger.log('info', 'wizard', 'generateStepsWithSelectors parsed result', {
      parsedKeys: Object.keys(parsed),
      hasSteps: Array.isArray(parsed.steps),
      stepCount: parsed.steps?.length || 0
    });
    wizardState.steps = fillEntryUrlDefaults(parsed.steps || [], pageInfo.url);
    // Deterministic topology heal: a step whose script signals polling but
    // omitted maxIterations (generation couldn't know the page needed polling)
    // gets a default retry budget now, so the first test already polls correctly.
    const genHeal = normalizeStepTopology(wizardState.steps);
    if (genHeal.changed.length) {
      appendLog('Set default retry budget (maxIterations) on poll step(s) that omitted it: ' + genHeal.changed.map(c => c.id).join(', '), 'info');
    }
    wizardState.inputSchema = parsed.inputSchema || { type: 'object' };
    wizardState.outputSchema = parsed.outputSchema || { type: 'object' };
    wizardState.sampleInput = parsed.sampleInput || {};
    debugLogger.log('info', 'wizard', 'Generated steps', {
      steps: parsed.steps,
      inputSchema: parsed.inputSchema,
      outputSchema: parsed.outputSchema,
      sampleInput: parsed.sampleInput
    });
    goToPhase(2);
  } catch (e) {
    debugLogger.log('error', 'wizard', 'Step generation (generateStepsWithSelectors) failed', {
      error: e.message, stack: e.stack, rawLLMOutput: e.rawLLMOutput
    });
    showToast('Step generation failed: ' + e.message, 'error', 5000);
  } finally {
    hideLoading();
  }
}

async function startResearch() {
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  if (!config.config) {
    showToast('Please configure LLM in Options first', 'error');
    return;
  }

  // Read the three structured requirement fields. pageOps is the essential
  // operational description — without it the LLM has no task context.
  const inputParams = (document.getElementById('reqInputParams').value || '').trim();
  const pageOps = (document.getElementById('reqPageOps').value || '').trim();
  const outputStruct = (document.getElementById('reqOutputStruct').value || '').trim();
  if (!pageOps) {
    showToast('Please describe the page operations and data to collect before researching', 'error', 5000);
    return;
  }
  // Re-read targetUrl here because the URL field now lives on the same phase-1
  // screen as the requirement fields and may have been edited after load.
  wizardState.targetUrl = document.getElementById('targetUrl').value;
  wizardState.requirements = { inputParams, pageOps, outputStruct };
  wizardState.description = buildRequirementsBlock(wizardState.requirements);
  if (!wizardState.userDescription) wizardState.userDescription = wizardState.description;

  // Background scrape tab (createScrapeTab) with visibility-keepalive
  // injection; rendering-dependent ops later go through sticky activation.
  const tab = await createScrapeTab(wizardState.targetUrl);
  wizardState.researchTabId = tab.id;

  try {
    await waitForTabLoad(tab.id);
  } catch (e) {
    showToast('Page failed to load: ' + e.message, 'error');
    return;
  }

  let response;
  try {
    response = await sendMessageWithRetry(tab.id, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' }, 5);
  } catch (e) {
    showToast('Failed to capture page snapshot: ' + e.message, 'error');
    return;
  }

  showLoading('Analyzing page for exploration needs...');

  const pageInfo = {
    url: wizardState.targetUrl,
    description: wizardState.description,
    structure: response.snapshot.structure || ''
  };
  wizardState.researchPageInfo = pageInfo;

  let exploration;
  try {
    exploration = await generateExplorationScript(config.config, pageInfo);
  } catch (e) {
    console.error('Exploration script generation failed:', e);
    showToast('Failed to generate exploration script: ' + e.message + '. Continuing without exploration.', 'error', 5000);
    hideLoading();
    await continueResearch(tab.id, config.config, pageInfo, null);
    return;
  }

  if (exploration.targetUrlTemplate && exploration.targetUrlTemplate !== wizardState.targetUrl) {
    wizardState.targetUrl = exploration.targetUrlTemplate;
    const urlInput = document.getElementById('targetUrl');
    if (urlInput) urlInput.value = exploration.targetUrlTemplate;
    wizardState.researchSampleInput = exploration.sampleInput;
    updateUrlTemplateHint(exploration.sampleInput);
    console.log('Applied targetUrlTemplate from Research:', exploration.targetUrlTemplate);
  } else {
    wizardState.researchSampleInput = exploration.sampleInput;
    updateUrlTemplateHint(exploration.sampleInput);
  }

  if (!exploration.needsExploration || !exploration.explorationScript) {
    hideLoading();
    await continueResearch(tab.id, config.config, pageInfo, null);
    return;
  }

  wizardState.explorationData = exploration;

  // Show exploration UI
  hideLoading();
  document.getElementById('explorationDescription').textContent = exploration.description || 'The AI suggests interacting with this page to reach the target content.';
  document.getElementById('explorationSampleInput').value = JSON.stringify(exploration.sampleInput || { query: 'What is 2+2?' }, null, 2);
  document.getElementById('explorationPanel').classList.remove('hidden');

  showToast('Review the exploration plan and sample input, then click Run Exploration.', 'info', 5000);
}

async function runTestFromStep5() {
  wizardState.testAborted = false;
  const parsed = validateTestInput(
    document.getElementById('inputSchemaEditor').value,
    document.getElementById('outputSchemaEditor').value,
    document.getElementById('testInputEditor').value
  );
  if (!parsed.valid) {
    showToast('Invalid JSON in schema or test input: ' + parsed.error, 'error');
    return;
  }
  wizardState.inputSchema = parsed.inputSchema;
  wizardState.outputSchema = parsed.outputSchema;
  wizardState.testInput = parsed.testInput;
  goToPhase(4);
  document.getElementById('executionLog').innerHTML = '';
  appendLog('Starting test...');
  await testScript();
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

async function testScript() {
  // Reset failure tracking so callers can detect success/failure by reading
  // wizardState.lastError after testScript returns. autoFix's retry loop
  // relies on this.
  wizardState.lastError = null;
  wizardState.lastErrorStepId = null;
  wizardState.lastErrorSnapshot = null;
  wizardState.lastExecutionEvents = [];
  wizardState.testAbortController = new AbortController();
  // RC25 (console.log 2026-08-04): reset trusted-wheel skip counter at the
  // start of each testScript run. Counter is incremented by the
  // TRUSTED_WHEEL_SKIPPED broadcast listener; surfaced as a tip after run.
  wizardState.trustedWheelSkipCount = 0;
  // RC11: only clear bestAttempt when the user explicitly re-runs the test
  // (btnRetryTest). When testScript is invoked from INSIDE autoFix (via
  // runFixIteration → line ~2866), clearing bestAttempt here would wipe the
  // prior iteration's tracked score BEFORE the scoring loop can compare.
  // That defeats the restore-on-regression logic for both the silent-retry
  // path (silent retries that previously scored > 0) and the user-feedback
  // path (prior submission's working state preserved across calls).
  // wizardState.autoFixing is true throughout the autoFix call (set at the
  // top, restored in finally), so it's a reliable "called from autoFix"
  // signal.
  if (!wizardState.autoFixing) {
    wizardState.bestAttempt = null;
    wizardState.dismissedInterventions = null;
  }
  clearInterventionBanner();
  debugLogger.log('info', 'wizard', 'testScript start', {
    targetUrl: wizardState.targetUrl,
    stepCount: wizardState.steps?.length,
    testInput: wizardState.testInput
  });

  // Acquire ExecutionQueue lock from background so wizard testScript never
  // runs concurrently with an API job (shared offscreen/sandbox/tabIdStack
  // would cross-contaminate DOM requests between the two tabs).
  try {
    await chrome.runtime.sendMessage({ type: 'ACQUIRE_EXEC_LOCK' });
  } catch (e) {
    debugLogger.log('warn', 'wizard', 'Could not acquire exec lock (background may be unavailable)', { error: e.message });
  }

  let tab = null;
  try {
    const service = {
      targetUrl: wizardState.targetUrl,
      steps: wizardState.steps,
      config: { timeoutMs: DEPLOY_TIMEOUT_MS, maxRetries: 0, autoCloseTab: true, maxStepIterations: 50, tabLoadTimeoutMs: 60000 }
    };

    appendLog('Starting step execution...');

    const result = await StepOrchestrator.execute(service, wizardState.testInput || {}, {
      createTab: async (url) => {
        // Background tab via createScrapeTab (RC20 removed the popup path);
        // rendering is handled by the five-layer throttle stack — sticky
        // activation wraps input-required ops.
        tab = await withTimeout(createScrapeTab(url), 10000, 'Failed to create tab (10s timeout)');
        appendLog('Opening ' + url + '...');
        return tab;
      },
      waitForTabLoad: async (tabId) => {
        await withTimeout(waitForTabLoad(tabId), 60000, 'Page load timeout (60s)');
        appendLog('Page loaded.');
        // WS2.1: wait for the content-script to be listening before the first
        // DOM_REQUEST — prevents the RELAY_FAILED (tabId:null) race.
        let ready = false;
        for (let i = 0; i < 20; i++) {
          try {
            const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
            if (r && r.pong) { ready = true; break; }
          } catch (e) { /* not ready yet */ }
          await new Promise(res => setTimeout(res, 300));
        }
        if (!ready) appendLog('Warning: content script not responding; proceeding anyway.');
      },
      resetDomActivity: async (tabId) => {
        await chrome.tabs.sendMessage(tabId, { type: 'RESET_DOM_ACTIVITY' }).catch(() => {});
      },
      getDomActivity: async (tabId) => {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOM_ACTIVITY' });
          return Array.isArray(r?.activities) ? r.activities : [];
        } catch { return []; }
      },
      executeScript: async (tabId, script, input, timeoutMs) => {
        if (wizardState.testAbortController?.signal.aborted) {
          throw new Error('TEST_ABORTED');
        }
        appendLog('Executing script via offscreen...');
        const executor = new OffscreenExecutor(tabId);
        executor.timeoutMs = timeoutMs || 30000;
        return await executor.execute(script, input);
      },
      captureSnapshot: async (tabId) => {
        try {
          const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOM_SNAPSHOT' });
          wizardState.lastSnapshot = response.snapshot;
          return response.snapshot;
        } catch (e) {
          return null;
        }
      },
      evaluateCondition: async (tabId, conditionExpr) => {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (expr) => {
              try { return eval(expr); } catch (e) { return false; }
            },
            args: [conditionExpr]
          });
          return results[0]?.result || false;
        } catch (e) {
          return false;
        }
      },
      removeTab: async (tabId) => {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
    }, {
      onEvent: (evt) => {
        wizardState.lastExecutionEvents.push(evt);
        try { renderExecutionProgress(evt); } catch (_) {}
      }
    });

    wizardState.testResult = result;
    wizardState.lastError = null;
    wizardState.lastErrorStepId = null;
    document.getElementById('testResults').textContent = JSON.stringify(result, null, 2);
    renderResultSummary(result);
    renderPagesViewer(result);
    appendLog('All steps completed successfully.', 'success');
    result.steps.forEach((step, i) => {
      appendLog(`Step ${i + 1} "${step.stepName}": ${step.skipped ? 'skipped (' + step.skipReason + ')' : 'completed'}`, step.skipped ? 'info' : 'success');
    });
    renderExecutionTimeline(result.steps);

    // Always save the last step's snapshot so autoFix has page context.
    // Without this, autoFix runs with an empty snapshot: by the time autoFix
    // fires, testScript has already destroyed the tab, and autoFix's fallback
    // (chrome.tabs.query by targetUrl) finds nothing — observed as
    // "Could not capture snapshot for auto-fix: Receiving end does not exist."
    const lastStep = result.steps[result.steps.length - 1];
    if (lastStep?.snapshot) {
      // Stamp capturedAt so Spec 5 classifyIntervention can compute snapshotAgeMs
      // for the page_state_stale rule. Snapshot itself is shared with other
      // consumers, so we spread-clone rather than mutate.
      wizardState.lastErrorSnapshot = { ...lastStep.snapshot, capturedAt: Date.now() };
    }

    // WS4.2: required-output check against outputSchema (catches "success:true with empty answer").
    const finalData = result.finalResult?.data || result.finalResult;
    // Empty-extraction check runs FIRST and throws on failure, so the LLM
    // gets the strong "fix failing step" prompt via autoFix. We previously
    // let {posts: []} route through validateOutputAgainstSchema's missing-field
    // informational branch — which only updated the UI without throwing, so
    // autoFix never fired and the LLM learned to bypass empty-extraction
    // detection by returning empty arrays (observed in bugx.log).
    const emptyFields = findEmptyExtractionFields(finalData, wizardState.outputSchema);
    if (emptyFields.length > 0) {
      const lastStepEntry = result.steps[result.steps.length - 1];
      // Walk back through pass-through steps to find the actual extraction step.
      // Without this, EMPTY_EXTRACTION is attributed to the LAST step in the
      // chain even when that step is a pure schema-conformance finalizer that
      // just maps over __stepResults__['N'].posts. autoFix would then target
      // the finalizer and never touch the real extractor (console.log
      // 2026-08-06: step6 finalize_output blamed for step4 extract_posts
      // returning {posts:[]} due to an over-aggressive ad filter).
      const nominalStepId = lastStepEntry?.stepId || (wizardState.steps[wizardState.steps.length - 1] && wizardState.steps[wizardState.steps.length - 1].id);
      const extractionStepId = (typeof findUpstreamExtractionStepId === 'function')
        ? findUpstreamExtractionStepId(wizardState.steps, nominalStepId)
        : nominalStepId;
      const err = new Error('EMPTY_EXTRACTION: required field(s) [' + emptyFields.join(', ') + '] are present but every extracted item has only empty values, or no items were extracted at all. The script found list items but the field selectors are wrong.');
      err.stepId = extractionStepId;
      err.snapshot = lastStepEntry?.snapshot || null;
      err.emptyFields = emptyFields;
      debugLogger.log('warn', 'wizard', 'Empty extraction detected — treating as failure', { emptyFields, extractionStepId, nominalStepId });
      throw err;
    }
    // Duplicate-records check: catches the per-record-loop-with-global-sub-selector
    // antipattern (console.log 2026-08-04 04:30:09: 10 identical FB posts reported
    // as SUCCESS because fields weren't empty — they were duplicated). Without
    // this check, the user only discovers the bug by manual inspection. Strict
    // 100% threshold (every record identical) — partial duplicates are surfaced
    // via the user-feedback autoFix path instead.
    const duplicateFields = detectDuplicateRecords(finalData, wizardState.outputSchema);
    if (duplicateFields.length > 0) {
      const lastStepEntry = result.steps[result.steps.length - 1];
      // Same walk-back as EMPTY_EXTRACTION above — duplicate records come from
      // a $extractList-per-record loop using a global sub-selector, not from a
      // pass-through finalizer.
      const nominalStepId = lastStepEntry?.stepId || (wizardState.steps[wizardState.steps.length - 1] && wizardState.steps[wizardState.steps.length - 1].id);
      const extractionStepId = (typeof findUpstreamExtractionStepId === 'function')
        ? findUpstreamExtractionStepId(wizardState.steps, nominalStepId)
        : nominalStepId;
      const summary = duplicateFields.map(d => `${d.field} (${d.totalRecords} records, ${d.uniqueSignatures} unique)`).join('; ');
      const err = new Error('DUPLICATE_RECORDS: array-of-objects output(s) [' + summary + '] are entirely identical across records. The script almost certainly uses a global sub-selector inside a per-record loop — every iteration captured the same first-match values. Use $extractListMulti with per-record sub-selectors (or scope queries via element.querySelector inside the loop).');
      err.stepId = extractionStepId;
      err.snapshot = lastStepEntry?.snapshot || null;
      err.duplicateFields = duplicateFields;
      debugLogger.log('warn', 'wizard', 'Duplicate records detected — treating as failure', { duplicateFields, extractionStepId, nominalStepId });
      throw err;
    }
    const oc = validateOutputAgainstSchema(finalData, wizardState.outputSchema);
    if (!oc.ok) {
      updatePhaseUI('empty-result');
      const gotKeys = (finalData && typeof finalData === 'object' && !Array.isArray(finalData)) ? Object.keys(finalData) : [];
      const wantKeys = (wizardState.outputSchema && wizardState.outputSchema.required) || [];
      debugLogger.log('warn', 'wizard', 'Output schema mismatch', { got: gotKeys, want: wantKeys, missing: oc.missing });
      const tr = document.getElementById('testResults');
      if (tr) tr.textContent += '\n\nOUTPUT SCHEMA MISMATCH:\n  result fields: [' + gotKeys.join(', ') + ']\n  required:     [' + wantKeys.join(', ') + ']\n  missing:      [' + oc.missing.join(', ') + ']\nThe extraction step must return the EXACT field names declared in outputSchema.';
    } else {
      updatePhaseUI('success');
    }
    debugLogger.log('info', 'wizard', 'testScript success', { finalResult: result.finalResult });
  } catch (e) {
    wizardState.lastError = e.message;
    wizardState.lastErrorStepId = e.stepId || null;
    wizardState.lastErrorSnapshot = e.snapshot ? { ...e.snapshot, capturedAt: Date.now() } : null;
    // Preserve partial step results so autoFix can recover context that
    // isn't in the failure snapshot — most importantly the detail URL from
    // a prior $openTab-returning step. Without this, autoFix's
    // findSampleDetailUrl(wizardState.testResult) returns null when step 4
    // fails inside $openTab, the "$openTab branch" never fires, and the
    // LLM is handed the *main* tab snapshot (the search page) instead of
    // the detail page. It then hallucinates selectors like `.header` that
    // don't exist on the detail page.
    if (e.steps) {
      wizardState.testResult = { steps: e.steps, finalResult: null };
    }
    document.getElementById('testResults').textContent = 'Error: ' + e.message + (e.stepId ? ' (in step: ' + e.stepId + ')' : '');
    document.getElementById('resultSummary').innerHTML = '';
    renderPagesViewer(wizardState.testResult);
    document.getElementById('rawOutputDetails')?.classList.remove('hidden');
    appendLog('Execution failed: ' + e.message, 'error');
    if (e.steps) renderExecutionTimeline(e.steps);
    debugLogger.log('error', 'wizard', 'testScript failed', { error: e.message, stepId: e.stepId, stack: e.stack });

    // Auto-fix retry loop: kick in on a fresh failure (not when testScript is
    // being called from inside an existing autoFix iteration) and only for
    // errors the LLM can plausibly fix. LOGIN_REQUIRED etc. skip straight to
    // the manual UI.
    if (e.message === 'TEST_ABORTED') {
      wizardState.testAborted = true;
      appendLog('Test aborted by user.', 'info');
    } else {
      const autoFixable = !/LOGIN_REQUIRED/i.test(e.message || '');
      if (!wizardState.autoFixing && autoFixable) {
        appendLog('Test failed — auto-fixing (up to 3 attempts before asking you)...', 'info');
        await autoFix(null);
      } else {
        updatePhaseUI('failure');
      }
    }
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    // Release the ExecutionQueue lock so API jobs can proceed.
    try {
      await chrome.runtime.sendMessage({ type: 'RELEASE_EXEC_LOCK' });
    } catch (e) { /* background may be unavailable */ }
    wizardState.testAbortController = null;
  }

  // RC25 (console.log 2026-08-04): surface trusted-wheel skip tip after the
  // run completes (success OR failure — the skip is orthogonal to outcome).
  // The skip means Enhanced Mode is off AND scroll stalled at least once;
  // the user can act on this by enabling Enhanced Mode in the options page.
  if ((wizardState.trustedWheelSkipCount || 0) > 0 && !wizardState.testAborted) {
    const count = wizardState.trustedWheelSkipCount;
    const tip = `Scrolling stalled ${count}× on this page; Enhanced Mode (trusted-wheel fallback) is off — enable it under Settings → Enhanced scraping mode for sites that gate lazy-load on isTrusted scroll events.`;
    appendLog(tip, 'warn');
    showToast(tip, 'info', 8000);
    debugLogger.log('info', 'wizard', 'Surfaced trusted-wheel skip tip', { count });
  }

  if (!wizardState.testAborted) {
    goToPhase(5);
  }
}

async function improveStepWithAI(stepIndex, userFeedback) {
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  if (!config.config) {
    showToast('Please configure LLM in Options first', 'error');
    return;
  }

  const step = wizardState.steps[stepIndex];
  if (!step) return;

  showLoading('Improving step "' + step.name + '"...');

  // Try to capture a fresh page snapshot for context
  let pageSnapshot = null;
  try {
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter(t => t.url && t.url.startsWith(wizardState.targetUrl));
    if (tabs.length > 0) {
      const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' });
      pageSnapshot = response.snapshot;
    }
  } catch (e) {
    // Page not available, proceed without snapshot
  }

  const snapshotSection = pageSnapshot
    ? `Page structure:\n${pageSnapshot.structure || ''}`
    : '(page snapshot not available — target page may not be open)';

  // If improving a $openTab step, capture the detail page snapshot
  if (step.script?.includes('$openTab')) {
    const detailUrl = findSampleDetailUrl(wizardState.testResult);
    // Defensive guard: findSampleDetailUrl should enforce string-only, but a
    // single bug there crashes improve() with "Invalid type: expected string".
    if (typeof detailUrl === 'string' && /^https?:\/\//.test(detailUrl)) {
      try {
        showLoading('Capturing detail page for improvement...');
        // Background scrape tab; rendering is handled by the throttle stack
        // (visibility-keepalive here, sticky activation during input-required ops).
        const detailTab = await createScrapeTab(detailUrl);
        await new Promise(r => setTimeout(r, 8000));
        const response = await chrome.tabs.sendMessage(detailTab.id, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' });
        if (response?.snapshot) {
          pageSnapshot = response.snapshot;
        }
        await chrome.tabs.remove(detailTab.id).catch(() => {});
      } catch (e) {
        console.warn('Could not capture detail page for improve:', e);
      }
    } else if (detailUrl) {
      debugLogger.log('warn', 'wizard', 'Skipping improve detail snapshot — detailUrl is not an http(s) string', {
        detailUrlType: typeof detailUrl,
        detailUrlPreview: typeof detailUrl === 'string' ? detailUrl.slice(0, 100) : String(detailUrl).slice(0, 100)
      });
    }
  }

  const detailSnapshotSection = pageSnapshot
    ? `Page structure:\n${pageSnapshot.structure || ''}`
    : snapshotSection;

  const prompt = `${buildUrlTemplateNotice(wizardState.targetUrl)}${SCRIPT_DSL_GUIDE}

Improve the following step script based on user feedback.
Return ONLY the improved JavaScript code, no explanation.

Step name: ${step.name}
Current script:
${step.script}

User feedback: ${userFeedback}

Target URL: ${wizardState.targetUrl}
Original requirement: ${wizardState.description}

${detailSnapshotSection}`;

  try {
    const client = new LLMClient(config.config);
    const systemMsg = { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping script improver. Return only JavaScript code.') };
    const userMsg = { role: 'user', content: prompt };
    const messages = [systemMsg, ...wizardState.llmHistory, userMsg];
    const result = await client.chat(messages, {});

    wizardState.llmHistory.push(
      { role: 'user', content: (() => {
          const DomCleanerForFp = (typeof window !== 'undefined' && window.DomCleaner)
            || (typeof global !== 'undefined' && global.DomCleaner)
            || (typeof require === 'function' ? require('./lib/dom-cleaner.js') : null);
          const struct = (pageSnapshot && (pageSnapshot.structure || pageSnapshot.html)) || '';
          const fp = DomCleanerForFp && struct ? DomCleanerForFp.htmlFingerprint(struct) : '(unavailable)';
          // Reuse summarizeStepsGeneration shape; carry step name + user feedback.
          return summarizeStepsGeneration({
            url: wizardState.targetUrl,
            description: '[Improve Step "' + step.name + '"] feedback: ' + (userFeedback || '(none)'),
            htmlFingerprint: fp,
            confirmedSelectors: (step.annotations || wizardState.confirmedSelectors || []).map(a => ({
              purpose: a.purpose || a.type || '(annotation)',
              selector: a.selector || a.revisedSelector || '',
              status: a.status || 'confirmed',
              revisedSelector: a.revisedSelector
            }))
          });
        })() },
      { role: 'assistant', content: summarizeGeneratedSteps(result) }
    );
    trimLlmHistory();

    const cleanedScript = cleanLLMResponse(result);
    if (!cleanedScript || !cleanedScript.trim()) {
      showToast('AI improve returned empty script, keeping original.', 'warn');
      return;
    }
    step.script = cleanedScript;
    renderStepList();
    showToast('Step "' + step.name + '" improved', 'success');
  } catch (e) {
    console.error('Improve step failed:', e);
    showToast('AI improve failed: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

function findSampleDetailUrl(testResult) {
  const steps = testResult?.steps;
  if (!steps) return null;
  for (const stepOutput of steps) {
    const url = findHrefInObject(stepOutput.result);
    if (url) return url;
  }
  return null;
}

function findHrefInObject(obj, depth = 0) {
  if (depth > 3 || !obj || typeof obj !== 'object') return null;
  // Strict-string helper. Earlier versions used `if (item?.href) return item.href;`
  // which returned ANY truthy value (function refs, objects, numbers, arrays).
  // That crashed chrome.tabs.create downstream with "Invalid type: expected
  // string, found function" when an LLM-generated result happened to surface a
  // non-string truthy `href`/`link`/`url` field. Strict typeof guard prevents
  // the bad value from propagating.
  const STR = (v) => (typeof v === 'string' && v) ? v : null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const h = STR(item?.href) || STR(item?.link) || STR(item?.url);
      if (h) return h;
    }
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && value.startsWith('http')) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const h = STR(item?.href) || STR(item?.link) || STR(item?.url);
        if (h) return h;
      }
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const found = findHrefInObject(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Spec 5: restore the highest-scoring attempt when the last iteration regressed.
// Applies the plan from planRestoreBestAttempt (pure) to wizardState + DOM.
// Supports both the multi-step shape (stepsSnapshot + historyMarker, current)
// and the legacy single-step shape (stepId + script + ..., retained for any
// bestAttempt objects persisted from older builds).
function restoreBestAttempt(best) {
  const plan = planRestoreBestAttempt(best, wizardState.steps, wizardState.llmHistory);
  if (!plan) return;
  const patches = Array.isArray(plan.stepPatches) ? plan.stepPatches : [];
  if (patches.length === 0) {
    // Legacy single-step return shape (planRestoreBestAttempt older version).
    const legacyStepId = plan.stepId;
    const legacyPatch = plan.stepPatch;
    if (!legacyStepId || !legacyPatch) return;
    const legacyTarget = wizardState.steps.find(s => s.id === legacyStepId);
    if (!legacyTarget) return;
    Object.assign(legacyTarget, legacyPatch);
    wizardState.llmHistory = plan.truncatedHistory;
    syncStepEditorUI(legacyStepId, legacyTarget);
    const legacyScriptEl = document.getElementById('currentScript');
    if (legacyScriptEl) legacyScriptEl.textContent = legacyTarget.script;
    appendLog(plan.logMessage, 'info');
    return;
  }
  for (const p of patches) {
    const targetStep = wizardState.steps.find(s => s.id === p.id);
    if (!targetStep) continue;
    Object.assign(targetStep, p.stepPatch);
    syncStepEditorUI(p.id, targetStep);
  }
  wizardState.llmHistory = plan.truncatedHistory;
  const currentScriptEl = document.getElementById('currentScript');
  if (currentScriptEl && patches.length > 0) {
    const firstTarget = wizardState.steps.find(s => s.id === patches[0].id);
    if (firstTarget) currentScriptEl.textContent = firstTarget.script;
  }
  appendLog(plan.logMessage, 'info');
}

// Spec 5 helper: keep a step's editor textareas in sync after a programmatic
// script/edge/maxIterations restore, so confirmDeploy's syncStepsFromEditor
// doesn't clobber the restore.
function syncStepEditorUI(stepId, step) {
  const detail = document.querySelector(`.step-detail[data-step-id="${stepId}"]`);
  if (!detail) return;
  const ta = detail.querySelector('.step-script-input');
  if (ta) ta.value = step.script;
  const s = detail.querySelector('.step-success-input'); if (s) s.value = step.onSuccess || 'TERMINATE';
  const f = detail.querySelector('.step-failure-input'); if (f) f.value = step.onFailure || 'TERMINATE';
  const m = detail.querySelector('.step-maxiter-input'); if (m) m.value = step.maxIterations || 1;
}

// RC11: pull finalResult out of wizardState.testResult without crashing when
// either field is null. Used by the user-feedback prompt builder to score the
// CURRENT state against bestAttempt — same pattern as the scoring loop in
// autoFix.
function wafeFallbackFinalResult(state) {
  if (!state || !state.testResult) return null;
  return state.testResult.finalResult !== undefined ? state.testResult.finalResult : null;
}

// RC11: build a regression-guard section for the user-feedback prompt. Returns
// '' when no bestAttempt is on record OR the current state already matches
// beats it. Otherwise returns a multi-line warning that surfaces the
// best-known-good metrics so the LLM treats the current scripts as a baseline
// to PRESERVE, not a blank slate to rewrite from. Generic across sites —
// speaks in terms of item count, field coverage, and required-field coverage,
// never about specific selectors or sites.
function buildRegressionGuard(bestAttempt, currentScoreResult) {
  if (!bestAttempt || !bestAttempt.score || bestAttempt.score <= 0) return '';
  const currentScore = (currentScoreResult && typeof currentScoreResult.score === 'number')
    ? currentScoreResult.score
    : 0;
  if (currentScore >= bestAttempt.score) return '';
  const lines = [];
  lines.push('');
  lines.push('REGRESSION GUARD — read before editing:');
  lines.push(`- The current scripts are the BEST-KNOWN-WORKING version. A previous user-feedback iteration regressed the output, and we rolled the scripts back.`);
  const bd = bestAttempt.breakdown || {};
  if (bd && typeof bd === 'object') {
    const parts = [];
    if (typeof bd.listItemCount === 'number') parts.push(`items extracted: ${bd.listItemCount}`);
    if (typeof bd.avgFieldsPerItem === 'number') parts.push(`avg fields per item: ${bd.avgFieldsPerItem.toFixed(2)}`);
    if (typeof bd.requiredCoverage === 'number') parts.push(`required-field coverage: ${(bd.requiredCoverage * 100).toFixed(0)}%`);
    if (parts.length) lines.push(`- Best-known output metrics — ${parts.join(', ')}.`);
  }
  lines.push(`- Score (higher is better) — best-known: ${bestAttempt.score}, current run: ${currentScore}.`);
  lines.push('- DO NOT rewrite a selector that is already producing the metrics above. Identify the SPECIFIC field or step that the user is reporting a problem on, and change ONLY that. "Improving" a working selector to "be safer" or "more general" is how the previous iteration regressed.');
  lines.push('- If you cannot pinpoint the broken selector from RUNTIME DIAGNOSTICS + the user feedback, return the current scripts UNCHANGED (one patch per step with the same script) rather than guessing. A no-op is strictly better than a regression here.');
  return lines.join('\n');
}

// Spec 5: render the intervention banner in #phase5 and wire button actions.
function showInterventionBanner(classification, failingStep) {
  try {
    const phase5 = document.getElementById('phase5');
    if (!phase5) {
      appendLog(classification.message, classification.severity);
      if (typeof showToast === 'function') showToast(classification.message, classification.severity);
      return;
    }
    // Remove any existing banner first
    const existing = phase5.querySelector('.intervention-banner');
    if (existing) existing.remove();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderInterventionBanner(classification);
    const banner = wrapper.firstElementChild;
    if (!banner) {
      appendLog(classification.message, classification.severity);
      return;
    }
    phase5.prepend(banner);
    banner.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'dismiss') {
        if (!wizardState.dismissedInterventions) wizardState.dismissedInterventions = new Set();
        wizardState.dismissedInterventions.add(classification.type);
        banner.remove();
        appendLog(`Dismissed ${classification.type} intervention — continuing autoFix.`, 'info');
      } else if (action === 'annotate_step') {
        goToPhase(3);  // phase 3 hosts annotation UI
      } else if (action === 'open_settings') {
        const openSettingsBtn = document.getElementById('openSettings');
        if (openSettingsBtn) openSettingsBtn.click();
      } else if (action === 'open_tab') {
        chrome.tabs.create({ url: wizardState.targetUrl, active: true });
      } else if (action === 'refresh_tab') {
        const targetTabId = wizardState.lastTargetTabId;
        if (targetTabId) chrome.tabs.reload(targetTabId);
      }
    });
    appendLog(classification.message, classification.severity);
  } catch (e) {
    appendLog(classification.message, classification.severity);
    if (typeof debugLogger !== 'undefined') {
      debugLogger.log('warn', 'wizard', 'showInterventionBanner failed', { error: e.message });
    }
  }
}

function clearInterventionBanner() {
  const phase5 = document.getElementById('phase5');
  if (!phase5) return;
  phase5.querySelectorAll('.intervention-banner').forEach(el => el.remove());
}

async function autoFix(userFeedback = null) {
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  if (!config.config) {
    showToast('Please configure LLM in Options first', 'error');
    return;
  }

  // userFeedback provided → single attempt (Auto-Fix button with hint).
  // userFeedback null → up to 3 silent retries before giving up and asking
  // the user for a hint. Triggered automatically by testScript on failure.
  const MAX_ATTEMPTS = userFeedback ? 1 : 3;
  // User-feedback path: start compact. The original steps-generation prompt
  // sitting in llmHistory is huge (SCRIPT_DSL_GUIDE + 30K-char snapshot), and
  // glm-5.1's proxy rejects prompts pre-emptively when total size crosses an
  // internal threshold. Going straight to 15K snapshot avoids the
  // overflow-then-retry round-trip. Failure-fix path keeps the larger default
  // (its prompts are smaller because there's a single target step).
  // Regression for console.log 2026-07-26 RC7.
  let compactMode = !!userFeedback;
  // Always clear any stale intervention banner from a prior autoFix run —
  // testScript's reset only fires on a fresh test, but btnAutoFix can invoke
  // autoFix() directly while a previous banner is still on screen.
  clearInterventionBanner();
  if (!userFeedback) {
    wizardState.fixAttemptCount = 0;
    wizardState.bestAttempt = null;
    wizardState.dismissedInterventions = null;
  }

  const prevAutoFixing = wizardState.autoFixing;
  wizardState.autoFixing = true;
  // compactMode initialized above (true for user-feedback path, false for
  // failure-fix path). Sticky: once the LLM signals context-window overflow,
  // every subsequent iteration in this autoFix run uses the compact prompt
  // (truncated HTML). Without this, attempt N+1 would re-send the full-sized
  // prompt and hit the same overflow — compacting once should apply to the
  // rest of the run.
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (wizardState.testAborted) break;
      let success = false;
      let fatal = false;
      try {
        success = await runFixIteration(userFeedback, config, { compact: compactMode, attemptNum: attempt, totalAttempts: MAX_ATTEMPTS });
      } catch (err) {
        if (err.name === 'LLMContextOverflow') {
          if (!compactMode) {
            // First overflow on this run: drop the accumulated conversation
            // history (it's stale anyway — prior failed scripts don't help)
            // and retry THIS iteration with a compacted snapshot. The client
            // has already given up retrying the same prompt internally, so
            // this is our one chance to recover with a smaller payload.
            appendLog('Context window exceeded — retrying with compacted prompt (history dropped, HTML truncated to 20K)...', 'warn');
            wizardState.llmHistory = [];
            compactMode = true;
            try {
              success = await runFixIteration(userFeedback, config, { compact: true, attemptNum: attempt, totalAttempts: MAX_ATTEMPTS });
            } catch (err2) {
              if (err2.name === 'LLMContextOverflow') {
                const msg = 'Page is too large for the model\'s context window even after truncation. Narrow the requirement, annotate elements manually, or switch to a model with a larger context window.';
                appendLog(msg, 'error');
                showToast(msg, 'error');
              } else {
                console.error('Auto-fix iteration threw after compact retry:', err2);
                appendLog('Auto-fix error after compact retry: ' + err2.message, 'error');
              }
              fatal = true;
            }
          } else {
            // Already in compact mode and STILL overflowed — the page itself
            // exceeds the model's limit. No amount of further truncation will
            // help; surface a clear message and stop.
            const msg = 'Page is too large for the model\'s context window even after truncation. Narrow the requirement, annotate elements manually, or switch to a model with a larger context window.';
            appendLog(msg, 'error');
            showToast(msg, 'error');
            fatal = true;
          }
        } else {
          // Fatal: LLM call failed, parse error, network. No point retrying.
          console.error('Auto-fix iteration threw:', err);
          appendLog('Auto-fix error: ' + err.message, 'error');
          fatal = true;
        }
      }
      // === Spec 5: score this attempt, track best, check intervention ===
      const finalResult = wizardState.testResult && wizardState.testResult.finalResult !== undefined
        ? wizardState.testResult.finalResult
        : null;
      const scoreResult = scoreAttemptResult(finalResult, wizardState.outputSchema);
      // Track best attempt regardless of error state. The previous gate on
      // lastErrorStepId broke coverage for both:
      //   - successful silent retries (testScript clears lastErrorStepId on entry)
      //   - user-feedback iterations (no error to begin with — lastErrorStepId null)
      // Without this, a user-feedback regression that drops extraction to 0
      // items cannot be detected + reverted (console.log 2026-07-26 14:49:08
      // RC11). Snapshot ALL steps so multi-step patches can be rolled back,
      // not just the failing step's script.
      if (scoreResult.isData && scoreResult.score > 0) {
        if (!wizardState.bestAttempt || scoreResult.score > wizardState.bestAttempt.score) {
          wizardState.bestAttempt = {
            stepsSnapshot: wizardState.steps.map(s => ({
              id: s.id,
              name: s.name,
              script: s.script,
              onSuccess: s.onSuccess,
              onFailure: s.onFailure,
              maxIterations: s.maxIterations
            })),
            // summarizeFixIteration emits `[Attempt — step "<id>" ...]`. When
            // targetStepId is null (user-feedback path), the marker literally
            // contains "null". Store the exact prefix so planRestoreBestAttempt
            // can slice llmHistory at the right boundary regardless of path.
            historyMarker: `[Attempt — step "${wizardState.lastErrorStepId || 'null'}"`,
            score: scoreResult.score,
            attemptNum: attempt,
            breakdown: scoreResult.breakdown
          };
        }
      }
      // Classifier (only on failure — if success, we return below before reaching here anyway)
      if (!success) {
        const snapshotAgeMs = wizardState.lastErrorSnapshot && wizardState.lastErrorSnapshot.capturedAt
          ? (Date.now() - wizardState.lastErrorSnapshot.capturedAt)
          : 0;
        const failingStep = wizardState.steps.find(s => s.id === wizardState.lastErrorStepId);
        const intervention = classifyIntervention({
          error: wizardState.lastError,
          result: finalResult,
          outputSchema: wizardState.outputSchema,
          annotations: (failingStep && failingStep.annotations) || [],
          attemptCount: attempt,
          lastError: wizardState.lastError,
          dismissed: wizardState.dismissedInterventions,
          snapshotAgeMs
        });
        if (intervention) {
          showInterventionBanner(intervention, failingStep);
          break;
        }
      }
      // === End Spec 5 additions ===

      if (success) return;
      if (fatal) break;
      if (attempt < MAX_ATTEMPTS) {
        appendLog('Attempt ' + attempt + '/' + MAX_ATTEMPTS + ' did not fix it, retrying...', 'info');
      }
    }
    if (!userFeedback) {
      appendLog('Auto-fix gave up after ' + MAX_ATTEMPTS + ' attempts. Add a hint below and click Auto-Fix.', 'warn');
      // Explicit annotation suggestion when extraction keeps coming back empty
      // and the failing step has no annotations. The LLM has failed to find
      // working selectors on its own; the user can short-circuit by manually
      // picking the elements.
      const isEmptyExtraction = /EMPTY_EXTRACTION/i.test(wizardState.lastError || '');
      const failingStep = wizardState.steps.find(s => s.id === wizardState.lastErrorStepId);
      const hasNoAnnotations = !failingStep?.annotations || failingStep.annotations.length === 0;
      if (isEmptyExtraction && failingStep && hasNoAnnotations) {
        const msg = 'Extraction keeps returning empty data. Click "Start Annotating" on step "' + failingStep.name + '" to manually select the elements — the LLM will use your picks directly.';
        appendLog(msg, 'warn');
        showToast(msg, 'warn', 12000);
      }
    }
    // Chronic-empty-fields annotation suggestion (fires on BOTH paths).
    // The hard-EMPTY_EXTRACTION suggestion above only fires when the WHOLE
    // array comes back empty. The more common case (console.log 2026-08-06
    // / 2026-08-07): partial extraction succeeds — the array has N records
    // with some fields populated (groupName, content, images) — but specific
    // fields are 100% empty across every record (postTime, account.username,
    // groupNature, location). The LLM iterates and iterates; EMPTY_FIELDS
    // signal tells it WHICH fields are empty, but the LLM still can't find
    // working selectors for them because the site's DOM is heavily obfuscated.
    // Element annotation is the most direct fix — the user clicks the actual
    // element and the LLM uses that selector verbatim. Surface a data-driven
    // suggestion naming the specific chronic-empty fields so the user knows
    // exactly what to annotate.
    const _finalData = wizardState.testResult && wizardState.testResult.finalResult !== undefined
      ? wizardState.testResult.finalResult
      : null;
    if (_finalData && typeof _finalData === 'object' && !Array.isArray(_finalData) && wizardState.outputSchema) {
      const chronicEmpty = (typeof detectEmptyOutputFieldsByRatio === 'function')
        ? detectEmptyOutputFieldsByRatio(_finalData, wizardState.outputSchema, { emptyRatioThreshold: 1.0, minRecords: 2 })
        : [];
      if (chronicEmpty.length > 0) {
        const lastStepId = wizardState.steps[wizardState.steps.length - 1] && wizardState.steps[wizardState.steps.length - 1].id;
        const extractionStepId = (typeof findUpstreamExtractionStepId === 'function')
          ? findUpstreamExtractionStepId(wizardState.steps, lastStepId)
          : lastStepId;
        const extractionStep = extractionStepId ? wizardState.steps.find(s => s.id === extractionStepId) : null;
        const hasNoAnnotations = !extractionStep || !extractionStep.annotations || extractionStep.annotations.length === 0;
        if (extractionStep && hasNoAnnotations) {
          // Show up to 5 field paths to keep the toast readable.
          const fieldList = chronicEmpty.slice(0, 5).map(f => f.path || f.field).join(', ');
          const more = chronicEmpty.length > 5 ? ' (+' + (chronicEmpty.length - 5) + ' more)' : '';
          const msg = 'Field(s) [' + fieldList + more + '] are empty across ALL extracted records. The LLM cannot find working selectors for them on this site. Click "Start Annotating" on step "' + extractionStep.name + '" and pick the actual elements — annotations are used directly by the LLM.';
          appendLog(msg, 'warn');
          showToast(msg, 'warn', 12000);
        }
      }
    }
    // === Spec 5: restore best attempt if the last iteration regressed ===
    if (wizardState.bestAttempt && wizardState.bestAttempt.score > 0) {
      const finalResult = wizardState.testResult && wizardState.testResult.finalResult !== undefined
        ? wizardState.testResult.finalResult
        : null;
      const currentScore = scoreAttemptResult(finalResult, wizardState.outputSchema).score;
      if (wizardState.bestAttempt.score > currentScore) {
        restoreBestAttempt(wizardState.bestAttempt);
      }
    }
    // === End Spec 5 ===

    updatePhaseUI('failure');
  } finally {
    wizardState.autoFixing = prevAutoFixing;
  }
}

async function runFixIteration(userFeedback, config, options = {}) {
  const attemptNum = Number.isFinite(options.attemptNum) ? options.attemptNum : 1;
  const totalAttempts = Number.isFinite(options.totalAttempts) ? options.totalAttempts : (userFeedback ? 1 : 3);
  // Deterministic topology heal first (no LLM): if a step signals polling but
  // left maxIterations unset (common when a prior LLM fix just added a wait),
  // give it a default retry budget before spending an LLM call.
  const fixHeal = normalizeStepTopology(wizardState.steps);
  if (fixHeal.changed.length) {
    appendLog('Set default retry budget (maxIterations) on poll step(s): ' + fixHeal.changed.map(c => c.id).join(', '), 'info');
  }

  // Determine which step to fix.
  // - Error path (lastErrorStepId set): target that specific failing step.
  //   Used as the FAILING marker in the prompt and as the soft-fallback when
  //   the LLM omits stepId.
  // - User-feedback path (lastErrorStepId null): NO default target. The
  //   previous "default to last step" heuristic was wrong because user-
  //   observed extraction bugs usually live in an upstream step, not the
  //   finalizer (bugx.log 2026-07-24). Pass null and let resolveAutoFixTargets
  //   require an explicit stepId on every patch.
  const targetStepId = wizardState.lastErrorStepId || null;
  if (!targetStepId && wizardState.steps.length === 0) {
    showToast('No steps to fix', 'error');
    return false;
  }

  const targetStep = targetStepId ? wizardState.steps.find(s => s.id === targetStepId) : null;
  if (targetStepId && !targetStep) {
    showToast('Step not found: ' + targetStepId, 'error');
    return false;
  }

  const isFailureFix = !!wizardState.lastErrorStepId;
  updatePhaseUI('fixing');
  showLoading(isFailureFix
    ? 'Fixing step "' + targetStep.name + '"...'
    : 'Analyzing your feedback and locating the root-cause step(s)...');
  debugLogger.log('info', 'wizard', 'autoFix target selected', {
    targetStepId: targetStepId || null,
    targetStepName: targetStep ? targetStep.name : null,
    isFailureFix,
    allSteps: wizardState.steps.map(s => ({ id: s.id, name: s.name, scriptLength: (s.script || '').length })),
    userFeedback: userFeedback ? userFeedback.slice(0, 500) : null
  });

  // Use the failing step's snapshot (captured at failure time with full HTML), or fall back to fresh capture
  let pageSnapshot = wizardState.lastErrorSnapshot;
  if (!pageSnapshot || !pageSnapshot.html) {
    try {
      const allTabs = await chrome.tabs.query({});
      const tabs = allTabs.filter(t => t.url && t.url.startsWith(wizardState.targetUrl));
      if (tabs.length > 0) {
        const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_DOM_SNAPSHOT', mode: 'full' });
        pageSnapshot = response.snapshot;
      }
    } catch (e) {
      console.warn('Could not capture snapshot for auto-fix:', e);
    }
  }
  if (!pageSnapshot) pageSnapshot = { html: '', textContent: '', structure: '', textSummary: '' };

  // If the failing step uses $openTab, OR any prior step returned a detail URL
  // (e.g. step 3 returns {href: ...} but step 4 doesn't yet wrap work in
  // $openTab), capture the detail page snapshot. Without this, the LLM is
  // handed the search/list page HTML and keeps inventing selectors for
  // elements that don't exist there.
  const detailUrl = findSampleDetailUrl(wizardState.testResult);
  // Any step might be the one that needs the detail page (user-feedback path
  // has no single targetStep), so scan the whole workflow.
  const anyStepUsesOpenTab = wizardState.steps.some(s => s.script && s.script.includes('$openTab'));
  const shouldCaptureDetail = detailUrl && (
    anyStepUsesOpenTab ||
    detailUrl !== wizardState.targetUrl
  );
  let detailPageHint = '';
  if (shouldCaptureDetail) {
    // Defensive guard: never hand a non-string or non-http(s) value to
    // chrome.tabs.create — Chrome rejects with "Invalid type: expected string"
    // (or opens about:blank for malformed URLs). findSampleDetailUrl is
    // supposed to enforce this, but a single bug there crashes the whole
    // autoFix iteration.
    if (typeof detailUrl !== 'string' || !/^https?:\/\//.test(detailUrl)) {
      debugLogger.log('warn', 'wizard', 'Skipping detail-page snapshot — detailUrl is not an http(s) string', {
        detailUrlType: typeof detailUrl,
        detailUrlPreview: typeof detailUrl === 'string' ? detailUrl.slice(0, 100) : String(detailUrl).slice(0, 100)
      });
    } else {
      try {
        showLoading('Capturing detail page snapshot for better fix...');
        // Background scrape tab; lazy-load rendering relies on the throttle
        // stack (visibility-keepalive + sticky activation), not a popup window.
        const detailTab = await createScrapeTab(detailUrl);
        // Wait for page + iframe content to load (8s for dynamic iframe chains)
        await new Promise(r => setTimeout(r, 8000));
        const response = await chrome.tabs.sendMessage(detailTab.id, { type: 'GET_DOM_SNAPSHOT', mode: 'full' });
        if (response?.snapshot) {
          pageSnapshot = response.snapshot;
          detailPageHint = `IMPORTANT — PAGE BOUNDARY:
The snapshot below is from the DETAIL PAGE: ${detailUrl}
The script's main execution context is the SEARCH/LIST page (the page that's currently loaded when this step runs).
To interact with elements in the snapshot below, your script MUST wrap the operations in $openTab:
  return await $openTab('${detailUrl}', async () => {
    // operations against the detail page go here
    const data = await $('...');
    return data;
  });
If your script does NOT use $openTab, $wait / $ / $extract will run against the wrong page (search/list) and time out with ELEMENT_NOT_FOUND.

`;
          debugLogger.log('info', 'wizard', 'Captured detail page snapshot for auto-fix', {
            url: detailUrl,
            htmlLength: pageSnapshot.html?.length,
            structureLength: pageSnapshot.structure?.length,
            anyStepUsesOpenTab
          });
        }
        await chrome.tabs.remove(detailTab.id).catch(() => {});
      } catch (e) {
        console.warn('Could not capture detail page snapshot:', e);
      }
    }
  }

  // Always cap the snapshot before building the LLM prompt. This used to fire
  // only on overflow-retry (the old compactMode block above), which meant the
  // first attempt sent the raw ~76KB HTML and could overflow before any
  // compaction engaged. Now every iteration starts with a 30K-capped snapshot
  // (15K on compact retry). The [TRUNCATED] marker inside the helper carries
  // the "structure was cut" signal in-band, so compactedNote is no longer
  // populated (left as '' for backward-compat with the prompt templates that
  // still interpolate it).
  let compactedNote = '';
  const snapshotBudget = options.compact ? 15000 : 30000;
  // A4: preserve the raw HTML before truncation so that if the cleaner returns
  // mode:'needs_subtree_selection' (meaning the cleaned HTML still exceeds
  // budget and the LLM must pick a subtree), we can re-parse the original HTML
  // to find that subtree. After truncateSnapshotForLLM, pageSnapshot.html is
  // undefined in that mode — only structureForSelection survives.
  const rawPageHtml = (pageSnapshot && typeof pageSnapshot.html === 'string') ? pageSnapshot.html : '';
  pageSnapshot = truncateSnapshotForLLM(pageSnapshot, snapshotBudget);

  // A4: if cleaning returned needs_subtree_selection, invoke the LLM to pick
  // a subtree and re-clean it. Fall back to compressed mode on any failure.
  // The subtree picker needs the original raw HTML (preserved above), NOT the
  // truncated snapshot — the truncated snapshot has no .html in this mode.
  if (pageSnapshot && pageSnapshot.mode === 'needs_subtree_selection') {
    try {
      const DomCleanerRef = (typeof window !== 'undefined' && window.DomCleaner)
        || (typeof global !== 'undefined' && global.DomCleaner)
        || (typeof require === 'function' ? require('./lib/dom-cleaner.js') : null);
      const LLMClientRef = (typeof window !== 'undefined' && window.LLMClient)
        || (typeof global !== 'undefined' && global.LLMClient)
        || (typeof require === 'function' ? require('./lib/llm-client.js') : null);
      const llmConfig = (config && config.config) ? config.config : config;
      const llmClient = (llmConfig && LLMClientRef) ? new LLMClientRef(llmConfig) : null;
      const doc = new DOMParser().parseFromString(rawPageHtml || '', 'text/html');
      const subtreeResult = DomCleanerRef
        ? await DomCleanerRef.requestSubtreeSelection(
            doc,
            wizardState.description || '',
            wizardState.annotations || [],
            llmClient
          )
        : null;
      if (subtreeResult && subtreeResult.subtreeHtml) {
        const reCleaned = DomCleanerRef.cleanHtmlForLLM(subtreeResult.subtreeHtml, wizardState.annotations || [], snapshotBudget);
        pageSnapshot = { ...pageSnapshot, ...reCleaned, subtreeSelector: subtreeResult.subtreeSelector };
        wizardState.subtreeSelector = subtreeResult.subtreeSelector;
        console.log('[A4] subtree selection succeeded:', subtreeResult.subtreeSelector);
      } else {
        // Fallback to compressed structure (tier 2c output) so the prompt still
        // gets something useful instead of an empty HTML block.
        pageSnapshot = {
          ...pageSnapshot,
          mode: 'compressed',
          html: '',
          structure: pageSnapshot.structureForSelection || pageSnapshot.structure || '',
          fingerprint: pageSnapshot.fingerprint || (DomCleanerRef ? DomCleanerRef.htmlFingerprint(pageSnapshot.structureForSelection || '') : '')
        };
        console.log('[A4] subtree selection failed — falling back to compressed structure');
      }
    } catch (e) {
      console.warn('[A4] subtree selection error:', e.message);
    }
  }

  // C3: HTML fingerprint dedup. If this fingerprint is already in history
  // (page unchanged across iterations), omit the full HTML body — send only
  // a reference marker so the LLM looks back at the prior message that
  // carried this fingerprint. Annotations are tracked separately and are
  // ALWAYS sent fresh in the prompt (user direction: "annotations另外").
  // The fingerprint hashes ONLY the raw HTML/structure, never the annotations.
  const DomCleanerRef = (typeof window !== 'undefined' && window.DomCleaner)
    || (typeof global !== 'undefined' && global.DomCleaner)
    || (typeof require === 'function' ? require('./lib/dom-cleaner.js') : null);
  const rawHtmlForFp = (pageSnapshot && (pageSnapshot.html || pageSnapshot.structure)) || '';
  const currentHtmlFp = (pageSnapshot && pageSnapshot.fingerprint)
    || (DomCleanerRef ? DomCleanerRef.htmlFingerprint(rawHtmlForFp) : 'unknown');
  const htmlInHistory = wizardState.htmlFingerprintsInHistory.has(currentHtmlFp);

  let htmlSection;
  if (htmlInHistory) {
    htmlSection = `[Page HTML fingerprint: ${currentHtmlFp} — UNCHANGED from a prior round. Full HTML is in the prior message with this fingerprint.]`;
  } else {
    htmlSection = `[Page HTML fingerprint: ${currentHtmlFp}]\n` + renderCleanedResult(pageSnapshot);
    wizardState.htmlFingerprintsInHistory.add(currentHtmlFp);
  }
  wizardState.lastHtmlFingerprint = currentHtmlFp;

  // Per-step timeout guidance is injected via buildTimeoutGuidance(DEPLOY_TIMEOUT_MS) in the prompts below.

  // Build full step workflow context so LLM understands the pipeline.
  // The "<<< FIXING/FAILING" marker is only added on the error path (where
  // there's a specific failing step to fix). On the user-feedback path the
  // marker would contradict the prompt's "do NOT anchor on any particular
  // step" instruction (bugx.log 2026-07-24: the marker biased glm-5.1 toward
  // step 5 even though the root cause was in step 4).
  const allStepsContext = wizardState.steps.map(s => {
    const marker = (isFailureFix && s.id === targetStepId) ? ' <<< FAILING' : '';
    // RC22 (console.log 2026-08-03 11:43–11:57): surface step.annotations
    // alongside each step's script. Without this, the user-feedback autoFix
    // path forced the LLM to guess selectors based on its training-data
    // assumption of the site DOM — every round failed the same way on FB's
    // username field despite the user having annotated it at author time.
    // The failure-fix path already dumped top-level wizardState.annotations
    // (line ~2694); the user-feedback path missed this entirely. Generic
    // data-flow fix — works for any annotated field on any site.
    let annBlock = '';
    if (Array.isArray(s.annotations) && s.annotations.length > 0) {
      const annText = buildAnnotationsText(s.annotations);
      if (annText && typeof annText === 'string') {
        // Indent each line so the block sits cleanly under the step's script.
        const indented = annText.split('\n').filter(Boolean).map(l => '    ' + l).join('\n');
        annBlock = '\n  User-annotated selectors (empirically verified at author time — PREFER these over your own guesses; if a field is missing, check here first):\n' + indented;
      }
    }
    return `Step ${s.id} (${s.name}):${marker}\n  onSuccess → ${s.onSuccess || 'TERMINATE'}\n  Script:\n${s.script}${annBlock}`;
  }).join('\n\n');

  // Build test results context. Strip snapshots and cap field sizes —
  // without this, a 5-step FB test result carries ~750K chars of per-step
  // snapshot HTML and overflows the LLM context (console.log 2026-07-26:
  // model_context_window_exceeded with prompt_tokens:0 even after the
  // compactMode retry path fired). The failing step's DOM is supplied
  // separately via the truncated `pageSnapshot` above.
  //
  // dedupeStepIterations (console.log 2026-08-05): collapse polling-step
  // iteration entries to the LAST per stepId. Without this, a 9-iteration
  // step-5 with growing updatedPosts bloated the prompt to 1.83MB even
  // after the 5K-per-field cap. Order: dedupe → strip pages → strip snapshots.
  const testResultSection = wizardState.testResult
    ? '\n\nPREVIOUS TEST RESULT:\n' + JSON.stringify(stripPagesFromLLMContext(stripSnapshotsFromTestResult(dedupeStepIterations(wizardState.testResult))), null, 2)
    : '';

  const RETURN_FORMAT = `RETURN FORMAT — choose ONE:
(A) Script-only fix (default): return ONLY the fixed JavaScript code, no explanation.
(B) If you ALSO need to change THIS step's flow (onSuccess/onFailure/maxIterations), OR redirect the fix to a DIFFERENT step, return a JSON object and nothing else:
    {"script": "<fixed JS as one string>", "onSuccess": "<step id or TERMINATE>", "onFailure": "<step id or TERMINATE>", "maxIterations": <number>, "stepId": "<id of step to apply this patch to>"}
    Include only the flow fields you are changing; "script" is always required. The new flow must keep the chain valid (every target id exists, no orphan steps, never use "SELF"). Do NOT add or remove steps.

REDIRECTING THE FIX (important when user reports extraction-quality issues):
- The step marked "<<< FAILING" below is the step that raised the runtime error. The actual root cause frequently lives in an EARLIER step whose output flowed into the failing step.
- If your analysis of the error + the step scripts shows the root cause is in a different step, set "stepId" to that step's id. Your patch will be applied there instead.
- Example: step 5 fails with "createdAt is undefined" because it reads __stepResults__['4'].records[0].createdAt — but step 4 never extracted createdAt in the first place. The fix belongs in step 4, not step 5. Return {"stepId":"4", "script":"<fixed step-4 script>"}.
- If the marked step IS the right one to fix, omit "stepId" (or set it to the marked step's id).`;

  // Multi-patch format for user-feedback path. bugx.log 2026-07-24 07:04:16:
  // feedback "publishTime missing" needed a fix in step 4 (extract), but the
  // LLM kept choosing to re-extract inside step 5 (finalizer) because (a) the
  // prompt anchored it on step 5's script and (b) only single-step patches
  // were allowed. The new format requires the LLM to identify every root-cause
  // step explicitly and return a patch per step — no implicit target, no
  // "re-extract in the finalizer" band-aid. The 2026-07-24 follow-up removed
  // the last-step default entirely (targetStepId=null on this path), so every
  // patch MUST carry an explicit stepId.
  const RETURN_FORMAT_FEEDBACK = `RETURN FORMAT — your fix may touch MULTIPLE steps. Always return JSON:
  {
    "analysis": "<one or two sentences: which step has which root cause>",
    "patches": [
      {"stepId": "<id from FULL STEP WORKFLOW>", "script": "<fixed JS for that step>"},
      ...one entry per step whose script contains a root cause...
    ]
  }
Rules (READ ALL):
- This is NOT a runtime error. The service ran successfully and produced output — the user looked at the output and is reporting data-quality problems they observed. There is no exception, no stack trace. Investigate the step scripts to find which extraction logic produced the wrong data.
- There is NO default target step. You MUST pick "stepId" on every patch from the "Step N (name)" headers in FULL STEP WORKFLOW. A patch without "stepId" will be rejected.
- Include a patch for EVERY step whose script currently contains a root cause. A partial fix leaves the test failing on the un-patched step and burns the user-feedback iteration (only ONE iteration runs per feedback submit).
- Each "script" REPLACES that step's script entirely — do not emit diffs.
- If a step's flow also needs to change, add "onSuccess"/"onFailure"/"maxIterations" to that patch. Do NOT add or remove steps. The chain must stay valid.
- Single-step fix is fine: return one-element "patches".
- FORBIDDEN: re-extracting a field in a LATER step to "ensure it's captured" when an EARLIER step's extraction is broken. If step 4 extracts createdAt with a bad selector and step 5 is the finalizer, FIX STEP 4's selector — do not add a parallel createdAt extraction in step 5. Re-extracting in the finalizer duplicates work, leaves the original bug latent, and the next user complaint will be about the same field.
- Common root-cause locations for user feedback:
  * "field X missing or wrong" → the step whose $extractList fieldMap includes field X (usually the extract step, NOT the finalizer).
  * "only N items extracted" → the scroll/paginate step (under-loaded) OR the extract step (container selector too narrow).
  * "image URLs incomplete" → the step that reads images. If it uses $extract('img', src) for a field declared array, switch to $list('img') — $extract returns ONE.
  * "records have wrong author/content" → the extract step's sub-selectors are matching the wrong element.
  * "scroll/poll step returned the same postCount on every iteration with a stalled counter increasing" → the scroll mechanism itself did not progress (page did not actually scroll). NOT a selector problem. Check RUNTIME DIAGNOSTICS above: if scrollRoot is not 'window' or stalled is true, the site uses an inner scroll container — the framework auto-probes one, but if the auto-probe picked the wrong container, pin it explicitly with $scrollToBottom('<inner container selector>').`;

  // Signal-block tracking (RC30 part-1): these are assigned in the
  // user-feedback branch below. Declared here with empty defaults so the
  // post-prompt signal-emission log can reference them on BOTH branches
  // (failure-fix path doesn't emit these specific signals).
  let noOpEscalation = '';
  let emptyFieldsSignal = '';
  let shapeDistributionSignal = '';
  let fieldCandidatesSignal = '';

  let prompt;
  if (isFailureFix) {
    // Field candidate discovery (2026-08-07): mirror of user-feedback branch.
    // When chronic-empty fields are detected AND no annotations exist AND
    // this is iteration 1 of the current autoFix run, scan the normalized
    // record HTML and surface up to K candidate leaf elements per field.
    // Suppress on iterations 2+ to avoid LLM locking onto the same wrong
    // candidate repeatedly.
    if (attemptNum === 1) {
      try {
        const chronicEmpty2 = (typeof detectEmptyOutputFieldsByRatio === 'function')
          ? detectEmptyOutputFieldsByRatio(wafeFallbackFinalResult(wizardState), wizardState.outputSchema, { emptyRatioThreshold: 1.0, minRecords: 2 })
          : [];
        const hasAnnotations = Array.isArray(wizardState.annotations) && wizardState.annotations.length > 0;
        if (chronicEmpty2.length > 0 && !hasAnnotations) {
          const lastStepId2 = wizardState.steps[wizardState.steps.length - 1] && wizardState.steps[wizardState.steps.length - 1].id;
          const extractionStepId2 = (typeof findUpstreamExtractionStepId === 'function')
            ? findUpstreamExtractionStepId(wizardState.steps, lastStepId2)
            : lastStepId2;
          if (extractionStepId2) {
            // Record HTML comes from the extraction step's selectorDiagnostics
            // (captured by computeExtractListDiagnostics as firstContainerHtml),
            // NOT from the output records themselves — those are flat LLM-
            // extracted values without source HTML. See wizard-utils.js
            // getFirstRecordHtmlFromExecution for the rationale.
            // Fallback (RC34, console.log 2026-08-11): findUpstreamExtractionStepId
            // may return a $list-using step that doesn't capture firstContainerHtml
            // (the regex matches $list). When that happens, scan ALL events for any
            // step's firstContainerHtml — discovery just needs SOME container
            // snapshot, regardless of provenance.
            let recordHtml2 = (typeof getFirstRecordHtmlFromExecution === 'function')
              ? getFirstRecordHtmlFromExecution(wizardState.lastExecutionEvents || [], extractionStepId2)
              : '';
            let recordHtmlSource2 = recordHtml2 ? 'chosen-step' : 'none';
            if (!recordHtml2 && typeof getFirstRecordHtmlFromAnyStep === 'function') {
              recordHtml2 = getFirstRecordHtmlFromAnyStep(wizardState.lastExecutionEvents || []);
              if (recordHtml2) recordHtmlSource2 = 'any-step-fallback';
            }
            const DomCleanerRef2 = (typeof window !== 'undefined' && window.DomCleaner)
              || (typeof global !== 'undefined' && global.DomCleaner);
            if (recordHtml2 && DomCleanerRef2 && DomCleanerRef2.normalizeRecordStructure) {
              const normalized2 = DomCleanerRef2.normalizeRecordStructure(recordHtml2);
              const discoveryResult2 = (typeof discoverFieldCandidates === 'function')
                ? discoverFieldCandidates(normalized2, chronicEmpty2.map(f => f.path || f.field))
                : { fields: [] };
              fieldCandidatesSignal = (typeof formatFieldCandidatesBlock === 'function')
                ? formatFieldCandidatesBlock(discoveryResult2)
                : '';
            }
            // RC34 diagnostic: trace which condition fired (or all of them)
            // so future investigations into "fieldCandidatesChars: 0" don't
            // need to re-instrument. Mirrors the failure-fix branch.
            try {
              const _evts = wizardState.lastExecutionEvents || [];
              const _hasAnyHtml = (typeof getFirstRecordHtmlFromAnyStep === 'function')
                ? !!getFirstRecordHtmlFromAnyStep(_evts)
                : null;
              debugLogger.log('info', 'wizard', 'fieldCandidates gate', {
                branch: isFailureFix ? 'failure-fix' : 'user-feedback',
                attemptNum,
                chronicEmptyCount: chronicEmpty2.length,
                chronicEmptyPaths: chronicEmpty2.slice(0, 5).map(f => f.path),
                hasAnnotations,
                extractionStepId: extractionStepId2,
                recordHtmlChars: recordHtml2 ? recordHtml2.length : 0,
                recordHtmlSource: recordHtmlSource2,
                anyStepHasHtml: _hasAnyHtml,
                signalChars: fieldCandidatesSignal.length
              });
            } catch (_) { /* diagnostic must never break the prompt */ }
          }
        }
      } catch (_) { /* defensive: discovery must never break the prompt */ }
    }
    prompt = `${buildUrlTemplateNotice(wizardState.targetUrl)}${buildFeedbackSection(userFeedback, attemptNum, totalAttempts, wizardState.llmHistory)}${SCRIPT_DSL_GUIDE}

The following step failed. Fix it — primarily its script, but you MAY also adjust THIS step's onSuccess / onFailure / maxIterations if the runtime shows the step flow itself is wrong (the steps were generated before seeing this page state, so the topology can be a best guess). Do NOT add or remove steps; only edit this step's own fields.
${compactedNote}

Step ID: ${targetStepId}
Step name: ${targetStep.name}
On success → ${targetStep.onSuccess}
On failure → ${targetStep.onFailure}

Error: ${wizardState.lastError}
${summarizeExecutionDiagnostics(wizardState.lastExecutionEvents || [], targetStepId)}
Target URL: ${wizardState.targetUrl}
Original requirement: ${wizardState.description}

Current step script:
${targetStep.script}

${buildTimeoutGuidance(DEPLOY_TIMEOUT_MS).text}

${detailPageHint}${htmlSection}

Annotations: ${JSON.stringify(wizardState.annotations)}

IMPORTANT SELECTOR RULES:
- Look at the ACTUAL HTML above — use the EXACT class names, IDs, and attributes you see there. Do NOT guess or invent generic selectors.
- Many modern sites use CSS module hash class names (e.g., "_chat-container_r2am5_1"). Use these EXACTLY as they appear — they are stable within a session.
- Prefer selectors by ID (#id), data-testid, data-* attributes, or unique tag + class combinations you see in the HTML.
- If the element has no good selector, use tag name + text content approach: find a parent with a stable attribute, then traverse.

FULL STEP WORKFLOW:
${allStepsContext}
${testResultSection}
${fieldCandidatesSignal ? '\n' + fieldCandidatesSignal + '\n' : ''}
${RETURN_FORMAT}`;
  } else {
    // Success but user wants different results.
    //
    // bugx.log 2026-07-24 07:04:16: the previous prompt showed step 5's
    // script up-front ("Step ID: 5 / Current step script: <step 5>") which
    // anchored glm-5.1 on step 5. Even with the redirect option, the LLM
    // kept re-extracting publishTime inside step 5 instead of fixing step 4's
    // broken selector. Restructured: ALL steps shown first as equals, no
    // single "current step" block, and the new RETURN_FORMAT_FEEDBACK
    // requires an explicit stepId on every patch.
    // RC9 audit miss: this site also serializes wizardState.testResult and
    // must route through stripSnapshotsFromTestResult + stripPagesFromLLMContext.
    // Without it, a 5-step FB-shaped testResult carrying ~150K-char per-step
    // snapshot.html bloated the autoFix-on-empty prompt to ~845K chars
    // (console.log 2026-07-26 13:33:09), drowning the "container matched 0
    // element(s)" diagnostic signal that would have told the LLM to broaden its
    // selector. The LLM then iterated on more hallucinated restrictive selectors
    // and stayed at 0 matches.
    //
    // dedupeStepIterations (console.log 2026-08-05): added AFTER the 2026-07-26
    // strip-snapshots fix — polling-step iteration entries with growing
    // accumulators (updatedPosts etc.) bypassed the per-field cap and ballooned
    // the prompt to 1.83MB on a 9-iteration step-5. See testResultSection above
    // for ordering rationale.
    const currentOutput = wizardState.testResult
      ? JSON.stringify(stripPagesFromLLMContext(stripSnapshotsFromTestResult(dedupeStepIterations(wizardState.testResult))), null, 2)
      : '(no output)';

    // RC11 regression guard. The user-feedback path runs MAX_ATTEMPTS=1 per
    // submit, but the test result still flows through scoreAttemptResult and
    // bestAttempt tracking. If a prior user-feedback iteration produced a
    // HIGHER-scoring output than the current state (i.e. the last submit
    // regressed), wizardState.bestAttempt holds the working snapshot after
    // restoreBestAttempt rolls the scripts back. Surface this to the LLM so
    // it treats the current scripts as a known-good baseline and only
    // changes what's actually broken — without this, glm-5.1 will happily
    // rewrite a working selector to "improve" it and regress again
    // (console.log 2026-07-26 14:49:08 RC11: working `h3 a[role="link"]`
    // replaced with broken `a[role="link"][aria-label]`).
    const regressionGuard = buildRegressionGuard(wizardState.bestAttempt, scoreAttemptResult(wafeFallbackFinalResult(wizardState), wizardState.outputSchema));

    // RC15 (console.log 2026-07-27): user feedback "为空的不正常" was ambiguous
    // and glm-5.1 misread it as "not enough posts" — rewrote the scroll step
    // instead of fixing the extraction. The data-driven signal below names the
    // ACTUAL empty fields with contrastive non-empty examples from the same
    // records, so the LLM's attention is pinned on extraction-quality
    // regardless of how the user phrased the feedback. Generic — works for
    // any site, any field, not just FB comments/shares.
    emptyFieldsSignal = formatEmptyOutputFieldsSignal(
      detectEmptyOutputFieldsByRatio(wafeFallbackFinalResult(wizardState), wizardState.outputSchema)
    );

    // Empirical shape distribution (2026-08-05 architectural pivot):
    // surface ACTUAL shape variance observed in the extracted records, so the
    // LLM can write genuine shape-switching logic instead of conflating
    // distinct entity types in the same list (e.g., some records have group.*
    // populated while others have account.* — those are different shapes and
    // need conditional extraction, not a single flat extractor). This is a
    // test-driven signal derived from real output — does not depend on user
    // annotation, which is the fallback path. Stays empty when all records
    // share one signature (no variance to surface).
    shapeDistributionSignal = typeof formatShapeDistributionFromData === 'function'
      ? formatShapeDistributionFromData(wafeFallbackFinalResult(wizardState), wizardState.outputSchema)
      : '';

    // No-op escalation (console.log 2026-08-05): when the user submits the
    // same feedback that was just rejected as a no-op, inject a strong,
    // cache-busting warning into the CURRENT prompt. llmHistory's
    // [NO-OP DETECTED] alone proved insufficient — glm-5.1 returned
    // byte-identical responses across 3 iterations because the current
    // prompt was textually identical. The iteration counter both (a) tells
    // the LLM this is a retry and (b) busts any upstream proxy cache.
    noOpEscalation = buildNoOpEscalationSection(wizardState.consecutiveNoOpCount || 0);

    // Field candidate discovery (2026-08-07): when chronic-empty fields are
    // detected AND no annotations exist AND this is iteration 1 of the
    // current autoFix run, scan the normalized record HTML and surface up to
    // K candidate leaf elements per field. Suppress on iterations 2+ to
    // avoid LLM locking onto the same wrong candidate repeatedly.
    if (attemptNum === 1) {
      try {
        const chronicEmpty2 = (typeof detectEmptyOutputFieldsByRatio === 'function')
          ? detectEmptyOutputFieldsByRatio(wafeFallbackFinalResult(wizardState), wizardState.outputSchema, { emptyRatioThreshold: 1.0, minRecords: 2 })
          : [];
        const hasAnnotations = Array.isArray(wizardState.annotations) && wizardState.annotations.length > 0;
        if (chronicEmpty2.length > 0 && !hasAnnotations) {
          const lastStepId2 = wizardState.steps[wizardState.steps.length - 1] && wizardState.steps[wizardState.steps.length - 1].id;
          const extractionStepId2 = (typeof findUpstreamExtractionStepId === 'function')
            ? findUpstreamExtractionStepId(wizardState.steps, lastStepId2)
            : lastStepId2;
          if (extractionStepId2) {
            // Record HTML comes from the extraction step's selectorDiagnostics
            // (captured by computeExtractListDiagnostics as firstContainerHtml),
            // NOT from the output records themselves — those are flat LLM-
            // extracted values without source HTML. See wizard-utils.js
            // getFirstRecordHtmlFromExecution for the rationale.
            // Fallback (RC34, console.log 2026-08-11): findUpstreamExtractionStepId
            // may return a $list-using step that doesn't capture firstContainerHtml
            // (the regex matches $list). When that happens, scan ALL events for any
            // step's firstContainerHtml — discovery just needs SOME container
            // snapshot, regardless of provenance.
            let recordHtml2 = (typeof getFirstRecordHtmlFromExecution === 'function')
              ? getFirstRecordHtmlFromExecution(wizardState.lastExecutionEvents || [], extractionStepId2)
              : '';
            let recordHtmlSource2 = recordHtml2 ? 'chosen-step' : 'none';
            if (!recordHtml2 && typeof getFirstRecordHtmlFromAnyStep === 'function') {
              recordHtml2 = getFirstRecordHtmlFromAnyStep(wizardState.lastExecutionEvents || []);
              if (recordHtml2) recordHtmlSource2 = 'any-step-fallback';
            }
            const DomCleanerRef2 = (typeof window !== 'undefined' && window.DomCleaner)
              || (typeof global !== 'undefined' && global.DomCleaner);
            if (recordHtml2 && DomCleanerRef2 && DomCleanerRef2.normalizeRecordStructure) {
              const normalized2 = DomCleanerRef2.normalizeRecordStructure(recordHtml2);
              const discoveryResult2 = (typeof discoverFieldCandidates === 'function')
                ? discoverFieldCandidates(normalized2, chronicEmpty2.map(f => f.path || f.field))
                : { fields: [] };
              fieldCandidatesSignal = (typeof formatFieldCandidatesBlock === 'function')
                ? formatFieldCandidatesBlock(discoveryResult2)
                : '';
            }
            // RC34 diagnostic: trace which condition fired (or all of them)
            // so future investigations into "fieldCandidatesChars: 0" don't
            // need to re-instrument. Mirrors the failure-fix branch.
            try {
              const _evts = wizardState.lastExecutionEvents || [];
              const _hasAnyHtml = (typeof getFirstRecordHtmlFromAnyStep === 'function')
                ? !!getFirstRecordHtmlFromAnyStep(_evts)
                : null;
              debugLogger.log('info', 'wizard', 'fieldCandidates gate', {
                branch: isFailureFix ? 'failure-fix' : 'user-feedback',
                attemptNum,
                chronicEmptyCount: chronicEmpty2.length,
                chronicEmptyPaths: chronicEmpty2.slice(0, 5).map(f => f.path),
                hasAnnotations,
                extractionStepId: extractionStepId2,
                recordHtmlChars: recordHtml2 ? recordHtml2.length : 0,
                recordHtmlSource: recordHtmlSource2,
                anyStepHasHtml: _hasAnyHtml,
                signalChars: fieldCandidatesSignal.length
              });
            } catch (_) { /* diagnostic must never break the prompt */ }
          }
        }
      } catch (_) { /* defensive: discovery must never break the prompt */ }
    }

    prompt = `${buildUrlTemplateNotice(wizardState.targetUrl)}${buildFeedbackSection(userFeedback, attemptNum, totalAttempts, wizardState.llmHistory)}${SCRIPT_DSL_GUIDE}

CONTEXT — read carefully:
- This is NOT a runtime error. The service ran successfully and produced output — no exception, no stack trace.
- The user looked at the output and is reporting DATA-QUALITY problems they observed (e.g. a field is missing, only N items extracted, image URLs are incomplete, an extracted value is wrong).
- Your job is to figure out WHICH step's extraction logic produced the wrong data and fix it at the source. The bug may be in ANY step — there is no default target step.

User's observation feedback:
${userFeedback}
${noOpEscalation}${emptyFieldsSignal ? '\n' + emptyFieldsSignal + '\n' : ''}${shapeDistributionSignal ? '\n' + shapeDistributionSignal + '\n' : ''}${fieldCandidatesSignal ? '\n' + fieldCandidatesSignal + '\n' : ''}
Identify EVERY step in the workflow below whose script contains a root cause for the reported problems, and return a fix for each. Do NOT anchor on any particular step — the bug may be in any of them. Typical patterns:
- "field X is missing/wrong" → FIRST check whether the step has User-annotated selectors (listed under each step below as "User-annotated selectors"). Those were empirically verified by the user at author time and are the source of truth — copy them VERBATIM. If no annotation exists for field X, fall back to deriving from RECORD HTML in RUNTIME DIAGNOSTICS below. The most common cause of repeated extraction failure is the LLM inventing its own selector when a working annotation was available but ignored.
- "only N items extracted" → the scroll/paginate step (under-loaded) OR the extract step (container selector too narrow).
- "field X has wrong value" → the step that extracts that field — its selector matches the wrong element.
- "image URLs incomplete" → if the field is declared array and the script uses $extract('img','src'), switch to $list('img') (one src vs array of srcs).
- "field X populated in an earlier step but empty in final output" → INTER-STEP FIELD-NAME DRIFT. When a step consumes another step's result via __lastResult__ / __stepResults__, it MUST use the EXACT property names the upstream step writes. Cross-check the upstream step's return statement before reading any field off its output — a single renamed property silently erases the field (e.g. upstream returns {authorName, createdAt} but downstream reads p.author / p.time → both become undefined).
- "RECORD SHAPE DISTRIBUTION shows fields appearing in SOME shapes only" → SHAPE-SWITCHING. Multiple distinct entity types coexist in the same list (e.g. records with group.* vs records with account.* vs records with both — these are different real-world shapes, not extraction failures). Detect which marker field is present per record and conditionally populate the shape-specific fields, rather than forcing every record into one flat schema or conflating one shape's value into another shape's field. The conflation pattern (logical-or fallback like "x || y") is WRONG when x and y belong to different shapes — write explicit shape detection instead.
${compactedNote}

Target URL: ${wizardState.targetUrl}
Original requirement: ${wizardState.description}

${buildTimeoutGuidance(DEPLOY_TIMEOUT_MS).text}

FULL STEP WORKFLOW (analyze EVERY step — root cause may be in ANY of them):
${allStepsContext}

RUNTIME DIAGNOSTICS (per-step iteration traces from the last test run — read these before deciding root cause):
${summarizeAllStepDiagnostics(wizardState.lastExecutionEvents || [], wizardState.steps)}

Current output:
${currentOutput}
${regressionGuard}
${detailPageHint}${htmlSection}

Annotations: ${JSON.stringify(wizardState.annotations)}

IMPORTANT SELECTOR RULES:
- Look at the ACTUAL HTML above — use the EXACT class names, IDs, and attributes you see there. Do NOT guess or invent generic selectors.
- Many modern sites use CSS module hash class names (e.g., "_chat-container_r2am5_1"). Use these EXACTLY as they appear.
- Prefer selectors by ID (#id), data-testid, data-* attributes, or unique tag + class combinations.

${RETURN_FORMAT_FEEDBACK}`;
  }

  try {
    const client = new LLMClient(config.config);
    const systemMsg = { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping script fixer. Return fixed JavaScript code, or a JSON {"script":...} object if you also need to change this step flow (onSuccess/onFailure/maxIterations).') };
    // User-feedback path: each iteration's prompt is self-contained (full steps
    // + current output + diagnostics). The accumulated history is largely noise
    // and the original steps-generation prompt (~30K chars with full snapshot)
    // blows up glm-5.1's effective context via the proxy. Keep only the most
    // recent user-assistant pair so the LLM remembers its last fix attempt
    // without dragging the entire conversation forward.
    // Regression for console.log 2026-07-26 RC7: autoFix hit
    // finish_reason=model_context_window_exceeded with prompt_tokens:0 — the
    // proxy rejected the prompt pre-emptively. Trimming here prevents overflow
    // on the FIRST attempt instead of relying on the post-overflow retry.
    // C1: full history on both paths. Size control is delegated to trimLlmHistory
    // (C4), which caps total chars without sacrificing multi-round memory.
    const historyForPrompt = wizardState.llmHistory;
    const userMsg = { role: 'user', content: prompt };
    const messages = [systemMsg, ...historyForPrompt, userMsg];
    const promptSizeStats = {
      isFailureFix,
      historyMessages: historyForPrompt.length,
      historyChars: historyForPrompt.reduce((n, m) => n + (m.content?.length || 0), 0),
      promptChars: prompt.length,
      totalChars: historyForPrompt.reduce((n, m) => n + (m.content?.length || 0), 0) + prompt.length,
      snapshotBudget,
      steps: wizardState.steps.length
    };
    console.log('[autoFix] Prompt sizes:', promptSizeStats);
    const signalsIncluded = [];
    if (noOpEscalation) signalsIncluded.push('NO_OP_ESCALATION');
    if (emptyFieldsSignal) signalsIncluded.push('EMPTY_FIELDS');
    if (shapeDistributionSignal) signalsIncluded.push('RECORD_SHAPE_DISTRIBUTION');
    if (fieldCandidatesSignal) signalsIncluded.push('FIELD_CANDIDATES');
    if (typeof buildAnnotationsText === 'function' && wizardState.annotations && wizardState.annotations.length > 0) signalsIncluded.push('ANNOTATIONS');
    if (typeof summarizeAllStepDiagnostics === 'function') signalsIncluded.push('RUNTIME_DIAGNOSTICS');
    console.log('[autoFix] Signals emitted:', { signalsIncluded, emptyFieldsChars: emptyFieldsSignal.length, shapeDistributionChars: shapeDistributionSignal.length, fieldCandidatesChars: fieldCandidatesSignal.length, annotationCount: (wizardState.annotations || []).length });
    appendLog(`Prompt size: ${promptSizeStats.totalChars} chars (history ${promptSizeStats.historyMessages} msgs / ${promptSizeStats.historyChars} chars + current ${promptSizeStats.promptChars} chars, snapshot budget ${promptSizeStats.snapshotBudget}); signals: ${signalsIncluded.join(',') || '(none)'}`, 'info');
    const result = await client.chat(messages, {});

    wizardState.llmHistory.push(
      { role: 'user', content: summarizeFixIteration({
        stepId: targetStep ? targetStep.id : null,
        stepName: targetStep ? targetStep.name : '(user feedback — no single target step)',
        script: targetStep ? targetStep.script : '',
        annotations: wizardState.annotations || [],
        userFeedback: userFeedback,
        error: wizardState.lastError || null,
        result: wizardState.testResult || null,
        htmlContext: htmlSection
      }) },
      { role: 'assistant', content: result }
    );
    trimLlmHistory();

    const cleaned = cleanLLMResponse(result);
    if (!cleaned || !cleaned.trim()) {
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' returned empty script' + (targetStep ? ' for step "' + targetStep.name + '"' : '') + ', keeping original.', 'warn');
      return false;
    }
    // Parse the LLM response into a list of patches. Three formats are accepted:
    //   (a) {"patches": [{stepId, script}, ...], "analysis"?: "..."} — multi-step
    //       (user-feedback path; lets the LLM fix every root-cause step at once)
    //   (b) {"script": "...", "stepId"?:..., "onSuccess"?:..., ...} — single-step
    //       (legacy; still emitted by the error path and by older LLM responses)
    //   (c) Plain JS string — single patch on the heuristic target (legacy)
    // bugx.log 2026-07-24 07:04:16: the user-feedback path needed format (a)
    // because the LLM otherwise kept re-extracting publishTime inside step 5
    // instead of fixing step 4's broken selector.
    const trimmed = cleaned.trim();
    let rawPatches = null;
    let analysisNote = '';
    if (trimmed.startsWith('{')) {
      const parsed = parseJsonLenient(trimmed);
      if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
        if (Array.isArray(parsed.value.patches)) {
          rawPatches = parsed.value.patches;
          if (typeof parsed.value.analysis === 'string' && parsed.value.analysis.trim()) {
            analysisNote = ' Analysis: "' + parsed.value.analysis.trim().slice(0, 200) + '"';
          }
        } else if (typeof parsed.value.script === 'string') {
          rawPatches = [parsed.value];
        }
      }
    }
    if (rawPatches === null) {
      // Plain JS — single patch, no stepId (applies to heuristic target).
      rawPatches = [{ script: trimmed }];
    }
    // Resolve each patch to a step (honoring LLM-chosen stepId; falling back
    // to targetStepId when stepId is absent or unknown).
    const target = resolveAutoFixTargets(rawPatches, targetStepId, wizardState.steps);
    if (target.errors && target.errors.length) {
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' rejected patches: ' + target.errors.join('; ') + '. Keeping original.', 'warn');
      return false;
    }
    if (!target.resolved || !target.resolved.length) {
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' returned no usable patches, keeping original.', 'warn');
      return false;
    }
    // Build proposed steps. Each patch can also adjust flow fields on its step.
    const patchedById = new Map();
    for (const r of target.resolved) {
      const proposed = { ...r.step, script: r.patch.script };
      if (typeof r.patch.onSuccess === 'string' && r.patch.onSuccess.trim()) proposed.onSuccess = r.patch.onSuccess.trim();
      if (typeof r.patch.onFailure === 'string' && r.patch.onFailure.trim()) proposed.onFailure = r.patch.onFailure.trim();
      if (Number.isInteger(r.patch.maxIterations) && r.patch.maxIterations >= 1) proposed.maxIterations = r.patch.maxIterations;
      patchedById.set(r.step.id, { proposed, resolved: r });
    }
    // Detect no-op ACK: LLM said "I'll fix it" but every patch leaves its step
    // unchanged (same script + flow fields). console.log 2026-08-04 FB username
    // loop: ACK "I'll distinguish group from user links" + identical script
    // char-for-char → testScript produced identical wrong output → wasted attempt.
    // Skip the testScript re-run; inject an explicit [NO-OP] directive into
    // llmHistory so the next iteration's prompt carries "you must change code".
    if (isNoOpAutoFixPatch(target.resolved, patchedById)) {
      const stepIds = target.resolved.map(r => r.step.id).join(',');
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' returned the same script(s) as the current step(s) — no change was made. Prompting the LLM to actually modify the code.', 'warn');
      debugLogger.log('warn', 'wizard', 'autoFix no-op fix detected', {
        targetStepId, attemptNum, totalAttempts, stepIds
      });
      wizardState.llmHistory.push({
        role: 'user',
        content: '[NO-OP DETECTED] Your previous response proposed the same script(s) as the current step(s) — no change was made, and a re-run would produce the same wrong output. You MUST modify the script this time. Inspect the current script, identify the specific line that produces the wrong output, and rewrite THAT line. If you genuinely cannot see a fix, respond with "// NACK: <specific reason>" instead of faking a fix.'
      });
      trimLlmHistory();
      // No-op escalation (console.log 2026-08-05): the [NO-OP DETECTED]
      // message pushed to llmHistory above wasn't enough — the LLM/proxy
      // returned byte-identical responses across iterations because the
      // CURRENT prompt was textually identical. Track consecutive no-ops
      // per feedback so the next iteration's CURRENT prompt can carry a
      // strong cache-busting warning. After 2+ repeats, also surface a
      // user-visible toast so the user knows their submission had no effect
      // and can decide whether to rephrase, annotate, or switch provider.
      registerNoOpForFeedback(wizardState, userFeedback || '');
      if (wizardState.consecutiveNoOpCount >= 2) {
        showToast(
          'The AI has produced no change for this feedback ' + wizardState.consecutiveNoOpCount + ' times in a row. ' +
          'Try one of: rephrase the feedback more specifically, annotate the exact element on the page, or switch LLM provider (the current provider may be caching responses).',
          'warn',
          9000
        );
      }
      return false;
    }
    // Validate the WHOLE chain after applying every patch atomically. A
    // topology change that orphans a step or dangles a pointer rejects ALL
    // patches (the next auto-fix iteration can retry).
    const trialSteps = wizardState.steps.map(s => patchedById.has(s.id) ? patchedById.get(s.id).proposed : s);
    const chainCheck = validateChain(trialSteps);
    if (!chainCheck.valid) {
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' proposed an invalid step flow (' + chainCheck.error + '); keeping the previous step.', 'warn');
      return false;
    }
    // Log redirects (per patch) BEFORE committing, so the user can see what
    // the LLM chose even if a later test fails.
    const logParts = [];
    for (const r of target.resolved) {
      if (r.redirected) {
        debugLogger.log('info', 'wizard', 'autoFix redirected to LLM-chosen step', {
          fromStepId: targetStepId, toStepId: r.step.id, toStepName: r.step.name
        });
        logParts.push('"' + r.step.name + '" [redirected from "' + (targetStep ? targetStep.name : targetStepId) + '"]');
      } else if (r.fallbackReason) {
        logParts.push('"' + r.step.name + '" [' + r.fallbackReason + ']');
      } else {
        logParts.push('"' + r.step.name + '"');
      }
    }
    // Commit. For each patched step: write script + (if changed) flow fields,
    // and sync the wizard's editor inputs so a later confirmDeploy picks up
    // the fix instead of being overwritten by stale textarea values.
    // No-op escalation: a real patch means the loop is broken — clear the
    // consecutive no-op counter so the next feedback starts fresh.
    resetNoOpEscalation(wizardState);
    for (const [stepId, entry] of patchedById) {
      const step = wizardState.steps.find(s => s.id === stepId);
      if (!step) continue;
      const proposed = entry.proposed;
      const patch = entry.resolved.patch;
      const flowChanged =
        (typeof patch.onSuccess === 'string' && proposed.onSuccess !== step.onSuccess) ||
        (typeof patch.onFailure === 'string' && proposed.onFailure !== step.onFailure) ||
        (Number.isInteger(patch.maxIterations) && proposed.maxIterations !== step.maxIterations);
      step.script = proposed.script;
      if (flowChanged) {
        step.onSuccess = proposed.onSuccess;
        step.onFailure = proposed.onFailure;
        step.maxIterations = proposed.maxIterations;
      }
      const fixedDetail = document.querySelector(`.step-detail[data-step-id="${stepId}"]`);
      if (fixedDetail) {
        const fixedTa = fixedDetail.querySelector('.step-script-input');
        if (fixedTa) fixedTa.value = step.script;
        if (flowChanged) {
          const s = fixedDetail.querySelector('.step-success-input'); if (s) s.value = step.onSuccess || 'TERMINATE';
          const f = fixedDetail.querySelector('.step-failure-input'); if (f) f.value = step.onFailure || 'TERMINATE';
          const m = fixedDetail.querySelector('.step-maxiter-input'); if (m) m.value = step.maxIterations || 1;
        }
      }
    }
    wizardState.fixAttemptCount++;
    // currentScript shows the heuristic target's script if it was patched;
    // otherwise the last patched step's script. Keeps the UI consistent with
    // what the user was looking at when they clicked Auto-Fix. On the user-
    // feedback path (targetStepId null), just show the last patched step.
    const showStep = (targetStepId && patchedById.has(targetStepId))
      ? wizardState.steps.find(s => s.id === targetStepId)
      : target.resolved[target.resolved.length - 1].step;
    document.getElementById('currentScript').textContent = showStep.script;
    appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' applied to step(s): ' + logParts.join(', ') + ' (attempt #' + wizardState.fixAttemptCount + analysisNote + '). Re-testing...');

    await testScript();
    // testScript resets wizardState.lastError at start; it's set again in the
    // catch on failure. So null means the re-test passed.
    return !wizardState.lastError;
  } finally {
    hideLoading();
  }
}

async function confirmDeploy() {
  syncStepsFromEditor();
  const execCheck = validateForExecution(wizardState.steps);
  if (!execCheck.valid) {
    showToast('Cannot deploy: ' + execCheck.error, 'error', 5000);
    return;
  }
  if (execCheck.warnings && execCheck.warnings.length) {
    showToast('Warning: ' + execCheck.warnings[0], 'warn', 6000);
  }
  // WS4.3: confirm before deploying if the test was never run, failed, or produced empty required output.
  const tested = wizardState.testResult;
  const outCheck = tested ? validateOutputAgainstSchema(tested.finalResult, wizardState.outputSchema) : null;
  const deployReasons = [];
  if (!tested) deployReasons.push('the test was never run');
  else if (tested.finalResult == null) deployReasons.push('the test produced no final result');
  else if (outCheck && !outCheck.ok) deployReasons.push('required output fields are missing/empty: ' + outCheck.missing.join(', '));
  if (deployReasons.length) {
    if (!confirm('Deploy this service despite:\n - ' + deployReasons.join('\n - ') + '\n\nProceed?')) return;
  }

  const registry = new ServiceRegistry();
  const existingService = wizardState.editingServiceId ? await registry.getById(wizardState.editingServiceId) : null;

  const service = {
    id: wizardState.editingServiceId || crypto.randomUUID(),
    name: existingService ? existingService.name : await generateUniqueSlug(wizardState.serviceName || 'service', registry, wizardState.editingServiceId),
    displayName: wizardState.serviceName || (wizardState.requirements?.pageOps || wizardState.description || '').slice(0, 30),
    userDescription: wizardState.userDescription || wizardState.description || '',
    requirements: wizardState.requirements || null,
    targetUrl: wizardState.targetUrl,
    steps: wizardState.steps,
    inputSchema: wizardState.inputSchema,
    outputSchema: wizardState.outputSchema,
    sampleInput: wizardState.sampleInput,
    annotations: wizardState.annotations,
    config: existingService ? existingService.config : { enabled: true, timeoutMs: DEPLOY_TIMEOUT_MS, maxRetries: 1, autoCloseTab: true, maxStepIterations: 50, tabLoadTimeoutMs: 60000 },
    createdAt: existingService ? existingService.createdAt : Date.now()
  };

  await registry.save(service);
  showToast('Service deployed!', 'success');
  setTimeout(() => { window.location.href = 'options.html'; }, 1000);
}

function waitForTabLoad(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab load timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

async function sendMessageWithRetry(tabId, message, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw e;
      }
    }
  }
}
