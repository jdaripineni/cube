/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Public API for @cubejs-backend/schema-intelligence.
 */

export { SchemaIntelligenceModule } from './SchemaIntelligenceModule';

// Types
export type {
  SchemaIntelligenceOptions,
  CubeMetaConfig,
  CubeQuery,
  ScoreResult,
  TranslationResult,
  TranslationContext,
  FeedbackEntry,
  FeedbackStats,
  FeedbackConfig,
  ValidationResult,
  VectorSearchResult,
  VectorStoreConfig,
  EmbeddingConfig,
  LLMConfig,
  TranslatorConfig,
  ScoringConfig,
  ScoringCriterionConfig,
  EnrichmentSuggestion,
  DistanceMetricType,
  IntelligenceMetrics,
  // Interfaces for custom implementations
  VectorStore,
  EmbeddingProvider,
  ScoringStrategy,
  SchemaSerializer,
  LLMProvider,
  FeedbackStore,
} from './types';

// Individual components (for advanced users building custom pipelines)
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
