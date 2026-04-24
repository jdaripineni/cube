/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview pgvector-backed vector store for production use.
 */

import type {
  VectorStore,
  VectorRecord,
  VectorSearchResult,
  SearchOptions,
  VectorStoreConfig,
} from '../types';

const OPERATOR_MAP: Record<string, string> = {
  cosine: '<=>',
  euclidean: '<->',
  dot_product: '<#>',
  manhattan: '<+>',
};

const INDEX_OPS_MAP: Record<string, string> = {
  cosine: 'vector_cosine_ops',
  euclidean: 'vector_l2_ops',
  dot_product: 'vector_ip_ops',
  manhattan: 'vector_l1_ops',
};

export class PgVectorStore implements VectorStore {
  private pool: any;
  private config: VectorStoreConfig;
  private tableName = 'cube_schema_embeddings';
  private operator: string;
  private indexOps: string;

  constructor(config: VectorStoreConfig) {
    this.config = config;
    const metric = config.distanceMetric || 'cosine';
    this.operator = OPERATOR_MAP[metric] || '<=>';
    this.indexOps = INDEX_OPS_MAP[metric] || 'vector_cosine_ops';
  }

  async initialize(): Promise<void> {
    let pg: any;
    try {
      pg = await import('pg');
    } catch {
      throw new Error('pgvector store requires pg. Install it: npm install pg');
    }

    const connOpts = this.config.connectionOptions || {};
    this.pool = new pg.default.Pool({
      connectionString: connOpts.connectionString,
      ...connOpts,
      max: connOpts.maxPoolSize || 5,
    });

    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id TEXT PRIMARY KEY,
          embedding vector,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `);

      const indexType = this.config.indexType || 'hnsw';
      const indexOpts = this.config.indexOptions || {};

      if (indexType === 'hnsw') {
        const m = indexOpts.m || 16;
        const efConstruction = indexOpts.efConstruction || 64;
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_${this.tableName}_embedding
          ON ${this.tableName}
          USING hnsw (embedding ${this.indexOps})
          WITH (m = ${m}, ef_construction = ${efConstruction})
        `);
      } else if (indexType === 'ivfflat') {
        const nLists = indexOpts.nLists || 100;
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_${this.tableName}_embedding
          ON ${this.tableName}
          USING ivfflat (embedding ${this.indexOps})
          WITH (lists = ${nLists})
        `);
      }
    } finally {
      client.release();
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const record of records) {
        const vecStr = `[${record.embedding.join(',')}]`;
        await client.query(
          `INSERT INTO ${this.tableName} (id, embedding, metadata, updated_at)
           VALUES ($1, $2::vector, $3, now())
           ON CONFLICT (id) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata,
             updated_at = now()`,
          [record.id, vecStr, JSON.stringify(record.metadata)]
        );
      }
    } finally {
      client.release();
    }
  }

  async search(queryEmbedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    const vecStr = `[${queryEmbedding.join(',')}]`;
    let whereClause = '';
    const params: any[] = [vecStr, opts.topK];

    if (opts.scoreThreshold !== undefined) {
      whereClause = `WHERE (metadata->>'score')::float >= $3`;
      params.push(opts.scoreThreshold);
    }

    const result = await this.pool.query(
      `SELECT id, embedding, metadata,
              1 - (embedding ${this.operator} $1::vector) AS similarity
       FROM ${this.tableName}
       ${whereClause}
       ORDER BY embedding ${this.operator} $1::vector
       LIMIT $2`,
      params
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      embedding: JSON.parse(row.embedding.replace('{', '[').replace('}', ']')),
      metadata: row.metadata,
      similarity: parseFloat(row.similarity),
    }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
      ids
    );
  }

  async count(): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*) as cnt FROM ${this.tableName}`);
    return parseInt(result.rows[0].cnt, 10);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
