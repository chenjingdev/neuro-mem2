export { IngestService, type IngestServiceOptions } from './ingest.js';
export { SessionManager, type SessionManagerOptions } from './session-manager.js';
export { BatchPipeline, type BatchPipelineOptions, type BatchExtractor } from './batch-pipeline.js';
export { TurnExtractionPipeline, type TurnExtractionPipelineOptions } from './turn-extraction-pipeline.js';
export {
  FactIngestionPipeline,
  type FactIngestionPipelineOptions,
  type FactIngestionResult,
} from './fact-ingestion-pipeline.js';
export { EpisodeBatchExtractor } from './episode-batch-extractor.js';
export { ConceptBatchExtractor, type ConceptBatchResult } from './concept-batch-extractor.js';
export {
  DecayScheduler,
  type DecaySchedulerOptions,
  type DecayCompletedEvent,
  type DecayErrorEvent,
  type DecayEvent,
  type DecayCycleResult,
} from './decay-scheduler.js';
export {
  GraphPersistence,
  type GraphPersistenceConfig,
  type PersistScoredEdgeInput,
  type PersistScoredResult,
  type PersistWeightedInput,
  type CoActivationResult,
  type GraphDecayResult,
  type WeightedNeighbor,
} from './graph-persistence.js';
export {
  AnchorCandidateFinder,
  DEFAULT_CANDIDATE_FINDER_CONFIG,
  type AnchorCandidateFinderConfig,
  type AnchorCandidate,
  type AnchorCandidateResult,
} from './anchor-candidate-finder.js';
export {
  AnchorLinker,
  DEFAULT_ANCHOR_LINKER_CONFIG,
  buildAnchorLinkPrompt,
  parseAnchorDecision,
  type AnchorLinkerConfig,
  type AnchorLinkResult,
  type LLMAnchorDecision,
  type LLMAnchorConnect,
  type LLMAnchorCreate,
} from './anchor-linker.js';
export {
  AnchorJudgment,
  DEFAULT_JUDGMENT_CONFIG,
  parseAnchorJudgmentResponse,
  type AnchorJudgmentConfig,
  type AnchorJudgmentResult,
} from './anchor-judgment.js';
export {
  EntityHubLinker,
  DEFAULT_ENTITY_HUB_LINKER_CONFIG,
  type EntityHubLinkerConfig,
  type EntityResolution,
  type NodeLinkResult,
  type EntityHubLinkResult,
  type EntityHubLinkStats,
} from './entity-hub-linker.js';
export {
  HubMatcher,
  DEFAULT_HUB_MATCHER_CONFIG,
  normalizeFtsRanks,
  type HubMatcherConfig,
  type HubMatch,
  type HubMatchResult,
  type HubMatchStats,
} from './hub-matcher.js';

// Identity services
export { IdentityEvolver } from './identity-evolver.js';
export { ContextComposer } from './context-composer.js';
