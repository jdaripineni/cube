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

### Self-hosted with Ollama

Run the full AI pipeline locally with no external API keys:

```js
module.exports = {
  schemaIntelligence: {
    scoring: true,
    embedding: {
      provider: 'ollama',
      model: 'nomic-embed-text',         // default; any Ollama embedding model works
      endpoint: 'http://localhost:11434', // Ollama native API (not /v1)
    },
    vectorStore: { provider: 'memory' },
    translator: { enabled: true },
    llm: {
      provider: 'ollama',
      model: 'qwen3:0.6b',              // or llama3, mistral, etc.
      baseUrl: 'http://localhost:11434/v1', // OpenAI-compatible endpoint
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
- Schemas are **automatically indexed** on every compilation (and recompilation) — no manual reindex needed

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
Force re-indexing of all schemas. Schemas are also automatically re-indexed whenever
the data model is recompiled, so this is only needed if you want to trigger it manually.

## Embedding Providers

| Provider | Model | Dimensions | Requires |
|----------|-------|-----------|----------|
| `local` | all-MiniLM-L6-v2 | 384 | `@xenova/transformers` (bundled in Cube Cloud) |
| `openai` | text-embedding-3-small | 1536 | `apiKey` (or `OPENAI_API_KEY`) |
| `ollama` | nomic-embed-text | 768 | Ollama running at `endpoint` (default `http://localhost:11434`) |

### Embedding config reference

```js
embedding: {
  provider: 'ollama',           // required: 'local' | 'openai' | 'ollama'
  model: 'nomic-embed-text',    // optional: override default model
  endpoint: 'http://...:11434', // optional: Ollama host (native API, not /v1)
  apiKey: '...',                // optional: for OpenAI
}
```

## Vector Store Providers

| Provider | Best For | Requires |
|----------|----------|----------|
| `memory` | <500 schemas, dev/test | Nothing |
| `pgvector` | Production, persistence | PostgreSQL with pgvector extension |

### Persistence across restarts

By default, **all AI data is ephemeral** — feedback, vector embeddings, and caches
are stored in-memory and lost when the CubeJS process restarts.

| Data | Default | Persistent option |
|------|---------|-------------------|
| Feedback (ratings, corrections, few-shot examples) | SQLite `:memory:` | Set `feedback.connectionOptions.path` to a file path |
| Vector store (schema embeddings) | JS `Map` (in-memory) | Switch to `pgvector` with a connection string |
| Embedding cache | In-process `Map` | Rebuilt automatically (no config needed) |

**Feedback** is the most critical to persist — it contains user ratings and corrections
that are unrecoverable if lost. Vector embeddings are self-healing (re-indexed on schema
compilation) but re-indexing costs embedding API calls on every restart.

#### Persistent feedback (SQLite on disk)

```js
module.exports = {
  schemaIntelligence: {
    feedback: {
      enabled: true,
      connectionOptions: {
        path: '/data/ai/feedback.db',  // file path — directory must exist
      },
    },
  },
};
```

Or via environment variable:
```bash
CUBEJS_AI_FEEDBACK_PATH=/data/ai/feedback.db
```

> **Kubernetes:** Mount a PersistentVolumeClaim at `/data/ai`. The atlas.cubejs.service
> Helm chart supports this via `ai.persistence.enabled=true` (see Helm values below).

#### Persistent vector store (pgvector)

```js
module.exports = {
  schemaIntelligence: {
    vectorStore: {
      provider: 'pgvector',
      connectionString: 'postgresql://user:pass@host:5432/db',
    },
  },
};
```

Or via environment variables:
```bash
CUBEJS_AI_VECTOR_STORE=pgvector
CUBEJS_AI_VECTOR_STORE_CONNECTION_STRING=postgresql://user:pass@host:5432/db
```

> The PostgreSQL instance must have the `pgvector` extension installed (`CREATE EXTENSION vector`).

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

## Schema Hints via `meta.ai`

Cube schema authors can embed LLM context directly in their cube definitions using the
standard `meta` field — no schema format or CRD changes required. The convention is
`meta.ai.*` at any level (cube, measure, dimension, segment).

### Supported `meta.ai` keys

| Key | Level | Type | Purpose |
|-----|-------|------|---------|
| `synonyms` | cube, measure, dimension | `string[]` | Alternative names the LLM should recognize |
| `hints` | cube, measure, dimension | `string` | Free-text guidance for the LLM |
| `enumValues` | dimension, measure | `string[]` | Valid values (shown to LLM for filter generation) |
| `examples` | cube | `Array<{nlq, query}>` | Few-shot examples authored by schema owners |

### Example

```js
cube(`Orders`, {
  description: 'E-commerce order transactions',
  meta: {
    ai: {
      synonyms: ['purchases', 'sales', 'transactions'],
      hints: 'Use for revenue and order volume queries. Combine with Products cube for category breakdowns.',
      examples: [
        {
          nlq: 'Total revenue last month',
          query: {
            measures: ['Orders.totalAmount'],
            timeDimensions: [{ dimension: 'Orders.createdAt', dateRange: 'last month' }],
          },
        },
        {
          nlq: 'Top 5 cities by order count this year',
          query: {
            measures: ['Orders.count'],
            dimensions: ['Orders.city'],
            timeDimensions: [{ dimension: 'Orders.createdAt', dateRange: 'this year' }],
            order: { 'Orders.count': 'desc' },
            limit: 5,
          },
        },
      ],
    },
  },

  measures: {
    count: {
      type: 'count',
      description: 'Total number of orders',
    },
    totalAmount: {
      type: 'sum',
      sql: `amount`,
      description: 'Sum of order amounts in USD',
      meta: {
        ai: { synonyms: ['revenue', 'sales', 'income'] },
      },
    },
  },

  dimensions: {
    status: {
      type: 'string',
      sql: `status`,
      description: 'Current order status',
      meta: {
        ai: {
          enumValues: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
          synonyms: ['state', 'order state'],
        },
      },
    },
    city: {
      type: 'string',
      sql: `city`,
      description: 'Customer city',
    },
    createdAt: {
      type: 'time',
      sql: `created_at`,
      description: 'Order creation timestamp',
    },
  },
});
```

### How it flows through the pipeline

1. **CompactSerializer** extracts `synonyms`, `hints`, and `enumValues` into the
   serialized schema text that the LLM sees in its context window:
   ```
   Orders: E-commerce order transactions [aka: purchases/sales/transactions; Use for revenue...] —
     measures[count(count, Total number of orders); totalAmount(sum, Sum of order amounts) [aka: revenue/sales/income]],
     dimensions[status(string, Current order status) [values: pending,processing,shipped,delivered,cancelled; aka: state/order state]]
   ```
2. **DefaultTranslator** collects `meta.ai.examples` from the vector-search results
   and passes them to the PromptBuilder.
3. **PromptBuilder** includes schema-authored examples in a dedicated
   "EXAMPLES FROM SCHEMA AUTHORS" section, separate from feedback-derived examples.

### Why `meta.ai` instead of a new schema field?

- `meta` is already validated by the Cube compiler at every level — no changes needed
- Works with existing Cube CRDs — application teams just update their JS files
- Fully opt-in — cubes without `meta.ai` work exactly as before
- The `meta` field passes through the compiler unchanged, so it's forward-compatible

## Environment Variables

All settings can also be driven via environment variables:

```bash
CUBEJS_SCHEMA_INTELLIGENCE=true
CUBEJS_AI_EMBEDDING_PROVIDER=local       # local (default) | openai | ollama
CUBEJS_AI_VECTOR_STORE=memory            # memory (default) | pgvector
CUBEJS_AI_VECTOR_STORE_CONNECTION_STRING= # required when CUBEJS_AI_VECTOR_STORE=pgvector
CUBEJS_AI_FEEDBACK_ENABLED=true          # default: true when intelligence enabled
CUBEJS_AI_FEEDBACK_PATH=                 # file path for persistent feedback (default: in-memory)
# Optional: enable NLQ translation
CUBEJS_AI_LLM_PROVIDER=openai
CUBEJS_AI_LLM_API_KEY=<your-key>
CUBEJS_AI_LLM_MODEL=gpt-4o-mini
```

### Ollama (self-hosted)

```bash
CUBEJS_SCHEMA_INTELLIGENCE=true
CUBEJS_AI_EMBEDDING_PROVIDER=ollama
CUBEJS_AI_LLM_PROVIDER=ollama
CUBEJS_AI_LLM_MODEL=qwen3:0.6b
CUBEJS_AI_LLM_BASE_URL=http://ollama:11434/v1
```

> **Note:** The `embedding.endpoint` uses Ollama's native `/api/embed` API (without `/v1`),
> while `llm.baseUrl` uses the OpenAI-compatible `/v1` endpoint. When configured via
> `CUBEJS_AI_LLM_BASE_URL`, the embedding endpoint is derived automatically by stripping
> the `/v1` suffix.

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
