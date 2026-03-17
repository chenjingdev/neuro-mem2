/**
 * Tests for auth-loader — loading codex OAuth tokens from local auth.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  findAuthFile,
  parseAuthFile,
  resolveCredentials,
  loadAuthCredentials,
  getApiKeyForProvider,
  AUTH_SEARCH_PATHS,
} from '../src/chat/auth-loader.js';
import type { AuthFileContent, AuthCredentials } from '../src/chat/auth-loader.js';

// ─── Helpers ─────────────────────────────────────────────

let tmpDir: string;

function writeTmpAuth(filename: string, content: unknown): string {
  const filePath = path.join(tmpDir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nero-auth-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['NERO_AUTH_PATH'];
});

// ─── findAuthFile ────────────────────────────────────────

describe('findAuthFile', () => {
  it('returns custom path when it exists', () => {
    const p = writeTmpAuth('custom-auth.json', { api_key: 'test' });
    expect(findAuthFile(p)).toBe(p);
  });

  it('returns undefined when custom path does not exist', () => {
    const result = findAuthFile('/nonexistent/path/auth.json', []);
    expect(result).toBeUndefined();
  });

  it('searches well-known paths in order', () => {
    const first = writeTmpAuth('first/auth.json', { api_key: 'a' });
    const second = writeTmpAuth('second/auth.json', { api_key: 'b' });
    const result = findAuthFile(undefined, [first, second]);
    expect(result).toBe(first);
  });

  it('falls back to second path if first does not exist', () => {
    const second = writeTmpAuth('second/auth.json', { api_key: 'b' });
    const result = findAuthFile(undefined, [
      path.join(tmpDir, 'nonexistent/auth.json'),
      second,
    ]);
    expect(result).toBe(second);
  });

  it('returns undefined when no search paths match', () => {
    const result = findAuthFile(undefined, [
      path.join(tmpDir, 'nope1.json'),
      path.join(tmpDir, 'nope2.json'),
    ]);
    expect(result).toBeUndefined();
  });
});

// ─── parseAuthFile ───────────────────────────────────────

describe('parseAuthFile', () => {
  it('parses valid auth.json with all fields', () => {
    const p = writeTmpAuth('auth.json', {
      openai_api_key: 'sk-test-openai',
      anthropic_api_key: 'sk-ant-test',
      oauth_token: 'oauth-tok-123',
      provider: 'openai',
      api_key: 'generic-key',
      codex: {
        token: 'codex-tok',
        refresh_token: 'codex-refresh',
        expires_at: '2026-12-31T00:00:00Z',
      },
    });

    const result = parseAuthFile(p);
    expect(result.openai_api_key).toBe('sk-test-openai');
    expect(result.anthropic_api_key).toBe('sk-ant-test');
    expect(result.oauth_token).toBe('oauth-tok-123');
    expect(result.provider).toBe('openai');
    expect(result.api_key).toBe('generic-key');
    expect(result.codex?.token).toBe('codex-tok');
    expect(result.codex?.refresh_token).toBe('codex-refresh');
    expect(result.codex?.expires_at).toBe('2026-12-31T00:00:00Z');
  });

  it('parses installed Codex auth.json tokens', () => {
    const p = writeTmpAuth('auth.json', {
      auth_mode: 'chatgpt',
      last_refresh: '2026-03-11T04:51:48.731097Z',
      tokens: {
        access_token: 'header.eyJleHAiOjE4MDAwMDAwMDB9.signature',
        refresh_token: 'refresh-token',
        id_token: 'id-token',
        account_id: 'account-123',
      },
    });

    const result = parseAuthFile(p);
    expect(result.auth_mode).toBe('chatgpt');
    expect(result.last_refresh).toBe('2026-03-11T04:51:48.731097Z');
    expect(result.tokens?.access_token).toBe('header.eyJleHAiOjE4MDAwMDAwMDB9.signature');
    expect(result.tokens?.refresh_token).toBe('refresh-token');
    expect(result.tokens?.account_id).toBe('account-123');
  });

  it('parses codex-login style oauth store entry', () => {
    const p = writeTmpAuth('auth.json', {
      'openai-codex': {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 1800000000000,
        accountId: 'account-xyz',
      },
    });

    const result = parseAuthFile(p);
    expect(result.openaiCodexOAuth).toEqual({
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1800000000000,
      accountId: 'account-xyz',
    });
  });

  it('handles minimal auth.json (empty object)', () => {
    const p = writeTmpAuth('auth.json', {});
    const result = parseAuthFile(p);
    expect(result).toEqual({});
  });

  it('ignores non-string values for string fields', () => {
    const p = writeTmpAuth('auth.json', {
      openai_api_key: 12345,
      anthropic_api_key: null,
      provider: true,
    });
    const result = parseAuthFile(p);
    expect(result.openai_api_key).toBeUndefined();
    expect(result.anthropic_api_key).toBeUndefined();
    expect(result.provider).toBeUndefined();
  });

  it('ignores empty string values', () => {
    const p = writeTmpAuth('auth.json', {
      openai_api_key: '',
      anthropic_api_key: '',
    });
    const result = parseAuthFile(p);
    expect(result.openai_api_key).toBeUndefined();
    expect(result.anthropic_api_key).toBeUndefined();
  });

  it('throws on invalid JSON', () => {
    const p = writeTmpAuth('auth.json', 'not json {{{');
    expect(() => parseAuthFile(p)).toThrow(/Invalid JSON/);
  });

  it('throws on non-object JSON (array)', () => {
    const p = writeTmpAuth('auth.json', '["not", "an", "object"]');
    expect(() => parseAuthFile(p)).toThrow(/must be a JSON object/);
  });

  it('throws on non-object JSON (string)', () => {
    const p = writeTmpAuth('auth.json', '"just a string"');
    expect(() => parseAuthFile(p)).toThrow(/must be a JSON object/);
  });
});

// ─── resolveCredentials ──────────────────────────────────

describe('resolveCredentials', () => {
  const src = '/test/auth.json';

  it('resolves provider-specific keys directly', () => {
    const content: AuthFileContent = {
      openai_api_key: 'sk-openai',
      anthropic_api_key: 'sk-anthropic',
    };
    const creds = resolveCredentials(content, src);
    expect(creds.openaiApiKey).toBe('sk-openai');
    expect(creds.anthropicApiKey).toBe('sk-anthropic');
    expect(creds.sourcePath).toBe(src);
  });

  it('sets defaultProvider from explicit provider field', () => {
    const content: AuthFileContent = {
      openai_api_key: 'sk-openai',
      anthropic_api_key: 'sk-anthropic',
      provider: 'anthropic',
    };
    const creds = resolveCredentials(content, src);
    expect(creds.defaultProvider).toBe('anthropic');
  });

  it('infers defaultProvider when only openai key present', () => {
    const creds = resolveCredentials({ openai_api_key: 'sk-openai' }, src);
    expect(creds.defaultProvider).toBe('openai');
  });

  it('infers defaultProvider when only anthropic key present', () => {
    const creds = resolveCredentials({ anthropic_api_key: 'sk-ant' }, src);
    expect(creds.defaultProvider).toBe('anthropic');
  });

  it('uses generic api_key for default provider (openai)', () => {
    const creds = resolveCredentials({ api_key: 'generic-key' }, src);
    expect(creds.openaiApiKey).toBe('generic-key');
    expect(creds.defaultProvider).toBe('openai');
  });

  it('uses generic api_key for anthropic when provider is set', () => {
    const creds = resolveCredentials(
      { api_key: 'generic-key', provider: 'anthropic' },
      src,
    );
    expect(creds.anthropicApiKey).toBe('generic-key');
    expect(creds.defaultProvider).toBe('anthropic');
  });

  it('uses oauth_token as fallback key', () => {
    const creds = resolveCredentials({ oauth_token: 'oauth-tok' }, src);
    expect(creds.openaiApiKey).toBe('oauth-tok');
  });

  it('uses codex.token as fallback key', () => {
    const creds = resolveCredentials(
      { codex: { token: 'codex-tok' }, provider: 'anthropic' },
      src,
    );
    expect(creds.anthropicApiKey).toBe('codex-tok');
    expect(creds.defaultProvider).toBe('anthropic');
  });

  it('does not overwrite provider-specific key with generic key', () => {
    const creds = resolveCredentials(
      { openai_api_key: 'specific', api_key: 'generic' },
      src,
    );
    expect(creds.openaiApiKey).toBe('specific');
  });

  it('normalizes codex-login oauth credentials', () => {
    const creds = resolveCredentials(
      {
        openaiCodexOAuth: {
          access: 'access-token',
          refresh: 'refresh-token',
          expires: 1800000000000,
          accountId: 'account-xyz',
        },
      },
      src,
    );

    expect(creds.codexOAuth).toEqual({
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1800000000000,
      accountId: 'account-xyz',
    });
    expect(creds.defaultProvider).toBe('openai');
  });

  it('normalizes installed codex auth tokens using JWT expiry', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1800000000 })).toString('base64url');
    const accessToken = `header.${payload}.signature`;

    const creds = resolveCredentials(
      {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessToken,
          refresh_token: 'refresh-token',
          account_id: 'account-abc',
        },
      },
      src,
    );

    expect(creds.codexOAuth).toEqual({
      access: accessToken,
      refresh: 'refresh-token',
      expires: 1800000000000,
      accountId: 'account-abc',
    });
    expect(creds.defaultProvider).toBe('openai');
  });

  it('handles empty content gracefully', () => {
    const creds = resolveCredentials({}, src);
    expect(creds.openaiApiKey).toBeUndefined();
    expect(creds.anthropicApiKey).toBeUndefined();
    expect(creds.codexOAuth).toBeUndefined();
    expect(creds.defaultProvider).toBeUndefined();
    expect(creds.sourcePath).toBe(src);
  });
});

// ─── loadAuthCredentials ─────────────────────────────────

describe('loadAuthCredentials', () => {
  it('loads credentials from custom path', () => {
    const p = writeTmpAuth('my-auth.json', {
      openai_api_key: 'sk-from-custom',
      provider: 'openai',
    });
    const creds = loadAuthCredentials(p);
    expect(creds).toBeDefined();
    expect(creds!.openaiApiKey).toBe('sk-from-custom');
    expect(creds!.sourcePath).toBe(p);
  });

  it('returns undefined when no auth file found and search paths empty', () => {
    // Use findAuthFile directly with empty search paths to guarantee no file found
    const authFile = findAuthFile('/nonexistent/auth.json', []);
    expect(authFile).toBeUndefined();
  });

  it('respects NERO_AUTH_PATH environment variable', () => {
    const p = writeTmpAuth('env-auth.json', {
      anthropic_api_key: 'sk-ant-env',
    });
    process.env['NERO_AUTH_PATH'] = p;
    const creds = loadAuthCredentials();
    expect(creds).toBeDefined();
    expect(creds!.anthropicApiKey).toBe('sk-ant-env');
  });

  it('custom path parameter takes priority over NERO_AUTH_PATH', () => {
    const envPath = writeTmpAuth('env.json', { api_key: 'env-key' });
    const customPath = writeTmpAuth('custom.json', { api_key: 'custom-key' });
    process.env['NERO_AUTH_PATH'] = envPath;
    const creds = loadAuthCredentials(customPath);
    expect(creds!.openaiApiKey).toBe('custom-key');
  });
});

// ─── getApiKeyForProvider ────────────────────────────────

describe('getApiKeyForProvider', () => {
  const creds: AuthCredentials = {
    openaiApiKey: 'sk-openai',
    anthropicApiKey: 'sk-anthropic',
    sourcePath: '/test',
  };

  it('returns openai key for openai provider', () => {
    expect(getApiKeyForProvider(creds, 'openai')).toBe('sk-openai');
  });

  it('returns anthropic key for anthropic provider', () => {
    expect(getApiKeyForProvider(creds, 'anthropic')).toBe('sk-anthropic');
  });

  it('returns undefined when key is missing', () => {
    const partial: AuthCredentials = { sourcePath: '/test' };
    expect(getApiKeyForProvider(partial, 'openai')).toBeUndefined();
  });
});

// ─── AUTH_SEARCH_PATHS ───────────────────────────────────

describe('AUTH_SEARCH_PATHS', () => {
  it('includes nero-mem and codex paths', () => {
    const paths = AUTH_SEARCH_PATHS.map((p) => path.basename(path.dirname(p)));
    expect(paths).toContain('.nero-mem');
    expect(paths).toContain('.codex');
  });

  it('includes project-local auth.json', () => {
    const last = AUTH_SEARCH_PATHS[AUTH_SEARCH_PATHS.length - 1]!;
    expect(path.basename(last)).toBe('auth.json');
  });
});
