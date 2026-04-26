/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Default search ranker — weighted linear blend of ranking signals.
 *
 * Industry-standard signals for schema search ranking:
 *
 * | Signal          | What it captures                                       | Default weight |
 * |-----------------|--------------------------------------------------------|:--------------:|
 * | similarity      | Semantic relevance (vector cosine distance)            | 0.50           |
 * | qualityScore    | Documentation completeness (descriptions, types, etc.) | 0.15           |
 * | textMatch       | Direct keyword/name match (cube/member names in query) | 0.15           |
 * | feedbackScore   | Aggregated user feedback from past translations        | 0.10           |
 * | recency         | How recently the schema was indexed                    | 0.10           |
 *
 * All weights are normalised to sum to 1. Missing signals (e.g. no feedback
 * store) are excluded from normalisation so they don't dilute other weights.
 *
 * Override by implementing {@link SearchRanker} for custom logic (e.g.
 * learning-to-rank, tenant-specific boosting).
 */

import type { SearchRanker, SearchRankingSignals, SearchRankerWeights } from '../types';

const DEFAULT_WEIGHTS: Required<SearchRankerWeights> = {
  similarity: 0.50,
  qualityScore: 0.15,
  textMatch: 0.15,
  feedbackScore: 0.10,
  recency: 0.10,
};

/**
 * Weighted-blend search ranker.
 *
 * @example Use the default weights:
 * ```ts
 * const ranker = new DefaultSearchRanker();
 * ```
 *
 * @example Customise weights (automatically normalised):
 * ```ts
 * const ranker = new DefaultSearchRanker({
 *   similarity: 0.40,
 *   qualityScore: 0.30,
 *   textMatch: 0.10,
 *   feedbackScore: 0.10,
 *   recency: 0.10,
 * });
 * ```
 */
export class DefaultSearchRanker implements SearchRanker {
  private weights: Required<SearchRankerWeights>;

  constructor(weights?: SearchRankerWeights) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Compute a final ranking score from the available signals.
   * Normalises weights on-the-fly to handle missing optional signals
   * (e.g. feedbackScore is `undefined` when no feedback store is configured).
   */
  rank(signals: SearchRankingSignals): number {
    const entries: [number, number][] = [
      [signals.similarity, this.weights.similarity],
      [signals.qualityScore, this.weights.qualityScore],
      [signals.textMatch, this.weights.textMatch],
      [signals.recency, this.weights.recency],
    ];

    // Only include feedbackScore if it was actually provided.
    if (signals.feedbackScore !== undefined) {
      entries.push([signals.feedbackScore, this.weights.feedbackScore]);
    }

    // Normalise so the active weights sum to 1.
    const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0);
    if (totalWeight === 0) return 0;

    return entries.reduce((sum, [value, weight]) => sum + value * (weight / totalWeight), 0);
  }
}

/**
 * Compute a text-match score between a query and a cube's name + member names.
 * Returns 0–1: 1 = query contains the exact cube name, fractional for member matches.
 */
export function computeTextMatch(query: string, cubeName: string, memberNames: string[]): number {
  const q = query.toLowerCase();
  // Cube name match is the strongest signal.
  const shortName = cubeName.includes('.') ? cubeName.split('.').pop()! : cubeName;
  if (q.includes(shortName.toLowerCase())) return 1.0;

  // Check for camelCase/PascalCase word fragments (e.g. "PricePaid" → ["price", "paid"]).
  const cubeWords = shortName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_]+/);
  const cubeWordMatches = cubeWords.filter(w => w.length > 2 && q.includes(w)).length;
  if (cubeWordMatches > 0) {
    const cubeNameBoost = cubeWordMatches / cubeWords.length;
    // Partial cube name match: up to 0.8.
    return Math.min(0.8, cubeNameBoost);
  }

  // Member name matches.
  let memberMatches = 0;
  for (const memberFqn of memberNames) {
    const member = memberFqn.includes('.') ? memberFqn.split('.').pop()! : memberFqn;
    const memberLower = member.toLowerCase();
    // Direct match.
    if (q.includes(memberLower)) {
      memberMatches++;
      continue;
    }
    // camelCase word match.
    const memberWords = member.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_]+/);
    if (memberWords.some(w => w.length > 2 && q.includes(w))) {
      memberMatches += 0.5;
    }
  }

  if (memberMatches > 0 && memberNames.length > 0) {
    // Member matches: up to 0.6 (less than cube name match).
    return Math.min(0.6, (memberMatches / memberNames.length) * 0.6);
  }

  return 0;
}

/**
 * Compute a recency score (0–1) from an ISO timestamp.
 * Uses an exponential decay: score halves every `halfLifeMs`.
 * Default half-life: 7 days.
 */
export function computeRecency(lastUpdated: string, halfLifeMs = 7 * 24 * 60 * 60 * 1000): number {
  const age = Date.now() - new Date(lastUpdated).getTime();
  if (age <= 0) return 1;
  // Exponential decay: score = 2^(-age/halfLife)
  return Math.pow(2, -age / halfLifeMs);
}
