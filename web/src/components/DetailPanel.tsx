/**
 * DetailPanel — Shows raw JSON detail data for a selected pipeline stage.
 *
 * Features:
 *   - Recursive JSON tree with collapsible nodes
 *   - Collapsible sections for input, output, metadata
 *   - Raw JSON view with copy button
 *   - Close button + Escape key support
 *   - Status-aware visual styling
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { StageEntry } from '../types/timeline';
import type { StageStatus } from '../types/timeline';
import {
  getStageColor,
  getStageLabel,
  formatDuration,
  STATUS_ICONS,
  STATUS_CLASSES,
} from '../types/timeline';

// ─── Recursive JSON Tree ─────────────────────────────────────

interface JsonNodeProps {
  data: unknown;
  name?: string;
  depth: number;
  defaultExpanded?: boolean;
}

/**
 * Recursively renders a JSON value as a collapsible tree.
 * Objects/arrays are expandable; primitives render inline.
 */
function JsonNode({ data, name, depth, defaultExpanded }: JsonNodeProps) {
  const isExpandable =
    data !== null &&
    typeof data === 'object' &&
    ((Array.isArray(data) && data.length > 0) ||
      (!Array.isArray(data) && Object.keys(data as Record<string, unknown>).length > 0));

  const [expanded, setExpanded] = useState(defaultExpanded ?? depth < 2);

  // Primitive or null/empty rendering
  if (!isExpandable) {
    return (
      <div className="dp-json-line" style={{ paddingLeft: depth * 16 }}>
        {name != null && <span className="dp-json-key">{name}: </span>}
        <PrimitiveValue data={data} />
      </div>
    );
  }

  const isArray = Array.isArray(data);
  const entries = isArray
    ? (data as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(data as Record<string, unknown>);
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';
  const summary = isArray
    ? `${entries.length} item${entries.length !== 1 ? 's' : ''}`
    : `${entries.length} field${entries.length !== 1 ? 's' : ''}`;

  return (
    <div className="dp-json-node">
      <button
        className="dp-json-toggle"
        style={{ paddingLeft: depth * 16 }}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="dp-json-arrow">{expanded ? '▼' : '▶'}</span>
        {name != null && <span className="dp-json-key">{name}: </span>}
        <span className="dp-json-bracket">{openBracket}</span>
        {!expanded && (
          <>
            <span className="dp-json-collapsed">{summary}</span>
            <span className="dp-json-bracket">{closeBracket}</span>
          </>
        )}
      </button>
      {expanded && (
        <>
          {entries.map(([key, value]) => (
            <JsonNode key={key} data={value} name={key} depth={depth + 1} />
          ))}
          <div className="dp-json-line" style={{ paddingLeft: depth * 16 }}>
            <span className="dp-json-bracket">{closeBracket}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** Renders a primitive JSON value with syntax-highlighting class. */
function PrimitiveValue({ data }: { data: unknown }) {
  if (data === null || data === undefined) {
    return <span className="dp-json-null">{String(data)}</span>;
  }
  if (typeof data === 'boolean') {
    return <span className="dp-json-boolean">{String(data)}</span>;
  }
  if (typeof data === 'number') {
    return <span className="dp-json-number">{data}</span>;
  }
  if (typeof data === 'string') {
    const isLong = data.length > 120;
    return (
      <span className="dp-json-string" title={isLong ? data : undefined}>
        &quot;{isLong ? data.slice(0, 120) + '…' : data}&quot;
      </span>
    );
  }
  // Empty object/array or other
  if (Array.isArray(data) && data.length === 0) {
    return <span className="dp-json-bracket">[]</span>;
  }
  if (typeof data === 'object' && Object.keys(data as object).length === 0) {
    return <span className="dp-json-bracket">{'{}'}</span>;
  }
  return <span className="dp-json-string">{String(data)}</span>;
}

// ─── Collapsible Section ─────────────────────────────────────

interface CollapsibleSectionProps {
  title: string;
  badge?: string;
  data: Record<string, unknown>;
  defaultExpanded?: boolean;
}

function CollapsibleSection({ title, badge, data, defaultExpanded = true }: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const fieldCount = Object.keys(data).length;
  if (fieldCount === 0) return null;

  return (
    <div className="dp-json-section">
      <button
        className="dp-json-section-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="dp-json-arrow">{expanded ? '▼' : '▶'}</span>
        <span className="dp-json-label">{title}</span>
        {badge && <span className="dp-section-badge">{badge}</span>}
        <span className="dp-json-count">
          {fieldCount} {fieldCount === 1 ? 'field' : 'fields'}
        </span>
      </button>
      {expanded && (
        <div className="dp-json-tree">
          <JsonNode data={data} depth={0} defaultExpanded={true} />
        </div>
      )}
    </div>
  );
}

// ─── Raw JSON View ───────────────────────────────────────────

function RawJsonView({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(jsonString).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [jsonString]);

  return (
    <div className="dp-raw-section">
      <button
        className="dp-raw-toggle"
        onClick={() => setOpen(!open)}
      >
        <span className="dp-json-arrow">{open ? '▼' : '▶'}</span>
        Raw JSON
      </button>
      {open && (
        <>
          <div className="dp-raw-actions">
            <button className="dp-copy-btn" onClick={handleCopy}>
              {copied ? '✓ Copied' : '⎘ Copy'}
            </button>
          </div>
          <pre className="dp-raw-json">{jsonString}</pre>
        </>
      )}
    </div>
  );
}

// ─── DetailPanel ─────────────────────────────────────────────

interface DetailPanelProps {
  /** The selected stage entry to display details for */
  entry: StageEntry | null;
  /** Callback to close the detail panel */
  onClose: () => void;
}

/**
 * DetailPanel — shows detailed information for a selected pipeline stage.
 *
 * Displays:
 *  - Stage name, status, and color indicator
 *  - Timing information (started, completed, duration)
 *  - Collapsible tree views for input and output data
 *  - Error messages or skip reasons
 *  - Raw JSON dump with copy support
 *
 * Supports Escape key to close.
 */
export function DetailPanel({ entry, onClose }: DetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus panel on mount
  useEffect(() => {
    if (entry) {
      panelRef.current?.focus();
    }
  }, [entry]);

  if (!entry) return null;

  const color = getStageColor(entry.stage);
  const statusClass = STATUS_CLASSES[entry.status as StageStatus] ?? '';
  const icon = STATUS_ICONS[entry.status as StageStatus] ?? '○';

  // Full data for raw JSON view
  const fullData: Record<string, unknown> = {
    stage: entry.stage,
    status: entry.status,
    isTopLevel: entry.isTopLevel,
    ...(entry.parentStage && { parentStage: entry.parentStage }),
    ...(entry.startedAt && { startedAt: entry.startedAt }),
    ...(entry.completedAt && { completedAt: entry.completedAt }),
    ...(entry.durationMs != null && { durationMs: entry.durationMs }),
    ...(entry.errorMessage && { errorMessage: entry.errorMessage }),
    ...(entry.skipReason && { skipReason: entry.skipReason }),
    ...(entry.input && { input: entry.input }),
    ...(entry.output && { output: entry.output }),
  };

  return (
    <div
      className={`detail-panel detail-panel-open`}
      ref={panelRef}
      tabIndex={-1}
      role="complementary"
      aria-label={`Stage details: ${getStageLabel(entry.stage)}`}
    >
      {/* ─── Header ─── */}
      <div className="dp-header">
        <div className="dp-header-title">
          <span className="dp-stage-dot" style={{ backgroundColor: color }} />
          <h3 className="dp-stage-name" style={{ color }}>
            {getStageLabel(entry.stage)}
          </h3>
          <span className={`dp-status-badge ${statusClass}`}>
            <span className="dp-status-icon">{icon}</span>
            {entry.status}
          </span>
        </div>
        <button
          className="dp-close-btn"
          onClick={onClose}
          aria-label="Close detail panel"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {/* ─── Body ─── */}
      <div className="dp-body">
        {/* Timing */}
        <div className="dp-section">
          <h4 className="dp-section-title">Timing</h4>
          <div className="dp-info-grid">
            {entry.startedAt && (
              <div className="dp-info-row">
                <span className="dp-info-label">Started</span>
                <span className="dp-info-value">
                  {new Date(entry.startedAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    fractionalSecondDigits: 3,
                  })}
                </span>
              </div>
            )}
            {entry.completedAt && (
              <div className="dp-info-row">
                <span className="dp-info-label">Completed</span>
                <span className="dp-info-value">
                  {new Date(entry.completedAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    fractionalSecondDigits: 3,
                  })}
                </span>
              </div>
            )}
            {entry.durationMs != null && (
              <div className="dp-info-row">
                <span className="dp-info-label">Duration</span>
                <span className="dp-info-value dp-duration" style={{ color }}>
                  {formatDuration(entry.durationMs)}
                  <span className="dp-duration-raw">
                    ({entry.durationMs.toFixed(2)}ms)
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Stage Info */}
        <div className="dp-section">
          <h4 className="dp-section-title">Stage Info</h4>
          <div className="dp-info-grid">
            <div className="dp-info-row">
              <span className="dp-info-label">Stage ID</span>
              <span className="dp-info-value dp-mono">{entry.stage}</span>
            </div>
            <div className="dp-info-row">
              <span className="dp-info-label">Level</span>
              <span className="dp-info-value">
                {entry.isTopLevel ? 'Top-level' : 'Sub-stage'}
              </span>
            </div>
            {entry.parentStage && (
              <div className="dp-info-row">
                <span className="dp-info-label">Parent</span>
                <span className="dp-info-value dp-mono">{entry.parentStage}</span>
              </div>
            )}
          </div>
        </div>

        {/* Error */}
        {entry.status === 'error' && entry.errorMessage && (
          <div className="dp-section">
            <h4 className="dp-section-title dp-section-error">Error</h4>
            <div className="dp-error-box">{entry.errorMessage}</div>
          </div>
        )}

        {/* Skip */}
        {entry.status === 'skipped' && entry.skipReason && (
          <div className="dp-section">
            <h4 className="dp-section-title dp-section-skip">Skip Reason</h4>
            <div className="dp-skip-box">{entry.skipReason}</div>
          </div>
        )}

        {/* Running */}
        {entry.status === 'running' && (
          <div className="dp-section">
            <div className="dp-running-box">
              <span className="dp-spinner" />
              <span>Stage is currently executing...</span>
            </div>
          </div>
        )}

        {/* Input Data (collapsible tree) */}
        {entry.input && Object.keys(entry.input).length > 0 && (
          <div className="dp-section">
            <CollapsibleSection
              title="Input Data"
              badge="IN"
              data={entry.input}
              defaultExpanded={true}
            />
          </div>
        )}

        {/* Output Data (collapsible tree) */}
        {entry.output && Object.keys(entry.output).length > 0 && (
          <div className="dp-section">
            <CollapsibleSection
              title="Output Data"
              badge="OUT"
              data={entry.output}
              defaultExpanded={true}
            />
          </div>
        )}

        {/* Raw JSON */}
        <div className="dp-section">
          <RawJsonView data={fullData} />
        </div>
      </div>
    </div>
  );
}
