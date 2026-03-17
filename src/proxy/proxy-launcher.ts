/**
 * Proxy Launcher — unified entry point that ties together:
 *   - ProxyConfig (env vars + config file)
 *   - ProxyServer (HTTP/HTTPS proxy)
 *   - MemoryRetrievalBridge (dual-path retrieval → context injection)
 *   - Context Injector (system prompt modification)
 *
 * Usage:
 *   // Zero-config (reads env vars + ~/.nero-mem/proxy.json)
 *   const proxy = await launchProxy();
 *
 *   // Programmatic config
 *   const proxy = await launchProxy({ port: 9000, apiKey: 'sk-...' });
 *
 *   // Shutdown
 *   await proxy.close();
 *
 * Client configuration examples:
 *   # Claude Code
 *   export ANTHROPIC_BASE_URL=http://localhost:8420
 *
 *   # OpenAI-compatible (Codex, etc.)
 *   export OPENAI_BASE_URL=http://localhost:8420
 *
 *   # HTTP proxy mode (any client)
 *   export HTTP_PROXY=http://localhost:8420
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import { ProxyServer } from './proxy-server.js';
import { MemoryRetrievalBridge, type MemoryBridgeConfig } from './memory-retrieval-bridge.js';
import { parseRequest } from './request-parser.js';
import {
  injectMemoryContext,
  type InjectionOptions,
} from './context-injector.js';
import {
  resolveProxyConfig,
  validateProxyConfig,
  type ProxyConfig as NeroProxyConfig,
  type ProxyConfigInput,
  type TargetProvider,
} from './config.js';
import type { InterceptedRequest, ForwardResult, ProxyConfig as ServerProxyConfig } from './types.js';

// ─── Launch Options ──────────────────────────────────────

export interface ProxyLaunchOptions extends ProxyConfigInput {
  /** Pre-configured database (if not provided, creates from dbPath) */
  db?: Database.Database;
  /** Embedding provider for vector search */
  embeddingProvider?: EmbeddingProvider;
  /** Memory bridge config overrides */
  bridgeConfig?: Partial<MemoryBridgeConfig>;
}

// ─── Launched Proxy Handle ───────────────────────────────

export interface LaunchedProxy {
  /** The underlying ProxyServer instance */
  server: ProxyServer;
  /** The resolved configuration */
  config: NeroProxyConfig;
  /** Host and port the proxy is listening on */
  address: { host: string; port: number };
  /** Close the proxy server */
  close(): Promise<void>;
  /** Get proxy stats */
  getStats(): ReturnType<ProxyServer['getStats']>;
  /** Whether injection is currently enabled */
  injectionEnabled: boolean;
  /** Toggle injection on/off */
  setInjection(enabled: boolean): void;
}

// ─── Provider Mapping ────────────────────────────────────

/**
 * Map our config's TargetProvider to an InjectionOptions provider.
 */
function mapProvider(provider: TargetProvider): InjectionOptions['provider'] {
  return provider;
}

// ─── Memory Injection Middleware ──────────────────────────

function createInjectionMiddleware(
  bridge: MemoryRetrievalBridge | null,
  config: NeroProxyConfig,
): (req: InterceptedRequest) => Promise<InterceptedRequest | null> {
  let injectionEnabled = config.injectionEnabled;

  const middleware = async (req: InterceptedRequest): Promise<InterceptedRequest | null> => {
    // Skip if injection is disabled or no bridge available
    if (!injectionEnabled || !bridge) return req;

    // Only inject for chat completion endpoints
    if (!req.isChatCompletion) return req;

    // Parse request to get user query
    const parsed = parseRequest(req.body);
    if (!parsed.latestUserMessage) return req;

    try {
      // Retrieve memories
      const result = await bridge.retrieve(parsed);

      if (!result.retrieved || !result.context || result.context.itemCount === 0) {
        return req;
      }

      // Inject context into the request body
      const injected = injectMemoryContext(
        req.body,
        result.context.items.map(item => ({
          nodeId: item.nodeId,
          nodeType: item.nodeType as any,
          score: item.score,
          content: item.content,
          sources: item.sources as any[],
          sourceScores: {},
        })),
        {
          template: config.injectionTemplate,
          maxMemories: config.maxMemories,
          provider: mapProvider(config.targetProvider),
        },
      );

      if (injected.modified) {
        // Rebuild rawBody with modified body
        const newRawBody = Buffer.from(JSON.stringify(injected.body));
        return {
          ...req,
          body: injected.body,
          rawBody: newRawBody,
        };
      }
    } catch (err) {
      if (config.failOpen) {
        // Continue with original request
        return req;
      }
      throw err;
    }

    return req;
  };

  // Expose injection toggle
  Object.defineProperty(middleware, 'injectionEnabled', {
    get: () => injectionEnabled,
    set: (v: boolean) => { injectionEnabled = v; },
  });

  return middleware;
}

// ─── Launch Function ─────────────────────────────────────

/**
 * Launch the nero memory proxy server.
 *
 * Resolves config from: defaults → config file → env vars → overrides.
 * Sets up the proxy server with memory injection middleware.
 */
export async function launchProxy(options: ProxyLaunchOptions = {}): Promise<LaunchedProxy> {
  // 1. Resolve configuration
  const config = resolveProxyConfig(options);

  // 2. Validate
  const errors = validateProxyConfig(config);
  // Allow missing apiKey for local testing (proxy will forward without auth)
  const criticalErrors = errors.filter(e => !e.includes('apiKey'));
  if (criticalErrors.length > 0) {
    throw new Error(`Invalid proxy configuration:\n  ${criticalErrors.join('\n  ')}`);
  }

  // 3. Set up memory bridge (if db + embedding provider available)
  let bridge: MemoryRetrievalBridge | null = null;
  if (options.db && options.embeddingProvider) {
    bridge = new MemoryRetrievalBridge(
      options.db,
      options.embeddingProvider,
      options.bridgeConfig,
    );
  }

  // 4. Create proxy server with config mapping
  const serverConfig: Partial<ServerProxyConfig> = {
    port: config.port,
    host: config.bindAddress,
    requestTimeout: config.requestTimeoutMs,
    debug: config.logLevel === 'debug',
  };

  const server = new ProxyServer(serverConfig);

  // 5. Add injection middleware
  const injectionMw = createInjectionMiddleware(bridge, config);
  server.useRequest(injectionMw);

  // 6. Start listening
  const addr = await server.listen();

  return {
    server,
    config,
    address: addr,
    close: () => server.close(),
    getStats: () => server.getStats(),
    get injectionEnabled() {
      return (injectionMw as any).injectionEnabled;
    },
    setInjection(enabled: boolean) {
      (injectionMw as any).injectionEnabled = enabled;
    },
  };
}
