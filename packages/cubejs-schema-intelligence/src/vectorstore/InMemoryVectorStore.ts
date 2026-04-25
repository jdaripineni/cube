/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview In-memory vector store using brute-force nearest neighbor.
 * Zero dependencies — suitable for dev/test and small deployments (<5K vectors).
 */

import type {
  VectorStore,
  VectorRecord,
  VectorSearchResult,
  SearchOptions,
  DistanceMetricType,
  VectorStoreConfig,
} from '../types';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function manhattanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum;
}

type SimilarityFn = (a: number[], b: number[]) => number;

function getSimilarityFn(metric: DistanceMetricType): SimilarityFn {
  switch (metric) {
    case 'cosine':
      return cosineSimilarity;
    case 'dot_product':
      return dotProduct;
    case 'euclidean':
      return (a, b) => 1 / (1 + euclideanDistance(a, b));
    case 'manhattan':
      return (a, b) => 1 / (1 + manhattanDistance(a, b));
    default:
      return cosineSimilarity;
  }
}

/**
 * In-memory vector store using brute-force k-nearest-neighbor search.
 * Best for development, testing, and small deployments (<5K vectors).
 * Data is lost on restart — use {@link PgVectorStore} for persistence.
 *
 * @example
 * ```ts
 * const store = new InMemoryVectorStore(); // cosine similarity by default
 * await store.initialize();
 * await store.upsert([{ id: 'Orders', embedding: [...], metadata: { ... } }]);
 * const results = await store.search(queryVector, { topK: 5 });
 * ```
 */
export class InMemoryVectorStore implements VectorStore {
  private records: Map<string, VectorRecord> = new Map();
  private similarityFn: SimilarityFn;

  /**
   * @param config - Optional store configuration.
   *   `config.distanceMetric` defaults to `'cosine'`. Also supports `'euclidean'`, `'dot_product'`, `'manhattan'`.
   */
  constructor(config?: VectorStoreConfig) {
    this.similarityFn = getSimilarityFn(config?.distanceMetric || 'cosine');
  }

  /** No-op for in-memory store. */
  async initialize(): Promise<void> {
  }

  /** Insert or update records. Existing records with the same `id` are overwritten. */
  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  /** Find the `topK` most similar vectors. Optionally filter by `scoreThreshold`. */
  async search(queryEmbedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    const scored: VectorSearchResult[] = [];

    for (const record of this.records.values()) {
      if (opts.scoreThreshold !== undefined && record.metadata.score < opts.scoreThreshold) {
        continue;
      }
      const similarity = this.similarityFn(queryEmbedding, record.embedding);
      scored.push({ ...record, similarity });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, opts.topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.records.delete(id);
    }
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    this.records.clear();
  }
}
