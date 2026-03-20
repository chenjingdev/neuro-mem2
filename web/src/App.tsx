import { useState, useCallback, useEffect } from 'react';
import { ChatPage } from './pages/ChatPage';
import { MemoryExplorerPage } from './pages/MemoryExplorerPage';
import { GraphExplorerPage } from './pages/GraphExplorerPage';

/**
 * App — root component for the nero-mem2 Visual Debug UI.
 *
 * Three views:
 *   1. ChatPage — SSE streaming chat with pipeline trace visualization
 *   2. MemoryExplorerPage — layer-by-layer memory node exploration
 *   3. GraphExplorerPage — sigma.js graph (global map + local ego-network + deepK)
 *
 * Uses history.pushState so browser back button works across views.
 */

type AppView = 'chat' | 'memory-explorer' | 'graph-explorer';

interface GraphExplorerState {
  initialNodeId?: string;
}

function pushView(view: AppView, extra?: Record<string, unknown>) {
  history.pushState({ view, ...extra }, '', undefined);
}

export function App() {
  const [view, setView] = useState<AppView>('chat');
  const [graphState, setGraphState] = useState<GraphExplorerState>({});

  // Replace initial history entry with chat state
  useEffect(() => {
    history.replaceState({ view: 'chat' }, '', undefined);
  }, []);

  // Listen for browser back/forward
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const state = e.state as { view?: AppView; initialNodeId?: string } | null;
      if (state?.view) {
        setView(state.view);
        if (state.view === 'graph-explorer') {
          setGraphState({ initialNodeId: state.initialNodeId });
        }
      } else {
        setView('chat');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigateToChat = useCallback(() => {
    setView('chat');
    pushView('chat');
  }, []);

  const navigateToExplorer = useCallback(() => {
    setView('memory-explorer');
    pushView('memory-explorer');
  }, []);

  const navigateToGraph = useCallback((nodeId?: string) => {
    setGraphState({ initialNodeId: nodeId });
    setView('graph-explorer');
    pushView('graph-explorer', { initialNodeId: nodeId });
  }, []);

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
      <div className="nav-fab nav-fab-memory" onClick={navigateToExplorer}>
        🧠 Memory
        <span className="fab-tooltip">저장된 메모리 노드를 필터/검색/상세 조회</span>
      </div>
      <div className="nav-fab nav-fab-graph" onClick={() => navigateToGraph()}>
        🕸 Graph
        <span className="fab-tooltip">메모리 그래프 시각화 — 전체 맵 / 노드 중심 / DeepK</span>
      </div>
    </div>
  );
}
