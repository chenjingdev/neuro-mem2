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

// ── Local embedding provider (all-MiniLM-L6-v2 via @huggingface/transformers) ──
export {
  LocalEmbeddingProvider,
  resetLocalEmbeddingPipeline,
} from './local-embedding-provider.js';

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

// ── Unified retriever (single pipeline: local embedding → cosine similarity → top-K anchors) ──
export {
  UnifiedRetriever,
  DEFAULT_UNIFIED_RETRIEVER_CONFIG,
} from './unified-retriever.js';

export type {
  UnifiedRetrieverConfig,
  UnifiedRecallQuery,
  UnifiedRecallResult,
  UnifiedRecallDiagnostics,
  UnifiedTraceHook,
  UnifiedTraceEvent,
  PipelineStage,
} from './unified-retriever.js';

// ── Re-ranking context builder (anchor → fact context for LLM re-ranking) ──
export {
  RerankingContextBuilder,
  DEFAULT_RERANKING_CONTEXT_CONFIG,
} from './reranking-context-builder.js';

export type {
  RerankingContextConfig,
  LinkedFact,
  AnchorContext,
  RerankingContext,
  RerankingContextStats,
} from './reranking-context-builder.js';

// ── BFS Expander (weighted-edge BFS from re-judged anchors) ──
export {
  BFSExpander,
  DEFAULT_BFS_EXPANDER_CONFIG,
} from './bfs-expander.js';

export type {
  BFSExpanderConfig,
  BFSExpansionResult,
  BFSExpansionStats,
} from './bfs-expander.js';

// ── Graph+Content ReRanker (graph traversal + Level 0/Level 1 content signals) ──
export {
  ReRanker,
  DEFAULT_RERANKER_CONFIG as DEFAULT_GRAPH_RERANKER_CONFIG,
} from './reranker.js';

export type {
  ReRankerConfig,
  ReRankResult,
  ReRankStats,
} from './reranker.js';

// ── LLM Reranker (cortical re-evaluation of coarse retrieval results) ──
export {
  LLMReranker,
  DEFAULT_RERANKER_CONFIG,
} from './llm-reranker.js';

export type {
  LLMRerankerConfig,
  LLMRerankResult,
  LLMRerankStats,
} from './llm-reranker.js';

// ── Memory context formatter (UnifiedRecallResult → LLM prompt context) ──
export {
  MemoryContextFormatter,
  DEFAULT_MEMORY_CONTEXT_CONFIG,
} from './memory-context-formatter.js';

export type {
  MemoryContextFormatterConfig,
  MemoryContextFormat,
  DetailLevel,
  FormattedMemoryContext,
} from './memory-context-formatter.js';

// ── Shared types ──
export type {
  ScoredMemoryItem,
  MergedMemoryItem,
  MergerConfig,
  MergeResult,
  MergeStats,
  RetrievalSource,
} from './types.js';
