/**
 * useForceAtlas2 — React hook for animated ForceAtlas2 layout.
 *
 * Provides both synchronous (one-shot) and animated (worker-based) layout
 * for sigma.js graph visualization.
 *
 * Features:
 * - Worker-based FA2 for smooth animated layout (non-blocking UI)
 * - Auto-stop after convergence timeout
 * - Manual start/stop/toggle controls
 * - Falls back to synchronous layout if worker is unavailable
 * - Adaptive parameters based on graph size (delegates to graphUtils)
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useSigma } from '@react-sigma/core';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { applyLayout, type FA2LayoutOptions } from '../components/graph/graphUtils';

export interface UseForceAtlas2Options {
  /** Auto-start animated layout on mount. Default: false */
  autoStart?: boolean;
  /** Auto-stop after this many ms. Default: 5000 (5s) */
  autoStopTimeout?: number;
  /** View mode for parameter tuning */
  viewMode?: 'global' | 'local';
  /** Center node id (for local view pinning) */
  centerNodeId?: string;
}

export interface UseForceAtlas2Result {
  /** Whether animated layout is currently running */
  isRunning: boolean;
  /** Start animated layout */
  start: () => void;
  /** Stop animated layout */
  stop: () => void;
  /** Toggle animated layout on/off */
  toggle: () => void;
  /** Re-apply synchronous layout (one-shot, resets positions) */
  relayout: () => void;
}

/**
 * Size-tier parameter resolver (mirrors graphUtils but returns raw settings
 * for the worker supervisor).
 */
function resolveWorkerSettings(nodeCount: number, viewMode: 'global' | 'local') {
  const isLocal = viewMode === 'local';

  // Simplified tier resolution
  let gravity: number, scalingRatio: number, slowDown: number, linLogMode: boolean, barnesHutOptimize: boolean, barnesHutTheta: number;

  if (nodeCount <= 50) {
    gravity = 3.0; scalingRatio = 2; slowDown = 1; linLogMode = false; barnesHutOptimize = false; barnesHutTheta = 0.5;
  } else if (nodeCount <= 500) {
    gravity = 1.5; scalingRatio = 5; slowDown = 1; linLogMode = false; barnesHutOptimize = false; barnesHutTheta = 0.5;
  } else if (nodeCount <= 2000) {
    gravity = 1.0; scalingRatio = 8; slowDown = 1.5; linLogMode = false; barnesHutOptimize = true; barnesHutTheta = 0.5;
  } else if (nodeCount <= 10000) {
    gravity = 0.5; scalingRatio = 12; slowDown = 2; linLogMode = true; barnesHutOptimize = true; barnesHutTheta = 0.6;
  } else {
    gravity = 0.3; scalingRatio = 20; slowDown = 3; linLogMode = true; barnesHutOptimize = true; barnesHutTheta = 0.8;
  }

  // Local view adjustments
  if (isLocal) {
    gravity *= 2.5;
    scalingRatio = Math.max(2, scalingRatio * 0.6);
    slowDown = Math.max(slowDown, 2);
  }

  return {
    gravity,
    scalingRatio,
    barnesHutOptimize,
    barnesHutTheta,
    strongGravityMode: isLocal,
    slowDown,
    edgeWeightInfluence: 1,
    linLogMode,
    adjustSizes: false,
  };
}

export function useForceAtlas2(options?: UseForceAtlas2Options): UseForceAtlas2Result {
  const {
    autoStart = false,
    autoStopTimeout = 5000,
    viewMode = 'global',
    centerNodeId,
  } = options ?? {};

  const sigma = useSigma();
  const supervisorRef = useRef<FA2Layout | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // Cleanup supervisor on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (supervisorRef.current) {
        try {
          supervisorRef.current.kill();
        } catch { /* ignore */ }
        supervisorRef.current = null;
      }
    };
  }, []);

  const start = useCallback(() => {
    const graph = sigma.getGraph();
    if (!graph || graph.order <= 1) return;

    // Kill existing supervisor
    if (supervisorRef.current) {
      try { supervisorRef.current.kill(); } catch { /* ignore */ }
      supervisorRef.current = null;
    }

    // Pin center node for local view
    if (centerNodeId && graph.hasNode(centerNodeId)) {
      graph.setNodeAttribute(centerNodeId, 'fixed', true);
    }

    const settings = resolveWorkerSettings(graph.order, viewMode);

    try {
      const supervisor = new FA2Layout(graph, {
        settings,
        getEdgeWeight: 'weight',
      });
      supervisorRef.current = supervisor;
      supervisor.start();
      setIsRunning(true);

      // Auto-stop after timeout
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (supervisorRef.current?.isRunning()) {
          supervisorRef.current.stop();
          setIsRunning(false);

          // Unpin center node
          if (centerNodeId && graph.hasNode(centerNodeId)) {
            graph.removeNodeAttribute(centerNodeId, 'fixed');
          }
        }
      }, autoStopTimeout);
    } catch (err) {
      console.warn('[useForceAtlas2] Worker failed, falling back to sync:', err);
      // Fallback to synchronous layout
      applyLayout(graph, { viewMode, centerNodeId });
      setIsRunning(false);
    }
  }, [sigma, viewMode, centerNodeId, autoStopTimeout]);

  const stop = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (supervisorRef.current?.isRunning()) {
      supervisorRef.current.stop();

      // Unpin center node
      const graph = sigma.getGraph();
      if (centerNodeId && graph.hasNode(centerNodeId)) {
        graph.removeNodeAttribute(centerNodeId, 'fixed');
      }
    }
    setIsRunning(false);
  }, [sigma, centerNodeId]);

  const toggle = useCallback(() => {
    if (isRunning) {
      stop();
    } else {
      start();
    }
  }, [isRunning, start, stop]);

  const relayout = useCallback(() => {
    // Stop any running animation first
    stop();

    const graph = sigma.getGraph();
    if (!graph || graph.order <= 1) return;

    // Randomize positions first for a fresh layout
    const spread = Math.sqrt(graph.order) * 10;
    graph.forEachNode((nodeId) => {
      const isCenter = nodeId === centerNodeId;
      graph.setNodeAttribute(nodeId, 'x', isCenter ? 0 : (Math.random() - 0.5) * spread);
      graph.setNodeAttribute(nodeId, 'y', isCenter ? 0 : (Math.random() - 0.5) * spread);
    });

    // Apply synchronous layout
    applyLayout(graph, { viewMode, centerNodeId });

    // Refresh sigma to show new positions
    sigma.refresh();
  }, [sigma, stop, viewMode, centerNodeId]);

  // Auto-start if requested
  useEffect(() => {
    if (autoStart) {
      // Small delay to let sigma initialize
      const t = setTimeout(start, 100);
      return () => clearTimeout(t);
    }
  }, [autoStart, start]);

  return {
    isRunning,
    start,
    stop,
    toggle,
    relayout,
  };
}
