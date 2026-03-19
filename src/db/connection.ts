/**
 * SQLite database connection manager.
 * Provides a singleton-style connection with WAL mode for performance.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { CREATE_TABLES, SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './schema.js';
import { CREATE_GRAPH_TABLES } from './graph-schema.js';
import { CREATE_ANCHOR_TABLES } from './anchor-schema.js';
import { CREATE_CO_RETRIEVAL_TABLES } from './co-retrieval-schema.js';
import { CREATE_MEMORY_EMBEDDING_TABLES } from './memory-embedding-schema.js';
import { CREATE_SYSTEM_STATE_TABLE } from './system-state-schema.js';
import { CREATE_MEMORY_NODE_TABLES } from './memory-node-schema.js';
import { CREATE_IDENTITY_TABLES } from './identity-schema.js';

export interface DatabaseOptions {
  /** Path to the SQLite database file. Defaults to ~/.nero-mem/nero.db */
  dbPath?: string;
  /** Use in-memory database (for testing) */
  inMemory?: boolean;
}

const DEFAULT_DB_DIR = path.join(
  process.env['HOME'] || process.env['USERPROFILE'] || '.',
  '.nero-mem'
);
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'nero.db');

export function createDatabase(options: DatabaseOptions = {}): Database.Database {
  let db: Database.Database;

  if (options.inMemory) {
    db = new Database(':memory:');
  } else {
    const dbPath = options.dbPath || DEFAULT_DB_PATH;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(dbPath);
  }

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Initialize schema
  db.exec(CREATE_TABLES);
  db.exec(CREATE_GRAPH_TABLES);
  db.exec(CREATE_ANCHOR_TABLES);
  db.exec(CREATE_CO_RETRIEVAL_TABLES);
  db.exec(CREATE_MEMORY_EMBEDDING_TABLES);
  db.exec(CREATE_SYSTEM_STATE_TABLE);
  db.exec(CREATE_MEMORY_NODE_TABLES);
  db.exec(CREATE_IDENTITY_TABLES);

  // Check/set schema version and run migrations
  const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  if (!versionRow) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  } else if (versionRow.version < SCHEMA_VERSION) {
    // Run migrations for each version between current and target
    for (let v = versionRow.version + 1; v <= SCHEMA_VERSION; v++) {
      const migration = SCHEMA_MIGRATIONS[v];
      if (migration) {
        try {
          db.exec(migration);
        } catch (_e) {
          // Columns may already exist (e.g., fresh DB created with new schema)
          // SQLite ALTER TABLE ADD COLUMN throws if column already exists
        }
      }
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }

  return db;
}
