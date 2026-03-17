/**
 * In-memory rate limiter middleware using sliding window counters.
 * No external dependencies — suitable for single-process local deployment.
 */
import type { Middleware, ApiRequest, ApiResponse, RateLimitConfig, RateLimitEntry } from './types.js';
import { ApiError } from './types.js';

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 60_000, // 1 minute
};

/**
 * In-memory rate limit store.
 * Uses a Map with periodic cleanup of expired entries.
 */
export class RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cleanupIntervalMs: number = 60_000) {
    // Periodic cleanup of stale entries
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    // Allow the timer to not block process exit
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check and increment the counter for a given key.
   * Returns { allowed, remaining, resetAt }.
   */
  check(
    key: string,
    maxRequests: number,
    windowMs: number,
  ): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry || now >= entry.resetAt) {
      // Window expired or first request — start new window
      entry = { count: 1, resetAt: now + windowMs };
      this.entries.set(key, entry);
      return { allowed: true, remaining: maxRequests - 1, resetAt: entry.resetAt };
    }

    entry.count++;
    const allowed = entry.count <= maxRequests;
    const remaining = Math.max(0, maxRequests - entry.count);
    return { allowed, remaining, resetAt: entry.resetAt };
  }

  /** Remove expired entries */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }

  /** Reset all entries (useful for testing) */
  reset(): void {
    this.entries.clear();
  }

  /** Stop cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Get current entry count (for testing/monitoring) */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Get the rate limit key for a request.
 * Uses apiKeyId if authenticated, otherwise falls back to IP.
 */
export function getRateLimitKey(req: ApiRequest): string {
  if (req.apiKeyId) {
    return `key:${req.apiKeyId}`;
  }
  // Fall back to IP
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.socket?.remoteAddress ?? 'unknown';
  return `ip:${ip}`;
}

/**
 * Create rate limiting middleware.
 */
export function createRateLimitMiddleware(
  config: Partial<RateLimitConfig> = {},
  store?: RateLimitStore,
): Middleware {
  const effectiveConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  const rateLimitStore = store ?? new RateLimitStore();

  return async (req: ApiRequest, res: ApiResponse, next: () => Promise<void>) => {
    const key = getRateLimitKey(req);
    const pathname = req.pathname ?? '/';

    // Check per-route limits first
    let maxRequests = effectiveConfig.maxRequests;
    let windowMs = effectiveConfig.windowMs;

    if (effectiveConfig.perRoute) {
      for (const [route, limit] of Object.entries(effectiveConfig.perRoute)) {
        if (pathname.startsWith(route)) {
          maxRequests = limit.maxRequests;
          windowMs = limit.windowMs;
          break;
        }
      }
    }

    const routeKey = `${key}:${pathname}`;
    const { allowed, remaining, resetAt } = rateLimitStore.check(routeKey, maxRequests, windowMs);

    // Always set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

    if (!allowed) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      throw new ApiError(
        429,
        `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        'RATE_LIMITED',
      );
    }

    return next();
  };
}
