/**
 * E2E tests for proxy configuration and client integration.
 *
 * Tests:
 * 1. Config resolution: env vars → config file → programmatic overrides
 * 2. Config validation
 * 3. Proxy server startup with config
 * 4. Client integration (Claude Code / Codex style requests through proxy)
 * 5. Memory injection ON/OFF toggle
 * 6. Health check and stats endpoints
 * 7. Request forwarding with context injection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveProxyConfig,
  loadConfigFile,
  loadEnvConfig,
  validateProxyConfig,
  detectProvider,
  generateSampleConfig,
  DEFAULT_PROXY_CONFIG,
} from '../src/proxy/config.js';
import type { ProxyConfig, ProxyConfigInput, TargetProvider } from '../src/proxy/config.js';
import {
  injectMemoryContext,
  formatMemories,
  buildContextBlock,
  extractQueryFromBody,
} from '../src/proxy/context-injector.js';
import type { MergedMemoryItem } from '../src/retrieval/types.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { launchProxy, type LaunchedProxy } from '../src/proxy/proxy-launcher.js';

// ─── Helpers ─────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nero-proxy-test-'));
}

function writeJsonFile(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
          ...options.headers,
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Make a proxy-style request (absolute URL)
function makeProxyRequest(
  proxyPort: number,
  targetUrl: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        method: options.method ?? 'POST',
        path: targetUrl, // absolute URL for proxy
        headers: {
          'Host': url.host,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
          ...options.headers,
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Mock Memory Items ───────────────────────────────────

const MOCK_MEMORIES: MergedMemoryItem[] = [
  {
    nodeId: 'fact-1',
    nodeType: 'fact',
    score: 0.92,
    content: 'The user prefers TypeScript over JavaScript',
    sources: ['vector'],
    sourceScores: { vector: 0.92 },
  },
  {
    nodeId: 'fact-2',
    nodeType: 'fact',
    score: 0.78,
    content: 'The user works on a project called nero-mem2',
    sources: ['graph'],
    sourceScores: { graph: 0.78 },
  },
];

// ═══════════════════════════════════════════════════════════
// 1. Config Resolution Tests
// ═══════════════════════════════════════════════════════════

describe('ProxyConfig: Environment Variables', () => {
  it('loads port from NERO_PROXY_PORT', () => {
    const env = { NERO_PROXY_PORT: '9999' };
    const cfg = loadEnvConfig(env);
    expect(cfg.port).toBe(9999);
  });

  it('loads target URL from NERO_PROXY_TARGET_URL', () => {
    const env = { NERO_PROXY_TARGET_URL: 'https://api.openai.com' };
    const cfg = loadEnvConfig(env);
    expect(cfg.targetUrl).toBe('https://api.openai.com');
  });

  it('loads API key from NERO_PROXY_API_KEY', () => {
    const env = { NERO_PROXY_API_KEY: 'sk-test-key-123' };
    const cfg = loadEnvConfig(env);
    expect(cfg.apiKey).toBe('sk-test-key-123');
  });

  it('parses injection ON/OFF from NERO_PROXY_INJECTION', () => {
    expect(loadEnvConfig({ NERO_PROXY_INJECTION: 'on' }).injectionEnabled).toBe(true);
    expect(loadEnvConfig({ NERO_PROXY_INJECTION: 'ON' }).injectionEnabled).toBe(true);
    expect(loadEnvConfig({ NERO_PROXY_INJECTION: 'true' }).injectionEnabled).toBe(true);
    expect(loadEnvConfig({ NERO_PROXY_INJECTION: '1' }).injectionEnabled).toBe(true);
    expect(loadEnvConfig({ NERO_PROXY_INJECTION: 'off' }).injectionEnabled).toBe(false);
    expect(loadEnvConfig({ NERO_PROXY_INJECTION: '0' }).injectionEnabled).toBe(false);
    expect(loadEnvConfig({ NERO_PROXY_INJECTION: 'false' }).injectionEnabled).toBe(false);
  });

  it('loads max memories from NERO_PROXY_MAX_MEMORIES', () => {
    const cfg = loadEnvConfig({ NERO_PROXY_MAX_MEMORIES: '20' });
    expect(cfg.maxMemories).toBe(20);
  });

  it('loads log level from NERO_PROXY_LOG_LEVEL', () => {
    expect(loadEnvConfig({ NERO_PROXY_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(loadEnvConfig({ NERO_PROXY_LOG_LEVEL: 'error' }).logLevel).toBe('error');
  });

  it('ignores invalid env values', () => {
    const cfg = loadEnvConfig({
      NERO_PROXY_PORT: 'not-a-number',
      NERO_PROXY_MAX_MEMORIES: '-5',
      NERO_PROXY_LOG_LEVEL: 'verbose',
    });
    expect(cfg.port).toBeUndefined();
    expect(cfg.maxMemories).toBeUndefined();
    expect(cfg.logLevel).toBeUndefined();
  });

  it('loads bind address from NERO_PROXY_BIND_ADDRESS', () => {
    const cfg = loadEnvConfig({ NERO_PROXY_BIND_ADDRESS: '0.0.0.0' });
    expect(cfg.bindAddress).toBe('0.0.0.0');
  });

  it('loads db path from NERO_PROXY_DB_PATH', () => {
    const cfg = loadEnvConfig({ NERO_PROXY_DB_PATH: '/tmp/test.db' });
    expect(cfg.dbPath).toBe('/tmp/test.db');
  });

  it('returns empty config for empty env', () => {
    const cfg = loadEnvConfig({});
    expect(Object.keys(cfg).length).toBe(0);
  });
});

describe('ProxyConfig: Config File', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('loads valid config file', () => {
    const configPath = writeJsonFile(tempDir, 'proxy.json', {
      port: 7777,
      targetUrl: 'https://api.openai.com',
      apiKey: 'sk-file-key',
      injectionEnabled: false,
      maxMemories: 5,
      logLevel: 'warn',
    });

    const cfg = loadConfigFile(configPath);
    expect(cfg.port).toBe(7777);
    expect(cfg.targetUrl).toBe('https://api.openai.com');
    expect(cfg.apiKey).toBe('sk-file-key');
    expect(cfg.injectionEnabled).toBe(false);
    expect(cfg.maxMemories).toBe(5);
    expect(cfg.logLevel).toBe('warn');
  });

  it('returns empty object for non-existent file', () => {
    const cfg = loadConfigFile(path.join(tempDir, 'nonexistent.json'));
    expect(cfg).toEqual({});
  });

  it('throws on invalid JSON', () => {
    const filePath = path.join(tempDir, 'bad.json');
    fs.writeFileSync(filePath, 'not json {{{');
    expect(() => loadConfigFile(filePath)).toThrow('Invalid JSON');
  });

  it('throws on invalid port in config file', () => {
    const configPath = writeJsonFile(tempDir, 'proxy.json', { port: 99999 });
    expect(() => loadConfigFile(configPath)).toThrow('Invalid port');
  });

  it('ignores unknown fields silently', () => {
    const configPath = writeJsonFile(tempDir, 'proxy.json', {
      port: 8080,
      unknownField: 'hello',
      anotherUnknown: 42,
    });
    const cfg = loadConfigFile(configPath);
    expect(cfg.port).toBe(8080);
    // unknownField should not be in result
    expect('unknownField' in cfg).toBe(false);
  });

  it('loads partial config (only some fields)', () => {
    const configPath = writeJsonFile(tempDir, 'proxy.json', {
      injectionEnabled: false,
    });
    const cfg = loadConfigFile(configPath);
    expect(cfg.injectionEnabled).toBe(false);
    expect(cfg.port).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
  });
});

describe('ProxyConfig: Resolution Order', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('uses defaults when no config file or env vars', () => {
    // Point to a non-existent config file to avoid reading user's actual config
    const config = resolveProxyConfig({ configPath: path.join(tempDir, 'nonexistent.json') });
    expect(config.port).toBe(DEFAULT_PROXY_CONFIG.port);
    expect(config.injectionEnabled).toBe(DEFAULT_PROXY_CONFIG.injectionEnabled);
  });

  it('programmatic overrides beat everything', () => {
    const configPath = writeJsonFile(tempDir, 'proxy.json', {
      port: 7777,
      injectionEnabled: false,
    });

    const config = resolveProxyConfig({
      configPath,
      port: 5555,
      injectionEnabled: true,
    });

    expect(config.port).toBe(5555);
    expect(config.injectionEnabled).toBe(true);
  });

  it('auto-detects provider from targetUrl', () => {
    const config = resolveProxyConfig({
      configPath: path.join(tempDir, 'nonexistent.json'),
      targetUrl: 'https://api.openai.com',
    });
    expect(config.targetProvider).toBe('openai');

    const config2 = resolveProxyConfig({
      configPath: path.join(tempDir, 'nonexistent.json'),
      targetUrl: 'https://api.anthropic.com',
    });
    expect(config2.targetProvider).toBe('anthropic');

    const config3 = resolveProxyConfig({
      configPath: path.join(tempDir, 'nonexistent.json'),
      targetUrl: 'https://custom-llm.example.com',
    });
    expect(config3.targetProvider).toBe('custom');
  });
});

describe('ProxyConfig: Validation', () => {
  it('valid config has no errors', () => {
    const errors = validateProxyConfig({
      ...DEFAULT_PROXY_CONFIG,
      apiKey: 'sk-test',
    });
    expect(errors).toEqual([]);
  });

  it('detects missing apiKey', () => {
    const errors = validateProxyConfig({
      ...DEFAULT_PROXY_CONFIG,
      apiKey: '',
    });
    expect(errors.some(e => e.includes('apiKey'))).toBe(true);
  });

  it('detects invalid port', () => {
    const errors = validateProxyConfig({
      ...DEFAULT_PROXY_CONFIG,
      apiKey: 'sk-test',
      port: -1,
    });
    expect(errors.some(e => e.includes('port'))).toBe(true);
  });

  it('allows port 0 (OS-assigned)', () => {
    const errors = validateProxyConfig({
      ...DEFAULT_PROXY_CONFIG,
      apiKey: 'sk-test',
      port: 0,
    });
    expect(errors.some(e => e.includes('port'))).toBe(false);
  });

  it('detects invalid targetUrl', () => {
    const errors = validateProxyConfig({
      ...DEFAULT_PROXY_CONFIG,
      apiKey: 'sk-test',
      targetUrl: 'not-a-url',
    });
    expect(errors.some(e => e.includes('targetUrl'))).toBe(true);
  });
});

describe('ProxyConfig: Provider Detection', () => {
  it('detects anthropic', () => {
    expect(detectProvider('https://api.anthropic.com')).toBe('anthropic');
    expect(detectProvider('https://api.anthropic.com/v1/messages')).toBe('anthropic');
  });

  it('detects openai', () => {
    expect(detectProvider('https://api.openai.com')).toBe('openai');
    expect(detectProvider('https://api.openai.com/v1/chat/completions')).toBe('openai');
  });

  it('detects custom', () => {
    expect(detectProvider('https://custom-llm.example.com')).toBe('custom');
    expect(detectProvider('http://localhost:8080')).toBe('custom');
  });
});

describe('ProxyConfig: Sample Config Generation', () => {
  it('generates valid JSON', () => {
    const sample = generateSampleConfig();
    const parsed = JSON.parse(sample);
    expect(parsed.port).toBe(8420);
    expect(parsed.targetUrl).toBe('https://api.anthropic.com');
    expect(parsed.injectionEnabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Context Injector Tests
// ═══════════════════════════════════════════════════════════

describe('ContextInjector: Anthropic Format', () => {
  it('injects into Anthropic body with string system prompt', () => {
    const body = {
      model: 'claude-sonnet-4-20250514',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    };

    const result = injectMemoryContext(body, MOCK_MEMORIES, {
      template: '<memory>\n{{memories}}\n</memory>',
      maxMemories: 2,
      provider: 'anthropic',
    });

    expect(result.modified).toBe(true);
    expect(result.memoriesInjected).toBe(2);
    const modified = result.body as Record<string, unknown>;
    expect(typeof modified.system).toBe('string');
    expect((modified.system as string)).toContain('TypeScript over JavaScript');
    expect((modified.system as string)).toContain('You are a helpful assistant.');
  });

  it('injects into Anthropic body with array system prompt', () => {
    const body = {
      model: 'claude-sonnet-4-20250514',
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    };

    const result = injectMemoryContext(body, MOCK_MEMORIES, {
      template: '<memory>\n{{memories}}\n</memory>',
      maxMemories: 1,
      provider: 'anthropic',
    });

    expect(result.modified).toBe(true);
    const modified = result.body as Record<string, unknown>;
    expect(Array.isArray(modified.system)).toBe(true);
    const system = modified.system as Array<{ type: string; text: string }>;
    expect(system[0]!.text).toContain('TypeScript over JavaScript');
  });

  it('creates system prompt when none exists', () => {
    const body = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    };

    const result = injectMemoryContext(body, MOCK_MEMORIES, {
      template: '<memory>\n{{memories}}\n</memory>',
      maxMemories: 1,
      provider: 'anthropic',
    });

    expect(result.modified).toBe(true);
    const modified = result.body as Record<string, unknown>;
    expect(modified.system).toContain('TypeScript over JavaScript');
  });
});

describe('ContextInjector: OpenAI Format', () => {
  it('injects into OpenAI body with existing system message', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a code reviewer.' },
        { role: 'user', content: 'Review my code' },
      ],
    };

    const result = injectMemoryContext(body, MOCK_MEMORIES, {
      template: '<memory>\n{{memories}}\n</memory>',
      maxMemories: 2,
      provider: 'openai',
    });

    expect(result.modified).toBe(true);
    const modified = result.body as { messages: Array<{ role: string; content: string }> };
    expect(modified.messages[0]!.role).toBe('system');
    expect(modified.messages[0]!.content).toContain('TypeScript over JavaScript');
    expect(modified.messages[0]!.content).toContain('You are a code reviewer.');
  });

  it('adds new system message when none exists', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };

    const result = injectMemoryContext(body, MOCK_MEMORIES, {
      template: '<memory>\n{{memories}}\n</memory>',
      maxMemories: 1,
      provider: 'openai',
    });

    expect(result.modified).toBe(true);
    const modified = result.body as { messages: Array<{ role: string; content: string }> };
    expect(modified.messages[0]!.role).toBe('system');
    expect(modified.messages[0]!.content).toContain('TypeScript over JavaScript');
    expect(modified.messages[1]!.role).toBe('user');
  });
});

describe('ContextInjector: Edge Cases', () => {
  it('returns unmodified when no memories', () => {
    const body = { messages: [{ role: 'user', content: 'test' }] };
    const result = injectMemoryContext(body, [], {
      template: '{{memories}}',
      maxMemories: 10,
      provider: 'openai',
    });
    expect(result.modified).toBe(false);
    expect(result.memoriesInjected).toBe(0);
  });

  it('respects maxMemories limit', () => {
    const manyMemories: MergedMemoryItem[] = Array.from({ length: 20 }, (_, i) => ({
      nodeId: `fact-${i}`,
      nodeType: 'fact' as const,
      score: 0.5,
      content: `Memory ${i}`,
      sources: ['vector' as const],
      sourceScores: {},
    }));

    const result = injectMemoryContext(
      { messages: [{ role: 'user', content: 'test' }] },
      manyMemories,
      { template: '{{memories}}', maxMemories: 3, provider: 'openai' },
    );

    expect(result.memoriesInjected).toBe(3);
  });

  it('returns unmodified for null body', () => {
    const result = injectMemoryContext(null, MOCK_MEMORIES, {
      template: '{{memories}}',
      maxMemories: 10,
      provider: 'openai',
    });
    expect(result.modified).toBe(false);
  });
});

describe('ContextInjector: Query Extraction', () => {
  it('extracts query from OpenAI format', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is TypeScript?' },
        { role: 'assistant', content: 'TypeScript is...' },
        { role: 'user', content: 'How does it handle generics?' },
      ],
    };
    expect(extractQueryFromBody(body, 'openai')).toBe('How does it handle generics?');
  });

  it('extracts query from Anthropic format', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Tell me about SQLite' },
      ],
      max_tokens: 1024,
    };
    expect(extractQueryFromBody(body, 'anthropic')).toBe('Tell me about SQLite');
  });

  it('handles Anthropic content blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: {} },
          ],
        },
      ],
    };
    expect(extractQueryFromBody(body, 'anthropic')).toBe('What is this?');
  });

  it('returns null for empty messages', () => {
    expect(extractQueryFromBody({ messages: [] }, 'openai')).toBeNull();
    expect(extractQueryFromBody({}, 'openai')).toBeNull();
    expect(extractQueryFromBody(null, 'openai')).toBeNull();
  });
});

describe('ContextInjector: Memory Formatting', () => {
  it('formats memories with type and score', () => {
    const formatted = formatMemories(MOCK_MEMORIES, 2);
    expect(formatted).toContain('[1]');
    expect(formatted).toContain('Fact');
    expect(formatted).toContain('92%');
    expect(formatted).toContain('TypeScript over JavaScript');
    expect(formatted).toContain('[2]');
    expect(formatted).toContain('nero-mem2');
  });

  it('returns empty string for no memories', () => {
    expect(formatMemories([], 10)).toBe('');
  });

  it('builds context block with template', () => {
    const block = buildContextBlock(
      '<context>\n{{memories}}\n</context>',
      MOCK_MEMORIES,
      1,
    );
    expect(block).toContain('<context>');
    expect(block).toContain('</context>');
    expect(block).toContain('TypeScript over JavaScript');
    expect(block).not.toContain('nero-mem2'); // maxCount=1
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Proxy Server E2E Tests
// ═══════════════════════════════════════════════════════════

describe('ProxyServer: Startup and Lifecycle', () => {
  let server: ProxyServer;

  afterEach(async () => {
    if (server?.isListening) {
      await server.close();
    }
  });

  it('starts and stops the proxy server', async () => {
    server = new ProxyServer({ port: 0 }); // port 0 = random available
    const addr = await server.listen();

    expect(server.isListening).toBe(true);
    expect(addr.port).toBeGreaterThan(0);

    await server.close();
    expect(server.isListening).toBe(false);
  });

  it('tracks request stats', async () => {
    server = new ProxyServer({ port: 0 });
    const addr = await server.listen();

    const stats = server.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.startedAt).toBeGreaterThan(0);

    await server.close();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Client Integration E2E Tests (simulated Claude Code / Codex)
// ═══════════════════════════════════════════════════════════

describe('E2E: Client Integration through Proxy', () => {
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;
  let proxy: ProxyServer;
  let proxyPort: number;

  // Track requests received by mock upstream
  let lastUpstreamRequest: {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  } | null;

  beforeEach(async () => {
    lastUpstreamRequest = null;

    // Create mock upstream server (simulates Anthropic/OpenAI API)
    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        };

        // Respond with a mock Anthropic API response
        const response = {
          id: 'msg-test-123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! I can help with that.' }],
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 8 },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, '127.0.0.1', resolve);
    });
    const upAddr = mockUpstream.address() as { port: number };
    mockUpstreamPort = upAddr.port;

    // Create proxy pointing to mock upstream
    proxy = new ProxyServer({ port: 0, debug: false });

    // Add middleware to rewrite URLs to point to mock upstream
    proxy.useRequest(async (req) => {
      // Rewrite the upstream URL to point to our mock
      return {
        ...req,
        url: `http://127.0.0.1:${mockUpstreamPort}${new URL(req.url).pathname}`,
      };
    });

    const addr = await proxy.listen();
    proxyPort = addr.port;
  });

  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => mockUpstream?.close(() => resolve()));
  });

  it('Claude Code: forwards Anthropic Messages API request through proxy', async () => {
    // Simulate Claude Code sending a request via the proxy
    // Claude Code would set ANTHROPIC_BASE_URL=http://localhost:<proxyPort>
    // and then send requests to the proxy as if it were Anthropic API
    const anthropicBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: 'You are a helpful coding assistant.',
      messages: [
        { role: 'user', content: 'Help me write a TypeScript function' },
      ],
    };

    const result = await makeProxyRequest(
      proxyPort,
      `http://api.anthropic.com/v1/messages`,
      {
        body: anthropicBody,
        headers: {
          'x-api-key': 'sk-ant-test-key',
          'anthropic-version': '2023-06-01',
        },
      },
    );

    // Proxy should forward and get response from mock upstream
    expect(result.status).toBe(200);
    const responseBody = JSON.parse(result.body);
    expect(responseBody.type).toBe('message');
    expect(responseBody.content[0].text).toBe('Hello! I can help with that.');

    // Verify the request reached upstream
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe('/v1/messages');
  });

  it('Codex/OpenAI: forwards Chat Completions API request through proxy', async () => {
    // Simulate Codex/OpenAI client sending request through proxy
    const openaiBody = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a code generator.' },
        { role: 'user', content: 'Write a Python function' },
      ],
    };

    const result = await makeProxyRequest(
      proxyPort,
      `http://api.openai.com/v1/chat/completions`,
      {
        body: openaiBody,
        headers: {
          'Authorization': 'Bearer sk-test-openai-key',
        },
      },
    );

    expect(result.status).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe('/v1/chat/completions');
  });

  it('tracks intercepted request stats', async () => {
    await makeProxyRequest(
      proxyPort,
      `http://api.anthropic.com/v1/messages`,
      {
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'test' }],
        },
        headers: { 'x-api-key': 'sk-test' },
      },
    );

    const stats = proxy.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.interceptedRequests).toBe(1);
  });

  it('handles request middleware chain', async () => {
    let middlewareCalled = false;

    proxy.useRequest(async (req) => {
      middlewareCalled = true;
      return req;
    });

    await makeProxyRequest(
      proxyPort,
      `http://api.anthropic.com/v1/messages`,
      {
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'test' }],
        },
        headers: { 'x-api-key': 'sk-test' },
      },
    );

    expect(middlewareCalled).toBe(true);
  });

  it('middleware can modify request body (injection simulation)', async () => {
    // This simulates what the memory injection middleware does
    proxy.useRequest(async (req) => {
      if (req.isChatCompletion && req.body) {
        const body = req.body as Record<string, unknown>;
        // Inject memory context into system prompt
        body['system'] = '<memory>User prefers TypeScript</memory>\n' + (body['system'] ?? '');
        const newRawBody = Buffer.from(JSON.stringify(body));
        return { ...req, body, rawBody: newRawBody };
      }
      return req;
    });

    await makeProxyRequest(
      proxyPort,
      `http://api.anthropic.com/v1/messages`,
      {
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Write code' }],
        },
        headers: { 'x-api-key': 'sk-test' },
      },
    );

    // Verify the upstream received the modified body
    expect(lastUpstreamRequest).not.toBeNull();
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body);
    expect(upstreamBody.system).toContain('User prefers TypeScript');
    expect(upstreamBody.system).toContain('You are helpful.');
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Proxy Launcher E2E Tests
// ═══════════════════════════════════════════════════════════

describe('E2E: Proxy Launcher', () => {
  let tempDir: string;
  let launched: LaunchedProxy | null = null;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = null;
    }
    cleanupDir(tempDir);
  });

  it('launches proxy with programmatic config', async () => {
    launched = await launchProxy({
      port: 0, // random port
      configPath: path.join(tempDir, 'nonexistent.json'),
      apiKey: 'sk-test-launch',
      targetUrl: 'https://api.anthropic.com',
    });

    expect(launched.server.isListening).toBe(true);
    expect(launched.address.port).toBeGreaterThan(0);
    expect(launched.config.apiKey).toBe('sk-test-launch');
  });

  it('launches proxy from config file', async () => {
    writeJsonFile(tempDir, 'proxy.json', {
      targetUrl: 'https://api.openai.com',
      apiKey: 'sk-from-file',
      maxMemories: 7,
    });

    launched = await launchProxy({
      port: 0,
      configPath: path.join(tempDir, 'proxy.json'),
    });

    expect(launched.config.targetUrl).toBe('https://api.openai.com');
    expect(launched.config.apiKey).toBe('sk-from-file');
    expect(launched.config.maxMemories).toBe(7);
  });

  it('injection toggle works', async () => {
    launched = await launchProxy({
      port: 0,
      configPath: path.join(tempDir, 'nonexistent.json'),
      apiKey: 'sk-test',
      injectionEnabled: true,
    });

    expect(launched.injectionEnabled).toBe(true);
    launched.setInjection(false);
    expect(launched.injectionEnabled).toBe(false);
    launched.setInjection(true);
    expect(launched.injectionEnabled).toBe(true);
  });

  it('reports stats', async () => {
    launched = await launchProxy({
      port: 0,
      configPath: path.join(tempDir, 'nonexistent.json'),
      apiKey: 'sk-test',
    });

    const stats = launched.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.startedAt).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Injection ON/OFF E2E Tests
// ═══════════════════════════════════════════════════════════

describe('E2E: Injection ON/OFF Toggle', () => {
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;
  let proxy: ProxyServer;
  let proxyPort: number;
  let injectionEnabled: boolean;
  let lastUpstreamBody: Record<string, unknown> | null;

  beforeEach(async () => {
    lastUpstreamBody = null;
    injectionEnabled = true;

    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          lastUpstreamBody = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }] }));
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, '127.0.0.1', resolve);
    });
    mockUpstreamPort = (mockUpstream.address() as { port: number }).port;

    proxy = new ProxyServer({ port: 0 });

    // URL rewriter + injection middleware
    proxy.useRequest(async (req) => {
      const rewritten = {
        ...req,
        url: `http://127.0.0.1:${mockUpstreamPort}${new URL(req.url).pathname}`,
      };

      // Conditional injection
      if (injectionEnabled && rewritten.isChatCompletion && rewritten.body) {
        const body = rewritten.body as Record<string, unknown>;
        body['system'] = '<memory>injected context</memory>\n' + (body['system'] ?? '');
        return { ...rewritten, body, rawBody: Buffer.from(JSON.stringify(body)) };
      }

      return rewritten;
    });

    proxyPort = (await proxy.listen()).port;
  });

  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => mockUpstream?.close(() => resolve()));
  });

  it('injects when ON', async () => {
    injectionEnabled = true;

    await makeProxyRequest(proxyPort, 'http://api.anthropic.com/v1/messages', {
      body: {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: 'Be helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      headers: { 'x-api-key': 'sk-test' },
    });

    expect(lastUpstreamBody).not.toBeNull();
    expect((lastUpstreamBody as Record<string, string>).system).toContain('injected context');
  });

  it('does NOT inject when OFF', async () => {
    injectionEnabled = false;

    await makeProxyRequest(proxyPort, 'http://api.anthropic.com/v1/messages', {
      body: {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: 'Be helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      headers: { 'x-api-key': 'sk-test' },
    });

    expect(lastUpstreamBody).not.toBeNull();
    expect((lastUpstreamBody as Record<string, string>).system).toBe('Be helpful.');
    expect((lastUpstreamBody as Record<string, string>).system).not.toContain('injected context');
  });

  it('can toggle injection mid-session', async () => {
    // First request: ON
    injectionEnabled = true;
    await makeProxyRequest(proxyPort, 'http://api.anthropic.com/v1/messages', {
      body: {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Q1' }],
      },
      headers: { 'x-api-key': 'sk-test' },
    });
    expect(lastUpstreamBody).not.toBeNull();
    expect(JSON.stringify(lastUpstreamBody)).toContain('injected context');

    // Second request: OFF
    injectionEnabled = false;
    await makeProxyRequest(proxyPort, 'http://api.anthropic.com/v1/messages', {
      body: {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Q2' }],
      },
      headers: { 'x-api-key': 'sk-test' },
    });
    expect(lastUpstreamBody).not.toBeNull();
    expect(JSON.stringify(lastUpstreamBody)).not.toContain('injected context');
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Multi-Provider E2E Tests
// ═══════════════════════════════════════════════════════════

describe('E2E: Multi-Provider Support', () => {
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;
  let proxy: ProxyServer;
  let proxyPort: number;
  let lastUpstreamUrl: string;

  beforeEach(async () => {
    lastUpstreamUrl = '';

    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamUrl = req.url ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, '127.0.0.1', resolve);
    });
    mockUpstreamPort = (mockUpstream.address() as { port: number }).port;

    proxy = new ProxyServer({ port: 0 });
    proxy.useRequest(async (req) => ({
      ...req,
      url: `http://127.0.0.1:${mockUpstreamPort}${new URL(req.url).pathname}`,
    }));
    proxyPort = (await proxy.listen()).port;
  });

  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => mockUpstream?.close(() => resolve()));
  });

  it('handles Anthropic /v1/messages endpoint', async () => {
    await makeProxyRequest(proxyPort, 'http://api.anthropic.com/v1/messages', {
      body: { model: 'claude-sonnet-4-20250514', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(lastUpstreamUrl).toBe('/v1/messages');
  });

  it('handles OpenAI /v1/chat/completions endpoint', async () => {
    await makeProxyRequest(proxyPort, 'http://api.openai.com/v1/chat/completions', {
      body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(lastUpstreamUrl).toBe('/v1/chat/completions');
  });

  it('handles Google AI endpoint', async () => {
    await makeProxyRequest(
      proxyPort,
      'http://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent',
      {
        body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      },
    );
    expect(lastUpstreamUrl).toBe('/v1/models/gemini-pro:generateContent');
  });
});
