/**
 * SQLite schema for the memory_embeddings table.
 *
 * Stores vector embeddings for memory chunks (facts, episodes, concepts)
 * enabling direct cosine similarity search without anchor intermediaries.
 *
 * This complements the anchor-based vector search by allowing
 * retrieval of memory nodes that may not yet be connected to anchors.
 */

export const CREATE_MEMORY_EMBEDDING_TABLES = `
-- Memory embeddings: vector representations of memory chunks for direct search
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK(node_type IN ('fact', 'episode', 'concept')),
  embedding BLOB NOT NULL,                    -- Float32Array serialized as binary blob
  embedding_dim INTEGER NOT NULL,             -- Dimensionality of the embedding vector
  content_hash TEXT NOT NULL,                 -- Hash of the source content (for staleness detection)
  model TEXT NOT NULL DEFAULT 'unknown',      -- Embedding model identifier
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_id, node_type)
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_node
  ON memory_embeddings(node_id, node_type);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_type
  ON memory_embeddings(node_type);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model
  ON memory_embeddings(model);
`;
