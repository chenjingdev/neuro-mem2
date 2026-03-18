/**
 * Centralized color palette configuration for MemoryNode visualization.
 *
 * Single source of truth for all nodeType and nodeRole color definitions.
 * Used by sigma.js graph rendering, tooltips, cards, legends, and CSS.
 *
 * Each nodeType has a full palette with base, light, dark, and dim variants:
 * - base: primary color used for sigma.js node fill
 * - light: lighter variant for highlights, hover states, backgrounds
 * - dark: darker variant for borders, shadows
 * - dim: low-opacity variant for dimmed/inactive states
 * - label: text color label representation
 */

// ─── Palette Types ────────────────────────────────────────────

export interface NodeColorPalette {
  /** Primary fill color (sigma.js node, badges) */
  base: string;
  /** Lighter variant for hover/highlight backgrounds */
  light: string;
  /** Darker variant for borders, outlines */
  dark: string;
  /** Low-opacity dimmed state */
  dim: string;
  /** Human-readable label (한영) */
  label: string;
  /** Icon/emoji representation */
  icon: string;
}

export interface RoleColorPalette {
  /** Primary color for role */
  base: string;
  /** Lighter variant */
  light: string;
  /** Border color used for hub ring effect */
  border: string;
  /** Label */
  label: string;
  /** Icon */
  icon: string;
}

// ─── Node Type Color Palettes ─────────────────────────────────

/**
 * Color palettes for each MemoryNode type.
 * Colors are chosen for:
 * - High contrast on dark backgrounds (#1a1a2e)
 * - Distinct hue separation between types
 * - Accessibility (WCAG AA contrast ratios)
 * - Visual harmony in graph layouts
 */
export const NODE_TYPE_PALETTES: Record<string, NodeColorPalette> = {
  semantic: {
    base: '#4a9eff',
    light: '#7ab8ff',
    dark: '#2a7edf',
    dim: 'rgba(74, 158, 255, 0.25)',
    label: 'Semantic (의미)',
    icon: '\u{1F4DA}', // 📚
  },
  episodic: {
    base: '#ff7675',
    light: '#ff9999',
    dark: '#e05555',
    dim: 'rgba(255, 118, 117, 0.25)',
    label: 'Episodic (에피소드)',
    icon: '\u{1F4C5}', // 📅
  },
  procedural: {
    base: '#00b894',
    light: '#55d4b4',
    dark: '#009874',
    dim: 'rgba(0, 184, 148, 0.25)',
    label: 'Procedural (절차)',
    icon: '\u2699\uFE0F', // ⚙️
  },
  prospective: {
    base: '#fdcb6e',
    light: '#fedd9a',
    dark: '#ddb04e',
    dim: 'rgba(253, 203, 110, 0.25)',
    label: 'Prospective (전망)',
    icon: '\u{1F3AF}', // 🎯
  },
  emotional: {
    base: '#e84393',
    light: '#f06baf',
    dark: '#c82373',
    dim: 'rgba(232, 67, 147, 0.25)',
    label: 'Emotional (감정)',
    icon: '\u{1F4AD}', // 💭
  },
  null: {
    base: '#8b8b9e',
    light: '#a5a5b5',
    dark: '#6b6b7e',
    dim: 'rgba(139, 139, 158, 0.25)',
    label: 'Untyped (미분류)',
    icon: '\u2753', // ❓
  },
};

// ─── Node Role Color Palettes ──────────────────────────────────

export const NODE_ROLE_PALETTES: Record<string, RoleColorPalette> = {
  hub: {
    base: '#6c5ce7',
    light: '#8c7cf7',
    border: '#a29bfe',
    label: 'Hub (허브)',
    icon: '\u{1F517}', // 🔗
  },
  leaf: {
    base: '#00cec9',
    light: '#55e8e4',
    border: '#81ecec',
    label: 'Leaf (리프)',
    icon: '\u{1F343}', // 🍃
  },
};

// ─── Convenience Accessors ─────────────────────────────────────

/** Flat color map: nodeType → base color (for sigma.js NODE_TYPE_COLORS compatibility) */
export const NODE_TYPE_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_TYPE_PALETTES).map(([k, v]) => [k, v.base]),
);

/** Flat color map: nodeRole → base color */
export const NODE_ROLE_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_ROLE_PALETTES).map(([k, v]) => [k, v.base]),
);

/** Flat icon map: nodeType → emoji */
export const NODE_TYPE_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_TYPE_PALETTES).map(([k, v]) => [k, v.icon]),
);

/** Flat icon map: nodeRole → emoji */
export const NODE_ROLE_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_ROLE_PALETTES).map(([k, v]) => [k, v.icon]),
);

// ─── Sigma.js Node Color Resolver ──────────────────────────────

/**
 * Resolve the sigma.js fill color for a node based on its type and role.
 *
 * Priority:
 *  1. nodeType base color (if type is known)
 *  2. nodeRole base color (fallback for untyped hubs)
 *  3. null palette base color (ultimate fallback)
 */
export function resolveNodeColor(
  nodeType: string | null | undefined,
  nodeRole?: string,
): string {
  const typeKey = nodeType ?? 'null';
  const palette = NODE_TYPE_PALETTES[typeKey];
  if (palette && typeKey !== 'null') return palette.base;

  // For null-typed nodes, use role color if hub
  if (nodeRole === 'hub') return NODE_ROLE_PALETTES.hub.base;

  return NODE_TYPE_PALETTES.null.base;
}

/**
 * Resolve the hub border/ring color.
 * Returns a border color if the node is a hub, null otherwise.
 */
export function resolveHubBorderColor(nodeRole?: string): string | null {
  if (nodeRole === 'hub') return NODE_ROLE_PALETTES.hub.border;
  return null;
}

/**
 * Get the dim color for a nodeType (used when other nodes are highlighted).
 */
export function resolveDimColor(nodeType: string | null | undefined): string {
  const typeKey = nodeType ?? 'null';
  return NODE_TYPE_PALETTES[typeKey]?.dim ?? NODE_TYPE_PALETTES.null.dim;
}

/**
 * Get the palette for a nodeType.
 */
export function getNodeTypePalette(nodeType: string | null | undefined): NodeColorPalette {
  return NODE_TYPE_PALETTES[nodeType ?? 'null'] ?? NODE_TYPE_PALETTES.null;
}

/**
 * Get the palette for a nodeRole.
 */
export function getNodeRolePalette(nodeRole: string | undefined): RoleColorPalette {
  return NODE_ROLE_PALETTES[nodeRole ?? 'leaf'] ?? NODE_ROLE_PALETTES.leaf;
}

// ─── Edge Color ─────────────────────────────────────────────────

/**
 * Compute edge color with opacity based on weight (0-100 scale).
 */
export function computeEdgeColor(weight: number): string {
  const alpha = Math.max(0.15, Math.min(0.8, weight / 100));
  return `rgba(120, 140, 180, ${alpha})`;
}

/**
 * Highlighted edge color.
 */
export const EDGE_HIGHLIGHT_COLOR = '#4a9eff';

/**
 * Dimmed edge color.
 */
export const EDGE_DIM_COLOR = 'rgba(40, 40, 70, 0.2)';

/**
 * Hub-connected edge color (local explorer).
 */
export const EDGE_HUB_COLOR = '#6c5ce7';

// ─── CSS Variable Generator ──────────────────────────────────────

/**
 * Generate CSS custom property declarations for all node type colors.
 * Useful for injecting into :root or component-level styles.
 *
 * Example output:
 *   --node-semantic: #4a9eff;
 *   --node-semantic-light: #7ab8ff;
 *   --node-semantic-dark: #2a7edf;
 *   --node-semantic-dim: rgba(74, 158, 255, 0.25);
 */
export function generateCSSVariables(): string {
  const lines: string[] = [];

  for (const [type, palette] of Object.entries(NODE_TYPE_PALETTES)) {
    const prefix = type === 'null' ? '--node-untyped' : `--node-${type}`;
    lines.push(`${prefix}: ${palette.base};`);
    lines.push(`${prefix}-light: ${palette.light};`);
    lines.push(`${prefix}-dark: ${palette.dark};`);
    lines.push(`${prefix}-dim: ${palette.dim};`);
  }

  for (const [role, palette] of Object.entries(NODE_ROLE_PALETTES)) {
    lines.push(`--role-${role}: ${palette.base};`);
    lines.push(`--role-${role}-light: ${palette.light};`);
    lines.push(`--role-${role}-border: ${palette.border};`);
  }

  return lines.join('\n  ');
}
