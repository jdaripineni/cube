/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Prompt builder — constructs LLM prompts with few-shot examples and schema context.
 */

import type {
  CubeQuery,
  ConversationMessage,
  FeedbackEntry,
  NegativePattern,
} from '../types';

const CUBE_QUERY_GRAMMAR = `You are a Cube.js query generator. Given a natural language question and a set of available cube schemas, generate a valid Cube.js REST API query as JSON.

Rules:
- Use ONLY measures, dimensions, segments, and time dimensions that exist in the provided schemas.
- measures: array of fully qualified names like "CubeName.measureName"
- dimensions: array of fully qualified names like "CubeName.dimensionName"
- timeDimensions: array of objects with { dimension, dateRange, granularity }
  - dateRange can be: "last week", "last month", "last 7 days", "last 30 days", "today", "yesterday", "this month", "this year", or [startDate, endDate]
  - granularity can be: "day", "week", "month", "year", "hour", "minute", or null (for no granularity)
- filters: array of { member, operator, values }
  - operators: equals, notEquals, contains, notContains, gt, gte, lt, lte, set, notSet, inDateRange, notInDateRange
- order: object mapping member names to "asc" or "desc"
- limit: integer (optional)
- Do NOT invent member names. Only use what is in the schemas.
- If the question is ambiguous, prefer the most specific cube that matches.
- For time-based questions, always use timeDimensions, not filters.
`;

export interface PromptBuildOptions {
  nlq: string;
  schemas: string;
  conversationHistory?: ConversationMessage[];
  fewShotExamples?: FeedbackEntry[];
  negativePatterns?: NegativePattern[];
  previousErrors?: Array<{ message: string; suggestions?: string[] }>;
  customSystemPrompt?: string;
}

/**
 * Constructs LLM prompts for NLQ translation with schema context, few-shot examples,
 * negative patterns (common mistakes), and self-healing error feedback.
 *
 * The system prompt contains the Cube.js query grammar rules.
 * The user prompt assembles: examples → schemas → history → errors → question.
 */
export class PromptBuilder {
  /**
   * Build a system + user prompt pair for the LLM.
   * @param opts - Prompt build options including the NLQ, serialized schemas,
   *   conversation history, few-shot examples, and any previous validation errors.
   * @returns `{ systemPrompt, userPrompt }` ready to pass to an LLM provider.
   */
  build(opts: PromptBuildOptions): { systemPrompt: string; userPrompt: string } {
    const systemParts: string[] = [
      opts.customSystemPrompt || CUBE_QUERY_GRAMMAR,
    ];

    // Negative patterns (common mistakes to avoid)
    if (opts.negativePatterns && opts.negativePatterns.length > 0) {
      systemParts.push('\nKNOWN MISTAKES TO AVOID:');
      for (const p of opts.negativePatterns.slice(0, 10)) {
        systemParts.push(`- ${p.pattern}`);
      }
    }

    const userParts: string[] = [];

    // Few-shot examples
    if (opts.fewShotExamples && opts.fewShotExamples.length > 0) {
      userParts.push('EXAMPLES OF SUCCESSFUL TRANSLATIONS:');
      for (const ex of opts.fewShotExamples.slice(0, 5)) {
        userParts.push(`Q: ${ex.nlq}`);
        userParts.push(`A: ${JSON.stringify(ex.correctedQuery || ex.generatedQuery)}`);
        userParts.push('');
      }
    }

    // Available schemas
    userParts.push('AVAILABLE CUBE SCHEMAS:');
    userParts.push(opts.schemas);
    userParts.push('');

    // Conversation history
    if (opts.conversationHistory && opts.conversationHistory.length > 0) {
      userParts.push('CONVERSATION HISTORY:');
      for (const msg of opts.conversationHistory.slice(-6)) {
        userParts.push(`${msg.role}: ${msg.content}`);
      }
      userParts.push('');
    }

    // Previous errors (for self-healing retry)
    if (opts.previousErrors && opts.previousErrors.length > 0) {
      userParts.push('YOUR PREVIOUS ATTEMPT HAD ERRORS:');
      for (const err of opts.previousErrors) {
        userParts.push(`- ${err.message}`);
        if (err.suggestions) {
          for (const s of err.suggestions) {
            userParts.push(`  Suggestion: ${s}`);
          }
        }
      }
      userParts.push('Please fix these errors in your response.');
      userParts.push('');
    }

    // The actual question
    userParts.push(`QUESTION: ${opts.nlq}`);
    userParts.push('');
    userParts.push('Generate ONLY the Cube.js query JSON. No explanation.');

    return {
      systemPrompt: systemParts.join('\n'),
      userPrompt: userParts.join('\n'),
    };
  }
}
