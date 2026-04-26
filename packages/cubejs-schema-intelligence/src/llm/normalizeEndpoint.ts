/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Endpoint URL normalization for LLM and embedding providers.
 *
 * Users provide a single `CUBEJS_AI_LLM_BASE_URL` (e.g. `http://ollama:11434/v1`
 * or `https://api.openai.com/v1`). Each provider type needs a different final URL:
 *
 * | Provider | API path |
 * |----------|----------|
 * | OpenAI LLM | `/v1/chat/completions` |
 * | OpenAI Embeddings | `/v1/embeddings` |
 * | Ollama LLM | `/api/chat` (base only — SDK appends) |
 * | Ollama Embeddings | `/api/embed` (base only — SDK appends) |
 * | Anthropic LLM | `/v1/messages` |
 * | Mistral LLM | `/v1/chat/completions` (OpenAI-compatible) |
 * | Mistral Embeddings | `/v1/embeddings` (OpenAI-compatible) |
 *
 * This module normalizes the raw endpoint into the correct base URL for each
 * provider type so individual providers don't need to care about URL formats.
 */

export type ProviderType =
  | 'openai-llm'
  | 'openai-embedding'
  | 'ollama-llm'
  | 'ollama-embedding'
  | 'anthropic-llm'
  | 'mistral-llm'
  | 'mistral-embedding';

/**
 * Normalize a raw endpoint URL for a specific provider type.
 *
 * @param endpoint - Raw endpoint from config (may have `/v1` suffix, trailing slash, or full path).
 * @param providerType - Which provider will consume this URL.
 * @returns The normalized endpoint URL ready for the provider to use directly.
 *
 * @example
 * ```ts
 * // Ollama — strip /v1, provider appends /api/chat or /api/embed itself
 * normalizeEndpoint('http://ollama:11434/v1', 'ollama-llm')
 * // → 'http://ollama:11434'
 *
 * // OpenAI — ensure full chat completions path
 * normalizeEndpoint('https://api.openai.com/v1', 'openai-llm')
 * // → 'https://api.openai.com/v1/chat/completions'
 *
 * // OpenAI — already complete, returned as-is
 * normalizeEndpoint('https://api.openai.com/v1/chat/completions', 'openai-llm')
 * // → 'https://api.openai.com/v1/chat/completions'
 *
 * // Anthropic — ensure /v1/messages path
 * normalizeEndpoint('https://api.anthropic.com', 'anthropic-llm')
 * // → 'https://api.anthropic.com/v1/messages'
 *
 * // Mistral — OpenAI-compatible, ensure full path
 * normalizeEndpoint('https://api.mistral.ai/v1', 'mistral-llm')
 * // → 'https://api.mistral.ai/v1/chat/completions'
 *
 * normalizeEndpoint('https://api.mistral.ai/v1', 'mistral-embedding')
 * // → 'https://api.mistral.ai/v1/embeddings'
 * ```
 */
export function normalizeEndpoint(endpoint: string, providerType: ProviderType): string {
  const trimmed = endpoint.replace(/\/+$/, '');

  switch (providerType) {
    case 'ollama-llm':
    case 'ollama-embedding':
      // Ollama uses native /api/* endpoints — strip any /v1 suffix.
      return trimmed.replace(/\/v1$/, '');

    case 'openai-llm':
    case 'mistral-llm':
      // OpenAI-compatible chat API — ensure path ends with /chat/completions.
      if (trimmed.endsWith('/chat/completions')) return trimmed;
      return `${trimmed}/chat/completions`;

    case 'openai-embedding':
    case 'mistral-embedding':
      // OpenAI-compatible embeddings API — ensure path ends with /embeddings.
      if (trimmed.endsWith('/embeddings')) return trimmed;
      return `${trimmed}/embeddings`;

    case 'anthropic-llm':
      // Anthropic Messages API — ensure path ends with /v1/messages.
      if (trimmed.endsWith('/v1/messages')) return trimmed;
      // Strip a bare /v1 so we don't double it (e.g. user passes "…/v1").
      return `${trimmed.replace(/\/v1$/, '')}/v1/messages`;

    default:
      return trimmed;
  }
}
