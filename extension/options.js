document.addEventListener('DOMContentLoaded', async () => {
  await loadLlmConfig();
  await loadServerPort();
  await loadServices();
  await loadExecHistory();
  loadNativeStatus();
  startNativeStatusPolling();

  document.getElementById('saveLlm').addEventListener('click', saveLlmConfig);
  document.getElementById('savePort').addEventListener('click', saveServerPort);
  document.getElementById('testConnection').addEventListener('click', testServerConnection);
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

  document.getElementById('nativeReconnect')?.addEventListener('click', reconnectNative);
  document.getElementById('nativeCopyDiag')?.addEventListener('click', copyNativeDiagnostics);

  document.getElementById('enhancedModeToggle')?.addEventListener('change', toggleEnhancedMode);
  loadEnhancedModeState();

  const settingsOpener = document.getElementById('openSettings');
  if (settingsOpener) {
    settingsOpener.addEventListener('click', () => {
      document.getElementById('settingsModal').classList.remove('hidden');
    });
    // Keyboard a11y for the div[role=button] — Enter or Space opens the modal.
    settingsOpener.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        document.getElementById('settingsModal').classList.remove('hidden');
      }
    });
  }

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
  connected:    'Connected',
  disconnected: 'Disconnected',
  unknown:      'Checking…'
};

const NATIVE_MODE_DESCRIPTIONS = {
  connected:    'Host reachable at the configured port.',
  disconnected: 'Host not running or wrong port. Run scrapewright doctor.',
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
  // Normalize: 'polling' (from background.js) → 'connected' (UI label).
  // 'native' should never appear post-HTTP-only migration, but normalize
  // defensively in case of stale persisted state.
  let effectiveMode = s.hostReachable ? s.mode : (s.mode || 'disconnected');
  if (effectiveMode === 'polling' || effectiveMode === 'native') effectiveMode = 'connected';

  badge.className = 'native-badge ' + (effectiveMode || 'unknown');
  badge.textContent = NATIVE_BADGE_LABELS[effectiveMode] || 'Checking…';
  desc.textContent = NATIVE_MODE_DESCRIPTIONS[effectiveMode] || '';

  document.getElementById('nativePort').textContent = s.port || '—';
  document.getElementById('nativeConnectedAt').textContent = formatTs(s.connectedAt);
  document.getElementById('nativeDisconnectedAt').textContent = formatTs(s.disconnectedAt);
  document.getElementById('nativeReconnectAttempts').textContent =
    (s.reconnectAttempts ?? 0) + (s.hostReachable ? '' : ' (will retry)');
  document.getElementById('nativeLogFile').textContent = s.logFileHint || '—';

  const errRow = document.getElementById('nativeErrorRow');
  const errEl  = document.getElementById('nativeError');
  if (s.lastError && effectiveMode !== 'connected') {
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

// --- Enhanced scraping mode (chrome.debugger transient activation) ----------

// Reflects the current permission state into the toggle UI. The actual grant
// is held by Chrome itself (optional_permissions:'debugger'), not in our
// storage — so we just query chrome.permissions.contains on load.
async function loadEnhancedModeState() {
  const toggle = document.getElementById('enhancedModeToggle');
  const statusEl = document.getElementById('enhancedModeStatus');
  if (!toggle || !statusEl) return;
  if (typeof hasDebuggerPermission !== 'function') {
    toggle.disabled = true;
    statusEl.textContent = 'Unavailable (renderer-activation module not loaded)';
    return;
  }
  try {
    const granted = await hasDebuggerPermission();
    toggle.checked = !!granted;
    statusEl.textContent = granted ? 'Enabled' : 'Not enabled';
  } catch (e) {
    toggle.disabled = true;
    statusEl.textContent = 'Error checking state: ' + (e && e.message);
  }
}

// Toggle handler — MUST run in a user-gesture context (the change event from
// the toggle click). Chrome will show its own permission dialog; if the user
// denies it, requestDebuggerPermission resolves false and we revert the toggle.
async function toggleEnhancedMode(e) {
  const toggle = e.target;
  const statusEl = document.getElementById('enhancedModeStatus');
  const wantEnabled = toggle.checked;
  if (typeof requestDebuggerPermission !== 'function' || typeof removeDebuggerPermission !== 'function') {
    showToast('Enhanced mode unavailable (module not loaded)', 'error');
    toggle.checked = !wantEnabled;
    return;
  }
  if (wantEnabled) {
    const result = await requestDebuggerPermission();
    if (!result.granted) {
      toggle.checked = false;
      if (statusEl) statusEl.textContent = 'Not enabled';
      showToast('Enhanced mode could not be enabled — ' + (result.reason || 'unknown'), 'error', 8000);
      console.warn('[Enhanced Mode] enable failed:', result);
      return;
    }
    if (statusEl) statusEl.textContent = 'Enabled';
    showToast('Enhanced scraping mode enabled', 'success');
  } else {
    const removed = await removeDebuggerPermission();
    if (!removed) {
      toggle.checked = true;
      if (statusEl) statusEl.textContent = 'Enabled (remove failed)';
      showToast('Could not revoke debugger permission', 'error');
      return;
    }
    if (statusEl) statusEl.textContent = 'Not enabled';
    showToast('Enhanced scraping mode disabled', 'info');
  }
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

async function testServerConnection() {
  const port = parseInt(document.getElementById('serverPort').value, 10) || 8765;
  const result = document.getElementById('connectionResult');
  result.textContent = 'Testing...';
  result.className = 'connection-result';
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      result.textContent = '✓ Connected';
      result.className = 'connection-result ok';
    } else {
      result.textContent = '✗ HTTP ' + r.status;
      result.className = 'connection-result fail';
    }
  } catch (e) {
    result.textContent = '✗ ' + (e.message || 'unreachable');
    result.className = 'connection-result fail';
  }
}

async function loadLlmConfig() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
  const config = response.config;
  if (!config) return;
  document.getElementById('provider').value = config.provider;
  document.getElementById('model').value = config.model || '';
  document.getElementById('apiKey').value = config.apiKey || '';
  document.getElementById('apiBaseUrl').value = config.apiBaseUrl || '';
  // timeoutMs is stored in ms; the UI is in seconds. Blank → default (120).
  const timeoutSeconds = config.timeoutMs ? Math.round(config.timeoutMs / 1000) : '';
  document.getElementById('llmTimeout').value = timeoutSeconds;
  // maxOutputTokens is stored as a plain token count. Blank → default (8192).
  document.getElementById('llmMaxTokens').value = config.maxOutputTokens || '';
}

async function saveLlmConfig() {
  const rawTimeout = parseInt(document.getElementById('llmTimeout').value, 10);
  const timeoutSeconds = Number.isFinite(rawTimeout) && rawTimeout >= 10 && rawTimeout <= 600
    ? rawTimeout
    : 120;
  // Completion budget (RC53). Blank or out-of-range → undefined, so
  // llm-client falls back to its 8192 default at the use site. Range floor
  // 1024: a smaller budget reintroduces the finish_reason:length truncation
  // class (RC52).
  const rawMaxTokens = parseInt(document.getElementById('llmMaxTokens').value, 10);
  const maxOutputTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens >= 1024 && rawMaxTokens <= 131072
    ? rawMaxTokens
    : undefined;
  const config = {
    provider: document.getElementById('provider').value,
    model: document.getElementById('model').value,
    apiKey: document.getElementById('apiKey').value,
    apiBaseUrl: document.getElementById('apiBaseUrl').value || undefined,
    temperature: 0.1,
    timeoutMs: timeoutSeconds * 1000,
    maxOutputTokens
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

    // Action buttons — grouped in a flex container with consistent styling.
    // Order: Edit (primary) → API Doc / Export (btn-secondary reference/state)
    // → Disable → Delete (btn-danger, destructive).
    const actions = document.createElement('div');
    actions.className = 'service-actions';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editService(svc.id));
    actions.appendChild(editBtn);

    const apiDocBtn = document.createElement('button');
    apiDocBtn.textContent = 'API Doc';
    apiDocBtn.className = 'btn-secondary';
    apiDocBtn.addEventListener('click', () => showApiDoc(svc));
    actions.appendChild(apiDocBtn);

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.className = 'btn-secondary';
    exportBtn.addEventListener('click', () => exportService(svc));
    actions.appendChild(exportBtn);

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = enabled ? 'Disable' : 'Enable';
    toggleBtn.addEventListener('click', async () => {
      if (!svc.config) svc.config = {};
      svc.config.enabled = !svc.config.enabled;
      await registry.save(svc);
      showToast(svc.displayName + (svc.config.enabled ? ' enabled' : ' disabled'), 'success');
      await loadServices();
    });
    actions.appendChild(toggleBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'btn-danger';
    deleteBtn.addEventListener('click', () => deleteService(svc.id));
    actions.appendChild(deleteBtn);

    div.appendChild(actions);

    list.appendChild(div);
  }
}

// Reads the host machine's non-internal IPv4s from /health (reported by
// native-host/lib/network-info.js — the extension itself has no API to
// enumerate network interfaces). Returns { reachable, reported, ips } so the
// UI can distinguish a down host from a reachable host running a pre-ips
// build (both previously collapsed to [] and showed "Host unreachable").
async function fetchLocalIps(port) {
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { reachable: false, reported: false, ips: [] };
    const body = await r.json();
    const reported = Array.isArray(body.ips);
    return {
      reachable: true,
      reported,
      ips: reported ? body.ips.filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) : []
    };
  } catch {
    return { reachable: false, reported: false, ips: [] };
  }
}

function apiDocAddressHint(ipInfo) {
  if (ipInfo.ips.length > 0) return 'Addresses detected from the host — pick the one your caller can reach.';
  if (!ipInfo.reachable) return 'Host unreachable — only localhost offered. Start the host to detect LAN addresses.';
  if (!ipInfo.reported) return 'Host is running an older build without address reporting — run scrapewright restart, then reopen this dialog to detect LAN addresses.';
  return 'Host reports no LAN IPv4 addresses — only localhost offered.';
}

// Modal state for the currently-shown API doc. Address + platform selectors
// re-render the examples from this state without refetching.
let apiDocState = null;

function renderApiDocExamples() {
  if (!apiDocState) return;
  const { svc, port, host, platform, apiKey } = apiDocState;
  const base = `http://${host}:${port}/api/v1`;
  const url = `${base}/services/${svc.name}/execute`;
  const sampleInput = svc.sampleInput || generateExampleFromSchema(svc.inputSchema);
  const curl = buildCurlExamples({ base, apiKey, serviceName: svc.name, sampleInput });
  const dialect = platform === 'windows' ? curl.windows : curl.unix;
  const container = document.getElementById('apiDocExamples');
  if (!container) return;
  container.innerHTML = `
    <div class="api-doc-section">
      <h3>Endpoint</h3>
      <div class="endpoint">POST ${escapeHtml(url)}</div>
    </div>

    <div class="api-doc-section">
      <h3>curl — Submit Job</h3>
      <pre><code>${escapeHtml(dialect.execute)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Wait for Result (blocking)</h3>
      <p class="hint">Long-polls until job completes. Timeout: ?timeout=N (max 300s, default 120s).</p>
      <pre><code>GET ${escapeHtml(base)}/jobs/&lt;jobId&gt;/wait</code></pre>
      <pre><code>${escapeHtml(dialect.wait)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Check Job Status</h3>
      <pre><code>${escapeHtml(dialect.status)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Cancel Job</h3>
      <pre><code>${escapeHtml(dialect.cancel)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>List All Jobs</h3>
      <pre><code>${escapeHtml(dialect.jobs)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>List All Services</h3>
      <pre><code>${escapeHtml(dialect.services)}</code></pre>
    </div>
  `;
}

async function showApiDoc(svc) {
  const portResponse = await chrome.runtime.sendMessage({ type: 'GET_SERVER_PORT' });
  const port = portResponse.port || 8765;
  const apiKey = 'dev-key';
  const ipInfo = await fetchLocalIps(port);
  const ips = ipInfo.ips;

  apiDocState = { svc, port, ips, host: 'localhost', platform: 'unix', apiKey };

  const sampleInput = svc.sampleInput || generateExampleFromSchema(svc.inputSchema);
  const executeBody = JSON.stringify({ input: sampleInput }, null, 2);
  const executeResponse = JSON.stringify({ success: true, jobId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', status: 'queued', queuePosition: 1 }, null, 2);
  const completedResponse = JSON.stringify({ success: true, job: { id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', status: 'completed', result: generateExampleFromSchema(svc.outputSchema), error: null, queuePosition: 0 } }, null, 2);
  const failedResponse = JSON.stringify({ success: true, job: { id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', status: 'failed', result: null, error: 'ELEMENT_NOT_FOUND: .item', queuePosition: 0 } }, null, 2);

  const addressOptions = ['localhost', ...ips]
    .map(h => `<option value="${escapeHtml(h)}" ${h === apiDocState.host ? 'selected' : ''}>${escapeHtml(h)}${h === 'localhost' ? ' (this machine)' : ''}</option>`)
    .join('');

  const bodyHtml = `
    <div class="api-doc-controls">
      <label>Address
        <select id="apiDocAddress">${addressOptions}</select>
      </label>
      <label>Shell
        <select id="apiDocPlatform">
          <option value="unix" selected>Linux / macOS (bash)</option>
          <option value="windows">Windows (cmd / PowerShell)</option>
        </select>
      </label>
      <span class="hint">${escapeHtml(apiDocAddressHint(ipInfo))}</span>
    </div>

    <div id="apiDocExamples"></div>

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
      <h3>Completed Response</h3>
      <pre><code>${escapeHtml(completedResponse)}</code></pre>
    </div>

    <div class="api-doc-section">
      <h3>Failed Response</h3>
      <pre><code>${escapeHtml(failedResponse)}</code></pre>
    </div>
  `;

  document.getElementById('apiDocTitle').textContent = 'API Doc — ' + (svc.displayName || svc.name);
  document.getElementById('apiDocBody').innerHTML = bodyHtml;
  renderApiDocExamples();

  const addressSelect = document.getElementById('apiDocAddress');
  addressSelect.addEventListener('change', () => {
    apiDocState.host = addressSelect.value;
    renderApiDocExamples();
  });
  const platformSelect = document.getElementById('apiDocPlatform');
  platformSelect.addEventListener('change', () => {
    apiDocState.platform = platformSelect.value;
    renderApiDocExamples();
  });

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
  // Re-query the host so the doc lists current LAN addresses even if the
  // modal was opened while the host was down.
  const { ips } = await fetchLocalIps(port);
  const md = generateServiceMarkdown(svc, port, { ips });
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
