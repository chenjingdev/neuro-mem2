/**
 * Request interceptor — reads incoming HTTP request bodies,
 * classifies them, and builds InterceptedRequest objects.
 */

import type { IncomingMessage } from 'node:http';
import { EndpointMatcher } from './endpoint-matcher.js';
import type { InterceptedRequest, ProxyConfig } from './types.js';

/**
 * Read the full body of an IncomingMessage into a Buffer.
 * Enforces maxBodySize limit.
 */
export function readBody(
  req: IncomingMessage,
  maxSize: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body exceeds max size of ${maxSize} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

/**
 * Parse the target URL from an incoming proxy request.
 * HTTP proxy requests use absolute URLs; regular requests use relative paths.
 */
export function parseTargetUrl(req: IncomingMessage): URL | null {
  const rawUrl = req.url;
  if (!rawUrl) return null;

  try {
    // Absolute URL (proxy request): "http://api.openai.com/v1/chat/completions"
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      return new URL(rawUrl);
    }
    // Relative URL with Host header
    const host = req.headers.host;
    if (host) {
      return new URL(rawUrl, `http://${host}`);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect if a request body indicates streaming (SSE).
 * OpenAI uses "stream": true in the body.
 * Anthropic uses "stream": true in the body.
 */
export function detectStreaming(body: unknown): boolean {
  if (body && typeof body === 'object' && 'stream' in (body as any)) {
    return (body as any).stream === true;
  }
  return false;
}

/**
 * Try to safely parse JSON from a buffer. Returns undefined on failure.
 */
export function tryParseJson(buf: Buffer): unknown | undefined {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    return undefined;
  }
}

export class RequestInterceptor {
  private readonly matcher: EndpointMatcher;
  private readonly maxBodySize: number;

  constructor(matcher: EndpointMatcher, config: Pick<ProxyConfig, 'maxBodySize'>) {
    this.matcher = matcher;
    this.maxBodySize = config.maxBodySize;
  }

  /**
   * Process an incoming HTTP request.
   * Returns an InterceptedRequest if it targets a known LLM endpoint,
   * or null for pass-through.
   */
  async intercept(req: IncomingMessage): Promise<InterceptedRequest | null> {
    const targetUrl = parseTargetUrl(req);
    if (!targetUrl) return null;

    const hostname = targetUrl.hostname;
    const path = targetUrl.pathname + targetUrl.search;

    const match = this.matcher.match(hostname, targetUrl.pathname);
    if (!match) return null;

    // Read body for LLM API requests
    const rawBody = await readBody(req, this.maxBodySize);
    const body = tryParseJson(rawBody);
    const isStreaming = detectStreaming(body);

    // Build sanitized headers copy
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      // Skip hop-by-hop headers
      if (isHopByHopHeader(key)) continue;
      headers[key] = val;
    }

    return {
      provider: match.endpoint,
      url: targetUrl.toString(),
      method: req.method ?? 'GET',
      headers,
      body,
      rawBody,
      isChatCompletion: match.isChatCompletion,
      isStreaming,
      receivedAt: Date.now(),
    };
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function isHopByHopHeader(header: string): boolean {
  return HOP_BY_HOP_HEADERS.has(header.toLowerCase());
}
