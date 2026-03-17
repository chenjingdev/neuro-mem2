/**
 * Hono-compatible rate limiting middleware.
 * Uses the in-memory RateLimitStore for sliding window counters.
 */
import type { Context, Next, MiddlewareHandler } from 'hono';
import { RateLimitStore } from './rate-limiter.js';
import type { RateLimitConfig } from './types.js';

export const DEFAULT_HONO_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 60_000,
};

/**
 * Get the rate limit key for a Hono request.
 * Uses apiKeyId if authenticated, otherwise IP.
 */
function getKey(c: Context): string {
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  if (apiKeyId) return `key:${apiKeyId}`;

  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return `ip:${forwarded.split(',')[0].trim()}`;

  // Hono doesn't expose raw socket easily — use a generic identifier
  return `ip:${c.req.header('host') ?? 'unknown'}`;
}

/**
 * Create Hono rate limiting middleware.
 */
export function honoRateLimit(
  config?: Partial<RateLimitConfig>,
  store?: RateLimitStore,
): MiddlewareHandler {
  const cfg = { ...DEFAULT_HONO_RATE_LIMIT, ...config };
  const rateLimitStore = store ?? new RateLimitStore();

  return async (c: Context, next: Next) => {
    const key = getKey(c);
    const path = new URL(c.req.url).pathname;

    // Check per-route limits
    let maxRequests = cfg.maxRequests;
    let windowMs = cfg.windowMs;

    if (cfg.perRoute) {
      for (const [route, limit] of Object.entries(cfg.perRoute)) {
        if (path.startsWith(route)) {
          maxRequests = limit.maxRequests;
          windowMs = limit.windowMs;
          break;
        }
      }
    }

    const routeKey = `${key}:${path}`;
    const { allowed, remaining, resetAt } = rateLimitStore.check(routeKey, maxRequests, windowMs);

    // Set rate limit headers
    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

    if (!allowed) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      c.header('Retry-After', retryAfter.toString());
      return c.json(
        { error: { code: 'RATE_LIMITED', message: `Rate limit exceeded. Try again in ${retryAfter} seconds.` } },
        429,
      );
    }

    return next();
  };
}

/**
 * Get the store instance for cleanup/testing.
 * Only exposed for testability — production code should use honoRateLimit().
 */
export function createRateLimitStoreForHono(cleanupIntervalMs?: number): RateLimitStore {
  return new RateLimitStore(cleanupIntervalMs);
}
