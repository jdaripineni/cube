import Joi from 'joi';
import DriverDependencies from './DriverDependencies';

const schemaQueueOptions = Joi.object().strict(true).keys({
  concurrency: Joi.number().min(1).integer(),
  continueWaitTimeout: Joi.number().min(0).max(90).integer(),
  executionTimeout: Joi.number().min(0).integer(),
  orphanedTimeout: Joi.number().min(0).integer(),
  heartBeatInterval: Joi.number().min(0).integer(),
  sendProcessMessageFn: Joi.func(),
  sendCancelMessageFn: Joi.func(),
});

const jwtOptions = Joi.object().strict(true).keys({
  // JWK options
  jwkRetry: Joi.number().min(1).max(5).integer(),
  jwkDefaultExpire: Joi.number().min(0),
  jwkUrl: Joi.alternatives().try(
    Joi.string(),
    Joi.func()
  ),
  jwkRefetchWindow: Joi.number().min(0),
  // JWT options
  key: Joi.string(),
  algorithms: Joi.array().items(Joi.string()),
  issuer: Joi.array().items(Joi.string()),
  audience: Joi.string(),
  subject: Joi.string(),
  claimsNamespace: Joi.string(),
});

const corsOptions = Joi.object().strict(true).keys({
  origin: Joi.any(),
  methods: Joi.any(),
  allowedHeaders: Joi.any(),
  exposedHeaders: Joi.any(),
  credentials: Joi.bool(),
  maxAge: Joi.number(),
  preflightContinue: Joi.bool(),
  optionsSuccessStatus: Joi.number(),
});

const dbTypes = Joi.alternatives().try(
  Joi.string().valid(...Object.keys(DriverDependencies)),
  Joi.func()
);

const schemaOptions = Joi.object().keys({
  // server CreateOptions
  webSockets: Joi.boolean(),
  http: Joi.object().strict(true).keys({
    cors: corsOptions,
  }),
  gracefulShutdown: Joi.number().min(0).integer(),
  serverHeadersTimeout: Joi.number(),
  serverKeepAliveTimeout: Joi.number(),
  // Additional from WebSocketServerOptions
  processSubscriptionsInterval: Joi.number(),
  webSocketsBasePath: Joi.string(),
  // server-core CoreCreateOptions
  dbType: dbTypes,
  externalDbType: dbTypes,
  schemaPath: Joi.string(),
  basePath: Joi.string(),
  devServer: Joi.boolean(),
  apiSecret: Joi.string(),
  logger: Joi.func(),
  // source
  dialectFactory: Joi.func(),
  driverFactory: Joi.func(),
  // external
  externalDialectFactory: Joi.func(),
  externalDriverFactory: Joi.func(),
  //
  cacheAndQueueDriver: Joi.string().valid('cubestore', 'memory'),
  contextToAppId: Joi.func(),
  contextToRoles: Joi.func(),
  contextToGroups: Joi.func(),
  contextToOrchestratorId: Joi.func(),
  contextToCubeStoreRouterId: Joi.func(),
  contextToDataSourceId: Joi.func(),
  contextToApiScopes: Joi.func(),
  repositoryFactory: Joi.func(),
  checkAuth: Joi.func(),
  jwt: jwtOptions,
  queryTransformer: Joi.func(),
  queryRewrite: Joi.func(),
  preAggregationsSchema: Joi.alternatives().try(
    Joi.string(),
    Joi.func()
  ),
  schemaVersion: Joi.func(),
  extendContext: Joi.func(),
  // Scheduled refresh
  scheduledRefreshTimer: Joi.alternatives().try(
    Joi.boolean(),
    Joi.number().min(0).integer()
  ),
  scheduledRefreshTimeZones: Joi.alternatives().try(
    Joi.array().items(Joi.string()),
    Joi.func()
  ),
  scheduledRefreshContexts: Joi.func(),
  scheduledRefreshConcurrency: Joi.number().min(1).integer(),
  scheduledRefreshBatchSize: Joi.number().min(1).integer(),
  // Compiler cache
  compilerCacheSize: Joi.number().min(0).integer(),
  updateCompilerCacheKeepAlive: Joi.boolean(),
  maxCompilerCacheKeepAlive: Joi.number().min(0).integer(),
  telemetry: Joi.boolean(),
  allowUngroupedWithoutPrimaryKey: Joi.boolean(),
  orchestratorOptions: Joi.alternatives().try(
    Joi.func(),
    Joi.object().strict(true).keys({
      redisPrefix: Joi.string().allow(''),
      continueWaitTimeout: Joi.number().min(0).max(90).integer(),
      skipExternalCacheAndQueue: Joi.boolean(),
      queryCacheOptions: Joi.object().keys({
        refreshKeyRenewalThreshold: Joi.number().min(0).integer(),
        backgroundRenew: Joi.boolean(),
        queueOptions: schemaQueueOptions,
        externalQueueOptions: schemaQueueOptions
      }),
      preAggregationsOptions: {
        queueOptions: schemaQueueOptions,
        externalRefresh: Joi.boolean(),
        maxPartitions: Joi.number(),
      },
      rollupOnlyMode: Joi.boolean(),
      testConnectionTimeout: Joi.number().min(0).integer(),
    })
  ),
  allowJsDuplicatePropsInSchema: Joi.boolean(),
  dashboardAppPath: Joi.string(),
  dashboardAppPort: Joi.number(),
  sqlCache: Joi.boolean(),
  livePreview: Joi.boolean(),
  // SQL API
  sqlPort: Joi.number(),
  pgSqlPort: Joi.number(),
  gatewayPort: Joi.number(),
  sqlSuperUser: Joi.string(),
  checkSqlAuth: Joi.func(),
  canSwitchSqlUser: Joi.func(),
  sqlUser: Joi.string(),
  sqlPassword: Joi.string(),
  semanticLayerSync: Joi.func(),
  // Additional system flags
  serverless: Joi.boolean(),
  allowNodeRequire: Joi.boolean(),
  fastReload: Joi.boolean(),
  // AI schema intelligence — feature-gated module for scoring, vector search,
  // and NLQ translation. See @cubejs-backend/schema-intelligence for full docs.
  //
  // Quick start:  schemaIntelligence: true
  // Full config:  schemaIntelligence: { scoring: true, embedding: { provider: 'ollama' }, ... }
  //
  // All sub-keys are optional. Omitted keys use sensible defaults.
  schemaIntelligence: Joi.alternatives().try(
    Joi.boolean(),
    Joi.object().keys({
      // Scoring engine: true for defaults, or { threshold, criteria } for custom weights
      scoring: Joi.alternatives().try(Joi.boolean(), Joi.object().keys({
        criteria: Joi.object().pattern(Joi.string(), Joi.object().keys({
          weight: Joi.number().min(0).max(1),
          description: Joi.string(),
        })),
      })),
      // Embedding provider: 'local' (default), 'openai', or 'ollama'
      // endpoint = Ollama native URL (e.g. http://ollama:11434), NOT /v1
      // baseUrl  = OpenAI-compatible URL (kept for parity with llm section)
      embedding: Joi.object().keys({
        provider: Joi.string().valid('local', 'openai', 'ollama'),
        apiKey: Joi.string(),
        model: Joi.string(),
        baseUrl: Joi.string(),
        endpoint: Joi.string(),
      }),
      // Vector store: 'memory' (default, dev/test) or 'pgvector' (production)
      vectorStore: Joi.object().keys({
        provider: Joi.string().valid('memory', 'pgvector'),
        connectionString: Joi.string(),
        dimensions: Joi.number().integer().min(1),
      }),
      // NLQ translator: requires llm section to also be configured
      translator: Joi.object().keys({
        enabled: Joi.boolean(),
        maxRetries: Joi.number().integer().min(0),
        maxContextSchemas: Joi.number().integer().min(1),
        fewShotCount: Joi.number().integer().min(0),
      }),
      // LLM provider for NLQ translation: 'openai' or 'ollama'
      // baseUrl = OpenAI-compatible endpoint (e.g. http://ollama:11434/v1)
      llm: Joi.object().keys({
        provider: Joi.string().valid('openai', 'ollama'),
        apiKey: Joi.string(),
        model: Joi.string(),
        baseUrl: Joi.string(),
        temperature: Joi.number().min(0).max(2),
      }),
      // Feedback store for continuous improvement via user ratings
      feedback: Joi.object().keys({
        enabled: Joi.boolean(),
        dbPath: Joi.string(),
      }),
      // Expose Prometheus metrics at /v1/ai/metrics
      metrics: Joi.boolean(),
    })
  ),
});

export default (options: any) => {
  const { error } = schemaOptions.validate(options, { abortEarly: false });
  if (error) {
    throw new Error(`Invalid cube-server-core options: ${error.message || error.toString()}`);
  }
};
