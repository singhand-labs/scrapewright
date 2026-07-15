// Single source of truth for the per-step timeout ceiling. Used by generation
// prompts, auto-fix prompts, the test harness, and deploy config so they all agree.
const DEPLOY_TIMEOUT_MS = 60000;

let wizardState = {
  phase: 1,
  targetUrl: '',
  description: '',
  userDescription: '',
  annotations: [],
  steps: [],
  serviceName: '',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  sampleInput: {},
  testInput: {},
  fixAttemptCount: 0,
  autoFixing: false,
  lastError: null,
  confirmedSelectors: [],
  editingServiceId: null,
  originalName: null,
  researchTabId: null,
  postSnapshot: null,
  explorationData: null,
  llmHistory: [],
  stepAnnotationTabs: {}
};

function buildSystemMessageWithGlobalContext(baseSystemContent) {
  const desc = (wizardState.userDescription || wizardState.description || '').trim();
  return appendGlobalContextBlock(baseSystemContent, desc);
}

function trimLlmHistory() {
  if (wizardState.llmHistory.length > 6) {
    wizardState.llmHistory = wizardState.llmHistory.slice(-6);
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
  el.textContent = message;
  el.className = 'toast ' + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast hidden'; }, duration);
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
      showToast('Target tab reloaded — annotations cleared. Click 开始标注 again to re-select elements.', 'error', 6000);
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
  document.getElementById('btnRetryTest').addEventListener('click', () => testScript());
  document.getElementById('btnAutoFix').addEventListener('click', () => autoFix(document.getElementById('feedbackInput').value));
  document.getElementById('btnDeployAnyway').addEventListener('click', () => {
    goToPhase(5);
    confirmDeploy();
  });
  document.getElementById('btnFixAgain').addEventListener('click', () => {
    autoFix(document.getElementById('feedbackInput').value);
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
  document.getElementById('reqPageOps').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) startResearch();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'EXECUTION_LOG') {
      appendLog(message.message, message.level || 'info');
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
  wizardState.serviceName = svc.displayName || '';
  wizardState.steps = svc.steps || [];
  wizardState.inputSchema = svc.inputSchema || { type: 'object' };
  wizardState.outputSchema = svc.outputSchema || { type: 'object' };
  wizardState.annotations = svc.annotations || [];
  wizardState.sampleInput = svc.sampleInput || {};
  wizardState.llmHistory = [];
  wizardState.phase = 2;

  document.getElementById('targetUrl').value = svc.targetUrl;
  document.getElementById('description').value = svc.displayName || '';
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
  const fixControls = document.getElementById('fixControls');
  const feedbackArea = document.getElementById('feedbackArea');
  const deployControls = document.getElementById('deployControls');
  const testStatus = document.getElementById('testStatus');

  fixControls.classList.add('hidden');
  feedbackArea.classList.add('hidden');
  deployControls.classList.add('hidden');
  testStatus.className = '';

  document.getElementById('serviceNameDisplay').textContent = 'Service: ' + (wizardState.serviceName || 'Unnamed');
  renderIOSummary();

  if (state === 'success') {
    testStatus.textContent = 'All steps passed!';
    testStatus.className = 'success';
    deployControls.classList.remove('hidden');
    feedbackArea.classList.remove('hidden');
    document.getElementById('feedbackInput').placeholder = 'Results not what you expected? Describe what to change...';
  } else if (state === 'empty-result') {
    testStatus.textContent = 'Test passed but extracted data is empty — extraction may not be working correctly.';
    testStatus.className = 'fixing';
    fixControls.classList.remove('hidden');
    feedbackArea.classList.remove('hidden');
    document.getElementById('feedbackInput').placeholder = 'Describe what data you expected and how to fix the extraction...';
    debugLogger.log('warn', 'wizard', 'Empty result detected, showing fix controls');
  } else if (state === 'failure') {
    const stepInfo = wizardState.lastErrorStepId ? ' (step: ' + wizardState.lastErrorStepId + ')' : '';
    testStatus.textContent = wizardState.lastError
      ? 'Test failed: ' + wizardState.lastError + stepInfo
      : 'Test failed';
    testStatus.className = 'failure';
    fixControls.classList.remove('hidden');
    if (wizardState.fixAttemptCount > 0) {
      feedbackArea.classList.remove('hidden');
    }
    document.getElementById('feedbackInput').placeholder = 'Describe what\'s wrong or how to fix it...';
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

function goToPhase(n) {
  if (n === 2) {
    renderStepList();
    if (!document.getElementById('serviceName').value && wizardState.serviceName) {
      document.getElementById('serviceName').value = wizardState.serviceName;
    }
    const pageOps = (wizardState.requirements && wizardState.requirements.pageOps) || wizardState.description || '';
    if (!wizardState.serviceName && pageOps) {
      const suggested = pageOps.slice(0, 30).replace(/\s+$/, '');
      document.getElementById('serviceName').value = suggested;
      wizardState.serviceName = suggested;
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
        <button class="btn-step-open-webpage" data-index="${index}">打开网页</button>
        <button class="btn-step-start-annotation" data-index="${index}">开始标注</button>
        <button class="btn-step-complete-annotation" data-index="${index}">完成标注</button>
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
    showToast('Tab opened. Navigate the page to the desired state, then click 开始标注.', 'info');
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
    showToast('Please click 打开网页 first to open a tab for this step', 'error');
    return;
  }
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    showToast('The tab for this step was closed. Please click 打开网页 again.', 'error');
    delete wizardState.stepAnnotationTabs[step.id];
    return;
  }
  try {
    await sendMessageWithRetry(tabId, {
      type: 'START_ANNOTATION',
      inputSchema: wizardState.inputSchema,
      outputSchema: wizardState.outputSchema
    });
    showToast('Annotation mode on. Click elements, then click 完成标注 when done.', 'info');
  } catch (e) {
    try {
      await chrome.tabs.reload(tabId);
      await waitForTabLoad(tabId);
      await sendMessageWithRetry(tabId, {
        type: 'START_ANNOTATION',
        inputSchema: wizardState.inputSchema,
        outputSchema: wizardState.outputSchema
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
    showToast('Please click 打开网页 and 开始标注 first', 'error');
    return;
  }
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    showToast('The tab for this step was closed. Please click 打开网页 and 开始标注 again.', 'error');
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
    showToast('No annotations captured. Click 开始标注 and select elements first.', 'error');
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

    const pageInfo = cleanHtmlForLLM(captured.fullHtml, captured.annotations);

    const stepContext = {
      globalDescription: wizardState.userDescription || wizardState.description || '',
      previousStepsSchema: wizardState.steps.slice(0, stepIndex).map(s => `${s.id} (${s.name})`).join(', ') || '(none)',
      nextStepsDescription: wizardState.steps.slice(stepIndex + 1).map(s => `${s.id} (${s.name})`).join(', ') || '(none, terminal)'
    };

    const result = await generateStepScript(config.config, step, pageInfo, captured.annotations, stepContext);

    if (result && result.script) {
      step.script = result.script;
      step.needsAnnotation = false;
      step.annotations = (result.revisedAnnotations && Array.isArray(result.revisedAnnotations))
        ? result.revisedAnnotations
        : captured.annotations;
      step.entryUrl = newEntryUrl;

      // Selector fidelity check: verify the generated script actually uses
      // the annotated selectors verbatim (catches LLM rewriting/simplifying).
      const fidCheck = checkSelectorFidelity(result.script, step.annotations);
      if (!fidCheck.ok) {
        const details = fidCheck.mismatches.map(m =>
          `${m.type} → ${m.outputField || m.waitCondition || m.selector.slice(0, 40)}: ${m.suggestion}`
        ).join('\n');
        showToast('⚠ Selector mismatch: LLM may have rewritten annotated selectors. Check the script.\n' + details, 'warn', 10000);
        debugLogger.log('warn', 'wizard', 'Selector fidelity check failed', { mismatches: fidCheck.mismatches });
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
${pageInfo.structure}

Page text (initial state):
${pageInfo.textSummary}`;

  if (postPageInfo) {
    prompt += `

Page compressed structure (after interaction):
${postPageInfo.structure}

Page text (after interaction):
${postPageInfo.textSummary}

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
    parsed = JSON.parse(cleaned);
  } catch (e) {
    debugLogger.log('error', 'wizard', 'getCandidateSelectors JSON.parse failed', {
      error: e.message,
      cleanedPreview: cleaned.slice(0, 500),
      cleanedLength: cleaned.length,
      rawPreview: (result || '').slice(0, 500)
    });
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
  const prompt = `Confirm these selectors using the full element HTML.

URL: ${pageInfo.url}
Requirements: ${pageInfo.description}

Elements:
${response.elements.map(e => `--- ${e.selector} ---\n${e.found ? e.outerHTML : 'NOT FOUND'}`).join('\n')}

Return JSON with:
- confirmedSelectors: array of { purpose, selector, status: "confirmed"|"revised", revisedSelector? }`;

  const result = await client.chat([
    { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping expert. Return JSON only.') },
    { role: 'user', content: prompt }
  ], { jsonMode: true });

  const cleaned = cleanLLMResponse(result);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    debugLogger.log('error', 'wizard', 'confirmSelectorsWithFullHtml JSON.parse failed', {
      error: e.message,
      cleanedPreview: cleaned.slice(0, 500),
      cleanedLength: cleaned.length,
      rawPreview: (result || '').slice(0, 500)
    });
    const err = new Error('confirmSelectorsWithFullHtml returned malformed JSON: ' + e.message);
    err.rawLLMOutput = cleaned.slice(0, 500);
    throw err;
  }
  return parsed;
}

async function generateStepsWithSelectors(config, pageInfo, confirmedSelectors, postPageInfo, detailPageInfo) {
  const client = new LLMClient(config);
  let prompt = `${SCRIPT_DSL_GUIDE}

Create a web scraping workflow for this page.

URL: ${pageInfo.url}
Requirements: ${pageInfo.description}

Confirmed element selectors:
${confirmedSelectors.map(s => `- ${s.purpose}: ${s.status === 'revised' ? s.revisedSelector : s.selector}`).join('\n')}

Page compressed structure (initial state):
${pageInfo.structure}

Page text (initial state):
${pageInfo.textSummary}`;

  if (postPageInfo) {
    prompt += `

Page compressed structure (after interaction):
${postPageInfo.structure}

Page text (after interaction):
${postPageInfo.textSummary}

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
Look at the page snapshot for specific loading/generating indicator class names (e.g., "cosd-markdown-loading", "my-spinner").
The correct pattern is to wait for these indicators to DISAPPEAR:
  const stillLoading = await $exists('.cosd-markdown-loading, .loading-spinner', 3000);
  return { done: !stillLoading };
DO NOT use "submit button exists" as a completion signal — the submit button is typically always visible on AI chat sites.
DO NOT use wildcard selectors like [class*="loading"] — they match unrelated page elements and cause infinite loops. Use only specific class names from the page snapshot.

Return JSON with:
- steps: array of { id, name, script, condition (optional), onSuccess, onFailure, maxIterations, entryUrl (URL string, optional) }
- inputSchema: JSON Schema object
- outputSchema: JSON Schema object
- sampleInput: JSON object with example values

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
  ], { jsonMode: true, maxTokens: 8192 });

  wizardState.llmHistory.push(
    { role: 'user', content: '[Script Generation] Target: ' + wizardState.targetUrl + '\nDescription: ' + wizardState.description + '\n' + prompt.substring(0, 2000) },
    { role: 'assistant', content: result.substring(0, 2000) }
  );
  trimLlmHistory();

  const cleaned = cleanLLMResponse(result);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    debugLogger.log('error', 'wizard', 'generateStepsWithSelectors JSON.parse failed', {
      error: e.message,
      cleanedPreview: cleaned.slice(0, 500),
      cleanedLength: cleaned.length,
      rawPreview: (result || '').slice(0, 500)
    });
    const err = new Error('generateStepsWithSelectors returned malformed JSON: ' + e.message);
    err.rawLLMOutput = cleaned.slice(0, 500);
    throw err;
  }
  return parsed;
}

async function generateStepScript(config, step, pageInfo, annotations, stepContext) {
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

  const prompt = `${SCRIPT_DSL_GUIDE}

Generate the script for a SINGLE step in an existing scraping workflow.

[STEP CONTEXT]
Step ID: ${step.id}
Step name: ${step.name || '(unnamed)'}
Entry URL (annotation start point): ${step.entryUrl || '(not set)'}

Position in workflow:
- Previous steps: ${stepContext.previousStepsSchema}
- Next steps depend on this step's output: ${stepContext.nextStepsDescription}

[ANNOTATIONS]
User annotated the following elements on the current page:
${annotationsText}
${keyValueGuidance}

[CURRENT PAGE]
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
  ], { jsonMode: true, maxTokens: 8192 });

  wizardState.llmHistory.push(
    { role: 'user', content: '[Step Script Gen ' + step.id + '] ' + prompt.substring(0, 2000) },
    { role: 'assistant', content: result.substring(0, 2000) }
  );
  trimLlmHistory();

  const cleaned = cleanLLMResponse(result);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
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

Page text:
${pageInfo.textSummary}

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
- description: string (brief human-readable description of what the script does)`;

  const result = await client.chat([
    { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping expert. Return JSON only.') },
    { role: 'user', content: prompt }
  ], { jsonMode: true });

  return JSON.parse(cleanLLMResponse(result));
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

  // Wait up to 30 seconds for page to settle after interaction
  showLoading('Waiting for page to settle (30s)...');
  await new Promise(r => setTimeout(r, 30000));

  let response;
  try {
    response = await sendMessageWithRetry(tabId, { type: 'GET_DOM_SNAPSHOT' }, 5);
  } catch (e) {
    debugLogger.log('error', 'wizard', 'Failed to capture post-interaction snapshot', { error: e.message });
    return null;
  }

  debugLogger.log('info', 'wizard', 'Post-interaction snapshot captured', {
    htmlLength: response.snapshot?.html?.length,
    textLength: response.snapshot?.textContent?.length
  });

  return {
    url: wizardState.targetUrl,
    html: response.snapshot.html || '',
    textContent: response.snapshot.textContent || '',
    structure: response.snapshot.structure || '',
    textSummary: response.snapshot.textContent || ''
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
    wizardState.postSnapshot = postPageInfo;
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
      // Fallback: try regex on pageInfo.structure
      if (!detailUrl) {
        const hrefMatch = pageInfo.structure?.match(/href="([^"]*(?:noticeDetails|detail)[^"]*)"/i) ||
                          pageInfo.structure?.match(/href="([^"]+)"/);
        if (hrefMatch) detailUrl = hrefMatch[1];
      }
      if (detailUrl) {
        if (!detailUrl.startsWith('http')) {
          detailUrl = new URL(detailUrl, pageInfo.url).href;
        }
        showLoading('Capturing detail page structure...');
        const detailTab = await chrome.tabs.create({ url: detailUrl, active: false });
        await new Promise(r => setTimeout(r, 8000));
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
    try { await debugLogger.persist(); } catch (_) {}
  }
}

async function startResearch() {
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  if (!config.config) {
    showToast('Please configure LLM in Options first', 'error');
    return;
  }

  // Read description directly from the textarea. The wizard has no Phase that
  // explicitly syncs it on transition (Phase 2 only has Back / Research), so
  // without this read the value is lost. Empty description means the LLM has
  // no task context and produces generic selectors
  // (observed in tianyan.log line 301: "Description: \n").
  const description = (document.getElementById('description').value || '').trim();
  if (!description) {
    showToast('Please describe what you want to extract before researching', 'error', 5000);
    return;
  }
  wizardState.description = description;
  if (!wizardState.userDescription) wizardState.userDescription = description;

  const tab = await chrome.tabs.create({ url: wizardState.targetUrl, active: true });
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
    structure: response.snapshot.structure || '',
    textSummary: response.snapshot.textSummary || ''
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
      config: { timeoutMs: DEPLOY_TIMEOUT_MS, maxRetries: 0, autoCloseTab: true, maxStepIterations: 50 }
    };

    appendLog('Starting step execution...');

    const result = await StepOrchestrator.execute(service, wizardState.testInput || {}, {
      createTab: async (url) => {
        tab = await withTimeout(chrome.tabs.create({ url, active: false }), 10000, 'Failed to create tab (10s timeout)');
        appendLog('Opening ' + url + '...');
        return tab;
      },
      waitForTabLoad: async (tabId) => {
        await withTimeout(waitForTabLoad(tabId), 30000, 'Page load timeout (30s)');
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
      executeScript: async (tabId, script, input, timeoutMs) => {
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
    });

    wizardState.testResult = result;
    wizardState.lastError = null;
    wizardState.lastErrorStepId = null;
    document.getElementById('testResults').textContent = JSON.stringify(result, null, 2);
    renderResultSummary(result);
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
      wizardState.lastErrorSnapshot = lastStep.snapshot;
    }

    // WS4.2: required-output check against outputSchema (catches "success:true with empty answer").
    const finalData = result.finalResult?.data || result.finalResult;
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
    wizardState.lastErrorSnapshot = e.snapshot || null;
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
    document.getElementById('rawOutputDetails')?.classList.remove('hidden');
    appendLog('Execution failed: ' + e.message, 'error');
    if (e.steps) renderExecutionTimeline(e.steps);
    debugLogger.log('error', 'wizard', 'testScript failed', { error: e.message, stepId: e.stepId, stack: e.stack });

    // Auto-fix retry loop: kick in on a fresh failure (not when testScript is
    // being called from inside an existing autoFix iteration) and only for
    // errors the LLM can plausibly fix. LOGIN_REQUIRED etc. skip straight to
    // the manual UI.
    const autoFixable = !/LOGIN_REQUIRED/i.test(e.message || '');
    if (!wizardState.autoFixing && autoFixable) {
      appendLog('Test failed — auto-fixing (up to 3 attempts before asking you)...', 'info');
      await autoFix(null);
    } else {
      updatePhaseUI('failure');
    }
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    // Release the ExecutionQueue lock so API jobs can proceed.
    try {
      await chrome.runtime.sendMessage({ type: 'RELEASE_EXEC_LOCK' });
    } catch (e) { /* background may be unavailable */ }
  }

  if (wizardState.phase !== 6) {
    goToPhase(5);
  }
  await debugLogger.persist();
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
    ? `Page structure:\n${pageSnapshot.structure || ''}\n\nPage text:\n${pageSnapshot.textContent || pageSnapshot.textSummary || ''}`
    : '(page snapshot not available — target page may not be open)';

  // If improving a $openTab step, capture the detail page snapshot
  if (step.script?.includes('$openTab')) {
    const detailUrl = findSampleDetailUrl(wizardState.testResult);
    if (detailUrl) {
      try {
        showLoading('Capturing detail page for improvement...');
        const detailTab = await chrome.tabs.create({ url: detailUrl, active: false });
        await new Promise(r => setTimeout(r, 8000));
        const response = await chrome.tabs.sendMessage(detailTab.id, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' });
        if (response?.snapshot) {
          pageSnapshot = response.snapshot;
        }
        await chrome.tabs.remove(detailTab.id).catch(() => {});
      } catch (e) {
        console.warn('Could not capture detail page for improve:', e);
      }
    }
  }

  const detailSnapshotSection = pageSnapshot
    ? `Page structure:\n${pageSnapshot.structure || ''}\n\nPage text:\n${pageSnapshot.textContent || pageSnapshot.textSummary || ''}`
    : snapshotSection;

  const prompt = `${SCRIPT_DSL_GUIDE}

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
    const result = await client.chat(messages, { maxTokens: 8192 });

    wizardState.llmHistory.push(
      { role: 'user', content: '[Improve Step "' + step.name + '"] ' + prompt.substring(0, 2000) },
      { role: 'assistant', content: result.substring(0, 2000) }
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
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item?.href) return item.href;
      if (item?.link) return item.link;
      if (item?.url) return item.url;
    }
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && value.startsWith('http')) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item?.href) return item.href;
        if (item?.link) return item.link;
        if (item?.url) return item.url;
      }
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const found = findHrefInObject(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function autoFix(userFeedback = null) {
  const config = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  if (!config.config) {
    showToast('Please configure LLM in Options first', 'error');
    return;
  }

  // userFeedback provided → single attempt (Fix Again button flow).
  // userFeedback null → up to 3 silent retries before giving up and asking
  // the user for a hint. Triggered automatically by testScript on failure.
  const MAX_ATTEMPTS = userFeedback ? 1 : 3;
  if (!userFeedback) wizardState.fixAttemptCount = 0;

  const prevAutoFixing = wizardState.autoFixing;
  wizardState.autoFixing = true;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let success = false;
      let fatal = false;
      try {
        success = await runFixIteration(userFeedback, config);
      } catch (err) {
        // Fatal: LLM call failed, parse error, network. No point retrying.
        console.error('Auto-fix iteration threw:', err);
        appendLog('Auto-fix error: ' + err.message, 'error');
        fatal = true;
      }
      if (success) return;
      if (fatal) break;
      if (attempt < MAX_ATTEMPTS) {
        appendLog('Attempt ' + attempt + '/' + MAX_ATTEMPTS + ' did not fix it, retrying...', 'info');
      }
    }
    if (!userFeedback) {
      appendLog('Auto-fix gave up after ' + MAX_ATTEMPTS + ' attempts. Add a hint below and click Fix Again.', 'warn');
    }
    updatePhaseUI('failure');
  } finally {
    wizardState.autoFixing = prevAutoFixing;
  }
}

async function runFixIteration(userFeedback, config) {
  // Deterministic topology heal first (no LLM): if a step signals polling but
  // left maxIterations unset (common when a prior LLM fix just added a wait),
  // give it a default retry budget before spending an LLM call.
  const fixHeal = normalizeStepTopology(wizardState.steps);
  if (fixHeal.changed.length) {
    appendLog('Set default retry budget (maxIterations) on poll step(s): ' + fixHeal.changed.map(c => c.id).join(', '), 'info');
  }

  // Determine which step to fix: failed step, or last step (extraction) on success-with-feedback
  let targetStepId = wizardState.lastErrorStepId;
  if (!targetStepId) {
    // Success state — default to the last step (typically extraction)
    if (wizardState.steps.length === 0) {
      showToast('No steps to fix', 'error');
      return false;
    }
    targetStepId = wizardState.steps[wizardState.steps.length - 1].id;
  }

  const targetStep = wizardState.steps.find(s => s.id === targetStepId);
  if (!targetStep) {
    showToast('Step not found: ' + targetStepId, 'error');
    return false;
  }

  const isFailureFix = !!wizardState.lastErrorStepId;
  updatePhaseUI('fixing');
  showLoading((isFailureFix ? 'Fixing' : 'Improving') + ' step "' + targetStep.name + '"...');

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
  const shouldCaptureDetail = detailUrl && (
    targetStep.script?.includes('$openTab') ||
    detailUrl !== wizardState.targetUrl
  );
  let detailPageHint = '';
  if (shouldCaptureDetail) {
    try {
      showLoading('Capturing detail page snapshot for better fix...');
      const detailTab = await chrome.tabs.create({ url: detailUrl, active: false });
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
          stepUsesOpenTab: targetStep.script?.includes('$openTab') || false
        });
      }
      await chrome.tabs.remove(detailTab.id).catch(() => {});
    } catch (e) {
      console.warn('Could not capture detail page snapshot:', e);
    }
  }

  const feedbackSection = userFeedback ? '\nUser feedback: ' + userFeedback : '';

  // Per-step timeout guidance is injected via buildTimeoutGuidance(DEPLOY_TIMEOUT_MS) in the prompts below.

  // Build full step workflow context so LLM understands the pipeline
  const allStepsContext = wizardState.steps.map(s => {
    const marker = s.id === targetStepId ? ' <<< ' + (isFailureFix ? 'FAILING' : 'FIXING') : '';
    return `Step ${s.id} (${s.name}):${marker}\n  onSuccess → ${s.onSuccess || 'TERMINATE'}\n  Script:\n${s.script}`;
  }).join('\n\n');

  // Build test results context
  const testResultSection = wizardState.testResult
    ? '\n\nPREVIOUS TEST RESULT:\n' + JSON.stringify(wizardState.testResult, null, 2)
    : '';

  const RETURN_FORMAT = `RETURN FORMAT — choose ONE:
(A) Script-only fix (default): return ONLY the fixed JavaScript code, no explanation.
(B) If you ALSO need to change THIS step's flow (onSuccess/onFailure/maxIterations), return a JSON object and nothing else:
    {"script": "<fixed JS as one string>", "onSuccess": "<step id or TERMINATE>", "onFailure": "<step id or TERMINATE>", "maxIterations": <number>}
    Include only the flow fields you are changing; "script" is always required. The new flow must keep the chain valid (every target id exists, no orphan steps, never use "SELF"). Do NOT add or remove steps.`;

  let prompt;
  if (isFailureFix) {
    prompt = `${SCRIPT_DSL_GUIDE}

The following step failed. Fix it — primarily its script, but you MAY also adjust THIS step's onSuccess / onFailure / maxIterations if the runtime shows the step flow itself is wrong (the steps were generated before seeing this page state, so the topology can be a best guess). Do NOT add or remove steps; only edit this step's own fields.

Step ID: ${targetStepId}
Step name: ${targetStep.name}
On success → ${targetStep.onSuccess}
On failure → ${targetStep.onFailure}

Error: ${wizardState.lastError}

Target URL: ${wizardState.targetUrl}
Original requirement: ${wizardState.description}

Current step script:
${targetStep.script}

${buildTimeoutGuidance(DEPLOY_TIMEOUT_MS).text}

${detailPageHint}Page HTML (cleaned, noise removed):
${pageSnapshot.html || ''}

Page text content:
${pageSnapshot.textContent || pageSnapshot.textSummary || ''}

Page compressed structure:
${pageSnapshot.structure || ''}

Annotations: ${JSON.stringify(wizardState.annotations)}
${feedbackSection}

IMPORTANT SELECTOR RULES:
- Look at the ACTUAL HTML above — use the EXACT class names, IDs, and attributes you see there. Do NOT guess or invent generic selectors.
- Many modern sites use CSS module hash class names (e.g., "_chat-container_r2am5_1"). Use these EXACTLY as they appear — they are stable within a session.
- Prefer selectors by ID (#id), data-testid, data-* attributes, or unique tag + class combinations you see in the HTML.
- If the element has no good selector, use tag name + text content approach: find a parent with a stable attribute, then traverse.

FULL STEP WORKFLOW:
${allStepsContext}
${testResultSection}

${RETURN_FORMAT}`;
  } else {
    // Success but user wants different results
    const currentOutput = wizardState.testResult
      ? JSON.stringify(wizardState.testResult, null, 2)
      : '(no output)';

    prompt = `${SCRIPT_DSL_GUIDE}

The test passed but the user is not satisfied with the extraction results. Improve the step script based on their feedback.

Step ID: ${targetStepId}
Step name: ${targetStep.name}
On success → ${targetStep.onSuccess}
On failure → ${targetStep.onFailure}

Target URL: ${wizardState.targetUrl}
Original requirement: ${wizardState.description}

Current step script:
${targetStep.script}

Current output:
${currentOutput}

${buildTimeoutGuidance(DEPLOY_TIMEOUT_MS).text}

Page HTML (cleaned, noise removed):
${pageSnapshot.html || ''}

Page text content:
${pageSnapshot.textContent || pageSnapshot.textSummary || ''}

Page compressed structure:
${pageSnapshot.structure || ''}

Annotations: ${JSON.stringify(wizardState.annotations)}
${feedbackSection}

IMPORTANT SELECTOR RULES:
- Look at the ACTUAL HTML above — use the EXACT class names, IDs, and attributes you see there. Do NOT guess or invent generic selectors.
- Many modern sites use CSS module hash class names (e.g., "_chat-container_r2am5_1"). Use these EXACTLY as they appear.
- Prefer selectors by ID (#id), data-testid, data-* attributes, or unique tag + class combinations.

Improve the script to produce better extraction results. You MAY also adjust THIS step's onSuccess / onFailure / maxIterations if the flow itself is wrong — see RETURN FORMAT.

FULL STEP WORKFLOW:
${allStepsContext}

${RETURN_FORMAT}`;
  }

  try {
    const client = new LLMClient(config.config);
    const systemMsg = { role: 'system', content: buildSystemMessageWithGlobalContext('You are a web scraping script fixer. Return fixed JavaScript code, or a JSON {"script":...} object if you also need to change this step flow (onSuccess/onFailure/maxIterations).') };
    const userMsg = { role: 'user', content: prompt };
    const messages = [systemMsg, ...wizardState.llmHistory, userMsg];
    const result = await client.chat(messages, { maxTokens: 8192 });

    wizardState.llmHistory.push(
      { role: 'user', content: '[AutoFix #' + wizardState.fixAttemptCount + '] ' + prompt.substring(0, 2000) },
      { role: 'assistant', content: result.substring(0, 2000) }
    );
    trimLlmHistory();

    const cleaned = cleanLLMResponse(result);
    if (!cleaned || !cleaned.trim()) {
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' returned empty script for step "' + targetStep.name + '", keeping original.', 'warn');
      return false;
    }
    // The LLM may return either plain JS (script-only) OR a JSON step object
    // {"script":..., "onSuccess"?:..., "onFailure"?:..., "maxIterations"?:N} when
    // it needs to adjust this step's flow (runtime revealed the generation-time
    // topology was a wrong guess). Only an object with a string "script" field
    // counts as a step-def; anything else is treated as a plain script.
    let newScript = cleaned;
    let edgePatch = null;
    const trimmed = cleaned.trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && typeof obj.script === 'string') {
          newScript = obj.script;
          edgePatch = obj;
        }
      } catch { /* not JSON — treat as plain script */ }
    }
    if (!newScript.trim()) {
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' returned empty script for step "' + targetStep.name + '", keeping original.', 'warn');
      return false;
    }
    // Build the proposed step and validate the WHOLE chain before committing.
    // A topology change that orphans a step or dangles a pointer is rejected and
    // the previous step is kept (the next auto-fix iteration can retry).
    const proposed = { ...targetStep, script: newScript };
    if (edgePatch) {
      if (typeof edgePatch.onSuccess === 'string' && edgePatch.onSuccess.trim()) proposed.onSuccess = edgePatch.onSuccess.trim();
      if (typeof edgePatch.onFailure === 'string' && edgePatch.onFailure.trim()) proposed.onFailure = edgePatch.onFailure.trim();
      if (Number.isInteger(edgePatch.maxIterations) && edgePatch.maxIterations >= 1) proposed.maxIterations = edgePatch.maxIterations;
    }
    const trialSteps = wizardState.steps.map(s => (s === targetStep ? proposed : s));
    const chainCheck = validateChain(trialSteps);
    if (!chainCheck.valid) {
      appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' proposed an invalid step flow (' + chainCheck.error + '); keeping the previous step.', 'warn');
      return false;
    }
    const flowChanged = !!edgePatch && (
      proposed.onSuccess !== targetStep.onSuccess ||
      proposed.onFailure !== targetStep.onFailure ||
      proposed.maxIterations !== targetStep.maxIterations
    );
    // Commit (script always; edges/maxIterations only if the LLM patched them).
    targetStep.script = proposed.script;
    if (edgePatch) {
      targetStep.onSuccess = proposed.onSuccess;
      targetStep.onFailure = proposed.onFailure;
      targetStep.maxIterations = proposed.maxIterations;
    }
    wizardState.fixAttemptCount++;
    document.getElementById('currentScript').textContent = targetStep.script;
    // Sync the step's editor inputs so a later confirmDeploy's syncStepsFromEditor
    // keeps the fix — otherwise the stale textarea overwrites the auto-fixed
    // values and the deployed service loses the fix. Syncs script AND (if the
    // flow changed) onSuccess/onFailure/maxIterations.
    const fixedDetail = document.querySelector(`.step-detail[data-step-id="${targetStep.id}"]`);
    if (fixedDetail) {
      const fixedTa = fixedDetail.querySelector('.step-script-input');
      if (fixedTa) fixedTa.value = targetStep.script;
      if (flowChanged) {
        const s = fixedDetail.querySelector('.step-success-input'); if (s) s.value = targetStep.onSuccess || 'TERMINATE';
        const f = fixedDetail.querySelector('.step-failure-input'); if (f) f.value = targetStep.onFailure || 'TERMINATE';
        const m = fixedDetail.querySelector('.step-maxiter-input'); if (m) m.value = targetStep.maxIterations || 1;
      }
    }
    appendLog((isFailureFix ? 'Auto-fix' : 'AI improve') + ' applied to step "' + targetStep.name + '" (attempt #' + wizardState.fixAttemptCount + (flowChanged ? ', flow adjusted' : '') + '). Re-testing...');

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
    displayName: wizardState.serviceName || wizardState.description.slice(0, 30),
    userDescription: wizardState.userDescription || wizardState.description || '',
    targetUrl: wizardState.targetUrl,
    steps: wizardState.steps,
    inputSchema: wizardState.inputSchema,
    outputSchema: wizardState.outputSchema,
    sampleInput: wizardState.sampleInput,
    annotations: wizardState.annotations,
    config: existingService ? existingService.config : { enabled: true, timeoutMs: DEPLOY_TIMEOUT_MS, maxRetries: 1, autoCloseTab: true, maxStepIterations: 50 },
    createdAt: existingService ? existingService.createdAt : Date.now()
  };

  await registry.save(service);
  showToast('Service deployed!', 'success');
  setTimeout(() => { window.location.href = 'options.html'; }, 1000);
}

function waitForTabLoad(tabId) {
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
      reject(new Error('Tab load timeout'));
    }, 30000);
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
