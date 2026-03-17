/**
 * API Key store — manages API keys in SQLite.
 * Keys are stored as SHA-256 hashes; the raw key is only returned on creation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { ApiKey, CreateApiKeyOptions, CreateApiKeyResult } from './types.js';

const API_KEY_PREFIX = 'nmem_';

/** SQL schema for the api_keys table */
export const API_KEYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_used_at TEXT,
  is_revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
`;

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const bytes = randomBytes(32);
  const raw = API_KEY_PREFIX + bytes.toString('base64url');
  const prefix = raw.slice(0, 12);
  const hash = hashKey(raw);
  return { raw, prefix, hash };
}

export class ApiKeyStore {
  private stmtInsert!: ReturnType<Database.Database['prepare']>;
  private stmtFindByHash!: ReturnType<Database.Database['prepare']>;
  private stmtRevoke!: ReturnType<Database.Database['prepare']>;
  private stmtUpdateLastUsed!: ReturnType<Database.Database['prepare']>;
  private stmtList!: ReturnType<Database.Database['prepare']>;
  private stmtFindById!: ReturnType<Database.Database['prepare']>;

  constructor(private readonly db: Database.Database) {
    this.db.exec(API_KEYS_SCHEMA);
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO api_keys (id, name, key_hash, prefix, scopes, created_at, expires_at, is_revoked)
      VALUES (@id, @name, @keyHash, @prefix, @scopes, @createdAt, @expiresAt, 0)
    `);
    this.stmtFindByHash = this.db.prepare(`
      SELECT * FROM api_keys WHERE key_hash = ?
    `);
    this.stmtRevoke = this.db.prepare(`
      UPDATE api_keys SET is_revoked = 1 WHERE id = ?
    `);
    this.stmtUpdateLastUsed = this.db.prepare(`
      UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?
    `);
    this.stmtList = this.db.prepare(`
      SELECT * FROM api_keys ORDER BY created_at DESC
    `);
    this.stmtFindById = this.db.prepare(`
      SELECT * FROM api_keys WHERE id = ?
    `);
  }

  /** Create a new API key. Returns the raw key (shown only once). */
  create(options: CreateApiKeyOptions): CreateApiKeyResult {
    const { raw, prefix, hash } = generateApiKey();
    const id = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = options.expiresInMs
      ? new Date(Date.now() + options.expiresInMs).toISOString()
      : null;
    const scopes = options.scopes ?? ['memory:read', 'memory:write'];

    this.stmtInsert.run({
      id,
      name: options.name,
      keyHash: hash,
      prefix,
      scopes: JSON.stringify(scopes),
      createdAt: now,
      expiresAt,
    });

    return { id, key: raw, name: options.name, prefix, scopes, expiresAt };
  }

  /** Validate a raw API key. Returns the key record if valid, null otherwise. */
  validate(rawKey: string): ApiKey | null {
    const hash = hashKey(rawKey);
    const row = this.stmtFindByHash.get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;

    const apiKey = this.rowToApiKey(row);

    // Check revoked
    if (apiKey.isRevoked) return null;

    // Check expiry
    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) return null;

    // Update last used
    this.stmtUpdateLastUsed.run(apiKey.id);

    return apiKey;
  }

  /** Revoke an API key by ID */
  revoke(id: string): boolean {
    const result = this.stmtRevoke.run(id);
    return result.changes > 0;
  }

  /** List all API keys (without hashes) */
  list(): ApiKey[] {
    const rows = this.stmtList.all({}) as Record<string, unknown>[];
    return rows.map((row) => this.rowToApiKey(row));
  }

  /** Find API key by ID */
  findById(id: string): ApiKey | null {
    const row = this.stmtFindById.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToApiKey(row) : null;
  }

  private rowToApiKey(row: Record<string, unknown>): ApiKey {
    return {
      id: row.id as string,
      name: row.name as string,
      keyHash: row.key_hash as string,
      prefix: row.prefix as string,
      scopes: JSON.parse(row.scopes as string) as string[],
      createdAt: row.created_at as string,
      expiresAt: (row.expires_at as string) ?? null,
      lastUsedAt: (row.last_used_at as string) ?? null,
      isRevoked: (row.is_revoked as number) === 1,
    };
  }
}
