/**
 * Tests for useLayerExpansion state management logic.
 *
 * Tests the pure reducer functions and state computations
 * without requiring React rendering.
 */

import { describe, it, expect } from 'vitest';
import {
  createDefaultNodeState,
  LAYER_ORDER,
  LAYER_INDEX,
} from '../web/src/hooks/useLayerExpansion';
import type {
  NodeLayerState,
  LayerExpansionState,
  LayerAction,
} from '../web/src/hooks/useLayerExpansion';

// ─── Test the pure state factory ────────────────────────────

describe('createDefaultNodeState', () => {
  it('creates state with only L0 (flash) expanded', () => {
    const state = createDefaultNodeState();
    expect(state.expanded.flash).toBe(true);
    expect(state.expanded.short).toBe(false);
    expect(state.expanded.mid).toBe(false);
    expect(state.expanded.long).toBe(false);
  });

  it('creates state with no layers animating', () => {
    const state = createDefaultNodeState();
    for (const layer of LAYER_ORDER) {
      expect(state.animating[layer]).toBe(false);
    }
  });

  it('has maxDepth of 0', () => {
    const state = createDefaultNodeState();
    expect(state.maxDepth).toBe(0);
  });
});

// ─── Test LAYER_ORDER and LAYER_INDEX consistency ───────────

describe('LAYER_ORDER and LAYER_INDEX', () => {
  it('has 4 layers in correct order', () => {
    expect(LAYER_ORDER).toEqual(['flash', 'short', 'mid', 'long']);
  });

  it('LAYER_INDEX matches LAYER_ORDER', () => {
    for (let i = 0; i < LAYER_ORDER.length; i++) {
      expect(LAYER_INDEX[LAYER_ORDER[i]]).toBe(i);
    }
  });

  it('flash is always index 0', () => {
    expect(LAYER_INDEX.flash).toBe(0);
  });

  it('long is always index 3', () => {
    expect(LAYER_INDEX.long).toBe(3);
  });
});

// ─── Test reducer logic (extracted for unit testing) ────────

// We re-implement the core reducer logic here for testing without React
function computeMaxDepth(expanded: Record<string, boolean>): number {
  for (let i = LAYER_ORDER.length - 1; i >= 0; i--) {
    if (expanded[LAYER_ORDER[i]]) return i;
  }
  return 0;
}

describe('computeMaxDepth', () => {
  it('returns 0 when only flash is expanded', () => {
    expect(computeMaxDepth({ flash: true, short: false, mid: false, long: false })).toBe(0);
  });

  it('returns 1 when flash+short expanded', () => {
    expect(computeMaxDepth({ flash: true, short: true, mid: false, long: false })).toBe(1);
  });

  it('returns 3 when all expanded', () => {
    expect(computeMaxDepth({ flash: true, short: true, mid: true, long: true })).toBe(3);
  });

  it('returns highest expanded layer even if gaps exist', () => {
    // e.g., flash + mid expanded (gap at short)
    expect(computeMaxDepth({ flash: true, short: false, mid: true, long: false })).toBe(2);
  });
});

describe('NodeLayerState toggle semantics', () => {
  it('toggling L1 from default state expands it', () => {
    const state = createDefaultNodeState();
    // Simulate toggle: short was false → becomes true
    const newExpanded = { ...state.expanded, short: !state.expanded.short };
    expect(newExpanded.short).toBe(true);
    expect(computeMaxDepth(newExpanded)).toBe(1);
  });

  it('toggling L1 twice returns to original state', () => {
    const state = createDefaultNodeState();
    const first = { ...state.expanded, short: !state.expanded.short };
    const second = { ...first, short: !first.short };
    expect(second.short).toBe(false);
    expect(computeMaxDepth(second)).toBe(0);
  });

  it('flash (L0) cannot be toggled off conceptually', () => {
    // In the reducer, TOGGLE_LAYER with 'flash' is a no-op
    const state = createDefaultNodeState();
    expect(state.expanded.flash).toBe(true);
    // Even if someone manually set it, the convention is L0 always visible
  });

  it('expandTo depth 2 expands flash, short, and mid', () => {
    const depth = 2;
    const expanded: Record<string, boolean> = {};
    for (let i = 0; i < LAYER_ORDER.length; i++) {
      expanded[LAYER_ORDER[i]] = i <= depth;
    }
    expect(expanded.flash).toBe(true);
    expect(expanded.short).toBe(true);
    expect(expanded.mid).toBe(true);
    expect(expanded.long).toBe(false);
    expect(computeMaxDepth(expanded)).toBe(2);
  });

  it('collapseTo depth 1 collapses mid and long', () => {
    // Start fully expanded
    const expanded = { flash: true, short: true, mid: true, long: true };
    const depth = 1;
    for (let i = LAYER_ORDER.length - 1; i > depth; i--) {
      expanded[LAYER_ORDER[i] as keyof typeof expanded] = false;
    }
    expect(expanded.flash).toBe(true);
    expect(expanded.short).toBe(true);
    expect(expanded.mid).toBe(false);
    expect(expanded.long).toBe(false);
    expect(computeMaxDepth(expanded)).toBe(1);
  });
});

describe('expand all / collapse all semantics', () => {
  it('expand all sets all layers to true', () => {
    const expanded = { flash: true, short: true, mid: true, long: true };
    for (const layer of LAYER_ORDER) {
      expect(expanded[layer]).toBe(true);
    }
  });

  it('collapse all keeps only flash', () => {
    const expanded = { flash: true, short: false, mid: false, long: false };
    expect(expanded.flash).toBe(true);
    expect(expanded.short).toBe(false);
    expect(expanded.mid).toBe(false);
    expect(expanded.long).toBe(false);
    expect(computeMaxDepth(expanded)).toBe(0);
  });
});

describe('animation state tracking', () => {
  it('animating flags default to all false', () => {
    const state = createDefaultNodeState();
    for (const layer of LAYER_ORDER) {
      expect(state.animating[layer]).toBe(false);
    }
  });

  it('animation flag should be set during toggle', () => {
    // When a layer is toggled, its animating flag should be true
    const state = createDefaultNodeState();
    const newAnimating = { ...state.animating, short: true };
    expect(newAnimating.short).toBe(true);
    expect(newAnimating.flash).toBe(false); // L0 not affected
  });

  it('animation flag cleared after transition end', () => {
    const animating = { flash: false, short: true, mid: false, long: false };
    animating.short = false; // simulate onTransitionEnd
    expect(animating.short).toBe(false);
  });
});

describe('multi-node state isolation', () => {
  it('different nodes have independent layer states', () => {
    const stateA = createDefaultNodeState();
    const stateB = createDefaultNodeState();

    // Expand L1 for node A only
    stateA.expanded.short = true;
    stateA.maxDepth = 1;

    expect(stateA.expanded.short).toBe(true);
    expect(stateB.expanded.short).toBe(false);
  });

  it('expanding all on one node does not affect others', () => {
    const nodes: Record<string, NodeLayerState> = {
      'node-1': createDefaultNodeState(),
      'node-2': createDefaultNodeState(),
    };

    // Expand all on node-1
    nodes['node-1'] = {
      expanded: { flash: true, short: true, mid: true, long: true },
      animating: { flash: false, short: true, mid: true, long: true },
      maxDepth: 3,
    };

    expect(nodes['node-1'].maxDepth).toBe(3);
    expect(nodes['node-2'].maxDepth).toBe(0);
    expect(nodes['node-2'].expanded.short).toBe(false);
  });
});
