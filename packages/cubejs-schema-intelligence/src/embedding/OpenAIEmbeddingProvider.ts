/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview OpenAI embedding provider (text-embedding-3-small/large, ada-002).
 */

import type { EmbeddingProvider, EmbeddingConfig } from '../types';

/**
 * Embedding provider using the OpenAI Embeddings API.
 * Supports `text-embedding-3-small`, `text-embedding-3-large`, and `text-embedding-ada-002`.
 *
 * @example
 * ```ts
 * const provider = new OpenAIEmbeddingProvider({
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: 'text-embedding-3-small',  // default
 * });
 * const vectors = await provider.embed(['show revenue by region']);
 * // vectors[0].length === 1536
 * ```
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private dimCount: number;
  private endpoint: string;
  private batchSize: number;

  /**
   * @param config - Embedding configuration. `apiKey` is required.
   *   `config.model` defaults to `'text-embedding-3-small'`.
   *   `config.dimensions` defaults to `1536`.
   *   `config.endpoint` defaults to `'https://api.openai.com/v1/embeddings'`.
   *   `config.batchSize` defaults to `100`.
   * @throws Error if `apiKey` is not provided.
   */
  constructor(config: EmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI embedding provider requires apiKey');
    }
    this.apiKey = config.apiKey;
    this.model = config.model || 'text-embedding-3-small';
    this.dimCount = config.dimensions || 1536;
    this.endpoint = config.endpoint || 'https://api.openai.com/v1/embeddings';
    this.batchSize = config.batchSize || 100;
  }

  /** Embed texts in batches via the OpenAI API. Returns one vector per input text. */
  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: batch,
          model: this.model,
          dimensions: this.dimCount,
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`OpenAI embedding API error (${resp.status}): ${err}`);
      }

      const json: any = await resp.json();
      for (const item of json.data) {
        results.push(item.embedding);
      }
    }

    return results;
  }

  dimensions(): number {
    return this.dimCount;
  }

  async shutdown(): Promise<void> {
    // No-op — HTTP client, nothing to close
  }
}
