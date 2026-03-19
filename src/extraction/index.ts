export { FactExtractor, type FactExtractionResult } from './fact-extractor.js';
export { buildFactExtractionRequest, getFactExtractionSystemPrompt } from './fact-prompt.js';
export { parseFactResponse, type ParseResult } from './fact-parser.js';
export {
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
} from './llm-provider.js';
export {
  buildConceptExtractionRequest,
  getConceptExtractionSystemPrompt,
  type ConceptExtractionInput,
  type ExtractedConcept,
  type ConceptCategory,
  CONCEPT_CATEGORIES,
} from './concept-prompt.js';
export {
  ConceptExtractor,
  type ConceptExtractionResult,
  type ConceptExtractorOptions,
} from './concept-extractor.js';
export {
  EpisodeExtractor,
  type EpisodeExtractorOptions,
} from './episode-extractor.js';
export { buildEpisodeExtractionRequest, getEpisodeExtractionSystemPrompt } from './episode-prompt.js';
export { parseEpisodeResponse, type EpisodeParseResult } from './episode-parser.js';

// Summary generation (Level 0 frontmatter + Level 1 summary)
export {
  buildSummaryGenerationRequest,
  buildSingleFactSummaryRequest,
  getSummaryGenerationSystemPrompt,
  type SummaryGenerationInput,
  type GeneratedSummary,
} from './summary-prompt.js';
export {
  parseSummaryResponse,
  buildSummaryMap,
  type SummaryParseResult,
} from './summary-parser.js';

// Frontmatter generation (structured Level 0 frontmatter with keywords + domain)
export {
  buildFrontmatterRequest,
  buildBatchFrontmatterRequest,
  getFrontmatterSystemPrompt,
  type FactFrontmatter,
  type FrontmatterInput,
  type FrontmatterResult,
} from './frontmatter-prompt.js';
export {
  parseFrontmatterResponse,
  parseBatchFrontmatterResponse,
  generateFallbackFrontmatter,
  type FrontmatterParseResult,
  type BatchFrontmatterParseResult,
} from './frontmatter-parser.js';

// OpenAI LLM provider (streaming-capable)
export { OpenAILLMProvider, type OpenAIProviderConfig } from './openai-llm-provider.js';
export {
  OpenAICodexLLMProvider,
  type OpenAICodexProviderConfig,
} from './openai-codex-llm-provider.js';

// Anthropic LLM provider (streaming-capable)
export { AnthropicLLMProvider, type AnthropicProviderConfig } from './anthropic-llm-provider.js';

// Anchor judgment prompt (LLM-based anchor binding decisions)
export {
  buildAnchorJudgmentRequest,
  getAnchorJudgmentSystemPrompt,
  type AnchorJudgmentInput,
  type AnchorJudgmentResponse,
  type AnchorDecision,
  type AnchorConnectDecision,
  type AnchorCreateDecision,
} from './anchor-judgment-prompt.js';

// Unified MemoryNode extraction (single LLM call per turn)
export {
  MemoryNodeExtractor,
  type MemoryNodeExtractionResult,
} from './memory-node-extractor.js';
export {
  buildMemoryNodeExtractionRequest,
  getMemoryNodeExtractionSystemPrompt,
  type MemoryNodeExtractionInput,
} from './memory-node-prompt.js';
export {
  parseMemoryNodeResponse,
  type MemoryNodeParseResult,
} from './memory-node-parser.js';

// Hub candidate extraction (entity → hub matching pipeline)
export {
  HubCandidateExtractor,
  DEFAULT_HUB_CANDIDATE_CONFIG,
  normalizeEntityLabel,
  looksLikeNamedEntity,
  detectHubType,
  computeNewHubConfidence,
  type HubCandidateExtractorConfig,
  type HubCandidate,
  type HubCandidateExtractionResult,
  type HubCandidateStats,
} from './hub-candidate-extractor.js';

// Identity extraction
export { IdentityExtractor } from './identity-extractor.js';
export { PersonaProposer } from './persona-proposer.js';
