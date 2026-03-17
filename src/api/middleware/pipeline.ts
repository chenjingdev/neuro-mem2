/**
 * Middleware pipeline — composes multiple middleware functions into a single handler.
 * Includes error handling and request augmentation.
 */
import { v4 as uuidv4 } from 'uuid';
import type { ApiRequest, ApiResponse, Middleware } from './types.js';
import { ApiError } from './types.js';

/**
 * Augment a raw ServerResponse with the json() helper.
 */
export function augmentResponse(res: ApiResponse): void {
  if (!res.json) {
    res.json = function jsonResponse(statusCode: number, data: unknown): void {
      const body = JSON.stringify(data);
      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
      });
      res.end(body);
    };
  }
}

/**
 * Augment a raw IncomingMessage with parsed URL parts and request ID.
 */
export function augmentRequest(req: ApiRequest): void {
  req.requestId = req.requestId ?? uuidv4();
  if (!req.pathname && req.url) {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      req.pathname = parsed.pathname;
      req.query = Object.fromEntries(parsed.searchParams.entries());
    } catch {
      req.pathname = req.url;
      req.query = {};
    }
  }
}

/**
 * Compose middleware functions into a pipeline that executes them in order.
 * Each middleware calls `next()` to proceed to the next one.
 * Errors (thrown or ApiError) are caught and returned as JSON responses.
 */
export function createPipeline(...middlewares: Middleware[]): (req: ApiRequest, res: ApiResponse) => Promise<void> {
  return async (req: ApiRequest, res: ApiResponse) => {
    augmentRequest(req);
    augmentResponse(res);

    // Set common headers
    res.setHeader('X-Request-Id', req.requestId!);

    let index = 0;

    const next = async (): Promise<void> => {
      if (index >= middlewares.length) return;
      const mw = middlewares[index++];
      await mw(req, res, next);
    };

    try {
      await next();
    } catch (err) {
      handleError(err, req, res);
    }
  };
}

/**
 * Error handler — converts errors to JSON responses.
 */
export function handleError(err: unknown, req: ApiRequest, res: ApiResponse): void {
  // Don't write if headers already sent
  if (res.headersSent) return;

  if (err instanceof ApiError) {
    res.json(err.statusCode, {
      error: {
        code: err.code,
        message: err.message,
        requestId: req.requestId,
      },
    });
    return;
  }

  // Unknown error — 500
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.json(500, {
    error: {
      code: 'INTERNAL_ERROR',
      message,
      requestId: req.requestId,
    },
  });
}
