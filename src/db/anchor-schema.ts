/**
 * SQLite schema for the anchor and weighted-edge retrieval layer.
 *
 * Anchors are semantic hub nodes for dual-path retrieval.
 * Weighted edges connect anchors to memory nodes with Hebbian learning parameters.
 */

export const CREATE_ANCHOR_TABLES = `
-- Anchors: semantic hub nodes for dual-path (vector + graph) retrieval
CREATE TABLE IF NOT EXISTS anchors (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  anchor_type TEXT NOT NULL CHECK(anchor_type IN ('entity', 'topic', 'temporal', 'composite')),
  aliases TEXT NOT NULL DEFAULT '[]',           -- JSON array of alternative labels
  embedding BLOB,                               -- Float32Array serialized as binary blob
  embedding_dim INTEGER,                        -- Dimensionality of the embedding vector
  -- Decay metadata: importance weight that decays over time
  current_weight REAL NOT NULL DEFAULT 0.5 CHECK(current_weight >= 0.0 AND current_weight <= 1.0),
  initial_weight REAL NOT NULL DEFAULT 0.5 CHECK(initial_weight >= 0.0 AND initial_weight <= 1.0),
  decay_rate REAL NOT NULL DEFAULT 0.01 CHECK(decay_rate >= 0.0 AND decay_rate <= 1.0),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,                         -- ISO 8601 timestamp of last retrieval access
  -- Activation tracking (Hebbian co-activation)
  activation_count INTEGER NOT NULL DEFAULT 0,
  last_activated_at TEXT,                        -- ISO 8601 timestamp
  -- Timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT                                  -- JSON string
);

CREATE INDEX IF NOT EXISTS idx_anchors_label
  ON anchors(label);

CREATE INDEX IF NOT EXISTS idx_anchors_type
  ON anchors(anchor_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_anchors_label_unique
  ON anchors(LOWER(label));

CREATE INDEX IF NOT EXISTS idx_anchors_activation
  ON anchors(activation_count DESC);

CREATE INDEX IF NOT EXISTS idx_anchors_weight
  ON anchors(current_weight DESC);

CREATE INDEX IF NOT EXISTS idx_anchors_last_accessed
  ON anchors(last_accessed_at DESC);

-- Weighted edges: retrieval graph edges with Hebbian learning parameters
-- Connects anchors to memory nodes (facts, episodes, concepts) and to other anchors
CREATE TABLE IF NOT EXISTS weighted_edges (
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
    'derived_from',
    'anchor_to_fact',
    'anchor_to_episode',
    'anchor_to_concept',
    'anchor_to_anchor',
    'query_activated'
  )),
  weight REAL NOT NULL DEFAULT 0.5 CHECK(weight >= 0.0 AND weight <= 1.0),
  initial_weight REAL NOT NULL DEFAULT 0.5 CHECK(initial_weight >= 0.0 AND initial_weight <= 1.0),
  learning_rate REAL NOT NULL DEFAULT 0.1 CHECK(learning_rate > 0.0 AND learning_rate <= 1.0),
  decay_rate REAL NOT NULL DEFAULT 0.01 CHECK(decay_rate >= 0.0 AND decay_rate <= 1.0),
  activation_count INTEGER NOT NULL DEFAULT 0,
  last_activated_at TEXT,                  -- ISO 8601 timestamp
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT,                           -- JSON string
  UNIQUE(source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_weighted_edges_source
  ON weighted_edges(source_id, source_type);

CREATE INDEX IF NOT EXISTS idx_weighted_edges_target
  ON weighted_edges(target_id, target_type);

CREATE INDEX IF NOT EXISTS idx_weighted_edges_type
  ON weighted_edges(edge_type);

CREATE INDEX IF NOT EXISTS idx_weighted_edges_weight
  ON weighted_edges(weight DESC);

CREATE INDEX IF NOT EXISTS idx_weighted_edges_activation
  ON weighted_edges(activation_count DESC);
`;
