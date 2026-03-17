/**
 * SQLite schema for co-retrieval tracking tables.
 *
 * Tracks when memory nodes are retrieved together during dual-path recall,
 * maintaining both individual events and aggregated pair frequencies.
 */

export const CREATE_CO_RETRIEVAL_TABLES = `
-- Co-retrieval events: log of each retrieval result set (immutable)
CREATE TABLE IF NOT EXISTS co_retrieval_events (
  id TEXT PRIMARY KEY NOT NULL,
  query_text TEXT NOT NULL,
  retrieved_node_ids TEXT NOT NULL,   -- JSON array of node IDs
  result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT                       -- JSON string
);

CREATE INDEX IF NOT EXISTS idx_co_retrieval_events_created
  ON co_retrieval_events(created_at DESC);

-- Co-retrieval pair frequencies: aggregated counter for each unique pair
-- Canonical ordering: node_a_id < node_b_id (lexicographic)
CREATE TABLE IF NOT EXISTS co_retrieval_pairs (
  id TEXT PRIMARY KEY NOT NULL,
  node_a_id TEXT NOT NULL,
  node_a_type TEXT NOT NULL CHECK(node_a_type IN ('episode', 'concept', 'fact', 'anchor')),
  node_b_id TEXT NOT NULL,
  node_b_type TEXT NOT NULL CHECK(node_b_type IN ('episode', 'concept', 'fact', 'anchor')),
  frequency INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(node_a_id, node_b_id)
);

CREATE INDEX IF NOT EXISTS idx_co_retrieval_pairs_node_a
  ON co_retrieval_pairs(node_a_id);

CREATE INDEX IF NOT EXISTS idx_co_retrieval_pairs_node_b
  ON co_retrieval_pairs(node_b_id);

CREATE INDEX IF NOT EXISTS idx_co_retrieval_pairs_frequency
  ON co_retrieval_pairs(frequency DESC);

CREATE INDEX IF NOT EXISTS idx_co_retrieval_pairs_last_seen
  ON co_retrieval_pairs(last_seen_at DESC);
`;
