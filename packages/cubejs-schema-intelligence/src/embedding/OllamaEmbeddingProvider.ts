/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Ollama embedding provider for self-hosted models.
 */

import type { EmbeddingProvider, EmbeddingConfig } from '../types';
import { retryFetch } from '../llm/retryFetch';

/**
 * Embedding provider for self-hosted Ollama instances.
 * Calls the native Ollama `/api/embed` endpoint (not OpenAI-compatible `/v1`).
 *
 * @example
 * ```ts
 * const provider = new OllamaEmbeddingProvider({
 *   provider: 'ollama',
 *   model: 'nomic-embed-text',           // default
 *   endpoint: 'http://localhost:11434',   // default
 * });
 * const vectors = await provider.embed(['What is revenue?']);
 * // vectors[0].length === 768
 * ```
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private endpoint: string;
  private dimCount: number;

  /**
   * @param config - Embedding configuration.
   *   `config.model` defaults to `'nomic-embed-text'`.
   *   `config.endpoint` defaults to `'http://localhost:11434'`.
   *   `config.dimensions` defaults to `768`.
   */
  constructor(config: EmbeddingConfig) {
    this.model = config.model || 'nomic-embed-text';
    this.endpoint = config.endpoint || 'http://localhost:11434';
    this.dimCount = config.dimensions || 768;
  }

  /** Embed one or more texts into vectors via Ollama's `/api/embed` endpoint. */
  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
      const resp = await retryFetch(`${this.endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: text }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Ollama embedding error (${resp.status}): ${err}`);
      }

      const json: any = await resp.json();
      const embedding = json.embeddings?.[0] || json.embedding;
      if (!embedding) {
        throw new Error('Ollama returned no embedding');
      }
      results.push(embedding);

      if (this.dimCount === 768 && embedding.length !== 768) {
        this.dimCount = embedding.length;
      }
    }

    return results;
  }

  /** Returns the dimensionality of the embedding vectors (e.g. 768 for nomic-embed-text). */
  dimensions(): number {
    return this.dimCount;
  }

  async shutdown(): Promise<void> {
    // No-op
  }
}
