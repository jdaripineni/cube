import {
  OpenAILLMProvider,
  OllamaLLMProvider,
  MODEL_REGISTRY,
  resolveLLMProvider,
} from '../src/llm/LLMProviders';

describe('MODEL_REGISTRY', () => {
  test('contains expected model entries', () => {
    expect(MODEL_REGISTRY.gpt_4o).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(MODEL_REGISTRY.claude_4_sonnet).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
    expect(MODEL_REGISTRY.o4_mini).toEqual({ provider: 'openai', model: 'o4-mini' });
  });

  test('all entries have provider and model', () => {
    for (const [key, val] of Object.entries(MODEL_REGISTRY)) {
      expect(val.provider).toBeTruthy();
      expect(val.model).toBeTruthy();
    }
  });
});

describe('OpenAILLMProvider', () => {
  test('throws without apiKey', () => {
    expect(() => new OpenAILLMProvider({ provider: 'openai' })).toThrow('apiKey');
  });

  test('constructs with valid config', () => {
    const provider = new OpenAILLMProvider({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
    expect(provider).toBeDefined();
  });

  test('complete calls fetch with correct shape', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"measures":["Orders.count"]}' } }],
      }),
    });
    global.fetch = mockFetch;

    const provider = new OpenAILLMProvider({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    });

    const result = await provider.complete('test prompt', {
      systemPrompt: 'You are a helper',
      temperature: 0.5,
    });

    expect(result).toBe('{"measures":["Orders.count"]}');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.temperature).toBe(0.5);
  });

  test('complete throws on API error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const provider = new OpenAILLMProvider({
      provider: 'openai',
      apiKey: 'bad-key',
    });

    await expect(provider.complete('test')).rejects.toThrow('OpenAI API error (401)');
  });

  test('completeStructured parses JSON from response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '```json\n{"measures":["A.count"]}\n```' } }],
      }),
    });

    const provider = new OpenAILLMProvider({
      provider: 'openai',
      apiKey: 'test-key',
    });

    const result = await provider.completeStructured('test', {});
    expect(result).toEqual({ measures: ['A.count'] });
  });
});

describe('OllamaLLMProvider', () => {
  test('constructs with defaults', () => {
    const provider = new OllamaLLMProvider({ provider: 'ollama' });
    expect(provider).toBeDefined();
  });

  test('complete calls Ollama endpoint', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'hello' } }),
    });
    global.fetch = mockFetch;

    const provider = new OllamaLLMProvider({ provider: 'ollama', model: 'llama3.1' });
    const result = await provider.complete('say hi');

    expect(result).toBe('hello');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
  });
});

describe('resolveLLMProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CUBEJS_LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns OpenAI provider for explicit openai config', async () => {
    const provider = await resolveLLMProvider({
      llm: { provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' },
    });
    expect(provider).toBeInstanceOf(OpenAILLMProvider);
  });

  test('returns Ollama provider for explicit ollama config', async () => {
    const provider = await resolveLLMProvider({
      llm: { provider: 'ollama', model: 'llama3.1' },
    });
    expect(provider).toBeInstanceOf(OllamaLLMProvider);
  });

  test('throws for unknown provider', async () => {
    await expect(
      resolveLLMProvider({ llm: { provider: 'unknown' } })
    ).rejects.toThrow('Unknown LLM provider');
  });

  test('resolves predefined model name gpt_4o', async () => {
    process.env.CUBEJS_LLM_API_KEY = 'test-key';
    const provider = await resolveLLMProvider({ llm: 'gpt_4o' });
    expect(provider).toBeInstanceOf(OpenAILLMProvider);
  });

  test('throws for unknown predefined model name', async () => {
    await expect(
      resolveLLMProvider({ llm: 'nonexistent_model_xyz' })
    ).rejects.toThrow('Unknown predefined LLM model');
  });

  test('returns null when no LLM is available', async () => {
    // Mock fetch to fail (no Ollama)
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const provider = await resolveLLMProvider(undefined);
    expect(provider).toBeNull();
  });
});
