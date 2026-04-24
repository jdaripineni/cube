# PR: feat(ai): Add Schema Intelligence package — scoring, vector search, NLQ translation

## Summary

Adds `@cubejs-backend/schema-intelligence` — a feature-gated AI package that brings schema scoring, semantic vector search, and natural language query translation to Cube.js OSS.

## Motivation

With 200+ cube schemas, finding the right schema for a query becomes a needle-in-a-haystack problem. LLMs need well-structured schema context to generate accurate Cube queries. This package solves both problems:

1. **Schema Scoring** — Quantifies how LLM-ready each schema is, with actionable improvement suggestions
2. **Vector Search** — Embeds schemas and retrieves the most relevant ones via semantic similarity (RAG pattern)
3. **NLQ Translation** — Converts "What was revenue last month?" → `{ measures: ["Orders.totalAmount"], timeDimensions: [...] }`
4. **Feedback Loop** — Users rate translations, building a corpus of few-shot examples and negative patterns

## Design Principles

- **Zero-cost when disabled** — All features gated behind `schemaIntelligence` option. When off: no deps loaded, no memory, no CPU, AI routes return 404
- **Provider pattern** — Every component (embedding, vector store, LLM, scoring, feedback) implements an interface. Ship with local/OpenAI/Ollama providers; users can implement their own
- **Alignment with Cube Cloud** — Matches property names (`embedding_llm`, `llm`, model registry), supports `agents/config.yml` format, bridges feedback → certified queries

## What's Included

### New Package: `packages/cubejs-schema-intelligence/`
| File | Purpose |
|------|---------|
| `src/types.ts` | All interfaces (VectorStore, EmbeddingProvider, LLMProvider, etc.) |
| `src/scoring/RuleBasedScorer.ts` | 7-criteria weighted scoring with enrichment suggestions |
| `src/embedding/{Local,OpenAI,Ollama,Cached}EmbeddingProvider.ts` | Embedding providers |
| `src/vectorstore/{InMemory,PgVector}Store.ts` | Vector store backends |
| `src/serialization/SchemaSerializers.ts` | Compact (~70% token reduction) and full JSON serializers |
| `src/validation/QueryValidator.ts` | Validates Cube queries against compiled meta with "did you mean?" |
| `src/llm/LLMProviders.ts` | OpenAI/Ollama providers + model registry matching Cube Cloud names |
| `src/translator/{PromptBuilder,DefaultTranslator}.ts` | NLQ → Cube query with self-healing retry loop |
| `src/feedback/SqliteFeedbackStore.ts` | SQLite-backed feedback persistence |
| `src/metrics/MetricsCollector.ts` | Prometheus text format metrics |
| `src/config/AgentsConfigLoader.ts` | Reads Cube Cloud agents/config.yml |
| `src/SchemaIntelligenceModule.ts` | Main orchestrator with lazy init and feature gate |
| `test/*.test.ts` | Unit tests for scorer, vector store, validator, serializers, prompt builder |

### Modified Files in cube-js/cube
| File | Change |
|------|--------|
| `packages/cubejs-server-core/src/core/types.ts` | Added `schemaIntelligence` to `CreateOptions` |
| `packages/cubejs-server-core/src/core/optionsValidate.ts` | Added Joi validation schema |
| `packages/cubejs-server-core/src/core/server.ts` | Lazy initialization on first `getCompilerApi()` call |
| `packages/cubejs-server-core/src/core/CompilerApi.ts` | Added `schemaIntelligenceModule` property + getter |
| `packages/cubejs-api-gateway/src/types/strings.ts` | Added `'ai'` to `ApiScopes` union |
| `packages/cubejs-api-gateway/src/gateway.ts` | Added 7 AI routes under `/v1/ai/*` + scope validation |

### Modified Files in atlas.cubejs.service
| File | Change |
|------|--------|
| `cubejs/cube.js` | Added env-var-driven `schemaIntelligence` config block |

## API Endpoints (all require `ai` scope)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/ai/search` | Semantic search across schemas |
| POST | `/v1/ai/translate` | NLQ → Cube query |
| GET | `/v1/ai/scores` | Schema LLM-readiness scores |
| POST | `/v1/ai/feedback` | Submit translation feedback |
| GET | `/v1/ai/status` | Module status |
| GET | `/v1/ai/metrics` | Prometheus metrics |
| POST | `/v1/ai/reindex` | Force re-index |

## How to Enable

### cube.js (minimal)
```js
module.exports = { schemaIntelligence: true };
```

### atlas.cubejs.service (Helm)
```yaml
env:
  CUBEJS_SCHEMA_INTELLIGENCE: "true"
  CUBEJS_AI_EMBEDDING_PROVIDER: "local"  # or openai, ollama
  CUBEJS_AI_LLM_PROVIDER: "openai"       # optional, enables translation
  CUBEJS_AI_LLM_API_KEY: "<secret>"
```

## Testing

```bash
cd packages/cubejs-schema-intelligence
npm test
```

## Future Work

- [ ] Auto-reindex on `onSchemaCompiled` hook via CompilerApi compilerId watch
- [ ] Weaviate/Qdrant vector store providers
- [ ] Streaming translation responses
- [ ] Multi-turn conversation state management
- [ ] Certified query promotion from feedback
