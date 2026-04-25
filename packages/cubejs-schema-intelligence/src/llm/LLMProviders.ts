/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview LLM provider resolver — auto-detects Ollama, maps predefined model names.
 */

import type { LLMProvider, LLMConfig, CompletionOptions, TranslatorConfig } from '../types';

// ── Predefined model name → provider config mapping ──
// Aligned with Cube Cloud's agents/config.yml `llm` values.

const MODEL_REGISTRY: Record<string, { provider: string; model: string }> = {
  // Anthropic Claude
  claude_3_5_sonnetv2: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  claude_3_7_sonnet: { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
  claude_4_sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  claude_4_5_sonnet: { provider: 'anthropic', model: 'claude-4-5-sonnet-20260301' },
  claude_4_6_sonnet: { provider: 'anthropic', model: 'claude-4-6-sonnet-20260401' },
  // OpenAI GPT
  gpt_4o: { provider: 'openai', model: 'gpt-4o' },
  gpt_4_1: { provider: 'openai', model: 'gpt-4.1' },
  gpt_4_1_mini: { provider: 'openai', model: 'gpt-4.1-mini' },
  gpt_5: { provider: 'openai', model: 'gpt-5' },
  gpt_5_mini: { provider: 'openai', model: 'gpt-5-mini' },
  o3: { provider: 'openai', model: 'o3' },
  o4_mini: { provider: 'openai', model: 'o4-mini' },
};

// ── OpenAI LLM Provider ──

/**
 * OpenAI LLM provider using the Chat Completions API.
 * Works with any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, LiteLLM, etc.).
 *
 * @example
 * ```ts
 * const llm = new OpenAILLMProvider({
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: 'gpt-4o-mini',  // default
 * });
 * const answer = await llm.complete('Translate: show revenue by month');
 * ```
 */
export class OpenAILLMProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private endpoint: string;

  /**
   * @param config - LLM configuration. `apiKey` is required.
   *   `config.model` defaults to `'gpt-4o-mini'`.
   *   `config.endpoint` defaults to `'https://api.openai.com/v1/chat/completions'`.
   * @throws Error if `apiKey` is not provided.
   */
  constructor(config: LLMConfig) {
    if (!config.apiKey) throw new Error('OpenAI LLM provider requires apiKey');
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4o-mini';
    this.endpoint = config.endpoint || 'https://api.openai.com/v1/chat/completions';
  }

  /** Send a prompt and return the LLM's text response. */
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const messages: any[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || this.model,
        messages,
        temperature: options?.temperature ?? 0.1,
        max_tokens: options?.maxTokens || 4096,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error (${resp.status}): ${err}`);
    }

    const json: any = await resp.json();
    return json.choices[0].message.content;
  }

  /** Send a prompt and parse the response as JSON matching `jsonSchema`. */
  async completeStructured<T = any>(prompt: string, jsonSchema: Record<string, any>, options?: CompletionOptions): Promise<T> {
    const schemaPrompt = `${prompt}\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
    let jsonStr = await this.complete(schemaPrompt, options);
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    return JSON.parse(jsonStr);
  }

  async shutdown(): Promise<void> {
    // No-op
  }
}

// ── Ollama LLM Provider ──

/**
 * Ollama LLM provider using the native `/api/chat` endpoint.
 * For self-hosted LLM inference with models like llama3, mistral, qwen, etc.
 *
 * @example
 * ```ts
 * const llm = new OllamaLLMProvider({
 *   provider: 'ollama',
 *   model: 'qwen3:0.6b',
 *   endpoint: 'http://localhost:11434',  // default
 * });
 * const answer = await llm.complete('Translate: show revenue by month');
 * ```
 */
export class OllamaLLMProvider implements LLMProvider {
  private model: string;
  private endpoint: string;

  /**
   * @param config - LLM configuration.
   *   `config.model` defaults to `'llama3.1'`.
   *   `config.endpoint` defaults to `'http://localhost:11434'`.
   */
  constructor(config: LLMConfig) {
    this.model = config.model || 'llama3.1';
    this.endpoint = config.endpoint || 'http://localhost:11434';
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const messages: any[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const resp = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model || this.model,
        messages,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.1,
          num_predict: options?.maxTokens || 4096,
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Ollama API error (${resp.status}): ${err}`);
    }

    const json: any = await resp.json();
    return json.message.content;
  }

  async completeStructured<T = any>(prompt: string, jsonSchema: Record<string, any>, options?: CompletionOptions): Promise<T> {
    const structuredPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}\n\nJSON response:`;
    const result = await this.complete(structuredPrompt, { ...options, temperature: options?.temperature ?? 0.05 });

    let jsonStr = result.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    return JSON.parse(jsonStr);
  }

  async shutdown(): Promise<void> {
    // No-op
  }
}

// ── Resolver ──

/**
 * Resolve an LLM provider from configuration. Tries in order:
 * 1. Explicit object config (`{ provider: 'openai', apiKey: ... }`)
 * 2. Predefined model name string (`'gpt_4o'`, `'claude_4_sonnet'`)
 * 3. Auto-detect local Ollama (probes `http://localhost:11434/api/tags`)
 * 4. API key env vars (`CUBEJS_LLM_API_KEY` or `OPENAI_API_KEY`)
 * 5. Returns `null` if no LLM is available.
 */
export async function resolveLLMProvider(config?: TranslatorConfig): Promise<LLMProvider | null> {
  const llmConfig = config?.llm;

  // 1. Explicit object config
  if (llmConfig && typeof llmConfig === 'object') {
    const c = llmConfig as LLMConfig;
    switch (c.provider) {
      case 'openai':
        return new OpenAILLMProvider(c);
      case 'ollama':
        return new OllamaLLMProvider(c);
      default:
        throw new Error(`Unknown LLM provider: ${c.provider}`);
    }
  }

  // 2. Predefined model name (e.g. 'claude_4_sonnet', 'gpt_4o')
  if (typeof llmConfig === 'string' && llmConfig !== 'auto') {
    const reg = MODEL_REGISTRY[llmConfig];
    if (reg) {
      return resolveLLMProvider({
        ...config,
        llm: { provider: reg.provider, model: reg.model, apiKey: process.env.CUBEJS_LLM_API_KEY },
      });
    }
    throw new Error(`Unknown predefined LLM model: ${llmConfig}. Known: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
  }

  // 3. Auto-detect Ollama
  try {
    const resp = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const json: any = await resp.json();
      const models: string[] = (json.models || []).map((m: any) => m.name || m.model);
      const preferred = ['llama3.1', 'mistral', 'qwen2.5', 'gemma2'];
      const model = preferred.find(p => models.some(m => m.includes(p))) || models[0];
      if (model) {
        return new OllamaLLMProvider({ provider: 'ollama', model });
      }
    }
  } catch {
    // Ollama not available
  }

  // 4. Check for API key environment variables
  if (process.env.CUBEJS_LLM_API_KEY || process.env.OPENAI_API_KEY) {
    return new OpenAILLMProvider({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: process.env.CUBEJS_LLM_API_KEY || process.env.OPENAI_API_KEY,
    });
  }

  // 5. No LLM available
  return null;
}

export { MODEL_REGISTRY };
