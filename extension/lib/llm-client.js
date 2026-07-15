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

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      console.error('[LLMClient] Network error:', e);
      throw new Error(`Network error calling LLM API (${url}): ${e.message}`);
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
      if (response.status === 404) {
        throw new Error(`LLM API endpoint not found (404). URL: ${url}. Check your Base URL and Model name. Detail: ${detail}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`LLM API auth failed (${response.status}). Check your API key. Detail: ${detail}`);
      }
      throw new Error(`LLM API error (${response.status}): ${detail}`);
    }
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      console.error('[LLMClient] Non-JSON response:', text.slice(0, 500));
      throw new Error(`LLM API returned non-JSON (status ${response.status}, content-type: ${contentType}, url: ${url}). Response starts with: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    console.log('[LLMClient] Response data keys:', Object.keys(data));

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error('[LLMClient] Unexpected response structure:', JSON.stringify(data, null, 2).slice(0, 500));
      throw new Error(`LLM API returned unexpected format. Expected data.choices[0].message.content, got: ${JSON.stringify(data).slice(0, 200)}`);
    }

    const content = data.choices[0].message.content;
    console.log('[LLMClient] Response content length:', content?.length);
    console.log('[LLMClient] Response content preview:', content?.slice(0, 300));

    return content;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LLMClient };
} else if (typeof window !== 'undefined') {
  window.LLMClient = LLMClient;
}
