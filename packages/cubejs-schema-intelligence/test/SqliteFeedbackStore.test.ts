import { SqliteFeedbackStore } from '../src/feedback/SqliteFeedbackStore';
import { FeedbackEntry } from '../src/types';

// better-sqlite3 is optional; skip if not installed
let hasSqlite = false;
try {
  require('better-sqlite3');
  hasSqlite = true;
} catch {
  // skip
}

const describeIfSqlite = hasSqlite ? describe : describe.skip;

describeIfSqlite('SqliteFeedbackStore', () => {
  let store: SqliteFeedbackStore;

  beforeEach(async () => {
    // Use in-memory DB for tests
    store = new SqliteFeedbackStore({ connectionOptions: { path: ':memory:' } });
    await store.initialize();
  });

  afterEach(async () => {
    await store.shutdown();
  });

  function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
    return {
      translationId: `txn-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      nlq: 'How many orders?',
      generatedQuery: { measures: ['Orders.count'] },
      schemasUsed: ['Orders'],
      rating: 'pending',
      latencyMs: 150,
      retryCount: 0,
      ...overrides,
    };
  }

  test('save and retrieve feedback entry', async () => {
    const entry = makeEntry({ translationId: 'test-001' });
    await store.save(entry);

    const stats = await store.getStats();
    expect(stats.totalTranslations).toBe(1);
  });

  test('submitFeedback updates rating', async () => {
    const entry = makeEntry({ translationId: 'test-002' });
    await store.save(entry);

    await store.submitFeedback('test-002', 'positive');

    const stats = await store.getStats();
    expect(stats.positiveRate).toBe(1);
  });

  test('getPositiveExamples returns rated entries', async () => {
    await store.save(makeEntry({ translationId: 'pos-1', rating: 'positive' }));
    await store.save(makeEntry({ translationId: 'pos-2', rating: 'positive' }));
    await store.save(makeEntry({ translationId: 'neg-1', rating: 'negative' }));

    const examples = await store.getPositiveExamples({ topK: 10 });
    expect(examples.length).toBe(2);
    examples.forEach(e => {
      expect(['positive', 'corrected']).toContain(e.rating);
    });
  });

  test('getNegativePatterns returns grouped error patterns', async () => {
    await store.save(makeEntry({
      translationId: 'neg-a',
      rating: 'negative',
      executionError: 'Unknown measure X',
    }));
    await store.save(makeEntry({
      translationId: 'neg-b',
      rating: 'negative',
      executionError: 'Unknown measure X',
    }));
    await store.save(makeEntry({
      translationId: 'neg-c',
      rating: 'negative',
      executionError: 'Timeout',
    }));

    const patterns = await store.getNegativePatterns();
    expect(patterns.length).toBe(2);

    const top = patterns[0];
    expect(top.pattern).toBe('Unknown measure X');
    expect(top.count).toBe(2);
    expect(top.lastSeen).toBeInstanceOf(Date);
  });

  test('getStats computes rates correctly', async () => {
    await store.save(makeEntry({ translationId: 's1', rating: 'positive' }));
    await store.save(makeEntry({ translationId: 's2', rating: 'positive' }));
    await store.save(makeEntry({ translationId: 's3', rating: 'negative' }));
    await store.save(makeEntry({ translationId: 's4', rating: 'corrected' }));

    const stats = await store.getStats();
    expect(stats.totalTranslations).toBe(4);
    expect(stats.positiveRate).toBe(0.5);
    expect(stats.negativeRate).toBe(0.25);
    expect(stats.correctedRate).toBe(0.25);
  });

  test('getStats returns zeros with empty store', async () => {
    const stats = await store.getStats();
    expect(stats.totalTranslations).toBe(0);
    expect(stats.positiveRate).toBe(0);
    expect(stats.averageLatencyMs).toBe(0);
  });

  test('submitFeedback with corrected query updates the entry', async () => {
    await store.save(makeEntry({ translationId: 'corr-1' }));
    await store.submitFeedback('corr-1', 'corrected', {
      measures: ['Orders.totalAmount'],
      dimensions: ['Orders.status'],
    });

    const stats = await store.getStats();
    expect(stats.correctedRate).toBe(1);
  });
});
