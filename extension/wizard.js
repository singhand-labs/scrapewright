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
  testInput: {},
  lastError: null,
  editingServiceId: null,
  originalName: null,
  llmHistory: [],
  stepAnnotationTabs: {},
  testAbortController: null,
  testAborted: false,
  subtreeSelector: null
};

function buildSystemMessageWithGlobalContext(baseSystemContent) {
  const desc = (wizardState.userDescription || wizardState.description || '').trim();
  return appendGlobalContextBlock(baseSystemContent, desc);
}

// renderCleanedResult: produce the prompt-rendered form of whatever mode
// DomCleaner.cleanHtmlForLLM returned. Used by prompt assembly to
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
// the steps-generation LLM call emitted 8206 chars of JSON that JSON.parse
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
  // for typical flows (which stay well under the limit) but caps pathological
  // growth (many rounds with page changes).
  // RC60 (console.log 2026-08-18): floor relaxed 4 → 2. Live evidence: round-3
  // history was 4 messages / 176,469 chars — over the 150K cap, yet the old
  // `length > 4` floor blocked every trim. The floor's only job is to keep
  // the most recent user/assistant pair; anything above it is trimmable.
  const limit = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : 150000;
  let total = wizardState.llmHistory.reduce((n, m) => n + (m.content?.length || 0), 0);
  let trimmed = false;
  while (total > limit && wizardState.llmHistory.length > 2) {
    const removed = wizardState.llmHistory.shift();
    total -= (removed.content?.length || 0);
    trimmed = true;
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

  // Direct reference (not a click-event-capturing arrow) — a click Event
  // would land in startResearchSession's seedOverride param.
  const startResearchSessionFromClick = () => startResearchSession();
  document.getElementById('btnPhase1Research').addEventListener('click', startResearchSessionFromClick);
  document.getElementById('sessionMaxTurns').addEventListener('change', () => { getSessionMaxTurns(); });
  loadSessionMaxTurns();
  document.getElementById('btnPhase2Next').addEventListener('click', () => goToPhase(3));
  document.getElementById('btnPhase2Back').addEventListener('click', () => goToPhase(1));
  document.getElementById('btnPhase3Test').addEventListener('click', runTestFromStep5);
  document.getElementById('btnPhase3Back').addEventListener('click', () => goToPhase(2));
  document.getElementById('btnPhase4Back').addEventListener('click', () => goToPhase(3));
  document.getElementById('btnPhase5Deploy').addEventListener('click', confirmDeploy);
  document.getElementById('btnPhase5Back').addEventListener('click', () => goToPhase(4));
  document.getElementById('btnPhase5EditSteps').addEventListener('click', () => goToPhase(2));
  document.getElementById('btnRetryTest').addEventListener('click', async () => {
    wizardState.testAborted = false;
    // A4: phase5 has no progress UI of its own (log/progress live on the
    // hidden phase4) — surface the overlay for the whole retry run.
    showLoading('Running test…');
    try {
      await testScript();
    } finally {
      hideLoading();
    }
  });
  document.getElementById('btnSessionPause').addEventListener('click', () => { wizardSession && wizardSession.pause(); });
  document.getElementById('btnSessionResume').addEventListener('click', async () => {
    const btn = document.getElementById('btnSessionResume');
    if (!wizardSession) { await resumeResearchSession(); return; }
    const stopped = wizardSession.state().session.stopped;
    const budgetStop = stopped && ['maxTurns', 'wallClock', 'tokenCap'].indexOf(stopped.reason) !== -1;
    if (budgetStop) {
      // G5: a fresh engine honors raised budget knobs.
      btn.disabled = true;
      try { await resumeResearchSession(); } finally { btn.disabled = false; }
      return;
    }
    btn.disabled = true;
    setSessionControls('running');
    try {
      const report = await wizardSession.run();
      if (report && report.stopped && sessionStopPresentsOutcome(report.stopped.reason)) await presentSessionCompletion();
    } finally { btn.disabled = false; }
    return;
  });
  document.getElementById('btnSessionAbort').addEventListener('click', () => {
    sessionAbortRequested = true;
    wizardSession && wizardSession.abort('user');
  });
  document.getElementById('btnAnnotationFinish').addEventListener('click', async () => {
    const btn = document.getElementById('btnAnnotationFinish');
    btn.disabled = true;
    try { wizardAnnotationBridge && await wizardAnnotationBridge.finish(); }
    finally { btn.disabled = false; }
  });
  document.getElementById('btnAnnotationCancel').addEventListener('click', () => { wizardAnnotationBridge && wizardAnnotationBridge.cancel(); });
  document.getElementById('btnIoConfirm').addEventListener('click', () => { wizardIoBridge && wizardIoBridge.confirm(); });
  document.getElementById('btnIoRevise').addEventListener('click', () => {
    const text = String(document.getElementById('ioConfirmFeedback').value || '').trim();
    if (!text) {
      showToast('Describe the changes first — or press Confirm to approve as-is.', 'warn', 4000);
      return;
    }
    wizardIoBridge && wizardIoBridge.revise(text);
  });
  document.getElementById('btnIoReject').addEventListener('click', () => { wizardIoBridge && wizardIoBridge.reject(); });
  document.getElementById('btnDeployAnyway').addEventListener('click', () => {
    // A16: the button only exists on phase5 — no phase switch needed.
    confirmDeploy();
  });
  document.getElementById('btnSessionFeedback').addEventListener('click', sendSessionFeedback);
  document.getElementById('serviceNameEdit').addEventListener('input', (e) => {
    wizardState.serviceName = e.target.value;
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
    updateUrlTemplateHint(wizardState.sampleInput || null);
  });
  document.getElementById('reqPageOps').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) startResearchSession();
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

  // Resume offer: an interrupted research session is parked in storage —
  // surface it once so the user knows Ctrl+Enter / Research resumes it.
  (async () => {
    try {
      const p = SessionPersistence.createSessionPersistence(chrome.storage.local, 'wizardResearchSession');
      const saved = await p.load();
      if (saved && saved.session && (!saved.session.stopped || ['paused', 'aborted', 'maxTurns', 'wallClock', 'tokenCap'].indexOf(saved.session.stopped.reason) !== -1)) {
        showToast('An interrupted research session was found. Press Ctrl+Enter on the requirement box or click Research to resume it.', 'info', 8000);
      }
    } catch (e) { /* storage unavailable */ }
  })();
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
  wizardState.description = buildRequirementsBlock(wizardState.requirements, svc.targetUrl);
  wizardState.serviceName = svc.displayName || '';
  wizardState.steps = svc.steps || [];
  wizardState.inputSchema = svc.inputSchema || { type: 'object' };
  wizardState.outputSchema = svc.outputSchema || { type: 'object' };
  wizardState.annotations = svc.annotations || [];
  wizardState.sampleInput = svc.sampleInput || {};
  wizardState.llmHistory = [];
  wizardState.phase = 2;

  document.getElementById('targetUrl').value = svc.targetUrl;
  updateUrlTemplateHint(wizardState.sampleInput || null);
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
  const btnDeployAnyway = document.getElementById('btnDeployAnyway');
  const btnPhase5Deploy = document.getElementById('btnPhase5Deploy');
  const testStatus = document.getElementById('testStatus');

  [btnRetryTest, btnDeployAnyway, btnPhase5Deploy].forEach(b => b.classList.add('hidden'));
  testStatus.className = '';

  const nameInput = document.getElementById('serviceNameEdit');
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = wizardState.serviceName || '';
  }
  renderIOSummary();

  if (state === 'success') {
    testStatus.textContent = 'All steps passed!';
    testStatus.className = 'success';
    btnPhase5Deploy.classList.remove('hidden');
  } else if (state === 'empty-result') {
    testStatus.textContent = 'Test passed but extracted data is empty — extraction may not be working correctly.';
    testStatus.className = 'fixing';
    btnRetryTest.classList.remove('hidden');
    btnDeployAnyway.classList.remove('hidden');
    debugLogger.log('warn', 'wizard', 'Empty result detected, showing fix controls');
  } else if (state === 'failure') {
    const stepInfo = wizardState.lastErrorStepId ? ' (step: ' + wizardState.lastErrorStepId + ')' : '';
    testStatus.textContent = wizardState.lastError
      ? 'Test failed: ' + wizardState.lastError + stepInfo
      : 'Test failed';
    testStatus.className = 'failure';
    btnRetryTest.classList.remove('hidden');
    btnDeployAnyway.classList.remove('hidden');
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
  // A15: unified visibility — the .hidden class everywhere, not the attribute.
  if (pages.length === 0) {
    viewer.classList.add('hidden');
    return;
  }
  viewer.classList.remove('hidden');
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

// A7: 60-turn sessions used to append thousands of DOM nodes here. Cap the
// log at LOG_MAX_ENTRIES entries; when the cap is exceeded drop the OLDEST
// log lines and keep a single sticky disclosure at the top of the container.
function appendLog(message, level = 'info') {
  const LOG_MAX_ENTRIES = 500;
  const logEl = document.getElementById('executionLog');
  if (!logEl) return;
  const line = document.createElement('div');
  line.className = 'log-line' + (level === 'error' ? ' error' : level === 'success' ? ' success' : '');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
  logEl.appendChild(line);
  // Trim: keep at most LOG_MAX_ENTRIES real log lines, plus one disclosure.
  let trimmed = logEl.querySelector('.log-trimmed');
  let dropped = trimmed ? parseInt(trimmed.dataset.dropped || '0', 10) : 0;
  let lines = logEl.querySelectorAll('.log-line');
  while (lines.length > LOG_MAX_ENTRIES) {
    const oldest = lines[0];
    if (!oldest || !oldest.parentNode) break;
    logEl.removeChild(oldest);
    dropped += 1;
    lines = logEl.querySelectorAll('.log-line');
  }
  if (dropped > 0) {
    if (!trimmed) {
      trimmed = document.createElement('div');
      trimmed.className = 'log-trimmed';
      logEl.insertBefore(trimmed, logEl.firstChild);
    }
    trimmed.dataset.dropped = String(dropped);
    trimmed.textContent = '… ' + dropped + ' earlier lines trimmed';
  }
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
  // AI-refined). Include it as a baseline so refinements are
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
  setSessionControls('idle');
  // A5 follow-up: the resolve buttons live inside these panels — hiding a
  // panel with a pending bridge request would orphan the awaiting session
  // run() until Abort. Cancel the bridge (no-op when nothing is pending) so
  // the engine sees a cancelled/declined reply and exits cleanly.
  const annPanel = document.getElementById('annotationRequestPanel');
  if (annPanel && !annPanel.classList.contains('hidden')) {
    if (wizardAnnotationBridge) wizardAnnotationBridge.cancel();
    appendLog('Annotation request closed — a manual test from Phase 5 parked the session panels.', 'warn');
  }
  if (annPanel) annPanel.classList.add('hidden');
  const ioPanel = document.getElementById('ioConfirmPanel');
  if (ioPanel && !ioPanel.classList.contains('hidden')) {
    if (wizardIoBridge) wizardIoBridge.cancel();
    appendLog('I/O confirmation closed — a manual test from Phase 5 parked the session panels.', 'warn');
  }
  if (ioPanel) ioPanel.classList.add('hidden');
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
  wizardState.lastError = null;
  wizardState.lastErrorStepId = null;
  wizardState.lastErrorSnapshot = null;
  wizardState.lastExecutionEvents = [];
  wizardState.testAbortController = new AbortController();
  wizardState.testAborted = false;
  sessionAbortRequested = false; // A1: an aborted session must not poison manual tests
  wizardState.trustedWheelSkipCount = 0;
  debugLogger.log('info', 'wizard', 'testScript start', {
    targetUrl: wizardState.targetUrl,
    stepCount: wizardState.steps ? wizardState.steps.length : 0,
    testInput: wizardState.testInput
  });

  if (!wizardRail) wizardRail = makeWizardRail();
  wizardRunner = null; // rebind ensureLock/getSignal to fresh state
  const runner = getWizardRunner();

  const service = {
    targetUrl: wizardState.targetUrl,
    steps: wizardState.steps,
    config: { timeoutMs: hoverAwareTimeoutMs(wizardState.steps, DEPLOY_TIMEOUT_MS), maxRetries: 0, autoCloseTab: true, maxStepIterations: 50, tabLoadTimeoutMs: 60000 }
  };

  appendLog('Starting step execution...');
  let out;
  try {
    out = await runner({ service: service, input: wizardState.testInput || {}, outputSchema: wizardState.outputSchema });
  } finally {
    wizardRail.releaseLock(); // manual runs release; the session holds it across turns
  }

  await presentTestOutcome(out);
}

// Shared post-run presentation for BOTH the manual test run (testScript) and
// the research-session completion path (presentSessionCompletion): stores the
// outcome into wizardState, renders phase 5, and lands on it.
async function presentTestOutcome(out) {
  wizardState.lastExecutionEvents = out.events;
  wizardState.countShortfall = out.report.detectors.countShortfall || null;
  wizardState.shapeDistribution = out.report.detectors.shapeDistribution || null;
  wizardState.testResult = out.report.ok ? out.raw.testResult : (out.raw.error && out.raw.error.steps ? { steps: out.raw.error.steps, finalResult: null } : out.raw.testResult);

  if (out.report.ok) {
    document.getElementById('testResults').textContent = JSON.stringify(out.raw.testResult, null, 2);
    renderResultSummary(out.raw.testResult);
    renderPagesViewer(out.raw.testResult);
    appendLog('All steps completed.', 'success');
    if (out.report.detectors.shapeDistribution) {
      appendLog(out.report.detectors.shapeDistribution, 'warn');
    }
    (out.raw.testResult.steps || []).forEach((step, i) => {
      appendLog('Step ' + (i + 1) + ' "' + step.stepName + '": ' + (step.skipped ? 'skipped (' + step.skipReason + ')' : 'completed'), step.skipped ? 'info' : 'success');
    });
    renderExecutionTimeline(out.raw.testResult.steps || []);
    const lastStep = (out.raw.testResult.steps || [])[(out.raw.testResult.steps || []).length - 1];
    if (lastStep && lastStep.snapshot) {
      wizardState.lastErrorSnapshot = { ...lastStep.snapshot, capturedAt: Date.now() };
    }
    if (out.report.schemaOk) {
      updatePhaseUI('success');
    } else {
      updatePhaseUI('empty-result');
      const gotKeys = (out.report.finalResult && typeof out.report.finalResult === 'object') ? Object.keys(out.report.finalResult) : [];
      const wantKeys = (wizardState.outputSchema && wizardState.outputSchema.required) || [];
      const tr = document.getElementById('testResults');
      if (tr) tr.textContent += '\n\nOUTPUT SCHEMA MISMATCH:\n  result fields: [' + gotKeys.join(', ') + ']\n  required:     [' + wantKeys.join(', ') + ']\n  missing:      [' + out.report.schemaMissing.join(', ') + ']\nThe extraction step must return the EXACT field names declared in outputSchema.';
      debugLogger.log('warn', 'wizard', 'Output schema mismatch', { got: gotKeys, want: wantKeys, missing: out.report.schemaMissing });
    }
    debugLogger.log('info', 'wizard', 'presentTestOutcome ok', { finalResult: out.raw.testResult.finalResult });
  } else {
    const err = out.raw.error || new Error(out.report.error.message);
    wizardState.lastError = out.report.error.message;
    wizardState.lastErrorStepId = out.report.error.stepId;
    if (err.snapshot) wizardState.lastErrorSnapshot = { ...err.snapshot, capturedAt: Date.now() };
    if (out.report.aborted) wizardState.testAborted = true;
    document.getElementById('testResults').textContent = 'Error: ' + out.report.error.message + (out.report.error.stepId ? ' (in step: ' + out.report.error.stepId + ')' : '');
    document.getElementById('resultSummary').innerHTML = '';
    // A12: a failed run has no trustworthy pages list — hide the viewer
    // rather than render pages from a partial/previous state.
    renderPagesViewer(null);
    const raw = document.getElementById('rawOutputDetails');
    if (raw) raw.classList.remove('hidden');
    appendLog(out.report.aborted ? 'Test aborted.' : 'Execution failed: ' + out.report.error.message, out.report.aborted ? 'info' : 'error');
    if (out.raw.testResult && out.raw.testResult.steps) renderExecutionTimeline(out.raw.testResult.steps);
    debugLogger.log('error', 'wizard', 'presentTestOutcome failed', { error: out.report.error.message, stepId: out.report.error.stepId });
    updatePhaseUI('failure');
  }

  if ((wizardState.trustedWheelSkipCount || 0) > 0 && !wizardState.testAborted) {
    const count = wizardState.trustedWheelSkipCount;
    const tip = 'Scrolling stalled ' + count + '× on this page; Enhanced Mode (trusted-wheel fallback) is off — enable it under Settings → Enhanced scraping mode for sites that gate lazy-load on isTrusted scroll events.';
    appendLog(tip, 'warn');
    showToast(tip, 'info', 8000);
  }

  if (!wizardState.testAborted) goToPhase(5);
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
            confirmedSelectors: (step.annotations || []).map(a => ({
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
    config: existingService
      ? { ...existingService.config, timeoutMs: hoverAwareTimeoutMs(wizardState.steps, existingService.config?.timeoutMs ?? DEPLOY_TIMEOUT_MS) }
      : { enabled: true, timeoutMs: hoverAwareTimeoutMs(wizardState.steps, DEPLOY_TIMEOUT_MS), maxRetries: 1, autoCloseTab: true, maxStepIterations: 50, tabLoadTimeoutMs: 60000 },
    // Spec §3B: persist the session's findings ledger as the service's
    // per-site memory — a later edit/repair session seeds from it instead
    // of re-discovering the page.
    findingsLedger: (wizardSession && wizardSession.ledger)
      ? wizardSession.ledger.serialize()
      : (existingService && existingService.findingsLedger) || undefined,
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

// ===== Research session integration (spec 2026-09-01) =====

let wizardSession = null;   // ResearchSession instance (public API)
let wizardRail = null;      // LiveRail instance
let wizardRunner = null;    // verify-runner instance (shared: testScript + verify.run)
let wizardToolsBag = null;  // SessionTools instance
let wizardPersistence = null;
let sessionAbortRequested = false;

// LLMClient.chat returns a bare string and THROWS its deterministic failures.
// The engine expects {content, finish_reason, usage}: map the client's
// empty+length non-retryable error onto an empty content + finish_reason
// 'length' return so the ENGINE's RC55 discipline fires on attempt 1
// instead of burning retry budgets.
function makeLlmAdapter(client) {
  return async ({ messages, maxTokens }) => {
    try {
      const content = await client.chat(messages, { maxTokens });
      return { content: String(content || ''), finish_reason: '', usage: null };
    } catch (e) {
      if (e && e.retryable === false && /finish_reason[=:]length/.test(String(e.message || ''))) {
        return { content: '', finish_reason: 'length', usage: null };
      }
      throw e;
    }
  };
}

function makeWizardRail() {
  return LiveRail.createLiveRail({
    defaultUrl: wizardState.targetUrl,
    createTab: (url) => createScrapeTab(url),
    removeTab: (tabId) => chrome.tabs.remove(tabId).catch(() => {}),
    waitForTabLoad: (tabId) => withTimeout(waitForTabLoad(tabId), 60000, 'Page load timeout (60s)'),
    getTab: (tabId) => chrome.tabs.get(tabId),
    watchTab: (tabId, onReload) => {
      // C3: a complete→loading transition on the SAME tab is a reload or
      // same-tab navigation — the DOM resets and every probe receipt from
      // before is stale. Registration happens after waitForTabLoad settled,
      // so the initial load never counts (last starts as 'complete').
      const last = { status: 'complete' };
      function listener(updatedTabId, info) {
        if (updatedTabId !== tabId || typeof info.status !== 'string') return;
        const prev = last.status;
        last.status = info.status;
        if (prev === 'complete' && info.status === 'loading') onReload();
      }
      chrome.tabs.onUpdated.addListener(listener);
      return () => chrome.tabs.onUpdated.removeListener(listener);
    },
    pingReady: async (tabId) => {
      for (let i = 0; i < 20; i++) {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
          if (r && r.pong) return true;
        } catch (e) { /* not ready yet */ }
        await new Promise((res) => setTimeout(res, 300));
      }
      return false;
    },
    execute: async (tabId, snippet) => {
      const executor = new OffscreenExecutor(tabId);
      executor.timeoutMs = 30000;
      const r = await executor.execute(snippet, {});
      return r.result; // probes want the snippet result
    },
    acquireLock: () => chrome.runtime.sendMessage({ type: 'ACQUIRE_EXEC_LOCK' }),
    releaseLock: () => chrome.runtime.sendMessage({ type: 'RELEASE_EXEC_LOCK' }),
    log: (level, msg) => appendLog(msg, level === 'error' ? 'error' : 'info')
  });
}

function getWizardRunner() {
  if (wizardRunner) return wizardRunner;
  wizardRunner = VerifyRunner.createVerifyRunner({
    orchestrate: (service, input, deps, options) => StepOrchestrator.execute(service, input, deps, options),
    ensureLock: () => wizardRail ? wizardRail.ensureLock() : Promise.resolve(),
    getSignal: () => ({
      aborted: !!(wizardState.testAbortController && wizardState.testAbortController.signal.aborted) || sessionAbortRequested
    }),
    log: (msg, level) => appendLog(msg, level === 'error' ? 'error' : level === 'warn' ? 'info' : 'info'),
    onEvent: (evt) => { try { renderExecutionProgress(evt); } catch (_) {} },
    createTab: (url) => createScrapeTab(url),
    removeTab: (tabId) => chrome.tabs.remove(tabId).catch(() => {}),
    waitForTabLoad: (tabId) => waitForTabLoad(tabId),
    sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
    executeScript: async (tabId, script, input, timeoutMs) => {
      const executor = new OffscreenExecutor(tabId);
      executor.timeoutMs = timeoutMs || 30000;
      return executor.execute(script, input);
    },
    captureSnapshot: async (tabId) => {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOM_SNAPSHOT' });
      wizardState.lastSnapshot = response.snapshot;
      return response.snapshot;
    },
    evaluateCondition: async (tabId, conditionExpr) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (expr) => { try { return eval(expr); } catch (e) { return false; } },
        args: [conditionExpr]
      });
      return results[0] && results[0].result ? results[0].result : false;
    }
  });
  return wizardRunner;
}

function applySessionArtifact(a) {
  wizardState.steps = a.steps;
  if (a.inputSchema && typeof a.inputSchema === 'object') wizardState.inputSchema = a.inputSchema;
  if (a.outputSchema && typeof a.outputSchema === 'object') wizardState.outputSchema = a.outputSchema;
  if (a.testInput && typeof a.testInput === 'object') wizardState.testInput = a.testInput;
  if (typeof a.name === 'string' && a.name.trim()) wizardState.serviceName = a.name.trim();
  renderStepList();
}

// The annotate.request host bridge (spec §5): activates the rail tab so the
// user can see/click it, starts annotation mode, and resolves when the user
// finishes or cancels. Wall-clock keeps running while the user annotates —
// documented behavior; the session budget default (30 min) covers it and
// the UI shows the request.
function createWizardAnnotationBridge(getRail) {
  let pending = null;
  const panel = () => document.getElementById('annotationRequestPanel');
  const show = (req) => {
    document.getElementById('annotationRequestWhy').textContent = req.why || 'The AI could not determine this from the page alone.';
    document.getElementById('annotationRequestScope').textContent =
      (req.containerSel ? 'Annotate inside: ' + req.containerSel + '. ' : '') +
      (req.fields && req.fields.length ? 'Fields: ' + req.fields.join(', ') + '. ' : '') +
      'The page tab was brought to the front — click elements to mark them, then come back and press Submit Annotations.';
    panel().classList.remove('hidden');
  };
  const hide = () => panel().classList.add('hidden');
  return {
    async request(req) {
      const rail = getRail();
      const tabId = rail ? rail.tabId : null;
      if (tabId == null) return { cancelled: true, error: 'no page open — the AI should call page.open first' };
      try { await chrome.tabs.update(tabId, { active: true }); } catch (e) { /* tab may be gone */ }
      try {
        await sendMessageWithRetry(tabId, {
          type: 'START_ANNOTATION',
          inputSchema: wizardState.inputSchema,
          outputSchema: wizardState.outputSchema,
          outputFieldOptions: getOutputFieldOptions(wizardState.outputSchema)
        });
      } catch (e) {
        return { cancelled: true, error: 'annotation mode failed to start: ' + String(e.message || e) };
      }
      show(req);
      return await new Promise((resolve) => { pending = resolve; });
    },
    async finish() {
      const rail = getRail();
      const tabId = rail ? rail.tabId : null;
      if (tabId == null || !pending) return;
      let captured;
      try {
        captured = await sendMessageWithRetry(tabId, { type: 'CAPTURE_ANNOTATION' });
      } catch (e) {
        captured = { error: String(e.message || e) };
      }
      hide();
      const done = pending;
      pending = null;
      if (!captured || captured.error || !Array.isArray(captured.annotations) || !captured.annotations.length) {
        done({ cancelled: true, error: (captured && captured.error) || 'no annotations captured' });
        return;
      }
      // Tag every pick provenance 'user' — these are direct human selections,
      // the highest-trust evidence the findings ledger keeps on compaction.
      done({
        annotations: captured.annotations.map((p) => Object.assign({}, p, { provenance: 'user' })),
        url: captured.url || ''
      });
    },
    cancel() {
      if (!pending) return;
      const done = pending;
      pending = null;
      hide();
      done({ cancelled: true });
    }
  };
}

let wizardAnnotationBridge = null;
let wizardIoBridge = null;

// Ninth-log follow-up (user request): the session must confirm the I/O
// contract with the user EARLY — before deep research and authoring — so the
// model never builds a verified artifact against schemas the user never
// signed off on. Mirrors the annotation bridge pattern: io.confirm parks the
// engine's turn on a pending promise until the user answers the panel.
function createWizardIoBridge() {
  let pendingResolve = null;

  function hidePanel() {
    const panel = document.getElementById('ioConfirmPanel');
    if (panel) panel.classList.add('hidden');
  }

  return {
    request(req) {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        const r = req && typeof req === 'object' ? req : {};
        const noteEl = document.getElementById('ioConfirmNote');
        if (noteEl) noteEl.textContent = String(r.note || '');
        const inEl = document.getElementById('ioConfirmInput');
        if (inEl) inEl.textContent = JSON.stringify(r.inputSchema || {}, null, 2);
        const outEl = document.getElementById('ioConfirmOutput');
        if (outEl) outEl.textContent = JSON.stringify(r.outputSchema || {}, null, 2);
        const fbEl = document.getElementById('ioConfirmFeedback');
        if (fbEl) fbEl.value = '';
        const panel = document.getElementById('ioConfirmPanel');
        if (panel) panel.classList.remove('hidden');
        appendLog('I/O contract proposed — confirm or revise it to let the session continue.', 'warn');
        showToast('Confirm the input/output contract to continue the research session.', 'info', 6000);
      });
    },
    confirm() {
      const r = pendingResolve;
      pendingResolve = null;
      hidePanel();
      if (r) { appendLog('I/O contract confirmed by the user.', 'success'); r({ confirmed: true }); }
    },
    revise(text) {
      const r = pendingResolve;
      pendingResolve = null;
      hidePanel();
      if (r) { appendLog('I/O contract revision requested: ' + String(text).slice(0, 200), 'warn'); r({ confirmed: false, feedback: String(text || '') }); }
    },
    cancel() {
      const r = pendingResolve;
      pendingResolve = null;
      hidePanel();
      if (r) r({ confirmed: false, feedback: '(cancelled — session stopped before confirmation)' });
    },
    reject() {
      const r = pendingResolve;
      pendingResolve = null;
      hidePanel();
      if (r) {
        appendLog('I/O contract rejected by the user — the session will renegotiate.', 'warn');
        r({ confirmed: false, feedback: 'User rejected this contract proposal — renegotiate based on evidence: re-propose with different fields, or justify adding/dropping them.' });
      }
    }
  };
}

// Sixth-log G5: the turn budget is a user knob (engine default 60). Read
// live so raising it before Resume extends a session that stopped at the cap.
let wizardMaxTurns = 60;

async function loadSessionMaxTurns() {
  try {
    const o = await chrome.storage.local.get('wizardMaxTurns');
    if (o && +o.wizardMaxTurns >= 10 && +o.wizardMaxTurns <= 500) wizardMaxTurns = Math.floor(+o.wizardMaxTurns);
    const el = document.getElementById('sessionMaxTurns');
    if (el) el.value = String(wizardMaxTurns);
  } catch (e) { /* storage unavailable — keep the default */ }
}

function getSessionMaxTurns() {
  const el = document.getElementById('sessionMaxTurns');
  const v = el ? +el.value : NaN;
  if (v >= 10 && v <= 500) {
    wizardMaxTurns = Math.floor(v);
    try { chrome.storage.local.set({ wizardMaxTurns: wizardMaxTurns }); } catch (e) { /* best-effort persistence */ }
  } else if (el) {
    el.value = String(wizardMaxTurns);
  }
  return wizardMaxTurns;
}

function setSessionControls(mode) {
  const bar = document.getElementById('sessionControls');
  if (!bar) return;
  if (mode === 'idle') { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('btnSessionPause').classList.toggle('hidden', mode !== 'running');
  document.getElementById('btnSessionResume').classList.toggle('hidden', mode !== 'paused' && mode !== 'stopped');
  document.getElementById('btnSessionAbort').classList.toggle('hidden', mode !== 'running' && mode !== 'paused');
}

function updateSessionSpendLine(st) {
  const el = document.getElementById('sessionSpend');
  if (!el || !st) return;
  const sp = st.session.spend;
  el.textContent = 'turns ' + sp.turns + '/' + wizardMaxTurns + ' · tokens ~' + (sp.promptTokens + sp.completionTokens) +
    (sp.estimated ? ' (est)' : '') + ' · ledger ' + st.ledger.entries.length;
}

function handleSessionEvent(ev) {
  // Console mirror (second-live-log D2): the UI execution log is invisible in
  // exported console logs — the verify#2 anomaly was undiagnosable because
  // tool results never reached the console. Mirror every session event with
  // its key fields; the mirror must never break the handler.
  try {
    if (ev && ev.type === 'tool_result') {
      console.log('[session] TOOL RESULT', ev.tool, ev.ok ? 'ok' : 'ERR', String(ev.summary || '').slice(0, 300));
    } else if (ev && ev.type === 'tool_call') {
      console.log('[session] TOOL', ev.tool, JSON.stringify(ev.args || {}).slice(0, 200));
    } else if (ev && ev.type) {
      console.log('[session]', ev.type, JSON.stringify(ev).slice(0, 200));
    }
  } catch (e) { /* mirror is best-effort */ }
  try {
    switch (ev.type) {
      case 'session_start':
        appendLog('Research session ' + ev.sessionId + (ev.resuming ? ' (resumed)' : '') + ' started.', 'success');
        break;
      case 'turn_start':
        appendLog('— turn ' + ev.turn + ' —');
        updateSessionSpendLine(wizardSession && wizardSession.state());
        break;
      case 'llm_reply':
        appendLog('LLM replied (' + ev.chars + ' chars' + (ev.finish_reason ? ', finish: ' + ev.finish_reason : '') + ').');
        break;
      case 'tool_call':
        appendLog('TOOL ' + ev.tool + ' ' + JSON.stringify(ev.args || {}).slice(0, 200));
        break;
      case 'tool_result':
        appendLog((ev.ok ? '✓ ' : '✗ ') + ev.summary, ev.ok ? 'info' : 'error');
        break;
      case 'knowledge_attached':
        appendLog('Knowledge attached: ' + ev.id + ' (trigger: ' + ev.trigger + ').');
        break;
      case 'artifact_version':
        renderStepList();
        appendLog('Artifact v' + ev.version + ' saved.', 'success');
        break;
      case 'ledger_add':
        appendLog('Ledger: ' + ev.finding);
        break;
      case 'compaction':
        appendLog('(Transcript compacted — ' + ev.collapsed + ' older entries collapsed into the digest.)');
        break;
      case 'protocol_violation':
        appendLog('Protocol violation (' + ev.violation + ') — requesting one repair round.', 'error');
        break;
      case 'persist_error':
        appendLog('Session persist failed: ' + ev.error, 'error');
        break;
      case 'paused':
        setSessionControls('paused');
        if (wizardRail) wizardRail.releaseLock(); // API jobs may run while paused
        appendLog('Session paused. Resume when ready.' + (
          !document.getElementById('annotationRequestPanel').classList.contains('hidden') ||
          !document.getElementById('ioConfirmPanel').classList.contains('hidden')
            ? ' An open request is still waiting — you can answer it while paused (its wait does not consume the session clock).'
            : ''), 'warn');
        break;
      case 'stopped':
        setSessionControls('stopped');
        wizardAnnotationBridge && wizardAnnotationBridge.cancel();
        wizardIoBridge && wizardIoBridge.cancel();
        if (wizardRail) wizardRail.releaseLock();
        appendLog('Session stopped: ' + ev.reason + (ev.detail ? ' — ' + String(ev.detail).slice(0, 300) : ''), ev.reason === 'completed' ? 'success' : 'warn');
        if (wizardPersistence) wizardPersistence.flush();
        break;
    }
  } catch (e) { /* UI must never kill the session */ }
}

function buildRequirementText() {
  const inputParams = (document.getElementById('reqInputParams').value || '').trim();
  const pageOps = (document.getElementById('reqPageOps').value || '').trim();
  const outputStruct = (document.getElementById('reqOutputStruct').value || '').trim();
  return { inputParams, pageOps, outputStruct };
}

let sessionBooting = false; // re-entrancy guard for the await-config window

async function startResearchSession(seedOverride) {
  if (sessionBooting) {
    showToast('Session is already starting — please wait.', 'warn', 3000);
    return;
  }
  // Double-start guard: a live session's loop holds status 'running'
  // (set at loop start; 'paused'/'stopped' once it ends).
  if (wizardSession && wizardSession.state().session.status === 'running') {
    showToast('A research session is already running — pause or abort it first.', 'warn', 4000);
    return;
  }
  sessionBooting = true;
  const releaseBoot = () => { sessionBooting = false; };
  try {
  // A17: hide the stale feedback panel from a previous session.
  const feedbackPanel = document.getElementById('sessionFeedbackPanel');
  if (feedbackPanel) feedbackPanel.classList.add('hidden');
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  if (!config.config) {
    showToast('Please configure LLM in Options first', 'error');
    return;
  }
  const { inputParams, pageOps, outputStruct } = buildRequirementText();
  // Final-review fix: the reload toast promises that Ctrl+Enter / Research
  // resumes a parked session. After a reload the requirement boxes are empty —
  // treat an empty box + parked session as a resume; typed text means the user
  // is starting fresh and the parked session is superseded.
  let seed = seedOverride || null;
  let resumeNote = null;
  if (!seed && !pageOps) {
    try {
      const p = SessionPersistence.createSessionPersistence(chrome.storage.local, 'wizardResearchSession');
      const saved = await p.load();
      if (saved && saved.session && (!saved.session.stopped || ['paused', 'aborted', 'maxTurns', 'wallClock', 'tokenCap'].indexOf(saved.session.stopped.reason) !== -1)) {
        seed = { session: saved.session, observation: saved.observation, ledger: saved.ledger };
      }
    } catch (e) { /* storage unavailable — start fresh */ }
  }
  if (!pageOps && !(seed && seed.session)) {
    showToast('Please describe the page operations and data to collect before researching', 'error', 5000);
    return;
  }
  wizardState.targetUrl = document.getElementById('targetUrl').value;
  if (seed && seed.session) {
    // Reload recovery: the engine state carries the requirement and artifacts;
    // targetUrl is NOT persisted — recover it from the last successful
    // page.open recorded in the transcript.
    const st = seed.session;
    if (Array.isArray(st.artifactVersions) && st.artifactVersions.length) {
      wizardState.steps = JSON.parse(JSON.stringify(st.artifactVersions[st.artifactVersions.length - 1].steps || []));
      renderStepList();
    }
    if (!wizardState.targetUrl && Array.isArray(st.transcript)) {
      for (let i = st.transcript.length - 1; i >= 0; i--) {
        const t = st.transcript[i];
        if (t && t.kind === 'tool' && t.name === 'page.open' && t.ok && t.result && typeof t.result.url === 'string' && /^https?:\/\//i.test(t.result.url)) {
          wizardState.targetUrl = t.result.url;
          document.getElementById('targetUrl').value = t.result.url;
          break;
        }
      }
    }
    wizardState.requirements = { inputParams: inputParams, pageOps: pageOps, outputStruct: outputStruct };
    wizardState.description = String(st.requirement || '') || buildRequirementsBlock(wizardState.requirements, wizardState.targetUrl);
    resumeNote = 'Resuming the parked research session' + (st.stopped && st.stopped.reason ? ' (interrupted: ' + st.stopped.reason + ')' : '') + '.';
  } else {
    wizardState.requirements = { inputParams, pageOps, outputStruct };
    wizardState.description = buildRequirementsBlock(wizardState.requirements, wizardState.targetUrl);
  }
  if (!wizardState.userDescription) wizardState.userDescription = wizardState.description;

  // Dispose any previous rail before creating a new one — otherwise every
  // re-run of Research orphans the previous scrape tab. The 'stopped' event
  // handler deliberately does NOT dispose: the tab stays for post-session
  // inspection (phase 5 may view the page).
  if (wizardRail) {
    try { await wizardRail.dispose(); } catch (e) { /* old rail cleanup is best-effort */ }
    wizardRail = null;
  }

  goToPhase(4);
  const title = document.getElementById('phase4Title');
  if (title) title.textContent = 'Phase 4: Research Session';
  document.getElementById('executionLog').innerHTML = '';
  setSessionControls('running');
  sessionAbortRequested = false;

  wizardRail = makeWizardRail();
  wizardRunner = null; // rebuilt so ensureLock binds to the new rail
  getWizardRunner();
  wizardAnnotationBridge = createWizardAnnotationBridge(() => wizardRail);
  wizardIoBridge = createWizardIoBridge();
  wizardToolsBag = SessionTools.createSessionTools({
    rail: wizardRail,
    runVerify: getWizardRunner(),
    getDraftService: () => ({
      targetUrl: wizardState.targetUrl,
      steps: wizardState.steps,
      config: { timeoutMs: hoverAwareTimeoutMs(wizardState.steps, DEPLOY_TIMEOUT_MS), maxRetries: 0, autoCloseTab: true, maxStepIterations: 50, tabLoadTimeoutMs: 60000 }
    }),
    applyArtifact: applySessionArtifact,
    getTestInput: () => wizardState.testInput || {},
    getOutputSchema: () => wizardState.outputSchema,
    getSteps: () => wizardState.steps,
    annotationBridge: wizardAnnotationBridge,
    ioConfirmBridge: wizardIoBridge
  });

  wizardPersistence = SessionPersistence.createSessionPersistence(chrome.storage.local, 'wizardResearchSession');
  const units = (typeof KnowledgeUnits !== 'undefined') ? KnowledgeUnits.KNOWLEDGE_UNITS : [];
  if (!seed && wizardState.editingServiceId) {
    // Edit mode: seed the ledger from the deployed service's per-site memory
    // (spec §3B — a repair session does NOT re-discover the page).
    try {
      const registry = new ServiceRegistry();
      const svc = await registry.getById(wizardState.editingServiceId);
      if (svc && svc.findingsLedger && Array.isArray(svc.findingsLedger.entries) && svc.findingsLedger.entries.length) {
        seed = { ledger: svc.findingsLedger };
      }
    } catch (e) { /* edit-mode ledger seed is best-effort */ }
  }

  appendLog(resumeNote || 'Starting research session — the AI will open the page, probe it, author the steps, and verify.');
  wizardSession = ResearchSessionLib.createResearchSession({
    requirement: wizardState.description,
    llm: makeLlmAdapter(new LLMClient(config.config)),
    epochOf: () => (wizardRail && typeof wizardRail.epoch === 'number') ? wizardRail.epoch : undefined,
    tools: wizardToolsBag.tools,
    toolSpecs: wizardToolsBag.toolSpecs,
    systemPrompt: wizardToolsBag.systemPromptBase,
    knowledge: { units: units, index: KnowledgeBase.buildIndex(units) },
    persistence: wizardPersistence,
    // RC53: the Settings-page maxOutputTokens knob is authoritative; falls
    // back to 16384 when blank/invalid. maxTurns: the phase-1 knob (G5).
    budgets: {
      maxTokensPerCall: (config.config.maxOutputTokens && +config.config.maxOutputTokens) || 16384,
      maxTurns: getSessionMaxTurns()
    },
    seed: seed,
    onEvent: handleSessionEvent,
    // C4 production wiring: engine stop/abort cancels pending user-parked
    // bridges (io.confirm / annotate.request) so run() can never hang.
    userBridges: [wizardIoBridge, wizardAnnotationBridge]
  });
  wizardToolsBag.bindEngine(wizardSession);

  let report;
  try {
    report = await wizardSession.run();
  } catch (e) {
    appendLog('Session crashed: ' + String((e && e.message) || e), 'error');
    // A8: a crashed session leaves phase4 looking alive — surface it loudly.
    showToast('Session crashed: ' + String((e && e.message) || e), 'error');
    setSessionControls('stopped');
    if (wizardPersistence) { try { await wizardPersistence.flush(); } catch (_) {} }
    return;
  }
  updateSessionSpendLine(wizardSession.state());
  if (report && report.stopped && sessionStopPresentsOutcome(report.stopped.reason)) {
    if (report.stopped.reason === 'maxTurns') {
      appendLog('Turn budget exhausted. Presenting the latest artifact state — raise the max-turns knob (Phase 1) and press Resume to continue, or send feedback below for a fresh-budget continuation.', 'warn');
    }
    await presentSessionCompletion();
  } else if (report) {
    appendLog('Session stopped early — ' + friendlyStopReason((report.stopped && report.stopped.reason) || report.status) + '. Open questions: ' +
      (report.openQuestions && report.openQuestions.length
        ? report.openQuestions.slice(0, 3).map((q) => (q.kind === 'hypothesis' ? 'H' + q.n : q.id) + ' ' + q.text).join(' | ')
        : '(none)') +
      '. You can Resume from the pause point or refine manually in Phase 2.', 'warn');
  }
  } finally { releaseBoot(); }
}

// A20: raw engine status codes ('aborted', 'maxTurns', …) mean nothing to a
// user reading the log — map the known stop reasons to plain copy and keep
// the code in parens only for unknown reasons.
function friendlyStopReason(reason) {
  switch (reason) {
    case 'user':
    case 'aborted': return 'you stopped it';
    case 'maxTurns': return 'the turn budget exhausted';
    case 'wallClock': return 'the time budget exhausted';
    case 'tokenCap': return 'the token budget exhausted';
    case 'error': return 'it hit an error';
    default: return 'it stopped early (' + reason + ')';
  }
}

// Ninth-log M2: which stop reasons land on a PRESENTED phase 5. 'completed'
// obviously; 'maxTurns' too — the ninth log's continuation fixed both fields,
// verified ok:true on its final turn, and died at the budget ceiling BEFORE it
// could finish, which must not hide the built artifact. Paused/aborted stay on
// phase 4 so Resume is the natural next action.
function sessionStopPresentsOutcome(reason) {
  return reason === 'completed' || reason === 'maxTurns';
}

// Ninth-log L2: a completed session must land on a PRESENTED phase 5 —
// result confirmation, feedback-driven repair continuation, name edit,
// deploy — not a blank page. Presentation source, in order of trust:
//   1. the session's last verify.run, if it is fresh (no service.update
//      landed after it) — presented through the shared presentTestOutcome;
//   2. otherwise a fresh end-to-end testScript run of the final artifact;
//   3. an artifact-less completion keeps the historical bare landing.
async function presentSessionCompletion() {
  if (wizardPersistence) { try { await wizardPersistence.flush(); } catch (_) {} }
  const lv = (wizardToolsBag && typeof wizardToolsBag.getLastVerify === 'function')
    ? wizardToolsBag.getLastVerify() : null;
  const st = wizardSession ? wizardSession.state() : null;
  const hasArtifact = !!(st && Array.isArray(st.artifactVersions) && st.artifactVersions.length);
  wizardState.testAborted = false;
  wizardState.trustedWheelSkipCount = 0;
  if (lv && lv.raw && !lv.staleArtifact) {
    appendLog('Session complete — presenting the last verified run. Review the result, send feedback to continue fixing, or deploy.', 'success');
    showSessionFeedbackPanel();
    await presentTestOutcome({ events: lv.events, report: lv.report, raw: lv.raw });
  } else if (hasArtifact) {
    appendLog('Session complete. Running a fresh end-to-end verification of the authored steps…', 'success');
    showSessionFeedbackPanel();
    await testScript();
  } else {
    appendLog('Session complete. Review the steps and deploy.', 'success');
    goToPhase(5);
  }
}

function showSessionFeedbackPanel() {
  const panel = document.getElementById('sessionFeedbackPanel');
  if (panel) panel.classList.remove('hidden');
}

// Ninth-log L4: feedback-driven repair continuation. The completed session is
// parked in storage; the fix request enters its transcript as a system entry
// (rendered to the LLM as a user-role message), and the engine restarts from
// the seeded state — the engine nulls state.stopped at construction, so a
// 'completed' stop reason resumes cleanly.
async function sendSessionFeedback() {
  const textEl = document.getElementById('sessionFeedbackText');
  const text = String((textEl && textEl.value) || '').trim();
  if (!text) {
    showToast('Describe what needs fixing first.', 'warn', 3000);
    return;
  }
  if (!wizardPersistence) {
    wizardPersistence = SessionPersistence.createSessionPersistence(chrome.storage.local, 'wizardResearchSession');
  }
  let persisted = null;
  try { persisted = await wizardPersistence.load(); } catch (e) { /* storage unavailable */ }
  if (!persisted || !persisted.session) {
    showToast('No saved research session to continue.', 'error');
    return;
  }
  const st = persisted.session;
  // Ninth-log M1: the feedback continuation gets a FRESH budget segment — the
  // ninth log resumed a completed session at turn 53/60, fixed both fields,
  // verified ok, and died at the ceiling before it could finish. The
  // transcript (real history) is untouched; only budget accounting resets.
  st.spend = { turns: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false };
  st.budgetAdvisories = [];
  st.elapsedMs = 0;
  if (!Array.isArray(st.transcript)) st.transcript = [];
  st.transcript.push({ kind: 'system', text: 'USER FEEDBACK (fix request): ' + text + ' — continue: the research tab was closed when the session ended, so page.open the target (with a concrete sample input) first; probe the live page to diagnose the reported problem, fix the artifact via service.update, then verify.run again before finishing.' });
  try {
    await wizardPersistence.save({ session: st, observation: persisted.observation, ledger: persisted.ledger });
    await wizardPersistence.flush();
  } catch (e) {
    showToast('Could not persist the feedback: ' + String((e && e.message) || e), 'error');
    return;
  }
  if (textEl) textEl.value = '';
  const seed = { session: st, observation: persisted.observation, ledger: persisted.ledger };
  await startResearchSession(seed);
}

async function resumeResearchSession() {
  if (!wizardPersistence) {
    wizardPersistence = SessionPersistence.createSessionPersistence(chrome.storage.local, 'wizardResearchSession');
  }
  const persisted = await wizardPersistence.load();
  if (!persisted || !persisted.session) {
    showToast('No saved research session found.', 'error');
    return;
  }
  const st = persisted.session;
  if (Array.isArray(st.artifactVersions) && st.artifactVersions.length) {
    wizardState.steps = JSON.parse(JSON.stringify(st.artifactVersions[st.artifactVersions.length - 1].steps || []));
    renderStepList();
  }
  // Ninth-log L3 + A5 review: the budget stops — maxTurns, wallClock, tokenCap
  // — are all resumable: raise the matching phase-1 knob, hit Resume, and the
  // session continues from the pause point (G5 promise). 'paused'/'aborted'
  // resume trivially. 'completed' stays non-resumable here: its continuation
  // path is the phase-5 feedback panel. llm-error-class and protocol-class
  // stops remain terminal.
  const stopReason = st.stopped && st.stopped.reason;
  if (stopReason && ['paused', 'aborted', 'maxTurns', 'wallClock', 'tokenCap'].indexOf(stopReason) === -1) {
    showToast('That session already ended (' + stopReason + '). Starting fresh.', 'info');
    await wizardPersistence.clear();
    return;
  }
  const seed = { session: st, observation: persisted.observation, ledger: persisted.ledger };
  await startResearchSession(seed);
}
