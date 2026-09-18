// Nineteenth log (user directive): provider rate limiting (429 storms — 41 in
// one session) burned the old 3-retry budget. Ten retries with exponential
// backoff rides out a sustained limit window (~63s worst case) instead of
// killing the session. Callers can override via options.maxRetries.
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Thirty-fourth log: Zhipu reports a PERMANENT billing condition via 429 with
// "Insufficient balance or no resource package. Please recharge." (four
// identical attempts in the live log — deterministic). Status-only
// classification burned the whole 10-retry budget (~63s) on every call and
// the retry notes made a terminal condition read as a transient hiccup.
// The signal is the error BODY semantics (balance/recharge), not the status —
// matched provider-agnostically, alongside the CN-provider phrasings.
const BALANCE_EXHAUSTED_RE = /insufficient balance|no resource package|please recharge|balance is exhausted|insufficient credits|arrears|欠费|余额不足/i;

// Thirty-fourth log followup (user directive): speak the Anthropic Messages
// protocol natively, PREFER it by default when the server supports it (coding
// plans — GLM Coding Plan, Kimi, ... — expose /v1/messages and provision the
// generous agent lane there), and fall back to OpenAI chat/completions when
// the server does not. Capability is probed once per base URL and cached in
// this map for the lifetime of the page context.
const ANTHROPIC_VERSION = '2023-06-01';
// Coding-plan lanes are provisioned for agent clients and classify traffic by
// the Claude Code client signature; mirror it so paid plan traffic lands in
// the agent lane instead of the generic low-limit pool.
const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.1.6 (external, cli)';
// Claude Code client fingerprint (2026-09-18 user directive: the LLM server
// must classify this system as a Claude Code client). Real Claude Code rides
// the Anthropic TS SDK — gateways fingerprinting agent traffic look for the
// Claude Code beta flag, the stainless SDK telemetry set, and a stable
// per-install metadata.user_id alongside the UA/x-app pair we already send.
const CLAUDE_CODE_BETA = 'claude-code-20250219';
const STAINLESS_HEADERS = {
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.60.0',
  'x-stainless-os': 'Unknown',
  'x-stainless-arch': 'unknown',
  'x-stainless-runtime': 'browser',
  'x-stainless-runtime-version': 'unknown'
};
// Stable per-install pseudo account id (body.metadata.user_id) — gateways
// check presence/shape, not validity; persisted so the fingerprint doesn't
// rotate between sessions.
let _ccUserId = null;
function claudeCodeUserId() {
  if (_ccUserId) return _ccUserId;
  try {
    const k = 'swCcUserId';
    const existing = (typeof localStorage !== 'undefined' && localStorage.getItem(k)) || null;
    if (existing) { _ccUserId = existing; return _ccUserId; }
  } catch (e) { /* non-DOM contexts */ }
  let h = 0;
  const seed = String((typeof navigator !== 'undefined' && navigator.userAgent) || 'sw') + String(Date.now());
  for (let i = 0; i < seed.length; i++) { h = (h * 31 + seed.charCodeAt(i)) >>> 0; }
  _ccUserId = 'user_' + h.toString(16).padStart(8, '0') + '-0000-4000-8000-' + h.toString(16).padStart(12, '0').slice(0, 12);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('swCcUserId', _ccUserId); } catch (e) { /* best effort */ }
  return _ccUserId;
}
const anthropicCapableByBase = new Map();

// Thirty-seventh log (user report): auto + the GLM Coding Plan preset
// assembled https://open.bigmodel.cn/api/coding/paas/v4/v1/messages — a
// path that does not exist (the b9818bc probe design wrongly assumed
// coding-plan bases served an appended /v1/messages). Thirty-eighth log
// (user report): the followup that resolved auto straight to OpenAI
// silently degraded the Messages preference — Zhipu's official coding-plan
// doc provisions BOTH endpoints under one plan: chat/completions on the
// configured coding lane AND the Anthropic Messages API on a DIFFERENT base
// (https://open.bigmodel.cn/api/anthropic). So Messages calls ROUTE to the
// documented sibling lane while chat/completions stays on the configured
// base — same plan quota on either. Keyed by the EXACT documented chat-lane
// base: any custom/overridden base keeps normal probe-and-append behavior,
// and a sibling capability miss falls back to the configured lane's
// chat/completions exactly like any probe failure.
const MESSAGES_LANE_BY_CHAT_LANE = {
  'https://open.bigmodel.cn/api/coding/paas/v4': 'https://open.bigmodel.cn/api/anthropic'
};

// Thirty-second log (user directive): the 300-char response preview hid the
// model's think + tool-call — exported logs could not show WHAT the model
// decided, only that it replied. Chunk the full content across console lines
// (one output per line, (i/N) parts).
// Eighty-sixth-round user directive (2026-09-19): EVERYTHING exchanged with
// the LLM must reach the console in full — the 8000/32000 caps cut the
// request tail where the system prompt, EVIDENCE DOSSIER ([STEP PLAN]),
// USER FEEDBACK entries, and knowledge units ride, making three feedback
// rounds in one log unrecoverable for review. No cap: long content just
// produces more (i/N) segments.
const CONTENT_LOG_CHUNK = 1500;
const CONTENT_LOG_CAP = Infinity;
function logContentChunks(label, content, capOverride) {
  const cap = (typeof capOverride === 'number' && capOverride > 0) ? capOverride : CONTENT_LOG_CAP;
  const s = String(content == null ? '' : content);
  if (!s) return;
  const shown = s.length > cap ? s.slice(0, cap) : s;
  const n = Math.ceil(shown.length / CONTENT_LOG_CHUNK);
  for (let i = 0; i < n; i++) {
    console.log(label + ' (' + (i + 1) + '/' + n + '):', shown.slice(i * CONTENT_LOG_CHUNK, (i + 1) * CONTENT_LOG_CHUNK));
  }
  if (s.length > cap) {
    console.log(label + ' (tail elided):', '…[+' + (s.length - cap) + ' chars not shown]…');
  }
}

class LLMError extends Error {
  constructor(message, { retryable = false, status, cause } = {}) {
    super(message);
    this.name = 'LLMError';
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (cause) this.cause = cause;
  }
}

// Context-window overflow is deterministic: retrying the SAME prompt will fail
// the same way. Surfaced as a distinct class so callers can react (compact the
// prompt, drop history, etc.) instead of wasting the retry budget.
class LLMContextOverflow extends LLMError {
  constructor(message, detail) {
    super(message, { retryable: false });
    this.name = 'LLMContextOverflow';
    if (detail) this.detail = detail;
  }
}

function defaultBackoffMs(attempt) {
  // attempt is 0-based for the *failed* attempt; first retry waits ~1s, then
  // ~2s, then ~4s. Capped at 8s. Jitter spreads thundering-herd retries.
  const base = Math.min(1000 * Math.pow(2, attempt), 8000);
  return base + Math.floor(Math.random() * 500);
}

function normalizeBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

// The Messages API path depends on the base convention: a base that already
// ends in /messages IS the endpoint (users paste the full URL — appending
// again would double the path); Anthropic-native bases end in /v1 and take
// /messages; anything else is a bare prefix and takes /v1/messages. A
// documented two-lane provider's chat base never gets the append — Messages
// routes to its sibling lane instead (see MESSAGES_LANE_BY_CHAT_LANE).
function anthropicMessagesUrl(base) {
  const b = MESSAGES_LANE_BY_CHAT_LANE[normalizeBase(base)] || normalizeBase(base);
  if (/\/messages$/i.test(b)) return b;
  return /\/v1$/i.test(b) ? b + '/messages' : b + '/v1/messages';
}

class LLMClient {
  constructor(config) {
    this.provider = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.apiBaseUrl = config.apiBaseUrl || this.getDefaultBaseUrl();
    this.temperature = config.temperature ?? 0.1;
    // 'auto' (default) prefers Anthropic Messages and falls back to OpenAI
    // chat/completions when the server does not speak it; 'anthropic'/
    // 'openai' pin the protocol (no silent switching).
    this.apiProtocol = config.apiProtocol === 'anthropic' || config.apiProtocol === 'openai'
      ? config.apiProtocol
      : 'auto';
    // Per-config timeout (ms). Falls back to DEFAULT_TIMEOUT_MS at use site
    // when undefined/invalid so legacy configs without this field still work.
    const configured = Number(config.timeoutMs);
    this.timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : undefined;
    // Per-provider completion budget (RC53). The safe max_tokens value belongs
    // to the provider+model pair (e.g. reasoning models can spend the whole
    // budget on non-visible tokens — RC52: output_tokens 4096, text_tokens 0),
    // so it is a Settings-page config knob, not a per-call-site guess. Use
    // site chain: options.maxTokens ?? this.maxOutputTokens ?? 16384.
    const maxOut = Number(config.maxOutputTokens);
    this.maxOutputTokens = Number.isFinite(maxOut) && maxOut > 0 ? maxOut : undefined;
  }

  getDefaultBaseUrl() {
    switch (this.provider) {
      case 'openai': return 'https://api.openai.com/v1';
      case 'moonshot': return 'https://api.moonshot.cn/v1';
      case 'kimi': return 'https://api.moonshot.cn/v1';
      case 'anthropic': return 'https://api.anthropic.com/v1';
      case 'glm': return 'https://open.bigmodel.cn/api/paas/v4';
      // Zhipu's official coding-plan doc: plan quota is honored ONLY on the
      // plan's dedicated endpoints, and a key pointed elsewhere (e.g. the
      // pay-as-you-go /api/paas/v4 lane above) cannot spend it at all. The
      // preset keeps coding-plan keys off that silent-quota-loss trap; the
      // Anthropic-compatible lane (https://open.bigmodel.cn/api/anthropic) is
      // the other plan endpoint and stays a manual Base URL choice.
      case 'glm-coding': return 'https://open.bigmodel.cn/api/coding/paas/v4';
      default: throw new Error(`Unknown provider: ${this.provider}`);
    }
  }

  _resolveProtocol() {
    if (this.apiProtocol !== 'auto') return this.apiProtocol;
    const cached = anthropicCapableByBase.get(normalizeBase(this.apiBaseUrl));
    if (cached === false) return 'openai';
    return 'anthropic';
  }

  _markProtocol(capable) {
    if (this.apiProtocol !== 'auto') return;
    anthropicCapableByBase.set(normalizeBase(this.apiBaseUrl), !!capable);
  }

  async chat(messages, options = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffMs = options.backoffMs ?? defaultBackoffMs;

    let lastError;
    let attempt = 0;
    for (; attempt <= maxRetries; attempt++) {
      try {
        return await this._chatOnce(messages, options);
      } catch (e) {
        lastError = e;
        const retryable = e.retryable === true;
        if (!retryable || attempt === maxRetries) break;
        const wait = backoffMs(attempt);
        const shortErr = (e && e.message) ? e.message.split('\n')[0].slice(0, 200) : String(e);
        console.warn(`[LLMClient] Attempt ${attempt + 1} failed (${shortErr}); retrying in ${wait}ms`);
        // Nineteenth log (user directive): retries must be VISIBLE — the UI
        // shows "attempt N of M, waiting Xs" instead of an unexplained stall.
        if (typeof options.onRetry === 'function') {
          try { options.onRetry({ attempt: attempt + 1, maxRetries: maxRetries, wait: wait, error: shortErr }); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, wait));
      }
    }

    // Retries exhausted (or hit a non-retryable error after some attempt).
    // `attempt` is the 0-based index of the last try; total tries = attempt + 1.
    if (attempt >= 1 && lastError && lastError.retryable) {
      const wrapped = new Error(`LLM call failed after ${attempt + 1} attempts. Last error: ${lastError.message}`);
      wrapped.name = 'LLMRetryExhausted';
      wrapped.cause = lastError;
      wrapped.lastError = lastError;
      wrapped.attempts = attempt + 1;
      throw wrapped;
    }
    throw lastError || new Error('LLM call failed without a captured error');
  }

  async _chatOnce(messages, options = {}) {
    if (this._resolveProtocol() === 'anthropic') return this._chatAnthropic(messages, options);
    return this._chatOpenAI(messages, options);
  }

  async _fetchWithTimeout(url, init, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetch(url, Object.assign({}, init, {
        signal: controller ? controller.signal : undefined
      }));
    } catch (e) {
      const name = e && e.name;
      // AbortError = our timeout; network failures are also retryable.
      const msg = name === 'AbortError'
        ? `LLM API timed out after ${timeoutMs}ms (${url})`
        : `Network error calling LLM API (${url}): ${e.message}`;
      console.error('[LLMClient] Network/timeout error:', msg);
      throw new LLMError(msg, { retryable: true, cause: e });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Both protocol families carry the error detail as error.message (OpenAI
  // {error:{message}} and Anthropic {type:'error', error:{type,message}}).
  async _extractErrorDetail(response) {
    try {
      const errBody = await response.json();
      return (errBody && errBody.error && errBody.error.message) || JSON.stringify(errBody).slice(0, 300);
    } catch (e) {
      try { return (await response.text()).slice(0, 300); } catch (_) { return ''; }
    }
  }

  _throwHttpError(response, url, detail) {
    // Balance/recharge bodies name a deterministic provider-side billing
    // condition — identical retries cannot succeed (RC55 family: don't burn
    // the budget on deterministic failures). Fail fast with the remedy.
    if (BALANCE_EXHAUSTED_RE.test(detail)) {
      throw new LLMError(
        `LLM provider reports an account billing condition (status ${response.status}): ${detail} This is deterministic — no retry was attempted because identical retries cannot fix it.${this._balanceRemedyTail()}`,
        { retryable: false, status: response.status }
      );
    }
    if (response.status === 404) {
      throw new LLMError(`LLM API endpoint not found (404). URL: ${url}. Check your Base URL and Model name. Detail: ${detail}`, { retryable: false, status: 404 });
    }
    if (response.status === 401 || response.status === 403) {
      throw new LLMError(`LLM API auth failed (${response.status}). Check your API key. Detail: ${detail}`, { retryable: false, status: response.status });
    }
    throw new LLMError(`LLM API error (${response.status}): ${detail}`, { retryable: RETRYABLE_STATUS.has(response.status), status: response.status });
  }

  _balanceRemedyTail() {
    return ` Recharge the provider account (or claim/activate a resource package covering model ${this.model}), or switch provider/model in Settings. If your key rides a coding-plan subscription (GLM Coding Plan and similar), its quota is only honored on the plan's dedicated Base URL — pick the GLM Coding Plan provider in Settings (Base URL https://open.bigmodel.cn/api/coding/paas/v4) or point Base URL at https://open.bigmodel.cn/api/anthropic for the Anthropic-compatible lane.`;
  }

  // Thirty-fifth log: some gateways (bigmodel.cn observed live) wrap upstream
  // failures in an HTTP-200 envelope {code, msg, success:false}. Status-based
  // classification never fires on those, and the generic "unexpected format"
  // throw buries the gateway's own diagnosis — the observed msg was
  // "404 NOT_FOUND", i.e. the requested API path does not exist on that Base
  // URL for that protocol. Decode the envelope; its body carries the real
  // classification.
  _gatewayEnvelope(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (Array.isArray(data.content) || Array.isArray(data.choices)) return null;
    if (typeof data.code !== 'number' || typeof data.msg !== 'string' || !data.msg) return null;
    return { code: data.code, msg: data.msg };
  }

  _throwGatewayError(envelope, url, protocolLabel) {
    console.error('[LLMClient] Gateway error envelope on HTTP 200:', JSON.stringify(envelope));
    if (BALANCE_EXHAUSTED_RE.test(envelope.msg)) {
      throw new LLMError(
        `LLM provider reports an account billing condition (HTTP 200 envelope, code ${envelope.code}): ${envelope.msg} This is deterministic — no retry was attempted because identical retries cannot fix it.${this._balanceRemedyTail()}`,
        { retryable: false }
      );
    }
    if (/404|not[_ -]?found/i.test(envelope.msg)) {
      throw new LLMError(
        `LLM gateway answered HTTP 200 but reported the API path missing (code ${envelope.code}): ${envelope.msg} — the ${protocolLabel} endpoint does not exist on this Base URL. Check Settings → Base URL and the API protocol selector (Zhipu lanes: the GLM Coding Plan provider → https://open.bigmodel.cn/api/coding/paas/v4, or Anthropic-compatible https://open.bigmodel.cn/api/anthropic). URL: ${url}`,
        { retryable: false }
      );
    }
    throw new LLMError(
      `LLM gateway error inside an HTTP 200 envelope (code ${envelope.code}): ${envelope.msg}. URL: ${url}`,
      { retryable: RETRYABLE_STATUS.has(envelope.code) }
    );
  }

  // Shared post-response pipeline: logging, empty-content classification
  // (overflow / RC55 budget burn / transient), truncation disclosure.
  // finishReason is normalized to OpenAI vocabulary by the caller ('length',
  // 'content_filter', 'stop').
  _finalizeContent(content, finishReason, usage, options = {}) {
    const effectiveMaxTokens = options.maxTokens ?? this.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    console.log('[LLMClient] Response finish_reason:', finishReason);
    console.log('[LLMClient] Response usage:', JSON.stringify(usage));
    console.log('[LLMClient] Response content length:', content?.length);
    logContentChunks('[LLMClient] Response content', content);

    if (!content || !String(content).trim()) {
      const detail = JSON.stringify({ finish_reason: finishReason, usage, model: this.model });
      console.error('[LLMClient] Empty content from LLM:', detail);
      // GLM (and some other proxies) return HTTP 200 with finish_reason=
      // model_context_window_exceeded and empty content when the prompt is
      // too large. This is deterministic — retrying the same prompt just
      // burns the retry budget. Throw a non-retryable signal so the caller
      // can shrink the prompt and retry intelligently.
      const isContextOverflow = finishReason === 'model_context_window_exceeded'
        || finishReason === 'context_length_exceeded';
      if (isContextOverflow) {
        throw new LLMContextOverflow(
          `LLM context window exceeded (finish_reason=${finishReason}). The prompt is too large for model ${this.model}. Compact the prompt (drop history, truncate HTML) before retrying. Detail: ${detail}`,
          { finish_reason: finishReason, usage }
        );
      }
      // RC55 (console.log 2026-08-15 07:35-07:38): finish_reason=length with
      // EMPTY content means the ENTIRE completion budget was consumed before
      // any content (glm-5.1 invisible reasoning via the proxy —
      // completion_tokens exactly equals the cap, content length 0). This is
      // deterministic under fixed (prompt, cap): RC52 4/4 at 4096, RC55 2/2
      // at 16000, and the user confirmed 8192 AND 16000 both fail. Identical
      // retries can never succeed and each burns another full budget.
      // Non-retryable, with the effective budget in the message so the user
      // knows which knob (Settings maxOutputTokens) to raise.
      if (finishReason === 'length') {
        throw new LLMError(
          `LLM API returned empty content and consumed the ENTIRE ${effectiveMaxTokens}-token completion budget before emitting any content (finish_reason=length). This failure is deterministic — identical retries cannot succeed, so no retry was attempted. Raise the Settings maxOutputTokens (effective budget was ${effectiveMaxTokens}) or use a provider/model with lower reasoning overhead. Detail: ${detail}`,
          { retryable: false, finish_reason: finishReason, usage, effectiveMaxTokens }
        );
      }
      const hint = finishReason === 'content_filter'
        ? ' (finish_reason=content_filter — the response was filtered)'
        : '';
      // Empty content with no overflow/length signal is often transient under
      // load — retry before surfacing.
      throw new LLMError(`LLM API returned empty content${hint}. Detail: ${detail}`, { retryable: true });
    }

    // 2026-08-24: finish_reason=length WITH partial content — the response
    // was clipped by the completion cap. RC55 above only handles the
    // empty+length burn; a clipped payload used to be returned silently and
    // fail JSON parsing downstream with no hint that the CAUSE was the cap.
    // Return it (callers may still salvage it) but make the truncation
    // visible, with the effective budget and the Settings knob to raise.
    if (finishReason === 'length' && content) {
      console.warn(
        `[LLMClient] Output TRUNCATED (finish_reason=length): the response was cut at the ${effectiveMaxTokens}-token completion budget before finishing ` +
        `(${String(content).length} chars received, completion_tokens=${usage.completion_tokens ?? 'unknown'}). ` +
        `A truncated payload will likely fail JSON parsing or end mid-script. ` +
        `If this recurs, raise the Settings maxOutputTokens above ${effectiveMaxTokens} for this provider.`
      );
    }
    return content;
  }

  async _chatAnthropic(messages, options = {}) {
    const url = anthropicMessagesUrl(this.apiBaseUrl);
    // Lane routing transparency: when Messages resolves to the provider's
    // documented sibling lane instead of the configured base, say so —
    // exported console logs must explain the URL.
    const sibling = MESSAGES_LANE_BY_CHAT_LANE[normalizeBase(this.apiBaseUrl)];
    if (sibling) {
      console.log(`[LLMClient] Protocol note: Messages routed to the provider's Anthropic-compatible lane (${sibling}); chat/completions stays on the configured base (${normalizeBase(this.apiBaseUrl)}).`);
    }
    const body = {
      model: this.model,
      messages: [],
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens ?? this.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      metadata: { user_id: claudeCodeUserId() }
    };
    // The Messages API takes system as a top-level parameter, not a message
    // role; multiple system messages concatenate.
    const systemParts = [];
    for (const m of messages) {
      if (m && m.role === 'system') systemParts.push(String(m.content ?? ''));
      else body.messages.push({ role: m.role, content: String(m.content ?? '') });
    }
    if (systemParts.filter((s) => s).length) body.system = systemParts.join('\n\n');
    // No response_format/jsonMode equivalent in the Messages API — JSON-ness
    // is enforced by the prompts and the lenient parser downstream.

    console.log('[LLMClient] Request URL:', url);
    console.log('[LLMClient] Request model:', this.model);
    console.log('[LLMClient] Request protocol: anthropic-messages');
    // Thirty-third log D4: one-line chunked strings survive DevTools
    // "Save as…" (response path, 32nd log). Tighter cap than the response:
    // the transcript itself is already mirrored at the wizard layer.
    logContentChunks('[LLMClient] Request body', JSON.stringify(body));

    const timeoutMs = options.timeoutMs ?? this.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = await this._fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Both auth spellings: native Anthropic keys x-api-key; bridges and
        // coding-plan gateways usually accept Bearer (many only Bearer).
        'x-api-key': this.apiKey,
        'Authorization': `Bearer ${this.apiKey}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'user-agent': CLAUDE_CLI_USER_AGENT,
        'x-app': 'cli',
        'anthropic-beta': CLAUDE_CODE_BETA,
        ...STAINLESS_HEADERS
      },
      body: JSON.stringify(body)
    }, timeoutMs);

    console.log('[LLMClient] Response status:', response.status);
    console.log('[LLMClient] Response content-type:', response.headers.get('content-type'));
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      const detail = await this._extractErrorDetail(response);
      // Capability probe (auto only): a missing Messages surface answers
      // 404/405 — pin OpenAI for this base and re-run the call there.
      if ((response.status === 404 || response.status === 405) && this.apiProtocol === 'auto') {
        this._markProtocol(false);
        console.warn(`[LLMClient] ${url} does not speak the Anthropic Messages protocol (HTTP ${response.status}) — falling back to OpenAI chat/completions for this base URL.`);
        return this._chatOpenAI(messages, options);
      }
      this._throwHttpError(response, url, detail);
    }
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      console.error('[LLMClient] Non-JSON response:', text.slice(0, 500));
      // Proxy hiccups (HTML error pages) are often transient.
      throw new LLMError(`LLM API returned non-JSON (status ${response.status}, content-type: ${contentType}, url: ${url}). Response starts with: ${text.slice(0, 200)}`, { retryable: true, status: response.status });
    }

    const data = await response.json();
    console.log('[LLMClient] Response data keys:', Object.keys(data));

    if (Array.isArray(data.content)) {
      this._markProtocol(true);
      const text = data.content
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('');
      // Normalize stop_reason to the OpenAI finish_reason vocabulary the
      // shared pipeline (and the RC55/truncation branches) speak.
      const stop = data.stop_reason;
      const finishReason = stop === 'max_tokens' ? 'length'
        : stop === 'refusal' ? 'content_filter'
        : 'stop';
      const u = data.usage || {};
      const usage = {
        prompt_tokens: u.input_tokens,
        completion_tokens: u.output_tokens,
        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0)
      };
      return this._finalizeContent(text, finishReason, usage, options);
    }

    // 200 but OpenAI-shaped: a bridge aliasing both protocols on one URL —
    // parse the response we already hold instead of paying another request.
    if (data.choices && data.choices[0] && data.choices[0].message) {
      this._markProtocol(false);
      console.log('[LLMClient] Protocol note: OpenAI-shaped response on the Messages URL — parsing as OpenAI and pinning OpenAI for this base.');
      return this._parseOpenAISuccess(data, options);
    }

    // Neither completion shape. A gateway error envelope is NOT a shape
    // sniff: a 404-flavored msg means the Messages path does not exist on
    // this base (same capability miss as HTTP 404/405 — fall back in auto
    // mode); any other envelope is a provider-side error — decode it and
    // fail WITHOUT marking the base, so a transient gateway error cannot
    // permanently mis-pin the protocol.
    const envelope = this._gatewayEnvelope(data);
    if (envelope && /404|not[_ -]?found/i.test(envelope.msg)) {
      if (this.apiProtocol === 'auto') {
        this._markProtocol(false);
        console.warn(`[LLMClient] ${url} reports the Messages path missing (HTTP 200 envelope: ${envelope.msg}) — falling back to OpenAI chat/completions for this base URL.`);
        return this._chatOpenAI(messages, options);
      }
      this._throwGatewayError(envelope, url, 'Anthropic Messages');
    }
    if (envelope) this._throwGatewayError(envelope, url, 'Anthropic Messages');

    if (this.apiProtocol === 'auto') {
      this._markProtocol(false);
      console.warn(`[LLMClient] Unrecognized response shape on ${url} — falling back to OpenAI chat/completions for this base URL.`);
      return this._chatOpenAI(messages, options);
    }
    console.error('[LLMClient] Unexpected response structure:', JSON.stringify(data, null, 2).slice(0, 500));
    throw new LLMError(`LLM API returned unexpected format. Expected an Anthropic Messages response (content blocks) or data.choices[0].message.content, got: ${JSON.stringify(data).slice(0, 200)}`, { retryable: false });
  }

  async _chatOpenAI(messages, options = {}) {
    const base = normalizeBase(this.apiBaseUrl);
    const url = `${base}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens ?? this.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      response_format: options.jsonMode ? { type: 'json_object' } : undefined
    };

    console.log('[LLMClient] Request URL:', url);
    console.log('[LLMClient] Request model:', this.model);
    console.log('[LLMClient] Request protocol: openai-chat');
    // Thirty-third log D4: the pretty-printed multi-line JSON single arg
    // vanished from every exported console capture ("Request body:" lines
    // read empty). One-line chunked strings survive DevTools "Save as…"
    // (response path, 32nd log). Tighter cap than the response: the
    // transcript itself is already mirrored at the wizard layer.
    logContentChunks('[LLMClient] Request body', JSON.stringify(body));

    const timeoutMs = options.timeoutMs ?? this.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = await this._fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    }, timeoutMs);

    console.log('[LLMClient] Response status:', response.status);
    console.log('[LLMClient] Response content-type:', response.headers.get('content-type'));

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      const detail = await this._extractErrorDetail(response);
      this._throwHttpError(response, url, detail);
    }
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      console.error('[LLMClient] Non-JSON response:', text.slice(0, 500));
      // Proxy hiccups (HTML error pages) are often transient.
      throw new LLMError(`LLM API returned non-JSON (status ${response.status}, content-type: ${contentType}, url: ${url}). Response starts with: ${text.slice(0, 200)}`, { retryable: true, status: response.status });
    }

    const data = await response.json();
    console.log('[LLMClient] Response data keys:', Object.keys(data));
    return this._parseOpenAISuccess(data, options);
  }

  _parseOpenAISuccess(data, options = {}) {
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      // Thirty-fifth log: gateways wrapping errors in HTTP-200 {code,msg}
      // envelopes land here with no choices — decode before the generic
      // unexpected-format throw buries the gateway's diagnosis.
      const envelope = this._gatewayEnvelope(data);
      if (envelope) {
        this._throwGatewayError(envelope, `${normalizeBase(this.apiBaseUrl)}/chat/completions`, 'OpenAI chat/completions');
      }
      console.error('[LLMClient] Unexpected response structure:', JSON.stringify(data, null, 2).slice(0, 500));
      throw new LLMError(`LLM API returned unexpected format. Expected data.choices[0].message.content, got: ${JSON.stringify(data).slice(0, 200)}`, { retryable: false });
    }
    const message = data.choices[0].message;
    const finishReason = data.choices[0].finish_reason;
    const usage = data.usage || {};
    return this._finalizeContent(message.content, finishReason, usage, options);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LLMClient, LLMError, LLMContextOverflow };
} else if (typeof window !== 'undefined') {
  window.LLMClient = LLMClient;
  window.LLMError = LLMError;
  window.LLMContextOverflow = LLMContextOverflow;
} else if (typeof self !== 'undefined') {
  self.LLMClient = LLMClient;
  self.LLMError = LLMError;
  self.LLMContextOverflow = LLMContextOverflow;
}
