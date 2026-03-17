/**
 * Proxy module — HTTP/HTTPS proxy server that intercepts LLM API requests,
 * parses them, retrieves memory context, and injects it into requests.
 */

// ── Proxy Server Core ──
export { ProxyServer } from './proxy-server.js';

// ── Endpoint Matching ──
export { EndpointMatcher, matchHostPattern, matchChatPath } from './endpoint-matcher.js';

// ── Request Interception ──
export {
  RequestInterceptor,
  readBody,
  parseTargetUrl,
  detectStreaming,
  tryParseJson,
} from './request-interceptor.js';

// ── Forwarding ──
export { forwardRequest, forwardStreaming } from './forwarder.js';

// ── Types ──
export {
  DEFAULT_PROXY_CONFIG as DEFAULT_PROXY_SERVER_CONFIG,
  BUILTIN_LLM_ENDPOINTS,
} from './types.js';
export type {
  ProxyConfig as ProxyServerConfig,
  ProxyEvents,
  ProxyStats,
  InterceptedRequest,
  ForwardResult,
  RequestMiddleware,
  ResponseMiddleware,
  LLMEndpoint,
} from './types.js';

// ── Configuration ──
export {
  resolveProxyConfig,
  loadConfigFile,
  loadEnvConfig,
  detectProvider,
  validateProxyConfig,
  generateSampleConfig,
  DEFAULT_PROXY_CONFIG,
} from './config.js';
export type {
  ProxyConfig,
  ProxyConfigInput,
  LogLevel,
  TargetProvider,
  ConfigFileContent,
} from './config.js';

// ── Request Parser ──
export {
  parseRequest,
  detectApiFormat,
  extractOpenAIContent,
  extractLatestUserQuery,
  DEFAULT_PARSER_CONFIG,
} from './request-parser.js';

export type {
  ApiFormat,
  ParsedMessage,
  ParsedRequest,
  RequestParserConfig,
} from './request-parser.js';

// ── Context Injection ──
export {
  injectMemoryContext,
  formatMemories,
  buildContextBlock,
  extractQueryFromBody,
} from './context-injector.js';
export type {
  InjectionResult,
  InjectionOptions,
} from './context-injector.js';

// ── Memory Retrieval Bridge ──
export {
  MemoryRetrievalBridge,
  DEFAULT_BRIDGE_CONFIG,
} from './memory-retrieval-bridge.js';

export type {
  MemoryBridgeConfig,
  MemoryContextBlock,
  ContextItem,
  MemoryBridgeResult,
} from './memory-retrieval-bridge.js';

// ── Proxy Launcher (unified entry point) ──
export {
  launchProxy,
} from './proxy-launcher.js';

export type {
  ProxyLaunchOptions,
  LaunchedProxy,
} from './proxy-launcher.js';
