/**
 * nero-mem2 — Local Memory Infrastructure for AI Conversations
 *
 * Transforms AI conversations into structured memories with
 * dual-path (vector + graph) retrieval for context reconstruction.
 */

export { createDatabase, type DatabaseOptions } from './db/index.js';
export { ConversationRepository } from './db/index.js';
export { FactRepository } from './db/index.js';
export { EpisodeRepository } from './db/index.js';
export { ConceptRepository } from './db/index.js';
export { EdgeRepository } from './db/index.js';
export { AnchorRepository } from './db/index.js';
export { WeightedEdgeRepository } from './db/index.js';
export { SessionRepository } from './db/index.js';
export { SCHEMA_VERSION } from './db/index.js';
export { IngestService, SessionManager, BatchPipeline, TurnExtractionPipeline, DecayScheduler, EpisodeBatchExtractor, ConceptBatchExtractor } from './services/index.js';
export type { SessionManagerOptions, BatchPipelineOptions, BatchExtractor, TurnExtractionPipelineOptions, IngestServiceOptions, DecaySchedulerOptions, DecayCompletedEvent, DecayErrorEvent, DecayEvent, DecayCycleResult, ConceptBatchResult } from './services/index.js';
export { EventBus } from './events/index.js';
export type {
  MemoryEvent,
  TurnCompletedEvent,
  FactsExtractedEvent,
  ExtractionErrorEvent,
  SessionEndedEvent,
  BatchJobCreatedEvent,
  BatchJobCompletedEvent,
  BatchJobFailedEvent,
  EventHandler,
} from './events/index.js';
export type {
  Role,
  RawMessage,
  RawConversation,
  IngestConversationInput,
  IngestMessageInput,
  AppendMessageInput,
} from './models/index.js';

// Memory extraction
export type {
  Fact,
  FactCategory,
  ExtractedFact,
  CreateFactInput,
  UpdateFactInput,
  FactExtractionInput,
} from './models/index.js';
export { FACT_CATEGORIES } from './models/index.js';
export {
  FactExtractor,
  type FactExtractionResult,
  buildFactExtractionRequest,
  parseFactResponse,
  type ParseResult,
  type LLMProvider,
  type LLMCompletionRequest,
  type LLMCompletionResponse,
  type LLMStreamRequest,
  type LLMStreamEvent,
  type LLMStreamDeltaEvent,
  type LLMStreamFinishEvent,
  type LLMStreamErrorEvent,
  type LLMChatMessage,
  MockLLMProvider,
} from './extraction/index.js';

// Episode extraction
export type {
  Episode,
  EpisodeType,
  ExtractedEpisodeRaw,
  EpisodeExtractionInput,
  EpisodeExtractionResult,
} from './models/index.js';
export { EPISODE_TYPES } from './models/index.js';
export {
  EpisodeExtractor,
  type EpisodeExtractorOptions,
  buildEpisodeExtractionRequest,
  parseEpisodeResponse,
  type EpisodeParseResult,
} from './extraction/index.js';

// Concept extraction
export type {
  Concept,
  CreateConceptInput,
  UpdateConceptInput,
} from './models/index.js';
export type { ConceptCategory } from './models/index.js';
export {
  ConceptExtractor,
  type ConceptExtractionResult,
  type ConceptExtractorOptions,
  buildConceptExtractionRequest,
  getConceptExtractionSystemPrompt,
  type ConceptExtractionInput,
  type ExtractedConcept,
  CONCEPT_CATEGORIES,
} from './extraction/index.js';

// Memory graph edges
export type {
  MemoryEdge,
  MemoryNodeType,
  EdgeType,
  CreateEdgeInput,
} from './models/index.js';

// Anchor nodes & Hebbian weight management
export type {
  Anchor,
  AnchorType,
  CreateAnchorInput,
  UpdateAnchorInput,
  AnchorRef,
  UpsertEdgeInput,
  WeightMergeStrategy,
  DecayOptions,
  DecayResult,
  EdgeEndpoints,
  BulkWeightUpdate,
  EdgeQueryFilter,
} from './models/index.js';
export { ANCHOR_TYPES } from './models/index.js';

// Weighted edges for retrieval graph
export type {
  WeightedEdge,
  WeightedNodeType,
  WeightedEdgeType,
  CreateWeightedEdgeInput,
  ReinforceEdgeInput,
  BatchCoActivationInput,
  ReinforceResult,
  WeightedEdgeFilter,
  WeightedEdgeRef,
} from './models/index.js';
export { WEIGHTED_EDGE_TYPES } from './models/index.js';

// Scoring & weighting
export {
  EdgeScorer,
  computeTemporalProximity,
  computeSemanticSimilarity,
  computeCoOccurrence,
  computeCoOccurrenceFromNodes,
  computeEntityOverlap,
  cosineSimilarity,
  jaccardSimilarity,
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_SCORER_CONFIG,
} from './scoring/index.js';
export type {
  MemoryNodeDescriptor,
  ScoringWeights,
  EdgeScorerConfig,
  ScoreBreakdown,
  CoOccurrenceData,
} from './scoring/index.js';

// Anchor decay
export {
  AnchorDecay,
  computeTimeDecay,
  computeUsageDecay,
  computeCombinedDecayFactor,
  computeEdgeDecay,
  DEFAULT_DECAY_CONFIG,
} from './scoring/index.js';
export type {
  AnchorDecayConfig,
  DecayEdgeInput,
  DecayComputeResult,
  BatchDecaySummary,
} from './scoring/index.js';

// Retrieval — graph traversal from query (entity extraction + seed discovery)
export {
  QueryGraphTraverser,
  extractEntitiesFromQuery,
  findSeedNodes,
  traverseGraph,
  resolveNodes,
} from './retrieval/index.js';
export type {
  GraphNode,
  TraversalResult,
  GraphTraversalOptions,
  ExtractedEntities,
  QueryGraphTraversalResult,
} from './retrieval/index.js';

// Retrieval — graph traversal from anchors (weighted edges)
export {
  GraphTraverser,
} from './retrieval/index.js';
export type {
  GraphTraversalInput,
  GraphTraversalResult,
  ScoredFact,
  ScoredEpisode,
  ScoredConcept,
} from './retrieval/index.js';

// Retrieval — vector search
export {
  VectorSearcher,
  cosineSimilarityVec,
  bufferToFloat32Array,
  DEFAULT_VECTOR_SEARCH_CONFIG,
  MockEmbeddingProvider,
} from './retrieval/index.js';
export type {
  VectorSearchConfig,
  VectorSearchResult,
  AnchorMatch,
  VectorSearchStats,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from './retrieval/index.js';

// Retrieval — dual-path orchestrator
export {
  DualPathRetriever,
  DEFAULT_DUAL_PATH_CONFIG,
} from './retrieval/index.js';
export type {
  DualPathRetrieverConfig,
  RecallQuery,
  RecallResult,
  RecallDiagnostics,
} from './retrieval/index.js';

// Retrieval — memory chunk search (direct vector search on memory chunks)
export {
  MemoryChunkSearcher,
  DEFAULT_CHUNK_SEARCH_CONFIG,
} from './retrieval/index.js';
export type {
  ChunkSearchConfig,
  ChunkSearchResult,
  ChunkSearchStats,
} from './retrieval/index.js';

// Memory embedding repository
export { MemoryEmbeddingRepository } from './db/index.js';
export type { MemoryEmbedding, StoreEmbeddingInput } from './db/index.js';

// Retrieval — dual-path result merger
export {
  ResultMerger,
  DEFAULT_MERGER_CONFIG,
  minMaxNormalize,
  clamp01,
  roundScore,
} from './retrieval/index.js';
export type {
  ScoredMemoryItem,
  MergedMemoryItem,
  MergerConfig,
  MergeResult,
  MergeStats,
  RetrievalSource,
} from './retrieval/index.js';

// Identity system
export { createIdentityRouter } from './api/identity-router.js';
export type { IdentityRouterDeps } from './api/identity-router.js';
export type {
  PersonalityAxis,
  IdentityEvolutionEntry,
  HumanIdentity,
  HumanIdentityTrait,
  HumanIdentityCoreValue,
  HumanIdentityCommunicationStyle,
  HumanIdentityExpertise,
  HumanIdentityFocus,
  CreateHumanIdentityInput,
  UpdateHumanIdentityInput,
  AgentIdentity,
  AgentPersona,
  AgentPersonalityEntry,
  AgentPrinciple,
  AgentBehavioralTendency,
  AgentVoice,
  AgentSelfNarrative,
  IdentityEvolutionConfig,
  CreateAgentIdentityInput,
  UpdateAgentIdentityInput,
  PersonaCandidate,
} from './models/identity.js';
export { DEFAULT_EVOLUTION_CONFIG } from './models/identity.js';
export { HumanIdentityRepository } from './db/index.js';
export { AgentIdentityRepository } from './db/index.js';
export { IdentityExtractor } from './extraction/index.js';
export { PersonaProposer } from './extraction/index.js';
export { IdentityEvolver } from './services/index.js';
export { ContextComposer } from './services/index.js';

// REST API
export { createRouter, startServer, stopServer, DEFAULT_SERVER_CONFIG } from './api/index.js';
export type { RouterDependencies, ServerConfig } from './api/index.js';
export type {
  IngestConversationRequest,
  IngestMessageSchema,
  AppendMessageRequest,
  IngestResponse,
  AppendMessageResponse,
  RecallRequest,
  RecallResponse,
  RecallItemSchema,
  ErrorResponse,
} from './api/index.js';
export {
  validateIngestConversation,
  validateAppendMessage,
  validateRecallRequest,
} from './api/index.js';

// Context injection for LLM API requests
export {
  ContextFormatter,
  DEFAULT_FORMATTER_CONFIG,
  ContextInjector,
  DEFAULT_INJECTOR_CONFIG,
} from './api/middleware/index.js';
export type {
  ContextFormat,
  ContextFormatterConfig,
  FormattedContext,
  InjectionStrategy,
  ContextInjectorConfig,
  ChatMessage,
  ContentPart,
  OpenAIChatRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  InjectionResult,
} from './api/middleware/index.js';

// Session & Batch
export type {
  Session,
  SessionStatus,
  SessionEndReason,
  BatchJob,
  BatchJobType,
  BatchJobStatus,
  CreateSessionInput,
  EndSessionInput,
} from './models/index.js';

// Proxy — HTTP/HTTPS proxy server for LLM API interception
export {
  ProxyServer,
  EndpointMatcher,
  matchHostPattern,
  matchChatPath,
  RequestInterceptor,
  readBody,
  parseTargetUrl,
  detectStreaming,
  tryParseJson,
  forwardRequest,
  forwardStreaming,
  BUILTIN_LLM_ENDPOINTS,
  DEFAULT_PROXY_SERVER_CONFIG,
  resolveProxyConfig,
  loadConfigFile,
  loadEnvConfig,
  detectProvider,
  validateProxyConfig,
  generateSampleConfig,
  DEFAULT_PROXY_CONFIG,
  parseRequest,
  detectApiFormat,
  extractOpenAIContent,
  extractLatestUserQuery,
  DEFAULT_PARSER_CONFIG,
  injectMemoryContext,
  formatMemories,
  buildContextBlock,
  extractQueryFromBody,
  MemoryRetrievalBridge,
  DEFAULT_BRIDGE_CONFIG,
} from './proxy/index.js';
export type {
  ProxyServerConfig,
  ProxyEvents,
  ProxyStats,
  InterceptedRequest,
  ForwardResult,
  RequestMiddleware,
  ResponseMiddleware,
  LLMEndpoint,
  ProxyConfig as ProxyResolvedConfig,
  ProxyConfigInput,
  LogLevel,
  TargetProvider,
  ConfigFileContent,
  ApiFormat,
  ParsedMessage,
  ParsedRequest,
  RequestParserConfig,
  InjectionOptions,
  MemoryBridgeConfig,
  MemoryContextBlock,
  ContextItem,
  MemoryBridgeResult,
} from './proxy/index.js';
export type { InjectionResult as ProxyInjectionResult } from './proxy/index.js';
