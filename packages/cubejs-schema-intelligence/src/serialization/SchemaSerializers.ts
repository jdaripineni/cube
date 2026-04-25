/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Schema serializers — token-optimized output for LLM context windows.
 */

import type { CubeMetaConfig, SchemaSerializer, SerializeOptions } from '../types';

const DEFAULT_OPTIONS: SerializeOptions = {
  format: 'compact',
  includeJoins: true,
  includePreAggs: false,
  includeSql: false,
};

/**
 * Token-optimized compact serializer for LLM context windows.
 * Produces a human-readable one-line-per-cube format that minimizes token usage
 * while preserving measure names, types, descriptions, and joins.
 *
 * @example Output format:
 * ```
 * Orders: Online sales data — measures[totalAmount(sum, Total order amount); orderCount(count)], dimensions[status(string, Values: active, cancelled)]
 * ```
 *
 * @example Usage:
 * ```ts
 * const serializer = new CompactSerializer();
 * const text = serializer.serialize(cubes, { maxTokens: 4000 });
 * ```
 */
export class CompactSerializer implements SchemaSerializer {
  /**
   * Serialize cubes into compact text.
   * @param cubes - Array of cube metadata.
   * @param options - Optional. `maxTokens` trims output to fit LLM context windows.
   *   `includeJoins` (default: `true`), `includePreAggs` (default: `false`).
   */
  serialize(cubes: CubeMetaConfig[], options?: Partial<SerializeOptions>): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const lines: string[] = [];

    for (const cube of cubes) {
      const parts: string[] = [];

      // Measures
      const measures = cube.measures || [];
      if (measures.length > 0) {
        const mList = measures
          .filter(m => m.isVisible !== false && m.public !== false)
          .map(m => {
            const desc = m.description ? `, ${m.description}` : '';
            return `${m.name}(${m.type}${desc})`;
          });
        parts.push(`measures[${mList.join('; ')}]`);
      }

      // Dimensions
      const dims = cube.dimensions || [];
      if (dims.length > 0) {
        const dList = dims
          .filter(d => d.isVisible !== false && d.public !== false)
          .map(d => {
            const pk = d.primaryKey ? ',PK' : '';
            const desc = d.description ? `, ${d.description}` : '';
            return `${d.name}(${d.type}${pk}${desc})`;
          });
        parts.push(`dimensions[${dList.join('; ')}]`);
      }

      // Joins
      if (opts.includeJoins && cube.joins && cube.joins.length > 0) {
        const jList = cube.joins.map(j => `${j.name}(${j.relationship})`);
        parts.push(`joins[${jList.join('; ')}]`);
      }

      const desc = cube.description ? `: ${cube.description}` : '';
      lines.push(`${cube.name}${desc} — ${parts.join(', ')}`);
    }

    let result = lines.join('\n\n');

    // Token budget trimming
    if (opts.maxTokens) {
      const estimatedTokens = Math.ceil(result.length / 4);
      if (estimatedTokens > opts.maxTokens) {
        const targetChars = opts.maxTokens * 4;
        result = result.substring(0, targetChars);
        const lastNewline = result.lastIndexOf('\n\n');
        if (lastNewline > 0) {
          result = result.substring(0, lastNewline);
        }
        result += '\n\n[... truncated to fit token budget]';
      }
    }

    return result;
  }
}

/**
 * Full JSON serializer — produces structured JSON output of cube schemas.
 * More verbose than {@link CompactSerializer} but preserves exact structure
 * for LLMs that work better with JSON input.
 */
export class FullJsonSerializer implements SchemaSerializer {
  /**
   * Serialize cubes into formatted JSON.
   * @param cubes - Array of cube metadata.
   * @param options - Optional. `maxTokens` truncates JSON if too large.
   */
  serialize(cubes: CubeMetaConfig[], options?: Partial<SerializeOptions>): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const simplified = cubes.map(c => {
      const cube: any = {
        name: c.name,
        description: c.description,
        measures: (c.measures || [])
          .filter(m => m.isVisible !== false && m.public !== false)
          .map(m => ({ name: m.name, type: m.type, description: m.description })),
        dimensions: (c.dimensions || [])
          .filter(d => d.isVisible !== false && d.public !== false)
          .map(d => ({ name: d.name, type: d.type, description: d.description, primaryKey: d.primaryKey })),
      };
      if (opts.includeJoins && c.joins) {
        cube.joins = c.joins.map(j => ({ name: j.name, relationship: j.relationship }));
      }
      return cube;
    });

    let result = JSON.stringify(simplified, null, 2);

    if (opts.maxTokens) {
      const estimatedTokens = Math.ceil(result.length / 4);
      if (estimatedTokens > opts.maxTokens) {
        const targetChars = opts.maxTokens * 4;
        result = result.substring(0, targetChars) + '\n... truncated';
      }
    }

    return result;
  }
}
