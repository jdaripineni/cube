/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Embedding cache — skip re-embedding unchanged schemas.
 */

import crypto from 'crypto';

import type { EmbeddingProvider } from '../types';

/**
 * Transparent caching layer for any {@link EmbeddingProvider}.
 * Avoids re-embedding unchanged schema texts by keying on a SHA-256 content hash.
 * Wraps a delegate provider — identical API, just faster for repeated inputs.
 *
 * Used automatically by {@link SchemaIntelligenceModule} during initialization.
 *
 * @example
 * ```ts
 * const ollama = new OllamaEmbeddingProvider({ provider: 'ollama' });
 * const cached = new CachedEmbeddingProvider(ollama);
 * await cached.embed(['same text']); // hits Ollama
 * await cached.embed(['same text']); // cache hit — no API call
 * ```
 */
export class CachedEmbeddingProvider implements EmbeddingProvider {
  private cache: Map<string, { contentHash: string; embedding: number[] }> = new Map();
  private delegate: EmbeddingProvider;

  constructor(delegate: EmbeddingProvider) {
    this.delegate = delegate;
  }

  /** Compute a truncated SHA-256 hash of the input text for cache keying. */
  static contentHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
  }

  /** Embed texts, returning cached vectors for unchanged inputs and delegating the rest. */
  async embed(texts: string[]): Promise<number[][]> {
    const results: (number[] | undefined)[] = new Array(texts.length);
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

  /** Number of entries currently in the cache. */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Invalidate a specific cache entry (by text prefix) or the entire cache. */
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
