import { PgVectorStore } from '../src/vectorstore/PgVectorStore';
import type { VectorStoreConfig, VectorRecord, SearchOptions } from '../src/types';

/**
 * Unit tests for PgVectorStore using a mock pg Pool.
 * No real PostgreSQL connection is needed.
 */

// --- mock helpers -------------------------------------------------------

function createMockClient() {
  const queries: { text: string; values?: any[] }[] = [];
  return {
    queries,
    query: jest.fn(async (text: string, values?: any[]): Promise<any> => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    connect: jest.fn(async () => mockClient),
    query: jest.fn(async (text: string, values?: any[]): Promise<any> => {
      return mockClient.query(text, values);
    }),
    end: jest.fn(async () => {}),
  };
}

// We mock `import('pg')` by patching the pool after initialize.
// PgVectorStore calls `new pg.default.Pool(...)` inside initialize(),
// so we mock the module import.
jest.mock('pg', () => {
  // The mock is set up per-test via __mockPool
  return {
    __esModule: true,
    default: {
      Pool: jest.fn().mockImplementation(() => (global as any).__mockPool),
    },
  };
});

describe('PgVectorStore', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;
  let store: PgVectorStore;

  const baseConfig: VectorStoreConfig = {
    provider: 'pgvector',
    connectionOptions: { connectionString: 'postgres://localhost/test' },
  };

  beforeEach(async () => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
    (global as any).__mockPool = mockPool;
  });

  afterEach(async () => {
    delete (global as any).__mockPool;
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    test('defaults to cosine operator', () => {
      store = new PgVectorStore(baseConfig);
      // Internal state tested via initialize DDL
      expect(store).toBeDefined();
    });

    test('accepts euclidean distance metric', () => {
      store = new PgVectorStore({ ...baseConfig, distanceMetric: 'euclidean' });
      expect(store).toBeDefined();
    });

    test('accepts dot_product distance metric', () => {
      store = new PgVectorStore({ ...baseConfig, distanceMetric: 'dot_product' });
      expect(store).toBeDefined();
    });
  });

  describe('initialize', () => {
    test('creates extension, table, and HNSW index by default', async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();

      const queryTexts = mockClient.queries.map(q => q.text);
      expect(queryTexts.some(t => t.includes('CREATE EXTENSION IF NOT EXISTS vector'))).toBe(true);
      expect(queryTexts.some(t => t.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
      expect(queryTexts.some(t => t.includes('USING hnsw'))).toBe(true);
      expect(queryTexts.some(t => t.includes('vector_cosine_ops'))).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('creates IVFFlat index when configured', async () => {
      store = new PgVectorStore({
        ...baseConfig,
        indexType: 'ivfflat',
        indexOptions: { nLists: 50 },
      });
      await store.initialize();

      const queryTexts = mockClient.queries.map(q => q.text);
      expect(queryTexts.some(t => t.includes('USING ivfflat'))).toBe(true);
      expect(queryTexts.some(t => t.includes('lists = 50'))).toBe(true);
    });

    test('uses custom HNSW parameters', async () => {
      store = new PgVectorStore({
        ...baseConfig,
        indexType: 'hnsw',
        indexOptions: { m: 32, efConstruction: 128 },
      });
      await store.initialize();

      const queryTexts = mockClient.queries.map(q => q.text);
      expect(queryTexts.some(t => t.includes('m = 32'))).toBe(true);
      expect(queryTexts.some(t => t.includes('ef_construction = 128'))).toBe(true);
    });

    test('uses euclidean ops when configured', async () => {
      store = new PgVectorStore({
        ...baseConfig,
        distanceMetric: 'euclidean',
      });
      await store.initialize();

      const queryTexts = mockClient.queries.map(q => q.text);
      expect(queryTexts.some(t => t.includes('vector_l2_ops'))).toBe(true);
    });

    test('releases client even if query fails', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('CREATE EXTENSION failed'));
      store = new PgVectorStore(baseConfig);

      await expect(store.initialize()).rejects.toThrow('CREATE EXTENSION failed');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('upsert', () => {
    beforeEach(async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();
      mockClient.queries.length = 0; // reset after init
    });

    test('inserts records with ON CONFLICT upsert', async () => {
      const records: VectorRecord[] = [
        {
          id: 'Orders',
          embedding: [0.1, 0.2, 0.3],
          metadata: {
            cubeName: 'Orders',
            metaJson: {},
            score: 0.8,
            scoreDimensions: {},
            lastUpdated: new Date().toISOString(),
          },
        },
      ];

      await store.upsert(records);

      const upsertQuery = mockClient.queries.find(q => q.text.includes('INSERT INTO'));
      expect(upsertQuery).toBeDefined();
      expect(upsertQuery!.text).toContain('ON CONFLICT (id) DO UPDATE');
      expect(upsertQuery!.values![0]).toBe('Orders');
      expect(upsertQuery!.values![1]).toBe('[0.1,0.2,0.3]');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('upserts multiple records in sequence', async () => {
      const records: VectorRecord[] = [
        {
          id: 'A',
          embedding: [1, 2],
          metadata: { cubeName: 'A', metaJson: {}, score: 0.5, scoreDimensions: {}, lastUpdated: '' },
        },
        {
          id: 'B',
          embedding: [3, 4],
          metadata: { cubeName: 'B', metaJson: {}, score: 0.7, scoreDimensions: {}, lastUpdated: '' },
        },
      ];

      await store.upsert(records);

      const inserts = mockClient.queries.filter(q => q.text.includes('INSERT INTO'));
      expect(inserts).toHaveLength(2);
      expect(inserts[0].values![0]).toBe('A');
      expect(inserts[1].values![0]).toBe('B');
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();
    });

    test('builds correct query with topK', async () => {
      // Set up mock to return rows
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'Orders',
            embedding: '{0.1,0.2,0.3}',
            metadata: { cubeName: 'Orders' },
            similarity: '0.95',
          },
        ],
      });

      const searchOpts: SearchOptions = { topK: 5 };
      const results = await store.search([0.1, 0.2, 0.3], searchOpts);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('Orders');
      expect(results[0].similarity).toBe(0.95);
      expect(results[0].embedding).toEqual([0.1, 0.2, 0.3]);

      const searchCall = mockPool.query.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('similarity')
      );
      expect(searchCall).toBeDefined();
      expect(searchCall![1]).toEqual(['[0.1,0.2,0.3]', 5]);
    });

    test('applies scoreThreshold WHERE clause', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const searchOpts: SearchOptions = { topK: 10, scoreThreshold: 0.6 };
      await store.search([1, 2], searchOpts);

      const searchCall = mockPool.query.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('score')
      );
      expect(searchCall).toBeDefined();
      expect(searchCall![0]).toContain("(metadata->>'score')::float >= $3");
      expect(searchCall![1]).toEqual(['[1,2]', 10, 0.6]);
    });
  });

  describe('delete', () => {
    beforeEach(async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();
    });

    test('deletes by IDs with parameterized query', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

      await store.delete(['A', 'B']);

      const deleteCall = mockPool.query.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE')
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall![0]).toContain('$1');
      expect(deleteCall![0]).toContain('$2');
      expect(deleteCall![1]).toEqual(['A', 'B']);
    });

    test('no-op for empty array', async () => {
      const queryCountBefore = mockPool.query.mock.calls.length;
      await store.delete([]);
      // Should not have made any new query calls
      expect(mockPool.query.mock.calls.length).toBe(queryCountBefore);
    });
  });

  describe('count', () => {
    test('returns parsed count', async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();

      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: '42' }] });

      const result = await store.count();
      expect(result).toBe(42);
    });
  });

  describe('healthCheck', () => {
    test('returns true when SELECT 1 succeeds', async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();

      mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      expect(await store.healthCheck()).toBe(true);
    });

    test('returns false when query fails', async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();

      mockPool.query.mockRejectedValueOnce(new Error('connection refused'));
      expect(await store.healthCheck()).toBe(false);
    });
  });

  describe('shutdown', () => {
    test('calls pool.end()', async () => {
      store = new PgVectorStore(baseConfig);
      await store.initialize();

      await store.shutdown();
      expect(mockPool.end).toHaveBeenCalled();
    });
  });
});
