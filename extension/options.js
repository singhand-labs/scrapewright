document.addEventListener('DOMContentLoaded', async () => {
  await loadLlmConfig();
  await loadServerPort();
  await loadServices();
  await loadExecHistory();
  loadNativeStatus();
  startNativeStatusPolling();

  document.getElementById('saveLlm').addEventListener('click', saveLlmConfig);
  document.getElementById('savePort').addEventListener('click', saveServerPort);
  document.getElementById('newService').addEventListener('click', createNewService);
  document.getElementById('exportAll').addEventListener('click', exportAll);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      importServices(e.target.files[0]);
      e.target.value = '';
    }
  });

  document.getElementById('exportDebug')?.addEventListener('click', exportDebugLogs);
  document.getElementById('clearDebug')?.addEventListener('click', clearDebugLogs);

  document.getElementById('nativeReconnect')?.addEventListener('click', reconnectNative);
  document.getElementById('nativeCopyDiag')?.addEventListener('click', copyNativeDiagnostics);

  document.getElementById('openSettings')?.addEventListener('click', () => {
    document.getElementById('settingsModal').classList.remove('hidden');
  });

  // Close any modal via the × button or ESC (not backdrop click — mis-clicks
  // would discard in-progress form edits).
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-close')) {
      e.target.closest('.modal')?.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
  });
});

// --- Native host status -----------------------------------------------------

const NATIVE_BADGE_LABELS = {
  native:       'Connected',
  polling:      'Polling',
  disconnected: 'Disconnected',
  unknown:      'Checking…'
};

const NATIVE_MODE_DESCRIPTIONS = {
  native:       'Launched by Chrome via Native Messaging. Best latency.',
  polling:      'Degraded — running standalone; extension polls via HTTP. Run install-host.',
  disconnected: 'No host reachable. Install or diagnose the native host.',
  unknown:      'Service worker still starting up.'
};

let lastNativeStatus = null;
let nativeStatusTimer = null;

async function loadNativeStatus() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: 'GET_NATIVE_STATUS' });
  } catch (e) {
    status = { mode: 'disconnected', lastError: 'Service worker unreachable: ' + e.message };
  }
  if (!status) return;
  lastNativeStatus = status;
  renderNativeStatus(status);
}

function renderNativeStatus(s) {
  const badge = document.getElementById('nativeStatusBadge');
  const desc  = document.getElementById('nativeModeDesc');
  const effectiveMode = s.hostReachable ? s.mode : (s.mode || 'disconnected');
  badge.className = 'native-badge ' + (effectiveMode || 'unknown');
  badge.textContent = NATIVE_BADGE_LABELS[effectiveMode] || effectiveMode || 'Unknown';
  desc.textContent = NATIVE_MODE_DESCRIPTIONS[effectiveMode] || '';

  document.getElementById('nativePort').textContent = s.port || '—';
  document.getElementById('nativeConnectedAt').textContent = formatTs(s.connectedAt);
  document.getElementById('nativeDisconnectedAt').textContent = formatTs(s.disconnectedAt);
  document.getElementById('nativeReconnectAttempts').textContent =
    (s.reconnectAttempts ?? 0) + (s.hostReachable ? '' : ' (will retry)');
  document.getElementById('nativeLogFile').textContent = s.logFileHint || '—';

  const errRow = document.getElementById('nativeErrorRow');
  const errEl  = document.getElementById('nativeError');
  if (s.lastError && effectiveMode !== 'native') {
    errRow.classList.remove('hidden');
    errEl.textContent = s.lastError;
  } else {
    errRow.classList.add('hidden');
    errEl.textContent = '';
  }
}

function formatTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function startNativeStatusPolling() {
  if (nativeStatusTimer) clearInterval(nativeStatusTimer);
  // Every 3s — cheap, and the user sees reconnects within a few seconds.
  nativeStatusTimer = setInterval(loadNativeStatus, 3000);
}

async function reconnectNative() {
  const btn = document.getElementById('nativeReconnect');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Reconnecting…';
  try {
    await chrome.runtime.sendMessage({ type: 'RECONNECT_NATIVE' });
    // Give the SW a beat to try the reconnect before we re-poll.
    setTimeout(loadNativeStatus, 500);
  } catch (e) {
    showToast('Reconnect failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reconnect';
  }
}

async function copyNativeDiagnostics() {
  if (!lastNativeStatus) {
    showToast('No status available yet', 'error');
    return;
  }
  const diag = {
    at: new Date().toISOString(),
    mode: lastNativeStatus.mode,
    hostReachable: lastNativeStatus.hostReachable,
    port: lastNativeStatus.port,
    connectedAt: lastNativeStatus.connectedAt,
    disconnectedAt: lastNativeStatus.disconnectedAt,
    reconnectAttempts: lastNativeStatus.reconnectAttempts,
    lastError: lastNativeStatus.lastError,
    logFileHint: lastNativeStatus.logFileHint,
    userAgent: navigator.userAgent
  };
  const text = JSON.stringify(diag, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    showToast('Diagnostics copied to clipboard', 'success');
  } catch (e) {
    // Fallback — some extension contexts block clipboard API.
    showToast('Copy failed: ' + e.message + '. Status: ' + JSON.stringify(diag), 'error', 8000);
  }
}

function showToast(message, type = 'info', duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast ' + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast hidden'; }, duration);
}

async function loadServerPort() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_SERVER_PORT' });
  document.getElementById('serverPort').value = response.port || '';
}

async function saveServerPort() {
  const port = parseInt(document.getElementById('serverPort').value);
  if (!port || port < 1 || port > 65535) {
    showToast('Invalid port. Must be 1-65535.', 'error');
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'SAVE_SERVER_PORT', port });
  showToast(response.success ? 'Port saved and applied.' : 'Failed: ' + (response.error || 'unknown'), response.success ? 'success' : 'error');
}

async function loadLlmConfig() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  const config = response.config;
  if (!config) return;
  document.getElementById('provider').value = config.provider;
  document.getElementById('model').value = config.model || '';
  document.getElementById('apiKey').value = config.apiKey || '';
  document.getElementById('apiBaseUrl').value = config.apiBaseUrl || '';
}

async function saveLlmConfig() {
  const config = {
    provider: document.getElementById('provider').value,
    model: document.getElementById('model').value,
    apiKey: document.getElementById('apiKey').value,
    apiBaseUrl: document.getElementById('apiBaseUrl').value || undefined,
    temperature: 0.1
  };
  await chrome.runtime.sendMessage({ type: 'SAVE_LLM_CONFIG', config });
  showToast('Saved', 'success');
}

async function loadServices() {
  const registry = new ServiceRegistry();
  const services = await registry.getAll();
  const list = document.getElementById('serviceList');
  list.innerHTML = '';

  for (const svc of services) {
    const div = document.createElement('div');
    div.className = 'service-card';

    const h3 = document.createElement('h3');
    h3.textContent = svc.displayName + ' ';
    const badge = document.createElement('span');
    const enabled = svc.config?.enabled ?? true;
    badge.className = 'badge ' + (enabled ? 'enabled' : 'disabled');
    badge.textContent = enabled ? 'ON' : 'OFF';
    h3.appendChild(badge);
    div.appendChild(h3);

    const url = document.createElement('p');
    url.className = 'svc-url';
    url.textContent = svc.targetUrl;
    div.appendChild(url);

    const ioInfo = document.createElement('p');
    ioInfo.className = 'svc-io';
    const inputFields = Object.keys(svc.inputSchema?.properties || {}).join(', ') || 'none';
    const outputFields = Object.keys(svc.outputSchema?.properties || {}).join(', ') || 'none';
    ioInfo.textContent = 'Input: ' + inputFields + ' | Output: ' + outputFields;
    div.appendChild(ioInfo);

    const stepInfo = document.createElement('p');
    stepInfo.className = 'svc-steps';
    const stepCount = svc.steps ? svc.steps.length : 0;
    stepInfo.textContent = stepCount + ' step' + (stepCount !== 1 ? 's' : '');
    div.appendChild(stepInfo);

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editService(svc.id));
    div.appendChild(editBtn);

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = enabled ? 'Disable' : 'Enable';
    toggleBtn.addEventListener('click', async () => {
      if (!svc.config) svc.config = {};
      svc.config.enabled = !svc.config.enabled;
      await registry.save(svc);
      showToast(svc.displayName + (svc.config.enabled ? ' enabled' : ' disabled'), 'success');
      await loadServices();
    });
    div.appendChild(toggleBtn);

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', () => exportService(svc));
    div.appendChild(exportBtn);

    const apiDocBtn = document.createElement('button');
    apiDocBtn.textContent = 'API Doc';
    apiDocBtn.className = 'btn-api-doc';
    apiDocBtn.addEventListener('click', () => showApiDoc(svc));
    div.appendChild(apiDocBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteService(svc.id));
    div.appendChild(deleteBtn);

    list.appendChild(div);
  }
}

async function showApiDoc(svc) {
  const portResponse = await chrome.runtime.sendMessage({ type: 'GET_SERVER_PORT' });
  const port = portResponse.port || 8765;
  const apiKey = 'dev-key';

  const url = `http://localhost:${port}/api/v1/services/${svc.name}/execute`;
  const sampleInput = svc.sampleInput || generateExampleFromSchema(svc.inputSchema);

  const executeBody = JSON.stringify({ input: sampleInput }, null, 2);
  const executeResponse = JSON.stringify({ success: true, jobId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', status: 'queued', queuePosition: 1 }, null, 2);
  const completedResponse = JSON.stringify({ success: true, job: { id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', status: 'completed', result: generateExampleFromSchema(svc.outputSchema), error: null, queuePosition: 0 } }, null, 2);
  const failedResponse = JSON.stringify({ success: true, job: { id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', status: 'failed', result: null, error: 'ELEMENT_NOT_FOUND: .item', queuePosition: 0 } }, null, 2);

  const curlExecute = `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-API-Key: ${apiKey}" \\\n  -d '${JSON.stringify({ input: sampleInput })}'`;

  const curlWait = `curl "http://localhost:${port}/api/v1/jobs/<jobId>/wait?timeout=120" \\\n  -H "X-API-Key: ${apiKey}"`;

  const curlStatus = `curl http://localhost:${port}/api/v1/jobs/<jobId> \\\n  -H "X-API-Key: ${apiKey}"`;

  const bodyHtml = `
    <div class="api-doc-section">
      <h3>Endpoint</h3>
      <div class="endpoint">POST ${url}</div>
    </div>

    <div class="api-doc-section">
      <h3>Headers</h3>
      <pre><code>Content-Type: application/json
X-API-Key: ${apiKey}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Submit Job</h3>
      <p class="hint">All executions are async. Returns jobId immediately.</p>
      <pre><code>${escapeHtml(executeBody)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Response (202 Accepted)</h3>
      <pre><code>${escapeHtml(executeResponse)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>curl — Submit Job</h3>
      <pre><code>${escapeHtml(curlExecute)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Wait for Result (blocking)</h3>
      <p class="hint">Long-polls until job completes. Timeout: ?timeout=N (max 300s, default 120s).</p>
      <pre><code>GET http://localhost:${port}/api/v1/jobs/&lt;jobId&gt;/wait</code></pre>
      <pre><code>${escapeHtml(curlWait)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Check Job Status</h3>
      <pre><code>${escapeHtml(curlStatus)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Completed Response</h3>
      <pre><code>${escapeHtml(completedResponse)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Failed Response</h3>
      <pre><code>${escapeHtml(failedResponse)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Cancel Job</h3>
      <pre><code>curl -X POST http://localhost:${port}/api/v1/jobs/&lt;jobId&gt;/cancel \\\n  -H "X-API-Key: ${apiKey}"</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>List All Jobs</h3>
      <pre><code>curl http://localhost:${port}/api/v1/jobs \\\n  -H "X-API-Key: ${apiKey}"</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>List All Services</h3>
      <pre><code>curl http://localhost:${port}/api/v1/services \\\n  -H "X-API-Key: ${apiKey}"</code></pre>
    </div>
  `;

  document.getElementById('apiDocTitle').textContent = 'API Doc — ' + (svc.displayName || svc.name);
  document.getElementById('apiDocBody').innerHTML = bodyHtml;
  const dlBtn = document.getElementById('apiDocDownloadMd');
  if (dlBtn) dlBtn.onclick = () => downloadServiceMarkdown(svc);
  document.getElementById('apiDocModal').classList.remove('hidden');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function createNewService() {
  window.location.href = 'wizard.html';
}

async function editService(id) {
  window.location.href = 'wizard.html?edit=' + id;
}

async function deleteService(id) {
  if (!confirm('Delete this service?')) return;
  const registry = new ServiceRegistry();
  await registry.delete(id);
  await loadServices();
}

function exportService(svc) {
  const blob = new Blob([JSON.stringify([svc], null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (svc.displayName || svc.name) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadServiceMarkdown(svc) {
  let port = 8765;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_SERVER_PORT' });
    if (r && r.port) port = r.port;
  } catch { /* default port */ }
  const md = generateServiceMarkdown(svc, port);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (svc.displayName || svc.name) + '.md';
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAll() {
  const registry = new ServiceRegistry();
  const services = await registry.getAll();
  const blob = new Blob([JSON.stringify(services, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scrapewright-services.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importServices(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    showToast('Invalid JSON file: ' + e.message, 'error');
    return;
  }
  const validated = validateImportData(data);
  const registry = new ServiceRegistry();
  const existing = await registry.getAll();
  const existingNames = new Set(existing.map(s => s.name));
  const { toImport, skipped: dupSkipped } = filterDuplicates(validated.imported, existingNames);
  const importFailures = [];
  let importedCount = 0;
  for (const svc of toImport) {
    try {
      await registry.save(svc);
      importedCount++;
    } catch (e) {
      importFailures.push((svc.displayName || svc.name || svc.id || '<unknown>') + ': ' + e.message);
    }
  }
  const totalSkipped = validated.skipped.length + dupSkipped + importFailures.length;
  const message = 'Imported ' + importedCount + ' services, skipped ' + totalSkipped +
    ' (duplicates, invalid, or broken chain).' +
    (importFailures.length > 0 ? '\n\nFailed:\n' + importFailures.join('\n') : '');
  showToast(message, importedCount > 0 ? 'success' : 'error', 8000);
  await loadServices();
}

async function exportDebugLogs() {
  const logs = await debugLogger.exportAll();
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scrapewright-debug-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function clearDebugLogs() {
  await debugLogger.clear();
  showToast('Debug logs cleared', 'success');
}

async function loadExecHistory() {
  const { executionLogs = [] } = await chrome.storage.local.get('executionLogs');
  const list = document.getElementById('execLogList');
  list.innerHTML = '';
  const recent = executionLogs.slice(-20).reverse();
  if (recent.length === 0) {
    list.textContent = 'No execution history yet.';
    return;
  }
  for (const log of recent) {
    const div = document.createElement('div');
    div.className = 'exec-entry';
    const status = log.error ? 'failure' : 'success';
    const time = document.createElement('span');
    time.className = 'exec-time';
    time.textContent = new Date(log.createdAt).toLocaleString();
    const svc = document.createElement('span');
    svc.className = 'exec-svc';
    svc.textContent = log.serviceName;
    const badge = document.createElement('span');
    badge.className = 'badge ' + (status === 'success' ? 'enabled' : 'disabled');
    badge.textContent = status;
    div.appendChild(time);
    div.appendChild(svc);
    div.appendChild(badge);
    list.appendChild(div);
  }
}
