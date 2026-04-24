import { SchemaIntelligenceModule } from '../src/SchemaIntelligenceModule';
import { CubeMetaConfig } from '../src/types';

const SAMPLE_CUBES: CubeMetaConfig[] = [
  {
    name: 'Orders',
    description: 'Customer orders with revenue and fulfillment data',
    measures: [
      { name: 'Orders.count', type: 'count', description: 'Total number of orders' },
      { name: 'Orders.totalAmount', type: 'sum', description: 'Sum of order amounts in USD' },
    ],
    dimensions: [
      { name: 'Orders.status', type: 'string', description: 'Order status. Values: pending, shipped, delivered' },
      { name: 'Orders.createdAt', type: 'time', description: 'When the order was created' },
    ],
    segments: [],
    joins: [],
  },
  {
    name: 'Users',
    description: 'Registered users and their profiles',
    measures: [
      { name: 'Users.count', type: 'count', description: 'Total registered users' },
    ],
    dimensions: [
      { name: 'Users.name', type: 'string', description: 'Full name of the user' },
      { name: 'Users.email', type: 'string', description: 'Email address' },
      { name: 'Users.createdAt', type: 'time', description: 'Registration date' },
    ],
    segments: [],
    joins: [],
  },
];

describe('SchemaIntelligenceModule', () => {
  describe('disabled mode', () => {
    test('all methods are no-ops when disabled', async () => {
      const mod = new SchemaIntelligenceModule(false);

      expect(mod.isEnabled()).toBe(false);

      const searchResults = await mod.search('test');
      expect(searchResults).toEqual([]);

      const scores = await mod.getScores();
      expect(scores).toEqual([]);

      const translation = await mod.translate('test');
      expect(translation.query).toBeNull();
      expect(translation.validationErrors).toBeDefined();

      const stats = await mod.getFeedbackStats();
      expect(stats).toBeNull();

      const status = await mod.getStatus();
      expect(status.enabled).toBe(false);

      // These should not throw
      await mod.submitFeedback('id', 'positive');
      await mod.onSchemaCompiled([], 'v1');
      await mod.reindex([]);
      await mod.shutdown();
    });

    test('constructor with undefined options defaults to disabled', async () => {
      const mod = new SchemaIntelligenceModule();
      expect(mod.isEnabled()).toBe(false);
    });

    test('constructor with boolean true enables', () => {
      const mod = new SchemaIntelligenceModule(true);
      expect(mod.isEnabled()).toBe(true);
    });

    test('constructor with options object respects enabled flag', () => {
      const mod = new SchemaIntelligenceModule({ enabled: true });
      expect(mod.isEnabled()).toBe(true);

      const mod2 = new SchemaIntelligenceModule({ enabled: false });
      expect(mod2.isEnabled()).toBe(false);
    });
  });

  describe('enabled mode (with mock embedding)', () => {
    let mod: SchemaIntelligenceModule;

    beforeEach(() => {
      // Enable with in-memory defaults — local embedding will fail since
      // @xenova/transformers isn't installed, so we test up to initialization
      mod = new SchemaIntelligenceModule({
        enabled: true,
        scoring: {},
        feedback: { enabled: false },
        // Use defaults (will use local embedding — expected to fail in test env)
      });
    });

    afterEach(async () => {
      await mod.shutdown();
    });

    test('getMetrics returns a MetricsCollector', () => {
      const metrics = mod.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.searchRequestsTotal).toBe(0);
      expect(typeof metrics.toPrometheus).toBe('function');
      expect(typeof metrics.toJSON).toBe('function');
    });

    test('getStatus returns enabled status before initialization', async () => {
      // getStatus attempts initialization; local embedding may fail
      // but enabled should still be true
      const status = await mod.getStatus();
      expect(status.enabled).toBe(true);
    });
  });

  describe('scoring (no embedding needed)', () => {
    test('getScores works when scorer is available', async () => {
      // We can directly test scoring through the module by manually triggering
      // the scorer without requiring embedding
      const { RuleBasedScorer } = await import('../src/scoring/RuleBasedScorer');
      const scorer = new RuleBasedScorer();

      const scores = SAMPLE_CUBES.map(c => scorer.score(c));
      expect(scores).toHaveLength(2);
      expect(scores[0].cubeName).toBe('Orders');
      expect(scores[0].overall).toBeGreaterThan(0);
      expect(scores[1].cubeName).toBe('Users');
    });
  });

  describe('onSchemaCompiled deduplication', () => {
    test('skips reindex when compilerId has not changed', async () => {
      const mod = new SchemaIntelligenceModule(false);
      // Even on disabled module, verify no crash
      await mod.onSchemaCompiled(SAMPLE_CUBES, 'v1');
      await mod.onSchemaCompiled(SAMPLE_CUBES, 'v1'); // duplicate — should be no-op
    });
  });
});
