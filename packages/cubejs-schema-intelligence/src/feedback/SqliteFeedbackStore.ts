/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview SQLite-backed feedback store (default, zero-config).
 */

import type {
  FeedbackStore,
  FeedbackEntry,
  FeedbackStats,
  ExampleQueryOptions,
  NegativePattern,
  CubeQuery,
  FeedbackConfig,
} from '../types';

/**
 * SQLite-backed feedback store for tracking NLQ translation quality.
 * Stores every translation attempt and user feedback (positive/negative/corrected).
 * Positive examples are reused as few-shot prompts for future translations.
 *
 * Requires `better-sqlite3` as a peer dependency:
 * ```bash
 * npm install better-sqlite3
 * ```
 *
 * @example In-memory (default, for dev/test):
 * ```ts
 * const store = new SqliteFeedbackStore();
 * await store.initialize();
 * ```
 *
 * @example Persistent file:
 * ```ts
 * const store = new SqliteFeedbackStore({
 *   enabled: true,
 *   connectionOptions: { path: '/data/cube-feedback.db' },
 * });
 * await store.initialize();
 * ```
 */
export class SqliteFeedbackStore implements FeedbackStore {
  private db: any;
  private config: FeedbackConfig;

  // Late-bound: loaded dynamically in initialize()
  private BetterSqlite3: any;

  constructor(config?: FeedbackConfig) {
    this.config = config || {};
    this.db = null;
  }

  /**
   * Open the SQLite database and create the `feedback` table + indexes if not present.
   * @throws Error if `better-sqlite3` is not installed.
   */
  async initialize(): Promise<void> {
    try {
      this.BetterSqlite3 = (await import('better-sqlite3')).default;
    } catch {
      throw new Error('SQLite feedback store requires better-sqlite3. Install it: npm install better-sqlite3');
    }

    const dbPath = this.config.connectionOptions?.path || ':memory:';
    this.db = new this.BetterSqlite3(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        translation_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        nlq TEXT NOT NULL,
        generated_query TEXT,
        schemas_used TEXT,
        rating TEXT NOT NULL DEFAULT 'pending',
        corrected_query TEXT,
        execution_success INTEGER,
        execution_error TEXT,
        user_id TEXT,
        latency_ms INTEGER,
        retry_count INTEGER DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
      CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON feedback(timestamp);
    `);
  }

  /** Save a translation attempt (generated query, schemas used, latency, etc.). */
  async save(entry: FeedbackEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO feedback
        (translation_id, timestamp, nlq, generated_query, schemas_used, rating,
         corrected_query, execution_success, execution_error, user_id, latency_ms, retry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.translationId,
      entry.timestamp.toISOString(),
      entry.nlq,
      entry.generatedQuery ? JSON.stringify(entry.generatedQuery) : null,
      JSON.stringify(entry.schemasUsed),
      entry.rating,
      entry.correctedQuery ? JSON.stringify(entry.correctedQuery) : null,
      entry.executionSuccess === undefined ? null : (entry.executionSuccess ? 1 : 0),
      entry.executionError || null,
      entry.userId || null,
      entry.latencyMs,
      entry.retryCount,
    );
  }

  /** Update the rating for a previously saved translation. Optionally attach a corrected query. */
  async submitFeedback(translationId: string, rating: 'positive' | 'negative' | 'corrected', correctedQuery?: CubeQuery): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE feedback SET rating = ?, corrected_query = ? WHERE translation_id = ?
    `);
    stmt.run(rating, correctedQuery ? JSON.stringify(correctedQuery) : null, translationId);
  }

  /** Retrieve recent positively-rated translations for use as few-shot examples. */
  async getPositiveExamples(opts: ExampleQueryOptions): Promise<FeedbackEntry[]> {
    const limit = opts.topK || 5;
    const minRating = opts.minRating || 'positive';

    const ratings = minRating === 'corrected' ? "'corrected'" : "'positive', 'corrected'";
    const rows = this.db.prepare(`
      SELECT * FROM feedback
      WHERE rating IN (${ratings}) AND generated_query IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);

    return rows.map((r: any) => this.rowToEntry(r));
  }

  /** Get recurring error patterns from negative feedback (for LLM "mistakes to avoid" prompts). */
  async getNegativePatterns(): Promise<NegativePattern[]> {
    const rows = this.db.prepare(`
      SELECT execution_error as pattern, COUNT(*) as count, MAX(timestamp) as last_seen
      FROM feedback
      WHERE rating = 'negative' AND execution_error IS NOT NULL
      GROUP BY execution_error
      ORDER BY count DESC
      LIMIT 20
    `).all();

    return rows.map((r: any) => ({
      pattern: r.pattern,
      count: r.count,
      lastSeen: new Date(r.last_seen),
    }));
  }

  /** Compute aggregate statistics: success/failure rates, average latency, retry stats. */
  async getStats(): Promise<FeedbackStats> {
    const total = this.db.prepare('SELECT COUNT(*) as cnt FROM feedback').get().cnt;
    if (total === 0) {
      return {
        totalTranslations: 0,
        positiveRate: 0,
        negativeRate: 0,
        correctedRate: 0,
        selfHealSuccessRate: 0,
        topFailingCubes: [],
        averageLatencyMs: 0,
        averageRetries: 0,
      };
    }

    const positive = this.db.prepare("SELECT COUNT(*) as cnt FROM feedback WHERE rating = 'positive'").get().cnt;
    const negative = this.db.prepare("SELECT COUNT(*) as cnt FROM feedback WHERE rating = 'negative'").get().cnt;
    const corrected = this.db.prepare("SELECT COUNT(*) as cnt FROM feedback WHERE rating = 'corrected'").get().cnt;
    const avgLatency = this.db.prepare('SELECT AVG(latency_ms) as avg_lat FROM feedback').get().avg_lat || 0;
    const avgRetries = this.db.prepare('SELECT AVG(retry_count) as avg_ret FROM feedback').get().avg_ret || 0;

    const retriedSuccess = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM feedback WHERE retry_count > 0 AND generated_query IS NOT NULL AND rating != 'negative'"
    ).get().cnt;
    const retriedTotal = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM feedback WHERE retry_count > 0'
    ).get().cnt;

    return {
      totalTranslations: total,
      positiveRate: positive / total,
      negativeRate: negative / total,
      correctedRate: corrected / total,
      selfHealSuccessRate: retriedTotal > 0 ? retriedSuccess / retriedTotal : 0,
      topFailingCubes: [],
      averageLatencyMs: Math.round(avgLatency),
      averageRetries: Math.round(avgRetries * 100) / 100,
    };
  }

  async shutdown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private rowToEntry(row: any): FeedbackEntry {
    return {
      translationId: row.translation_id,
      timestamp: new Date(row.timestamp),
      nlq: row.nlq,
      generatedQuery: row.generated_query ? JSON.parse(row.generated_query) : null,
      schemasUsed: row.schemas_used ? JSON.parse(row.schemas_used) : [],
      rating: row.rating,
      correctedQuery: row.corrected_query ? JSON.parse(row.corrected_query) : undefined,
      executionSuccess: row.execution_success === null ? undefined : !!row.execution_success,
      executionError: row.execution_error || undefined,
      userId: row.user_id || undefined,
      latencyMs: row.latency_ms,
      retryCount: row.retry_count,
    };
  }
}
