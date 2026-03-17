/**
 * SQLite schema definitions for nero-mem2.
 * All DDL statements are idempotent (IF NOT EXISTS).
 */

export const SCHEMA_VERSION = 4;

export const CREATE_TABLES = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw conversations (immutable after creation, only updatedAt changes on append)
CREATE TABLE IF NOT EXISTS raw_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT  -- JSON string
);

-- Raw messages (immutable, append-only)
CREATE TABLE IF NOT EXISTS raw_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT,  -- JSON string
  FOREIGN KEY (conversation_id) REFERENCES raw_conversations(id)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_raw_messages_conversation
  ON raw_messages(conversation_id, turn_index);

CREATE INDEX IF NOT EXISTS idx_raw_conversations_source
  ON raw_conversations(source);

CREATE INDEX IF NOT EXISTS idx_raw_conversations_updated
  ON raw_conversations(updated_at);

-- Episodes: chronological events/actions/decisions extracted from conversations (batch)
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('action', 'decision', 'event', 'discovery')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  start_turn_index INTEGER NOT NULL,
  end_turn_index INTEGER NOT NULL,
  source_message_ids TEXT NOT NULL,  -- JSON array of message IDs
  actors TEXT NOT NULL,              -- JSON array of actor strings
  outcome TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT,                     -- JSON string
  FOREIGN KEY (conversation_id) REFERENCES raw_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_episodes_conversation
  ON episodes(conversation_id);

CREATE INDEX IF NOT EXISTS idx_episodes_type
  ON episodes(type);

-- Facts: atomic knowledge extracted per-turn (real-time extraction)
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  source_message_ids TEXT NOT NULL,     -- JSON array of raw_messages.id
  source_turn_index INTEGER NOT NULL,   -- Turn index within the conversation
  content TEXT NOT NULL,                -- The factual statement
  category TEXT NOT NULL CHECK(category IN (
    'preference', 'technical', 'requirement', 'decision',
    'context', 'instruction', 'knowledge', 'relationship', 'other'
  )),
  confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
  entities TEXT NOT NULL DEFAULT '[]',  -- JSON array of entity strings
  subject TEXT,                         -- Optional SPO triple: subject
  predicate TEXT,                       -- Optional SPO triple: predicate
  object TEXT,                          -- Optional SPO triple: object
  superseded INTEGER NOT NULL DEFAULT 0, -- Boolean: 0=active, 1=superseded
  superseded_by TEXT,                   -- ID of superseding fact
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT,                        -- JSON string
  FOREIGN KEY (conversation_id) REFERENCES raw_conversations(id),
  FOREIGN KEY (superseded_by) REFERENCES facts(id)
);

-- Indexes for fact retrieval
CREATE INDEX IF NOT EXISTS idx_facts_conversation
  ON facts(conversation_id, source_turn_index);

CREATE INDEX IF NOT EXISTS idx_facts_category
  ON facts(category);

CREATE INDEX IF NOT EXISTS idx_facts_active
  ON facts(superseded) WHERE superseded = 0;

CREATE INDEX IF NOT EXISTS idx_facts_entities
  ON facts(entities);

CREATE INDEX IF NOT EXISTS idx_facts_subject
  ON facts(subject) WHERE subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_facts_created
  ON facts(created_at);

-- Sessions track active conversation periods and their lifecycle
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'ended', 'processing', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK(end_reason IN ('explicit', 'timeout', 'ttl_expired') OR end_reason IS NULL),
  timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  ttl_ms INTEGER,  -- Maximum session lifetime in ms (NULL = no limit)
  metadata TEXT,  -- JSON string
  FOREIGN KEY (conversation_id) REFERENCES raw_conversations(id)
);

-- Batch extraction jobs triggered on session end
CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  job_type TEXT NOT NULL
    CHECK(job_type IN ('episode_extraction', 'concept_extraction', 'full_extraction')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  result TEXT,  -- JSON string
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (conversation_id) REFERENCES raw_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_conversation
  ON sessions(conversation_id, status);

CREATE INDEX IF NOT EXISTS idx_sessions_status
  ON sessions(status);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_session
  ON batch_jobs(session_id);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status
  ON batch_jobs(status, created_at);
`;
