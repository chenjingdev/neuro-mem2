/**
 * Trace Types — defines TraceEvent and related types for instrumenting
 * the recall pipeline (vector search → graph traversal → merge → format → inject).
 *
 * Each pipeline stage emits a TraceEvent with:
 *   - stage: which step of the pipeline
 *   - status: lifecycle state (start / complete / error / skipped)
 *   - input: what was fed into the stage
 *   - output: what the stage produced
 *   - durationMs: wall-clock time for the stage
 *   - timestamp: ISO 8601 event time
 *
 * These events are collected by TraceCollector and streamed to the
 * Visual Debug Chat App as SSE `event:trace` messages.
 */

// ─── Pipeline Stage Names ──────────────────────────────────

/**
 * All recognised recall pipeline stages.
 *
 * The stages execute in this order:
 *   1. vector_search  — embedding-based anchor similarity search
 *   2. graph_traversal — entity extraction → seed discovery → BFS
 *   3. merge          — normalize, deduplicate, rank from both paths
 *   4. reinforce      — Hebbian edge reinforcement (optional)
 *   5. format         — convert merged items into context string
 *   6. inject         — attach context to the LLM prompt
 */
export type RecallPipelineStage =
  | 'vector_search'
  | 'graph_traversal'
  | 'merge'
  | 'reinforce'
  | 'format'
  | 'inject';

/**
 * Top-level pipeline stages (beyond recall).
 */
export type TopLevelStage =
  | 'recall'       // the entire recall pipeline
  | 'llm'          // LLM streaming
  | 'ingestion'    // memory ingestion (future)
  | 'pipeline'     // full end-to-end pipeline
  | 'episode_extraction'   // batch episode extraction (session end)
  | 'concept_extraction'   // batch concept extraction (session end)
  | 'batch_extraction';    // overall batch extraction wrapper

/** All valid stage names. */
export type TraceStage = RecallPipelineStage | TopLevelStage;

// ─── Stage Status ──────────────────────────────────────────

export type TraceStatus = 'start' | 'complete' | 'error' | 'skipped';

// ─── TraceEvent ────────────────────────────────────────────

/**
 * A single pipeline trace event capturing one stage's lifecycle.
 *
 * For each stage you get a pair: {status:'start'} → {status:'complete'|'error'}.
 * Skipped stages emit a single {status:'skipped'} event.
 */
export interface TraceEvent {
  /** Unique trace event ID (monotonic counter within a TraceCollector). */
  id: number;

  /** Which pipeline stage this event belongs to. */
  stage: TraceStage;

  /** Lifecycle status. */
  status: TraceStatus;

  /** What was fed into this stage (only on 'start'). */
  input?: unknown;

  /** What this stage produced (only on 'complete'). */
  output?: unknown;

  /** Wall-clock duration in ms (only on 'complete' or 'error'). */
  durationMs?: number;

  /** Error message (only on 'error'). */
  error?: string;

  /** Reason for skipping (only on 'skipped'). */
  skipReason?: string;

  /** ISO 8601 timestamp. */
  timestamp: string;

  /** Optional parent stage for nesting (e.g. vector_search → recall). */
  parentStage?: TraceStage;
}

// ─── Stage-specific input/output payloads ──────────────────

/** vector_search stage input */
export interface VectorSearchTraceInput {
  queryText: string;
  topK?: number;
  similarityThreshold?: number;
}

/** vector_search stage output */
export interface VectorSearchTraceOutput {
  matchedAnchors: Array<{ anchorId: string; label: string; similarity: number }>;
  itemCount: number;
  timedOut: boolean;
}

/** graph_traversal stage input */
export interface GraphTraversalTraceInput {
  queryText: string;
  maxHops?: number;
  minEdgeWeight?: number;
}

/** graph_traversal stage output */
export interface GraphTraversalTraceOutput {
  extractedEntities: string[];
  seedCount: number;
  itemCount: number;
  timedOut: boolean;
}

/** merge stage input */
export interface MergeTraceInput {
  vectorItemCount: number;
  graphItemCount: number;
}

/** merge stage output */
export interface MergeTraceOutput {
  mergedItemCount: number;
  overlapCount: number;
  filteredCount: number;
  mergeTimeMs: number;
}

/** reinforce stage input */
export interface ReinforceTraceInput {
  anchorIds: string[];
  resultCount: number;
  learningRate: number;
}

/** reinforce stage output */
export interface ReinforceTraceOutput {
  edgesReinforced: number;
}

/** format stage input */
export interface FormatTraceInput {
  itemCount: number;
  format?: string;
  maxChars?: number;
}

/** format stage output */
export interface FormatTraceOutput {
  charCount: number;
  truncated: boolean;
  itemsIncluded: number;
}

/** inject stage input */
export interface InjectTraceInput {
  hasMemoryContext: boolean;
  contextCharCount: number;
  systemPromptLength: number;
}

/** inject stage output */
export interface InjectTraceOutput {
  finalPromptLength: number;
}

// ─── Ingestion stage-specific payloads ──────────────────────

/** ingestion stage input (on 'start') */
export interface IngestionTraceInput {
  userMessage: string;
  assistantResponseLength: number;
  mode: 'handler' | 'factExtractor';
}

/** ingestion stage output (on 'complete') */
export interface IngestionTraceOutput {
  /** Number of facts extracted */
  factCount: number;
  /** Extracted facts with full detail */
  facts: Array<{
    id?: string;
    content: string;
    category?: string;
    confidence?: number;
    entities?: string[];
    subject?: string;
    predicate?: string;
    object?: string;
  }>;
  /** Raw LLM response JSON (for debugging) */
  rawResponse?: string;
}

/** ingestion stage error output */
export interface IngestionTraceError {
  error: string;
  rawResponse?: string;
}

// ─── Batch extraction stage-specific payloads ──────────────

/** batch_extraction stage input (on 'start') */
export interface BatchExtractionTraceInput {
  sessionId: string;
  conversationId: string;
  reason: string;
  jobTypes: string[];
}

/** batch_extraction stage output (on 'complete') */
export interface BatchExtractionTraceOutput {
  jobCount: number;
  jobs: Array<{
    jobType: string;
    status: string;
    durationMs?: number;
    result?: Record<string, unknown>;
    error?: string;
  }>;
  totalDurationMs: number;
}

/** episode_extraction stage input (on 'start') */
export interface EpisodeExtractionTraceInput {
  conversationId: string;
  sessionId: string;
  jobId: string;
}

/** episode_extraction stage output (on 'complete') */
export interface EpisodeExtractionTraceOutput {
  episodeCount: number;
  extractionTimeMs: number;
  episodeTypes?: Record<string, number>;
  previousEpisodesDeleted?: number;
}

/** concept_extraction stage input (on 'start') */
export interface ConceptExtractionTraceInput {
  conversationId: string;
  sessionId: string;
  jobId: string;
}

/** concept_extraction stage output (on 'complete') */
export interface ConceptExtractionTraceOutput {
  newConceptCount: number;
  updatedConceptCount: number;
  edgeCount: number;
  factConceptEdgeCount: number;
  extractionTimeMs: number;
  conceptCategories?: Record<string, number>;
}

// ─── Callback / Listener types ─────────────────────────────

/**
 * Callback invoked for every TraceEvent.
 * Can be sync or async — async errors are caught by the collector.
 */
export type TraceEventListener = (event: TraceEvent) => void | Promise<void>;
