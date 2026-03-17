export type {
  Role,
  RawMessage,
  RawConversation,
  IngestConversationInput,
  IngestMessageInput,
  AppendMessageInput,
} from './conversation.js';

export type {
  Fact,
  FactCategory,
  ExtractedFact,
  CreateFactInput,
  UpdateFactInput,
  FactExtractionInput,
} from './fact.js';

export { FACT_CATEGORIES } from './fact.js';

export type {
  Episode,
  EpisodeType,
  ExtractedEpisodeRaw,
  EpisodeExtractionInput,
  EpisodeExtractionResult,
} from './episode.js';

export { EPISODE_TYPES } from './episode.js';

export type {
  Session,
  SessionStatus,
  SessionEndReason,
  BatchJob,
  BatchJobType,
  BatchJobStatus,
  CreateSessionInput,
  EndSessionInput,
} from './session.js';

export type {
  Concept,
  CreateConceptInput,
  UpdateConceptInput,
} from './concept.js';

export type { ConceptCategory } from './concept.js';

export type {
  MemoryEdge,
  MemoryNodeType,
  EdgeType,
  CreateEdgeInput,
} from './memory-edge.js';

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
} from './anchor.js';

export { ANCHOR_TYPES } from './anchor.js';

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
} from './weighted-edge.js';

export { WEIGHTED_EDGE_TYPES } from './weighted-edge.js';

export type {
  CoRetrievalEvent,
  RecordCoRetrievalInput,
  CoRetrievalPair,
  CoRetrievalPairRef,
  CoRetrievalPairFilter,
  CoRetrievalStats,
} from './co-retrieval.js';
