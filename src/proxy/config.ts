/**
 * Proxy Configuration — environment variable + config file based configuration.
 *
 * Resolution order (later wins):
 *   1. Built-in defaults
 *   2. Config file (~/.nero-mem/proxy.json or custom path)
 *   3. Environment variables (NERO_PROXY_*)
 *   4. Programmatic overrides (constructor arg)
 *
 * Supported environment variables:
 *   NERO_PROXY_PORT          — Port to listen on (default: 8420)
 *   NERO_PROXY_TARGET_URL    — Upstream API base URL (default: https://api.anthropic.com)
 *   NERO_PROXY_API_KEY       — API key forwarded to upstream
 *   NERO_PROXY_INJECTION     — Memory injection ON/OFF (default: "on")
 *   NERO_PROXY_DB_PATH       — Path to SQLite database
 *   NERO_PROXY_MAX_MEMORIES  — Max memory items to inject per request (default: 10)
 *   NERO_PROXY_CONFIG_PATH   — Path to JSON config file
 *   NERO_PROXY_LOG_LEVEL     — Logging verbosity: "debug" | "info" | "warn" | "error"
 *   NERO_PROXY_BIND_ADDRESS  — Bind address (default: "127.0.0.1")
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Types ───────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TargetProvider = 'anthropic' | 'openai' | 'custom';

export interface ProxyConfig {
  /** Port to listen on */
  port: number;
  /** Bind address */
  bindAddress: string;
  /** Upstream API base URL */
  targetUrl: string;
  /** Target provider type (auto-detected from targetUrl if not specified) */
  targetProvider: TargetProvider;
  /** API key for upstream (forwarded in Authorization/x-api-key header) */
  apiKey: string;
  /** Whether memory injection is enabled */
  injectionEnabled: boolean;
  /** Path to SQLite database file */
  dbPath: string;
  /** Max number of memory items to inject per request */
  maxMemories: number;
  /** Log level */
  logLevel: LogLevel;
  /** Path to config file (resolved during loading) */
  configPath: string;
  /** Request timeout in milliseconds */
  requestTimeoutMs: number;
  /** Whether to pass through requests when injection fails */
  failOpen: boolean;
  /** Custom system prompt prefix template. Use {{memories}} as placeholder. */
  injectionTemplate: string;
}

export interface ProxyConfigInput {
  port?: number;
  bindAddress?: string;
  targetUrl?: string;
  targetProvider?: TargetProvider;
  apiKey?: string;
  injectionEnabled?: boolean;
  dbPath?: string;
  maxMemories?: number;
  logLevel?: LogLevel;
  configPath?: string;
  requestTimeoutMs?: number;
  failOpen?: boolean;
  injectionTemplate?: string;
}

// ─── Defaults ────────────────────────────────────────────

const DEFAULT_DB_DIR = path.join(
  process.env['HOME'] || process.env['USERPROFILE'] || '.',
  '.nero-mem',
);

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 8420,
  bindAddress: '127.0.0.1',
  targetUrl: 'https://api.anthropic.com',
  targetProvider: 'anthropic',
  apiKey: '',
  injectionEnabled: true,
  dbPath: path.join(DEFAULT_DB_DIR, 'nero.db'),
  maxMemories: 10,
  logLevel: 'info',
  configPath: path.join(DEFAULT_DB_DIR, 'proxy.json'),
  requestTimeoutMs: 30000,
  failOpen: true,
  injectionTemplate: `<nero-memory-context>\nThe following relevant memories were retrieved from previous conversations:\n{{memories}}\n</nero-memory-context>`,
};

// ─── Provider Detection ──────────────────────────────────

export function detectProvider(url: string): TargetProvider {
  if (url.includes('anthropic.com')) return 'anthropic';
  if (url.includes('openai.com')) return 'openai';
  return 'custom';
}

// ─── Config File Loading ─────────────────────────────────

export interface ConfigFileContent {
  port?: number;
  bindAddress?: string;
  targetUrl?: string;
  targetProvider?: TargetProvider;
  apiKey?: string;
  injectionEnabled?: boolean;
  dbPath?: string;
  maxMemories?: number;
  logLevel?: LogLevel;
  requestTimeoutMs?: number;
  failOpen?: boolean;
  injectionTemplate?: string;
}

/**
 * Load config from a JSON file. Returns empty object if file doesn't exist.
 * Throws if file exists but is invalid JSON.
 */
export function loadConfigFile(configPath: string): ConfigFileContent {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Config file must be a JSON object: ${configPath}`);
    }
    return validateConfigFileContent(parsed, configPath);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}: ${err.message}`);
    }
    throw err;
  }
}

function validateConfigFileContent(obj: Record<string, unknown>, filePath: string): ConfigFileContent {
  const result: ConfigFileContent = {};

  if ('port' in obj) {
    const port = Number(obj['port']);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port in ${filePath}: ${obj['port']}`);
    }
    result.port = port;
  }

  if ('bindAddress' in obj && typeof obj['bindAddress'] === 'string') {
    result.bindAddress = obj['bindAddress'];
  }

  if ('targetUrl' in obj && typeof obj['targetUrl'] === 'string') {
    result.targetUrl = obj['targetUrl'];
  }

  if ('targetProvider' in obj) {
    const tp = obj['targetProvider'];
    if (tp === 'anthropic' || tp === 'openai' || tp === 'custom') {
      result.targetProvider = tp;
    }
  }

  if ('apiKey' in obj && typeof obj['apiKey'] === 'string') {
    result.apiKey = obj['apiKey'];
  }

  if ('injectionEnabled' in obj && typeof obj['injectionEnabled'] === 'boolean') {
    result.injectionEnabled = obj['injectionEnabled'];
  }

  if ('dbPath' in obj && typeof obj['dbPath'] === 'string') {
    result.dbPath = obj['dbPath'];
  }

  if ('maxMemories' in obj) {
    const mm = Number(obj['maxMemories']);
    if (Number.isInteger(mm) && mm >= 0) {
      result.maxMemories = mm;
    }
  }

  if ('logLevel' in obj) {
    const ll = obj['logLevel'];
    if (ll === 'debug' || ll === 'info' || ll === 'warn' || ll === 'error') {
      result.logLevel = ll;
    }
  }

  if ('requestTimeoutMs' in obj) {
    const t = Number(obj['requestTimeoutMs']);
    if (Number.isFinite(t) && t > 0) {
      result.requestTimeoutMs = t;
    }
  }

  if ('failOpen' in obj && typeof obj['failOpen'] === 'boolean') {
    result.failOpen = obj['failOpen'];
  }

  if ('injectionTemplate' in obj && typeof obj['injectionTemplate'] === 'string') {
    result.injectionTemplate = obj['injectionTemplate'];
  }

  return result;
}

// ─── Environment Variable Loading ────────────────────────

export function loadEnvConfig(env: Record<string, string | undefined> = process.env): ProxyConfigInput {
  const result: ProxyConfigInput = {};

  const port = env['NERO_PROXY_PORT'];
  if (port !== undefined) {
    const p = Number(port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      result.port = p;
    }
  }

  const bindAddress = env['NERO_PROXY_BIND_ADDRESS'];
  if (bindAddress) result.bindAddress = bindAddress;

  const targetUrl = env['NERO_PROXY_TARGET_URL'];
  if (targetUrl) result.targetUrl = targetUrl;

  const apiKey = env['NERO_PROXY_API_KEY'];
  if (apiKey) result.apiKey = apiKey;

  const injection = env['NERO_PROXY_INJECTION'];
  if (injection !== undefined) {
    result.injectionEnabled = injection.toLowerCase() === 'on' || injection === '1' || injection.toLowerCase() === 'true';
  }

  const dbPath = env['NERO_PROXY_DB_PATH'];
  if (dbPath) result.dbPath = dbPath;

  const maxMemories = env['NERO_PROXY_MAX_MEMORIES'];
  if (maxMemories !== undefined) {
    const mm = Number(maxMemories);
    if (Number.isInteger(mm) && mm >= 0) {
      result.maxMemories = mm;
    }
  }

  const logLevel = env['NERO_PROXY_LOG_LEVEL'];
  if (logLevel === 'debug' || logLevel === 'info' || logLevel === 'warn' || logLevel === 'error') {
    result.logLevel = logLevel;
  }

  const configPath = env['NERO_PROXY_CONFIG_PATH'];
  if (configPath) result.configPath = configPath;

  const timeout = env['NERO_PROXY_REQUEST_TIMEOUT'];
  if (timeout !== undefined) {
    const t = Number(timeout);
    if (Number.isFinite(t) && t > 0) {
      result.requestTimeoutMs = t;
    }
  }

  const failOpen = env['NERO_PROXY_FAIL_OPEN'];
  if (failOpen !== undefined) {
    result.failOpen = failOpen.toLowerCase() === 'true' || failOpen === '1';
  }

  return result;
}

// ─── Config Resolution ───────────────────────────────────

/**
 * Resolve final proxy config by merging: defaults → config file → env vars → overrides.
 */
export function resolveProxyConfig(overrides?: ProxyConfigInput): ProxyConfig {
  // Step 1: Start with defaults
  const base = { ...DEFAULT_PROXY_CONFIG };

  // Step 2: Determine config file path (overrides > env > default)
  const envConfig = loadEnvConfig();
  const configPath = overrides?.configPath ?? envConfig.configPath ?? base.configPath;

  // Step 3: Load config file
  const fileConfig = loadConfigFile(configPath);

  // Step 4: Merge: defaults ← file ← env ← overrides
  const merged: ProxyConfig = {
    ...base,
    ...stripUndefined(fileConfig),
    ...stripUndefined(envConfig),
    ...stripUndefined(overrides ?? {}),
  };

  // Step 5: Auto-detect provider if not explicitly set
  if (!overrides?.targetProvider && !envConfig.targetProvider && !fileConfig.targetProvider) {
    merged.targetProvider = detectProvider(merged.targetUrl);
  }

  // Store the resolved config path
  merged.configPath = configPath;

  return merged;
}

// ─── Helpers ─────────────────────────────────────────────

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * Validate that a resolved config is usable for starting the proxy.
 * Returns an array of validation errors (empty if valid).
 */
export function validateProxyConfig(config: ProxyConfig): string[] {
  const errors: string[] = [];

  if (config.port < 0 || config.port > 65535) {
    errors.push(`Invalid port: ${config.port} (must be 0-65535, 0 = OS-assigned)`);
  }

  if (!config.targetUrl) {
    errors.push('targetUrl is required');
  }

  try {
    new URL(config.targetUrl);
  } catch {
    errors.push(`Invalid targetUrl: ${config.targetUrl}`);
  }

  if (!config.apiKey) {
    errors.push('apiKey is required (set NERO_PROXY_API_KEY or configure in proxy.json)');
  }

  if (config.maxMemories < 0) {
    errors.push(`Invalid maxMemories: ${config.maxMemories} (must be >= 0)`);
  }

  return errors;
}

/**
 * Generate a sample proxy.json config file content.
 */
export function generateSampleConfig(): string {
  return JSON.stringify(
    {
      port: 8420,
      targetUrl: 'https://api.anthropic.com',
      apiKey: 'YOUR_API_KEY_HERE',
      injectionEnabled: true,
      maxMemories: 10,
      logLevel: 'info',
      failOpen: true,
    },
    null,
    2,
  );
}
