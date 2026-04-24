/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Core type definitions for Schema Intelligence.
 */

// ── Distance Metrics ──

export type DistanceMetricType =
  | 'cosine'
  | 'euclidean'
  | 'dot_product'
  | 'manhattan'
  | 'hamming';

// ── Vector Store ──

export interface VectorStoreConfig {
  provider: string;
  connectionOptions?: Record<string, any>;
  distanceMetric?: DistanceMetricType;
  indexType?: 'hnsw' | 'ivfflat' | 'flat';
  indexOptions?: Record<string, number>;
}

export interface VectorRecord {
  id: string;
  embedding: number[];
  metadata: VectorRecordMetadata;
}

export interface VectorRecordMetadata {
  cubeName: string;
  metaJson: Record<string, any>;
  score: number;
  scoreDimensions: Record<string, number>;
  lastUpdated: string;
}

export interface VectorSearchResult extends VectorRecord {
  similarity: number;
}

export interface SearchOptions {
  topK: number;
  scoreThreshold?: number;
  filter?: Record<string, any>;
}

export interface VectorStore {
  initialize(): Promise<void>;
  upsert(records: VectorRecord[]): Promise<void>;
  search(queryEmbedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
  delete(ids: string[]): Promise<void>;
  count(): Promise<number>;
  healthCheck(): Promise<boolean>;
  shutdown(): Promise<void>;
}

// ── Embedding ──

export interface EmbeddingConfig {
  provider: string;
  model?: string;
  dimensions?: number;
  endpoint?: string;
  apiKey?: string;
  batchSize?: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  shutdown(): Promise<void>;
}

// ── Scoring ──

export interface ScoringCriterionConfig {
  name: string;
  weight: number;
}

export interface ScoringCriterion {
  name: string;
  weight: number;
  evaluate(cube: CubeMetaConfig): number;
}

export interface ScoreResult {
  cubeName: string;
  overall: number;
  dimensions: Record<string, number>;
  consumable: boolean;
  suggestions: EnrichmentSuggestion[];
}

export interface EnrichmentSuggestion {
  cubeName: string;
  member?: string;
  issue: EnrichmentIssue;
  severity: 'error' | 'warning' | 'info';
  suggestion: string;
}

export type EnrichmentIssue =
  | 'missing_description'
  | 'vague_description'
  | 'missing_enum_values'
  | 'missing_type'
  | 'no_datasource'
  | 'no_tenant_isolation'
  | 'missing_join_description';

export interface ScoringStrategy {
  score(cube: CubeMetaConfig): ScoreResult;
}

export interface ScoringConfig {
  threshold?: number;
  criteria?: ScoringCriterionConfig[];
}

// ── Serialization ──

export interface SerializeOptions {
  format: 'compact' | 'full' | 'yaml';
  maxTokens?: number;
  includeJoins?: boolean;
  includePreAggs?: boolean;
  includeSql?: boolean;
}

export interface SchemaSerializer {
  serialize(cubes: CubeMetaConfig[], options?: Partial<SerializeOptions>): string;
}

// ── LLM ──

export interface LLMConfig {
  provider: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface LLMProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  completeStructured<T = any>(prompt: string, jsonSchema: Record<string, any>, options?: CompletionOptions): Promise<T>;
  shutdown(): Promise<void>;
}

// ── Translator ──

export interface TranslatorConfig {
  enabled?: boolean;
  llm?: string | LLMConfig;
  runtime?: 'plain' | 'reasoning';
  maxRetries?: number;
  promptTemplate?: string;
}

export interface TranslationContext {
  securityContext?: any;
  conversationHistory?: ConversationMessage[];
  maxRetries?: number;
  maxTokens?: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TranslationResult {
  query: CubeQuery | null;
  explanation?: string;
  confidence: number;
  schemasUsed: string[];
  translationId: string;
  validationErrors?: string[];
  retryCount: number;
}

// ── Feedback ──

export interface FeedbackConfig {
  enabled?: boolean;
  provider?: string;
  connectionOptions?: Record<string, any>;
  memoryMode?: 'space' | 'user' | 'disabled';
  exportAsCertifiedQueries?: boolean;
}

export interface FeedbackEntry {
  translationId: string;
  timestamp: Date;
  nlq: string;
  generatedQuery: CubeQuery | null;
  schemasUsed: string[];
  rating: 'positive' | 'negative' | 'corrected' | 'pending';
  correctedQuery?: CubeQuery;
  executionSuccess?: boolean;
  executionError?: string;
  userId?: string;
  latencyMs: number;
  retryCount: number;
}

export interface FeedbackStore {
  initialize(): Promise<void>;
  save(entry: FeedbackEntry): Promise<void>;
  submitFeedback(translationId: string, rating: 'positive' | 'negative' | 'corrected', correctedQuery?: CubeQuery): Promise<void>;
  getPositiveExamples(opts: ExampleQueryOptions): Promise<FeedbackEntry[]>;
  getNegativePatterns(): Promise<NegativePattern[]>;
  getStats(): Promise<FeedbackStats>;
  shutdown(): Promise<void>;
}

export interface ExampleQueryOptions {
  similarTo?: number[];
  topK?: number;
  minRating?: 'positive' | 'corrected';
  diverseCubes?: boolean;
}

export interface NegativePattern {
  pattern: string;
  count: number;
  lastSeen: Date;
}

export interface FeedbackStats {
  totalTranslations: number;
  positiveRate: number;
  negativeRate: number;
  correctedRate: number;
  selfHealSuccessRate: number;
  topFailingCubes: Array<{ cube: string; failureRate: number }>;
  averageLatencyMs: number;
  averageRetries: number;
}

// ── Query Validation ──

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  suggestions: string[];
}

export interface ValidationError {
  type: 'unknown_member' | 'invalid_filter' | 'invalid_time_dimension' | 'missing_required' | 'type_mismatch';
  message: string;
  member?: string;
}

// ── Cube Meta Types ──

export interface CubeMemberMeta {
  name: string;
  title?: string;
  type: string;
  description?: string;
  meta?: Record<string, any>;
  isVisible?: boolean;
  public?: boolean;
}

export interface CubeMeasureMeta extends CubeMemberMeta {
  aggType?: string;
  drillMembers?: string[];
  format?: string;
}

export interface CubeDimensionMeta extends CubeMemberMeta {
  primaryKey?: boolean;
}

export interface CubeJoinMeta {
  name: string;
  relationship: string;
  sql?: string;
}

export interface CubeMetaConfig {
  name: string;
  title?: string;
  description?: string;
  measures?: CubeMeasureMeta[];
  dimensions?: CubeDimensionMeta[];
  segments?: CubeMemberMeta[];
  joins?: CubeJoinMeta[];
}

export interface CubeQuery {
  measures?: string[];
  dimensions?: string[];
  filters?: CubeQueryFilter[];
  timeDimensions?: CubeQueryTimeDimension[];
  segments?: string[];
  order?: Record<string, 'asc' | 'desc'>;
  limit?: number;
  offset?: number;
}

export interface CubeQueryFilter {
  member?: string;
  operator?: string;
  values?: string[];
  and?: CubeQueryFilter[];
  or?: CubeQueryFilter[];
}

export interface CubeQueryTimeDimension {
  dimension: string;
  dateRange?: string | string[];
  granularity?: string;
}

// ── Top-Level Config ──

export interface SchemaIntelligenceOptions {
  enabled?: boolean;
  vectorStore?: VectorStoreConfig;
  embeddingLlm?: string | EmbeddingConfig;
  scoring?: ScoringConfig;
  translator?: TranslatorConfig;
  feedback?: FeedbackConfig;
  accessibleViews?: string[];
  reindexOnSchemaChange?: boolean;
  indexingBatchSize?: number;
}

// ── Metrics ──

export interface IntelligenceMetrics {
  indexedCubesTotal: number;
  indexedCubesConsumable: number;
  indexLastUpdated: Date | null;
  searchRequestsTotal: number;
  searchLatencyMs: number[];
  translateRequestsTotal: number;
  translateSuccessRate: number;
  embeddingApiCalls: number;
  embeddingCacheHits: number;
  llmApiCalls: number;
  llmTokensUsed: number;
  feedbackPositive: number;
  feedbackNegative: number;
  feedbackCorrected: number;
}
