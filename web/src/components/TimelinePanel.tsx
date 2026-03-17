import { useState, useMemo, useEffect, useRef } from 'react';
import type { TraceEvent } from '../types';
import type { StageEntry, StageStatus } from '../types/timeline';
import {
  PIPELINE_STAGE_ORDER,
  TOP_LEVEL_STAGES,
  RECALL_SUB_STAGES,
  BATCH_SUB_STAGES,
  STATUS_ICONS,
  STATUS_CLASSES,
  getStageColor,
  getStageLabel,
  getStageOrder,
  formatDuration,
} from '../types/timeline';

// Re-export StageEntry so useTimeline and other consumers can import from here
export type { StageEntry } from '../types/timeline';

// ─── Helpers ────────────────────────────────────────────────

/**
 * Aggregate raw trace events into StageEntry objects.
 * Pairs start → complete/error events for the same stage.
 */
function aggregateStages(traces: TraceEvent[]): StageEntry[] {
  const stageMap = new Map<string, StageEntry>();

  for (const trace of traces) {
    const existing = stageMap.get(trace.stage);

    if (trace.status === 'start') {
      stageMap.set(trace.stage, {
        stage: trace.stage,
        status: 'running',
        startedAt: trace.timestamp,
        input: trace.data as Record<string, unknown> | undefined,
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      });
    } else if (trace.status === 'complete') {
      const entry = existing ?? {
        stage: trace.stage,
        status: 'done' as const,
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      };
      stageMap.set(trace.stage, {
        ...entry,
        status: 'done',
        durationMs: trace.durationMs,
        completedAt: trace.timestamp,
        output: trace.data as Record<string, unknown> | undefined,
      });
    } else if (trace.status === 'error') {
      const entry = existing ?? {
        stage: trace.stage,
        status: 'error' as const,
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      };
      stageMap.set(trace.stage, {
        ...entry,
        status: 'error',
        durationMs: trace.durationMs,
        completedAt: trace.timestamp,
        errorMessage: (trace.data as Record<string, unknown>)?.error as string
          ?? (trace.data as Record<string, unknown>)?.message as string
          ?? 'Unknown error',
      });
    } else if (trace.status === 'skipped') {
      stageMap.set(trace.stage, {
        stage: trace.stage,
        status: 'skipped',
        startedAt: trace.timestamp,
        completedAt: trace.timestamp,
        skipReason: (trace.data as Record<string, unknown>)?.reason as string
          ?? (trace.data as Record<string, unknown>)?.skipReason as string
          ?? 'Skipped',
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      });
    }
  }

  // Sort by pipeline order
  return Array.from(stageMap.values()).sort(
    (a, b) => getStageOrder(a.stage) - getStageOrder(b.stage),
  );
}

// ─── Sub-components ─────────────────────────────────────────

/** Duration bar with proportional width relative to the max duration. */
function DurationBar({ durationMs, maxDurationMs }: { durationMs: number; maxDurationMs: number }) {
  const pct = maxDurationMs > 0 ? Math.max(4, (durationMs / maxDurationMs) * 100) : 4;
  return (
    <div className="tl-duration-bar-bg">
      <div
        className="tl-duration-bar-fill"
        style={{ width: `${pct}%` }}
      />
      <span className="tl-duration-label">{formatDuration(durationMs)}</span>
    </div>
  );
}

/** Expandable JSON data section. */
function DataSection({
  label,
  data,
}: {
  label: string;
  data: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);

  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  return (
    <div className="tl-data-section">
      <button
        className="tl-data-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="tl-data-arrow">{open ? '▼' : '▶'}</span>
        {label} ({entries.length} {entries.length === 1 ? 'field' : 'fields'})
      </button>
      {open && (
        <div className="tl-data-content">
          {entries.map(([key, value]) => (
            <div key={key} className="tl-data-field">
              <span className="tl-data-key">{key}:</span>
              <span className="tl-data-value">
                {typeof value === 'object' && value !== null
                  ? JSON.stringify(value, null, 2)
                  : String(value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Single stage entry in the timeline. */
function StageRow({
  entry,
  maxDurationMs,
  isNested,
  isSelected,
  onSelect,
}: {
  entry: StageEntry;
  maxDurationMs: number;
  isNested: boolean;
  isSelected: boolean;
  onSelect: (stage: string) => void;
}) {
  const color = getStageColor(entry.stage);
  const statusClass = STATUS_CLASSES[entry.status as StageStatus] ?? '';
  const icon = STATUS_ICONS[entry.status as StageStatus] ?? '○';

  return (
    <div
      className={`tl-stage-row ${statusClass} ${isNested ? 'tl-nested' : ''} ${isSelected ? 'tl-selected' : ''}`}
      data-stage={entry.stage}
      data-status={entry.status}
      onClick={(e) => { e.stopPropagation(); onSelect(entry.stage); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(entry.stage); } }}
      aria-selected={isSelected}
    >
      {/* Timeline connector */}
      <div className="tl-connector">
        <div className="tl-line tl-line-top" />
        <div
          className="tl-dot"
          style={{
            borderColor: color,
            backgroundColor: entry.status === 'running' ? color : 'transparent',
          }}
        >
          <span className="tl-dot-icon" style={{ color }}>
            {icon}
          </span>
        </div>
        <div className="tl-line tl-line-bottom" />
      </div>

      {/* Stage content */}
      <div className="tl-content">
        <div className="tl-stage-header">
          <span className="tl-stage-name" style={{ color }}>
            {getStageLabel(entry.stage)}
          </span>
          <span className={`tl-status-badge ${statusClass}`}>
            {entry.status}
          </span>
        </div>

        {/* Duration bar */}
        {entry.durationMs != null && (
          <DurationBar durationMs={entry.durationMs} maxDurationMs={maxDurationMs} />
        )}

        {/* Running spinner */}
        {entry.status === 'running' && (
          <div className="tl-running-indicator">
            <span className="tl-spinner" />
            <span className="tl-running-text">Processing...</span>
          </div>
        )}

        {/* Error message */}
        {entry.status === 'error' && entry.errorMessage && (
          <div className="tl-error-message">{entry.errorMessage}</div>
        )}

        {/* Skip reason */}
        {entry.status === 'skipped' && entry.skipReason && (
          <div className="tl-skip-reason">{entry.skipReason}</div>
        )}

        {/* Input data */}
        {entry.input && Object.keys(entry.input).length > 0 && (
          <DataSection label="Input" data={entry.input} />
        )}

        {/* Output data */}
        {entry.output && Object.keys(entry.output).length > 0 && (
          <DataSection label="Output" data={entry.output} />
        )}
      </div>
    </div>
  );
}

// ─── TimelinePanel ──────────────────────────────────────────

interface TimelinePanelProps {
  traces: TraceEvent[];
  /** Externally controlled selected step (optional) */
  selectedStep?: string | null;
  /** Callback when a step is selected/deselected (optional) */
  onSelectStep?: (stage: string | null) => void;
}

/**
 * TimelinePanel — visualizes the memory pipeline as a vertical timeline.
 *
 * Aggregates raw trace events into stage entries, groups recall sub-stages
 * under the recall parent, and displays status, duration, and detail data
 * for each pipeline stage.
 */
export function TimelinePanel({ traces, selectedStep: externalSelectedStep, onSelectStep }: TimelinePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Internal selected step state (used when not externally controlled)
  const [internalSelectedStep, setInternalSelectedStep] = useState<string | null>(null);

  // Determine if controlled or uncontrolled
  const isControlled = externalSelectedStep !== undefined;
  const selectedStep = isControlled ? externalSelectedStep : internalSelectedStep;

  // Handle step selection (toggle behavior: click again to deselect)
  const handleSelectStep = (stage: string) => {
    const newValue = stage === selectedStep ? null : stage;
    if (isControlled && onSelectStep) {
      onSelectStep(newValue);
    } else {
      setInternalSelectedStep(newValue);
    }
  };

  // Aggregate traces into stage entries
  const stages = useMemo(() => aggregateStages(traces), [traces]);

  // Max duration for proportional bars
  const maxDurationMs = useMemo(
    () =>
      stages.reduce(
        (max, s) => (s.durationMs != null && s.durationMs > max ? s.durationMs : max),
        0,
      ),
    [stages],
  );

  // Separate top-level and nested stages
  const topLevelStages = useMemo(
    () => stages.filter((s) => s.isTopLevel),
    [stages],
  );
  const recallSubStages = useMemo(
    () => stages.filter((s) => s.parentStage === 'recall'),
    [stages],
  );
  const batchSubStages = useMemo(
    () => stages.filter((s) => s.parentStage === 'batch_extraction'),
    [stages],
  );

  // Auto-scroll to bottom when new stages appear
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [stages]);

  // Summary counts
  const summary = useMemo(() => {
    const counts = { done: 0, running: 0, error: 0, skipped: 0, pending: 0 };
    for (const s of stages) {
      counts[s.status as keyof typeof counts]++;
    }
    return counts;
  }, [stages]);

  const totalDuration = useMemo(() => {
    const pipelineStage = stages.find((s) => s.stage === 'pipeline');
    return pipelineStage?.durationMs;
  }, [stages]);

  if (traces.length === 0) {
    return (
      <div className="timeline-panel">
        <div className="tl-header">
          <h2>Pipeline Timeline</h2>
        </div>
        <div className="empty-state">
          No trace events yet. Send a message to see the memory pipeline in action.
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-panel">
      <div className="tl-header">
        <h2>Pipeline Timeline</h2>
        <div className="tl-summary">
          {summary.done > 0 && (
            <span className="tl-summary-chip tl-chip-done">✓ {summary.done}</span>
          )}
          {summary.running > 0 && (
            <span className="tl-summary-chip tl-chip-running">◉ {summary.running}</span>
          )}
          {summary.error > 0 && (
            <span className="tl-summary-chip tl-chip-error">✗ {summary.error}</span>
          )}
          {summary.skipped > 0 && (
            <span className="tl-summary-chip tl-chip-skipped">⏭ {summary.skipped}</span>
          )}
          {totalDuration != null && (
            <span className="tl-summary-total">
              Total: {formatDuration(totalDuration)}
            </span>
          )}
        </div>
      </div>

      <div className="tl-timeline" ref={containerRef}>
        {topLevelStages.map((entry) => (
          <div key={entry.stage} className="tl-stage-group">
            <StageRow
              entry={entry}
              maxDurationMs={maxDurationMs}
              isNested={false}
              isSelected={selectedStep === entry.stage}
              onSelect={handleSelectStep}
            />
            {/* Render recall sub-stages nested under recall */}
            {entry.stage === 'recall' && recallSubStages.length > 0 && (
              <div className="tl-nested-group">
                {recallSubStages.map((sub) => (
                  <StageRow
                    key={sub.stage}
                    entry={sub}
                    maxDurationMs={maxDurationMs}
                    isNested={true}
                    isSelected={selectedStep === sub.stage}
                    onSelect={handleSelectStep}
                  />
                ))}
              </div>
            )}
            {/* Render batch extraction sub-stages nested under batch_extraction */}
            {entry.stage === 'batch_extraction' && batchSubStages.length > 0 && (
              <div className="tl-nested-group">
                {batchSubStages.map((sub) => (
                  <StageRow
                    key={sub.stage}
                    entry={sub}
                    maxDurationMs={maxDurationMs}
                    isNested={true}
                    isSelected={selectedStep === sub.stage}
                    onSelect={handleSelectStep}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
