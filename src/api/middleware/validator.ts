/**
 * Request validation middleware — validates body and query parameters
 * against a simple schema. Zero external dependencies.
 */
import type { Middleware, ApiRequest, ApiResponse, ValidationRule, ValidationSchema } from './types.js';
import { ApiError } from './types.js';

/** Get a nested value from an object using dot notation */
function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Validate a single field against a rule */
export function validateField(value: unknown, rule: ValidationRule): string | null {
  // Required check
  if (value === undefined || value === null) {
    if (rule.required) {
      return `Field '${rule.field}' is required`;
    }
    return null; // Optional and not provided — skip further checks
  }

  // Type check
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType !== rule.type) {
    return `Field '${rule.field}' must be of type '${rule.type}', got '${actualType}'`;
  }

  // Enum check
  if (rule.enum && !rule.enum.includes(value)) {
    return `Field '${rule.field}' must be one of: ${rule.enum.join(', ')}`;
  }

  // String-specific validations
  if (rule.type === 'string' && typeof value === 'string') {
    if (rule.min !== undefined && value.length < rule.min) {
      return `Field '${rule.field}' must be at least ${rule.min} characters`;
    }
    if (rule.max !== undefined && value.length > rule.max) {
      return `Field '${rule.field}' must be at most ${rule.max} characters`;
    }
    if (rule.pattern) {
      const regex = new RegExp(rule.pattern);
      if (!regex.test(value)) {
        return `Field '${rule.field}' does not match required pattern`;
      }
    }
  }

  // Number-specific validations
  if (rule.type === 'number' && typeof value === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      return `Field '${rule.field}' must be at least ${rule.min}`;
    }
    if (rule.max !== undefined && value > rule.max) {
      return `Field '${rule.field}' must be at most ${rule.max}`;
    }
  }

  // Array-specific validations
  if (rule.type === 'array' && Array.isArray(value)) {
    if (rule.min !== undefined && value.length < rule.min) {
      return `Field '${rule.field}' must have at least ${rule.min} items`;
    }
    if (rule.max !== undefined && value.length > rule.max) {
      return `Field '${rule.field}' must have at most ${rule.max} items`;
    }
  }

  return null;
}

/** Validate a set of rules against data */
export function validateData(
  data: unknown,
  rules: ValidationRule[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const rule of rules) {
    const value = getNestedValue(data, rule.field);
    const error = validateField(value, rule);
    if (error) {
      errors.push(error);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Create request validation middleware for a specific endpoint.
 */
export function createValidationMiddleware(schema: ValidationSchema): Middleware {
  return async (req: ApiRequest, _res: ApiResponse, next: () => Promise<void>) => {
    const errors: string[] = [];

    // Validate body
    if (schema.body && schema.body.length > 0) {
      if (req.body === undefined || req.body === null) {
        // Check if any body fields are required
        const hasRequired = schema.body.some((r) => r.required);
        if (hasRequired) {
          throw new ApiError(400, 'Request body is required.', 'BODY_REQUIRED');
        }
      } else {
        const result = validateData(req.body, schema.body);
        errors.push(...result.errors);
      }
    }

    // Validate query params
    if (schema.query && schema.query.length > 0) {
      const result = validateData(req.query ?? {}, schema.query);
      errors.push(...result.errors);
    }

    if (errors.length > 0) {
      throw new ApiError(400, `Validation failed: ${errors.join('; ')}`, 'VALIDATION_ERROR');
    }

    return next();
  };
}

/**
 * Body parser middleware — parses JSON request bodies.
 * Must be placed before validation middleware in the chain.
 */
export function createBodyParserMiddleware(maxBodySizeBytes: number = 1_048_576): Middleware {
  return (req: ApiRequest, _res: ApiResponse, next: () => Promise<void>) => {
    return new Promise<void>((resolve, reject) => {
      const contentType = req.headers['content-type'];

      // Skip body parsing for GET/HEAD/DELETE without body
      if (req.method === 'GET' || req.method === 'HEAD') {
        resolve(next());
        return;
      }

      // Only parse JSON
      if (contentType && !contentType.includes('application/json')) {
        reject(new ApiError(415, 'Content-Type must be application/json', 'UNSUPPORTED_MEDIA_TYPE'));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBodySizeBytes) {
          reject(new ApiError(413, `Request body exceeds maximum size of ${maxBodySizeBytes} bytes`, 'BODY_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(next());
          return;
        }

        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          req.body = JSON.parse(raw);
          resolve(next());
        } catch {
          reject(new ApiError(400, 'Invalid JSON in request body', 'INVALID_JSON'));
        }
      });

      req.on('error', (err) => {
        reject(new ApiError(400, `Request error: ${err.message}`, 'REQUEST_ERROR'));
      });
    });
  };
}

/** Common validation schemas for nero-mem2 API endpoints */
export const COMMON_SCHEMAS = {
  /** POST /api/conversations */
  ingestConversation: {
    body: [
      { field: 'messages', type: 'array' as const, required: true, min: 1 },
      { field: 'metadata', type: 'object' as const, required: false },
    ],
  } satisfies ValidationSchema,

  /** POST /api/recall */
  recall: {
    body: [
      { field: 'query', type: 'string' as const, required: true, min: 1, max: 10_000 },
      { field: 'sessionId', type: 'string' as const, required: false },
      { field: 'topK', type: 'number' as const, required: false, min: 1, max: 100 },
    ],
  } satisfies ValidationSchema,

  /** POST /api/keys */
  createApiKey: {
    body: [
      { field: 'name', type: 'string' as const, required: true, min: 1, max: 255 },
      { field: 'scopes', type: 'array' as const, required: false },
      { field: 'expiresInMs', type: 'number' as const, required: false, min: 1 },
    ],
  } satisfies ValidationSchema,
} as const;
