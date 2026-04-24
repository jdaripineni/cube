/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Default NLQ → Cube Query translator with self-healing retry loop.
 */

import { v4 as uuidv4 } from 'uuid';

import type {
  CubeMetaConfig,
  CubeQuery,
  TranslationContext,
  TranslationResult,
  LLMProvider,
  EmbeddingProvider,
  VectorStore,
  FeedbackStore,
  SchemaSerializer,
  SearchOptions,
} from '../types';
import { QueryValidator } from '../validation/QueryValidator';
import { PromptBuilder } from './PromptBuilder';

const CUBE_QUERY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    measures: { type: 'array', items: { type: 'string' } },
    dimensions: { type: 'array', items: { type: 'string' } },
    filters: { type: 'array', items: { type: 'object' } },
    timeDimensions: { type: 'array', items: { type: 'object' } },
    segments: { type: 'array', items: { type: 'string' } },
    order: { type: 'object' },
    limit: { type: 'integer' },
  },
};

export interface DefaultTranslatorDeps {
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  feedbackStore: FeedbackStore | null;
  serializer: SchemaSerializer;
  compiledMeta: CubeMetaConfig[];
}

export class DefaultTranslator {
  private deps: DefaultTranslatorDeps;
  private promptBuilder: PromptBuilder;
  private validator: QueryValidator;

  constructor(deps: DefaultTranslatorDeps) {
    this.deps = deps;
    this.promptBuilder = new PromptBuilder();
    this.validator = new QueryValidator(deps.compiledMeta);
  }

  updateMeta(cubes: CubeMetaConfig[]): void {
    this.deps.compiledMeta = cubes;
    this.validator = new QueryValidator(cubes);
  }

  async translate(nlq: string, context?: TranslationContext): Promise<TranslationResult> {
    const startTime = Date.now();
    const maxRetries = context?.maxRetries ?? 3;
    const translationId = uuidv4();

    // Step 1: Embed the NLQ
    const [nlqEmbedding] = await this.deps.embeddingProvider.embed([nlq]);

    // Step 2: Retrieve relevant schemas
    const searchOpts: SearchOptions = { topK: 10, scoreThreshold: 0.5 };
    const results = await this.deps.vectorStore.search(nlqEmbedding, searchOpts);
    const relevantCubes = results.map(r => r.metadata.metaJson as unknown as CubeMetaConfig);

    if (relevantCubes.length === 0) {
      return {
        query: null,
        confidence: 0,
        schemasUsed: [],
        translationId,
        validationErrors: ['No relevant schemas found for this query'],
        retryCount: 0,
      };
    }

    // Step 3: Serialize schemas
    const serialized = this.deps.serializer.serialize(relevantCubes, {
      maxTokens: context?.maxTokens,
    });

    // Step 4: Get few-shot examples + negative patterns from feedback
    let fewShotExamples: any[] = [];
    let negativePatterns: any[] = [];
    if (this.deps.feedbackStore) {
      try {
        fewShotExamples = await this.deps.feedbackStore.getPositiveExamples({
          similarTo: nlqEmbedding,
          topK: 5,
        });
        negativePatterns = await this.deps.feedbackStore.getNegativePatterns();
      } catch {
        // Feedback store unavailable — continue without examples
      }
    }

    // Step 5: Self-healing retry loop
    let lastErrors: Array<{ message: string; suggestions?: string[] }> = [];
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      const { systemPrompt, userPrompt } = this.promptBuilder.build({
        nlq,
        schemas: serialized,
        conversationHistory: context?.conversationHistory,
        fewShotExamples,
        negativePatterns,
        previousErrors: lastErrors.length > 0 ? lastErrors : undefined,
      });

      let generatedQuery: CubeQuery;
      try {
        generatedQuery = await this.deps.llmProvider.completeStructured<CubeQuery>(
          userPrompt,
          CUBE_QUERY_JSON_SCHEMA,
          {
            systemPrompt,
            temperature: retryCount === 0 ? 0.1 : 0.3,
          }
        );
      } catch (err: any) {
        lastErrors = [{ message: `LLM response parse error: ${err.message}` }];
        retryCount++;
        continue;
      }

      // Step 6: Validate
      const validation = this.validator.validate(generatedQuery);

      if (validation.valid) {
        const latencyMs = Date.now() - startTime;
        const confidence = this.computeConfidence(results, retryCount);

        // Save to feedback store
        if (this.deps.feedbackStore) {
          try {
            await this.deps.feedbackStore.save({
              translationId,
              timestamp: new Date(),
              nlq,
              generatedQuery,
              schemasUsed: results.map(r => r.metadata.cubeName),
              rating: 'pending',
              latencyMs,
              retryCount,
            });
          } catch {
            // Non-critical
          }
        }

        return {
          query: generatedQuery,
          confidence,
          schemasUsed: results.map(r => r.metadata.cubeName),
          translationId,
          retryCount,
        };
      }

      // Prepare errors for next retry
      lastErrors = validation.errors.map(e => ({
        message: e.message,
        suggestions: validation.suggestions,
      }));
      retryCount++;
    }

    // All retries exhausted
    const latencyMs = Date.now() - startTime;
    if (this.deps.feedbackStore) {
      try {
        await this.deps.feedbackStore.save({
          translationId,
          timestamp: new Date(),
          nlq,
          generatedQuery: null,
          schemasUsed: results.map(r => r.metadata.cubeName),
          rating: 'pending',
          latencyMs,
          retryCount: maxRetries,
        });
      } catch {
        // Non-critical
      }
    }

    return {
      query: null,
      confidence: 0,
      schemasUsed: results.map(r => r.metadata.cubeName),
      translationId,
      validationErrors: lastErrors.map(e => e.message),
      retryCount: maxRetries,
    };
  }

  private computeConfidence(searchResults: any[], retryCount: number): number {
    if (searchResults.length === 0) return 0;
    const avgSimilarity = searchResults.reduce((s: number, r: any) => s + r.similarity, 0) / searchResults.length;
    const retryPenalty = retryCount * 0.1;
    return Math.max(0, Math.min(1, avgSimilarity - retryPenalty));
  }
}
