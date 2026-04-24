import { PromptBuilder } from '../src/translator/PromptBuilder';

describe('PromptBuilder', () => {
  const schemas = 'Cube: Orders\nDescription: Customer orders\nMeasures: count(count), totalAmount(sum)\nDimensions: status(string), createdAt(time)';

  test('builds a prompt with system and user sections', () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({ nlq: 'How many orders last month?', schemas });
    expect(prompt.systemPrompt.length).toBeGreaterThan(0);
    expect(prompt.userPrompt.length).toBeGreaterThan(0);
  });

  test('includes schema context in user prompt', () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({ nlq: 'How many orders?', schemas });
    expect(prompt.userPrompt).toContain('Orders');
  });

  test('includes few-shot examples when provided', () => {
    const builder = new PromptBuilder();
    const fewShotExamples = [{
      translationId: 'ex1',
      timestamp: new Date(),
      nlq: 'Count users',
      generatedQuery: { measures: ['Users.count'] },
      schemasUsed: ['Users'],
      rating: 'positive' as const,
      latencyMs: 100,
      retryCount: 0,
    }];
    const prompt = builder.build({ nlq: 'How many orders?', schemas, fewShotExamples });
    expect(prompt.userPrompt).toContain('Count users');
  });

  test('includes conversation history', () => {
    const builder = new PromptBuilder();
    const conversationHistory = [
      { role: 'user' as const, content: 'Show me revenue' },
      { role: 'assistant' as const, content: '{"measures":["Orders.totalAmount"]}' },
    ];
    const prompt = builder.build({ nlq: 'Now filter by status', schemas, conversationHistory });
    expect(prompt.userPrompt).toContain('Show me revenue');
  });

  test('includes error context for self-healing', () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      nlq: 'Count orders',
      schemas,
      previousErrors: [{ message: 'Unknown measure Orders.cont', suggestions: ['Orders.count'] }],
    });
    expect(prompt.userPrompt).toContain('Orders.cont');
    expect(prompt.userPrompt).toContain('Unknown measure');
  });
});
