/**
 * NodeTooltip — floating tooltip shown on node hover in graph views.
 *
 * Displays compact node info: label, type (with color badge), role, activation count, keywords.
 * Uses centralized color palette from config/node-colors.
 * Positioned near the cursor/node position.
 */

import type { GraphNode } from '../../hooks/useGraphData';
import {
  getNodeTypePalette,
  getNodeRolePalette,
  NODE_TYPE_ICONS,
  NODE_ROLE_ICONS,
} from '../../config/node-colors';

interface NodeTooltipProps {
  node: GraphNode;
  position: { x: number; y: number };
}

export function NodeTooltip({ node, position }: NodeTooltipProps) {
  const keywords = node.keywords?.split(' ').filter(Boolean).slice(0, 5) ?? [];
  const typePalette = getNodeTypePalette(node.nodeType);
  const rolePalette = getNodeRolePalette(node.nodeRole);

  return (
    <div
      className="graph-tooltip"
      style={{
        left: position.x + 15,
        top: position.y - 10,
      }}
    >
      <div className="tooltip-header">
        <span className="tooltip-role-icon">{NODE_ROLE_ICONS[node.nodeRole] ?? ''}</span>
        <span className="tooltip-label">{node.label}</span>
      </div>
      <div className="tooltip-meta">
        {/* Colored type badge with nodeType palette */}
        <span
          className="tooltip-type-badge"
          style={{
            backgroundColor: typePalette.dim,
            color: typePalette.light,
            borderLeft: `3px solid ${typePalette.base}`,
          }}
        >
          {NODE_TYPE_ICONS[node.nodeType ?? ''] ?? typePalette.icon} {node.nodeType ?? 'untyped'}
        </span>
        {/* Role badge */}
        <span
          className="tooltip-role-badge"
          style={{
            backgroundColor: rolePalette.border + '33',
            color: rolePalette.light,
          }}
        >
          {node.nodeRole}
        </span>
        <span className="tooltip-activation">
          {node.activationCount} activation{node.activationCount !== 1 ? 's' : ''}
        </span>
      </div>
      {keywords.length > 0 && (
        <div className="tooltip-keywords">
          {keywords.map((kw, i) => (
            <span key={i} className="tooltip-kw">{kw}</span>
          ))}
        </div>
      )}
    </div>
  );
}
