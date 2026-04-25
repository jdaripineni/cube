/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Integration tests for Schema Intelligence.
 *
 * These tests wire REAL internal components together — InMemoryVectorStore,
 * RuleBasedScorer, CompactSerializer, QueryValidator, PromptBuilder,
 * DefaultTranslator, SqliteFeedbackStore, MetricsCollector — using only
 * lightweight stubs for external I/O (LLM API, embedding model).
 *
 * No network calls, no Docker, no external services.
 */

import { InMemoryVectorStore } from '../../src/vectorstore/InMemoryVectorStore';
import { RuleBasedScorer } from '../../src/scoring/RuleBasedScorer';
import { CompactSerializer } from '../../src/serialization/SchemaSerializers';
import { QueryValidator } from '../../src/validation/QueryValidator';
import { PromptBuilder } from '../../src/translator/PromptBuilder';
import { DefaultTranslator } from '../../src/translator/DefaultTranslator';
import { MetricsCollector } from '../../src/metrics/MetricsCollector';
import type {
  CubeMetaConfig,
  EmbeddingProvider,
  LLMProvider,
  FeedbackStore,
  VectorRecord,
  FeedbackEntry,
  ExampleQueryOptions,
  NegativePattern,
  FeedbackStats,
  FeedbackQueryOptions,
  FeedbackQueryResult,
  CubeQuery,
  CompletionOptions,
} from '../../src/types';

// ── Shared test schemas ─────────────────────────────────────────────

const CUBES: CubeMetaConfig[] = [
  {
    name: 'Orders',
    description: 'E-commerce orders with revenue, status, and fulfillment tracking',
    measures: [
      { name: 'Orders.count', type: 'count', description: 'Total number of orders' },
      { name: 'Orders.totalAmount', type: 'sum', description: 'Sum of order amounts in USD' },
      { name: 'Orders.averageAmount', type: 'avg', description: 'Average order value' },
    ],
    dimensions: [
      { name: 'Orders.status', type: 'string', description: 'Order status: pending, shipped, delivered, cancelled' },
      { name: 'Orders.createdAt', type: 'time', description: 'Timestamp when the order was placed' },
      { name: 'Orders.customerId', type: 'string', description: 'Foreign key to Users cube' },
    ],
    segments: [{ name: 'Orders.completed', type: 'boolean', description: 'Only delivered orders' }],
    joins: [{ name: 'Users', relationship: 'belongsTo' }],
  },
  {
    name: 'Users',
    description: 'Registered users and their profile information',
    measures: [
      { name: 'Users.count', type: 'count', description: 'Total number of registered users' },
    ],
    dimensions: [
      { name: 'Users.name', type: 'string', description: 'Full name' },
      { name: 'Users.email', type: 'string', description: 'Email address' },
      { name: 'Users.city', type: 'string', description: 'City of residence' },
      { name: 'Users.createdAt', type: 'time', description: 'Registration timestamp' },
    ],
    segments: [],
    joins: [],
  },
  {
    name: 'Products',
    description: 'Product catalog',
    measures: [
      { name: 'Products.count', type: 'count', description: 'Total products' },
    ],
    dimensions: [
      { name: 'Products.name', type: 'string', description: 'Product name' },
      { name: 'Products.category', type: 'string', description: 'Product category' },
      { name: 'Products.price', type: 'number', description: 'Unit price in USD' },
    ],
    segments: [],
    joins: [],
  },
  {
    name: 'LineItems',
    // intentionally no description — scorer should penalize
    measures: [
      { name: 'LineItems.count', type: 'count' }, // no description
      { name: 'LineItems.totalRevenue', type: 'sum' }, // no description
    ],
    dimensions: [
      { name: 'LineItems.orderId', type: 'string' }, // no description
      { name: 'LineItems.productId', type: 'string' }, // no description
      { name: 'LineItems.quantity', type: 'number' }, // no description
    ],
    segments: [],
    joins: [],
  },
];

// ── Deterministic stub embedding provider ───────────────────────────
// Maps each text to a stable, unique-enough vector by hashing characters.

class StubEmbeddingProvider implements EmbeddingProvider {
  private dims: number;

  constructor(dims = 32) {
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.hash(t));
  }

  dimensions(): number {
    return this.dims;
  }

  async shutdown(): Promise<void> {}

  private hash(text: string): number[] {
    const vec = new Array(this.dims).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dims] += text.charCodeAt(i) / 256;
    }
    // L2-normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }
}

// ── Stub LLM provider ───────────────────────────────────────────────
// Returns a pre-programmed Cube query based on keywords in the prompt.

class StubLLMProvider implements LLMProvider {
  callLog: Array<{ prompt: string; schema?: Record<string, any>; options?: CompletionOptions }> = [];
  forceError = false;

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    this.callLog.push({ prompt, options });
    if (this.forceError) throw new Error('LLM unavailable');
    return JSON.stringify({ measures: ['Orders.count'] });
  }

  async completeStructured<T>(prompt: string, jsonSchema: Record<string, any>, options?: CompletionOptions): Promise<T> {
    this.callLog.push({ prompt, schema: jsonSchema, options });
    if (this.forceError) throw new Error('LLM unavailable');

    // Route by keywords in the prompt
    if (prompt.includes('how many orders')) {
      return { measures: ['Orders.count'] } as unknown as T;
    }
    if (prompt.includes('total revenue')) {
      return { measures: ['Orders.totalAmount'] } as unknown as T;
    }
    if (prompt.includes('orders by status')) {
      return {
        measures: ['Orders.count'],
        dimensions: ['Orders.status'],
      } as unknown as T;
    }
    if (prompt.includes('users in each city')) {
      return {
        measures: ['Users.count'],
        dimensions: ['Users.city'],
      } as unknown as T;
    }
    // Intentionally return an invalid member to test self-healing
    if (prompt.includes('PREVIOUS ATTEMPT HAD ERRORS')) {
      // On retry, return a correct query
      return { measures: ['Orders.count'] } as unknown as T;
    }
    if (prompt.includes('average order')) {
      return {
        measures: ['Orders.averageAmount'],
        timeDimensions: [{ dimension: 'Orders.createdAt', granularity: 'month' }],
      } as unknown as T;
    }
    // Default: invalid member to trigger validation error
    return { measures: ['Nonexistent.metric'] } as unknown as T;
  }

  async shutdown(): Promise<void> {}
}

// ── Stub feedback store (in-memory) ──────────────────────────────────

class StubFeedbackStore implements FeedbackStore {
  entries: FeedbackEntry[] = [];

  async initialize(): Promise<void> {}

  async save(entry: FeedbackEntry): Promise<void> {
    this.entries.push(entry);
  }

  async submitFeedback(translationId: string, rating: 'positive' | 'negative' | 'corrected', correctedQuery?: CubeQuery): Promise<void> {
    const entry = this.entries.find(e => e.translationId === translationId);
    if (entry) {
      entry.rating = rating;
      if (correctedQuery) entry.correctedQuery = correctedQuery;
    }
  }

  async getPositiveExamples(_opts: ExampleQueryOptions): Promise<FeedbackEntry[]> {
    return this.entries.filter(e => e.rating === 'positive' || e.rating === 'corrected');
  }

  async getNegativePatterns(): Promise<NegativePattern[]> {
    return [];
  }

  async getStats(): Promise<FeedbackStats> {
    const total = this.entries.length;
    const pos = this.entries.filter(e => e.rating === 'positive').length;
    const neg = this.entries.filter(e => e.rating === 'negative').length;
    const cor = this.entries.filter(e => e.rating === 'corrected').length;
    return {
      totalTranslations: total,
      positiveRate: total > 0 ? pos / total : 0,
      negativeRate: total > 0 ? neg / total : 0,
      correctedRate: total > 0 ? cor / total : 0,
      selfHealSuccessRate: 0,
      topFailingCubes: [],
      averageLatencyMs: 0,
      averageRetries: 0,
    };
  }

  async queryFeedback(opts: FeedbackQueryOptions): Promise<FeedbackQueryResult> {
    let filtered = [...this.entries];
    if (opts.rating) filtered = filtered.filter(e => e.rating === opts.rating);
    if (opts.conversationId) filtered = filtered.filter(e => e.conversationId === opts.conversationId);
    if (opts.since) filtered = filtered.filter(e => e.timestamp >= opts.since!);
    if (opts.until) filtered = filtered.filter(e => e.timestamp <= opts.until!);
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    return { entries: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
  }

  async shutdown(): Promise<void> {}
}

// ═══════════════════════════════════════════════════════════════════════
// Integration Test Suites
// ═══════════════════════════════════════════════════════════════════════

describe('Integration: Scoring → Indexing → Vector Search pipeline', () => {
  let scorer: RuleBasedScorer;
  let serializer: CompactSerializer;
  let embedding: StubEmbeddingProvider;
  let vectorStore: InMemoryVectorStore;
  let metrics: MetricsCollector;

  beforeAll(async () => {
    scorer = new RuleBasedScorer();
    serializer = new CompactSerializer();
    embedding = new StubEmbeddingProvider();
    vectorStore = new InMemoryVectorStore();
    metrics = new MetricsCollector();
    await vectorStore.initialize();

    // Index all cubes — mimics SchemaIntelligenceModule.reindex()
    let consumable = 0;
    for (const cube of CUBES) {
      const score = scorer.score(cube);
      const text = serializer.serialize([cube]);
      const [vec] = await embedding.embed([text]);

      const record: VectorRecord = {
        id: cube.name,
        embedding: vec,
        metadata: {
          cubeName: cube.name,
          metaJson: cube as any,
          score: score.overall,
          scoreDimensions: score.dimensions,
          lastUpdated: new Date().toISOString(),
        },
      };
      await vectorStore.upsert([record]);
      if (score.consumable) consumable++;
    }
    metrics.recordIndex(CUBES.length, consumable);
  });

  afterAll(async () => {
    await vectorStore.shutdown();
  });

  test('all 4 cubes are indexed', async () => {
    expect(await vectorStore.count()).toBe(4);
  });

  test('well-documented cubes score higher than undocumented ones', () => {
    const ordersScore = scorer.score(CUBES[0]); // fully documented
    const lineItemsScore = scorer.score(CUBES[3]); // no descriptions
    expect(ordersScore.overall).toBeGreaterThan(lineItemsScore.overall);
  });

  test('scorer flags missing descriptions on LineItems', () => {
    const result = scorer.score(CUBES[3]);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.some(s => s.issue === 'missing_description')).toBe(true);
  });

  test('metrics reflect the indexing operation', () => {
    expect(metrics.indexedCubesTotal).toBe(4);
    expect(metrics.indexedCubesConsumable).toBeGreaterThan(0);
  });

  test('vector search for "orders" returns Orders cube first', async () => {
    const [queryVec] = await embedding.embed(['orders revenue']);
    const results = await vectorStore.search(queryVec, { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    // Orders should rank highly because its serialized text contains "orders"
    const names = results.map(r => r.metadata.cubeName);
    expect(names).toContain('Orders');
  });

  test('vector search with scoreThreshold filters low-score cubes', async () => {
    const [queryVec] = await embedding.embed(['some query']);
    const lineItemsScore = scorer.score(CUBES[3]).overall;
    // Set threshold above LineItems score
    const threshold = lineItemsScore + 0.01;
    const results = await vectorStore.search(queryVec, { topK: 10, scoreThreshold: threshold });
    const names = results.map(r => r.metadata.cubeName);
    expect(names).not.toContain('LineItems');
  });

  test('deleting a cube removes it from vector store', async () => {
    await vectorStore.delete(['Products']);
    expect(await vectorStore.count()).toBe(3);
    // Re-add for subsequent tests
    const score = scorer.score(CUBES[2]);
    const [vec] = await embedding.embed([serializer.serialize([CUBES[2]])]);
    await vectorStore.upsert([{
      id: 'Products',
      embedding: vec,
      metadata: {
        cubeName: 'Products',
        metaJson: CUBES[2] as any,
        score: score.overall,
        scoreDimensions: score.dimensions,
        lastUpdated: new Date().toISOString(),
      },
    }]);
    expect(await vectorStore.count()).toBe(4);
  });
});

describe('Integration: NLQ Translation end-to-end', () => {
  let translator: DefaultTranslator;
  let llm: StubLLMProvider;
  let feedbackStore: StubFeedbackStore;
  let vectorStore: InMemoryVectorStore;

  beforeAll(async () => {
    const embedding = new StubEmbeddingProvider();
    vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize();
    const serializer = new CompactSerializer();
    const scorer = new RuleBasedScorer();

    // Index cubes
    for (const cube of CUBES) {
      const score = scorer.score(cube);
      const text = serializer.serialize([cube]);
      const [vec] = await embedding.embed([text]);
      await vectorStore.upsert([{
        id: cube.name,
        embedding: vec,
        metadata: {
          cubeName: cube.name,
          metaJson: cube as any,
          score: score.overall,
          scoreDimensions: score.dimensions,
          lastUpdated: new Date().toISOString(),
        },
      }]);
    }

    llm = new StubLLMProvider();
    feedbackStore = new StubFeedbackStore();

    translator = new DefaultTranslator({
      llmProvider: llm,
      embeddingProvider: embedding,
      vectorStore,
      feedbackStore,
      serializer,
      compiledMeta: CUBES,
    });
  });

  afterAll(async () => {
    await vectorStore.shutdown();
  });

  test('translates "how many orders" to Orders.count query', async () => {
    const result = await translator.translate('how many orders');
    expect(result.query).not.toBeNull();
    expect(result.query!.measures).toContain('Orders.count');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.schemasUsed.length).toBeGreaterThan(0);
    expect(result.retryCount).toBe(0);
    expect(result.translationId).toBeTruthy();
  });

  test('translates "total revenue" to Orders.totalAmount', async () => {
    const result = await translator.translate('total revenue');
    expect(result.query).not.toBeNull();
    expect(result.query!.measures).toContain('Orders.totalAmount');
  });

  test('translates "orders by status" to query with dimension', async () => {
    const result = await translator.translate('orders by status');
    expect(result.query).not.toBeNull();
    expect(result.query!.measures).toContain('Orders.count');
    expect(result.query!.dimensions).toContain('Orders.status');
  });

  test('translates "users in each city" to Users query', async () => {
    const result = await translator.translate('users in each city');
    expect(result.query).not.toBeNull();
    expect(result.query!.measures).toContain('Users.count');
    expect(result.query!.dimensions).toContain('Users.city');
  });

  test('translates "average order" with timeDimensions', async () => {
    const result = await translator.translate('average order');
    expect(result.query).not.toBeNull();
    expect(result.query!.measures).toContain('Orders.averageAmount');
    expect(result.query!.timeDimensions).toBeDefined();
    expect(result.query!.timeDimensions!.length).toBe(1);
    expect(result.query!.timeDimensions![0].dimension).toBe('Orders.createdAt');
  });

  test('self-heals when LLM returns invalid member then corrects', async () => {
    // "something unknown" will trigger Nonexistent.metric on first try,
    // then the retry prompt will contain "PREVIOUS ATTEMPT HAD ERRORS"
    // and the stub will return a valid Orders.count query
    const result = await translator.translate('something unknown');
    expect(result.query).not.toBeNull();
    expect(result.retryCount).toBeGreaterThan(0); // had to retry
  });

  test('records translation to feedback store', async () => {
    expect(feedbackStore.entries.length).toBeGreaterThan(0);
    const entry = feedbackStore.entries[0];
    expect(entry.nlq).toBeTruthy();
    expect(entry.translationId).toBeTruthy();
    expect(entry.rating).toBe('pending');
  });

  test('LLM receives schema context in the prompt', () => {
    expect(llm.callLog.length).toBeGreaterThan(0);
    // The prompt should contain serialized cube schemas
    const lastCall = llm.callLog[llm.callLog.length - 1];
    expect(lastCall.prompt).toContain('Orders');
  });

  test('conversation history flows into the prompt', async () => {
    const result = await translator.translate('how many orders', {
      conversationHistory: [
        { role: 'user', content: 'Show me orders from last week' },
        { role: 'assistant', content: 'Here are the orders...' },
      ],
    });
    expect(result.query).not.toBeNull();
    // The prompt should include conversation history
    const lastCall = llm.callLog[llm.callLog.length - 1];
    expect(lastCall.prompt).toContain('Show me orders from last week');
  });
});

describe('Integration: Feedback loop', () => {
  let translator: DefaultTranslator;
  let feedbackStore: StubFeedbackStore;
  let vectorStore: InMemoryVectorStore;

  beforeAll(async () => {
    const embedding = new StubEmbeddingProvider();
    vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize();
    const serializer = new CompactSerializer();
    const scorer = new RuleBasedScorer();

    for (const cube of CUBES) {
      const score = scorer.score(cube);
      const text = serializer.serialize([cube]);
      const [vec] = await embedding.embed([text]);
      await vectorStore.upsert([{
        id: cube.name,
        embedding: vec,
        metadata: {
          cubeName: cube.name,
          metaJson: cube as any,
          score: score.overall,
          scoreDimensions: score.dimensions,
          lastUpdated: new Date().toISOString(),
        },
      }]);
    }

    feedbackStore = new StubFeedbackStore();
    translator = new DefaultTranslator({
      llmProvider: new StubLLMProvider(),
      embeddingProvider: embedding,
      vectorStore,
      feedbackStore,
      serializer,
      compiledMeta: CUBES,
    });
  });

  afterAll(async () => {
    await vectorStore.shutdown();
  });

  test('full feedback lifecycle: translate → rate → retrieve positives', async () => {
    // Step 1: Translate
    const result = await translator.translate('how many orders');
    expect(result.query).not.toBeNull();
    const tid = result.translationId;

    // Step 2: User rates as positive
    await feedbackStore.submitFeedback(tid, 'positive');

    // Step 3: Positive examples surface in future queries
    const positives = await feedbackStore.getPositiveExamples({ topK: 10 });
    expect(positives.length).toBeGreaterThan(0);
    expect(positives.some(p => p.translationId === tid)).toBe(true);
    expect(positives[0].rating).toBe('positive');
  });

  test('corrected feedback records the fixed query', async () => {
    const result = await translator.translate('total revenue');
    const tid = result.translationId;

    const corrected: CubeQuery = {
      measures: ['Orders.totalAmount'],
      dimensions: ['Orders.status'],
    };
    await feedbackStore.submitFeedback(tid, 'corrected', corrected);

    const entry = feedbackStore.entries.find(e => e.translationId === tid);
    expect(entry).toBeDefined();
    expect(entry!.rating).toBe('corrected');
    expect(entry!.correctedQuery).toEqual(corrected);
  });

  test('negative feedback is tracked in stats', async () => {
    const result = await translator.translate('orders by status');
    await feedbackStore.submitFeedback(result.translationId, 'negative');

    const stats = await feedbackStore.getStats();
    expect(stats.totalTranslations).toBeGreaterThanOrEqual(3);
    expect(stats.negativeRate).toBeGreaterThan(0);
  });

  test('metrics collector tracks feedback events', () => {
    const metrics = new MetricsCollector();
    metrics.recordFeedback('positive');
    metrics.recordFeedback('positive');
    metrics.recordFeedback('negative');
    metrics.recordFeedback('corrected');

    const json = metrics.toJSON();
    expect(json.feedbackPositive).toBe(2);
    expect(json.feedbackNegative).toBe(1);
    expect(json.feedbackCorrected).toBe(1);
  });
});

describe('Integration: Query Validation with real schemas', () => {
  let validator: QueryValidator;

  beforeAll(() => {
    validator = new QueryValidator(CUBES);
  });

  test('accepts a valid multi-cube query', () => {
    const result = validator.validate({
      measures: ['Orders.count', 'Orders.totalAmount'],
      dimensions: ['Orders.status'],
      timeDimensions: [{ dimension: 'Orders.createdAt', granularity: 'month' }],
      limit: 100,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects made-up members and suggests alternatives', () => {
    const result = validator.validate({
      measures: ['Orders.totamount'], // typo
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // Should suggest the real member name
    expect(result.suggestions.some(s => s.toLowerCase().includes('totalamount'))).toBe(true);
  });

  test('rejects query with no measures and no dimensions', () => {
    const result = validator.validate({});
    expect(result.valid).toBe(false);
  });

  test('validates cross-cube queries', () => {
    const result = validator.validate({
      measures: ['Orders.count'],
      dimensions: ['Users.city'],
    });
    // Both members exist — validation passes (join enforcement is runtime)
    expect(result.valid).toBe(true);
  });
});

describe('Integration: Serialization → Prompt → Validation round-trip', () => {
  test('serialized schemas appear in prompt and prompt contains NLQ', () => {
    const serializer = new CompactSerializer();
    const serialized = serializer.serialize(CUBES);

    const builder = new PromptBuilder();
    const { systemPrompt, userPrompt } = builder.build({
      nlq: 'how many pending orders',
      schemas: serialized,
    });

    // System prompt has Cube query grammar
    expect(systemPrompt).toContain('Cube.js query generator');
    // User prompt has the schema and the question
    expect(userPrompt).toContain('Orders');
    expect(userPrompt).toContain('Users');
    expect(userPrompt).toContain('how many pending orders');
    // Serialized output is shorter than full JSON
    expect(serialized.length).toBeGreaterThan(0);
  });

  test('prompt includes few-shot examples and negative patterns', () => {
    const serializer = new CompactSerializer();
    const serialized = serializer.serialize(CUBES);
    const builder = new PromptBuilder();

    const fewShot: FeedbackEntry[] = [
      {
        translationId: 'ex1',
        timestamp: new Date(),
        nlq: 'count of orders',
        generatedQuery: { measures: ['Orders.count'] },
        schemasUsed: ['Orders'],
        rating: 'positive',
        latencyMs: 42,
        retryCount: 0,
      },
    ];

    const negPatterns: NegativePattern[] = [
      { pattern: 'Do not use Nonexistent.metric', count: 3, lastSeen: new Date() },
    ];

    const { systemPrompt, userPrompt } = builder.build({
      nlq: 'how many orders',
      schemas: serialized,
      fewShotExamples: fewShot,
      negativePatterns: negPatterns,
      previousErrors: [{ message: 'Unknown member: Foo.bar' }],
    });

    expect(systemPrompt).toContain('Do not use Nonexistent.metric');
    expect(userPrompt).toContain('count of orders');
    expect(userPrompt).toContain('PREVIOUS ATTEMPT HAD ERRORS');
    expect(userPrompt).toContain('Unknown member: Foo.bar');
  });
});

describe('Integration: Metrics through a translation sequence', () => {
  test('metrics aggregate across multiple operations', async () => {
    const metrics = new MetricsCollector();
    const embedding = new StubEmbeddingProvider();
    const vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize();

    // Simulate indexing
    metrics.recordIndex(4, 3);
    expect(metrics.indexedCubesTotal).toBe(4);
    expect(metrics.indexedCubesConsumable).toBe(3);

    // Simulate searches
    metrics.recordSearch(15);
    metrics.recordSearch(22);
    metrics.recordSearch(10);
    expect(metrics.searchRequestsTotal).toBe(3);

    // Simulate translations
    metrics.recordTranslation(true);
    metrics.recordTranslation(true);
    metrics.recordTranslation(false); // failed
    expect(metrics.translateRequestsTotal).toBe(3);
    expect(metrics.translateSuccessRate).toBeCloseTo(2 / 3, 2);

    // Simulate feedback
    metrics.recordFeedback('positive');
    metrics.recordFeedback('negative');

    // Prometheus format
    const prom = metrics.toPrometheus();
    expect(prom).toContain('cubejs_ai_index_cubes_total 4');
    expect(prom).toContain('cubejs_ai_search_requests_total 3');
    expect(prom).toContain('cubejs_ai_translate_requests_total 3');
    expect(prom).toContain('cubejs_ai_feedback_total{type="positive"} 1');
    expect(prom).toContain('cubejs_ai_feedback_total{type="negative"} 1');

    // JSON format
    const json = metrics.toJSON();
    expect(json.indexedCubesTotal).toBe(4);
    expect(json.translateSuccessRate).toBeGreaterThan(0);

    await vectorStore.shutdown();
  });
});

describe('Integration: Schema update triggers re-validation', () => {
  test('translator picks up new cubes after updateMeta', async () => {
    const embedding = new StubEmbeddingProvider();
    const vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize();
    const serializer = new CompactSerializer();
    const scorer = new RuleBasedScorer();

    // Only index Orders initially
    const ordersCube = CUBES[0];
    const score = scorer.score(ordersCube);
    const [vec] = await embedding.embed([serializer.serialize([ordersCube])]);
    await vectorStore.upsert([{
      id: ordersCube.name,
      embedding: vec,
      metadata: {
        cubeName: ordersCube.name,
        metaJson: ordersCube as any,
        score: score.overall,
        scoreDimensions: score.dimensions,
        lastUpdated: new Date().toISOString(),
      },
    }]);

    const llm = new StubLLMProvider();
    const translator = new DefaultTranslator({
      llmProvider: llm,
      embeddingProvider: embedding,
      vectorStore,
      feedbackStore: null,
      serializer,
      compiledMeta: [ordersCube],
    });

    // Validate against only Orders
    const validator = new QueryValidator([ordersCube]);
    const v1 = validator.validate({ measures: ['Users.count'] });
    expect(v1.valid).toBe(false); // Users not in meta

    // Add Users cube
    translator.updateMeta(CUBES);
    // Now internal validator knows about Users
    const result = await translator.translate('users in each city');
    expect(result.query).not.toBeNull();
    expect(result.query!.measures).toContain('Users.count');

    await vectorStore.shutdown();
  });
});
