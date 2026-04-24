/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Ollama embedding provider for self-hosted models.
 */

import type { EmbeddingProvider, EmbeddingConfig } from '../types';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private endpoint: string;
  private dimCount: number;

  constructor(config: EmbeddingConfig) {
    this.model = config.model || 'nomic-embed-text';
    this.endpoint = config.endpoint || 'http://localhost:11434';
    this.dimCount = config.dimensions || 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
      const resp = await fetch(`${this.endpoint}/api/embed`, {
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

  dimensions(): number {
    return this.dimCount;
  }

  async shutdown(): Promise<void> {
    // No-op
  }
}
