/**
 * MemoryNodeCard — Expandable 4-layer progressive depth card for MemoryNode.
 *
 * Renders a MemoryNode with expand/collapse toggle for each depth layer:
 *   L0 (flash)  — always visible: frontmatter, keywords, embedding indicator
 *   L1 (short)  — collapsible: JSON metadata (entities, SPO, category, etc.)
 *   L2 (mid)    — collapsible: human-readable summary
 *   L3 (long)   — collapsible: source turn references
 *
 * Uses CSS transitions for smooth expand/collapse animations.
 */

import { useRef, useEffect, type CSSProperties } from 'react';
import './MemoryNodeCard.css';
import type { MemoryNodeData } from '../types/memory-node';
import { NODE_TYPE_COLORS, NODE_TYPE_ICONS, NODE_ROLE_ICONS } from '../types/memory-node';
import { DEPTH_LAYER_COLORS, DEPTH_LAYER_LABELS, DEPTH_LAYER_ICONS } from '../types/timeline';
import type { DepthLayer } from '../types/timeline';
import type { NodeLayerState } from '../hooks/useLayerExpansion';
import { LAYER_ORDER } from '../hooks/useLayerExpansion';

// ─── Props ──────────────────────────────────────────────────

export interface MemoryNodeCardProps {
  node: MemoryNodeData;
  layerState: NodeLayerState;
  onToggleLayer: (layer: DepthLayer) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onExpandTo: (depth: number) => void;
  onTransitionEnd: (layer: DepthLayer) => void;
  /** Optional: highlight when selected in graph */
  isSelected?: boolean;
  /** Optional: click handler for the card header */
  onClick?: () => void;
  /** Compact mode for graph sidebar (less padding) */
  compact?: boolean;
}

// ─── Component ──────────────────────────────────────────────

export function MemoryNodeCard({
  node,
  layerState,
  onToggleLayer,
  onExpandAll,
  onCollapseAll,
  onExpandTo,
  onTransitionEnd,
  isSelected = false,
  onClick,
  compact = false,
}: MemoryNodeCardProps) {
  const nodeTypeColor = node.nodeType ? NODE_TYPE_COLORS[node.nodeType] ?? '#b2bec3' : '#b2bec3';
  const nodeTypeIcon = node.nodeType ? NODE_TYPE_ICONS[node.nodeType] ?? '📦' : '📦';
  const roleIcon = NODE_ROLE_ICONS[node.nodeRole] ?? '';

  return (
    <div
      className={`mn-card ${isSelected ? 'mn-card--selected' : ''} ${compact ? 'mn-card--compact' : ''}`}
      style={{ '--node-type-color': nodeTypeColor } as CSSProperties}
    >
      {/* ─── L0: Flash (Always Visible) ─── */}
      <div className="mn-card__header" onClick={onClick}>
        <div className="mn-card__title-row">
          <span className="mn-card__role-badge" data-role={node.nodeRole}>
            {roleIcon} {node.nodeRole}
          </span>
          <span className="mn-card__type-badge" style={{ color: nodeTypeColor }}>
            {nodeTypeIcon} {node.nodeType ?? 'untyped'}
          </span>
          <span className="mn-card__id" title={node.id}>
            {node.id.slice(0, 8)}…
          </span>
        </div>

        <h3 className="mn-card__frontmatter">{node.frontmatter}</h3>

        {node.keywords && (
          <div className="mn-card__keywords">
            {node.keywords.split(/[,\s]+/).filter(Boolean).map((kw, i) => (
              <span key={i} className="mn-card__keyword-tag">{kw}</span>
            ))}
          </div>
        )}

        {node.hasEmbedding && (
          <span className="mn-card__embedding-badge">
            ⚡ embedded{node.embeddingDim ? ` (${node.embeddingDim}d)` : ''}
          </span>
        )}

        {/* Depth control buttons */}
        <div className="mn-card__depth-controls">
          <DepthStepper
            maxDepth={layerState.maxDepth}
            onExpandTo={onExpandTo}
            onExpandAll={onExpandAll}
            onCollapseAll={onCollapseAll}
          />
        </div>
      </div>

      {/* ─── L1: Short (Metadata) ─── */}
      <LayerSection
        layer="short"
        isExpanded={layerState.expanded.short}
        isAnimating={layerState.animating.short}
        onToggle={() => onToggleLayer('short')}
        onTransitionEnd={() => onTransitionEnd('short')}
      >
        <MetadataContent metadata={node.metadata} nodeType={node.nodeType} />
      </LayerSection>

      {/* ─── L2: Mid (Summary) ─── */}
      <LayerSection
        layer="mid"
        isExpanded={layerState.expanded.mid}
        isAnimating={layerState.animating.mid}
        onToggle={() => onToggleLayer('mid')}
        onTransitionEnd={() => onTransitionEnd('mid')}
      >
        <div className="mn-card__summary">
          {node.summary || <span className="mn-card__empty">(no summary)</span>}
        </div>
      </LayerSection>

      {/* ─── L3: Long (Source References) ─── */}
      <LayerSection
        layer="long"
        isExpanded={layerState.expanded.long}
        isAnimating={layerState.animating.long}
        onToggle={() => onToggleLayer('long')}
        onTransitionEnd={() => onTransitionEnd('long')}
      >
        <SourceRefsContent
          sourceMessageIds={node.sourceMessageIds}
          conversationId={node.conversationId}
          sourceTurnIndex={node.sourceTurnIndex}
        />
      </LayerSection>

      {/* ─── Footer: Lifecycle Info ─── */}
      <div className="mn-card__footer">
        <span title="Activation count">⚡ {node.activationCount}</span>
        <span title="Created at event">🕐 e{node.createdAtEvent}</span>
        <span title="Last activated at event">🔄 e{node.lastActivatedAtEvent}</span>
      </div>
    </div>
  );
}

// ─── LayerSection (Animated Expand/Collapse) ────────────────

interface LayerSectionProps {
  layer: DepthLayer;
  isExpanded: boolean;
  isAnimating: boolean;
  onToggle: () => void;
  onTransitionEnd: () => void;
  children: React.ReactNode;
}

function LayerSection({
  layer,
  isExpanded,
  isAnimating,
  onToggle,
  onTransitionEnd,
  children,
}: LayerSectionProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // Measure and animate height
  useEffect(() => {
    const el = contentRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;

    if (isExpanded) {
      // Expanding: set height to actual content height, then auto after transition
      const height = inner.scrollHeight;
      el.style.height = '0px';
      // Force reflow
      void el.offsetHeight;
      el.style.height = `${height}px`;

      const onEnd = () => {
        el.style.height = 'auto';
        onTransitionEnd();
      };
      el.addEventListener('transitionend', onEnd, { once: true });
      return () => el.removeEventListener('transitionend', onEnd);
    } else {
      // Collapsing: capture current height, then set to 0
      const height = el.scrollHeight;
      el.style.height = `${height}px`;
      // Force reflow
      void el.offsetHeight;
      el.style.height = '0px';

      const onEnd = () => {
        onTransitionEnd();
      };
      el.addEventListener('transitionend', onEnd, { once: true });
      return () => el.removeEventListener('transitionend', onEnd);
    }
  }, [isExpanded]);

  const layerColor = DEPTH_LAYER_COLORS[layer];
  const layerLabel = DEPTH_LAYER_LABELS[layer];
  const layerIcon = DEPTH_LAYER_ICONS[layer];

  return (
    <div
      className={`mn-layer ${isExpanded ? 'mn-layer--expanded' : 'mn-layer--collapsed'} ${isAnimating ? 'mn-layer--animating' : ''}`}
      style={{ '--layer-color': layerColor } as CSSProperties}
    >
      <button
        className="mn-layer__toggle"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${layerLabel}`}
      >
        <span className="mn-layer__chevron">{isExpanded ? '▾' : '▸'}</span>
        <span className="mn-layer__icon">{layerIcon}</span>
        <span className="mn-layer__label">{layerLabel}</span>
        <span className="mn-layer__indicator" />
      </button>

      <div
        ref={contentRef}
        className="mn-layer__content"
        style={{ height: isExpanded ? 'auto' : '0px', overflow: 'hidden' }}
      >
        <div ref={innerRef} className="mn-layer__inner">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── DepthStepper ───────────────────────────────────────────

interface DepthStepperProps {
  maxDepth: number;
  onExpandTo: (depth: number) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

function DepthStepper({ maxDepth, onExpandTo, onExpandAll, onCollapseAll }: DepthStepperProps) {
  return (
    <div className="mn-depth-stepper">
      {LAYER_ORDER.map((layer, idx) => (
        <button
          key={layer}
          className={`mn-depth-stepper__dot ${idx <= maxDepth ? 'mn-depth-stepper__dot--active' : ''}`}
          style={{ '--dot-color': DEPTH_LAYER_COLORS[layer] } as CSSProperties}
          onClick={(e) => {
            e.stopPropagation();
            onExpandTo(idx);
          }}
          title={`${DEPTH_LAYER_LABELS[layer]}: ${idx <= maxDepth ? 'visible' : 'hidden'}`}
          aria-label={`Toggle depth to ${DEPTH_LAYER_LABELS[layer]}`}
        >
          {DEPTH_LAYER_ICONS[layer]}
        </button>
      ))}
      <button
        className="mn-depth-stepper__btn"
        onClick={(e) => {
          e.stopPropagation();
          if (maxDepth >= 3) collapseAll();
          else onExpandAll();

          function collapseAll() { onCollapseAll(); }
        }}
        title={maxDepth >= 3 ? 'Collapse all layers' : 'Expand all layers'}
      >
        {maxDepth >= 3 ? '⊟' : '⊞'}
      </button>
    </div>
  );
}

// ─── MetadataContent (L1) ───────────────────────────────────

function MetadataContent({
  metadata,
  nodeType,
}: {
  metadata: MemoryNodeData['metadata'];
  nodeType: MemoryNodeData['nodeType'];
}) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return <span className="mn-card__empty">(no metadata)</span>;
  }

  return (
    <div className="mn-metadata">
      {/* Common fields */}
      {metadata.entities && metadata.entities.length > 0 && (
        <MetaRow label="Entities">
          {metadata.entities.map((e, i) => (
            <span key={i} className="mn-metadata__tag">{e}</span>
          ))}
        </MetaRow>
      )}
      {metadata.category && <MetaRow label="Category">{metadata.category}</MetaRow>}
      {metadata.confidence != null && (
        <MetaRow label="Confidence">
          <ConfidenceBar value={metadata.confidence} />
        </MetaRow>
      )}

      {/* Semantic (SPO) */}
      {nodeType === 'semantic' && metadata.subject && (
        <MetaRow label="SPO">
          <span className="mn-metadata__spo">
            <em>{metadata.subject}</em> → {metadata.predicate} → <em>{metadata.object}</em>
          </span>
        </MetaRow>
      )}

      {/* Episodic */}
      {nodeType === 'episodic' && metadata.episodeType && (
        <MetaRow label="Episode">{metadata.episodeType}</MetaRow>
      )}
      {metadata.actors && metadata.actors.length > 0 && (
        <MetaRow label="Actors">
          {metadata.actors.map((a, i) => (
            <span key={i} className="mn-metadata__tag">{a}</span>
          ))}
        </MetaRow>
      )}

      {/* Procedural */}
      {metadata.steps && metadata.steps.length > 0 && (
        <MetaRow label="Steps">
          <ol className="mn-metadata__steps">
            {metadata.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </MetaRow>
      )}

      {/* Prospective */}
      {metadata.priority && <MetaRow label="Priority">{metadata.priority}</MetaRow>}
      {metadata.status && <MetaRow label="Status">{metadata.status}</MetaRow>}

      {/* Emotional */}
      {metadata.emotion && (
        <MetaRow label="Emotion">
          {metadata.emotion}
          {metadata.intensity != null && ` (intensity: ${metadata.intensity})`}
        </MetaRow>
      )}

      {/* Hub */}
      {metadata.hubType && <MetaRow label="Hub Type">{metadata.hubType}</MetaRow>}
      {metadata.aliases && metadata.aliases.length > 0 && (
        <MetaRow label="Aliases">
          {metadata.aliases.map((a, i) => (
            <span key={i} className="mn-metadata__tag">{a}</span>
          ))}
        </MetaRow>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mn-metadata__row">
      <span className="mn-metadata__label">{label}</span>
      <span className="mn-metadata__value">{children}</span>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? '#2ed573' : value >= 0.5 ? '#ffa502' : '#ff6b6b';
  return (
    <span className="mn-confidence">
      <span className="mn-confidence__bar" style={{ width: `${pct}%`, background: color }} />
      <span className="mn-confidence__text">{pct}%</span>
    </span>
  );
}

// ─── SourceRefsContent (L3) ─────────────────────────────────

function SourceRefsContent({
  sourceMessageIds,
  conversationId,
  sourceTurnIndex,
}: {
  sourceMessageIds: string[];
  conversationId?: string;
  sourceTurnIndex?: number;
}) {
  const hasRefs = sourceMessageIds && sourceMessageIds.length > 0;
  const hasConv = conversationId || sourceTurnIndex != null;

  if (!hasRefs && !hasConv) {
    return <span className="mn-card__empty">(no source references)</span>;
  }

  return (
    <div className="mn-source-refs">
      {conversationId && (
        <div className="mn-source-refs__row">
          <span className="mn-source-refs__label">Conversation</span>
          <code className="mn-source-refs__value">{conversationId}</code>
        </div>
      )}
      {sourceTurnIndex != null && (
        <div className="mn-source-refs__row">
          <span className="mn-source-refs__label">Turn Index</span>
          <code className="mn-source-refs__value">{sourceTurnIndex}</code>
        </div>
      )}
      {hasRefs && (
        <div className="mn-source-refs__row">
          <span className="mn-source-refs__label">Source IDs</span>
          <div className="mn-source-refs__ids">
            {sourceMessageIds.map((id, i) => (
              <code key={i} className="mn-source-refs__id">{id}</code>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
