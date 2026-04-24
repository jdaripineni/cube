import { RuleBasedScorer } from '../src/scoring/RuleBasedScorer';
import { CubeMetaConfig } from '../src/types';

describe('RuleBasedScorer', () => {
  let scorer: RuleBasedScorer;

  beforeEach(() => {
    scorer = new RuleBasedScorer();
  });

  const wellDocumentedCube: CubeMetaConfig = {
    name: 'Orders',
    title: 'Orders',
    description: 'All customer orders with fulfillment tracking and revenue analysis',
    measures: [
      { name: 'Orders.count', type: 'count', title: 'Count', description: 'Total number of orders placed by customers' },
      { name: 'Orders.totalAmount', type: 'sum', title: 'Total Amount', description: 'Sum of order amounts measured in USD currency' },
    ],
    dimensions: [
      { name: 'Orders.status', type: 'string', title: 'Status', description: 'Current order status. Values: pending, shipped, delivered, cancelled' },
      { name: 'Orders.createdAt', type: 'time', title: 'Created At', description: 'Timestamp when the order was initially created in the system' },
    ],
    segments: [],
    joins: [{ name: 'Orders.customer', relationship: 'belongsTo', sql: '${CUBE}.customer_id = ${Customer}.id' }],
  };

  const poorlyDocumentedCube: CubeMetaConfig = {
    name: 'Data',
    title: 'Data',
    measures: [
      { name: 'Data.count', type: 'count', title: 'Count' },
    ],
    dimensions: [
      { name: 'Data.value', type: 'string', title: 'Value' },
    ],
    segments: [],
    joins: [],
  };

  test('scores a well-documented cube highly', () => {
    const result = scorer.score(wellDocumentedCube);
    expect(result.overall).toBeGreaterThan(0.7);
    expect(result.cubeName).toBe('Orders');
  });

  test('scores a poorly documented cube low', () => {
    const result = scorer.score(poorlyDocumentedCube);
    expect(result.overall).toBeLessThan(0.4);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  test('returns per-criterion breakdown', () => {
    const result = scorer.score(wellDocumentedCube);
    expect(result.dimensions).toBeDefined();
    expect(Object.keys(result.dimensions).length).toBeGreaterThan(0);
    for (const [, score] of Object.entries(result.dimensions)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test('generates enrichment suggestions for missing descriptions', () => {
    const result = scorer.score(poorlyDocumentedCube);
    const descSuggestions = result.suggestions.filter(s =>
      s.issue === 'missing_description' || s.issue === 'vague_description'
    );
    expect(descSuggestions.length).toBeGreaterThan(0);
  });

  test('custom criteria weights are normalized', () => {
    const customScorer = new RuleBasedScorer({
      criteria: [
        { name: 'cube_description', weight: 5 },
        { name: 'measure_descriptions', weight: 5 },
      ],
    });
    const result = customScorer.score(wellDocumentedCube);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(1);
  });
});
