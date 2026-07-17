importScripts(
  'lib/service-registry.js',
  'lib/llm-client.js',
  'lib/offscreen-executor.js',
  'lib/url-template.js',
  'lib/step-orchestrator.js',
  'lib/wizard-utils.js',
  'lib/debug-logger.js'
);

const registry = new ServiceRegistry();

// Execution queue — serializes concurrent service calls to prevent offscreen document conflicts
class ExecutionQueue {
  constructor() {
    this.running = false;
    this.queue = [];
  }

  enqueue(jobId, fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ jobId, fn, resolve, reject });
      debugLogger.log('info', 'background', 'Job queued', { jobId, queueLength: this.queue.length });
      this.processNext();
    });
  }

  async processNext() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const item = this.queue.shift();
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.running = false;
      this.processNext();
    }
  }

  getQueuePosition(jobId) {
    const idx = this.queue.findIndex(item => item.jobId === jobId);
    return idx >= 0 ? idx + 1 : 0;
  }

  get length() {
    return this.queue.length;
  }
}

const executionQueue = new ExecutionQueue();

// Communication channels
let pollingActive = false;
let serverPort = 8765;

// Native host connection state — surfaced to the options page UI.
// Persisted to chrome.storage.local so SW restarts don't lose the last error.
let nativeState = {
  mode: 'unknown',         // 'polling' | 'disconnected' | 'unknown'
  lastError: null,         // string from last disconnect/failure
  connectedAt: null,       // timestamp of current successful connection
  disconnectedAt: null,    // timestamp of last disconnect
  reconnectAttempts: 0     // bumped each time we try to reconnect
};

async function persistNativeState() {
  try {
    await chrome.storage.local.set({ nativeState: { ...nativeState } });
  } catch (e) {
    debugLogger.log('warn', 'background', 'Failed to persist nativeState', { error: e.message });
  }
}

async function loadNativeState() {
  try {
    const { nativeState: saved } = await chrome.storage.local.get('nativeState');
    if (saved) {
      nativeState = { ...nativeState, ...saved };
      // Migration: pre-HTTP-only versions stored mode='native'; normalize to 'polling'.
      if (nativeState.mode === 'native') nativeState.mode = 'polling';
    }
  } catch {}
}

function setNativeMode(mode, errorMessage = null) {
  const now = Date.now();
  const prev = nativeState.mode;
  nativeState.mode = mode;
  if (mode === 'polling') {
    nativeState.connectedAt = now;
    nativeState.lastError = null;
  } else if (mode === 'disconnected') {
    nativeState.disconnectedAt = now;
    if (errorMessage) nativeState.lastError = errorMessage;
  }
  debugLogger.log('info', 'background', 'Native state transition', { from: prev, to: mode, error: errorMessage });
  persistNativeState();
}

chrome.runtime.onStartup.addListener(() => {
  loadNativeState().finally(() => initCommunication());
});

chrome.runtime.onInstalled.addListener(() => {
  loadNativeState().finally(() => initCommunication());
});

// Toolbar icon click opens the Options (service management) page directly —
// no popup. New services can be created from there via "+ New Service".
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Keep Service Worker alive: alarm fires every 25s to wake up SW and reconnect if needed
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
// Daily log cleanup
chrome.alarms.create('logCleanup', { periodInMinutes: 60 });
// Periodic job queue cleanup (remove jobs older than 24h)
chrome.alarms.create('jobCleanup', { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!pollingActive) {
      debugLogger.log('info', 'background', 'Keepalive alarm: reconnecting');
      initCommunication();
    }
  } else if (alarm.name === 'logCleanup') {
    debugLogger.pruneOldLogs();
  } else if (alarm.name === 'jobCleanup') {
    pruneJobQueue();
  }
});

async function initCommunication() {
  const result = await chrome.storage.local.get('serverPort');
  serverPort = result.serverPort || 8765;

  pruneJobQueue();

  if (pollingActive) return;

  nativeState.reconnectAttempts++;
  persistNativeState();

  try {
    const probe = await fetch(`http://localhost:${serverPort}/api/v1/extension/poll`, {
      signal: AbortSignal.timeout(3000)
    });
    if (probe.ok) {
      debugLogger.log('info', 'background', 'Host reachable, using long-polling');
    }
  } catch (e) {
    // Will be retried by startLongPolling's reconnect loop.
  }

  startLongPolling();
}

async function startLongPolling() {
  if (pollingActive) return;
  pollingActive = true;

  debugLogger.log('info', 'background', 'Starting long-polling', { port: serverPort });

  // A single transient failure shouldn't flip the badge red — but if the host
  // is unreachable for several polls in a row, we treat it as disconnected.
  // On the first success after failures, we flip back to 'polling'.
  const DISCONNECT_THRESHOLD = 3;
  let consecutiveFailures = 0;

  while (pollingActive) {
    try {
      const response = await fetch(`http://localhost:${serverPort}/api/v1/extension/poll`);

      if (!response.ok) {
        consecutiveFailures++;
        debugLogger.log('warn', 'background', 'Poll failed', { status: response.status, consecutiveFailures });
        if (consecutiveFailures >= DISCONNECT_THRESHOLD) {
          setNativeMode('disconnected', 'host returned HTTP ' + response.status + ' on /extension/poll');
        }
        await sleep(5000);
        continue;
      }

      if (consecutiveFailures > 0) {
        consecutiveFailures = 0;
        setNativeMode('polling');
      }

      const msg = await response.json();

      if (msg.type === 'HEARTBEAT') {
        continue;
      }

      const result = await handleHostMessage(msg);
      if (result) {
        await fetch(`http://localhost:${serverPort}/api/v1/extension/response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result)
        });
      }
    } catch (e) {
      consecutiveFailures++;
      debugLogger.log('warn', 'background', 'Poll error, retrying in 5s', { error: e.message, consecutiveFailures });
      if (consecutiveFailures >= DISCONNECT_THRESHOLD) {
        setNativeMode('disconnected', e.message || 'cannot reach host on configured port');
      }
      await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleHostMessage(message) {
  debugLogger.log('info', 'background', 'Host message received', { type: message.type, reqId: message.reqId });

  if (message.type === 'EXECUTE' || message.type === 'EXECUTE_ASYNC') {
    // WS2.3: validate synchronously so the host returns the right status code
    // (404 unknown service, 400 bad input) instead of 202-then-async-fail.
    const svc = await registry.getByName(message.serviceName);
    if (!svc) {
      return { reqId: message.reqId, success: false, httpStatus: 404, error: `Unknown service: ${message.serviceName}` };
    }
    if (svc.config?.enabled === false) {
      return { reqId: message.reqId, success: false, httpStatus: 409, error: `Service '${message.serviceName}' is disabled` };
    }
    const ic = validateInputAgainstSchema(message.input, svc.inputSchema);
    if (!ic.valid) {
      return { reqId: message.reqId, success: false, httpStatus: ic.code, error: ic.error };
    }
    // All executions are async — create job, queue, return jobId immediately
    const job = await createJob(message.serviceName, message.input);
    const jobId = job.id;

    executionQueue.enqueue(jobId, async () => {
      await processJob(jobId, message.serviceName, message.input);
    }).catch(async err => {
      debugLogger.log('error', 'background', 'Queue execution failed', { jobId, error: err.message });
      await updateJob(jobId, { status: 'failed', error: err.message, completedAt: Date.now() }).catch(() => {});
    });

    return {
      reqId: message.reqId,
      success: true,
      jobId,
      status: 'queued',
      queuePosition: executionQueue.getQueuePosition(jobId)
    };
  } else if (message.type === 'GET_JOB_STATUS') {
    const job = await getJob(message.jobId);
    if (job) {
      const pos = executionQueue.getQueuePosition(message.jobId);
      job.queuePosition = pos;
    }
    return { reqId: message.reqId, success: !!job, job: job || null };
  } else if (message.type === 'GET_JOBS') {
    const jobs = await getJobs();
    return { reqId: message.reqId, success: true, jobs };
  } else if (message.type === 'GET_SERVICES') {
    const services = await registry.getAll();
    const list = services.map(s => ({
      name: s.name,
      displayName: s.displayName,
      targetUrl: s.targetUrl,
      enabled: s.config?.enabled,
      inputSchema: s.inputSchema,
      outputSchema: s.outputSchema
    }));
    return { reqId: message.reqId, success: true, services: list };
  } else if (message.type === 'GET_STATUS') {
    return {
      reqId: message.reqId,
      success: true,
      queueLength: executionQueue.queue.length,
      queueRunning: executionQueue.running
    };
  } else if (message.type === 'ACQUIRE_EXEC_LOCK') {
    // Wizard testScript acquires this lock so it never runs concurrently with
    // an API job (shared offscreen/sandbox/tabIdStack would cross-contaminate).
    executionQueue.enqueue('__wizard_test__', async () => {
      return new Promise((resolve) => { executionQueue._wizardResolve = resolve; });
    });
    return { reqId: message.reqId, success: true };
  } else if (message.type === 'RELEASE_EXEC_LOCK') {
    if (executionQueue._wizardResolve) {
      executionQueue._wizardResolve();
      executionQueue._wizardResolve = null;
    }
    return { reqId: message.reqId, success: true };
  } else if (message.type === 'CANCEL_JOB') {
    const cancelled = await cancelJob(message.jobId);
    return { reqId: message.reqId, success: cancelled, cancelled };
  } else if (message.type === 'STEP_ADD') {
    return await handleStepAdd(message);
  } else if (message.type === 'STEP_UPDATE') {
    return await handleStepUpdate(message);
  } else if (message.type === 'STEP_DELETE') {
    return await handleStepDelete(message);
  }

  return { reqId: message.reqId, success: false, error: 'Unknown message type: ' + message.type };
}

async function handleStepAdd(message) {
  const service = await registry.getByName(message.serviceName);
  if (!service) return { reqId: message.reqId, success: false, error: 'Service not found' };
  if (!Array.isArray(service.steps)) service.steps = [];
  const incoming = message.step || {};
  const step = {
    id: incoming.id,
    name: incoming.name || 'New Step',
    script: incoming.script || '',
    onSuccess: incoming.onSuccess || 'TERMINATE',
    onFailure: incoming.onFailure || 'TERMINATE',
    maxIterations: incoming.maxIterations || 1,
    entryUrl: incoming.entryUrl || service.targetUrl || ''
  };
  if (!step.id) {
    const existing = new Set(service.steps.map(s => s.id));
    let id = 'step-' + (service.steps.length + 1);
    while (existing.has(id)) id = 'step-' + Math.floor(Math.random() * 10000);
    step.id = id;
  }
  appendStepWithChainLink(service.steps, step);
  try {
    await registry.save(service);
  } catch (e) {
    return { reqId: message.reqId, success: false, error: e.message };
  }
  return { reqId: message.reqId, success: true, step, steps: service.steps };
}

async function handleStepUpdate(message) {
  const service = await registry.getByName(message.serviceName);
  if (!service) return { reqId: message.reqId, success: false, error: 'Service not found' };
  const step = (service.steps || []).find(s => s.id === message.stepId);
  if (!step) return { reqId: message.reqId, success: false, error: 'Step not found' };
  const patch = message.patch || {};
  for (const [k, v] of Object.entries(patch)) step[k] = v;
  try {
    await registry.save(service);
  } catch (e) {
    return { reqId: message.reqId, success: false, error: e.message };
  }
  return { reqId: message.reqId, success: true, step, steps: service.steps };
}

async function handleStepDelete(message) {
  const service = await registry.getByName(message.serviceName);
  if (!service) return { reqId: message.reqId, success: false, error: 'Service not found' };
  if (!Array.isArray(service.steps) || !service.steps.find(s => s.id === message.stepId)) {
    return { reqId: message.reqId, success: false, error: 'Step not found' };
  }
  removeStepWithRelink(service.steps, message.stepId);
  try {
    await registry.save(service);
  } catch (e) {
    return { reqId: message.reqId, success: false, error: e.message };
  }
  return { reqId: message.reqId, success: true, steps: service.steps };
}

// Strip heavy snapshot data from per-step results so job.steps is safe to expose
// via GET /jobs/{id} for failure diagnosis (P2-3 observability).
function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map(s => ({
    stepId: s.stepId,
    stepName: s.stepName,
    skipped: s.skipped || false,
    skipReason: s.skipReason || null,
    result: s.result === undefined ? null : s.result,
    timestamp: s.timestamp || null
  }));
}

async function createJob(serviceName, input) {
  debugLogger.log('info', 'background', 'Creating job', { serviceName, input });
  const job = {
    id: crypto.randomUUID(),
    serviceName,
    input,
    status: 'queued',
    result: null,
    error: null,
    steps: [],
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null
  };
  const { jobQueue = [] } = await chrome.storage.local.get('jobQueue');
  jobQueue.push(job);
  if (jobQueue.length > 100) jobQueue.shift();
  await chrome.storage.local.set({ jobQueue });
  return job;
}

async function updateJob(jobId, updates) {
  debugLogger.log('info', 'background', 'Updating job', { jobId, status: updates.status });
  const { jobQueue = [] } = await chrome.storage.local.get('jobQueue');
  const idx = jobQueue.findIndex(j => j.id === jobId);
  if (idx >= 0) {
    jobQueue[idx] = { ...jobQueue[idx], ...updates };
    await chrome.storage.local.set({ jobQueue });
  }
}

async function getJob(jobId) {
  const { jobQueue = [] } = await chrome.storage.local.get('jobQueue');
  return jobQueue.find(j => j.id === jobId);
}

async function getJobs() {
  const { jobQueue = [] } = await chrome.storage.local.get('jobQueue');
  return jobQueue;
}

async function cancelJob(jobId) {
  const { jobQueue = [] } = await chrome.storage.local.get('jobQueue');
  const idx = jobQueue.findIndex(j => j.id === jobId);
  if (idx >= 0 && jobQueue[idx].status === 'queued') {
    jobQueue[idx].status = 'cancelled';
    jobQueue[idx].completedAt = Date.now();
    await chrome.storage.local.set({ jobQueue });
    return true;
  }
  return false;
}

async function processJob(jobId, serviceName, input) {
  debugLogger.log('info', 'background', 'Processing job', { jobId, serviceName });
  await updateJob(jobId, { status: 'running', startedAt: Date.now() });

  try {
    const result = await handleExecute(serviceName, input);
    debugLogger.log('info', 'background', 'Job completed', { jobId, success: result.success, error: result.error });
    await updateJob(jobId, {
      status: result.success ? 'completed' : 'failed',
      result: result.data || null,
      error: result.error || null,
      steps: result.steps || [],
      completedAt: Date.now()
    });
  } catch (error) {
    debugLogger.log('error', 'background', 'Job failed', { jobId, error: error.message });
    await updateJob(jobId, {
      status: 'failed',
      error: error.message,
      completedAt: Date.now()
    });
  }
  await debugLogger.persist();
}

async function pruneJobQueue(maxSize = 100, ttlMs = 24 * 60 * 60 * 1000) {
  const { jobQueue = [] } = await chrome.storage.local.get('jobQueue');
  const now = Date.now();
  const pruned = jobQueue.filter(j => (now - j.createdAt) < ttlMs);
  const result = pruned.length > maxSize ? pruned.slice(-maxSize) : pruned;
  if (result.length !== jobQueue.length) {
    await chrome.storage.local.set({ jobQueue: result });
    debugLogger.log('info', 'background', 'Job queue pruned', { before: jobQueue.length, after: result.length });
  }
}

function sendLog(message, level = 'info') {
  try { chrome.runtime.sendMessage({ type: 'EXECUTION_LOG', message, level }); } catch (e) { /* no listener */ }
}

async function handleExecute(serviceName, input) {
  debugLogger.log('info', 'background', 'handleExecute start', { serviceName, input });
  const service = await registry.getByName(serviceName);
  if (!service) {
    debugLogger.log('error', 'background', 'Service not found', { serviceName });
    return { success: false, error: `Service '${serviceName}' not found` };
  }
  if (!service.config.enabled) {
    debugLogger.log('error', 'background', 'Service disabled', { serviceName });
    return { success: false, error: `Service '${serviceName}' is disabled` };
  }

  if (!service.steps || service.steps.length === 0) {
    debugLogger.log('error', 'background', 'Service has no steps', { serviceName });
    return { success: false, error: `Service '${serviceName}' has no steps` };
  }

  debugLogger.log('info', 'background', 'Service config', {
    targetUrl: service.targetUrl,
    stepCount: service.steps.length,
    timeoutMs: service.config.timeoutMs,
    maxRetries: service.config.maxRetries,
    autoCloseTab: service.config.autoCloseTab
  });

  debugLogger.log('info', 'background', 'Steps', {
    steps: service.steps.map(s => ({
      id: s.id,
      name: s.name,
      onSuccess: s.onSuccess,
      onFailure: s.onFailure,
      condition: s.condition,
      scriptPreview: s.script?.slice(0, 2000),
      scriptLength: s.script?.length
    }))
  });

  let lastError = null;
  const maxRetries = service.config.maxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      sendLog('Starting step execution for ' + service.targetUrl + '...');
      debugLogger.log('info', 'background', 'Calling StepOrchestrator.execute', { serviceName, targetUrl: service.targetUrl });

      const result = await StepOrchestrator.execute(service, input, {
        createTab: async (url) => {
          const tab = await chrome.tabs.create({ url, active: false });
          await waitForTabLoad(tab.id);
          // WS2.1: wait for the content-script to be listening before the first
          // DOM_REQUEST — prevents the RELAY_FAILED (tabId:null) race.
          const csReady = await waitForContentScript(tab.id);
          if (!csReady) {
            await chrome.tabs.remove(tab.id).catch(() => {});
            throw new Error('CONTENT_SCRIPT_NOT_READY');
          }
          return tab;
        },
        waitForTabLoad: async (tabId) => {
          await waitForTabLoad(tabId);
          sendLog('Page loaded successfully');
        },
        executeScript: async (tabId, script, input, timeoutMs) => {
          sendLog('Executing script via offscreen...');
          const executor = new OffscreenExecutor(tabId);
          executor.timeoutMs = timeoutMs || service.config.timeoutMs;
          return await executor.execute(script, input);
        },
        captureSnapshot: async (tabId) => {
          try {
            const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOM_SNAPSHOT' });
            return response.snapshot;
          } catch (e) {
            return null;
          }
        },
        removeTab: async (tabId) => {
          if (service.config.autoCloseTab !== false) {
            await chrome.tabs.remove(tabId).catch(() => {});
          }
        },
        evaluateCondition: async (tabId, conditionExpr) => {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              func: (expr) => {
                try {
                  return eval(expr);
                } catch (e) {
                  return false;
                }
              },
              args: [conditionExpr]
            });
            return results[0]?.result || false;
          } catch (e) {
            return false;
          }
        }
      });

      sendLog('All steps completed successfully', 'success');
      result.steps.forEach(step => {
        sendLog(`Step "${step.stepName}" completed`);
      });
      debugLogger.log('info', 'background', 'StepOrchestrator completed', {
        finalResult: result.finalResult,
        stepOutputs: result.steps.map(s => ({ stepId: s.stepId, stepName: s.stepName, skipped: s.skipped, skipReason: s.skipReason }))
      });

      // WS2.2 + P2-3: empty required output → failed; attach sanitized per-step trace for diagnosis.
      const stepTrace = sanitizeSteps(result.steps);
      const oc = validateOutputAgainstSchema(result.finalResult, service.outputSchema);
      if (!oc.ok) {
        const gotKeys = (result.finalResult && typeof result.finalResult === 'object' && !Array.isArray(result.finalResult)) ? Object.keys(result.finalResult) : [];
        const outErr = oc.code + ': missing [' + oc.missing.join(', ') + '] — result has [' + gotKeys.join(', ') + ']; the extraction step must return outputSchema field names';
        debugLogger.log('warn', 'background', 'Output failed required-field check', { missing: oc.missing, got: gotKeys });
        await logExecution(service, input, result.finalResult, outErr, attempt);
        await debugLogger.persist();
        return { success: false, error: outErr, data: result.finalResult, steps: stepTrace };
      }
      await logExecution(service, input, result.finalResult, null, attempt);
      await debugLogger.persist();
      return { success: true, data: result.finalResult, steps: stepTrace };

    } catch (error) {
      lastError = error;
      sendLog('Step execution failed: ' + error.message, 'error');
      debugLogger.log('error', 'background', 'StepOrchestrator failed', {
        error: error.message,
        stepId: error.stepId,
        stack: error.stack
      });

      if (error.message?.includes('LOGIN_REQUIRED')) {
        return { success: false, error: 'LOGIN_REQUIRED: Please log in and retry' };
      }

      if (error.code === 'MISSING_URL_PARAM') {
        await logExecution(service, input, null, error.message, attempt);
        await debugLogger.persist();
        return {
          success: false,
          error: error.message,
          code: error.code,
          paramName: error.paramName,
          steps: []
        };
      }

      const shouldAutoFix = attempt < maxRetries &&
        error.stepId &&
        (error.message?.includes('ELEMENT_NOT_FOUND') || error.message?.includes('SCRIPT_ERROR') || error.message?.includes('SCRIPT_TIMEOUT'));

      if (shouldAutoFix) {
        sendLog('Auto-fixing step "' + error.stepId + '" (attempt ' + (attempt + 1) + ')...');
        const fixed = await tryAutoFixStep(service, error.stepId, error);
        if (fixed) {
          await registry.save(service);
          continue;
        }
      }

      if (attempt < maxRetries) {
        sendLog('Retrying (attempt ' + (attempt + 1) + ')...');
        continue;
      }
    }
  }

  await logExecution(service, input, null, lastError?.message, maxRetries);
  await debugLogger.persist();
  return { success: false, error: lastError?.message || 'Execution failed', steps: sanitizeSteps(lastError?.steps) };
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === 'complete') {
        setTimeout(resolve, 1000);
        return;
      }
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1000);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab load timeout after 30s'));
      }, 30000);
    });
  });
}

async function tryAutoFixStep(service, stepId, error) {
  try {
    const config = await getLLMConfig();
    if (!config) return null;

    const step = service.steps.find(s => s.id === stepId);
    if (!step) return null;

    const client = new LLMClient(config);

    let compressedSnapshot = { structure: '', textSummary: '' };
    try {
      const tabs = await chrome.tabs.query({ url: service.targetUrl + '*' });
      if (tabs.length > 0) {
        const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_DOM_SNAPSHOT', mode: 'compressed' });
        compressedSnapshot = response.snapshot;
      }
    } catch (e) {
      console.warn('Could not capture snapshot for auto-fix:', e);
    }

    const prompt = `${SCRIPT_DSL_GUIDE}

The following step script failed. Fix ONLY this step's script code. Do not change step flow (onSuccess/onFailure).

Step ID: ${stepId}
Step name: ${step.name}
On success → ${step.onSuccess}
On failure → ${step.onFailure}

Error: ${error.message}

Target URL: ${service.targetUrl}
Original requirement: ${service.userDescription || service.displayName || service.name}

Current step script:
${step.script}

Page compressed structure:
${compressedSnapshot.structure || ''}

Page text:
${compressedSnapshot.textSummary || ''}

Annotations: ${JSON.stringify(service.annotations)}

Return ONLY the fixed JavaScript code, no explanation.`;

    const fixedCode = await client.chat([
      { role: 'system', content: buildAutoFixSystemMessage(service.userDescription || service.displayName || '') },
      { role: 'user', content: prompt }
    ], { maxTokens: 8192 });

    const cleaned = cleanLLMResponse(fixedCode);
    if (!cleaned || !cleaned.trim()) {
      return false;
    }

    // Validate the fix parses before persisting. Service workers cannot use
    // new Function() under MV3 CSP, so we roundtrip through the offscreen
    // document's sandbox via SYNTAX_CHECK_OFFSCREEN. The offscreen document
    // has its own working same-origin sandbox iframe (unlike content-script
    // iframes on web pages, which require web_accessible_resources).
    // Returns null on any infra problem → accept fix as best-effort fallback.
    const syntaxOk = await validateScriptSyntaxViaOffscreen(cleaned);
    if (syntaxOk === false) {
      console.warn('Auto-fix produced unparseable script; rejecting fix.', { stepId });
      return false;
    }

    step.script = cleaned;
    return true;
  } catch (e) {
    console.error('Auto-fix step failed:', e);
    return null;
  }
}

async function validateScriptSyntaxViaOffscreen(scriptCode) {
  try {
    await ensureOffscreenReady();
    const reqId = crypto.randomUUID();
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        console.warn('SYNTAX_CHECK_OFFSCREEN timed out; accepting fix as fallback.');
        resolve(null);
      }, 5000);

      const listener = (message) => {
        if (message.type === 'SYNTAX_CHECK_RESULT' && message._fromOffscreen && message.reqId === reqId) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(message.ok ? true : false);
        }
      };
      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({
        type: 'SYNTAX_CHECK_OFFSCREEN',
        reqId,
        script: scriptCode,
        _toOffscreen: true
      }).catch((e) => {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        console.warn('SYNTAX_CHECK_OFFSCREEN sendMessage failed; accepting fix as fallback.', e);
        resolve(null);
      });
    });
  } catch (e) {
    console.warn('SYNTAX_CHECK_OFFSCREEN roundtrip failed; accepting fix as fallback.', e);
    return null;
  }
}

async function ensureOffscreenReady() {
  const has = typeof chrome.runtime.getContexts === 'function'
    ? (await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen.html')]
      })).length > 0
    : false;
  if (has) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['WORKERS'],
    justification: 'Validate and execute user-generated scraping scripts'
  });
}

async function getLLMConfig() {
  const result = await chrome.storage.local.get('llmConfig');
  return result.llmConfig;
}

async function logExecution(service, input, output, error, retryCount) {
  const logs = (await chrome.storage.local.get('executionLogs')).executionLogs || [];
  logs.push({
    id: crypto.randomUUID(),
    serviceId: service.id,
    serviceName: service.name,
    input,
    output,
    error,
    durationMs: 0,
    retryCount,
    aiFixed: false,
    createdAt: Date.now()
  });
  if (logs.length > 100) logs.shift();
  await chrome.storage.local.set({ executionLogs: logs });
}

// Internal message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEBUG_LOG') {
    debugLogger.log(message.level, message.component, message.message, message.data);
    return false;
  }
  if (message.type === 'OFFSCREEN_READY' && message._fromOffscreen) {
    debugLogger.log('info', 'background', 'Offscreen document ready');
    return false;
  }
  if (message.type === 'DOM_REQUEST' && message._fromOffscreen) {
    // Relay DOM_REQUEST from offscreen doc to content script in target tab
    const relayMsg = {
      type: 'DOM_REQUEST',
      id: message.id,
      action: message.action,
      selector: message.selector,
      args: message.args,
      tabId: message.tabId,
      _fromOffscreen: true
    };
    (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await chrome.tabs.sendMessage(message.tabId, relayMsg);
          return;
        } catch (err) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 1000));
          } else {
            debugLogger.log('error', 'background', 'Failed to relay DOM_REQUEST after retries', { tabId: message.tabId, error: err.message });
            chrome.runtime.sendMessage({
              type: 'DOM_RESPONSE',
              id: message.id,
              error: 'RELAY_FAILED: ' + err.message,
              _fromOffscreen: true
            }).catch(() => {});
          }
        }
      }
    })();
    return false;
  }
  if (message.type === 'DOM_RESPONSE' && sender.tab?.id && message._fromOffscreen) {
    // Relay DOM_RESPONSE from content script back to offscreen doc.
    // subTabSnapshot must be preserved: it's attached by handleOpenTabExecute
    // when an $openTab body fails, and threads up through the chain so
    // step-orchestrator can hand autoFix the failing sub-tab's DOM instead
    // of snapshotting the (wrong) main tab.
    chrome.runtime.sendMessage({
      type: 'DOM_RESPONSE',
      id: message.id,
      result: message.result,
      error: message.error,
      subTabSnapshot: message.subTabSnapshot,
      _fromOffscreen: true
    }).catch(() => {
      // offscreen may not be listening
    });
    return false;
  }
  if (message.type === 'GET_CURRENT_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id });
    return false;
  }
  if (message.type === 'OPEN_TAB_EXECUTE') {
    handleOpenTabExecute(message.url, message.script, message.parentTabId, message.reqId)
      .catch(err => {
        debugLogger.log('error', 'background', 'handleOpenTabExecute failed', { error: err.message });
        if (message.parentTabId) {
          chrome.tabs.sendMessage(message.parentTabId, {
            type: 'TAB_RESULT',
            reqId: message.reqId,
            error: err.message
          }).catch(() => {});
        }
      });
    sendResponse({ ack: true });
    return true;
  }
  if (message.type === 'SAVE_LLM_CONFIG') {
    chrome.storage.local.set({ llmConfig: message.config }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
  if (message.type === 'GET_LLM_CONFIG') {
    getLLMConfig().then(config => sendResponse({ config }));
    return true;
  }
  if (message.type === 'SAVE_SERVER_PORT') {
    chrome.storage.local.set({ serverPort: message.port }).then(async () => {
      serverPort = message.port;
      // Restart polling with the new port
      pollingActive = false;
      await initCommunication();
      sendResponse({ success: true });
    });
    return true;
  }
  if (message.type === 'GET_SERVER_PORT') {
    chrome.storage.local.get('serverPort').then(result => {
      sendResponse({ port: result.serverPort || 8765 });
    });
    return true;
  }
  if (message.type === 'GET_NATIVE_STATUS') {
    // Compute log-file hint based on platform so the UI can show users
    // where to look without round-tripping to the host.
    let logFileHint = null;
    const plat = (navigator?.platform || '') + ' ' + (navigator?.userAgent || '');
    if (/Mac|iPhone|iPad|iPod/.test(plat)) {
      logFileHint = '~/Library/Logs/scrapewright/host.log';
    } else if (/Win/.test(plat)) {
      logFileHint = '%LOCALAPPDATA%\\scrapewright\\host.log';
    } else {
      logFileHint = '~/.cache/scrapewright/host.log';
    }
    sendResponse({
      mode: pollingActive ? 'polling' : nativeState.mode,
      lastError: nativeState.lastError,
      connectedAt: nativeState.connectedAt,
      disconnectedAt: nativeState.disconnectedAt,
      reconnectAttempts: nativeState.reconnectAttempts,
      port: serverPort,
      logFileHint,
      hostReachable: pollingActive
    });
    return false;
  }
  if (message.type === 'RECONNECT_NATIVE') {
    (async () => {
      debugLogger.log('info', 'background', 'Manual reconnect requested');
      // Reset polling flag so initCommunication can try again
      pollingActive = false;
      await initCommunication();
      sendResponse({ ok: true });
    })();
    return true;
  }
});

async function waitForContentScript(tabId, maxAttempts = 20, interval = 300) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, interval));
    }
  }
  return false;
}

async function handleOpenTabExecute(url, scriptStr, parentTabId, reqId) {
  debugLogger.log('info', 'background', 'handleOpenTabExecute start', { url, parentTabId, reqId });
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabLoad(tab.id);
  const csReady = await waitForContentScript(tab.id);
  if (!csReady) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    debugLogger.log('error', 'background', 'handleOpenTabExecute content-script not ready', { tabId: tab.id });
    throw new Error('CONTENT_SCRIPT_NOT_READY');
  }
  debugLogger.log('info', 'background', 'handleOpenTabExecute sub-tab ready, executing script', { tabId: tab.id });
  const executor = new OffscreenExecutor(tab.id);
  executor.timeoutMs = 60000;
  try {
    // scriptStr is a function body (may contain function declarations + return statements)
    const result = await executor.execute(`return await (async () => { ${scriptStr} })();`, {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    debugLogger.log('info', 'background', 'handleOpenTabExecute sub-tab completed', { tabId: tab.id });
    if (parentTabId) {
      chrome.tabs.sendMessage(parentTabId, {
        type: 'TAB_RESULT',
        reqId,
        result
      });
    }
  } catch (error) {
    // Capture the sub-tab's DOM BEFORE destroying it. The error propagates
    // back to autoFix as wizardState.lastErrorSnapshot, which the LLM uses to
    // generate selectors. Without this, step-orchestrator falls back to
    // snapshotting the MAIN tab (the search/list page) — useless for fixing
    // a script that operates on the detail page. Capturing here also grabs
    // the post-interaction DOM state (after clicks/scrolls/loads inside the
    // $openTab body), which is what the script was actually operating on.
    let subTabSnapshot = null;
    try {
      const snapResp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT', mode: 'full' });
      subTabSnapshot = snapResp?.snapshot || null;
      debugLogger.log('info', 'background', 'Captured sub-tab snapshot before destroy', {
        tabId: tab.id,
        htmlLength: subTabSnapshot?.html?.length,
        structureLength: subTabSnapshot?.structure?.length
      });
    } catch (snapErr) {
      debugLogger.log('warn', 'background', 'Sub-tab snapshot capture failed', { tabId: tab.id, error: snapErr.message });
    }
    await chrome.tabs.remove(tab.id).catch(() => {});
    debugLogger.log('error', 'background', 'handleOpenTabExecute sub-tab failed', { tabId: tab.id, error: error.message });
    if (parentTabId) {
      chrome.tabs.sendMessage(parentTabId, {
        type: 'TAB_RESULT',
        reqId,
        error: error.message,
        subTabSnapshot
      });
    }
  }
}
