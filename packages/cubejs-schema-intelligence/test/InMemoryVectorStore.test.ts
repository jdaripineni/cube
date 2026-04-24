import { InMemoryVectorStore } from '../src/vectorstore/InMemoryVectorStore';
import { VectorRecord } from '../src/types';

function makeRecord(id: string, embedding: number[], cubeName: string): VectorRecord {
  return {
    id,
    embedding,
    metadata: {
      cubeName,
      metaJson: {},
      score: 1.0,
      scoreDimensions: {},
      lastUpdated: new Date().toISOString(),
    },
  };
}

describe('InMemoryVectorStore', () => {
  let store: InMemoryVectorStore;

  beforeEach(async () => {
    store = new InMemoryVectorStore({ provider: 'memory', distanceMetric: 'cosine' });
    await store.initialize();
  });

  test('upsert and search returns results', async () => {
    await store.upsert([
      makeRecord('a', [1, 0, 0], 'Orders'),
      makeRecord('b', [0, 1, 0], 'Users'),
      makeRecord('c', [0, 0, 1], 'Products'),
    ]);

    const results = await store.search([1, 0.1, 0], { topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a');
    expect(results[0].similarity).toBeGreaterThan(0.9);
  });

  test('delete removes entries', async () => {
    await store.upsert([makeRecord('x', [1, 0], 'Test')]);
    await store.delete(['x']);
    const results = await store.search([1, 0], { topK: 5 });
    expect(results).toHaveLength(0);
  });

  test('count returns correct number', async () => {
    await store.upsert([
      makeRecord('1', [1, 0], 'A'),
      makeRecord('2', [0, 1], 'B'),
    ]);
    expect(await store.count()).toBe(2);
  });

  test('upsert overwrites existing id', async () => {
    await store.upsert([makeRecord('a', [1, 0], 'V1')]);
    await store.upsert([makeRecord('a', [0, 1], 'V2')]);
    expect(await store.count()).toBe(1);
    const results = await store.search([0, 1], { topK: 1 });
    expect(results[0].metadata.cubeName).toBe('V2');
  });

  test('euclidean distance metric works', async () => {
    const eucStore = new InMemoryVectorStore({ provider: 'memory', distanceMetric: 'euclidean' });
    await eucStore.initialize();
    await eucStore.upsert([
      makeRecord('a', [0, 0], 'Origin'),
      makeRecord('b', [3, 4], 'Far'),
    ]);
    const results = await eucStore.search([0, 0], { topK: 2 });
    expect(results[0].id).toBe('a');
  });
});
