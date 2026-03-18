/**
 * LayoutControls — FA2 layout animation controls for sigma.js graph views.
 *
 * Provides:
 * - Play/pause toggle for animated ForceAtlas2 layout
 * - Re-layout button (resets positions and re-applies FA2)
 * - Visual indicator when layout is running
 *
 * Must be rendered inside <SigmaContainer>.
 */

import { useForceAtlas2, type UseForceAtlas2Options } from '../../hooks/useForceAtlas2';

interface LayoutControlsProps {
  viewMode?: 'global' | 'local';
  centerNodeId?: string;
  /** Auto-start layout animation on mount */
  autoStart?: boolean;
}

export function LayoutControls({
  viewMode = 'global',
  centerNodeId,
  autoStart = false,
}: LayoutControlsProps) {
  const { isRunning, toggle, relayout } = useForceAtlas2({
    viewMode,
    centerNodeId,
    autoStart,
    autoStopTimeout: 5000,
  });

  return (
    <div className="layout-controls">
      <button
        className={`layout-ctrl-btn ${isRunning ? 'layout-ctrl-active' : ''}`}
        onClick={toggle}
        title={isRunning ? 'Stop layout animation' : 'Start layout animation'}
      >
        {isRunning ? '⏸' : '▶'}
      </button>
      <button
        className="layout-ctrl-btn"
        onClick={relayout}
        title="Re-layout (reset positions)"
        disabled={isRunning}
      >
        ⟳
      </button>
      {isRunning && (
        <span className="layout-running-indicator">
          <span className="layout-pulse" />
          FA2
        </span>
      )}
    </div>
  );
}
