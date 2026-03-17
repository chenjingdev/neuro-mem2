/**
 * HTTP forwarder — sends intercepted requests to their upstream LLM API
 * and returns the response. Supports both buffered and streaming modes.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { InterceptedRequest, ForwardResult, ProxyConfig } from './types.js';

/**
 * Forward an intercepted request to the upstream LLM API.
 * Returns the full response (buffered).
 */
export async function forwardRequest(
  intercepted: InterceptedRequest,
  config: Pick<ProxyConfig, 'requestTimeout'>,
): Promise<ForwardResult> {
  const startTime = Date.now();
  const url = new URL(intercepted.url);
  const isHttps = url.protocol === 'https:';

  const requestModule = isHttps ? https : http;

  // Build outgoing headers, removing proxy-specific ones
  const outHeaders: Record<string, string | string[] | undefined> = {
    ...intercepted.headers,
  };
  // Ensure host header matches target
  outHeaders['host'] = url.host;
  // Set correct content-length from raw body
  if (intercepted.rawBody.length > 0) {
    outHeaders['content-length'] = String(intercepted.rawBody.length);
  }

  return new Promise<ForwardResult>((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: intercepted.method,
      headers: outHeaders,
      timeout: config.requestTimeout,
    };

    const upstream = requestModule.request(options, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const responseHeaders: Record<string, string | string[] | undefined> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          responseHeaders[key] = val;
        }

        resolve({
          statusCode: res.statusCode ?? 502,
          headers: responseHeaders,
          body,
          isStreaming: intercepted.isStreaming,
          latencyMs: Date.now() - startTime,
        });
      });

      res.on('error', reject);
    });

    upstream.on('timeout', () => {
      upstream.destroy();
      reject(new Error(`Upstream request timed out after ${config.requestTimeout}ms`));
    });

    upstream.on('error', reject);

    // Send request body
    if (intercepted.rawBody.length > 0) {
      upstream.write(intercepted.rawBody);
    }
    upstream.end();
  });
}

/**
 * Forward an intercepted request and pipe the response directly to a client response.
 * Used for streaming (SSE) responses to avoid buffering.
 */
export function forwardStreaming(
  intercepted: InterceptedRequest,
  clientRes: http.ServerResponse,
  config: Pick<ProxyConfig, 'requestTimeout'>,
): Promise<ForwardResult> {
  const startTime = Date.now();
  const url = new URL(intercepted.url);
  const isHttps = url.protocol === 'https:';
  const requestModule = isHttps ? https : http;

  const outHeaders: Record<string, string | string[] | undefined> = {
    ...intercepted.headers,
  };
  outHeaders['host'] = url.host;
  if (intercepted.rawBody.length > 0) {
    outHeaders['content-length'] = String(intercepted.rawBody.length);
  }

  return new Promise<ForwardResult>((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: intercepted.method,
      headers: outHeaders,
      timeout: config.requestTimeout,
    };

    const upstream = requestModule.request(options, (res) => {
      // Pipe upstream response headers to client
      const responseHeaders: Record<string, string | string[] | undefined> = {};
      for (const [key, val] of Object.entries(res.headers)) {
        responseHeaders[key] = val;
        if (val !== undefined) {
          clientRes.setHeader(key, val);
        }
      }
      clientRes.writeHead(res.statusCode ?? 502);

      // Collect body while piping
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        clientRes.write(chunk);
      });

      res.on('end', () => {
        clientRes.end();
        resolve({
          statusCode: res.statusCode ?? 502,
          headers: responseHeaders,
          body: Buffer.concat(chunks),
          isStreaming: true,
          latencyMs: Date.now() - startTime,
        });
      });

      res.on('error', (err) => {
        clientRes.end();
        reject(err);
      });
    });

    upstream.on('timeout', () => {
      upstream.destroy();
      reject(new Error(`Upstream streaming request timed out after ${config.requestTimeout}ms`));
    });

    upstream.on('error', reject);

    if (intercepted.rawBody.length > 0) {
      upstream.write(intercepted.rawBody);
    }
    upstream.end();
  });
}
