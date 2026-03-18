/**
 * useLayerExpansion — State management for MemoryNode 4-layer progressive depth
 * expand/collapse toggle.
 *
 * Manages which depth layers (L0–L3) are expanded for each node,
 * supports bulk expand/collapse, and tracks animation transition states.
 *
 * Layer hierarchy:
 *   L0 (flash)  — always visible (anchor/keywords/embedding)
 *   L1 (short)  — JSON metadata (entities, SPO triples, etc.)
 *   L2 (mid)    — human-readable summary
 *   L3 (long)   — source turn references
 */

import { useCallback, useReducer, useRef } from 'react';
import type { DepthLayer } from '../types/timeline';

// ─── Types ──────────────────────────────────────────────────

/** Ordered layers from shallowest to deepest */
export const LAYER_ORDER: readonly DepthLayer[] = ['flash', 'short', 'mid', 'long'] as const;

/** Numeric index for each depth layer */
export const LAYER_INDEX: Readonly<Record<DepthLayer, number>> = {
  flash: 0,
  short: 1,
  mid: 2,
  long: 3,
};

/** Expansion state for a single node */
export interface NodeLayerState {
  /** Which layers are currently expanded (L0 always true) */
  expanded: Record<DepthLayer, boolean>;
  /** Which layers are currently animating (for transition CSS class) */
  animating: Record<DepthLayer, boolean>;
  /** The deepest currently expanded layer index (0-3) */
  maxDepth: number;
}

/** Actions for the layer expansion reducer */
export type LayerAction =
  | { type: 'TOGGLE_LAYER'; nodeId: string; layer: DepthLayer }
  | { type: 'EXPAND_TO'; nodeId: string; depth: number }
  | { type: 'COLLAPSE_TO'; nodeId: string; depth: number }
  | { type: 'EXPAND_ALL'; nodeId: string }
  | { type: 'COLLAPSE_ALL'; nodeId: string }
  | { type: 'EXPAND_ALL_NODES' }
  | { type: 'COLLAPSE_ALL_NODES' }
  | { type: 'SET_ANIMATING'; nodeId: string; layer: DepthLayer; value: boolean }
  | { type: 'REMOVE_NODE'; nodeId: string };

/** Full state: maps node IDs to their layer expansion states */
export type LayerExpansionState = Record<string, NodeLayerState>;

// ─── Default State Factory ──────────────────────────────────

/** Create default state for a node (only L0 expanded) */
export function createDefaultNodeState(): NodeLayerState {
  return {
    expanded: { flash: true, short: false, mid: false, long: false },
    animating: { flash: false, short: false, mid: false, long: false },
    maxDepth: 0,
  };
}

/** Get or create node state from the expansion state map */
function getNodeState(state: LayerExpansionState, nodeId: string): NodeLayerState {
  return state[nodeId] ?? createDefaultNodeState();
}

/** Compute maxDepth from expanded map */
function computeMaxDepth(expanded: Record<DepthLayer, boolean>): number {
  for (let i = LAYER_ORDER.length - 1; i >= 0; i--) {
    if (expanded[LAYER_ORDER[i]]) return i;
  }
  return 0;
}

// ─── Reducer ────────────────────────────────────────────────

function layerExpansionReducer(
  state: LayerExpansionState,
  action: LayerAction,
): LayerExpansionState {
  switch (action.type) {
    case 'TOGGLE_LAYER': {
      const { nodeId, layer } = action;
      // L0 (flash) is always visible, cannot be collapsed
      if (layer === 'flash') return state;

      const prev = getNodeState(state, nodeId);
      const newExpanded = { ...prev.expanded, [layer]: !prev.expanded[layer] };
      const newAnimating = { ...prev.animating, [layer]: true };

      return {
        ...state,
        [nodeId]: {
          expanded: newExpanded,
          animating: newAnimating,
          maxDepth: computeMaxDepth(newExpanded),
        },
      };
    }

    case 'EXPAND_TO': {
      const { nodeId, depth } = action;
      const clampedDepth = Math.max(0, Math.min(3, depth));
      const prev = getNodeState(state, nodeId);
      const newExpanded = { ...prev.expanded };
      const newAnimating = { ...prev.animating };

      for (let i = 0; i < LAYER_ORDER.length; i++) {
        const shouldExpand = i <= clampedDepth;
        if (newExpanded[LAYER_ORDER[i]] !== shouldExpand) {
          newAnimating[LAYER_ORDER[i]] = true;
        }
        newExpanded[LAYER_ORDER[i]] = shouldExpand;
      }

      return {
        ...state,
        [nodeId]: {
          expanded: newExpanded,
          animating: newAnimating,
          maxDepth: clampedDepth,
        },
      };
    }

    case 'COLLAPSE_TO': {
      const { nodeId, depth } = action;
      const clampedDepth = Math.max(0, Math.min(3, depth));
      const prev = getNodeState(state, nodeId);
      const newExpanded = { ...prev.expanded };
      const newAnimating = { ...prev.animating };

      for (let i = LAYER_ORDER.length - 1; i > clampedDepth; i--) {
        if (newExpanded[LAYER_ORDER[i]]) {
          newAnimating[LAYER_ORDER[i]] = true;
        }
        newExpanded[LAYER_ORDER[i]] = false;
      }

      return {
        ...state,
        [nodeId]: {
          expanded: newExpanded,
          animating: newAnimating,
          maxDepth: computeMaxDepth(newExpanded),
        },
      };
    }

    case 'EXPAND_ALL': {
      const { nodeId } = action;
      const prev = getNodeState(state, nodeId);
      const newAnimating = { ...prev.animating };
      for (const layer of LAYER_ORDER) {
        if (!prev.expanded[layer]) newAnimating[layer] = true;
      }

      return {
        ...state,
        [nodeId]: {
          expanded: { flash: true, short: true, mid: true, long: true },
          animating: newAnimating,
          maxDepth: 3,
        },
      };
    }

    case 'COLLAPSE_ALL': {
      const { nodeId } = action;
      const prev = getNodeState(state, nodeId);
      const newAnimating = { ...prev.animating };
      for (const layer of LAYER_ORDER) {
        if (layer !== 'flash' && prev.expanded[layer]) {
          newAnimating[layer] = true;
        }
      }

      return {
        ...state,
        [nodeId]: {
          expanded: { flash: true, short: false, mid: false, long: false },
          animating: newAnimating,
          maxDepth: 0,
        },
      };
    }

    case 'EXPAND_ALL_NODES': {
      const next: LayerExpansionState = {};
      for (const nodeId of Object.keys(state)) {
        const prev = state[nodeId];
        const newAnimating = { ...prev.animating };
        for (const layer of LAYER_ORDER) {
          if (!prev.expanded[layer]) newAnimating[layer] = true;
        }
        next[nodeId] = {
          expanded: { flash: true, short: true, mid: true, long: true },
          animating: newAnimating,
          maxDepth: 3,
        };
      }
      return next;
    }

    case 'COLLAPSE_ALL_NODES': {
      const next: LayerExpansionState = {};
      for (const nodeId of Object.keys(state)) {
        const prev = state[nodeId];
        const newAnimating = { ...prev.animating };
        for (const layer of LAYER_ORDER) {
          if (layer !== 'flash' && prev.expanded[layer]) {
            newAnimating[layer] = true;
          }
        }
        next[nodeId] = {
          expanded: { flash: true, short: false, mid: false, long: false },
          animating: newAnimating,
          maxDepth: 0,
        };
      }
      return next;
    }

    case 'SET_ANIMATING': {
      const { nodeId, layer, value } = action;
      const prev = getNodeState(state, nodeId);
      return {
        ...state,
        [nodeId]: {
          ...prev,
          animating: { ...prev.animating, [layer]: value },
        },
      };
    }

    case 'REMOVE_NODE': {
      const { [action.nodeId]: _, ...rest } = state;
      return rest;
    }

    default:
      return state;
  }
}

// ─── Hook ───────────────────────────────────────────────────

export interface UseLayerExpansionReturn {
  /** Current expansion state for all tracked nodes */
  state: LayerExpansionState;

  /** Get layer state for a specific node (returns default if not tracked) */
  getNodeState: (nodeId: string) => NodeLayerState;

  /** Toggle a single layer's expand/collapse for a node */
  toggleLayer: (nodeId: string, layer: DepthLayer) => void;

  /** Expand a node to a specific depth (0-3), expanding all layers up to that depth */
  expandTo: (nodeId: string, depth: number) => void;

  /** Collapse a node to a specific depth, collapsing all deeper layers */
  collapseTo: (nodeId: string, depth: number) => void;

  /** Expand all layers for a node */
  expandAll: (nodeId: string) => void;

  /** Collapse all layers for a node (L0 stays visible) */
  collapseAll: (nodeId: string) => void;

  /** Expand all layers for all tracked nodes */
  expandAllNodes: () => void;

  /** Collapse all tracked nodes to L0 only */
  collapseAllNodes: () => void;

  /** Clear animating flag after transition completes */
  onTransitionEnd: (nodeId: string, layer: DepthLayer) => void;

  /** Remove a node from tracking */
  removeNode: (nodeId: string) => void;

  /** Check if a layer is expanded for a node */
  isExpanded: (nodeId: string, layer: DepthLayer) => boolean;

  /** Check if a layer is currently animating */
  isAnimating: (nodeId: string, layer: DepthLayer) => boolean;

  /** Get the max expanded depth for a node (0-3) */
  getMaxDepth: (nodeId: string) => number;
}

export function useLayerExpansion(): UseLayerExpansionReturn {
  const [state, dispatch] = useReducer(layerExpansionReducer, {} as LayerExpansionState);

  // Stable refs for animation timeout cleanup
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const getNodeStateFn = useCallback(
    (nodeId: string) => getNodeState(state, nodeId),
    [state],
  );

  const toggleLayer = useCallback((nodeId: string, layer: DepthLayer) => {
    dispatch({ type: 'TOGGLE_LAYER', nodeId, layer });
    scheduleAnimationClear(nodeId, layer, timeoutsRef);
  }, []);

  const expandTo = useCallback((nodeId: string, depth: number) => {
    dispatch({ type: 'EXPAND_TO', nodeId, depth });
    // Clear animations for all affected layers
    for (const layer of LAYER_ORDER) {
      scheduleAnimationClear(nodeId, layer, timeoutsRef);
    }
  }, []);

  const collapseTo = useCallback((nodeId: string, depth: number) => {
    dispatch({ type: 'COLLAPSE_TO', nodeId, depth });
    for (const layer of LAYER_ORDER) {
      scheduleAnimationClear(nodeId, layer, timeoutsRef);
    }
  }, []);

  const expandAll = useCallback((nodeId: string) => {
    dispatch({ type: 'EXPAND_ALL', nodeId });
    for (const layer of LAYER_ORDER) {
      scheduleAnimationClear(nodeId, layer, timeoutsRef);
    }
  }, []);

  const collapseAll = useCallback((nodeId: string) => {
    dispatch({ type: 'COLLAPSE_ALL', nodeId });
    for (const layer of LAYER_ORDER) {
      scheduleAnimationClear(nodeId, layer, timeoutsRef);
    }
  }, []);

  const expandAllNodes = useCallback(() => {
    dispatch({ type: 'EXPAND_ALL_NODES' });
  }, []);

  const collapseAllNodes = useCallback(() => {
    dispatch({ type: 'COLLAPSE_ALL_NODES' });
  }, []);

  const onTransitionEnd = useCallback((nodeId: string, layer: DepthLayer) => {
    dispatch({ type: 'SET_ANIMATING', nodeId, layer, value: false });
  }, []);

  const removeNode = useCallback((nodeId: string) => {
    dispatch({ type: 'REMOVE_NODE', nodeId });
    // Clean up any pending timeouts for this node
    for (const layer of LAYER_ORDER) {
      const key = `${nodeId}:${layer}`;
      const existing = timeoutsRef.current.get(key);
      if (existing) {
        clearTimeout(existing);
        timeoutsRef.current.delete(key);
      }
    }
  }, []);

  const isExpanded = useCallback(
    (nodeId: string, layer: DepthLayer) => getNodeState(state, nodeId).expanded[layer],
    [state],
  );

  const isAnimating = useCallback(
    (nodeId: string, layer: DepthLayer) => getNodeState(state, nodeId).animating[layer],
    [state],
  );

  const getMaxDepth = useCallback(
    (nodeId: string) => getNodeState(state, nodeId).maxDepth,
    [state],
  );

  return {
    state,
    getNodeState: getNodeStateFn,
    toggleLayer,
    expandTo,
    collapseTo,
    expandAll,
    collapseAll,
    expandAllNodes,
    collapseAllNodes,
    onTransitionEnd,
    removeNode,
    isExpanded,
    isAnimating,
    getMaxDepth,
  };
}

// ─── Internal Helpers ───────────────────────────────────────

/**
 * Schedule clearing the animating flag after CSS transition completes.
 * Uses a 350ms timeout (matching CSS transition duration).
 */
function scheduleAnimationClear(
  nodeId: string,
  layer: DepthLayer,
  timeoutsRef: React.RefObject<Map<string, ReturnType<typeof setTimeout>>>,
) {
  const key = `${nodeId}:${layer}`;
  const existing = timeoutsRef.current!.get(key);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(() => {
    // Note: We don't dispatch here — onTransitionEnd should be called from
    // the actual CSS transitionend event for better accuracy.
    // This is a fallback cleanup.
    timeoutsRef.current!.delete(key);
  }, 400);

  timeoutsRef.current!.set(key, timeout);
}
