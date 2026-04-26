import { DefaultSearchRanker, computeTextMatch, computeRecency } from '../src/ranking/DefaultSearchRanker';
import type { SearchRankingSignals } from '../src/types';

describe('DefaultSearchRanker', () => {
  describe('rank()', () => {
    test('returns weighted blend of all signals with default weights', () => {
      const ranker = new DefaultSearchRanker();
      const score = ranker.rank({
        similarity: 1.0,
        qualityScore: 1.0,
        textMatch: 1.0,
        feedbackScore: 1.0,
        recency: 1.0,
      });
      // All signals 1.0 → blended = 1.0 regardless of weights
      expect(score).toBeCloseTo(1.0, 5);
    });

    test('gives 0 when all signals are 0', () => {
      const ranker = new DefaultSearchRanker();
      const score = ranker.rank({
        similarity: 0,
        qualityScore: 0,
        textMatch: 0,
        feedbackScore: 0,
        recency: 0,
      });
      expect(score).toBe(0);
    });

    test('weights similarity highest by default (0.50)', () => {
      const ranker = new DefaultSearchRanker();
      // Only similarity is 1.0, rest are 0
      const score = ranker.rank({
        similarity: 1.0,
        qualityScore: 0,
        textMatch: 0,
        feedbackScore: 0,
        recency: 0,
      });
      // 1.0 * 0.50 / 1.0 = 0.50
      expect(score).toBeCloseTo(0.50, 5);
    });

    test('excludes undefined feedbackScore from weight normalisation', () => {
      const ranker = new DefaultSearchRanker();
      // Without feedback → active weights: 0.50 + 0.15 + 0.15 + 0.10 = 0.90
      // Each weight is divided by 0.90 for normalisation
      const score = ranker.rank({
        similarity: 1.0,
        qualityScore: 0,
        textMatch: 0,
        recency: 0,
        // feedbackScore intentionally omitted
      } as SearchRankingSignals);
      // similarity * (0.50 / 0.90) ≈ 0.5556
      expect(score).toBeCloseTo(0.50 / 0.90, 3);
    });

    test('respects custom weights', () => {
      const ranker = new DefaultSearchRanker({
        similarity: 0.0,
        qualityScore: 1.0,
        textMatch: 0.0,
        feedbackScore: 0.0,
        recency: 0.0,
      });
      const score = ranker.rank({
        similarity: 0.5,
        qualityScore: 0.8,
        textMatch: 0.9,
        feedbackScore: 0.1,
        recency: 0.3,
      });
      // Only qualityScore matters → 0.8
      expect(score).toBeCloseTo(0.8, 5);
    });

    test('partial custom weights merge with defaults', () => {
      const ranker = new DefaultSearchRanker({ similarity: 0.80 });
      // Other weights keep defaults: quality 0.15, text 0.15, feedback 0.10, recency 0.10
      const score = ranker.rank({
        similarity: 1.0,
        qualityScore: 0,
        textMatch: 0,
        feedbackScore: 0,
        recency: 0,
      });
      // Total weights: 0.80+0.15+0.15+0.10+0.10 = 1.30
      // 1.0 * (0.80 / 1.30)
      expect(score).toBeCloseTo(0.80 / 1.30, 3);
    });

    test('returns 0 when all weights are 0', () => {
      const ranker = new DefaultSearchRanker({
        similarity: 0,
        qualityScore: 0,
        textMatch: 0,
        feedbackScore: 0,
        recency: 0,
      });
      const score = ranker.rank({
        similarity: 1.0,
        qualityScore: 1.0,
        textMatch: 1.0,
        feedbackScore: 1.0,
        recency: 1.0,
      });
      expect(score).toBe(0);
    });
  });
});

describe('computeTextMatch', () => {
  test('returns 1.0 when query contains exact cube short name', () => {
    expect(computeTextMatch('show me orders', 'Orders', [])).toBe(1.0);
  });

  test('case-insensitive cube name match', () => {
    expect(computeTextMatch('ORDERS total', 'Orders', [])).toBe(1.0);
  });

  test('returns partial score for camelCase word fragments', () => {
    const score = computeTextMatch('show me price stats', 'PricePaid', []);
    // "price" matches out of ["price", "paid"] → 1/2 = 0.5, capped at 0.8
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.8);
  });

  test('returns 0 when no match', () => {
    expect(computeTextMatch('totally unrelated query', 'Orders', ['Orders.revenue'])).toBe(0);
  });

  test('matches member names when cube name does not match', () => {
    const score = computeTextMatch('show revenue', 'Orders', ['Orders.revenue', 'Orders.count']);
    // "revenue" matches 1 of 2 members → score up to 0.6
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.6);
  });

  test('matches camelCase member words', () => {
    const score = computeTextMatch('show created data', 'Orders', ['Orders.createdAt']);
    // "created" matches as a camelCase fragment → partial credit
    expect(score).toBeGreaterThan(0);
  });

  test('returns 0 for empty query', () => {
    expect(computeTextMatch('', 'Orders', ['Orders.revenue'])).toBe(0);
  });

  test('handles dotted cube names', () => {
    expect(computeTextMatch('show orders', 'schema.Orders', [])).toBe(1.0);
  });
});

describe('computeRecency', () => {
  test('returns 1.0 for just-updated (future timestamp)', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    expect(computeRecency(future)).toBe(1);
  });

  test('returns ~0.5 at the half-life', () => {
    const halfLifeMs = 7 * 24 * 60 * 60 * 1000;
    const halfLifeAgo = new Date(Date.now() - halfLifeMs).toISOString();
    expect(computeRecency(halfLifeAgo)).toBeCloseTo(0.5, 1);
  });

  test('returns near 0 for very old timestamps', () => {
    const veryOld = new Date('2000-01-01').toISOString();
    expect(computeRecency(veryOld)).toBeLessThan(0.001);
  });

  test('accepts custom half-life', () => {
    const oneHourMs = 60 * 60 * 1000;
    const oneHourAgo = new Date(Date.now() - oneHourMs).toISOString();
    expect(computeRecency(oneHourAgo, oneHourMs)).toBeCloseTo(0.5, 1);
  });
});
