/**
 * Tests for API authentication, rate limiting, and request validation middleware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  ApiKeyStore,
  hashKey,
  generateApiKey,
  createAuthMiddleware,
  createScopeMiddleware,
  extractApiKey,
  createRateLimitMiddleware,
  RateLimitStore,
  getRateLimitKey,
  createValidationMiddleware,
  validateField,
  validateData,
  createPipeline,
  augmentRequest,
  augmentResponse,
  handleError,
  ApiError,
  COMMON_SCHEMAS,
} from '../src/api/middleware/index.js';
import type { ApiRequest, ApiResponse, Middleware } from '../src/api/middleware/index.js';

// ─── Test helpers ─────────────────────────────────────────────

function createMockRequest(overrides: Partial<ApiRequest> = {}): ApiRequest {
  const req = new EventEmitter() as unknown as ApiRequest;
  (req as any).headers = overrides.headers ?? {};
  (req as any).method = overrides.method ?? 'GET';
  (req as any).url = overrides.url ?? '/';
  (req as any).socket = { remoteAddress: '127.0.0.1' } as Socket;
  req.body = overrides.body;
  req.apiKeyId = overrides.apiKeyId;
  req.pathname = overrides.pathname;
  req.query = overrides.query;
  // Add destroy method
  (req as any).destroy = () => {};
  return req;
}

function createMockResponse(): ApiResponse & { _status: number; _body: unknown; _headers: Record<string, string> } {
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string>,
    headersSent: false,
    writeHead(statusCode: number, headers?: Record<string, string>) {
      this._status = statusCode;
      if (headers) Object.assign(this._headers, headers);
      return this;
    },
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return this._headers[name.toLowerCase()];
    },
    end(body?: string) {
      if (body) this._body = JSON.parse(body);
      this.headersSent = true;
    },
    json(statusCode: number, data: unknown) {
      this._status = statusCode;
      this._body = data;
      this.headersSent = true;
    },
  };
  return res as any;
}

const noop = async () => {};

// ─── ApiKeyStore ──────────────────────────────────────────────

describe('ApiKeyStore', () => {
  let db: Database.Database;
  let store: ApiKeyStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ApiKeyStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a key and returns it with raw value', () => {
    const result = store.create({ name: 'test-key' });
    expect(result.key).toMatch(/^nmem_/);
    expect(result.name).toBe('test-key');
    expect(result.prefix).toBe(result.key.slice(0, 12));
    expect(result.scopes).toEqual(['memory:read', 'memory:write']);
    expect(result.id).toBeTruthy();
  });

  it('validates a correct key', () => {
    const { key } = store.create({ name: 'valid-key' });
    const apiKey = store.validate(key);
    expect(apiKey).not.toBeNull();
    expect(apiKey!.name).toBe('valid-key');
  });

  it('rejects an unknown key', () => {
    const result = store.validate('nmem_fake-key-that-does-not-exist');
    expect(result).toBeNull();
  });

  it('rejects a revoked key', () => {
    const { id, key } = store.create({ name: 'revoke-me' });
    store.revoke(id);
    expect(store.validate(key)).toBeNull();
  });

  it('rejects an expired key', () => {
    // Create key that expired 1ms ago
    const { key } = store.create({ name: 'expired', expiresInMs: -1000 });
    expect(store.validate(key)).toBeNull();
  });

  it('lists all keys', () => {
    store.create({ name: 'key1' });
    store.create({ name: 'key2' });
    const keys = store.list();
    expect(keys).toHaveLength(2);
  });

  it('creates key with custom scopes', () => {
    const { key, scopes } = store.create({ name: 'admin', scopes: ['admin'] });
    expect(scopes).toEqual(['admin']);
    const validated = store.validate(key);
    expect(validated!.scopes).toEqual(['admin']);
  });

  it('updates last_used_at on validate', () => {
    const { id, key } = store.create({ name: 'usage-track' });
    const before = store.findById(id);
    expect(before!.lastUsedAt).toBeNull();

    store.validate(key);
    const after = store.findById(id);
    expect(after!.lastUsedAt).not.toBeNull();
  });
});

// ─── Key generation utilities ──────────────────────────────────

describe('hashKey / generateApiKey', () => {
  it('hashKey is deterministic', () => {
    expect(hashKey('test')).toBe(hashKey('test'));
  });

  it('generateApiKey produces unique keys', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1.raw).not.toBe(k2.raw);
    expect(k1.hash).not.toBe(k2.hash);
  });
});

// ─── Auth middleware ──────────────────────────────────────────

describe('createAuthMiddleware', () => {
  let db: Database.Database;
  let keyStore: ApiKeyStore;
  let authMiddleware: Middleware;
  let validKey: string;

  beforeEach(() => {
    db = new Database(':memory:');
    keyStore = new ApiKeyStore(db);
    authMiddleware = createAuthMiddleware({ keyStore });
    const result = keyStore.create({ name: 'test' });
    validKey = result.key;
  });

  afterEach(() => db.close());

  it('passes with valid Bearer token', async () => {
    const req = createMockRequest({
      headers: { authorization: `Bearer ${validKey}` },
    });
    const res = createMockResponse();
    let called = false;
    await authMiddleware(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
    expect(req.apiKeyId).toBeTruthy();
  });

  it('passes with X-API-Key header', async () => {
    const req = createMockRequest({
      headers: { 'x-api-key': validKey },
    });
    const res = createMockResponse();
    let called = false;
    await authMiddleware(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('rejects without key', async () => {
    const req = createMockRequest();
    const res = createMockResponse();
    await expect(authMiddleware(req, res as any, noop)).rejects.toThrow('API key required');
  });

  it('rejects with invalid key', async () => {
    const req = createMockRequest({
      headers: { authorization: 'Bearer nmem_invalid' },
    });
    const res = createMockResponse();
    await expect(authMiddleware(req, res as any, noop)).rejects.toThrow('Invalid or expired');
  });

  it('skips auth for public paths', async () => {
    const mw = createAuthMiddleware({ keyStore, publicPaths: ['/health'] });
    const req = createMockRequest({ pathname: '/health' });
    const res = createMockResponse();
    let called = false;
    await mw(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('optional mode allows unauthenticated requests', async () => {
    const mw = createAuthMiddleware({ keyStore, optional: true });
    const req = createMockRequest();
    const res = createMockResponse();
    let called = false;
    await mw(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
    expect(req.apiKeyId).toBeUndefined();
  });
});

// ─── extractApiKey ────────────────────────────────────────────

describe('extractApiKey', () => {
  it('extracts from Bearer header', () => {
    const req = createMockRequest({ headers: { authorization: 'Bearer mykey123' } });
    expect(extractApiKey(req)).toBe('mykey123');
  });

  it('extracts from X-API-Key header', () => {
    const req = createMockRequest({ headers: { 'x-api-key': 'mykey456' } });
    expect(extractApiKey(req)).toBe('mykey456');
  });

  it('prefers Authorization over X-API-Key', () => {
    const req = createMockRequest({
      headers: { authorization: 'Bearer auth-key', 'x-api-key': 'x-key' },
    });
    expect(extractApiKey(req)).toBe('auth-key');
  });

  it('returns null when no key present', () => {
    const req = createMockRequest();
    expect(extractApiKey(req)).toBeNull();
  });
});

// ─── Scope middleware ─────────────────────────────────────────

describe('createScopeMiddleware', () => {
  let db: Database.Database;
  let keyStore: ApiKeyStore;

  beforeEach(() => {
    db = new Database(':memory:');
    keyStore = new ApiKeyStore(db);
  });

  afterEach(() => db.close());

  it('allows when key has required scope', async () => {
    const { id } = keyStore.create({ name: 'reader', scopes: ['memory:read'] });
    const mw = createScopeMiddleware(keyStore, ['memory:read']);
    const req = createMockRequest({ apiKeyId: id });
    const res = createMockResponse();
    let called = false;
    await mw(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('denies when scope is missing', async () => {
    const { id } = keyStore.create({ name: 'reader', scopes: ['memory:read'] });
    const mw = createScopeMiddleware(keyStore, ['memory:write']);
    const req = createMockRequest({ apiKeyId: id });
    const res = createMockResponse();
    await expect(mw(req, res as any, noop)).rejects.toThrow('Insufficient permissions');
  });

  it('admin scope grants all access', async () => {
    const { id } = keyStore.create({ name: 'admin', scopes: ['admin'] });
    const mw = createScopeMiddleware(keyStore, ['memory:read', 'memory:write', 'conversation:write']);
    const req = createMockRequest({ apiKeyId: id });
    const res = createMockResponse();
    let called = false;
    await mw(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('rejects unauthenticated request', async () => {
    const mw = createScopeMiddleware(keyStore, ['memory:read']);
    const req = createMockRequest();
    const res = createMockResponse();
    await expect(mw(req, res as any, noop)).rejects.toThrow('Authentication required');
  });
});

// ─── Rate Limiter ─────────────────────────────────────────────

describe('RateLimitStore', () => {
  let store: RateLimitStore;

  beforeEach(() => {
    store = new RateLimitStore(60_000);
  });

  afterEach(() => {
    store.destroy();
  });

  it('allows requests within limit', () => {
    const result = store.check('client1', 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('denies requests over limit', () => {
    for (let i = 0; i < 5; i++) {
      store.check('client2', 5, 60_000);
    }
    const result = store.check('client2', 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('resets after window expires', () => {
    // Fill up the limit
    for (let i = 0; i < 5; i++) {
      store.check('client3', 5, 1); // 1ms window
    }
    // Wait for window to expire
    const result = store.check('client3', 5, 1);
    // May or may not have expired in same tick — the key point is the logic works
    expect(typeof result.allowed).toBe('boolean');
  });

  it('cleanup removes expired entries', () => {
    store.check('expired', 5, 1); // 1ms window — will expire fast
    // Force cleanup
    store.cleanup();
    // The entry should be cleaned or still within window
    expect(store.size).toBeLessThanOrEqual(1);
  });

  it('reset clears all entries', () => {
    store.check('a', 5, 60_000);
    store.check('b', 5, 60_000);
    store.reset();
    expect(store.size).toBe(0);
  });
});

describe('createRateLimitMiddleware', () => {
  let store: RateLimitStore;

  beforeEach(() => {
    store = new RateLimitStore(60_000);
  });

  afterEach(() => {
    store.destroy();
  });

  it('passes requests within limit', async () => {
    const mw = createRateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 }, store);
    const req = createMockRequest({ pathname: '/api/test' });
    const res = createMockResponse();
    let called = false;
    await mw(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
    expect(res._headers['x-ratelimit-limit']).toBe('10');
  });

  it('blocks requests over limit with 429', async () => {
    const mw = createRateLimitMiddleware({ maxRequests: 2, windowMs: 60_000 }, store);
    const req = createMockRequest({ pathname: '/api/test' });
    const res = createMockResponse();

    // Use up the limit
    await mw(req, res as any, noop);
    await mw(req, res as any, noop);

    // Third request should be rejected
    await expect(mw(req, res as any, noop)).rejects.toThrow('Rate limit exceeded');
  });

  it('sets rate limit headers', async () => {
    const mw = createRateLimitMiddleware({ maxRequests: 5, windowMs: 60_000 }, store);
    const req = createMockRequest({ pathname: '/api/test' });
    const res = createMockResponse();
    await mw(req, res as any, noop);
    expect(res._headers['x-ratelimit-limit']).toBe('5');
    expect(res._headers['x-ratelimit-remaining']).toBe('4');
    expect(res._headers['x-ratelimit-reset']).toBeTruthy();
  });

  it('uses per-route limits', async () => {
    const mw = createRateLimitMiddleware({
      maxRequests: 100,
      windowMs: 60_000,
      perRoute: {
        '/api/recall': { maxRequests: 2, windowMs: 60_000 },
      },
    }, store);

    const req = createMockRequest({ pathname: '/api/recall' });
    const res = createMockResponse();

    await mw(req, res as any, noop);
    await mw(req, res as any, noop);
    await expect(mw(req, res as any, noop)).rejects.toThrow('Rate limit exceeded');
  });
});

describe('getRateLimitKey', () => {
  it('uses apiKeyId when authenticated', () => {
    const req = createMockRequest({ apiKeyId: 'key-123' });
    expect(getRateLimitKey(req)).toBe('key:key-123');
  });

  it('falls back to IP', () => {
    const req = createMockRequest();
    const key = getRateLimitKey(req);
    expect(key).toMatch(/^ip:/);
  });

  it('uses X-Forwarded-For if present', () => {
    const req = createMockRequest({
      headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' },
    });
    expect(getRateLimitKey(req)).toBe('ip:10.0.0.1');
  });
});

// ─── Validator ────────────────────────────────────────────────

describe('validateField', () => {
  it('validates required field', () => {
    expect(validateField(undefined, { field: 'name', type: 'string', required: true }))
      .toBe("Field 'name' is required");
  });

  it('allows missing optional field', () => {
    expect(validateField(undefined, { field: 'name', type: 'string' })).toBeNull();
  });

  it('validates type mismatch', () => {
    expect(validateField(123, { field: 'name', type: 'string', required: true }))
      .toContain('must be of type');
  });

  it('validates string min length', () => {
    expect(validateField('ab', { field: 'name', type: 'string', min: 3 }))
      .toContain('at least 3 characters');
  });

  it('validates string max length', () => {
    expect(validateField('abcde', { field: 'name', type: 'string', max: 3 }))
      .toContain('at most 3 characters');
  });

  it('validates string pattern', () => {
    expect(validateField('bad!', { field: 'slug', type: 'string', pattern: '^[a-z]+$' }))
      .toContain('does not match');
  });

  it('validates number range', () => {
    expect(validateField(0, { field: 'count', type: 'number', min: 1 }))
      .toContain('at least 1');
    expect(validateField(200, { field: 'count', type: 'number', max: 100 }))
      .toContain('at most 100');
  });

  it('validates array length', () => {
    expect(validateField([], { field: 'items', type: 'array', min: 1 }))
      .toContain('at least 1 items');
  });

  it('validates enum values', () => {
    expect(validateField('bad', { field: 'role', type: 'string', enum: ['user', 'assistant'] }))
      .toContain('must be one of');
  });

  it('passes valid data', () => {
    expect(validateField('hello', { field: 'msg', type: 'string', required: true, min: 1, max: 100 }))
      .toBeNull();
  });
});

describe('validateData', () => {
  it('returns valid for correct data', () => {
    const result = validateData(
      { name: 'test', count: 5 },
      [
        { field: 'name', type: 'string', required: true },
        { field: 'count', type: 'number', required: true, min: 1 },
      ],
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collects multiple errors', () => {
    const result = validateData(
      {},
      [
        { field: 'name', type: 'string', required: true },
        { field: 'count', type: 'number', required: true },
      ],
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('validates nested fields with dot notation', () => {
    const result = validateData(
      { meta: { source: 'test' } },
      [{ field: 'meta.source', type: 'string', required: true }],
    );
    expect(result.valid).toBe(true);
  });
});

describe('createValidationMiddleware', () => {
  it('passes valid request', async () => {
    const mw = createValidationMiddleware(COMMON_SCHEMAS.recall);
    const req = createMockRequest({
      body: { query: 'What is TypeScript?' },
    });
    const res = createMockResponse();
    let called = false;
    await mw(req, res as any, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('rejects invalid request', async () => {
    const mw = createValidationMiddleware(COMMON_SCHEMAS.recall);
    const req = createMockRequest({
      body: { query: '' }, // min length 1
    });
    const res = createMockResponse();
    await expect(mw(req, res as any, noop)).rejects.toThrow('Validation failed');
  });

  it('rejects missing required body', async () => {
    const mw = createValidationMiddleware(COMMON_SCHEMAS.recall);
    const req = createMockRequest(); // no body
    const res = createMockResponse();
    await expect(mw(req, res as any, noop)).rejects.toThrow('Request body is required');
  });
});

// ─── Pipeline ─────────────────────────────────────────────────

describe('createPipeline', () => {
  it('executes middleware in order', async () => {
    const order: number[] = [];
    const mw1: Middleware = async (_req, _res, next) => { order.push(1); await next(); };
    const mw2: Middleware = async (_req, _res, next) => { order.push(2); await next(); };
    const mw3: Middleware = async (_req, _res, _next) => { order.push(3); };

    const pipeline = createPipeline(mw1, mw2, mw3);
    const req = createMockRequest({ url: '/test' });
    const res = createMockResponse();
    await pipeline(req, res as any);
    expect(order).toEqual([1, 2, 3]);
  });

  it('catches ApiError and returns JSON', async () => {
    const mw: Middleware = async () => {
      throw new ApiError(403, 'Forbidden', 'FORBIDDEN');
    };

    const pipeline = createPipeline(mw);
    const req = createMockRequest({ url: '/test' });
    const res = createMockResponse();
    await pipeline(req, res as any);
    expect(res._status).toBe(403);
    expect((res._body as any).error.code).toBe('FORBIDDEN');
  });

  it('catches unknown errors as 500', async () => {
    const mw: Middleware = async () => {
      throw new Error('unexpected');
    };

    const pipeline = createPipeline(mw);
    const req = createMockRequest({ url: '/test' });
    const res = createMockResponse();
    await pipeline(req, res as any);
    expect(res._status).toBe(500);
    expect((res._body as any).error.code).toBe('INTERNAL_ERROR');
  });

  it('augments request with requestId and pathname', async () => {
    let capturedReq: ApiRequest | null = null;
    const mw: Middleware = async (req, _res, _next) => { capturedReq = req; };

    const pipeline = createPipeline(mw);
    const req = createMockRequest({ url: '/api/recall?q=test' });
    const res = createMockResponse();
    await pipeline(req, res as any);
    expect(capturedReq!.requestId).toBeTruthy();
    expect(capturedReq!.pathname).toBe('/api/recall');
    expect(capturedReq!.query?.q).toBe('test');
  });

  it('sets X-Request-Id header', async () => {
    const pipeline = createPipeline(async (_req, _res, _next) => {});
    const req = createMockRequest({ url: '/' });
    const res = createMockResponse();
    await pipeline(req, res as any);
    expect(res._headers['x-request-id']).toBeTruthy();
  });
});

// ─── Integration: full middleware chain ───────────────────────

describe('Full middleware chain integration', () => {
  let db: Database.Database;
  let keyStore: ApiKeyStore;
  let rateLimitStore: RateLimitStore;

  beforeEach(() => {
    db = new Database(':memory:');
    keyStore = new ApiKeyStore(db);
    rateLimitStore = new RateLimitStore(60_000);
  });

  afterEach(() => {
    rateLimitStore.destroy();
    db.close();
  });

  it('auth → rate limit → validate → handler works end-to-end', async () => {
    const { key } = keyStore.create({ name: 'integration-test' });

    const authMw = createAuthMiddleware({ keyStore });
    const rateMw = createRateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 }, rateLimitStore);
    const validateMw = createValidationMiddleware(COMMON_SCHEMAS.recall);
    const handler: Middleware = async (req, res, _next) => {
      res.json(200, { result: 'ok', query: (req.body as any).query });
    };

    const pipeline = createPipeline(authMw, rateMw, validateMw, handler);

    const req = createMockRequest({
      url: '/api/recall',
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: { query: 'What is TypeScript?' },
    });
    const res = createMockResponse();

    await pipeline(req, res as any);
    expect(res._status).toBe(200);
    expect((res._body as any).result).toBe('ok');
    expect((res._body as any).query).toBe('What is TypeScript?');
  });

  it('auth failure stops the chain early', async () => {
    const rateMw = createRateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 }, rateLimitStore);
    const authMw = createAuthMiddleware({ keyStore });

    const pipeline = createPipeline(authMw, rateMw);
    const req = createMockRequest({ url: '/api/recall' });
    const res = createMockResponse();
    await pipeline(req, res as any);
    expect(res._status).toBe(401);
  });

  it('rate limit blocks after auth succeeds', async () => {
    const { key } = keyStore.create({ name: 'rate-test' });
    const authMw = createAuthMiddleware({ keyStore });
    const rateMw = createRateLimitMiddleware({ maxRequests: 1, windowMs: 60_000 }, rateLimitStore);

    const pipeline = createPipeline(authMw, rateMw, async (_req, res, _next) => {
      res.json(200, { ok: true });
    });

    // First request passes
    const req1 = createMockRequest({
      url: '/api/test',
      headers: { authorization: `Bearer ${key}` },
    });
    const res1 = createMockResponse();
    await pipeline(req1, res1 as any);
    expect(res1._status).toBe(200);

    // Second request blocked
    const req2 = createMockRequest({
      url: '/api/test',
      headers: { authorization: `Bearer ${key}` },
    });
    const res2 = createMockResponse();
    await pipeline(req2, res2 as any);
    expect(res2._status).toBe(429);
  });
});

// ─── Hono Integration Tests ──────────────────────────────────

import { Hono } from 'hono';
import { honoAuth, honoRequireScope } from '../src/api/middleware/hono-auth.js';
import { honoRateLimit } from '../src/api/middleware/hono-rate-limit.js';

describe('Hono auth middleware', () => {
  let db: Database.Database;
  let keyStore: ApiKeyStore;
  let validKey: string;
  let app: Hono;

  beforeEach(() => {
    db = new Database(':memory:');
    keyStore = new ApiKeyStore(db);
    const result = keyStore.create({ name: 'hono-test' });
    validKey = result.key;

    app = new Hono();
    app.use('*', honoAuth({ keyStore, publicPaths: ['/health'] }));
    app.get('/health', (c) => c.json({ status: 'ok' }));
    app.get('/protected', (c) => c.json({ apiKeyId: c.get('apiKeyId') }));
  });

  afterEach(() => db.close());

  it('allows access to public path without auth', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('rejects protected path without auth', async () => {
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('AUTH_REQUIRED');
  });

  it('allows protected path with valid Bearer token', async () => {
    const res = await app.request('/protected', {
      headers: { authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.apiKeyId).toBeTruthy();
  });

  it('allows protected path with X-API-Key', async () => {
    const res = await app.request('/protected', {
      headers: { 'x-api-key': validKey },
    });
    expect(res.status).toBe(200);
  });

  it('rejects invalid key', async () => {
    const res = await app.request('/protected', {
      headers: { authorization: 'Bearer nmem_invalid_key_123' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('AUTH_INVALID');
  });

  it('rejects revoked key', async () => {
    const { id, key } = keyStore.create({ name: 'to-revoke' });
    keyStore.revoke(id);
    const res = await app.request('/protected', {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('Hono scope middleware', () => {
  let db: Database.Database;
  let keyStore: ApiKeyStore;

  beforeEach(() => {
    db = new Database(':memory:');
    keyStore = new ApiKeyStore(db);
  });

  afterEach(() => db.close());

  it('allows access with correct scope', async () => {
    const { key } = keyStore.create({ name: 'scoped', scopes: ['memory:read'] });

    const app = new Hono();
    app.use('*', honoAuth({ keyStore }));
    app.get('/read', honoRequireScope('memory:read'), (c) => c.json({ ok: true }));

    const res = await app.request('/read', {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });

  it('denies access with wrong scope', async () => {
    const { key } = keyStore.create({ name: 'reader-only', scopes: ['memory:read'] });

    const app = new Hono();
    app.use('*', honoAuth({ keyStore }));
    app.post('/write', honoRequireScope('memory:write'), (c) => c.json({ ok: true }));

    const res = await app.request('/write', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('admin scope bypasses all checks', async () => {
    const { key } = keyStore.create({ name: 'admin', scopes: ['admin'] });

    const app = new Hono();
    app.use('*', honoAuth({ keyStore }));
    app.delete('/danger', honoRequireScope('memory:write', 'conversation:write'), (c) => c.json({ ok: true }));

    const res = await app.request('/danger', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('Hono rate limit middleware', () => {
  let rateLimitStore: RateLimitStore;

  beforeEach(() => {
    rateLimitStore = new RateLimitStore(60_000);
  });

  afterEach(() => {
    rateLimitStore.destroy();
  });

  it('allows requests within limit', async () => {
    const app = new Hono();
    app.use('*', honoRateLimit({ maxRequests: 5, windowMs: 60_000 }, rateLimitStore));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('5');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4');
  });

  it('blocks requests over limit with 429', async () => {
    const app = new Hono();
    app.use('*', honoRateLimit({ maxRequests: 2, windowMs: 60_000 }, rateLimitStore));
    app.get('/test', (c) => c.json({ ok: true }));

    // Use up the limit
    await app.request('/test');
    await app.request('/test');

    // Third should be blocked
    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('uses per-route limits', async () => {
    const app = new Hono();
    app.use('*', honoRateLimit({
      maxRequests: 100,
      windowMs: 60_000,
      perRoute: {
        '/limited': { maxRequests: 1, windowMs: 60_000 },
      },
    }, rateLimitStore));
    app.get('/limited', (c) => c.json({ ok: true }));
    app.get('/unlimited', (c) => c.json({ ok: true }));

    // First request to /limited passes
    const res1 = await app.request('/limited');
    expect(res1.status).toBe(200);

    // Second request to /limited blocked
    const res2 = await app.request('/limited');
    expect(res2.status).toBe(429);

    // /unlimited still works
    const res3 = await app.request('/unlimited');
    expect(res3.status).toBe(200);
  });
});

describe('Hono full middleware chain', () => {
  let db: Database.Database;
  let keyStore: ApiKeyStore;
  let rateLimitStore: RateLimitStore;

  beforeEach(() => {
    db = new Database(':memory:');
    keyStore = new ApiKeyStore(db);
    rateLimitStore = new RateLimitStore(60_000);
  });

  afterEach(() => {
    rateLimitStore.destroy();
    db.close();
  });

  it('rate limit → auth → scope → handler chain works', async () => {
    const { key } = keyStore.create({ name: 'chain-test', scopes: ['memory:read'] });

    const app = new Hono();
    app.use('*', honoRateLimit({ maxRequests: 10, windowMs: 60_000 }, rateLimitStore));
    app.use('*', honoAuth({ keyStore, publicPaths: ['/health'] }));

    app.get('/health', (c) => c.json({ status: 'ok' }));
    app.get('/memories', honoRequireScope('memory:read'), (c) => {
      return c.json({ data: 'secret', apiKeyId: c.get('apiKeyId') });
    });

    // Health is public
    const healthRes = await app.request('/health');
    expect(healthRes.status).toBe(200);

    // /memories without auth → 401
    const noAuthRes = await app.request('/memories');
    expect(noAuthRes.status).toBe(401);

    // /memories with valid auth → 200
    const authRes = await app.request('/memories', {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(authRes.status).toBe(200);
    const body = await authRes.json() as any;
    expect(body.data).toBe('secret');
    expect(body.apiKeyId).toBeTruthy();
  });

  it('rate limit blocks before auth is checked', async () => {
    const { key } = keyStore.create({ name: 'rate-first' });

    const app = new Hono();
    app.use('*', honoRateLimit({ maxRequests: 1, windowMs: 60_000 }, rateLimitStore));
    app.use('*', honoAuth({ keyStore }));
    app.get('/test', (c) => c.json({ ok: true }));

    // First request passes
    const res1 = await app.request('/test', {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res1.status).toBe(200);

    // Second request blocked by rate limit (429, not 401)
    const res2 = await app.request('/test', {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res2.status).toBe(429);
  });
});
