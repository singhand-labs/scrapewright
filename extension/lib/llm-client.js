const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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

class LLMClient {
  constructor(config) {
    this.provider = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.apiBaseUrl = config.apiBaseUrl || this.getDefaultBaseUrl();
    this.temperature = config.temperature ?? 0.1;
  }

  getDefaultBaseUrl() {
    switch (this.provider) {
      case 'openai': return 'https://api.openai.com/v1';
      case 'moonshot': return 'https://api.moonshot.cn/v1';
      case 'kimi': return 'https://api.moonshot.cn/v1';
      case 'anthropic': return 'https://api.anthropic.com/v1';
      case 'glm': return 'https://open.bigmodel.cn/api/paas/v4';
      default: throw new Error(`Unknown provider: ${this.provider}`);
    }
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
    const base = this.apiBaseUrl.replace(/\/$/, '');
    const url = `${base}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens ?? 4096,
      response_format: options.jsonMode ? { type: 'json_object' } : undefined
    };

    console.log('[LLMClient] Request URL:', url);
    console.log('[LLMClient] Request model:', this.model);
    console.log('[LLMClient] Request body:', JSON.stringify(body, null, 2));

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
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

    console.log('[LLMClient] Response status:', response.status);
    console.log('[LLMClient] Response content-type:', response.headers.get('content-type'));

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      let detail = '';
      try {
        const errBody = await response.json();
        detail = errBody.error?.message || JSON.stringify(errBody).slice(0, 300);
      } catch (e) {
        detail = (await response.text()).slice(0, 300);
      }
      const retryable = RETRYABLE_STATUS.has(response.status);
      const base = { retryable, status: response.status };
      if (response.status === 404) {
        throw new LLMError(`LLM API endpoint not found (404). URL: ${url}. Check your Base URL and Model name. Detail: ${detail}`, base);
      }
      if (response.status === 401 || response.status === 403) {
        throw new LLMError(`LLM API auth failed (${response.status}). Check your API key. Detail: ${detail}`, base);
      }
      throw new LLMError(`LLM API error (${response.status}): ${detail}`, base);
    }
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      console.error('[LLMClient] Non-JSON response:', text.slice(0, 500));
      // Proxy hiccups (HTML error pages) are often transient.
      throw new LLMError(`LLM API returned non-JSON (status ${response.status}, content-type: ${contentType}, url: ${url}). Response starts with: ${text.slice(0, 200)}`, { retryable: true, status: response.status });
    }

    const data = await response.json();
    console.log('[LLMClient] Response data keys:', Object.keys(data));

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error('[LLMClient] Unexpected response structure:', JSON.stringify(data, null, 2).slice(0, 500));
      throw new LLMError(`LLM API returned unexpected format. Expected data.choices[0].message.content, got: ${JSON.stringify(data).slice(0, 200)}`, { retryable: false });
    }

    const message = data.choices[0].message;
    const finishReason = data.choices[0].finish_reason;
    const usage = data.usage || {};
    console.log('[LLMClient] Response finish_reason:', finishReason);
    console.log('[LLMClient] Response usage:', JSON.stringify(usage));

    const content = message.content;
    console.log('[LLMClient] Response content length:', content?.length);
    console.log('[LLMClient] Response content preview:', content?.slice(0, 300));

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
      const hint = finishReason === 'length'
        ? ' (finish_reason=length — raise maxTokens; the model could not fit a complete response in the token budget)'
        : finishReason === 'content_filter'
          ? ' (finish_reason=content_filter — the response was filtered)'
          : '';
      // Empty content with no overflow signal is often transient under load —
      // retry before surfacing.
      throw new LLMError(`LLM API returned empty content${hint}. Detail: ${detail}`, { retryable: true });
    }

    return content;
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
