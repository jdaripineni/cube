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
  FeedbackQueryOptions,
  FeedbackQueryResult,
  CubeQuery,
  SearchStrategy,
  SearchConfig,
  SearchRanker,
  SearchRankerWeights,
} from './types';
import { MetricsCollector } from './metrics/MetricsCollector';
import { ConversationManager } from './conversation/ConversationManager';
import type { ConversationStore } from './types';

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
  private conversationManager: ConversationManager | null = null;
  private searchRanker: SearchRanker | null = null;
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

  /** Get the conversation manager (lazy-initialized with the configured store). */
  async getConversationManager(): Promise<ConversationManager> {
    if (!this.conversationManager) {
      const store = await this.resolveConversationStore();
      this.conversationManager = new ConversationManager(store, this.options.conversation);
    }
    return this.conversationManager;
  }

  private async resolveConversationStore(): Promise<ConversationStore> {
    const provider = this.options.conversation?.provider || 'memory';
    switch (provider) {
      case 'redis': {
        const { RedisConversationStore } = await import('./conversation/RedisConversationStore');
        return new RedisConversationStore(this.options.conversation);
      }
      case 'memory':
      default: {
        const { InMemoryConversationStore } = await import('./conversation/InMemoryConversationStore');
        return new InMemoryConversationStore(this.options.conversation);
      }
    }
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
      // Resolve from top-level llm config first, fall back to translator.llm
      const llmSource = this.options.llm
        ? { ...this.options.translator, llm: this.options.llm }
        : this.options.translator;
      this.llmProvider = await resolveLLMProvider(llmSource);
    }

    // Search ranker: custom instance, custom weights, or default.
    this.searchRanker = await this.resolveSearchRanker();

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
    const searchConfig = this.options.search;
    const strategy = searchConfig?.strategy;
    const effectiveTopK = topK ?? searchConfig?.defaultTopK ?? 10;
    const effectiveThreshold = scoreThreshold ?? searchConfig?.defaultScoreThreshold;

    // Step 1: Query transformation (e.g. HyDE, query expansion)
    let textsToEmbed = [query];
    if (strategy?.transformQuery) {
      textsToEmbed = await strategy.transformQuery(query, this.llmProvider || undefined);
    }

    // Step 2: Embed (multiple texts are averaged)
    const embeddings = await this.embeddingProvider!.embed(textsToEmbed);
    const embedding = embeddings.length === 1
      ? embeddings[0]
      : embeddings[0].map((_, i) => embeddings.reduce((sum, e) => sum + e[i], 0) / embeddings.length);

    // Step 3: Over-retrieve when a strategy is set (to give re-ranker more candidates)
    const overFactor = searchConfig?.overRetrieveFactor ?? (strategy ? 2 : 1);
    const retrieveK = Math.ceil(effectiveTopK * overFactor);
    let results = await this.vectorStore!.search(embedding, {
      topK: retrieveK,
      scoreThreshold: effectiveThreshold,
    });

    // Step 4: Multi-signal ranking (similarity, quality, text match, feedback, recency)
    results = await this.rerankResults(results, query);

    // Step 5: Apply diversity factor (MMR-style)
    const diversityFactor = searchConfig?.diversityFactor ?? 1;
    if (diversityFactor < 1 && results.length > 1) {
      results = this.applyMMR(results, embedding, diversityFactor, effectiveTopK);
    }

    // Step 6: Custom re-ranking (pluggable SearchStrategy)
    if (strategy?.rerank) {
      results = await strategy.rerank(results, query);
    }

    // Step 7: Custom filtering
    if (strategy?.filter) {
      results = results.filter(r => strategy.filter!(r, query));
    }

    // Step 8: Trim to requested topK
    results = results.slice(0, effectiveTopK);

    this.metrics.recordSearch(Date.now() - startTime);
    return results;
  }

  /**
   * Maximal Marginal Relevance: balance relevance (similarity to query) with
   * diversity (dissimilarity to already-selected results).
   */
  private applyMMR(
    results: VectorSearchResult[],
    queryEmbedding: number[],
    lambda: number,
    k: number,
  ): VectorSearchResult[] {
    const selected: VectorSearchResult[] = [];
    const remaining = [...results];

    while (selected.length < k && remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const relevance = remaining[i].similarity;
        let maxSimilarityToSelected = 0;
        for (const sel of selected) {
          const sim = this.cosineSim(remaining[i].embedding, sel.embedding);
          if (sim > maxSimilarityToSelected) maxSimilarityToSelected = sim;
        }
        const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarityToSelected;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = i;
        }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected;
  }

  private cosineSim(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Return the number of vectors currently stored (0 = not yet indexed). */
  async getVectorCount(): Promise<number> {
    if (!this.enabled || !this.vectorStore) return 0;
    await this.initialize();
    return this.vectorStore.count();
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
        searchConfig: this.options.search,
        searchRanker: this.searchRanker || undefined,
      });
    }

    const result = await this.translator.translate(nlq, context);
    this.metrics.recordTranslation(result.query !== null);
    this.metrics.llmApiCalls++;

    return result;
  }

  async submitFeedback(translationId: string, rating: 'positive' | 'negative' | 'corrected', correctedQuery?: CubeQuery): Promise<void> {
    if (!this.enabled) return;
    await this.initialize();
    if (!this.feedbackStore) return;
    await this.feedbackStore.submitFeedback(translationId, rating, correctedQuery);
    this.metrics.recordFeedback(rating);
  }

  async getFeedbackStats(): Promise<FeedbackStats | null> {
    if (!this.enabled) return null;
    await this.initialize();
    if (!this.feedbackStore) return null;
    return this.feedbackStore.getStats();
  }

  async getFeedbackEntries(opts: FeedbackQueryOptions): Promise<FeedbackQueryResult | null> {
    if (!this.enabled) return null;
    await this.initialize();
    if (!this.feedbackStore) return null;
    return this.feedbackStore.queryFeedback(opts);
  }

  async getStatus(): Promise<Record<string, any>> {
    if (!this.enabled) {
      return { enabled: false };
    }
    await this.initialize();

    const count = this.vectorStore ? await this.vectorStore.count() : 0;
    const healthy = this.vectorStore ? await this.vectorStore.healthCheck() : false;

    return {
      enabled: true,
      initialized: this.initialized,
      vectorStoreProvider: this.options.vectorStore?.provider || 'inmemory',
      embeddingProvider: typeof this.options.embedding === 'string'
        ? this.options.embedding
        : (this.options.embedding as any)?.provider || 'local',
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
    const config = this.options.embedding;

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

    // Object config — normalize endpoint URL for the target provider before constructing.
    const { normalizeEndpoint } = await import('./llm/normalizeEndpoint');
    const normalized = { ...config };
    if (normalized.endpoint) {
      const providerType = normalized.provider === 'ollama' ? 'ollama-embedding' as const : 'openai-embedding' as const;
      normalized.endpoint = normalizeEndpoint(normalized.endpoint, providerType);
    }

    switch (config.provider) {
      case 'openai': {
        const { OpenAIEmbeddingProvider } = await import('./embedding/OpenAIEmbeddingProvider');
        return new OpenAIEmbeddingProvider(normalized);
      }
      case 'ollama': {
        const { OllamaEmbeddingProvider } = await import('./embedding/OllamaEmbeddingProvider');
        return new OllamaEmbeddingProvider(normalized);
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

  /**
   * Resolve the search ranker from options:
   * - If `searchRanker` is a `SearchRanker` instance (has `rank` method), use it directly.
   * - If it's a `SearchRankerWeights` object, create a `DefaultSearchRanker` with those weights.
   * - Otherwise, create a `DefaultSearchRanker` with defaults.
   */
  private async resolveSearchRanker(): Promise<SearchRanker> {
    const opt = this.options.searchRanker;
    if (opt && typeof (opt as SearchRanker).rank === 'function') {
      return opt as SearchRanker;
    }
    const { DefaultSearchRanker } = await import('./ranking/DefaultSearchRanker');
    if (opt && typeof opt === 'object') {
      return new DefaultSearchRanker(opt as SearchRankerWeights);
    }
    return new DefaultSearchRanker();
  }

  /**
   * Apply the search ranker to reorder vector store results.
   * Computes all ranking signals for each result and re-sorts by final score.
   */
  async rerankResults(results: VectorSearchResult[], query: string): Promise<VectorSearchResult[]> {
    if (!this.searchRanker || results.length === 0) return results;

    const { computeTextMatch, computeRecency } = await import('./ranking/DefaultSearchRanker');

    // Optionally compute per-cube feedback scores from the feedback store.
    let feedbackMap: Map<string, number> | undefined;
    if (this.feedbackStore) {
      feedbackMap = new Map();
      try {
        const stats = await this.feedbackStore.getStats();
        if (stats.topFailingCubes) {
          for (const entry of stats.topFailingCubes) {
            // failureRate 0-1 → feedback score: invert so low failure = high score
            feedbackMap.set(entry.cube, 1 - entry.failureRate);
          }
        }
      } catch {
        // Feedback unavailable — signals.feedbackScore will be undefined
      }
    }

    const ranked = results.map(r => {
      const meta = r.metadata || {} as any;
      const metaJson = meta.metaJson as any;
      const memberNames = [
        ...((metaJson?.measures || []).map((m: any) => m.name).filter(Boolean)),
        ...((metaJson?.dimensions || []).map((d: any) => d.name).filter(Boolean)),
      ];

      const signals = {
        similarity: r.similarity,
        qualityScore: meta.score || 0,
        textMatch: computeTextMatch(query, meta.cubeName, memberNames),
        feedbackScore: meta.cubeName ? feedbackMap?.get(meta.cubeName) : undefined,
        recency: computeRecency(meta.lastUpdated),
      };

      const score = this.searchRanker!.rank(signals);
      return { ...r, similarity: score };
    });

    ranked.sort((a, b) => b.similarity - a.similarity);
    return ranked;
  }
}
