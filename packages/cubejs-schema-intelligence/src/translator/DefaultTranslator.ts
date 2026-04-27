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
  SearchConfig,
  SearchRanker,
  VectorSearchResult,
} from '../types';
import { computeTextMatch, computeRecency } from '../ranking/DefaultSearchRanker';
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
  searchConfig?: SearchConfig;
  /** Optional ranker for multi-signal re-ranking after vector retrieval. */
  searchRanker?: SearchRanker;
}

/**
 * Default NLQ → Cube Query translator with self-healing retry loop.
 *
 * Pipeline:
 * 1. Embed the natural language question
 * 2. Vector search for the most relevant cube schemas
 * 3. Serialize schemas into compact text for the LLM context
 * 4. Retrieve few-shot examples from the feedback store
 * 5. Build prompt and call the LLM for structured JSON output
 * 6. Validate the generated query against compiled metadata
 * 7. If validation fails, retry with error context (self-healing)
 *
 * @example
 * ```ts
 * const translator = new DefaultTranslator({
 *   llmProvider, embeddingProvider, vectorStore,
 *   feedbackStore: null, serializer, compiledMeta: cubes,
 * });
 * const result = await translator.translate('show revenue by month');
 * if (result.query) {
 *   console.log(result.query);       // { measures: ['Orders.revenue'], timeDimensions: [...] }
 *   console.log(result.confidence);   // 0.87
 * }
 * ```
 */
export class DefaultTranslator {
  private deps: DefaultTranslatorDeps;
  private promptBuilder: PromptBuilder;
  private validator: QueryValidator;

  constructor(deps: DefaultTranslatorDeps) {
    this.deps = deps;
    this.promptBuilder = new PromptBuilder();
    this.validator = new QueryValidator(deps.compiledMeta);
  }

  /** Update the compiled cube metadata (called when schemas are recompiled). */
  updateMeta(cubes: CubeMetaConfig[]): void {
    this.deps.compiledMeta = cubes;
    this.validator = new QueryValidator(cubes);
  }

  /**
   * Translate a natural language question into a Cube.js query.
   * @param nlq - The question in natural language (e.g. "show revenue by month").
   * @param context - Optional context: conversation history, max retries, security context.
   * @returns Translation result with `query` (or null on failure), `confidence`, `schemasUsed`, and `translationId`.
   */
  async translate(nlq: string, context?: TranslationContext): Promise<TranslationResult> {
    const startTime = Date.now();
    const maxRetries = context?.maxRetries ?? 3;
    const translationId = uuidv4();

    // Step 1: Embed the NLQ
    const [nlqEmbedding] = await this.deps.embeddingProvider.embed([nlq]);

    // Step 2: Retrieve relevant schemas
    const sc = this.deps.searchConfig;
    const searchOpts: SearchOptions = {
      topK: sc?.defaultTopK ?? 10,
      scoreThreshold: sc?.defaultScoreThreshold ?? 0.5,
    };
    const results = await this.deps.vectorStore.search(nlqEmbedding, searchOpts);

    // Step 2b: Multi-signal re-ranking (if a ranker is configured)
    const rankedResults = this.deps.searchRanker
      ? await this.rerankResults(results, nlq)
      : results;

    const relevantCubes = rankedResults.map(r => r.metadata.metaJson as unknown as CubeMetaConfig);

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

    // Step 4b: Extract schema-authored examples from cube meta.ai.examples
    const schemaExamples: Array<{ nlq: string; query: any }> = [];
    for (const cube of relevantCubes) {
      const examples = cube.meta?.ai?.examples;
      if (Array.isArray(examples)) {
        for (const ex of examples) {
          if (ex.nlq && ex.query) {
            schemaExamples.push({ nlq: ex.nlq, query: ex.query });
          }
        }
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
        schemaExamples: schemaExamples.length > 0 ? schemaExamples : undefined,
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
        const confidence = this.computeConfidence(rankedResults, retryCount);

        // Save to feedback store (with embedding for similarity retrieval)
        if (this.deps.feedbackStore) {
          try {
            await this.deps.feedbackStore.save({
              translationId,
              timestamp: new Date(),
              nlq,
              generatedQuery,
              schemasUsed: rankedResults.map(r => r.metadata.cubeName),
              rating: 'pending',
              latencyMs,
              retryCount,
              nlqEmbedding: nlqEmbedding,
            } as any);
          } catch {
            // Non-critical
          }
        }

        return {
          query: generatedQuery,
          confidence,
          schemasUsed: rankedResults.map(r => r.metadata.cubeName),
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
          schemasUsed: rankedResults.map(r => r.metadata.cubeName),
          rating: 'pending',
          latencyMs,
          retryCount: maxRetries,
          nlqEmbedding: nlqEmbedding,
        } as any);
      } catch {
        // Non-critical
      }
    }

    return {
      query: null,
      confidence: 0,
      schemasUsed: rankedResults.map(r => r.metadata.cubeName),
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

  /**
   * Apply multi-signal re-ranking to vector store results.
   * Computes text match, quality, feedback, and recency signals,
   * then delegates to the configured SearchRanker for final scoring.
   */
  private async rerankResults(results: VectorSearchResult[], query: string): Promise<VectorSearchResult[]> {
    const ranker = this.deps.searchRanker!;
    if (results.length === 0) return results;

    // Optionally compute per-cube feedback scores.
    let feedbackMap: Map<string, number> | undefined;
    if (this.deps.feedbackStore) {
      try {
        const stats = await this.deps.feedbackStore.getStats();
        if (stats.topFailingCubes) {
          feedbackMap = new Map();
          for (const entry of stats.topFailingCubes) {
            feedbackMap.set(entry.cube, 1 - entry.failureRate);
          }
        }
      } catch {
        // Feedback unavailable
      }
    }

    const ranked = results.map(r => {
      const meta = r.metadata || {} as any;
      const metaJson = meta.metaJson as any;
      const memberNames = [
        ...((metaJson?.measures || []).map((m: any) => m.name).filter(Boolean)),
        ...((metaJson?.dimensions || []).map((d: any) => d.name).filter(Boolean)),
      ];

      const score = ranker.rank({
        similarity: r.similarity,
        qualityScore: meta.score || 0,
        textMatch: computeTextMatch(query, meta.cubeName, memberNames),
        feedbackScore: meta.cubeName ? feedbackMap?.get(meta.cubeName) : undefined,
        recency: computeRecency(meta.lastUpdated),
      });

      return { ...r, similarity: score };
    });

    ranked.sort((a, b) => b.similarity - a.similarity);
    return ranked;
  }
}
