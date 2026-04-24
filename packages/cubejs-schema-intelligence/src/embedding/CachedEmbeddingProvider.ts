/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Embedding cache — skip re-embedding unchanged schemas.
 */

import crypto from 'crypto';

import type { EmbeddingProvider } from '../types';

export class CachedEmbeddingProvider implements EmbeddingProvider {
  private cache: Map<string, { contentHash: string; embedding: number[] }> = new Map();
  private delegate: EmbeddingProvider;

  constructor(delegate: EmbeddingProvider) {
    this.delegate = delegate;
  }

  static contentHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const hash = CachedEmbeddingProvider.contentHash(texts[i]);
      const cached = this.cache.get(texts[i].substring(0, 200));
      if (cached && cached.contentHash === hash) {
        results[i] = cached.embedding;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const embeddings = await this.delegate.embed(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = embeddings[j];
        const key = texts[idx].substring(0, 200);
        const hash = CachedEmbeddingProvider.contentHash(texts[idx]);
        this.cache.set(key, { contentHash: hash, embedding: embeddings[j] });
      }
    }

    return results as number[][];
  }

  dimensions(): number {
    return this.delegate.dimensions();
  }

  cacheSize(): number {
    return this.cache.size;
  }

  invalidate(textPrefix?: string): void {
    if (textPrefix) {
      this.cache.delete(textPrefix.substring(0, 200));
    } else {
      this.cache.clear();
    }
  }

  async shutdown(): Promise<void> {
    this.cache.clear();
    await this.delegate.shutdown();
  }
}
