/**
 * Core HTTP/HTTPS proxy server for intercepting LLM API requests.
 *
 * Features:
 * - Transparent HTTP proxy (absolute URL requests)
 * - HTTPS CONNECT tunneling for TLS traffic
 * - Request/response middleware hooks for memory context injection
 * - Built-in detection of OpenAI, Anthropic, Google AI, Azure OpenAI endpoints
 * - Stats tracking for monitoring
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { EndpointMatcher } from './endpoint-matcher.js';
import { RequestInterceptor, parseTargetUrl, readBody, tryParseJson } from './request-interceptor.js';
import { forwardRequest, forwardStreaming } from './forwarder.js';
import type {
  ProxyConfig,
  ProxyEvents,
  ProxyStats,
  InterceptedRequest,
  ForwardResult,
  RequestMiddleware,
  ResponseMiddleware,
} from './types.js';
import { DEFAULT_PROXY_CONFIG } from './types.js';

export class ProxyServer extends EventEmitter {
  private readonly config: ProxyConfig;
  private readonly matcher: EndpointMatcher;
  private readonly interceptor: RequestInterceptor;
  private readonly server: http.Server;
  private readonly requestMiddlewares: RequestMiddleware[] = [];
  private readonly responseMiddlewares: ResponseMiddleware[] = [];
  private readonly stats: ProxyStats;
  private _listening = false;

  constructor(config: Partial<ProxyConfig> = {}) {
    super();
    this.config = { ...DEFAULT_PROXY_CONFIG, ...config };
    this.matcher = new EndpointMatcher(this.config.customEndpoints);
    this.interceptor = new RequestInterceptor(this.matcher, this.config);
    this.stats = {
      totalRequests: 0,
      interceptedRequests: 0,
      passthroughRequests: 0,
      connectTunnels: 0,
      errors: 0,
      startedAt: 0,
      bytesForwarded: 0,
    };

    this.server = http.createServer();
    this.server.on('request', this.handleRequest.bind(this));

    if (this.config.enableConnect) {
      this.server.on('connect', this.handleConnect.bind(this));
    }

    this.server.on('error', (err) => {
      this.emit('server.error', err);
    });
  }

  /**
   * Add a request middleware that can inspect/modify requests before forwarding.
   * Middlewares run in the order they were added.
   */
  useRequest(middleware: RequestMiddleware): this {
    this.requestMiddlewares.push(middleware);
    return this;
  }

  /**
   * Add a response middleware that can inspect/modify responses after upstream.
   * Middlewares run in the order they were added.
   */
  useResponse(middleware: ResponseMiddleware): this {
    this.responseMiddlewares.push(middleware);
    return this;
  }

  /**
   * Start listening on the configured host:port.
   */
  async listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        this._listening = true;
        this.stats.startedAt = Date.now();
        const addr = this.server.address() as net.AddressInfo;
        this.emit('server.listening', addr.address, addr.port);
        if (this.config.debug) {
          console.log(`[nero-proxy] Listening on ${addr.address}:${addr.port}`);
        }
        resolve({ host: addr.address, port: addr.port });
      });
      this.server.on('error', reject);
    });
  }

  /**
   * Gracefully shut down the proxy server.
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._listening) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this._listening = false;
        if (err) reject(err);
        else {
          this.emit('server.closed');
          resolve();
        }
      });
    });
  }

  /** Whether the server is currently listening */
  get isListening(): boolean {
    return this._listening;
  }

  /** Get current stats snapshot */
  getStats(): Readonly<ProxyStats> {
    return { ...this.stats };
  }

  /** Get the underlying http.Server (for testing) */
  getHttpServer(): http.Server {
    return this.server;
  }

  /** Get the endpoint matcher (for testing / external use) */
  getEndpointMatcher(): EndpointMatcher {
    return this.matcher;
  }

  // ── HTTP Request Handler ──────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    this.stats.totalRequests++;

    try {
      // Try to intercept as LLM API request
      const intercepted = await this.interceptor.intercept(req);

      if (intercepted) {
        await this.handleIntercepted(intercepted, res);
      } else {
        // Not an LLM API request — forward as plain HTTP proxy
        await this.handlePassthrough(req, res);
      }
    } catch (err) {
      this.stats.errors++;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('request.error', req.url ?? '<unknown>', error);

      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', message: error.message }));
      }
    }
  }

  private async handleIntercepted(
    intercepted: InterceptedRequest,
    res: http.ServerResponse,
  ): Promise<void> {
    this.stats.interceptedRequests++;
    this.emit('request.intercepted', intercepted);

    if (this.config.debug) {
      console.log(
        `[nero-proxy] Intercepted ${intercepted.provider.name} request: ${intercepted.method} ${intercepted.url} (chat=${intercepted.isChatCompletion}, stream=${intercepted.isStreaming})`,
      );
    }

    // Run request middlewares
    let current: InterceptedRequest | null = intercepted;
    for (const mw of this.requestMiddlewares) {
      current = await mw(current);
      if (!current) {
        // Middleware signaled to skip forwarding — respond with 200
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ skipped: true }));
        }
        return;
      }
    }

    // Forward to upstream
    let result: ForwardResult;
    if (current.isStreaming) {
      result = await forwardStreaming(current, res, this.config);
    } else {
      result = await forwardRequest(current, this.config);
    }

    this.stats.bytesForwarded += result.body.length;

    // Run response middlewares
    let finalResult = result;
    for (const mw of this.responseMiddlewares) {
      finalResult = await mw(current, finalResult);
    }

    // Send response to client (non-streaming — streaming was already piped)
    if (!current.isStreaming && !res.headersSent) {
      // Copy response headers
      for (const [key, val] of Object.entries(finalResult.headers)) {
        if (val !== undefined) {
          res.setHeader(key, val);
        }
      }
      res.writeHead(finalResult.statusCode);
      res.end(finalResult.body);
    }

    this.emit('request.forwarded', current, finalResult);

    if (this.config.debug) {
      console.log(
        `[nero-proxy] Forwarded ${current.provider.name}: ${finalResult.statusCode} in ${finalResult.latencyMs}ms`,
      );
    }
  }

  /**
   * Pass-through non-LLM requests as a standard HTTP proxy.
   */
  private async handlePassthrough(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    this.stats.passthroughRequests++;

    const targetUrl = parseTargetUrl(req);
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid proxy request URL' }));
      return;
    }

    this.emit('request.passthrough', targetUrl.toString(), req.method ?? 'GET');

    const isHttps = targetUrl.protocol === 'https:';
    const requestModule = isHttps ? await import('node:https') : await import('node:http');

    // Read client body
    const body = await readBody(req, this.config.maxBodySize);

    const outHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      outHeaders[key] = val;
    }
    outHeaders['host'] = targetUrl.host;

    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: outHeaders,
      timeout: this.config.requestTimeout,
    };

    const upstream = requestModule.request(options, (upstreamRes) => {
      for (const [key, val] of Object.entries(upstreamRes.headers)) {
        if (val !== undefined) {
          res.setHeader(key, val);
        }
      }
      res.writeHead(upstreamRes.statusCode ?? 502);
      upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
      this.stats.errors++;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream error', message: err.message }));
      }
    });

    upstream.on('timeout', () => {
      upstream.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway timeout' }));
      }
    });

    if (body.length > 0) {
      upstream.write(body);
    }
    upstream.end();
  }

  // ── HTTPS CONNECT Tunneling ───────────────────────────────────────

  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    this.stats.connectTunnels++;

    const [hostname, portStr] = (req.url ?? '').split(':');
    const port = parseInt(portStr, 10) || 443;

    if (this.config.debug) {
      console.log(`[nero-proxy] CONNECT tunnel: ${hostname}:${port}`);
    }

    this.emit('connect.tunnel', hostname, port);

    // Create TCP connection to target
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\n' +
        'Proxy-Agent: nero-proxy\r\n' +
        '\r\n',
      );

      // Pipe data in both directions
      if (head.length > 0) {
        serverSocket.write(head);
      }
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      this.stats.errors++;
      if (this.config.debug) {
        console.error(`[nero-proxy] CONNECT tunnel error to ${hostname}:${port}:`, err.message);
      }
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });

    serverSocket.on('timeout', () => {
      serverSocket.destroy();
      clientSocket.destroy();
    });

    clientSocket.on('timeout', () => {
      clientSocket.destroy();
      serverSocket.destroy();
    });
  }
}
