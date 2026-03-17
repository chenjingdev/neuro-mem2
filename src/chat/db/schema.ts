/**
 * SQLite schema for the Visual Debug Chat App.
 *
 * Three tables store chat conversations, messages, and pipeline trace events:
 *
 *   - chat_conversations: top-level debug chat sessions
 *   - chat_messages: individual user/assistant messages within a conversation
 *   - chat_trace_events: recall + ingestion pipeline trace events per message
 *
 * All DDL is idempotent (IF NOT EXISTS) so it can be called on every startup.
 */

export const CHAT_SCHEMA_VERSION = 1;

export const CREATE_CHAT_TABLES = `
-- Debug-chat conversations
CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT,                -- nero-mem2 session ID (from startSession)
  user_id TEXT NOT NULL DEFAULT 'debug-user',
  metadata TEXT                   -- JSON string for arbitrary extra data
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated
  ON chat_conversations(updated_at);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_user
  ON chat_conversations(user_id);

-- Messages within a debug-chat conversation
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  token_count INTEGER,            -- approximate token count (optional)
  duration_ms REAL,               -- wall-clock time for assistant response
  model TEXT,                     -- which LLM model produced this response
  metadata TEXT,                  -- JSON string
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages(conversation_id, turn_index);

-- Pipeline trace events captured during a single message exchange
CREATE TABLE IF NOT EXISTS chat_trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,       -- the assistant message this trace belongs to
  trace_id INTEGER NOT NULL,      -- TraceEvent.id (monotonic within collector)
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('start', 'complete', 'error', 'skipped')),
  parent_stage TEXT,
  input TEXT,                     -- JSON string
  output TEXT,                    -- JSON string
  error TEXT,
  skip_reason TEXT,
  duration_ms REAL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id),
  FOREIGN KEY (message_id) REFERENCES chat_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_trace_events_message
  ON chat_trace_events(message_id);

CREATE INDEX IF NOT EXISTS idx_chat_trace_events_conversation
  ON chat_trace_events(conversation_id);

CREATE INDEX IF NOT EXISTS idx_chat_trace_events_stage
  ON chat_trace_events(stage, status);
`;
