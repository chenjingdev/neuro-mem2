/**
 * GraphControls — sidebar controls for graph visualization parameters.
 *
 * Controls:
 * - maxNodes: how many nodes to sample (global view)
 * - minWeight: minimum edge weight filter
 * - hops: BFS depth for local explorer
 * - hubsOnly: show only hub nodes (global view)
 * - Stats display
 */

import type { GraphStats } from '../../hooks/useGraphData';
import {
  NODE_TYPE_PALETTES,
  NODE_ROLE_PALETTES,
  NODE_TYPE_COLORS,
} from '../../config/node-colors';

interface GraphControlsProps {
  viewMode: 'global' | 'local';
  maxNodes: number;
  minWeight: number;
  hops: number;
  hubsOnly: boolean;
  stats: GraphStats | null;
  onChange: (changes: {
    maxNodes?: number;
    minWeight?: number;
    hops?: number;
    hubsOnly?: boolean;
  }) => void;
  onApply: () => void;
}

export function GraphControls({
  viewMode,
  maxNodes,
  minWeight,
  hops,
  hubsOnly,
  stats,
  onChange,
  onApply,
}: GraphControlsProps) {
  return (
    <div className="graph-controls">
      <h3 className="controls-title">Controls</h3>

      {/* Max Nodes */}
      {viewMode === 'global' && (
        <div className="control-group">
          <label className="control-label">
            Max Nodes
            <span className="control-value">{maxNodes.toLocaleString()}</span>
          </label>
          <input
            type="range"
            min={100}
            max={10000}
            step={100}
            value={maxNodes}
            onChange={e => onChange({ maxNodes: parseInt(e.target.value, 10) })}
            className="control-slider"
          />
        </div>
      )}

      {/* Min Edge Weight */}
      <div className="control-group">
        <label className="control-label">
          Min Edge Weight
          <span className="control-value">{minWeight.toFixed(0)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={minWeight}
          onChange={e => onChange({ minWeight: parseFloat(e.target.value) })}
          className="control-slider"
        />
      </div>

      {/* BFS Hops (local only) */}
      {viewMode === 'local' && (
        <div className="control-group">
          <label className="control-label">
            BFS Hops
            <span className="control-value">{hops}</span>
          </label>
          <input
            type="range"
            min={1}
            max={4}
            step={1}
            value={hops}
            onChange={e => onChange({ hops: parseInt(e.target.value, 10) })}
            className="control-slider"
          />
        </div>
      )}

      {/* Hubs Only Toggle (global only) */}
      {viewMode === 'global' && (
        <div className="control-group">
          <label className="control-checkbox">
            <input
              type="checkbox"
              checked={hubsOnly}
              onChange={e => onChange({ hubsOnly: e.target.checked })}
            />
            Hubs only
          </label>
        </div>
      )}

      {/* Apply Button */}
      <button className="btn btn-accent control-apply" onClick={onApply}>
        Apply
      </button>

      {/* Stats */}
      {stats && (
        <div className="control-stats">
          <h4>Statistics</h4>
          <div className="stat-row">
            <span>Total Nodes</span>
            <span>{stats.totalNodes.toLocaleString()}</span>
          </div>
          <div className="stat-row">
            <span>Total Edges</span>
            <span>{stats.totalEdges.toLocaleString()}</span>
          </div>
          <div className="stat-row">
            <span>Hubs</span>
            <span>{stats.byRole.hub.toLocaleString()}</span>
          </div>
          <div className="stat-row">
            <span>Leaves</span>
            <span>{stats.byRole.leaf.toLocaleString()}</span>
          </div>
          <hr className="stat-divider" />
          {Object.entries(stats.byType).map(([type, count]) => (
            <div className="stat-row" key={type}>
              <span className={`stat-type stat-type-${type}`}>
                {type === 'null' ? 'untyped' : type}
              </span>
              <span>{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Legend — uses centralized color palette */}
      <div className="control-legend">
        <h4>Legend</h4>
        <div className="legend-section">
          <span className="legend-subtitle">Node Types</span>
          {Object.entries(NODE_TYPE_PALETTES)
            .filter(([key]) => key !== 'null')
            .map(([type, palette]) => (
              <div className="legend-item" key={type}>
                <span
                  className="legend-dot"
                  style={{ backgroundColor: palette.base }}
                />
                <span className="legend-label">
                  {palette.icon} {palette.label}
                </span>
              </div>
            ))}
          {/* Untyped nodes */}
          <div className="legend-item">
            <span
              className="legend-dot"
              style={{ backgroundColor: NODE_TYPE_PALETTES.null.base }}
            />
            <span className="legend-label">
              {NODE_TYPE_PALETTES.null.icon} {NODE_TYPE_PALETTES.null.label}
            </span>
          </div>
        </div>
        <div className="legend-section">
          <span className="legend-subtitle">Node Roles</span>
          <div className="legend-item">
            <span
              className="legend-dot legend-dot-large"
              style={{
                backgroundColor: NODE_ROLE_PALETTES.hub.base,
                borderColor: NODE_ROLE_PALETTES.hub.border,
                borderWidth: 2,
                borderStyle: 'solid',
              }}
            />
            <span className="legend-label">
              {NODE_ROLE_PALETTES.hub.icon} {NODE_ROLE_PALETTES.hub.label}
            </span>
          </div>
          <div className="legend-item">
            <span
              className="legend-dot legend-dot-small"
              style={{ backgroundColor: NODE_ROLE_PALETTES.leaf.base }}
            />
            <span className="legend-label">
              {NODE_ROLE_PALETTES.leaf.icon} {NODE_ROLE_PALETTES.leaf.label}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
