/**
 * Database connection helper for the Visual Debug Chat App.
 *
 * Re-uses the same better-sqlite3 instance used by the rest of nero-mem2
 * (or creates a standalone one for testing / independent usage).
 * The chat tables are applied via `ensureChatTables()` which is idempotent.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { CREATE_CHAT_TABLES, CHAT_SCHEMA_VERSION } from './schema.js';

// ─── Types ────────────────────────────────────────────────

export interface ChatDatabaseOptions {
  /** An existing better-sqlite3 handle to reuse. */
  db?: Database.Database;
  /** Path to a standalone SQLite file (ignored when `db` is provided). */
  dbPath?: string;
  /** Use in-memory database (for testing). Ignored when `db` is provided. */
  inMemory?: boolean;
}

// ─── Default path ─────────────────────────────────────────

const DEFAULT_DB_DIR = path.join(
  process.env['HOME'] || process.env['USERPROFILE'] || '.',
  '.nero-mem',
);
const DEFAULT_CHAT_DB_PATH = path.join(DEFAULT_DB_DIR, 'chat-debug.db');

// ─── Public API ───────────────────────────────────────────

/**
 * Ensure the chat tables exist on the given database handle.
 * Safe to call multiple times — all DDL uses IF NOT EXISTS.
 */
export function ensureChatTables(db: Database.Database): void {
  db.exec(CREATE_CHAT_TABLES);
}

/**
 * Open (or reuse) a database connection with the chat tables applied.
 *
 * Three modes:
 *   1. Pass an existing `db` handle → tables are applied in-place.
 *   2. Pass a `dbPath` → a new handle is created at that path.
 *   3. Pass `inMemory: true` → an in-memory handle (tests).
 *   4. Omit everything → default `~/.nero-mem/chat-debug.db`.
 */
export function openChatDatabase(options: ChatDatabaseOptions = {}): Database.Database {
  if (options.db) {
    ensureChatTables(options.db);
    return options.db;
  }

  const dbPath = options.inMemory ? ':memory:' : (options.dbPath ?? DEFAULT_CHAT_DB_PATH);

  if (!options.inMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);

  // Performance pragmas (same as core nero-mem2)
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  ensureChatTables(db);

  return db;
}

/**
 * Return the current chat schema version.
 */
export function getChatSchemaVersion(): number {
  return CHAT_SCHEMA_VERSION;
}
