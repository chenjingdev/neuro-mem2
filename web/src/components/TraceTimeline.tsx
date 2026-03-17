import { useState, useEffect, useRef } from 'react';
import type { TraceEvent } from '../types';

interface TraceTimelineProps {
  traces: TraceEvent[];
}

// ─── Stage Colors ─────────────────────────────────────────────
const STAGE_COLORS: Record<string, string> = {
  recall: '#4a9eff',
  'vector-search': '#4a9eff',
  'graph-traversal': '#6c5ce7',
  'result-merge': '#00b894',
  ingestion: '#fdcb6e',
  'fact-extraction': '#e17055',
  'episode-extraction': '#d63031',
  'concept-extraction': '#a29bfe',
  'context-injection': '#00cec9',
  session: '#636e72',
  llm: '#ff7675',
  pipeline: '#74b9ff',
};

// ─── Stage Groups (for visual grouping) ───────────────────────
const STAGE_GROUPS: Record<string, string> = {
  recall: 'Recall',
  'vector-search': 'Recall',
  'graph-traversal': 'Recall',
  'result-merge': 'Recall',
  'context-injection': 'Recall',
  llm: 'LLM',
  ingestion: 'Ingestion',
  'fact-extraction': 'Ingestion',
  'episode-extraction': 'Ingestion',
  'concept-extraction': 'Ingestion',
  session: 'Session',
  pipeline: 'Pipeline',
};

const STATUS_ICONS: Record<string, string> = {
  start: '\u25b6',
  complete: '\u2713',
  error: '\u2717',
  skipped: '\u23ed',
};

const GROUP_ICONS: Record<string, string> = {
  Pipeline: '\ud83d\udd27',
  Session: '\ud83d\udcc1',
  Recall: '\ud83d\udd0d',
  LLM: '\ud83e\udde0',
  Ingestion: '\ud83d\udce5',
};

function getStageColor(stage: string): string {
  return STAGE_COLORS[stage] ?? '#b2bec3';
}

function getGroupName(stage: string): string {
  return STAGE_GROUPS[stage] ?? 'Other';
}

// ─── Group traces by pipeline phase ────────────────────────────
interface TraceGroup {
  name: string;
  icon: string;
  traces: TraceEvent[];
  color: string;
}

function groupTraces(traces: TraceEvent[]): TraceGroup[] {
  const groups: Map<string, TraceEvent[]> = new Map();
  const groupOrder: string[] = [];

  for (const trace of traces) {
    const group = getGroupName(trace.stage);
    if (!groups.has(group)) {
      groups.set(group, []);
      groupOrder.push(group);
    }
    groups.get(group)!.push(trace);
  }

  return groupOrder.map((name) => ({
    name,
    icon: GROUP_ICONS[name] ?? '\ud83d\udccc',
    traces: groups.get(name)!,
    color: getStageColor(groups.get(name)![0].stage),
  }));
}

// ─── TraceItem component ───────────────────────────────────────
function TraceItem({ trace, index }: { trace: TraceEvent; index: number }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Staggered slide-in animation
    const timer = setTimeout(() => setVisible(true), index * 30);
    return () => clearTimeout(timer);
  }, [index]);

  const color = getStageColor(trace.stage);
  const isActive = trace.status === 'start';
  const isError = trace.status === 'error';
  const isSkipped = trace.status === 'skipped';

  return (
    <div
      ref={ref}
      className={`trace-item trace-status-${trace.status}${visible ? ' trace-visible' : ''}`}
      style={{ '--stage-color': color } as React.CSSProperties}
    >
      <div className="trace-connector">
        <div
          className={`trace-dot${isActive ? ' trace-dot-active' : ''}`}
          style={{ backgroundColor: color }}
        />
        <div className="trace-line" />
      </div>
      <div className="trace-body">
        <div className="trace-header">
          <span className="trace-stage" style={{ color }}>
            <span className="trace-icon">{STATUS_ICONS[trace.status] ?? ''}</span>
            {trace.stage}
          </span>
          <div className="trace-meta">
            <span className={`trace-status-badge trace-badge-${trace.status}`}>
              {trace.status}
            </span>
            {trace.durationMs != null && (
              <span className={`trace-duration${trace.durationMs > 500 ? ' trace-duration-slow' : ''}`}>
                {trace.durationMs}ms
              </span>
            )}
          </div>
        </div>
        {isError && trace.data && 'error' in trace.data && (
          <div className="trace-error-msg">
            {String(trace.data.error)}
          </div>
        )}
        {isSkipped && trace.data && 'reason' in trace.data && (
          <div className="trace-skip-reason">
            {String(trace.data.reason)}
          </div>
        )}
        {trace.data && Object.keys(trace.data).length > 0 && (
          <details className="trace-data">
            <summary>
              <span className="trace-data-toggle">data</span>
              <span className="trace-data-count">
                {Object.keys(trace.data).length} {Object.keys(trace.data).length === 1 ? 'field' : 'fields'}
              </span>
            </summary>
            <pre>{JSON.stringify(trace.data, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

// ─── TraceGroup component ──────────────────────────────────────
function TraceGroupSection({ group }: { group: TraceGroup }) {
  const [collapsed, setCollapsed] = useState(false);

  // Check if group has any errors
  const hasError = group.traces.some((t) => t.status === 'error');
  // Total duration: sum of all complete stages
  const totalDuration = group.traces
    .filter((t) => t.status === 'complete' && t.durationMs != null)
    .reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  // Is any stage still in progress?
  const isActive = group.traces.some((t) => t.status === 'start') &&
    !group.traces.some((t) => t.status === 'complete' || t.status === 'error');

  return (
    <div className={`trace-group${hasError ? ' trace-group-error' : ''}${isActive ? ' trace-group-active' : ''}`}>
      <button
        className="trace-group-header"
        onClick={() => setCollapsed(!collapsed)}
        type="button"
      >
        <span className="trace-group-icon">{group.icon}</span>
        <span className="trace-group-name">{group.name}</span>
        <span className="trace-group-count">{group.traces.length}</span>
        {totalDuration > 0 && (
          <span className="trace-group-duration">{totalDuration}ms</span>
        )}
        {isActive && <span className="trace-group-spinner" />}
        <span className={`trace-group-chevron${collapsed ? '' : ' trace-group-chevron-open'}`}>
          &#9656;
        </span>
      </button>
      {!collapsed && (
        <div className="trace-group-items">
          {group.traces.map((trace, i) => (
            <TraceItem key={i} trace={trace} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main TraceTimeline ────────────────────────────────────────
export function TraceTimeline({ traces }: TraceTimelineProps) {
  const listEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom as new traces arrive
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [traces]);

  const groups = groupTraces(traces);

  return (
    <div className="trace-timeline">
      <div className="trace-timeline-header">
        <h2>Pipeline Trace</h2>
        {traces.length > 0 && (
          <span className="trace-count">{traces.length} events</span>
        )}
      </div>
      {traces.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">{'\ud83d\udd0d'}</div>
          No trace events yet. Send a message to see the memory pipeline in action.
        </div>
      ) : (
        <div className="trace-groups">
          {groups.map((group, i) => (
            <TraceGroupSection key={`${group.name}-${i}`} group={group} />
          ))}
          <div ref={listEndRef} />
        </div>
      )}
    </div>
  );
}
