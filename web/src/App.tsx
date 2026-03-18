import { useState, useCallback } from 'react';
import { ChatPage } from './pages/ChatPage';
import { MemoryExplorerPage } from './pages/MemoryExplorerPage';
import { GraphExplorerPage } from './pages/GraphExplorerPage';
import { GraphMapPage } from './pages/GraphMapPage';
import { DecayMonitorPage } from './pages/DecayMonitorPage';

/**
 * App — root component for the nero-mem2 Visual Debug UI.
 *
 * Supports five views:
 *   1. ChatPage — SSE streaming chat with pipeline trace visualization
 *   2. MemoryExplorerPage — layer-by-layer memory node exploration
 *   3. GraphExplorerPage — sigma.js local graph exploration (ego-network)
 *   4. GraphMapPage — sigma.js global map visualization (全체 맵)
 *   5. DecayMonitorPage — decay simulation chart + edge weight/shield monitor
 *
 * Simple client-side routing via state (no React Router needed).
 */

type AppView = 'chat' | 'memory-explorer' | 'graph-explorer' | 'graph-map' | 'decay-monitor';

interface GraphExplorerState {
  initialNodeId?: string;
}

export function App() {
  const [view, setView] = useState<AppView>('chat');
  const [graphState, setGraphState] = useState<GraphExplorerState>({});

  const navigateToChat = useCallback(() => setView('chat'), []);
  const navigateToExplorer = useCallback(() => setView('memory-explorer'), []);
  const navigateToGraph = useCallback((nodeId?: string) => {
    setGraphState({ initialNodeId: nodeId });
    setView('graph-explorer');
  }, []);
  const navigateToGlobalMap = useCallback(() => setView('graph-map'), []);
  const navigateToDecayMonitor = useCallback(() => setView('decay-monitor'), []);

  if (view === 'decay-monitor') {
    return (
      <DecayMonitorPage
        onNavigateToChat={navigateToChat}
        onNavigateToExplorer={navigateToExplorer}
        onNavigateToGraph={navigateToGraph}
      />
    );
  }

  if (view === 'graph-map') {
    return (
      <GraphMapPage
        onNavigateToChat={navigateToChat}
        onNavigateToExplorer={navigateToExplorer}
      />
    );
  }

  if (view === 'graph-explorer') {
    return (
      <GraphExplorerPage
        onNavigateToChat={navigateToChat}
        onNavigateToExplorer={navigateToExplorer}
        initialNodeId={graphState.initialNodeId}
      />
    );
  }

  if (view === 'memory-explorer') {
    return <MemoryExplorerPage onNavigateToChat={navigateToChat} />;
  }

  return (
    <div className="app-with-nav">
      <ChatPage />
      {/* Floating nav buttons */}
      <button
        className="nav-fab nav-fab-graph"
        onClick={() => navigateToGraph()}
        title="Open Graph Explorer"
      >
        🕸
      </button>
      <button
        className="nav-fab nav-fab-global-map"
        onClick={navigateToGlobalMap}
        title="Open Global Map"
      >
        🗺️
      </button>
      <button
        className="nav-fab nav-fab-memory"
        onClick={navigateToExplorer}
        title="Open Memory Explorer"
      >
        🧠
      </button>
      <button
        className="nav-fab nav-fab-decay"
        onClick={navigateToDecayMonitor}
        title="Open Decay Monitor"
      >
        📉
      </button>
    </div>
  );
}
