import { MetricsCollector } from '../src/metrics/MetricsCollector';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  test('starts with zeroed counters', () => {
    expect(metrics.indexedCubesTotal).toBe(0);
    expect(metrics.searchRequestsTotal).toBe(0);
    expect(metrics.translateRequestsTotal).toBe(0);
    expect(metrics.feedbackPositive).toBe(0);
    expect(metrics.feedbackNegative).toBe(0);
    expect(metrics.feedbackCorrected).toBe(0);
  });

  test('recordSearch increments counter and tracks latency', () => {
    metrics.recordSearch(42);
    metrics.recordSearch(58);

    expect(metrics.searchRequestsTotal).toBe(2);
    expect(metrics.searchLatencyMs).toEqual([42, 58]);
  });

  test('recordTranslation tracks success rate', () => {
    metrics.recordTranslation(true);
    metrics.recordTranslation(true);
    metrics.recordTranslation(false);

    expect(metrics.translateRequestsTotal).toBe(3);
    expect(metrics.translateSuccessRate).toBeCloseTo(2 / 3, 2);
  });

  test('recordIndex updates cube counts', () => {
    metrics.recordIndex(100, 85);

    expect(metrics.indexedCubesTotal).toBe(100);
    expect(metrics.indexedCubesConsumable).toBe(85);
    expect(metrics.indexLastUpdated).toBeInstanceOf(Date);
  });

  test('recordFeedback increments correct counter', () => {
    metrics.recordFeedback('positive');
    metrics.recordFeedback('positive');
    metrics.recordFeedback('negative');
    metrics.recordFeedback('corrected');

    expect(metrics.feedbackPositive).toBe(2);
    expect(metrics.feedbackNegative).toBe(1);
    expect(metrics.feedbackCorrected).toBe(1);
  });

  test('toPrometheus produces valid text format', () => {
    metrics.recordSearch(10);
    metrics.recordTranslation(true);
    metrics.recordFeedback('positive');
    metrics.recordIndex(50, 40);

    const prom = metrics.toPrometheus();

    expect(prom).toContain('cubejs_ai_index_cubes_total 50');
    expect(prom).toContain('cubejs_ai_index_cubes_consumable 40');
    expect(prom).toContain('cubejs_ai_search_requests_total 1');
    expect(prom).toContain('cubejs_ai_translate_requests_total 1');
    expect(prom).toContain('cubejs_ai_feedback_total{type="positive"} 1');
    expect(prom).toContain('# HELP');
    expect(prom).toContain('# TYPE');
  });

  test('toJSON returns structured metrics', () => {
    metrics.recordIndex(10, 8);
    metrics.recordSearch(20);

    const json = metrics.toJSON();

    expect(json.indexedCubesTotal).toBe(10);
    expect(json.indexedCubesConsumable).toBe(8);
    expect(json.searchRequestsTotal).toBe(1);
  });

  test('search latency buffer caps at 1000 entries', () => {
    for (let i = 0; i < 1100; i++) {
      metrics.recordSearch(i);
    }

    expect(metrics.searchLatencyMs.length).toBeLessThanOrEqual(1000);
    expect(metrics.searchRequestsTotal).toBe(1100);
  });
});
