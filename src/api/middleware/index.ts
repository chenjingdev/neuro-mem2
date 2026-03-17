/**
 * API Middleware — barrel exports
 */

// Types
export {
  ApiError,
  API_SCOPES,
} from './types.js';
export type {
  ApiRequest,
  ApiResponse,
  Middleware,
  ApiKey,
  CreateApiKeyOptions,
  CreateApiKeyResult,
  RateLimitConfig,
  RateLimitEntry,
  ValidationRule,
  ValidationSchema,
  ApiScope,
} from './types.js';

// API Key Store
export { ApiKeyStore, hashKey, generateApiKey, API_KEYS_SCHEMA } from './api-key-store.js';

// Auth middleware
export { createAuthMiddleware, createScopeMiddleware, extractApiKey } from './auth.js';
export type { AuthMiddlewareOptions } from './auth.js';

// Rate limiter
export {
  createRateLimitMiddleware,
  RateLimitStore,
  getRateLimitKey,
  DEFAULT_RATE_LIMIT_CONFIG,
} from './rate-limiter.js';

// Validator
export {
  createValidationMiddleware,
  createBodyParserMiddleware,
  validateField,
  validateData,
  COMMON_SCHEMAS,
} from './validator.js';

// Pipeline
export {
  createPipeline,
  augmentRequest,
  augmentResponse,
  handleError,
} from './pipeline.js';

// Context Formatter
export {
  ContextFormatter,
  DEFAULT_FORMATTER_CONFIG,
} from './context-formatter.js';
export type {
  ContextFormat,
  ContextFormatterConfig,
  FormattedContext,
} from './context-formatter.js';

// Context Injector
export {
  ContextInjector,
  DEFAULT_INJECTOR_CONFIG,
} from './context-injector.js';
export type {
  InjectionStrategy,
  ContextInjectorConfig,
  ChatMessage,
  ContentPart,
  OpenAIChatRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  InjectionResult,
} from './context-injector.js';

// Hono-compatible middleware (for use with Hono router)
export { honoAuth, honoRequireScope } from './hono-auth.js';
export type { HonoAuthOptions, AuthVariables } from './hono-auth.js';
export { honoRateLimit, createRateLimitStoreForHono, DEFAULT_HONO_RATE_LIMIT } from './hono-rate-limit.js';
