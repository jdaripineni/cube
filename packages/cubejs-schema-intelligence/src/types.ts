/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Core type definitions for Schema Intelligence.
 */

// ── Distance Metrics ──

/** Distance metric for vector similarity search. `'cosine'` is the default and works best for normalized embeddings. */
export type DistanceMetricType =
  | 'cosine'
  | 'euclidean'
  | 'dot_product'
  | 'manhattan'
  | 'hamming';

// ── Vector Store ──

/**
 * Configuration for the vector store that holds cube schema embeddings.
 *
 * @example Memory store (default — good for dev/test and <500 schemas):
 * ```js
 * vectorStore: { provider: 'memory' }
 * ```
 *
 * @example pgvector (production — persistent, scalable):
 * ```js
 * vectorStore: {
 *   provider: 'pgvector',
 *   connectionString: 'postgresql://user:pass@host:5432/cubeai',
 *   dimensions: 768,
 * }
 * ```
 */
export interface VectorStoreConfig {
  /** Store backend. `'memory'` (default) or `'pgvector'`. */
  provider: string;
  /** Connection string for pgvector (ignored for memory). */
  connectionString?: string;
  /** Embedding vector dimensionality. Must match the embedding provider's output.
   *  Defaults: local=384, openai=1536, ollama/nomic-embed-text=768. */
  dimensions?: number;
  /** Additional driver-specific connection options. */
  connectionOptions?: Record<string, any>;
  /** Distance metric for similarity search. Default: `'cosine'`. */
  distanceMetric?: DistanceMetricType;
  /** Index type for pgvector. Default: `'hnsw'`. */
  indexType?: 'hnsw' | 'ivfflat' | 'flat';
  /** Index-specific tuning parameters (e.g. `{ m: 16, ef_construction: 200 }`). */
  indexOptions?: Record<string, number>;
}

/** A single vector record stored in the vector store. One per indexed cube. */
export interface VectorRecord {
  /** Unique identifier, typically the cube name (e.g. `'Orders'`). */
  id: string;
  /** The embedding vector produced by the embedding provider. */
  embedding: number[];
  /** Associated metadata stored alongside the vector. */
  metadata: VectorRecordMetadata;
}

/** Metadata stored with each vector record for retrieval and display. */
export interface VectorRecordMetadata {
  /** The cube name this record represents. */
  cubeName: string;
  /** Full cube metadata JSON (measures, dimensions, etc.). */
  metaJson: Record<string, any>;
  /** LLM-readiness score (0–1) from the scoring engine. */
  score: number;
  /** Per-criterion score breakdown (e.g. `{ measure_descriptions: 0.8 }`). */
  scoreDimensions: Record<string, number>;
  /** ISO 8601 timestamp of when this record was last indexed. */
  lastUpdated: string;
}

/** A vector search result — extends {@link VectorRecord} with a similarity score. */
export interface VectorSearchResult extends VectorRecord {
  /** Similarity to the query vector (0–1 for cosine, higher = more similar). */
  similarity: number;
}

/** Options for vector similarity search. */
export interface SearchOptions {
  /** Maximum number of results to return. */
  topK: number;
  /** Minimum LLM-readiness score for a cube to be included. */
  scoreThreshold?: number;
  /** Additional metadata filters (provider-specific). */
  filter?: Record<string, any>;
  /** Pluggable search strategy for query transformation and result re-ranking. */
  strategy?: SearchStrategy;
  /** MMR diversity factor (0–1). `0` = max diversity, `1` = max relevance. Default: `1` (pure similarity). */
  diversityFactor?: number;
  /** Per-result score adjustment based on metadata. Return a multiplier (e.g. `1.2` to boost 20%). */
  boostFn?: (result: VectorSearchResult) => number;
}

// ── Search Strategy ──

/**
 * Pluggable strategy for customizing vector search behavior.
 * Operates above the vector store: transforms queries before embedding and
 * re-ranks results after retrieval. The store itself is a black box.
 *
 * All methods are optional — implement only the hooks you need.
 *
 * @example MMR diversity re-ranker:
 * ```ts
 * const mmrStrategy: SearchStrategy = {
 *   async rerank(results, query) {
 *     return maximalMarginalRelevance(results, query, { lambda: 0.7 });
 *   },
 * };
 * ```
 *
 * @example HyDE (Hypothetical Document Embeddings):
 * ```ts
 * const hydeStrategy: SearchStrategy = {
 *   async transformQuery(query, llm) {
 *     const hypothetical = await llm.complete(
 *       `Generate a cube schema description that would answer: ${query}`
 *     );
 *     return [query, hypothetical]; // embed both, search with averaged vector
 *   },
 * };
 * ```
 */
export interface SearchStrategy {
  /** Transform the raw NLQ query into one or more texts to embed.
   *  Multiple texts are embedded independently and their vectors averaged.
   *  If omitted, the original query is used as-is. */
  transformQuery?(query: string, llm?: LLMProvider): Promise<string[]>;
  /** Re-rank results after initial vector retrieval.
   *  Receives the full result set and the original query text.
   *  Must return results in the desired final order. */
  rerank?(results: VectorSearchResult[], query: string): Promise<VectorSearchResult[]>;
  /** Filter results based on custom business logic.
   *  Called after re-ranking. Return `true` to keep a result. */
  filter?(result: VectorSearchResult, query: string): boolean;
}

/**
 * Configuration for search behavior, set at the top level.
 *
 * @example Enable MMR diversity:
 * ```js
 * search: {
 *   defaultTopK: 10,
 *   defaultScoreThreshold: 0.5,
 *   diversityFactor: 0.7,
 * }
 * ```
 */
export interface SearchConfig {
  /** Default number of results to return. Default: `10`. */
  defaultTopK?: number;
  /** Default minimum LLM-readiness score. Default: `0.5`. */
  defaultScoreThreshold?: number;
  /** Default MMR diversity factor (0–1). `0` = max diversity, `1` = pure similarity. Default: `1`. */
  diversityFactor?: number;
  /** Pluggable search strategy instance (query transformation + re-ranking). */
  strategy?: SearchStrategy;
  /** Over-retrieve factor: fetch `topK * overRetrieveFactor` from the store,
   *  then re-rank/filter down to `topK`. Default: `2` when a strategy is set, `1` otherwise. */
  overRetrieveFactor?: number;
}

/**
 * Interface for vector store implementations.
 * Implement this to add a custom vector database backend (e.g. Weaviate, Pinecone).
 *
 * Built-in implementations: {@link InMemoryVectorStore}, {@link PgVectorStore}.
 */
export interface VectorStore {
  /** Create tables/indexes. Called once during initialization. */
  initialize(): Promise<void>;
  /** Insert or update vector records. */
  upsert(records: VectorRecord[]): Promise<void>;
  /** Find the nearest vectors to `queryEmbedding`. */
  search(queryEmbedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
  /** Delete records by ID. */
  delete(ids: string[]): Promise<void>;
  /** Return the total number of stored vectors. */
  count(): Promise<number>;
  /** Check if the store is healthy and reachable. */
  healthCheck(): Promise<boolean>;
  /** Release resources (connection pools, file handles, etc.). */
  shutdown(): Promise<void>;
}

// ── Embedding ──

/**
 * Configuration for the embedding provider that converts schema text into vectors.
 *
 * @example Local embeddings (default — no external dependencies in Cube Cloud):
 * ```js
 * embedding: { provider: 'local' }
 * ```
 *
 * @example OpenAI embeddings:
 * ```js
 * embedding: {
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY,
 *   model: 'text-embedding-3-small',  // default
 * }
 * ```
 *
 * @example Ollama embeddings (self-hosted):
 * ```js
 * embedding: {
 *   provider: 'ollama',
 *   model: 'nomic-embed-text',           // default
 *   endpoint: 'http://ollama:11434',      // Ollama native API (not /v1)
 * }
 * ```
 */
export interface EmbeddingConfig {
  /** Embedding backend. `'local'` (default), `'openai'`, or `'ollama'`. */
  provider: string;
  /** Model name override. Defaults: local=`all-MiniLM-L6-v2`, openai=`text-embedding-3-small`, ollama=`nomic-embed-text`. */
  model?: string;
  /** Output vector dimensions. Auto-detected from provider defaults if omitted.
   *  local=384, openai=1536, ollama/nomic-embed-text=768. */
  dimensions?: number;
  /** Ollama server URL (native API, **not** `/v1`). Default: `http://localhost:11434`.
   *  The provider calls `{endpoint}/api/embed` internally. */
  endpoint?: string;
  /** API key for OpenAI. Can also be set via `OPENAI_API_KEY` env var. */
  apiKey?: string;
  /** Number of texts to embed per API call. Default: 50. */
  batchSize?: number;
}

/**
 * Interface for embedding providers. Implement this to integrate a custom embedding model.
 *
 * Built-in implementations: {@link LocalEmbeddingProvider}, {@link OpenAIEmbeddingProvider},
 * {@link OllamaEmbeddingProvider}, {@link CachedEmbeddingProvider}.
 */
export interface EmbeddingProvider {
  /** Convert an array of text strings into embedding vectors. */
  embed(texts: string[]): Promise<number[][]>;
  /** Return the dimensionality of the output vectors. */
  dimensions(): number;
  /** Release resources (pipeline handles, caches, etc.). */
  shutdown(): Promise<void>;
}

// ── Scoring ──

/** A named scoring criterion with a weight, used for custom scoring configurations. */
export interface ScoringCriterionConfig {
  /** Criterion name. Must match a built-in: `cube_description`, `measure_descriptions`,
   *  `dimension_descriptions`, `type_coverage`, `enum_values_listed`, `datasource_explicit`, `join_descriptions`. */
  name: string;
  /** Weight (0–1). All weights are normalized to sum to 1. */
  weight: number;
}

/** Internal scoring criterion with its evaluation function. */
export interface ScoringCriterion {
  /** Criterion identifier. */
  name: string;
  /** Normalized weight. */
  weight: number;
  /** Evaluate a single cube, returning a score from 0 (worst) to 1 (best). */
  evaluate(cube: CubeMetaConfig): number;
}

/** Result of scoring a single cube for LLM readiness. */
export interface ScoreResult {
  /** The cube name that was scored. */
  cubeName: string;
  /** Weighted overall score (0–1). */
  overall: number;
  /** Per-criterion score breakdown (e.g. `{ measure_descriptions: 0.9 }`). */
  dimensions: Record<string, number>;
  /** Whether the cube meets the threshold for LLM consumption. */
  consumable: boolean;
  /** Actionable suggestions for improving the score. */
  suggestions: EnrichmentSuggestion[];
}

/** An actionable suggestion for improving a cube's LLM-readiness score. */
export interface EnrichmentSuggestion {
  /** The cube this suggestion applies to. */
  cubeName: string;
  /** Specific member name (measure/dimension) if applicable. */
  member?: string;
  /** Category of the issue. */
  issue: EnrichmentIssue;
  /** Severity level: `'error'` = blocks consumption, `'warning'` = degrades quality, `'info'` = nice to have. */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable suggestion text. */
  suggestion: string;
}

/** Categories of schema quality issues detected by the scoring engine. */
export type EnrichmentIssue =
  | 'missing_description'
  | 'vague_description'
  | 'missing_enum_values'
  | 'missing_type'
  | 'no_datasource'
  | 'no_tenant_isolation'
  | 'missing_join_description';

/** Interface for scoring strategy implementations. See {@link RuleBasedScorer}. */
export interface ScoringStrategy {
  /** Score a single cube's metadata for LLM readiness. */
  score(cube: CubeMetaConfig): ScoreResult;
}

/**
 * Configuration for the LLM-readiness scoring engine.
 *
 * @example Enable with defaults:
 * ```js
 * scoring: true
 * ```
 *
 * @example Custom criteria weights:
 * ```js
 * scoring: {
 *   threshold: 0.6,
 *   criteria: [
 *     { name: 'measure_descriptions', weight: 0.3 },
 *     { name: 'dimension_descriptions', weight: 0.3 },
 *     { name: 'cube_description', weight: 0.2 },
 *     { name: 'type_coverage', weight: 0.2 },
 *   ],
 * }
 * ```
 */
export interface ScoringConfig {
  /** Minimum overall score (0–1) for a cube to be considered "consumable" by the LLM. Default: `0.5`. */
  threshold?: number;
  /** Override default scoring criteria and weights. See README for the full default list. */
  criteria?: ScoringCriterionConfig[];
}

// ── Serialization ──

/** Options controlling how cube schemas are serialized for LLM context. */
export interface SerializeOptions {
  /** Output format. `'compact'` = one-line-per-cube (token efficient), `'full'` = JSON, `'yaml'` = YAML. */
  format: 'compact' | 'full' | 'yaml';
  /** Maximum estimated token count. Output is truncated if exceeded. */
  maxTokens?: number;
  /** Include join information in the output. Default: `true`. */
  includeJoins?: boolean;
  /** Include pre-aggregation info. Default: `false`. */
  includePreAggs?: boolean;
  /** Include SQL definitions. Default: `false` (not recommended for LLM context). */
  includeSql?: boolean;
}

/** Interface for schema serializer implementations. See {@link CompactSerializer}, {@link FullJsonSerializer}. */
export interface SchemaSerializer {
  /** Serialize an array of cube metadata into a text representation for LLM context. */
  serialize(cubes: CubeMetaConfig[], options?: Partial<SerializeOptions>): string;
}

// ── LLM ──

/**
 * Configuration for the LLM provider used by the NLQ translator.
 *
 * @example OpenAI:
 * ```js
 * llm: {
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY,
 *   model: 'gpt-4o-mini',
 * }
 * ```
 *
 * @example Ollama (self-hosted):
 * ```js
 * llm: {
 *   provider: 'ollama',
 *   model: 'qwen3:0.6b',
 *   baseUrl: 'http://ollama:11434/v1',  // OpenAI-compatible endpoint
 * }
 * ```
 */
export interface LLMConfig {
  /** LLM backend. `'openai'` or `'ollama'`. */
  provider: string;
  /** Model name. Default: `'gpt-4o-mini'` (openai), `'llama3'` (ollama). */
  model?: string;
  /** Base URL for OpenAI-compatible APIs (e.g. `http://ollama:11434/v1`). */
  endpoint?: string;
  /** API key for OpenAI. Can also be set via `OPENAI_API_KEY` env var. */
  apiKey?: string;
}

/**
 * Per-request options for LLM completions.
 */
export interface CompletionOptions {
  /** Override the model for this request. */
  model?: string;
  /** Sampling temperature (0–2). Lower = more deterministic. Default: `0`. */
  temperature?: number;
  /** Maximum tokens in the response. */
  maxTokens?: number;
  /** System prompt prepended to every request. */
  systemPrompt?: string;
}

/**
 * Interface for LLM provider implementations.
 * See {@link OpenAILLMProvider}, {@link OllamaLLMProvider}.
 */
export interface LLMProvider {
  /** Generate a text completion from a prompt. */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  /** Generate a structured (JSON) completion matching the given schema. */
  completeStructured<T = any>(prompt: string, jsonSchema: Record<string, any>, options?: CompletionOptions): Promise<T>;
  /** Release resources. */
  shutdown(): Promise<void>;
}

// ── Translator ──

/**
 * Configuration for the NLQ-to-CubeQuery translator.
 *
 * @example Enable with defaults:
 * ```js
 * translator: { enabled: true }
 * ```
 *
 * @example With tuning:
 * ```js
 * translator: {
 *   enabled: true,
 *   maxRetries: 3,           // retry on validation failure
 *   maxContextSchemas: 10,   // top-K schemas in LLM context
 *   fewShotCount: 3,         // number of example pairs from feedback
 * }
 * ```
 */
export interface TranslatorConfig {
  /** Enable NLQ translation. Requires `llm` to also be configured. Default: `false`. */
  enabled?: boolean;
  /** Inline LLM config for the translator (overrides top-level `llm`). Rarely needed. */
  llm?: string | LLMConfig;
  /** Prompt strategy. `'plain'` = single-shot, `'reasoning'` = chain-of-thought. Default: `'plain'`. */
  runtime?: 'plain' | 'reasoning';
  /** Max self-heal retries when the generated query fails validation. Default: `2`. */
  maxRetries?: number;
  /** Custom prompt template. Uses `{schema}`, `{question}`, `{examples}` placeholders. */
  promptTemplate?: string;
}

/** Runtime context passed into a single translation request. */
export interface TranslationContext {
  /** Cube.js security context (row-level security, tenant ID, etc.). Forwarded from the JWT. */
  securityContext?: any;
  /** Previous conversation turns for multi-turn follow-up questions. */
  conversationHistory?: ConversationMessage[];
  /** Override max self-heal retries for this request. */
  maxRetries?: number;
  /** Override max tokens in the LLM response for this request. */
  maxTokens?: number;
}

/** A single message in a multi-turn conversation history. */
export interface ConversationMessage {
  /** Who sent the message. */
  role: 'user' | 'assistant' | 'system';
  /** Message content. */
  content: string;
}

/** Result returned by the translator after converting NLQ → CubeQuery. */
export interface TranslationResult {
  /** The generated Cube query, or `null` if translation failed completely. */
  query: CubeQuery | null;
  /** Plain-English explanation of what the query computes. */
  explanation?: string;
  /** Model-estimated confidence (0–1). */
  confidence: number;
  /** Names of cube schemas included in the LLM context window. */
  schemasUsed: string[];
  /** Unique ID for this translation. Use with the feedback API. */
  translationId: string;
  /** Validation errors from the self-heal loop (empty if query is valid). */
  validationErrors?: string[];
  /** How many retry iterations the self-heal loop performed. */
  retryCount: number;
}

// ── Feedback ──

/**
 * Configuration for the feedback store that tracks translation quality.
 * Positive examples are used as few-shot examples in future translations.
 *
 * @example Enable with defaults (SQLite in /tmp):
 * ```js
 * feedback: { enabled: true }
 * ```
 *
 * @example Custom SQLite path:
 * ```js
 * feedback: {
 *   enabled: true,
 *   dbPath: '/data/cube-feedback.db',
 * }
 * ```
 */
export interface FeedbackConfig {
  /** Enable feedback collection. Default: `true` when schema intelligence is enabled. */
  enabled?: boolean;
  /** Storage backend. Currently only `'sqlite'` is implemented. */
  provider?: string;
  /** Additional connection options for the feedback store. */
  connectionOptions?: Record<string, any>;
  /** How feedback memory is scoped. `'space'` = shared, `'user'` = per-user, `'disabled'` = none. */
  memoryMode?: 'space' | 'user' | 'disabled';
  /** Export highly-rated translations as certified query examples. Default: `false`. */
  exportAsCertifiedQueries?: boolean;
}

/** A single feedback record for a translation. */
export interface FeedbackEntry {
  /** Translation ID this feedback relates to. */
  translationId: string;
  /** When the translation occurred. */
  timestamp: Date;
  /** Original natural-language question. */
  nlq: string;
  /** The query the model generated (may be `null` on failure). */
  generatedQuery: CubeQuery | null;
  /** Cube schemas that were in the LLM context for this translation. */
  schemasUsed: string[];
  /** User-submitted rating, or `'pending'` if not yet rated. */
  rating: 'positive' | 'negative' | 'corrected' | 'pending';
  /** User-supplied corrected query when rating = `'corrected'`. */
  correctedQuery?: CubeQuery;
  /** Whether the generated query executed successfully against Cube. */
  executionSuccess?: boolean;
  /** Error message if execution failed. */
  executionError?: string;
  /** Optional user identifier for per-user memory mode. */
  userId?: string;
  /** End-to-end translation latency in milliseconds. */
  latencyMs: number;
  /** Number of self-heal retries used. */
  retryCount: number;
}

/**
 * Interface for feedback persistence backends.
 * See {@link SqliteFeedbackStore} for the built-in implementation.
 */
export interface FeedbackStore {
  /** Create tables/schema. Called once during initialization. */
  initialize(): Promise<void>;
  /** Persist a new feedback entry (typically called automatically after each translation). */
  save(entry: FeedbackEntry): Promise<void>;
  /** Update a previously saved entry with a user-supplied rating and optional correction. */
  submitFeedback(translationId: string, rating: 'positive' | 'negative' | 'corrected', correctedQuery?: CubeQuery): Promise<void>;
  /** Retrieve highly rated examples for few-shot prompting. */
  getPositiveExamples(opts: ExampleQueryOptions): Promise<FeedbackEntry[]>;
  /** Retrieve recurring failure patterns to inform negative-example prompts. */
  getNegativePatterns(): Promise<NegativePattern[]>;
  /** Aggregate statistics for the `/ai/status` endpoint. */
  getStats(): Promise<FeedbackStats>;
  /** Release resources. */
  shutdown(): Promise<void>;
}

/** Options for retrieving few-shot example queries from the feedback store. */
export interface ExampleQueryOptions {
  /** Embedding vector to rank examples by similarity. If omitted, most recent are returned. */
  similarTo?: number[];
  /** Max number of examples. Default: `3`. */
  topK?: number;
  /** Minimum rating threshold. Default: `'positive'`. */
  minRating?: 'positive' | 'corrected';
  /** Prefer examples covering different cubes for broader context. Default: `true`. */
  diverseCubes?: boolean;
}

/** A recurring failure pattern extracted from negative feedback. */
export interface NegativePattern {
  /** Regex or description of the failing NLQ pattern (e.g. `"ambiguous time reference"`). */
  pattern: string;
  /** Number of times this pattern has been observed. */
  count: number;
  /** Timestamp of the most recent occurrence. */
  lastSeen: Date;
}

/** Aggregate feedback statistics returned by `/ai/status`. */
export interface FeedbackStats {
  /** Total number of translations recorded. */
  totalTranslations: number;
  /** Fraction of translations rated positive (0–1). */
  positiveRate: number;
  /** Fraction rated negative (0–1). */
  negativeRate: number;
  /** Fraction rated corrected (0–1). */
  correctedRate: number;
  /** Fraction of initially-invalid queries fixed by the self-heal loop (0–1). */
  selfHealSuccessRate: number;
  /** Cubes with the highest failure rate, sorted descending. */
  topFailingCubes: Array<{ cube: string; failureRate: number }>;
  /** Mean end-to-end translation latency in milliseconds. */
  averageLatencyMs: number;
  /** Mean number of self-heal retries per translation. */
  averageRetries: number;
}

// ── Query Validation ──

/** Result of validating a generated CubeQuery against the data model. */
export interface ValidationResult {
  /** `true` if the query references only known members with correct types. */
  valid: boolean;
  /** List of validation errors (empty when `valid` is `true`). */
  errors: ValidationError[];
  /** Optional human-readable suggestions for fixing the errors. */
  suggestions: string[];
}

/** A single validation error found in a generated CubeQuery. */
export interface ValidationError {
  /** Error category. */
  type: 'unknown_member' | 'invalid_filter' | 'invalid_time_dimension' | 'missing_required' | 'type_mismatch';
  /** Human-readable error message. */
  message: string;
  /** The offending member name, if applicable. */
  member?: string;
}

// ── Cube Meta Types ──

/** Base metadata for a cube member (measure, dimension, or segment). */
export interface CubeMemberMeta {
  /** Fully qualified member name (e.g. `'Orders.count'`). */
  name: string;
  /** Human-readable display title. */
  title?: string;
  /** Member type (e.g. `'number'`, `'string'`, `'time'`). */
  type: string;
  /** Description from the cube schema — critical for LLM quality. */
  description?: string;
  /** Arbitrary key-value metadata from the cube schema. */
  meta?: Record<string, any>;
  /** Whether this member is visible in the Playground. Deprecated in favor of `public`. */
  isVisible?: boolean;
  /** Whether this member is exposed via the API. Default: `true`. */
  public?: boolean;
}

/** Measure-specific metadata, extending {@link CubeMemberMeta}. */
export interface CubeMeasureMeta extends CubeMemberMeta {
  /** Aggregation type (e.g. `'count'`, `'sum'`, `'avg'`, `'countDistinct'`). */
  aggType?: string;
  /** Members available for drill-down from this measure. */
  drillMembers?: string[];
  /** Display format hint (e.g. `'currency'`, `'percent'`). */
  format?: string;
}

/** Dimension-specific metadata, extending {@link CubeMemberMeta}. */
export interface CubeDimensionMeta extends CubeMemberMeta {
  /** Whether this dimension is the primary key of the cube. */
  primaryKey?: boolean;
}

/** Metadata for a join relationship between cubes. */
export interface CubeJoinMeta {
  /** Target cube name. */
  name: string;
  /** Relationship type: `'belongsTo'`, `'hasMany'`, or `'hasOne'`. */
  relationship: string;
  /** Raw SQL join condition (only included when `includeSql` is `true`). */
  sql?: string;
}

/** Full metadata for a single cube, as returned by the Cube.js Meta API. */
export interface CubeMetaConfig {
  /** Cube name (e.g. `'Orders'`). */
  name: string;
  /** Human-readable title. */
  title?: string;
  /** Description — the single most impactful field for LLM readiness scoring. */
  description?: string;
  /** All measures defined in this cube. */
  measures?: CubeMeasureMeta[];
  /** All dimensions defined in this cube. */
  dimensions?: CubeDimensionMeta[];
  /** All segments defined in this cube. */
  segments?: CubeMemberMeta[];
  /** Join relationships to other cubes. */
  joins?: CubeJoinMeta[];
}

/** A Cube query object (the JSON payload sent to `/cubejs-api/v1/load`). */
export interface CubeQuery {
  /** Measures to aggregate (e.g. `['Orders.count']`). */
  measures?: string[];
  /** Dimensions to group by (e.g. `['Orders.status']`). */
  dimensions?: string[];
  /** Filter conditions. */
  filters?: CubeQueryFilter[];
  /** Time-based grouping and date range filters. */
  timeDimensions?: CubeQueryTimeDimension[];
  /** Segments to apply (pre-defined filter sets). */
  segments?: string[];
  /** Sort order. Keys are member names, values are `'asc'` or `'desc'`. */
  order?: Record<string, 'asc' | 'desc'>;
  /** Maximum rows to return. */
  limit?: number;
  /** Number of rows to skip (pagination). */
  offset?: number;
}

/** A filter condition in a Cube query. Can be nested with `and`/`or`. */
export interface CubeQueryFilter {
  /** The member to filter on (e.g. `'Orders.status'`). */
  member?: string;
  /** Filter operator (e.g. `'equals'`, `'contains'`, `'gt'`, `'inDateRange'`). */
  operator?: string;
  /** Values to compare against. */
  values?: string[];
  /** Logical AND group of sub-filters. */
  and?: CubeQueryFilter[];
  /** Logical OR group of sub-filters. */
  or?: CubeQueryFilter[];
}

/** Time dimension grouping and date range filter. */
export interface CubeQueryTimeDimension {
  /** The time dimension member (e.g. `'Orders.createdAt'`). */
  dimension: string;
  /** Date range: a preset string (`'last 7 days'`) or `[start, end]` ISO pair. */
  dateRange?: string | string[];
  /** Time granularity: `'day'`, `'week'`, `'month'`, `'quarter'`, `'year'`, `'hour'`, etc. */
  granularity?: string;
}

// ── Top-Level Config ──

/**
 * Top-level configuration for the Schema Intelligence module.
 * Pass as `schemaIntelligence` in your `cube.js` config.
 *
 * @example Minimal (scoring only, local embeddings, in-memory vectors):
 * ```js
 * module.exports = { schemaIntelligence: true };
 * ```
 *
 * @example Full self-hosted setup with Ollama:
 * ```js
 * module.exports = {
 *   schemaIntelligence: {
 *     scoring: true,
 *     embedding: {
 *       provider: 'ollama',
 *       endpoint: 'http://ollama:11434',
 *     },
 *     vectorStore: { provider: 'memory' },
 *     translator: { enabled: true },
 *     llm: {
 *       provider: 'ollama',
 *       model: 'qwen3:0.6b',
 *       baseUrl: 'http://ollama:11434/v1',
 *     },
 *     feedback: { enabled: true },
 *     metrics: true,
 *   },
 * };
 * ```
 */
export interface SchemaIntelligenceOptions {
  /** Master switch. Set `false` to disable all AI features (zero overhead). Default: `true` when the object is provided. */
  enabled?: boolean;
  /** Vector store for schema embeddings. See {@link VectorStoreConfig}. */
  vectorStore?: VectorStoreConfig;
  /** Embedding provider config, or a shorthand string (`'local'`, `'openai'`, `'ollama'`, or a model name). See {@link EmbeddingConfig}. */
  embedding?: string | EmbeddingConfig;
  /** Scoring engine config, or `true` for defaults. See {@link ScoringConfig}. */
  scoring?: ScoringConfig;
  /** NLQ translator config. Requires `llm` to be set. See {@link TranslatorConfig}. */
  translator?: TranslatorConfig;
  /** Feedback store config. See {@link FeedbackConfig}. */
  feedback?: FeedbackConfig;
  /** Search behavior config (defaults, diversity, custom strategy). See {@link SearchConfig}. */
  search?: SearchConfig;
  /** Restrict which views/cubes are exposed to the AI endpoints. Default: all cubes. */
  accessibleViews?: string[];
  /** Re-index vectors automatically when the data model is recompiled. Default: `true`. */
  reindexOnSchemaChange?: boolean;
  /** Number of cubes to embed per batch during indexing. Default: `50`. */
  indexingBatchSize?: number;
}

// ── Metrics ──

/** Runtime metrics collected by the {@link MetricsCollector}. Exposed via `/ai/status`. */
export interface IntelligenceMetrics {
  /** Total number of cubes in the vector index. */
  indexedCubesTotal: number;
  /** Number of cubes that passed the LLM-readiness threshold. */
  indexedCubesConsumable: number;
  /** When the index was last rebuilt, or `null` if never indexed. */
  indexLastUpdated: Date | null;
  /** Total `/ai/search` requests since startup. */
  searchRequestsTotal: number;
  /** Search latency samples in milliseconds (ring buffer). */
  searchLatencyMs: number[];
  /** Total `/ai/translate` requests since startup. */
  translateRequestsTotal: number;
  /** Fraction of translations that produced a valid query (0–1). */
  translateSuccessRate: number;
  /** Number of embedding API calls made. */
  embeddingApiCalls: number;
  /** Number of embedding cache hits (avoids API call). */
  embeddingCacheHits: number;
  /** Number of LLM completion API calls made. */
  llmApiCalls: number;
  /** Estimated total LLM tokens consumed. */
  llmTokensUsed: number;
  /** Count of positive feedback entries. */
  feedbackPositive: number;
  /** Count of negative feedback entries. */
  feedbackNegative: number;
  /** Count of corrected feedback entries. */
  feedbackCorrected: number;
}
