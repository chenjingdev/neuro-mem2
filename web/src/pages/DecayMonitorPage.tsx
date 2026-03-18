/**
 * DecayMonitorPage — Full-page decay monitoring dashboard.
 *
 * Composes two main components:
 *   1. DecaySimulationChart — Interactive decay simulation with parameter controls
 *   2. EdgeMonitorPanel — Real-time edge weight/shield monitoring table
 *
 * Features:
 *   - Tab navigation between Simulation and Edge Monitor views
 *   - Both views available simultaneously in split mode (wide screens)
 *   - Navigation back to chat, graph explorer, and memory explorer
 */

import { useState, useCallback } from 'react';
import { DecaySimulationChart } from '../components/DecaySimulationChart';
import { EdgeMonitorPanel } from '../components/EdgeMonitorPanel';

// ─── Types ──────────────────────────────────────────────────

type TabMode = 'simulation' | 'monitor' | 'split';

interface DecayMonitorPageProps {
  /** Navigate back to chat */
  onNavigateToChat?: () => void;
  /** Navigate to memory explorer */
  onNavigateToExplorer?: () => void;
  /** Navigate to graph explorer, optionally focusing on a node */
  onNavigateToGraph?: (nodeId?: string) => void;
}

// ─── Main Page Component ─────────────────────────────────────

export function DecayMonitorPage({
  onNavigateToChat,
  onNavigateToExplorer,
  onNavigateToGraph,
}: DecayMonitorPageProps) {
  const [activeTab, setActiveTab] = useState<TabMode>('simulation');

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      onNavigateToGraph?.(nodeId);
    },
    [onNavigateToGraph],
  );

  return (
    <div className="dmp-container">
      {/* Header */}
      <header className="dmp-header">
        <div className="dmp-header-left">
          {onNavigateToChat && (
            <button className="btn-back-to-chat" onClick={onNavigateToChat} title="Back to Chat">
              &#9664; Chat
            </button>
          )}
          <h1 className="app-title">&#128201; Decay Monitor</h1>
        </div>

        <div className="dmp-header-center">
          <div className="dmp-tab-bar">
            <button
              className={`dmp-tab-btn ${activeTab === 'simulation' ? 'dmp-tab-active' : ''}`}
              onClick={() => setActiveTab('simulation')}
            >
              &#128200; Simulation
            </button>
            <button
              className={`dmp-tab-btn ${activeTab === 'monitor' ? 'dmp-tab-active' : ''}`}
              onClick={() => setActiveTab('monitor')}
            >
              &#128268; Edge Monitor
            </button>
            <button
              className={`dmp-tab-btn ${activeTab === 'split' ? 'dmp-tab-active' : ''}`}
              onClick={() => setActiveTab('split')}
            >
              &#9638; Split View
            </button>
          </div>
        </div>

        <div className="dmp-header-right">
          {onNavigateToExplorer && (
            <button className="btn btn-nav" onClick={onNavigateToExplorer} title="Memory Explorer">
              &#128203; Explorer
            </button>
          )}
          {onNavigateToGraph && (
            <button className="btn btn-nav" onClick={() => onNavigateToGraph()} title="Graph Explorer">
              &#128376;&#65039; Graph
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className={`dmp-body ${activeTab === 'split' ? 'dmp-body-split' : ''}`}>
        {/* Simulation Tab */}
        {(activeTab === 'simulation' || activeTab === 'split') && (
          <div className={`dmp-panel ${activeTab === 'split' ? 'dmp-panel-half' : 'dmp-panel-full'}`}>
            <DecaySimulationChart compact={activeTab === 'split'} />
          </div>
        )}

        {/* Edge Monitor Tab */}
        {(activeTab === 'monitor' || activeTab === 'split') && (
          <div className={`dmp-panel ${activeTab === 'split' ? 'dmp-panel-half' : 'dmp-panel-full'}`}>
            <EdgeMonitorPanel
              onNodeClick={handleNodeClick}
              autoRefreshMs={5000}
            />
          </div>
        )}
      </div>
    </div>
  );
}
