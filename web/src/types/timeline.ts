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
