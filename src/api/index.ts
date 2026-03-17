/**
 * API module — REST endpoints for nero-mem2.
 */

export { createRouter, type RouterDependencies } from './router.js';
export { startServer, stopServer, DEFAULT_SERVER_CONFIG, type ServerConfig } from './server.js';
export type { ApiRequest, ApiResponse, Middleware, ApiKey, CreateApiKeyOptions, CreateApiKeyResult, RateLimitConfig, ValidationRule, ValidationSchema, ApiScope } from './middleware/types.js';
export { ApiError, API_SCOPES } from './middleware/types.js';

// API Key management
export { ApiKeyStore, hashKey, generateApiKey, API_KEYS_SCHEMA } from './middleware/api-key-store.js';

// Hono middleware (for use with Hono router)
export { honoAuth, honoRequireScope } from './middleware/hono-auth.js';
export type { HonoAuthOptions, AuthVariables } from './middleware/hono-auth.js';
export { honoRateLimit, createRateLimitStoreForHono, DEFAULT_HONO_RATE_LIMIT } from './middleware/hono-rate-limit.js';
export { RateLimitStore } from './middleware/rate-limiter.js';

// Generic middleware (framework-agnostic)
export { createAuthMiddleware, createScopeMiddleware, extractApiKey } from './middleware/auth.js';
export { createRateLimitMiddleware, getRateLimitKey, DEFAULT_RATE_LIMIT_CONFIG } from './middleware/rate-limiter.js';
export { createValidationMiddleware, createBodyParserMiddleware, validateField, validateData, COMMON_SCHEMAS } from './middleware/validator.js';
export { createPipeline, augmentRequest, augmentResponse, handleError } from './middleware/pipeline.js';

// Request/Response schemas
export type {
  IngestConversationRequest,
  IngestMessageSchema,
  AppendMessageRequest,
  IngestResponse,
  AppendMessageResponse,
  RecallRequest,
  RecallResponse,
  RecallItemSchema,
  ErrorResponse,
  ValidationError,
} from './schemas.js';

export {
  validateIngestConversation,
  validateAppendMessage,
  validateRecallRequest,
  toIngestInput,
  toAppendInput,
  toRecallResponse,
} from './schemas.js';

// OpenAPI
export {
  generateOpenApiSpec,
  validateOpenApiSpec,
  getOperationIds,
  getEndpoints,
  REQUIRED_ROUTES,
} from './openapi.js';
export type { OpenApiSpec } from './openapi.js';
