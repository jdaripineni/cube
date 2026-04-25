/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Public API for `@cubejs-backend/schema-intelligence`.
 *
 * ## Quick Start
 * ```ts
 * import { SchemaIntelligenceModule } from '@cubejs-backend/schema-intelligence';
 *
 * // In cube.js config:
 * module.exports = {
 *   schemaIntelligence: {
 *     scoring: true,
 *     embedding: { provider: 'ollama', endpoint: 'http://ollama:11434' },
 *     translator: { enabled: true },
 *     llm: { provider: 'ollama', model: 'qwen3:0.6b', endpoint: 'http://ollama:11434' },
 *   },
 * };
 * ```
 *
 * ## Custom Implementations
 * All core components implement swappable interfaces:
 * ```ts
 * import type { VectorStore, EmbeddingProvider, LLMProvider } from '@cubejs-backend/schema-intelligence';
 * ```
 */

export { SchemaIntelligenceModule } from './SchemaIntelligenceModule';

// ── Configuration Types ──
export type {
  SchemaIntelligenceOptions,
  EmbeddingConfig,
  LLMConfig,
  TranslatorConfig,
  ScoringConfig,
  ScoringCriterionConfig,
  FeedbackConfig,
  VectorStoreConfig,
  DistanceMetricType,
  SearchConfig,
} from './types';

// ── Result Types ──
export type {
  CubeMetaConfig,
  CubeQuery,
  ScoreResult,
  TranslationResult,
  TranslationContext,
  FeedbackEntry,
  FeedbackStats,
  ValidationResult,
  VectorSearchResult,
  EnrichmentSuggestion,
  IntelligenceMetrics,
} from './types';

// ── Interfaces for Custom Implementations ──
export type {
  VectorStore,
  EmbeddingProvider,
  ScoringStrategy,
  SchemaSerializer,
  LLMProvider,
  FeedbackStore,
  SearchStrategy,
} from './types';

// ── Built-in Components (for advanced users building custom pipelines) ──
export { RuleBasedScorer } from './scoring/RuleBasedScorer';
export { InMemoryVectorStore } from './vectorstore/InMemoryVectorStore';
export { PgVectorStore } from './vectorstore/PgVectorStore';
export { LocalEmbeddingProvider } from './embedding/LocalEmbeddingProvider';
export { OpenAIEmbeddingProvider } from './embedding/OpenAIEmbeddingProvider';
export { OllamaEmbeddingProvider } from './embedding/OllamaEmbeddingProvider';
export { CachedEmbeddingProvider } from './embedding/CachedEmbeddingProvider';
export { CompactSerializer, FullJsonSerializer } from './serialization/SchemaSerializers';
export { QueryValidator } from './validation/QueryValidator';
export { DefaultTranslator } from './translator/DefaultTranslator';
export { PromptBuilder } from './translator/PromptBuilder';
export { SqliteFeedbackStore } from './feedback/SqliteFeedbackStore';
export { OpenAILLMProvider, OllamaLLMProvider, resolveLLMProvider, MODEL_REGISTRY } from './llm/LLMProviders';
export { AgentsConfigLoader } from './config/AgentsConfigLoader';
export { MetricsCollector } from './metrics/MetricsCollector';
