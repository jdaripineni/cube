# Schema Intelligence — AI-Powered Cube.js Schema Features

## Overview

`@cubejs-backend/schema-intelligence` adds AI capabilities to Cube.js:

1. **Schema Scoring** — Rate how well your cube schemas work with LLMs
2. **Vector Search** — Semantic search across 200+ schemas using embeddings
3. **NLQ Translation** — Convert natural language questions to Cube queries
4. **Feedback Loop** — Continuous improvement via user ratings
5. **Metrics** — Prometheus-compatible observability

## Quick Start

```js
// cube.js
module.exports = {
  schemaIntelligence: true, // enable with defaults
};
```

Or with full configuration:

```js
module.exports = {
  schemaIntelligence: {
    scoring: true,
    embedding: { provider: 'local' },           // local (default) | openai | ollama
    vectorStore: { provider: 'memory' },         // memory (default) | pgvector
    translator: { enabled: true, maxRetries: 2 },
    llm: {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    },
    feedback: { enabled: true },
    metrics: true,
  },
};
```

## Feature Gate

All features are gated behind the `schemaIntelligence` option. When disabled (default):
- Zero extra dependencies loaded
- No additional memory or CPU usage
- All AI API endpoints return 404
- No bloatware

When enabled:
- Optional dependencies (`better-sqlite3`, `@xenova/transformers`, `pg`) are loaded lazily
- AI endpoints become available under `/v1/ai/*`

## API Endpoints

All endpoints require the `ai` API scope.

### `POST /v1/ai/search`
Semantic vector search across schemas.
```json
{ "query": "revenue by product category", "limit": 5 }
```

### `POST /v1/ai/translate`
Translate natural language to a Cube query.
```json
{ "question": "What was total revenue last month?" }
```
Response:
```json
{
  "translationId": "uuid",
  "query": { "measures": ["Orders.totalAmount"], "timeDimensions": [...] },
  "confidence": 0.92,
  "reasoning": "...",
  "schemasUsed": ["Orders"]
}
```

### `GET /v1/ai/scores`
Get LLM-readiness scores for all schemas.

### `POST /v1/ai/feedback`
Submit feedback on a translation.
```json
{ "translationId": "uuid", "rating": 5, "correction": null }
```

### `GET /v1/ai/status`
Check intelligence module status (indexed count, providers, etc.).

### `GET /v1/ai/metrics`
Prometheus metrics. Use `?format=prometheus` for text format.

### `POST /v1/ai/reindex`
Force re-indexing of all schemas.

## Embedding Providers

| Provider | Model | Dimensions | Requires |
|----------|-------|-----------|----------|
| `local` | all-MiniLM-L6-v2 | 384 | Nothing (bundled) |
| `openai` | text-embedding-3-small | 1536 | `OPENAI_API_KEY` |
| `ollama` | nomic-embed-text | 768 | Ollama running locally |

## Vector Store Providers

| Provider | Best For | Requires |
|----------|----------|----------|
| `memory` | <500 schemas, dev/test | Nothing |
| `pgvector` | Production, persistence | PostgreSQL with pgvector extension |

## LLM Providers

| Provider | Models | Requires |
|----------|--------|----------|
| `openai` | gpt-4o, gpt-4o-mini, etc. | `OPENAI_API_KEY` |
| `ollama` | llama3, mistral, etc. | Ollama running locally |

## Scoring Criteria

Default weights (customizable):

| Criterion | Weight | Description |
|-----------|--------|-------------|
| `measure_descriptions` | 0.20 | All measures have meaningful descriptions |
| `dimension_descriptions` | 0.20 | All dimensions have meaningful descriptions |
| `cube_description` | 0.15 | Cube itself has a description |
| `type_coverage` | 0.15 | Proper types assigned to all members |
| `enum_values_listed` | 0.10 | String dimensions list possible values |
| `datasource_explicit` | 0.10 | Data source is explicitly declared |
| `join_descriptions` | 0.10 | Joins have descriptions |

## atlas.cubejs.service Integration

Set these environment variables in your Helm values:

```yaml
env:
  CUBEJS_SCHEMA_INTELLIGENCE: "true"
  CUBEJS_AI_EMBEDDING_PROVIDER: "local"
  CUBEJS_AI_VECTOR_STORE: "memory"
  # Optional: enable NLQ translation
  CUBEJS_AI_LLM_PROVIDER: "openai"
  CUBEJS_AI_LLM_API_KEY: "<from-secret>"
  CUBEJS_AI_LLM_MODEL: "gpt-4o-mini"
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│              SchemaIntelligenceModule            │
│  (lazy init, feature-gated, all no-ops if off)  │
├──────────┬──────────┬──────────┬────────────────┤
│ Scoring  │ Embedder │ Vector   │  Translator    │
│ Engine   │ + Cache  │ Store    │  + Validator   │
├──────────┼──────────┼──────────┼────────────────┤
│ Rule-    │ Local /  │ Memory / │  Prompt +      │
│ Based    │ OpenAI / │ pgvector │  LLM + Self-   │
│ Scorer   │ Ollama   │          │  Heal Loop     │
├──────────┴──────────┴──────────┴────────────────┤
│           Feedback Store (SQLite)               │
│           Metrics Collector (Prometheus)         │
└─────────────────────────────────────────────────┘
```

## Custom Implementations

All components implement interfaces that can be replaced:

```typescript
import { SchemaIntelligenceModule, VectorStore, EmbeddingProvider } from '@cubejs-backend/schema-intelligence';

// Implement your own vector store
class WeaviateVectorStore implements VectorStore { ... }

// Implement your own embedding provider
class CohereEmbeddingProvider implements EmbeddingProvider { ... }
```
