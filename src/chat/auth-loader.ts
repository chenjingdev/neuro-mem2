/**
 * Auth Loader — loads LLM API credentials from local auth.json files.
 *
 * Supports loading codex OAuth tokens and direct API keys from multiple
 * well-known locations. Used by the Visual Debug Chat App to authenticate
 * with OpenAI and Anthropic APIs without requiring manual configuration.
 *
 * Search order (first file found wins):
 *   1. Custom path via `NERO_AUTH_PATH` environment variable
 *   2. `~/.nero-mem/auth.json`      — nero-mem specific credentials
 *   3. `~/.codex/auth.json`         — codex CLI OAuth tokens
 *   4. `./auth.json`                — project-local override
 *
 * Supported auth.json formats:
 *
 * ```json
 * {
 *   "openai_api_key": "sk-...",
 *   "anthropic_api_key": "sk-ant-...",
 *   "oauth_token": "...",
 *   "provider": "openai"
 * }
 * ```
 *
 * Fields are all optional. The loader extracts whatever is available.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Types ───────────────────────────────────────────────

/** Raw shape of the auth.json file. All fields are optional. */
export interface AuthFileContent {
  /** OpenAI API key (sk-...) */
  openai_api_key?: string;
  /** Anthropic API key (sk-ant-...) */
  anthropic_api_key?: string;
  /** Generic OAuth token (codex-issued) */
  oauth_token?: string;
  /** Which provider to use by default: 'openai' | 'anthropic' */
  provider?: string;
  /** Generic API key field — used when provider-specific keys are absent */
  api_key?: string;
  /** Optional codex token metadata */
  codex?: {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
  };
}

/** Resolved credentials ready for use by LLM providers. */
export interface AuthCredentials {
  /** API key for OpenAI (if available) */
  openaiApiKey?: string;
  /** API key for Anthropic (if available) */
  anthropicApiKey?: string;
  /** Default provider preference */
  defaultProvider?: 'openai' | 'anthropic';
  /** Path from which credentials were loaded */
  sourcePath: string;
}

// ─── Constants ───────────────────────────────────────────

const HOME_DIR =
  process.env['HOME'] || process.env['USERPROFILE'] || '.';

/** Well-known auth.json search paths, in priority order. */
export const AUTH_SEARCH_PATHS: readonly string[] = [
  path.join(HOME_DIR, '.nero-mem', 'auth.json'),
  path.join(HOME_DIR, '.codex', 'auth.json'),
  path.join(process.cwd(), 'auth.json'),
];

// ─── Core Functions ──────────────────────────────────────

/**
 * Find the first existing auth.json file from search paths.
 * Returns `undefined` if no auth file is found.
 */
export function findAuthFile(
  customPath?: string,
  searchPaths: readonly string[] = AUTH_SEARCH_PATHS,
): string | undefined {
  // Priority 1: explicit custom path
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    // If custom path was specified but doesn't exist, log warning and continue
    console.warn(`[auth-loader] Custom auth path not found: ${resolved}`);
  }

  // Priority 2: well-known search paths
  for (const candidate of searchPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Parse and validate an auth.json file.
 * Returns the raw content with basic type checks applied.
 *
 * @throws {Error} if the file exists but contains invalid JSON
 */
export function parseAuthFile(filePath: string): AuthFileContent {
  const raw = fs.readFileSync(filePath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in auth file: ${filePath}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Auth file must be a JSON object: ${filePath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const result: AuthFileContent = {};

  // Extract string fields
  if (typeof obj['openai_api_key'] === 'string' && obj['openai_api_key']) {
    result.openai_api_key = obj['openai_api_key'];
  }
  if (typeof obj['anthropic_api_key'] === 'string' && obj['anthropic_api_key']) {
    result.anthropic_api_key = obj['anthropic_api_key'];
  }
  if (typeof obj['oauth_token'] === 'string' && obj['oauth_token']) {
    result.oauth_token = obj['oauth_token'];
  }
  if (typeof obj['provider'] === 'string' && obj['provider']) {
    result.provider = obj['provider'];
  }
  if (typeof obj['api_key'] === 'string' && obj['api_key']) {
    result.api_key = obj['api_key'];
  }

  // Extract nested codex object
  if (typeof obj['codex'] === 'object' && obj['codex'] !== null && !Array.isArray(obj['codex'])) {
    const codex = obj['codex'] as Record<string, unknown>;
    result.codex = {};
    if (typeof codex['token'] === 'string') result.codex.token = codex['token'];
    if (typeof codex['refresh_token'] === 'string') result.codex.refresh_token = codex['refresh_token'];
    if (typeof codex['expires_at'] === 'string') result.codex.expires_at = codex['expires_at'];
  }

  return result;
}

/**
 * Resolve auth file content into usable credentials.
 *
 * Resolution logic:
 * - Provider-specific keys (`openai_api_key`, `anthropic_api_key`) are preferred
 * - Generic `api_key` is used as fallback for the selected provider
 * - `oauth_token` is treated as a generic key (for codex OAuth flows)
 * - `codex.token` is treated as an OAuth token (for codex-specific flows)
 */
export function resolveCredentials(
  content: AuthFileContent,
  sourcePath: string,
): AuthCredentials {
  const creds: AuthCredentials = { sourcePath };

  // Direct provider-specific keys (highest priority)
  if (content.openai_api_key) {
    creds.openaiApiKey = content.openai_api_key;
  }
  if (content.anthropic_api_key) {
    creds.anthropicApiKey = content.anthropic_api_key;
  }

  // Fallback: generic api_key or oauth_token
  const genericKey = content.api_key || content.oauth_token || content.codex?.token;

  // Determine default provider
  const rawProvider = content.provider?.toLowerCase();
  if (rawProvider === 'openai' || rawProvider === 'anthropic') {
    creds.defaultProvider = rawProvider;
  } else if (creds.openaiApiKey && !creds.anthropicApiKey) {
    creds.defaultProvider = 'openai';
  } else if (creds.anthropicApiKey && !creds.openaiApiKey) {
    creds.defaultProvider = 'anthropic';
  }

  // Apply generic key to the appropriate provider if specific key is missing
  if (genericKey) {
    if (!creds.openaiApiKey && (creds.defaultProvider === 'openai' || !creds.defaultProvider)) {
      creds.openaiApiKey = genericKey;
      if (!creds.defaultProvider) creds.defaultProvider = 'openai';
    }
    if (!creds.anthropicApiKey && creds.defaultProvider === 'anthropic') {
      creds.anthropicApiKey = genericKey;
    }
  }

  return creds;
}

/**
 * Load auth credentials from local auth.json.
 *
 * This is the primary entry point — call this at server startup.
 * Returns `undefined` if no auth file is found (non-fatal).
 *
 * @param customPath - Optional explicit path to auth.json (overrides search)
 * @returns Resolved credentials, or undefined if no auth file found
 */
export function loadAuthCredentials(
  customPath?: string,
): AuthCredentials | undefined {
  // Check env var for custom path
  const envPath = process.env['NERO_AUTH_PATH'];
  const effectivePath = customPath || envPath;

  const authFile = findAuthFile(effectivePath);
  if (!authFile) {
    console.info(
      '[auth-loader] No auth.json found. Searched:',
      effectivePath ? [effectivePath] : AUTH_SEARCH_PATHS,
    );
    return undefined;
  }

  console.info(`[auth-loader] Loading credentials from: ${authFile}`);

  const content = parseAuthFile(authFile);
  const credentials = resolveCredentials(content, authFile);

  // Log what was loaded (without exposing secrets)
  const loaded: string[] = [];
  if (credentials.openaiApiKey) loaded.push('openai');
  if (credentials.anthropicApiKey) loaded.push('anthropic');
  console.info(
    `[auth-loader] Loaded credentials for: ${loaded.length > 0 ? loaded.join(', ') : '(none)'}`,
    credentials.defaultProvider ? `(default: ${credentials.defaultProvider})` : '',
  );

  return credentials;
}

/**
 * Get the API key for a specific provider from credentials.
 * Convenience helper for selecting the right key at runtime.
 */
export function getApiKeyForProvider(
  credentials: AuthCredentials,
  provider: 'openai' | 'anthropic',
): string | undefined {
  return provider === 'openai'
    ? credentials.openaiApiKey
    : credentials.anthropicApiKey;
}
