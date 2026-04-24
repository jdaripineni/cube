/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Agents config loader — reads Cube Cloud's agents/config.yml format.
 */

import fs from 'fs';
import path from 'path';

import type { SchemaIntelligenceOptions, FeedbackEntry } from '../types';

interface AgentsYamlConfig {
  llm?: string | Record<string, any>;
  embedding_llm?: string | Record<string, any>;
  runtime?: string;
  accessible_views?: string[];
  memory_mode?: string;
  certified_queries?: Array<{ name: string; description: string; sql: string }>;
}

function parseYamlSimple(content: string): Record<string, any> {
  // Minimal YAML parser for flat agent config (key: value, arrays)
  const result: Record<string, any> = {};
  const lines = content.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') && currentArray !== null) {
      currentArray.push(trimmed.substring(2).trim());
      continue;
    }

    if (currentArray !== null) {
      result[currentKey] = currentArray;
      currentArray = null;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();

      if (value === '') {
        // Could be array or nested — check next line
        currentKey = key;
        currentArray = [];
      } else {
        result[key] = value;
      }
    }
  }

  if (currentArray !== null) {
    result[currentKey] = currentArray;
  }

  return result;
}

export class AgentsConfigLoader {
  async load(configPath: string): Promise<Partial<SchemaIntelligenceOptions>> {
    const configFile = path.join(configPath, 'config.yml');

    if (!fs.existsSync(configFile)) {
      return {};
    }

    const content = fs.readFileSync(configFile, 'utf8');
    const config = parseYamlSimple(content) as AgentsYamlConfig;

    const result: Partial<SchemaIntelligenceOptions> = {};

    if (config.embedding_llm) {
      result.embeddingLlm = typeof config.embedding_llm === 'string'
        ? config.embedding_llm
        : config.embedding_llm as any;
    }

    if (config.llm || config.runtime) {
      result.translator = {
        enabled: true,
        llm: config.llm as any,
        runtime: config.runtime as any,
      };
    }

    if (config.accessible_views) {
      result.accessibleViews = config.accessible_views;
    }

    if (config.memory_mode) {
      result.feedback = {
        enabled: true,
        memoryMode: config.memory_mode as any,
      };
    }

    return result;
  }

  async loadCertifiedQueries(configPath: string): Promise<FeedbackEntry[]> {
    const queriesDir = path.join(configPath, 'certified_queries');
    const entries: FeedbackEntry[] = [];

    if (!fs.existsSync(queriesDir)) return entries;

    const files = fs.readdirSync(queriesDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(queriesDir, file), 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      if (frontmatter.description && body.trim()) {
        entries.push({
          translationId: `certified-${path.basename(file, '.md')}`,
          timestamp: new Date(),
          nlq: frontmatter.description,
          generatedQuery: null, // Certified queries are SQL, not Cube queries
          schemasUsed: frontmatter.cubes || [],
          rating: 'positive',
          latencyMs: 0,
          retryCount: 0,
        });
      }
    }

    return entries;
  }

  async loadRules(configPath: string): Promise<string[]> {
    const rulesDir = path.join(configPath, 'rules');
    const rules: string[] = [];

    if (!fs.existsSync(rulesDir)) return rules;

    const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(rulesDir, file), 'utf8');
      const { body } = parseFrontmatter(content);
      if (body.trim()) {
        rules.push(body.trim());
      }
    }

    return rules;
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  if (!content.startsWith('---')) {
    return { frontmatter: {}, body: content };
  }

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = content.substring(3, endIdx).trim();
  const body = content.substring(endIdx + 3).trim();
  const frontmatter = parseYamlSimple(yamlStr);

  return { frontmatter, body };
}
