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
  type MemoryNodeDescriptor,
  type ScoringWeights,
  type EdgeScorerConfig,
  type ScoreBreakdown,
  type CoOccurrenceData,
} from './edge-scorer.js';

export {
  AnchorDecay,
  computeTimeDecay,
  computeUsageDecay,
  computeCombinedDecayFactor,
  computeEdgeDecay,
  computeAnchorEffectiveWeight,
  DEFAULT_DECAY_CONFIG,
  type AnchorDecayConfig,
  type AnchorDecayInput,
  type DecayEdgeInput,
  type DecayComputeResult,
  type BatchDecaySummary,
} from './anchor-decay.js';

export {
  AnchorScorer,
  inferEdgeType,
  DEFAULT_ANCHOR_SCORER_CONFIG,
  type AnchorScorerConfig,
  type AnchorScoringResult,
  type ReinforcementResult,
  type BatchScoringResult,
} from './anchor-scorer.js';

export {
  HebbianWeightUpdater,
  computeActivationLevel,
  computeHebbianDelta as computeHebbianDeltaFromActivation,
  makeEdgeKey,
  DEFAULT_HEBBIAN_CONFIG,
  type HebbianUpdaterConfig,
  type NodeActivation,
  type HebbianUpdateInput,
  type HebbianUpdateResult,
  type CoRetrievalBatchInput,
  type CoRetrievalBatchResult,
  type ReinforceDecayInput,
  type ReinforceDecayResult,
} from './hebbian-updater.js';

export {
  // Policy interface & types
  type DecayPolicy,
  type DecayableState,
  type DecayPolicyResult,
  type DecayableRepository,
  type DecayableItem,
  type EngineDecayItem,
  type EngineDecaySummary,
  // Config types
  type TimeBasedDecayConfig,
  type AccessBasedDecayConfig,
  type CombinedDecayConfig,
  // Default configs
  DEFAULT_TIME_DECAY_CONFIG,
  DEFAULT_ACCESS_DECAY_CONFIG,
  DEFAULT_COMBINED_DECAY_CONFIG,
  // Policy implementations
  TimeBasedDecayPolicy,
  AccessBasedDecayPolicy,
  CombinedDecayPolicy,
  NoDecayPolicy,
  // Engine
  DecayPolicyEngine,
  // Adapters
  WeightedEdgeDecayAdapter,
  AnchorDecayAdapter,
  // Factory functions
  createTimeBasedPolicy,
  createAccessBasedPolicy,
  createCombinedPolicy,
  createNoDecayPolicy,
} from './decay-policy.js';
