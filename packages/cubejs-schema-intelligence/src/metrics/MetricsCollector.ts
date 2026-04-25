/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Prometheus metrics for schema intelligence.
 */

import type { IntelligenceMetrics } from '../types';

/**
 * Collects Prometheus-compatible metrics for schema intelligence operations.
 * Tracks indexing, search, translation, embedding API calls, and user feedback.
 *
 * Access via `GET /v1/ai/metrics` (text format) or `GET /v1/ai/status` (JSON).
 *
 * @example Prometheus text output:
 * ```
 * cubejs_ai_index_cubes_total 150
 * cubejs_ai_translate_requests_total 42
 * cubejs_ai_translate_success_rate 0.857
 * cubejs_ai_feedback_total{type="positive"} 30
 * ```
 */
export class MetricsCollector implements IntelligenceMetrics {
  indexedCubesTotal = 0;
  indexedCubesConsumable = 0;
  indexLastUpdated: Date | null = null;
  searchRequestsTotal = 0;
  searchLatencyMs: number[] = [];
  translateRequestsTotal = 0;
  translateSuccessRate = 0;
  embeddingApiCalls = 0;
  embeddingCacheHits = 0;
  llmApiCalls = 0;
  llmTokensUsed = 0;
  feedbackPositive = 0;
  feedbackNegative = 0;
  feedbackCorrected = 0;

  private translateSuccessCount = 0;

  /** Record a vector search operation with its latency. */
  recordSearch(latencyMs: number): void {
    this.searchRequestsTotal++;
    this.searchLatencyMs.push(latencyMs);
    if (this.searchLatencyMs.length > 1000) {
      this.searchLatencyMs = this.searchLatencyMs.slice(-1000);
    }
  }

  /** Record a translation attempt (success or failure). Updates success rate. */
  recordTranslation(success: boolean): void {
    this.translateRequestsTotal++;
    if (success) this.translateSuccessCount++;
    this.translateSuccessRate = this.translateRequestsTotal > 0
      ? this.translateSuccessCount / this.translateRequestsTotal
      : 0;
  }

  /** Record a reindex operation with total cubes and consumable count. */
  recordIndex(total: number, consumable: number): void {
    this.indexedCubesTotal = total;
    this.indexedCubesConsumable = consumable;
    this.indexLastUpdated = new Date();
  }

  /** Record user feedback by type. */
  recordFeedback(rating: 'positive' | 'negative' | 'corrected'): void {
    switch (rating) {
      case 'positive': this.feedbackPositive++; break;
      case 'negative': this.feedbackNegative++; break;
      case 'corrected': this.feedbackCorrected++; break;
    }
  }

  /** Export metrics in Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    const ts = Date.now();

    lines.push(`# HELP cubejs_ai_index_cubes_total Total indexed cubes`);
    lines.push(`# TYPE cubejs_ai_index_cubes_total gauge`);
    lines.push(`cubejs_ai_index_cubes_total ${this.indexedCubesTotal} ${ts}`);

    lines.push(`# HELP cubejs_ai_index_cubes_consumable Cubes scoring above threshold`);
    lines.push(`# TYPE cubejs_ai_index_cubes_consumable gauge`);
    lines.push(`cubejs_ai_index_cubes_consumable ${this.indexedCubesConsumable} ${ts}`);

    lines.push(`# HELP cubejs_ai_search_requests_total Total vector search requests`);
    lines.push(`# TYPE cubejs_ai_search_requests_total counter`);
    lines.push(`cubejs_ai_search_requests_total ${this.searchRequestsTotal} ${ts}`);

    lines.push(`# HELP cubejs_ai_translate_requests_total Total NLQ translation requests`);
    lines.push(`# TYPE cubejs_ai_translate_requests_total counter`);
    lines.push(`cubejs_ai_translate_requests_total ${this.translateRequestsTotal} ${ts}`);

    lines.push(`# HELP cubejs_ai_translate_success_rate Translation success rate`);
    lines.push(`# TYPE cubejs_ai_translate_success_rate gauge`);
    lines.push(`cubejs_ai_translate_success_rate ${this.translateSuccessRate} ${ts}`);

    lines.push(`# HELP cubejs_ai_feedback_total Feedback entries by type`);
    lines.push(`# TYPE cubejs_ai_feedback_total counter`);
    lines.push(`cubejs_ai_feedback_total{type="positive"} ${this.feedbackPositive} ${ts}`);
    lines.push(`cubejs_ai_feedback_total{type="negative"} ${this.feedbackNegative} ${ts}`);
    lines.push(`cubejs_ai_feedback_total{type="corrected"} ${this.feedbackCorrected} ${ts}`);

    if (this.searchLatencyMs.length > 0) {
      const avg = this.searchLatencyMs.reduce((a, b) => a + b, 0) / this.searchLatencyMs.length;
      lines.push(`# HELP cubejs_ai_search_latency_avg_ms Average search latency`);
      lines.push(`# TYPE cubejs_ai_search_latency_avg_ms gauge`);
      lines.push(`cubejs_ai_search_latency_avg_ms ${Math.round(avg)} ${ts}`);
    }

    return lines.join('\n') + '\n';
  }

  /** Export metrics as a JSON object (used by `/v1/ai/status`). */
  toJSON(): Record<string, any> {
    return {
      indexedCubesTotal: this.indexedCubesTotal,
      indexedCubesConsumable: this.indexedCubesConsumable,
      indexLastUpdated: this.indexLastUpdated?.toISOString() || null,
      searchRequestsTotal: this.searchRequestsTotal,
      translateRequestsTotal: this.translateRequestsTotal,
      translateSuccessRate: Math.round(this.translateSuccessRate * 1000) / 1000,
      feedbackPositive: this.feedbackPositive,
      feedbackNegative: this.feedbackNegative,
      feedbackCorrected: this.feedbackCorrected,
    };
  }
}
