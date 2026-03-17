/**
 * Hono-compatible authentication middleware.
 * Wraps the core ApiKeyStore for use in Hono routes.
 */
import type { Context, Next, MiddlewareHandler } from 'hono';
import type { ApiKeyStore } from './api-key-store.js';
import type { ApiScope } from './types.js';

// ─── Hono Variables (type-safe context) ─────────────────

export interface AuthVariables {
  apiKeyId: string;
  apiKeyScopes: string[];
}

// ─── Auth Middleware Options ─────────────────────────────

export interface HonoAuthOptions {
  /** API key store */
  keyStore: ApiKeyStore;
  /** Paths that skip auth (e.g., '/health') */
  publicPaths?: string[];
  /** If true, requests without keys still proceed (apiKeyId will be undefined) */
  optional?: boolean;
}

/**
 * Extract API key from request headers.
 * Supports Authorization: Bearer <key> and X-API-Key: <key>.
 */
function extractKey(c: Context): string | null {
  const authHeader = c.req.header('authorization');
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (match) return match[1];
  }
  const xApiKey = c.req.header('x-api-key');
  if (xApiKey && xApiKey.length > 0) return xApiKey;
  return null;
}

/**
 * Create Hono authentication middleware.
 */
export function honoAuth(options: HonoAuthOptions): MiddlewareHandler {
  const { keyStore, publicPaths = [], optional = false } = options;

  return async (c: Context, next: Next) => {
    // Skip auth for public paths
    const path = new URL(c.req.url).pathname;
    if (publicPaths.some(p => path === p || path.startsWith(p + '/'))) {
      return next();
    }

    const rawKey = extractKey(c);

    if (!rawKey) {
      if (optional) return next();
      return c.json(
        { error: { code: 'AUTH_REQUIRED', message: 'API key required. Provide via Authorization: Bearer <key> or X-API-Key header.' } },
        401,
      );
    }

    const apiKey = keyStore.validate(rawKey);
    if (!apiKey) {
      return c.json(
        { error: { code: 'AUTH_INVALID', message: 'Invalid or expired API key.' } },
        401,
      );
    }

    // Store in context for downstream handlers
    c.set('apiKeyId', apiKey.id);
    c.set('apiKeyScopes', apiKey.scopes);

    return next();
  };
}

/**
 * Create Hono scope-checking middleware.
 * Must be used after honoAuth middleware.
 */
export function honoRequireScope(...requiredScopes: ApiScope[]): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const scopes = c.get('apiKeyScopes') as string[] | undefined;

    if (!scopes) {
      return c.json(
        { error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } },
        401,
      );
    }

    // Admin bypasses all scope checks
    if (scopes.includes('admin')) return next();

    const missing = requiredScopes.filter(s => !scopes.includes(s));
    if (missing.length > 0) {
      return c.json(
        { error: { code: 'INSUFFICIENT_SCOPE', message: `Insufficient permissions. Required: ${missing.join(', ')}` } },
        403,
      );
    }

    return next();
  };
}
