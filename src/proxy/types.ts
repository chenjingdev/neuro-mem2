/**
 * Types for the LLM API proxy server.
 *
 * The proxy transparently intercepts requests to LLM API endpoints
 * (OpenAI, Anthropic, etc.) and forwards them, allowing middleware
 * hooks for memory context injection.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Known LLM API provider endpoints */
export interface LLMEndpoint {
  /** Human-readable name (e.g., "OpenAI", "Anthropic") */
  name: string;
  /** Hostname patterns to match (e.g., "api.openai.com") */
  hostPatterns: string[];
  /** Chat completion path patterns (regex) */
  chatPaths: RegExp[];
}

/** Proxy server configuration */
export interface ProxyConfig {
  /** Port to listen on (default: 9800) */
  port: number;
  /** Host to bind to (default: "127.0.0.1") */
  host: string;
  /** Request timeout in ms (default: 120_000) */
  requestTimeout: number;
  /** Maximum request body size in bytes (default: 10MB) */
  maxBodySize: number;
  /** Custom LLM endpoints to intercept (merged with built-in ones) */
  customEndpoints: LLMEndpoint[];
  /** Enable verbose debug logging (default: false) */
  debug: boolean;
  /** Enable HTTPS CONNECT tunneling (default: true) */
  enableConnect: boolean;
}

/** Parsed information about an intercepted request */
export interface InterceptedRequest {
  /** The LLM provider this request targets */
  provider: LLMEndpoint;
  /** Full target URL */
  url: string;
  /** HTTP method */
  method: string;
  /** Request headers (sanitized copy) */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed request body (for chat completion requests) */
  body: unknown;
  /** Raw request body buffer */
  rawBody: Buffer;
  /** Whether this is a chat/completion endpoint */
  isChatCompletion: boolean;
  /** Whether response is streaming (SSE) */
  isStreaming: boolean;
  /** Timestamp when request was received */
  receivedAt: number;
}

/** Result of forwarding a request upstream */
export interface ForwardResult {
  /** HTTP status code from upstream */
  statusCode: number;
  /** Response headers from upstream */
  headers: Record<string, string | string[] | undefined>;
  /** Response body buffer */
  body: Buffer;
  /** Whether response was streamed (SSE) */
  isStreaming: boolean;
  /** Time taken for upstream round-trip in ms */
  latencyMs: number;
}

/**
 * Middleware hook that can inspect/modify requests before forwarding.
 * Return the (possibly modified) InterceptedRequest, or null to skip forwarding.
 */
export type RequestMiddleware = (
  req: InterceptedRequest,
) => Promise<InterceptedRequest | null> | InterceptedRequest | null;

/**
 * Middleware hook that can inspect/modify responses after receiving from upstream.
 * Return the (possibly modified) ForwardResult.
 */
export type ResponseMiddleware = (
  req: InterceptedRequest,
  res: ForwardResult,
) => Promise<ForwardResult> | ForwardResult;

/** Proxy server events */
export interface ProxyEvents {
  'request.intercepted': (req: InterceptedRequest) => void;
  'request.forwarded': (req: InterceptedRequest, res: ForwardResult) => void;
  'request.passthrough': (url: string, method: string) => void;
  'request.error': (url: string, error: Error) => void;
  'connect.tunnel': (host: string, port: number) => void;
  'server.listening': (host: string, port: number) => void;
  'server.error': (error: Error) => void;
  'server.closed': () => void;
}

/** Stats tracked by the proxy */
export interface ProxyStats {
  totalRequests: number;
  interceptedRequests: number;
  passthroughRequests: number;
  connectTunnels: number;
  errors: number;
  startedAt: number;
  bytesForwarded: number;
}

/** Default proxy configuration values */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 9800,
  host: '127.0.0.1',
  requestTimeout: 120_000,
  maxBodySize: 10 * 1024 * 1024, // 10 MB
  customEndpoints: [],
  debug: false,
  enableConnect: true,
};

/** Built-in LLM API endpoint definitions */
export const BUILTIN_LLM_ENDPOINTS: LLMEndpoint[] = [
  {
    name: 'OpenAI',
    hostPatterns: ['api.openai.com'],
    chatPaths: [
      /^\/v1\/chat\/completions/,
      /^\/v1\/completions/,
      /^\/v1\/responses/,
    ],
  },
  {
    name: 'Anthropic',
    hostPatterns: ['api.anthropic.com'],
    chatPaths: [
      /^\/v1\/messages/,
      /^\/v1\/complete/,
    ],
  },
  {
    name: 'Google AI',
    hostPatterns: ['generativelanguage.googleapis.com'],
    chatPaths: [
      /^\/v1(beta)?\/models\/.+:generateContent/,
      /^\/v1(beta)?\/models\/.+:streamGenerateContent/,
    ],
  },
  {
    name: 'Azure OpenAI',
    hostPatterns: ['*.openai.azure.com'],
    chatPaths: [
      /^\/openai\/deployments\/.+\/chat\/completions/,
      /^\/openai\/deployments\/.+\/completions/,
    ],
  },
];
