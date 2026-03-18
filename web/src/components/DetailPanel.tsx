/**
 * DetailPanel — Dual-mode detail viewer for pipeline stages AND MemoryNodes.
 *
 * Mode 1 (Stage): Shows raw JSON detail data for a selected pipeline stage.
 * Mode 2 (MemoryNode): Shows 4-layer progressive depth view with
 *   editable fields (frontmatter, keywords, summary, metadata) and
 *   shield/weight/decay visualization for connected edges.
 *
 * Features:
 *   - Recursive JSON tree with collapsible nodes
 *   - Collapsible sections for input, output, metadata
 *   - Raw JSON view with copy button
 *   - Close button + Escape key support
 *   - Status-aware visual styling
 *   - MemoryNode 4-layer (L0/L1/L2/L3) display
 *   - Inline editing for frontmatter, keywords, summary, metadata
 *   - Shield/weight/decay visualization with progress bars
 *   - Decay risk indicator
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
import type {
  MemoryNodeData,
  WeightedEdgeData,
  DecayInfo,
  UpdateMemoryNodeInput,
  MemoryNodeRole,
} from '../types/memory-node';
import {
  NODE_TYPE_COLORS,
  NODE_ROLE_COLORS,
  NODE_TYPE_ICONS,
  NODE_ROLE_ICONS,
  MEMORY_NODE_TYPES,
  MEMORY_NODE_ROLES,
} from '../types/memory-node';

// ─── Constants ──────────────────────────────────────────────

const WEIGHT_CAP = 100;
const BASE_SHIELD_CAP = 50;

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

// ─── Progress Bar ────────────────────────────────────────────

interface ProgressBarProps {
  value: number;
  max: number;
  color: string;
  label: string;
  showValue?: boolean;
}

function ProgressBar({ value, max, color, label, showValue = true }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="dp-progress-row">
      <span className="dp-progress-label">{label}</span>
      <div className="dp-progress-bar">
        <div
          className="dp-progress-fill"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      {showValue && (
        <span className="dp-progress-value">
          {value.toFixed(1)}/{max}
        </span>
      )}
    </div>
  );
}

// ─── Editable Text Field ─────────────────────────────────────

interface EditableFieldProps {
  label: string;
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
}

function EditableField({ label, value, onSave, multiline = false, placeholder }: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const handleSave = () => {
    if (draft !== value) {
      onSave(draft);
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Enter' && multiline && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
    }
  };

  if (!editing) {
    return (
      <div className="dp-editable-field">
        <span className="dp-editable-label">{label}</span>
        <div className="dp-editable-display" onClick={() => setEditing(true)} title="Click to edit">
          <span className="dp-editable-text">{value || <em className="dp-placeholder">{placeholder || 'empty'}</em>}</span>
          <span className="dp-edit-icon">✎</span>
        </div>
      </div>
    );
  }

  return (
    <div className="dp-editable-field dp-editable-active">
      <span className="dp-editable-label">{label}</span>
      {multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          className="dp-editable-input dp-editable-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          className="dp-editable-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
        />
      )}
      <div className="dp-editable-actions">
        <button className="dp-editable-save" onClick={handleSave}>Save</button>
        <button className="dp-editable-cancel" onClick={handleCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Inline Select Field ─────────────────────────────────────

interface SelectFieldProps {
  label: string;
  value: string;
  options: readonly string[];
  onSave: (value: string) => void;
  allowNull?: boolean;
}

function SelectField({ label, value, options, onSave, allowNull = false }: SelectFieldProps) {
  return (
    <div className="dp-info-row dp-select-row">
      <span className="dp-info-label">{label}</span>
      <select
        className="dp-select-input"
        value={value}
        onChange={(e) => onSave(e.target.value)}
      >
        {allowNull && <option value="">none</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Decay Indicator ─────────────────────────────────────────

function DecayIndicator({ decay }: { decay: DecayInfo }) {
  const healthPct = decay.decayFactor * 100;
  const healthColor = healthPct > 70 ? '#00b894' : healthPct > 40 ? '#fdcb6e' : '#e17055';

  return (
    <div className="dp-decay-section">
      <h4 className="dp-section-title">Decay Status</h4>
      <div className="dp-decay-grid">
        <div className="dp-decay-meter">
          <div className="dp-decay-ring" style={{
            background: `conic-gradient(${healthColor} ${healthPct}%, rgba(255,255,255,0.05) ${healthPct}%)`,
          }}>
            <span className="dp-decay-pct">{healthPct.toFixed(0)}%</span>
          </div>
          <span className="dp-decay-label">Health</span>
        </div>
        <div className="dp-decay-info">
          <div className="dp-info-row">
            <span className="dp-info-label">Global Counter</span>
            <span className="dp-info-value dp-mono">{decay.currentEventCounter}</span>
          </div>
          <div className="dp-info-row">
            <span className="dp-info-label">Events Since Active</span>
            <span className="dp-info-value dp-mono">{decay.eventsSinceActivation}</span>
          </div>
          <div className="dp-info-row">
            <span className="dp-info-label">Decay Factor</span>
            <span className="dp-info-value dp-mono">{decay.decayFactor.toFixed(4)}</span>
          </div>
          {decay.isAtRisk && (
            <div className="dp-decay-risk">
              <span className="dp-risk-icon">⚠</span>
              <span>At risk of forgetting</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Edge List ───────────────────────────────────────────────

function EdgeList({ edges, currentEvent }: { edges: WeightedEdgeData[]; currentEvent: number }) {
  const [expanded, setExpanded] = useState(true);

  if (edges.length === 0) return null;

  return (
    <div className="dp-section">
      <button
        className="dp-json-section-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="dp-json-arrow">{expanded ? '▼' : '▶'}</span>
        <span className="dp-json-label">Connected Edges</span>
        <span className="dp-section-badge">{edges.length}</span>
      </button>
      {expanded && (
        <div className="dp-edge-list">
          {edges.map((edge) => {
            const eventDelta = currentEvent - edge.lastActivatedAtEvent;
            const rawDecay = edge.decayRate * eventDelta;
            const shieldAbsorb = Math.min(edge.shield, rawDecay);
            const weightDecay = rawDecay - shieldAbsorb;
            const effectiveWeight = Math.max(0, edge.weight - weightDecay);
            const effectiveShield = Math.max(0, edge.shield - shieldAbsorb);

            return (
              <div key={edge.id} className="dp-edge-card">
                <div className="dp-edge-header">
                  <span className="dp-edge-type">{edge.edgeType.replace(/_/g, ' ')}</span>
                  {edge.connectedNodeLabel && (
                    <span className="dp-edge-target" title={edge.connectedNodeId}>
                      {edge.connectedNodeRole === 'hub' ? '🔗' : '🍃'} {edge.connectedNodeLabel}
                    </span>
                  )}
                </div>
                <ProgressBar
                  value={effectiveWeight}
                  max={WEIGHT_CAP}
                  color="#4a9eff"
                  label="Weight"
                />
                <ProgressBar
                  value={effectiveShield}
                  max={BASE_SHIELD_CAP}
                  color="#6c5ce7"
                  label="Shield"
                />
                <div className="dp-edge-stats">
                  <span className="dp-edge-stat">
                    <span className="dp-edge-stat-label">LR</span>
                    <span className="dp-edge-stat-value">{edge.learningRate}</span>
                  </span>
                  <span className="dp-edge-stat">
                    <span className="dp-edge-stat-label">DR</span>
                    <span className="dp-edge-stat-value">{edge.decayRate}</span>
                  </span>
                  <span className="dp-edge-stat">
                    <span className="dp-edge-stat-label">Act</span>
                    <span className="dp-edge-stat-value">{edge.activationCount}</span>
                  </span>
                  <span className="dp-edge-stat">
                    <span className="dp-edge-stat-label">Decay</span>
                    <span className="dp-edge-stat-value" style={{ color: rawDecay > 0 ? '#e17055' : 'inherit' }}>
                      -{rawDecay.toFixed(2)}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── MemoryNode Detail View ──────────────────────────────────

interface MemoryNodeDetailProps {
  node: MemoryNodeData;
  edges?: WeightedEdgeData[];
  decay?: DecayInfo;
  onUpdate?: (id: string, update: UpdateMemoryNodeInput) => void;
  onClose: () => void;
}

function MemoryNodeDetail({ node, edges, decay, onUpdate, onClose }: MemoryNodeDetailProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.focus();
  }, [node.id]);

  const handleFieldUpdate = useCallback((field: keyof UpdateMemoryNodeInput, value: string) => {
    if (onUpdate) {
      onUpdate(node.id, { [field]: value });
    }
  }, [onUpdate, node.id]);

  const handleRoleUpdate = useCallback((value: string) => {
    if (onUpdate && (value === 'hub' || value === 'leaf')) {
      onUpdate(node.id, { nodeRole: value as MemoryNodeRole });
    }
  }, [onUpdate, node.id]);

  const typeColor = node.nodeType ? NODE_TYPE_COLORS[node.nodeType] ?? '#b2bec3' : '#b2bec3';
  const roleColor = NODE_ROLE_COLORS[node.nodeRole] ?? '#b2bec3';
  const typeIcon = node.nodeType ? NODE_TYPE_ICONS[node.nodeType] ?? '' : '';
  const roleIcon = NODE_ROLE_ICONS[node.nodeRole] ?? '';

  // Build metadata display (filter out undefined/null values)
  const metadataDisplay: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node.metadata)) {
    if (val !== undefined && val !== null) {
      metadataDisplay[key] = val;
    }
  }

  // Full data for raw JSON view
  const fullData: Record<string, unknown> = {
    id: node.id,
    nodeType: node.nodeType,
    nodeRole: node.nodeRole,
    frontmatter: node.frontmatter,
    keywords: node.keywords,
    hasEmbedding: node.hasEmbedding,
    embeddingDim: node.embeddingDim,
    metadata: node.metadata,
    summary: node.summary,
    sourceMessageIds: node.sourceMessageIds,
    conversationId: node.conversationId,
    sourceTurnIndex: node.sourceTurnIndex,
    createdAtEvent: node.createdAtEvent,
    lastActivatedAtEvent: node.lastActivatedAtEvent,
    activationCount: node.activationCount,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };

  return (
    <div
      className="detail-panel detail-panel-open detail-panel-memory"
      ref={panelRef}
      tabIndex={-1}
      role="complementary"
      aria-label={`MemoryNode: ${node.frontmatter}`}
    >
      {/* ─── Header ─── */}
      <div className="dp-header dp-header-memory">
        <div className="dp-header-title">
          <span className="dp-node-icon">{roleIcon}</span>
          <h3 className="dp-stage-name" style={{ color: typeColor }}>
            {node.frontmatter || 'Untitled Node'}
          </h3>
        </div>
        <div className="dp-header-badges">
          {node.nodeType && (
            <span className="dp-type-badge" style={{ backgroundColor: `${typeColor}22`, color: typeColor, borderColor: `${typeColor}55` }}>
              {typeIcon} {node.nodeType}
            </span>
          )}
          <span className="dp-role-badge" style={{ backgroundColor: `${roleColor}22`, color: roleColor, borderColor: `${roleColor}55` }}>
            {roleIcon} {node.nodeRole}
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

        {/* ── Decay Status ── */}
        {decay && <DecayIndicator decay={decay} />}

        {/* ── L0: Anchor / Keywords ── */}
        <div className="dp-section">
          <h4 className="dp-section-title">
            <span className="dp-layer-badge dp-layer-l0">L0</span>
            Anchor / Keywords
          </h4>
          <EditableField
            label="Frontmatter"
            value={node.frontmatter}
            onSave={(v) => handleFieldUpdate('frontmatter', v)}
            placeholder="One-line label..."
          />
          <EditableField
            label="Keywords"
            value={node.keywords}
            onSave={(v) => handleFieldUpdate('keywords', v)}
            placeholder="Space-separated keywords (한영 혼용)..."
          />
          <div className="dp-info-grid">
            <div className="dp-info-row">
              <span className="dp-info-label">Embedding</span>
              <span className="dp-info-value">
                {node.hasEmbedding ? (
                  <span className="dp-badge-ok">✓ {node.embeddingDim ?? '?'}d</span>
                ) : (
                  <span className="dp-badge-missing">No embedding</span>
                )}
              </span>
            </div>
            <div className="dp-info-row">
              <span className="dp-info-label">ID</span>
              <span className="dp-info-value dp-mono" title={node.id}>{node.id.slice(0, 12)}...</span>
            </div>
          </div>
        </div>

        {/* ── Classification ── */}
        <div className="dp-section">
          <h4 className="dp-section-title">Classification</h4>
          <div className="dp-info-grid">
            <SelectField
              label="Node Type"
              value={node.nodeType ?? ''}
              options={MEMORY_NODE_TYPES}
              onSave={() => {/* nodeType not editable via update */}}
              allowNull={true}
            />
            <SelectField
              label="Node Role"
              value={node.nodeRole}
              options={MEMORY_NODE_ROLES}
              onSave={handleRoleUpdate}
            />
          </div>
        </div>

        {/* ── L1: Metadata ── */}
        {Object.keys(metadataDisplay).length > 0 && (
          <div className="dp-section">
            <h4 className="dp-section-title">
              <span className="dp-layer-badge dp-layer-l1">L1</span>
              Metadata
            </h4>
            <CollapsibleSection
              title="Structured Fields"
              badge="META"
              data={metadataDisplay}
              defaultExpanded={true}
            />
          </div>
        )}

        {/* ── L2: Summary ── */}
        <div className="dp-section">
          <h4 className="dp-section-title">
            <span className="dp-layer-badge dp-layer-l2">L2</span>
            Summary
          </h4>
          <EditableField
            label="Summary"
            value={node.summary}
            onSave={(v) => handleFieldUpdate('summary', v)}
            multiline={true}
            placeholder="Human-readable summary..."
          />
        </div>

        {/* ── L3: Source References ── */}
        {(node.sourceMessageIds.length > 0 || node.conversationId) && (
          <div className="dp-section">
            <h4 className="dp-section-title">
              <span className="dp-layer-badge dp-layer-l3">L3</span>
              Source References
            </h4>
            <div className="dp-info-grid">
              {node.conversationId && (
                <div className="dp-info-row">
                  <span className="dp-info-label">Conversation</span>
                  <span className="dp-info-value dp-mono" title={node.conversationId}>
                    {node.conversationId.slice(0, 12)}...
                  </span>
                </div>
              )}
              {node.sourceTurnIndex != null && (
                <div className="dp-info-row">
                  <span className="dp-info-label">Turn Index</span>
                  <span className="dp-info-value dp-mono">{node.sourceTurnIndex}</span>
                </div>
              )}
            </div>
            {node.sourceMessageIds.length > 0 && (
              <div className="dp-source-refs">
                {node.sourceMessageIds.map((ref, i) => (
                  <span key={i} className="dp-source-ref" title={ref}>
                    {ref}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Lifecycle ── */}
        <div className="dp-section">
          <h4 className="dp-section-title">Lifecycle</h4>
          <div className="dp-info-grid">
            <div className="dp-info-row">
              <span className="dp-info-label">Created At Event</span>
              <span className="dp-info-value dp-mono">{node.createdAtEvent}</span>
            </div>
            <div className="dp-info-row">
              <span className="dp-info-label">Last Activated</span>
              <span className="dp-info-value dp-mono">{node.lastActivatedAtEvent}</span>
            </div>
            <div className="dp-info-row">
              <span className="dp-info-label">Activation Count</span>
              <span className="dp-info-value dp-mono">{node.activationCount}</span>
            </div>
          </div>
        </div>

        {/* ── Timestamps ── */}
        <div className="dp-section">
          <h4 className="dp-section-title">Timestamps</h4>
          <div className="dp-info-grid">
            <div className="dp-info-row">
              <span className="dp-info-label">Created</span>
              <span className="dp-info-value">
                {new Date(node.createdAt).toLocaleString()}
              </span>
            </div>
            <div className="dp-info-row">
              <span className="dp-info-label">Updated</span>
              <span className="dp-info-value">
                {new Date(node.updatedAt).toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* ── Connected Edges (Shield / Weight / Decay) ── */}
        {edges && edges.length > 0 && (
          <EdgeList edges={edges} currentEvent={decay?.currentEventCounter ?? node.lastActivatedAtEvent} />
        )}

        {/* ── Raw JSON ── */}
        <div className="dp-section">
          <RawJsonView data={fullData} />
        </div>
      </div>
    </div>
  );
}

// ─── Main DetailPanel (Dual-Mode) ────────────────────────────

interface DetailPanelProps {
  /** The selected stage entry to display details for (stage mode) */
  entry?: StageEntry | null;
  /** The selected memory node to display details for (node mode) */
  memoryNode?: MemoryNodeData | null;
  /** Connected weighted edges for the selected memory node */
  edges?: WeightedEdgeData[];
  /** Computed decay info for the selected memory node */
  decay?: DecayInfo;
  /** Callback when a memory node field is updated */
  onUpdateNode?: (id: string, update: UpdateMemoryNodeInput) => void;
  /** Callback to close the detail panel */
  onClose: () => void;
}

/**
 * DetailPanel — dual-mode detail viewer.
 *
 * When `memoryNode` is provided, renders the MemoryNode view with
 * 4-layer progressive depth, shield/weight/decay, and inline editing.
 *
 * When `entry` is provided, renders the legacy pipeline stage view
 * with timing, status, input/output data, and raw JSON.
 *
 * Supports Escape key to close in both modes.
 */
export function DetailPanel({ entry, memoryNode, edges, decay, onUpdateNode, onClose }: DetailPanelProps) {
  // ── MemoryNode mode ──
  if (memoryNode) {
    return (
      <MemoryNodeDetail
        node={memoryNode}
        edges={edges}
        decay={decay}
        onUpdate={onUpdateNode}
        onClose={onClose}
      />
    );
  }

  // ── Stage mode (legacy) ──
  return <StageDetail entry={entry ?? null} onClose={onClose} />;
}

// ─── Stage Detail (extracted from original DetailPanel) ──────

interface StageDetailProps {
  entry: StageEntry | null;
  onClose: () => void;
}

function StageDetail({ entry, onClose }: StageDetailProps) {
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
