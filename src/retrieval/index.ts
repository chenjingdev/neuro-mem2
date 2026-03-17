/**
 * Retrieval module — dual-path (vector + graph) retrieval for memory recall.
 */

// ── Dual-path orchestrator (parallel vector + graph) ──
export {
  DualPathRetriever,
  DEFAULT_DUAL_PATH_CONFIG,
} from './dual-path-retriever.js';

export type {
  DualPathRetrieverConfig,
  RecallQuery,
  RecallResult,
  RecallDiagnostics,
  RecallTraceHook,
  RecallTraceEvent,
} from './dual-path-retriever.js';

// ── Graph traversal from query (entity extraction + seed discovery + BFS) ──
export {
  QueryGraphTraverser,
  extractEntitiesFromQuery,
  findSeedNodes,
  traverseGraph,
  resolveNodes,
} from './graph-traversal.js';

export type {
  GraphNode,
  TraversalResult,
  GraphTraversalOptions,
  ExtractedEntities,
  GraphTraversalResult as QueryGraphTraversalResult,
} from './graph-traversal.js';

// ── Graph traversal from anchors (weighted edges) ──
export {
  GraphTraverser,
  type GraphTraversalInput,
  type GraphTraversalResult,
  type ScoredFact,
  type ScoredEpisode,
  type ScoredConcept,
} from './graph-traverser.js';

// ── Vector search ──
export {
  VectorSearcher,
  cosineSimilarityVec,
  bufferToFloat32Array,
  DEFAULT_VECTOR_SEARCH_CONFIG,
  type VectorSearchConfig,
  type VectorSearchResult,
  type AnchorMatch,
  type VectorSearchStats,
} from './vector-searcher.js';

// ── Embedding provider ──
export {
  MockEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from './embedding-provider.js';

// ── Result merger ──
export {
  ResultMerger,
  DEFAULT_MERGER_CONFIG,
  minMaxNormalize,
  clamp01,
  roundScore,
} from './result-merger.js';

// ── Co-retrieval tracker ──
export {
  CoRetrievalTracker,
  DEFAULT_CO_RETRIEVAL_TRACKER_CONFIG,
} from './co-retrieval-tracker.js';

export type {
  CoRetrievalTrackerConfig,
  TrackResult,
} from './co-retrieval-tracker.js';

// ── Memory chunk search (direct vector search on facts/episodes/concepts) ──
export {
  MemoryChunkSearcher,
  DEFAULT_CHUNK_SEARCH_CONFIG,
  type ChunkSearchConfig,
  type ChunkSearchResult,
  type ChunkSearchStats,
} from './memory-chunk-searcher.js';

// ── Shared types ──
export type {
  ScoredMemoryItem,
  MergedMemoryItem,
  MergerConfig,
  MergeResult,
  MergeStats,
  RetrievalSource,
} from './types.js';
