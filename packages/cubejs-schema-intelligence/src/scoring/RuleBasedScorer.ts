/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Rule-based scoring engine for cube schema quality.
 */

import type {
  CubeMetaConfig,
  ScoringStrategy,
  ScoringCriterion,
  ScoringCriterionConfig,
  ScoreResult,
  EnrichmentSuggestion,
  EnrichmentIssue,
  ScoringConfig,
} from '../types';

const VAGUE_DESCRIPTIONS = new Set([
  'the count', 'total value', 'the status', 'type value',
  'the name', 'the id', 'value', 'count', 'total', 'type',
  'name', 'id', 'status', 'description', 'the description',
]);

function isVagueDescription(desc?: string): boolean {
  if (!desc) return true;
  const normalized = desc.trim().toLowerCase().replace(/[.!?]+$/, '');
  return normalized.length < 5 || VAGUE_DESCRIPTIONS.has(normalized);
}

// ── Built-in Criteria ──

function cubeDescriptionCriterion(cube: CubeMetaConfig): number {
  if (!cube.description) return 0;
  if (isVagueDescription(cube.description)) return 0.3;
  return cube.description.length > 30 ? 1.0 : 0.6;
}

function measureDescriptionsCriterion(cube: CubeMetaConfig): number {
  const measures = cube.measures || [];
  if (measures.length === 0) return 1.0;
  const described = measures.filter(m => m.description && !isVagueDescription(m.description));
  return described.length / measures.length;
}

function dimensionDescriptionsCriterion(cube: CubeMetaConfig): number {
  const dims = cube.dimensions || [];
  if (dims.length === 0) return 1.0;
  const described = dims.filter(d => d.description && !isVagueDescription(d.description));
  return described.length / dims.length;
}

function typeCoverageCriterion(cube: CubeMetaConfig): number {
  const allMembers = [...(cube.measures || []), ...(cube.dimensions || [])];
  if (allMembers.length === 0) return 1.0;
  const typed = allMembers.filter(m => m.type && m.type.length > 0);
  return typed.length / allMembers.length;
}

function enumValuesListedCriterion(cube: CubeMetaConfig): number {
  const dims = cube.dimensions || [];
  const categoricals = dims.filter(d => d.type === 'string');
  if (categoricals.length === 0) return 1.0;
  const withEnums = categoricals.filter(d => {
    if (!d.description) return false;
    const desc = d.description.toLowerCase();
    return desc.includes('values:') || desc.includes('options:') ||
           desc.includes('one of:') || desc.includes('enum:');
  });
  return withEnums.length / categoricals.length;
}

function datasourceExplicitCriterion(cube: CubeMetaConfig): number {
  const meta = cube as any;
  return meta.dataSource || meta.datasource ? 1.0 : 0;
}

function joinDescriptionsCriterion(cube: CubeMetaConfig): number {
  const joins = cube.joins || [];
  if (joins.length === 0) return 1.0;
  const described = joins.filter(j => j.sql && j.sql.length > 0);
  return described.length / joins.length;
}

const DEFAULT_CRITERIA: ScoringCriterion[] = [
  { name: 'cube_description', weight: 0.15, evaluate: cubeDescriptionCriterion },
  { name: 'measure_descriptions', weight: 0.20, evaluate: measureDescriptionsCriterion },
  { name: 'dimension_descriptions', weight: 0.20, evaluate: dimensionDescriptionsCriterion },
  { name: 'type_coverage', weight: 0.15, evaluate: typeCoverageCriterion },
  { name: 'enum_values_listed', weight: 0.10, evaluate: enumValuesListedCriterion },
  { name: 'datasource_explicit', weight: 0.10, evaluate: datasourceExplicitCriterion },
  { name: 'join_descriptions', weight: 0.10, evaluate: joinDescriptionsCriterion },
];

// ── Enrichment Advisor ──

function generateSuggestions(cube: CubeMetaConfig, scoreDimensions: Record<string, number>): EnrichmentSuggestion[] {
  const suggestions: EnrichmentSuggestion[] = [];

  if (scoreDimensions.cube_description < 0.5) {
    suggestions.push({
      cubeName: cube.name,
      issue: 'missing_description' as EnrichmentIssue,
      severity: 'error',
      suggestion: `Add a top-level description to cube '${cube.name}' explaining its data and purpose.`,
    });
  }

  for (const m of cube.measures || []) {
    if (!m.description || isVagueDescription(m.description)) {
      suggestions.push({
        cubeName: cube.name,
        member: m.name,
        issue: 'vague_description' as EnrichmentIssue,
        severity: 'warning',
        suggestion: `Measure '${m.name}': add a specific description stating what is aggregated, the method, and unit.`,
      });
    }
  }

  for (const d of cube.dimensions || []) {
    if (!d.description || isVagueDescription(d.description)) {
      suggestions.push({
        cubeName: cube.name,
        member: d.name,
        issue: 'vague_description' as EnrichmentIssue,
        severity: 'warning',
        suggestion: `Dimension '${d.name}': add a specific description with business meaning.`,
      });
    }
    if (d.type === 'string' && d.description && !d.description.toLowerCase().includes('values:')) {
      suggestions.push({
        cubeName: cube.name,
        member: d.name,
        issue: 'missing_enum_values' as EnrichmentIssue,
        severity: 'info',
        suggestion: `Dimension '${d.name}': if categorical, list known values (e.g., 'Values: active, inactive, pending').`,
      });
    }
  }

  return suggestions;
}

// ── Scorer ──

/**
 * Rule-based scorer that evaluates cube schema quality for LLM consumption.
 * Each cube gets a 0–1 score based on weighted criteria (descriptions, types, enums, etc.).
 * Cubes scoring above the threshold are marked `consumable`.
 *
 * @example
 * ```ts
 * const scorer = new RuleBasedScorer(); // default criteria + 0.7 threshold
 * const result = scorer.score(cubeMetaConfig);
 * console.log(result.overall);      // 0.85
 * console.log(result.consumable);   // true
 * console.log(result.suggestions);  // [{issue: 'missing_description', ...}]
 * ```
 *
 * @example Custom criteria weights:
 * ```ts
 * const scorer = new RuleBasedScorer({
 *   threshold: 0.6,
 *   criteria: [
 *     { name: 'measure_descriptions', weight: 0.5 },
 *     { name: 'dimension_descriptions', weight: 0.5 },
 *   ],
 * });
 * ```
 */
export class RuleBasedScorer implements ScoringStrategy {
  private criteria: ScoringCriterion[];
  private threshold: number;

  /**
   * @param config - Optional scoring configuration.
   *   `config.threshold` — minimum score for a cube to be "consumable". Default: `0.7`.
   *   `config.criteria` — override default criteria and weights.
   *     Available criteria: `cube_description`, `measure_descriptions`, `dimension_descriptions`,
   *     `type_coverage`, `enum_values_listed`, `datasource_explicit`, `join_descriptions`.
   * @throws Error if an unknown criterion name is provided.
   */
  constructor(config?: ScoringConfig) {
    this.threshold = config?.threshold ?? 0.7;

    if (config?.criteria && config.criteria.length > 0) {
      this.criteria = config.criteria.map((c: ScoringCriterionConfig) => {
        const builtin = DEFAULT_CRITERIA.find(d => d.name === c.name);
        if (!builtin) {
          throw new Error(`Unknown scoring criterion: ${c.name}. Available: ${DEFAULT_CRITERIA.map(d => d.name).join(', ')}`);
        }
        return { ...builtin, weight: c.weight };
      });
    } else {
      this.criteria = [...DEFAULT_CRITERIA];
    }

    // Normalize weights to sum to 1
    const totalWeight = this.criteria.reduce((s, c) => s + c.weight, 0);
    if (totalWeight > 0) {
      this.criteria = this.criteria.map(c => ({ ...c, weight: c.weight / totalWeight }));
    }
  }

  /**
   * Score a single cube's metadata for LLM readiness.
   * @param cube - Cube metadata from schema compilation.
   * @returns Score result with `overall` (0–1), per-criterion `dimensions`, `consumable` flag, and `suggestions`.
   */
  score(cube: CubeMetaConfig): ScoreResult {
    const dimensions: Record<string, number> = {};
    let overall = 0;

    for (const criterion of this.criteria) {
      const score = Math.max(0, Math.min(1, criterion.evaluate(cube)));
      dimensions[criterion.name] = score;
      overall += score * criterion.weight;
    }

    overall = Math.round(overall * 1000) / 1000;

    const suggestions = generateSuggestions(cube, dimensions);

    return {
      cubeName: cube.name,
      overall,
      dimensions,
      consumable: overall >= this.threshold,
      suggestions,
    };
  }
}
