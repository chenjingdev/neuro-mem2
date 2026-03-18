/**
 * SQLite schema for the unified MemoryNode table with 4-layer progressive depth.
 *
 * Layer structure:
 *   L0 — frontmatter (TEXT), keywords (FTS5-indexed), embedding (BLOB)
 *   L1 — metadata (JSON TEXT)
 *   L2 — summary (TEXT)
 *   L3 — source_message_ids (JSON TEXT) + conversation_id + source_turn_index
 *
 * FTS5 virtual table enables full-text search across frontmatter + keywords + summary
 * for both Korean and English content (한영 혼용).
 *
 * The embedding column stores Float32Array as BLOB for brute-force cosine similarity.
 * Pre-filtering via FTS5 narrows candidates before vector reranking.
 */

export const CREATE_MEMORY_NODE_TABLES = `
-- ═══════════════════════════════════════════════════════════════════
-- memory_nodes: unified memory table replacing facts/episodes/concepts/anchors
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memory_nodes (
  -- Primary key
  id TEXT PRIMARY KEY NOT NULL,

  -- Classification
  node_type TEXT CHECK(node_type IS NULL OR node_type IN ('semantic', 'episodic', 'procedural', 'prospective', 'emotional')),
  node_role TEXT NOT NULL DEFAULT 'leaf' CHECK(node_role IN ('hub', 'leaf')),

  -- L0: Anchor / Embedding / Keywords
  frontmatter TEXT NOT NULL,                          -- One-line label for L0 context injection
  keywords TEXT NOT NULL DEFAULT '',                   -- Space-separated FTS5 keywords (한영 혼용)
  embedding BLOB,                                     -- Float32Array as binary blob
  embedding_dim INTEGER,                              -- Embedding vector dimensionality

  -- L1: JSON Metadata
  metadata TEXT NOT NULL DEFAULT '{}',                 -- JSON: entities, category, confidence, SPO, etc.

  -- L2: Summary
  summary TEXT NOT NULL DEFAULT '',                    -- Human-readable summary text

  -- L3: Source References
  source_message_ids TEXT NOT NULL DEFAULT '[]',       -- JSON array of raw_messages.id
  conversation_id TEXT,                                -- Source conversation (NULL for hub/index nodes)
  source_turn_index INTEGER,                           -- Turn index for per-turn facts

  -- Lifecycle (event-based decay)
  created_at_event REAL NOT NULL DEFAULT 0.0,          -- Global event counter at creation
  last_activated_at_event REAL NOT NULL DEFAULT 0.0,   -- Global event counter at last activation
  activation_count INTEGER NOT NULL DEFAULT 0,         -- Number of activations

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════
-- Indexes for efficient querying at scale (수십만 노드 대응)
-- ═══════════════════════════════════════════════════════════════════

-- Classification queries
CREATE INDEX IF NOT EXISTS idx_memory_nodes_type
  ON memory_nodes(node_type);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_role
  ON memory_nodes(node_role);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_type_role
  ON memory_nodes(node_type, node_role);

-- Source tracing (L3)
CREATE INDEX IF NOT EXISTS idx_memory_nodes_conversation
  ON memory_nodes(conversation_id) WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_nodes_turn
  ON memory_nodes(conversation_id, source_turn_index)
  WHERE source_turn_index IS NOT NULL;

-- Lifecycle / decay queries
CREATE INDEX IF NOT EXISTS idx_memory_nodes_activation
  ON memory_nodes(activation_count DESC);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_last_event
  ON memory_nodes(last_activated_at_event DESC);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_created_event
  ON memory_nodes(created_at_event DESC);

-- Hub node fast lookup
CREATE INDEX IF NOT EXISTS idx_memory_nodes_hubs
  ON memory_nodes(node_type, frontmatter)
  WHERE node_role = 'hub';

-- Timestamp queries
CREATE INDEX IF NOT EXISTS idx_memory_nodes_created
  ON memory_nodes(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_updated
  ON memory_nodes(updated_at DESC);

-- ═══════════════════════════════════════════════════════════════════
-- FTS5 virtual table for full-text search (한영 혼용 지원)
-- ═══════════════════════════════════════════════════════════════════
-- Indexes frontmatter + keywords + summary for hybrid FTS5+vector search.
--
-- Tokenizer: unicode61 with remove_diacritics=2 for robust Unicode handling.
--   - Correctly segments Korean/CJK characters at Unicode category boundaries
--   - English words lowercased automatically by FTS5
--   - remove_diacritics=2 strips accents (café → cafe) for broader matching
--
-- External content mode (content='memory_nodes', content_rowid='rowid')
-- avoids data duplication — FTS5 reads content from memory_nodes on demand.
--
-- Column order matters for BM25 weighting in search queries:
--   bm25(memory_nodes_fts, 2.0, 10.0, 1.0) → frontmatter:2, keywords:10, summary:1
--   Keywords get highest weight since they are pre-normalized search anchors.
-- ═══════════════════════════════════════════════════════════════════
CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
  frontmatter,
  keywords,
  summary,
  content='memory_nodes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- ═══════════════════════════════════════════════════════════════════
-- Triggers to keep FTS5 index in sync with memory_nodes table
-- ═══════════════════════════════════════════════════════════════════
-- These triggers maintain the external content FTS5 index automatically.
-- Keywords are expected to be pre-normalized (lowercased, deduped, sorted)
-- by the application layer (keyword-normalizer.ts) before INSERT/UPDATE.
-- ═══════════════════════════════════════════════════════════════════

-- After INSERT: index the new row
CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_insert
  AFTER INSERT ON memory_nodes
BEGIN
  INSERT INTO memory_nodes_fts(rowid, frontmatter, keywords, summary)
  VALUES (NEW.rowid, NEW.frontmatter, NEW.keywords, NEW.summary);
END;

-- Before UPDATE: remove old FTS entry (must happen before content changes)
CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_update_before
  BEFORE UPDATE ON memory_nodes
BEGIN
  DELETE FROM memory_nodes_fts WHERE rowid = OLD.rowid;
END;

-- After UPDATE: index the new content
CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_update_after
  AFTER UPDATE ON memory_nodes
BEGIN
  INSERT INTO memory_nodes_fts(rowid, frontmatter, keywords, summary)
  VALUES (NEW.rowid, NEW.frontmatter, NEW.keywords, NEW.summary);
END;

-- Before DELETE: remove from FTS index (must happen while content still exists)
CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_delete
  BEFORE DELETE ON memory_nodes
BEGIN
  DELETE FROM memory_nodes_fts WHERE rowid = OLD.rowid;
END;
`;
