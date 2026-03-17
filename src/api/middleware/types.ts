/**
 * Common types for API middleware chain.
 * Uses a framework-agnostic approach based on Node.js HTTP primitives.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Extended request with parsed body and metadata */
export interface ApiRequest extends IncomingMessage {
  /** Parsed JSON body (populated by body parser middleware) */
  body?: unknown;
  /** Authenticated API key ID (populated by auth middleware) */
  apiKeyId?: string;
  /** Request ID for tracing */
  requestId?: string;
  /** Parsed URL path */
  pathname?: string;
  /** Parsed query parameters */
  query?: Record<string, string>;
}

/** Extended response with helper methods */
export interface ApiResponse extends ServerResponse {
  /** Send JSON response */
  json(statusCode: number, data: unknown): void;
}

/** Middleware function signature */
export type Middleware = (
  req: ApiRequest,
  res: ApiResponse,
  next: () => Promise<void>,
) => Promise<void> | void;

/** Middleware error with HTTP status */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'ERROR',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** API key record stored in database */
export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  isRevoked: boolean;
}

/** Options for creating a new API key */
export interface CreateApiKeyOptions {
  name: string;
  scopes?: string[];
  expiresInMs?: number;
}

/** Result of creating a new API key (includes the raw key, shown only once) */
export interface CreateApiKeyResult {
  id: string;
  key: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
}

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Max requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Optional: different limits per scope/path */
  perRoute?: Record<string, { maxRequests: number; windowMs: number }>;
}

/** Rate limit state for a single client */
export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** Request validation schema (simple, zero-dependency) */
export interface ValidationRule {
  /** Field name (supports dot notation for nested fields) */
  field: string;
  /** Expected type */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** Whether the field is required */
  required?: boolean;
  /** Min length for strings, min value for numbers, min items for arrays */
  min?: number;
  /** Max length for strings, max value for numbers, max items for arrays */
  max?: number;
  /** Regex pattern for strings */
  pattern?: string;
  /** Allowed values */
  enum?: unknown[];
}

/** Validation schema for an endpoint */
export interface ValidationSchema {
  body?: ValidationRule[];
  query?: ValidationRule[];
}

/** Available API scopes */
export const API_SCOPES = [
  'memory:read',
  'memory:write',
  'conversation:read',
  'conversation:write',
  'admin',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];
