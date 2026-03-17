/**
 * Authentication middleware — validates API keys from Authorization header.
 * Supports Bearer token and X-API-Key header formats.
 */
import type { Middleware, ApiRequest, ApiResponse, ApiScope } from './types.js';
import { ApiError } from './types.js';
import type { ApiKeyStore } from './api-key-store.js';

export interface AuthMiddlewareOptions {
  /** The API key store instance */
  keyStore: ApiKeyStore;
  /** Paths that don't require authentication */
  publicPaths?: string[];
  /** If true, auth is optional — request proceeds without apiKeyId if no key provided */
  optional?: boolean;
}

/**
 * Extract the API key from the request.
 * Supports:
 *   - Authorization: Bearer <key>
 *   - X-API-Key: <key>
 */
export function extractApiKey(req: ApiRequest): string | null {
  // Check Authorization header first
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (match) return match[1];
  }

  // Check X-API-Key header
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return xApiKey;
  }

  return null;
}

/**
 * Create authentication middleware.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): Middleware {
  const { keyStore, publicPaths = [], optional = false } = options;

  return async (req: ApiRequest, _res: ApiResponse, next: () => Promise<void>) => {
    // Skip auth for public paths
    if (req.pathname && publicPaths.includes(req.pathname)) {
      return next();
    }

    const rawKey = extractApiKey(req);

    if (!rawKey) {
      if (optional) {
        return next();
      }
      throw new ApiError(401, 'API key required. Provide via Authorization: Bearer <key> or X-API-Key header.', 'AUTH_REQUIRED');
    }

    const apiKey = keyStore.validate(rawKey);
    if (!apiKey) {
      throw new ApiError(401, 'Invalid or expired API key.', 'AUTH_INVALID');
    }

    // Attach key ID to request for downstream use
    req.apiKeyId = apiKey.id;

    return next();
  };
}

/**
 * Create scope-checking middleware.
 * Must be used after auth middleware (requires req.apiKeyId).
 */
export function createScopeMiddleware(
  keyStore: ApiKeyStore,
  requiredScopes: ApiScope[],
): Middleware {
  return async (req: ApiRequest, _res: ApiResponse, next: () => Promise<void>) => {
    if (!req.apiKeyId) {
      throw new ApiError(401, 'Authentication required before scope check.', 'AUTH_REQUIRED');
    }

    const apiKey = keyStore.findById(req.apiKeyId);
    if (!apiKey) {
      throw new ApiError(401, 'API key not found.', 'AUTH_INVALID');
    }

    // Admin scope grants all access
    if (apiKey.scopes.includes('admin')) {
      return next();
    }

    const missing = requiredScopes.filter((s) => !apiKey.scopes.includes(s));
    if (missing.length > 0) {
      throw new ApiError(
        403,
        `Insufficient permissions. Required scopes: ${missing.join(', ')}`,
        'INSUFFICIENT_SCOPE',
      );
    }

    return next();
  };
}
