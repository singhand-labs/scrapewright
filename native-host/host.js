#!/usr/bin/env node
// Boot trap — must run before any require() that could fail.
// If a required module is missing/syntactically broken, Node exits before
// the logger initializes, and the OS service supervisor (systemd / launchd /
// Task Scheduler) just sees a non-zero exit. We dump the real error
// synchronously to startup-error.log so doctor / users can see what
// actually crashed.
//
// __bootReady flips to true once logger is wired up (see below); at that
// point the boot trap detaches and the runtime trap (which logs and keeps
// the host alive) takes over.
let __bootReady = false;
try {
  const __bootFs = require('fs');
  const __bootPath = require('path');
  const __bootOs = require('os');
  const __bootLogDir = process.env.SCRAPEWRIGHT_LOG_DIR || (
    process.platform === 'darwin'
      ? __bootPath.join(__bootOs.homedir(), 'Library', 'Logs', 'scrapewright')
      : process.platform === 'win32'
        ? __bootPath.join(process.env.LOCALAPPDATA || __bootOs.homedir(), 'scrapewright')
        : __bootPath.join(process.env.XDG_CACHE_HOME || __bootPath.join(__bootOs.homedir(), '.cache'), 'scrapewright')
  );
  const __bootHandler = (err) => {
    if (__bootReady) return; // defer to the runtime handler
    try {
      __bootFs.mkdirSync(__bootLogDir, { recursive: true });
      __bootFs.appendFileSync(
        __bootPath.join(__bootLogDir, 'startup-error.log'),
        `[${new Date().toISOString()}] pid=${process.pid} crash during boot: ${err && (err.stack || err.message || String(err))}\n`
      );
    } catch { /* nothing more we can do */ }
    process.exit(1);
  };
  process.on('uncaughtException', __bootHandler);
} catch { /* fs/path/os are core modules — failing here means Node itself is broken */ }

const http = require('http');
const path = require('path');
const fs = require('fs');
const { logger, resolveLogPath } = require('./lib/logger');

// Logger is up — boot phase is over. The runtime trap below takes over.
__bootReady = true;

// Parse CLI args
const cliArgs = process.argv.slice(2);
let cliPort = null;
for (const arg of cliArgs) {
  if (arg.startsWith('--port=')) cliPort = parseInt(arg.split('=')[1]);
}
if (cliArgs.includes('--doctor') || cliArgs.includes('-d')) {
  runDoctor();
  process.exit(0);
}

const PORT = cliPort || parseInt(process.env.SCRAPEWRIGHT_PORT) || 8765;
const API_KEY = process.env.SCRAPEWRIGHT_API_KEY || 'dev-key';

let pendingRequests = new Map();
let reqIdCounter = 1;
let currentPort = PORT;

// Extension poll channel state
let pollResponse = null;
let messageQueue = [];
let heartbeatTimer = null;

// Startup diagnostics
logger.info('host starting', {
  node: process.version,
  platform: process.platform,
  pid: process.pid,
  port: PORT,
  apiKeySet: API_KEY !== 'dev-key',
  logFile: resolveLogPath()
});

logger.info('mode: http server', {
  port: PORT,
  invokedBy: process.env.SCRAPEWRIGHT_INVOKED_BY || 'foreground'
});

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});

function handleIncomingMessage(msg) {
  logger.info('extension→host message', { reqId: msg.reqId, type: msg.type });
  const pending = pendingRequests.get(msg.reqId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRequests.delete(msg.reqId);
    pending.resolve(msg);
  }
}

function sendToExtension(message) {
  return new Promise((resolve, reject) => {
    const reqId = reqIdCounter++;
    const msg = { ...message, reqId };
    const timer = setTimeout(() => {
      if (pendingRequests.has(reqId)) {
        pendingRequests.delete(reqId);
        reject(new Error('Extension timeout'));
      }
    }, 60000);
    pendingRequests.set(reqId, { resolve, reject, timer });

    if (pollResponse) {
      clearTimeout(heartbeatTimer);
      pollResponse.statusCode = 200;
      pollResponse.end(JSON.stringify(msg));
      pollResponse = null;
    } else {
      messageQueue.push(msg);
      logger.warn('message queued (extension not connected)', { reqId, type: msg.type, queueDepth: messageQueue.length });
    }
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const urlPath = (req.url.split('?')[0] || '/').replace(/\/+$/, '') || '/';
  if (urlPath !== '/api/v1/extension/poll') {
    // Filter out the high-frequency extension poll noise; log everything else.
    logger.info('http request', { method: req.method, path: urlPath });
  }

  // === Extension communication endpoints (no auth — internal localhost) ===

  if (urlPath === '/api/v1/extension/poll' && req.method === 'GET') {
    handlePollRequest(req, res);
    return;
  }

  if (urlPath === '/api/v1/extension/response' && req.method === 'POST') {
    handleExtensionResponse(req, res);
    return;
  }

  // === Health check (no auth) ===

  if (urlPath === '/health' && req.method === 'GET') {
    handleHealthCheck(req, res);
    return;
  }

  // === External API endpoints (auth required) ===

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Route matching — more specific routes first
  const executeMatch = urlPath.match(/^\/api\/v1\/services\/([^\/]+)\/execute$/);
  const stepAddMatch = urlPath.match(/^\/api\/v1\/services\/([^\/]+)\/steps$/);
  const stepModifyMatch = urlPath.match(/^\/api\/v1\/services\/([^\/]+)\/steps\/([^\/]+)$/);
  const jobWaitMatch = urlPath.match(/^\/api\/v1\/jobs\/([^\/]+)\/wait$/);
  const cancelMatch = urlPath.match(/^\/api\/v1\/jobs\/([^\/]+)\/cancel$/);
  const jobStatusMatch = urlPath.match(/^\/api\/v1\/jobs\/([^\/]+)$/);
  const jobsListMatch = urlPath === '/api/v1/jobs';
  const servicesListMatch = urlPath === '/api/v1/services';

  if (executeMatch && req.method === 'POST') {
    await handleExecuteRequest(res, executeMatch[1], req);
  } else if (stepAddMatch && req.method === 'POST') {
    await handleStepAddRequest(res, stepAddMatch[1], req);
  } else if (stepModifyMatch && req.method === 'PUT') {
    await handleStepUpdateRequest(res, stepModifyMatch[1], stepModifyMatch[2], req);
  } else if (stepModifyMatch && req.method === 'DELETE') {
    await handleStepDeleteRequest(res, stepModifyMatch[1], stepModifyMatch[2]);
  } else if (jobWaitMatch && req.method === 'GET') {
    await handleJobWaitRequest(req, res, jobWaitMatch[1]);
  } else if (cancelMatch && req.method === 'POST') {
    await handleCancelRequest(res, cancelMatch[1]);
  } else if (jobStatusMatch && req.method === 'GET') {
    await handleJobStatusRequest(res, jobStatusMatch[1]);
  } else if (jobsListMatch && req.method === 'GET') {
    await handleJobsListRequest(res);
  } else if (servicesListMatch && req.method === 'GET') {
    await handleServicesListRequest(res);
  } else {
    logger.warn('no route matched', { method: req.method, path: urlPath });
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found', method: req.method, url: req.url, path: urlPath }));
  }
});

async function handleHealthCheck(req, res) {
  const extensionConnected = !!pollResponse;
  let queueLength = 0;
  let queueRunning = false;

  if (extensionConnected) {
    try {
      const result = await Promise.race([
        sendToExtension({ type: 'GET_STATUS' }),
        new Promise(r => setTimeout(() => r(null), 3000))
      ]);
      if (result && result.success) {
        queueLength = result.queueLength || 0;
        queueRunning = result.queueRunning || false;
      }
    } catch {}
  }

  res.statusCode = 200;
  res.end(JSON.stringify({
    status: extensionConnected ? 'ok' : 'degraded',
    extensionConnected,
    queueLength,
    queueRunning,
    uptime: Math.floor(process.uptime())
  }));
}

function handlePollRequest(req, res) {
  // Close any existing pending poll
  if (pollResponse) {
    clearTimeout(heartbeatTimer);
    pollResponse.statusCode = 200;
    pollResponse.end(JSON.stringify({ type: 'HEARTBEAT' }));
  }

  // Send queued message if any
  if (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    res.statusCode = 200;
    res.end(JSON.stringify(msg));
    return;
  }

  // Hold connection for up to 30 seconds
  pollResponse = res;
  heartbeatTimer = setTimeout(() => {
    if (pollResponse === res) {
      pollResponse = null;
      res.statusCode = 200;
      res.end(JSON.stringify({ type: 'HEARTBEAT' }));
    }
  }, 30000);

  req.on('close', () => {
    if (pollResponse === res) {
      pollResponse = null;
      clearTimeout(heartbeatTimer);
    }
  });
}

function handleExtensionResponse(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const msg = JSON.parse(body);
      handleIncomingMessage(msg);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

async function handleExecuteRequest(res, serviceName, req) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    // WS2.3: separate JSON-parse errors (400, client fault) from transport errors (500).
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid JSON body: ' + err.message }));
      return;
    }
    try {
      // All executions are async — returns jobId, unless the extension rejects
      // synchronously with an httpStatus (404 unknown service, 400 bad input, 409 disabled).
      const result = await sendToExtension({
        type: 'EXECUTE',
        serviceName,
        input: parsed.input || {}
      });
      res.statusCode = result.success ? 202 : (result.httpStatus || 500);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

async function handleJobWaitRequest(req, res, jobId) {
  // Parse timeout from query string
  const url = new URL(req.url, `http://localhost:${currentPort}`);
  const timeoutSec = Math.min(parseInt(url.searchParams.get('timeout') || '120'), 300);
  const deadline = Date.now() + timeoutSec * 1000;
  const pollInterval = 1000;

  try {
    while (Date.now() < deadline) {
      const result = await sendToExtension({ type: 'GET_JOB_STATUS', jobId });
      if (!result.success) {
        res.statusCode = 404;
        res.end(JSON.stringify(result));
        return;
      }
      const status = result.job?.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        return;
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }
    // Timeout — return current status
    const result = await sendToExtension({ type: 'GET_JOB_STATUS', jobId });
    res.statusCode = 200;
    res.end(JSON.stringify({ ...result, timedOut: true }));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleJobStatusRequest(res, jobId) {
  try {
    const result = await sendToExtension({ type: 'GET_JOB_STATUS', jobId });
    res.statusCode = result.success ? 200 : 404;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleJobsListRequest(res) {
  try {
    const result = await sendToExtension({ type: 'GET_JOBS' });
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleCancelRequest(res, jobId) {
  try {
    const result = await sendToExtension({ type: 'CANCEL_JOB', jobId });
    res.statusCode = result.success ? 200 : 400;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleServicesListRequest(res) {
  try {
    const result = await sendToExtension({ type: 'GET_SERVICES' });
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleStepAddRequest(res, serviceName, req) {
  const body = await readBody(req);
  if (body === null) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }
  let step;
  try {
    step = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }
  if (typeof step !== 'object' || step === null || Array.isArray(step)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Request body must be a step object' }));
    return;
  }
  try {
    const result = await sendToExtension({ type: 'STEP_ADD', serviceName, step });
    res.statusCode = result.success ? 201 : 404;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleStepUpdateRequest(res, serviceName, stepId, req) {
  const body = await readBody(req);
  if (body === null) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }
  let patch;
  try {
    patch = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Request body must be a patch object' }));
    return;
  }
  try {
    const result = await sendToExtension({ type: 'STEP_UPDATE', serviceName, stepId, patch });
    res.statusCode = result.success ? 200 : 404;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleStepDeleteRequest(res, serviceName, stepId) {
  try {
    const result = await sendToExtension({ type: 'STEP_DELETE', serviceName, stepId });
    res.statusCode = result.success ? 200 : 404;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: err.message }));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(null));
  });
}

// EADDRINUSE on initial startup is fatal — record it loudly so the doctor
// can surface the conflict from the log file.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('port already in use — another host instance is likely running. Try pkill -f "node.*host.js" then restart.', { port: currentPort, code: err.code });
  } else {
    logger.error('server error', { code: err.code, message: err.message });
  }
});

if (require.main === module) {
  server.listen(currentPort, () => {
    logger.info('listening for HTTP', { port: currentPort });
    process.stderr.write('  Waiting for extension to connect via long-polling on port ' + currentPort + '.\n');
    process.stderr.write('  Test: curl -H "x-api-key: ' + API_KEY + '" http://localhost:' + currentPort + '/api/v1/jobs\n');
  });
}

// --- doctor -----------------------------------------------------------------
// Ran via `node host.js --doctor`. Same surface as install-host.sh --doctor
// but useful when the wrapper/manifest side is fine and you want to debug the
// running host's view of the world.

function runDoctor() {
  const logFile = resolveLogPath();
  process.stderr.write('Scrapewright host doctor\n');
  process.stderr.write('\n');
  process.stderr.write('Environment:\n');
  process.stderr.write('  node:           ' + process.version + '\n');
  process.stderr.write('  platform:       ' + process.platform + '\n');
  process.stderr.write('  cwd:            ' + process.cwd() + '\n');
  process.stderr.write('  host.js:        ' + __filename + '\n');
  process.stderr.write('  log file:       ' + logFile + '\n');
  process.stderr.write('  port (default): ' + (parseInt(process.env.SCRAPEWRIGHT_PORT) || 8765) + '\n');
  process.stderr.write('\n');

  process.stderr.write('Recent log (last 15 lines):\n');
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-15);
    if (lines.length === 0) {
      process.stderr.write('  (log file exists but is empty)\n');
    } else {
      for (const l of lines) process.stderr.write('  ' + l + '\n');
    }
  } catch (e) {
    process.stderr.write('  (no log file yet)\n');
  }
}

module.exports = { server, sendToExtension, handleExecuteRequest, handleJobStatusRequest, handleJobWaitRequest, handleJobsListRequest, handleServicesListRequest, handleCancelRequest, handleStepAddRequest, handleStepUpdateRequest, handleStepDeleteRequest };
