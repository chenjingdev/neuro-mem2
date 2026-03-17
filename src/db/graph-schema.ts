/**
 * SQLite schema for the memory graph layer.
 * Adds concepts table and memory_edges for graph relationships.
 *
 * Note: episodes and facts tables are defined in schema.ts.
 * This schema adds the graph connectivity layer on top.
 */

export const CREATE_GRAPH_TABLES = `
-- Concepts: abstract topics/themes extracted from conversations (batch)
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',   -- JSON array of alternative names
  category TEXT NOT NULL CHECK(category IN (
    'technology', 'architecture', 'domain', 'methodology',
    'preference', 'project', 'platform', 'standard', 'other'
  )),
  relevance REAL NOT NULL DEFAULT 0.5 CHECK(relevance >= 0.0 AND relevance <= 1.0),
  source_conversation_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of conversation IDs
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT  -- JSON string
);

CREATE INDEX IF NOT EXISTS idx_concepts_name
  ON concepts(name);

CREATE INDEX IF NOT EXISTS idx_concepts_category
  ON concepts(category);

CREATE UNIQUE INDEX IF NOT EXISTS idx_concepts_name_unique
  ON concepts(LOWER(name));

-- Memory edges: graph relationships between episodes, concepts, and facts
-- with Hebbian-style weights for co-activation strength
CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('episode', 'concept', 'fact', 'anchor')),
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('episode', 'concept', 'fact', 'anchor')),
  edge_type TEXT NOT NULL CHECK(edge_type IN (
    'episode_mentions_concept',
    'concept_related_to',
    'fact_supports_concept',
    'episode_contains_fact',
    'temporal_next',
    'derived_from'
  )),
  weight REAL NOT NULL DEFAULT 0.5 CHECK(weight >= 0.0 AND weight <= 1.0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT,  -- JSON string
  UNIQUE(source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_source
  ON memory_edges(source_id, source_type);

CREATE INDEX IF NOT EXISTS idx_memory_edges_target
  ON memory_edges(target_id, target_type);

CREATE INDEX IF NOT EXISTS idx_memory_edges_type
  ON memory_edges(edge_type);
`;
