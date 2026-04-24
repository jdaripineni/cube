import { QueryValidator } from '../src/validation/QueryValidator';
import { CubeMetaConfig } from '../src/types';

describe('QueryValidator', () => {
  const meta: CubeMetaConfig[] = [
    {
      name: 'Orders',
      measures: [
        { name: 'Orders.count', type: 'count' },
        { name: 'Orders.totalAmount', type: 'sum' },
      ],
      dimensions: [
        { name: 'Orders.status', type: 'string' },
        { name: 'Orders.createdAt', type: 'time' },
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

  let validator: QueryValidator;

  beforeEach(() => {
    validator = new QueryValidator(meta);
  });

  test('validates a correct query', () => {
    const result = validator.validate({
      measures: ['Orders.count'],
      dimensions: ['Orders.status'],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects unknown measure', () => {
    const result = validator.validate({
      measures: ['Orders.nonexistent'],
      dimensions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('suggests similar member names', () => {
    const result = validator.validate({
      measures: ['Orders.cont'],
      dimensions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]).toContain('Orders.count');
  });

  test('rejects unknown dimension', () => {
    const result = validator.validate({
      measures: ['Orders.count'],
      dimensions: ['Orders.unknown'],
    });
    expect(result.valid).toBe(false);
  });

  test('allows empty measures with dimensions', () => {
    const result = validator.validate({
      measures: [],
      dimensions: ['Orders.status'],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects query with no measures and no dimensions', () => {
    const result = validator.validate({
      measures: [],
      dimensions: [],
    });
    expect(result.valid).toBe(false);
  });
});
