import { DefaultTranslator, DefaultTranslatorDeps } from '../src/translator/DefaultTranslator';
import { InMemoryVectorStore } from '../src/vectorstore/InMemoryVectorStore';
import { CompactSerializer } from '../src/serialization/SchemaSerializers';
import {
  CubeMetaConfig,
  LLMProvider,
  EmbeddingProvider,
  FeedbackStore,
  VectorRecord,
} from '../src/types';

// ── Mock LLM Provider ──
class MockLLMProvider implements LLMProvider {
  public lastPrompt = '';
  public responseJson: any = { measures: ['Orders.count'] };

  async complete(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return JSON.stringify(this.responseJson);
  }

  async completeStructured<T>(prompt: string): Promise<T> {
    this.lastPrompt = prompt;
    return this.responseJson as T;
  }

  async shutdown(): Promise<void> {}
}

// ── Mock Embedding Provider ──
class MockEmbeddingProvider implements EmbeddingProvider {
  private dim = 3;

  async embed(texts: string[]): Promise<number[][]> {
    // Deterministic fake embeddings based on text hash
    return texts.map(t => {
      const hash = t.length % 10;
      return [hash / 10, (10 - hash) / 10, 0.5];
    });
  }

  dimensions(): number {
    return this.dim;
  }

  async shutdown(): Promise<void> {}
}

const CUBES: CubeMetaConfig[] = [
  {
    name: 'Orders',
    description: 'Customer orders with amounts',
    measures: [
      { name: 'Orders.count', type: 'count', description: 'Total orders' },
      { name: 'Orders.totalAmount', type: 'sum', description: 'Revenue' },
    ],
    dimensions: [
      { name: 'Orders.status', type: 'string', description: 'Status' },
      { name: 'Orders.createdAt', type: 'time', description: 'Created date' },
    ],
    segments: [],
  },
  {
    name: 'Users',
    measures: [{ name: 'Users.count', type: 'count' }],
    dimensions: [{ name: 'Users.name', type: 'string' }],
    segments: [],
  },
];

function makeVectorRecord(cube: CubeMetaConfig, embedding: number[]): VectorRecord {
  return {
    id: cube.name,
    embedding,
    metadata: {
      cubeName: cube.name,
      metaJson: cube as any,
      score: 0.9,
      scoreDimensions: {},
      lastUpdated: new Date().toISOString(),
    },
  };
}

describe('DefaultTranslator', () => {
  let llm: MockLLMProvider;
  let embeddingProvider: MockEmbeddingProvider;
  let vectorStore: InMemoryVectorStore;
  let translator: DefaultTranslator;

  beforeEach(async () => {
    llm = new MockLLMProvider();
    embeddingProvider = new MockEmbeddingProvider();
    vectorStore = new InMemoryVectorStore({ provider: 'memory', distanceMetric: 'cosine' });
    await vectorStore.initialize();

    // Pre-populate vector store
    await vectorStore.upsert([
      makeVectorRecord(CUBES[0], [0.8, 0.2, 0.5]),
      makeVectorRecord(CUBES[1], [0.2, 0.8, 0.5]),
    ]);

    const deps: DefaultTranslatorDeps = {
      llmProvider: llm,
      embeddingProvider,
      vectorStore,
      feedbackStore: null,
      serializer: new CompactSerializer(),
      compiledMeta: CUBES,
    };

    translator = new DefaultTranslator(deps);
  });

  test('translates a simple question to a valid query', async () => {
    llm.responseJson = { measures: ['Orders.count'] };

    const result = await translator.translate('How many orders?');

    expect(result.query).toEqual({ measures: ['Orders.count'] });
    expect(result.translationId).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.retryCount).toBe(0);
    expect(result.schemasUsed.length).toBeGreaterThan(0);
  });

  test('returns no-result when vector store has no matches', async () => {
    // Clear store
    await vectorStore.delete(['Orders', 'Users']);

    const result = await translator.translate('Random unrelated question');

    expect(result.query).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.length).toBeGreaterThan(0);
  });

  test('retries on validation failure then succeeds', async () => {
    let callCount = 0;
    llm.completeStructured = async function <T>(): Promise<T> {
      callCount++;
      if (callCount === 1) {
        // First attempt: invalid member
        return { measures: ['Orders.nonexistent'] } as any;
      }
      // Second attempt: valid
      return { measures: ['Orders.count'] } as any;
    };

    const result = await translator.translate('Count orders', { maxRetries: 3 });

    expect(result.query).toEqual({ measures: ['Orders.count'] });
    expect(result.retryCount).toBe(1);
  });

  test('exhausts retries and returns null query', async () => {
    // Always return invalid member
    llm.completeStructured = async function <T>(): Promise<T> {
      return { measures: ['Nonexistent.count'] } as any;
    };

    const result = await translator.translate('Count something', { maxRetries: 2 });

    expect(result.query).toBeNull();
    expect(result.retryCount).toBe(2);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.length).toBeGreaterThan(0);
  });

  test('handles LLM parse errors as retryable failures', async () => {
    let callCount = 0;
    llm.completeStructured = async function <T>(): Promise<T> {
      callCount++;
      if (callCount === 1) {
        throw new Error('Invalid JSON in response');
      }
      return { measures: ['Orders.count'] } as any;
    };

    const result = await translator.translate('Count orders', { maxRetries: 2 });

    expect(result.query).toEqual({ measures: ['Orders.count'] });
    expect(result.retryCount).toBe(1);
  });

  test('includes conversation history in prompt', async () => {
    llm.responseJson = { measures: ['Orders.totalAmount'] };

    await translator.translate('What about revenue?', {
      conversationHistory: [
        { role: 'user', content: 'Show me orders' },
        { role: 'assistant', content: '{"measures":["Orders.count"]}' },
      ],
    });

    // The LLM should have received the conversation history in the prompt
    expect(llm.lastPrompt).toContain('Show me orders');
  });

  test('updateMeta refreshes the internal validator', async () => {
    const newCubes: CubeMetaConfig[] = [
      {
        name: 'Products',
        measures: [{ name: 'Products.count', type: 'count' }],
        dimensions: [],
        segments: [],
      },
    ];

    translator.updateMeta(newCubes);

    llm.responseJson = { measures: ['Products.count'] };

    // Need a vector store match for Products
    await vectorStore.upsert([makeVectorRecord(newCubes[0], [0.5, 0.5, 0.5])]);

    const result = await translator.translate('How many products?');
    expect(result.query).toEqual({ measures: ['Products.count'] });
  });
});
