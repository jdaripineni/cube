import { CompactSerializer, FullJsonSerializer } from '../src/serialization/SchemaSerializers';
import { CubeMetaConfig } from '../src/types';

describe('CompactSerializer', () => {
  const serializer = new CompactSerializer();

  const cube: CubeMetaConfig = {
    name: 'Orders',
    title: 'Orders',
    description: 'Customer orders',
    measures: [
      { name: 'Orders.count', type: 'count', title: 'Count', description: 'Total orders' },
      { name: 'Orders.amount', type: 'sum', title: 'Amount', description: 'Sum of amounts' },
    ],
    dimensions: [
      { name: 'Orders.status', type: 'string', title: 'Status', description: 'Order status' },
      { name: 'Orders.createdAt', type: 'time', title: 'Created', description: 'Creation time' },
    ],
    segments: [],
    joins: [{ name: 'Orders.customer', relationship: 'belongsTo' }],
  };

  test('produces shorter output than full JSON', () => {
    const compact = serializer.serialize([cube]);
    const full = new FullJsonSerializer().serialize([cube]);
    expect(compact.length).toBeLessThan(full.length);
  });

  test('includes cube name and description', () => {
    const result = serializer.serialize([cube]);
    expect(result).toContain('Orders');
    expect(result).toContain('Customer orders');
  });

  test('includes measures and dimensions', () => {
    const result = serializer.serialize([cube]);
    expect(result).toContain('count');
    expect(result).toContain('status');
  });

  test('respects maxTokens budget', () => {
    const result = serializer.serialize([cube], { maxTokens: 50 });
    // Should be truncated — 50 tokens ≈ 200 chars
    expect(result.length).toBeLessThanOrEqual(300);
  });
});

describe('FullJsonSerializer', () => {
  test('produces valid JSON', () => {
    const serializer = new FullJsonSerializer();
    const cube: CubeMetaConfig = { name: 'Test', measures: [], dimensions: [], segments: [] };
    const result = serializer.serialize([cube]);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
