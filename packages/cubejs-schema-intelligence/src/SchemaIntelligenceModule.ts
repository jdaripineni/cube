/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Schema Intelligence Module — main orchestrator.
 * Feature-gated: does nothing when disabled. Lazily loads all dependencies.
 */

import type {
  SchemaIntelligenceOptions,
  CubeMetaConfig,
  EmbeddingProvider,
  VectorStore,
  ScoringStrategy,
  SchemaSerializer,
  LLMProvider,
  FeedbackStore,
  ScoreResult,
  TranslationResult,
  TranslationContext,
  VectorSearchResult,
  FeedbackStats,
  CubeQuery,
} from './types';
import { MetricsCollector } from './metrics/MetricsCollector';

/**
 * SchemaIntelligenceModule is the single entry point. When `enabled: false`
 * (or schemaIntelligence not configured), all methods are no-ops and no
 * dependencies are loaded — zero overhead, zero bloat.
 */
export class SchemaIntelligenceModule {
  private enabled: boolean;
  private options: SchemaIntelligenceOptions;
  private initialized = false;

  // Lazy-loaded components (null when disabled)
  private scorer: ScoringStrategy | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private vectorStore: VectorStore | null = null;
  private serializer: SchemaSerializer | null = null;
  private llmProvider: LLMProvider | null = null;
  private feedbackStore: FeedbackStore | null = null;
  private translator: any | null = null; // DefaultTranslator
  private metrics: MetricsCollector;

  private lastCompilerId: string | null = null;
  private compiledMeta: CubeMetaConfig[] = [];

  constructor(options?: SchemaIntelligenceOptions | boolean) {
    if (typeof options === 'boolean') {
      this.enabled = options;
      this.options = { enabled: options };
    } else if (options) {
      this.enabled = options.enabled !== false;
      this.options = options;
    } else {
      this.enabled = false;
      this.options = { enabled: false };
    }

    this.metrics = new MetricsCollector();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getMetrics(): MetricsCollector {
    return this.metrics;
  }

  /**
   * Lazy initialization — only called on first use, not at server startup.
   * This ensures zero overhead when the feature is disabled.
   */
  async initialize(): Promise<void> {
    if (!this.enabled || this.initialized) return;

    // Dynamically import to avoid loading when disabled
    const { RuleBasedScorer } = await import('./scoring/RuleBasedScorer');
    this.scorer = new RuleBasedScorer(this.options.scoring);

    // Embedding provider
    this.embeddingProvider = await this.createEmbeddingProvider();

    // Wrap with cache
    const { CachedEmbeddingProvider } = await import('./embedding/CachedEmbeddingProvider');
    this.embeddingProvider = new CachedEmbeddingProvider(this.embeddingProvider);

    // Vector store
    this.vectorStore = await this.createVectorStore();
    await this.vectorStore.initialize();

    // Serializer
    const { CompactSerializer } = await import('./serialization/SchemaSerializers');
    this.serializer = new CompactSerializer();

    // Feedback store (optional)
    if (this.options.feedback?.enabled !== false) {
      this.feedbackStore = await this.createFeedbackStore();
      await this.feedbackStore.initialize();
    }

    // LLM + Translator (optional)
    if (this.options.translator?.enabled !== false) {
      const { resolveLLMProvider } = await import('./llm/LLMProviders');
      this.llmProvider = await resolveLLMProvider(this.options.translator);
    }

    this.initialized = true;
  }

  /**
   * Called when schema compilation produces new metadata.
   * Triggers re-indexing if compilerId has changed.
   */
  async onSchemaCompiled(cubes: CubeMetaConfig[], compilerId: string): Promise<void> {
    if (!this.enabled) return;

    if (this.lastCompilerId === compilerId) return;
    this.lastCompilerId = compilerId;
    this.compiledMeta = cubes;

    if (this.options.reindexOnSchemaChange !== false) {
      await this.reindex(cubes);
    }
  }

  /**
   * Score + embed + upsert all cubes into the vector store.
   */
  async reindex(cubes?: CubeMetaConfig[]): Promise<void> {
    if (!this.enabled) return;
    await this.initialize();

    const cubesToIndex = cubes || this.compiledMeta;
    if (cubesToIndex.length === 0) return;

    const batchSize = this.options.indexingBatchSize || 50;
    let consumableCount = 0;

    for (let i = 0; i < cubesToIndex.length; i += batchSize) {
      const batch = cubesToIndex.slice(i, i + batchSize);

      // Score
      const scores = batch.map(c => this.scorer!.score(c));

      // Serialize for embedding
      const texts = batch.map(c => this.serializer!.serialize([c]));

      // Embed
      const embeddings = await this.embeddingProvider!.embed(texts);
      this.metrics.embeddingApiCalls += texts.length;

      // Build records
      const records = batch.map((cube, j) => ({
        id: cube.name,
        embedding: embeddings[j],
        metadata: {
          cubeName: cube.name,
          metaJson: cube as any,
          score: scores[j].overall,
          scoreDimensions: scores[j].dimensions,
          lastUpdated: new Date().toISOString(),
        },
      }));

      await this.vectorStore!.upsert(records);
      consumableCount += scores.filter(s => s.consumable).length;
    }

    this.metrics.recordIndex(cubesToIndex.length, consumableCount);

    // Update translator meta if available
    if (this.translator) {
      this.translator.updateMeta(cubesToIndex);
    }
  }

  // ── Public API Methods ──

  async search(query: string, topK = 10, scoreThreshold?: number): Promise<VectorSearchResult[]> {
    if (!this.enabled) return [];
    await this.initialize();

    const startTime = Date.now();
    const [embedding] = await this.embeddingProvider!.embed([query]);
    const results = await this.vectorStore!.search(embedding, { topK, scoreThreshold });
    this.metrics.recordSearch(Date.now() - startTime);

    return results;
  }

  async getScores(cubeName?: string): Promise<ScoreResult[]> {
    if (!this.enabled) return [];
    await this.initialize();

    const cubes = cubeName
      ? this.compiledMeta.filter(c => c.name === cubeName)
      : this.compiledMeta;

    return cubes.map(c => this.scorer!.score(c));
  }

  async translate(nlq: string, context?: TranslationContext): Promise<TranslationResult> {
    if (!this.enabled || !this.llmProvider) {
      return {
        query: null,
        confidence: 0,
        schemasUsed: [],
        translationId: '',
        validationErrors: ['Schema Intelligence or NLQ translator not enabled'],
        retryCount: 0,
      };
    }

    await this.initialize();

    if (!this.translator) {
      const { DefaultTranslator } = await import('./translator/DefaultTranslator');
      this.translator = new DefaultTranslator({
        llmProvider: this.llmProvider,
        embeddingProvider: this.embeddingProvider!,
        vectorStore: this.vectorStore!,
        feedbackStore: this.feedbackStore,
        serializer: this.serializer!,
        compiledMeta: this.compiledMeta,
      });
    }

    const result = await this.translator.translate(nlq, context);
    this.metrics.recordTranslation(result.query !== null);
    this.metrics.llmApiCalls++;

    return result;
  }

  async submitFeedback(translationId: string, rating: 'positive' | 'negative' | 'corrected', correctedQuery?: CubeQuery): Promise<void> {
    if (!this.enabled || !this.feedbackStore) return;
    await this.feedbackStore.submitFeedback(translationId, rating, correctedQuery);
    this.metrics.recordFeedback(rating);
  }

  async getFeedbackStats(): Promise<FeedbackStats | null> {
    if (!this.enabled || !this.feedbackStore) return null;
    return this.feedbackStore.getStats();
  }

  async getStatus(): Promise<Record<string, any>> {
    if (!this.enabled) {
      return { enabled: false };
    }

    const count = this.vectorStore ? await this.vectorStore.count() : 0;
    const healthy = this.vectorStore ? await this.vectorStore.healthCheck() : false;

    return {
      enabled: true,
      initialized: this.initialized,
      vectorStoreProvider: this.options.vectorStore?.provider || 'inmemory',
      embeddingProvider: typeof this.options.embeddingLlm === 'string'
        ? this.options.embeddingLlm
        : (this.options.embeddingLlm as any)?.provider || 'local',
      translatorEnabled: !!this.llmProvider,
      feedbackEnabled: !!this.feedbackStore,
      indexedCubes: count,
      vectorStoreHealthy: healthy,
      lastCompilerId: this.lastCompilerId,
      metrics: this.metrics.toJSON(),
    };
  }

  async shutdown(): Promise<void> {
    if (this.vectorStore) await this.vectorStore.shutdown();
    if (this.embeddingProvider) await this.embeddingProvider.shutdown();
    if (this.feedbackStore) await this.feedbackStore.shutdown();
    if (this.llmProvider) await this.llmProvider.shutdown();
  }

  // ── Private Factory Methods ──

  private async createEmbeddingProvider(): Promise<EmbeddingProvider> {
    const config = this.options.embeddingLlm;

    if (!config || config === 'local') {
      const { LocalEmbeddingProvider } = await import('./embedding/LocalEmbeddingProvider');
      return new LocalEmbeddingProvider();
    }

    if (typeof config === 'string') {
      // Predefined embedding model name
      if (config.includes('text-embedding-3') || config.includes('ada')) {
        const apiKey = process.env.CUBEJS_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error(`Embedding model '${config}' requires CUBEJS_EMBEDDING_API_KEY or OPENAI_API_KEY`);
        const { OpenAIEmbeddingProvider } = await import('./embedding/OpenAIEmbeddingProvider');
        return new OpenAIEmbeddingProvider({ provider: 'openai', model: config, apiKey });
      }
      // Try as Ollama model
      const { OllamaEmbeddingProvider } = await import('./embedding/OllamaEmbeddingProvider');
      return new OllamaEmbeddingProvider({ provider: 'ollama', model: config });
    }

    // Object config
    switch (config.provider) {
      case 'openai': {
        const { OpenAIEmbeddingProvider } = await import('./embedding/OpenAIEmbeddingProvider');
        return new OpenAIEmbeddingProvider(config);
      }
      case 'ollama': {
        const { OllamaEmbeddingProvider } = await import('./embedding/OllamaEmbeddingProvider');
        return new OllamaEmbeddingProvider(config);
      }
      case 'local':
      default: {
        const { LocalEmbeddingProvider } = await import('./embedding/LocalEmbeddingProvider');
        return new LocalEmbeddingProvider(config.model);
      }
    }
  }

  private async createVectorStore(): Promise<VectorStore> {
    const config = this.options.vectorStore;

    if (!config || config.provider === 'inmemory') {
      const { InMemoryVectorStore } = await import('./vectorstore/InMemoryVectorStore');
      return new InMemoryVectorStore(config);
    }

    switch (config.provider) {
      case 'pgvector': {
        const { PgVectorStore } = await import('./vectorstore/PgVectorStore');
        return new PgVectorStore(config);
      }
      default: {
        const { InMemoryVectorStore } = await import('./vectorstore/InMemoryVectorStore');
        return new InMemoryVectorStore(config);
      }
    }
  }

  private async createFeedbackStore(): Promise<FeedbackStore> {
    const config = this.options.feedback;

    if (!config || config.provider === 'sqlite' || !config.provider) {
      const { SqliteFeedbackStore } = await import('./feedback/SqliteFeedbackStore');
      const store = new SqliteFeedbackStore(config);
      return store;
    }

    // Default to sqlite
    const { SqliteFeedbackStore } = await import('./feedback/SqliteFeedbackStore');
    return new SqliteFeedbackStore(config);
  }
}
