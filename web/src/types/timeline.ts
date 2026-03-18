/**
 * Timeline Types — Type definitions for the pipeline timeline visualization.
 *
 * These types drive the TimelinePanel component and useTimeline hook,
 * providing structured representations of pipeline stages and their states.
 */

// ─── Pipeline Stage Names ──────────────────────────────────

/**
 * All recognized recall pipeline sub-stages.
 * Executed in order under the 'recall' parent stage.
 */
export type RecallSubStage =
  | 'vector_search'
  | 'graph_traversal'
  | 'merge'
  | 'reinforce'
  | 'format'
  | 'inject';

/**
 * Top-level pipeline stages (not nested under another stage).
 */
export type TopLevelStage =
  | 'pipeline'
  | 'recall'
  | 'llm'
  | 'ingestion'
  | 'session_end'
  | 'batch_extraction';

/**
 * All valid stage names used in the timeline.
 */
export type TimelineStage = RecallSubStage | TopLevelStage;

// ─── MemoryNode Depth Layers ────────────────────────────────

/**
 * MemoryNode 4-layer progressive depth classification.
 *
 * Maps to the MemoryNode data model:
 *   flash (L0) — anchor/embedding/keywords: fastest retrieval, lightest data
 *   short (L1) — JSON metadata: structured entities, categories, SPO triples
 *   mid   (L2) — summary: human-readable text summary
 *   long  (L3) — source references: links back to original conversation turns
 *
 * Pipeline stages are tagged with the depth layer they primarily operate on,
 * enabling visual grouping and color-coding in the timeline UI.
 */
export type DepthLayer = 'flash' | 'short' | 'mid' | 'long';

/** Human-readable labels for depth layers. */
export const DEPTH_LAYER_LABELS: Readonly<Record<DepthLayer, string>> = {
  flash: 'L0 Flash',
  short: 'L1 Short',
  mid: 'L2 Mid',
  long: 'L3 Long',
};

/** Colors for each depth layer (gradient from hot → cool). */
export const DEPTH_LAYER_COLORS: Readonly<Record<DepthLayer, string>> = {
  flash: '#ff6b6b',   // Hot red — ephemeral, fastest
  short: '#ffa502',   // Orange — structured metadata
  mid: '#2ed573',     // Green — summary context
  long: '#1e90ff',    // Blue — deep historical
};

/** Background tint colors (low opacity) for each depth layer. */
export const DEPTH_LAYER_BG: Readonly<Record<DepthLayer, string>> = {
  flash: 'rgba(255, 107, 107, 0.08)',
  short: 'rgba(255, 165, 2, 0.08)',
  mid: 'rgba(46, 213, 115, 0.08)',
  long: 'rgba(30, 144, 255, 0.08)',
};

/** Border-left accent colors for depth layer indicators. */
export const DEPTH_LAYER_BORDER: Readonly<Record<DepthLayer, string>> = {
  flash: 'rgba(255, 107, 107, 0.5)',
  short: 'rgba(255, 165, 2, 0.5)',
  mid: 'rgba(46, 213, 115, 0.5)',
  long: 'rgba(30, 144, 255, 0.5)',
};

/** Icons for depth layers. */
export const DEPTH_LAYER_ICONS: Readonly<Record<DepthLayer, string>> = {
  flash: '⚡',
  short: '📋',
  mid: '📝',
  long: '🔗',
};

/**
 * Map pipeline stages to their primary depth layer.
 * Stages not listed here don't have a specific layer association.
 */
export const STAGE_DEPTH_LAYER: Readonly<Record<string, DepthLayer>> = {
  // Recall pipeline → operates on different layers
  vector_search: 'flash',       // L0: embedding similarity search
  'vector-search': 'flash',     // alias
  graph_traversal: 'short',     // L1: traverse metadata-linked nodes
  'graph-traversal': 'short',   // alias
  merge: 'mid',                 // L2: merge results with summaries
  'result-merge': 'mid',        // alias
  reinforce: 'short',           // L1: Hebbian weight update on metadata
  format: 'mid',                // L2: format summaries for context
  inject: 'long',               // L3: inject with source references

  // Ingestion pipeline
  ingestion: 'flash',           // L0: initial ingestion (keywords, embedding)
  node_extraction: 'short',     // L1: extract structured metadata
  'fact-extraction': 'short',   // alias for legacy
  'episode-extraction': 'mid',  // L2: episodic summary extraction
  'concept-extraction': 'long', // L3: concept linking to sources

  // Batch extraction
  batch_extraction: 'short',    // L1: batch metadata extraction

  // Context injection
  'context-injection': 'mid',   // L2: context formatting
};

/** Get the depth layer for a given stage, or undefined if not mapped. */
export function getStageDepthLayer(stage: string): DepthLayer | undefined {
  return STAGE_DEPTH_LAYER[stage];
}

// ─── Stage Status ──────────────────────────────────────────

/**
 * Aggregated stage status for the timeline UI.
 *
 * - pending:  stage not yet started (future stage in pipeline)
 * - running:  start event received, no complete/error yet
 * - done:     complete event received
 * - error:    error event received
 * - skipped:  skipped event received (stage was bypassed)
 */
export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

// ─── Stage Entry (aggregated from trace events) ────────────

/**
 * Aggregated stage entry combining start + complete/error/skipped events
 * into a single UI-friendly representation.
 *
 * Created by pairing raw TraceEvent objects for the same stage.
 */
export interface StageEntry {
  /** Stage name (e.g. 'vector_search', 'recall', 'llm') */
  stage: string;

  /** Current aggregated status of the stage */
  status: StageStatus;

  /** Wall-clock duration in ms (set on done/error) */
  durationMs?: number;

  /** Input data from the start event */
  input?: Record<string, unknown>;

  /** Output data from the complete event */
  output?: Record<string, unknown>;

  /** Error message (on error status) */
  errorMessage?: string;

  /** Skip reason (on skipped status) */
  skipReason?: string;

  /** ISO timestamp when stage started */
  startedAt?: string;

  /** ISO timestamp when stage completed */
  completedAt?: string;

  /** Parent stage for nesting (e.g. recall sub-stages) */
  parentStage?: string;

  /** Whether this is a top-level stage */
  isTopLevel: boolean;

  /** MemoryNode depth layer this stage primarily operates on */
  depthLayer?: DepthLayer;
}

// ─── Stage Metadata ────────────────────────────────────────

/**
 * Display metadata for a pipeline stage.
 * Used by the TimelinePanel to render labels, colors, and icons.
 */
export interface StageMetadata {
  /** Human-readable label */
  label: string;

  /** Hex color for the stage's visual indicator */
  color: string;

  /** Sort order in the timeline (lower = earlier) */
  order: number;

  /** Whether this is a top-level stage */
  isTopLevel: boolean;

  /** Parent stage name (for nested stages) */
  parentStage?: string;
}

// ─── Stage Configuration ───────────────────────────────────

/** Ordered list of all known pipeline stages (top-level first, then sub-stages). */
export const PIPELINE_STAGE_ORDER: readonly string[] = [
  'pipeline',
  'recall',
  'vector_search',
  'graph_traversal',
  'merge',
  'reinforce',
  'format',
  'inject',
  'llm',
  'ingestion',
  'session_end',
  'batch_extraction',
  'episode_extraction',
  'concept_extraction',
] as const;

/** Set of top-level stages. */
export const TOP_LEVEL_STAGES: ReadonlySet<string> = new Set([
  'pipeline',
  'recall',
  'llm',
  'ingestion',
  'session_end',
  'batch_extraction',
]);

/** Set of recall sub-stages. */
export const RECALL_SUB_STAGES: ReadonlySet<string> = new Set([
  'vector_search',
  'graph_traversal',
  'merge',
  'reinforce',
  'format',
  'inject',
]);

/** Set of batch extraction sub-stages. */
export const BATCH_SUB_STAGES: ReadonlySet<string> = new Set([
  'episode_extraction',
  'concept_extraction',
]);

/** Human-readable stage labels. */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  pipeline: 'Pipeline',
  recall: 'Recall',
  vector_search: 'Vector Search',
  graph_traversal: 'Graph Traversal',
  merge: 'Merge & Rank',
  reinforce: 'Hebbian Reinforce',
  format: 'Format Context',
  inject: 'Inject Prompt',
  llm: 'LLM Generation',
  ingestion: 'Ingestion',
  session_end: 'Session End',
  batch_extraction: 'Batch Extraction',
  episode_extraction: 'Episode Extraction',
  concept_extraction: 'Concept Extraction',
};

/** Stage color mapping (hex). */
export const STAGE_COLORS: Readonly<Record<string, string>> = {
  pipeline: '#74b9ff',
  recall: '#4a9eff',
  vector_search: '#0984e3',
  graph_traversal: '#6c5ce7',
  merge: '#00b894',
  reinforce: '#fdcb6e',
  format: '#00cec9',
  inject: '#a29bfe',
  llm: '#ff7675',
  ingestion: '#e17055',
  session_end: '#d63031',
  batch_extraction: '#e84393',
  episode_extraction: '#fd79a8',
  concept_extraction: '#a29bfe',
};

/** Status indicator icons (Unicode). */
export const STATUS_ICONS: Readonly<Record<StageStatus, string>> = {
  pending: '○',
  running: '◉',
  done: '✓',
  error: '✗',
  skipped: '⏭',
};

/** Status CSS class suffixes. */
export const STATUS_CLASSES: Readonly<Record<StageStatus, string>> = {
  pending: 'tl-status-pending',
  running: 'tl-status-running',
  done: 'tl-status-done',
  error: 'tl-status-error',
  skipped: 'tl-status-skipped',
};

// ─── Helper functions ──────────────────────────────────────

/** Get the display color for a stage. Falls back to grey for unknown stages. */
export function getStageColor(stage: string): string {
  return STAGE_COLORS[stage] ?? '#b2bec3';
}

/** Get the human-readable label for a stage. Falls back to formatted stage name. */
export function getStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, ' ');
}

/** Get the sort order for a stage. Unknown stages sort last. */
export function getStageOrder(stage: string): number {
  const idx = PIPELINE_STAGE_ORDER.indexOf(stage);
  return idx === -1 ? 999 : idx;
}

/** Format a duration in milliseconds to a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ─── Stage Metadata Builder ────────────────────────────────

/** Build a complete StageMetadata map for all known stages. */
export function buildStageMetadataMap(): Map<string, StageMetadata> {
  const map = new Map<string, StageMetadata>();

  for (let i = 0; i < PIPELINE_STAGE_ORDER.length; i++) {
    const stage = PIPELINE_STAGE_ORDER[i];
    const isTopLevel = TOP_LEVEL_STAGES.has(stage);
    const parentStage = RECALL_SUB_STAGES.has(stage) ? 'recall'
      : BATCH_SUB_STAGES.has(stage) ? 'batch_extraction'
      : undefined;

    map.set(stage, {
      label: getStageLabel(stage),
      color: getStageColor(stage),
      order: i,
      isTopLevel,
      parentStage,
    });
  }

  return map;
}
