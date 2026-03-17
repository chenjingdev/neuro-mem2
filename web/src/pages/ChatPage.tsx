/**
 * ChatPage — Full-page layout integrating ChatWindow + TimelinePanel.
 *
 * This page composes:
 *   - useChatStream hook (SSE streaming + timeline session management)
 *   - useSessionHistory hook (historical session loading from backend)
 *   - SessionList sidebar (session browser)
 *   - ChatWindow (center panel: message list + input)
 *   - TimelinePanel (right panel: pipeline trace visualization)
 *
 * Two modes:
 *   1. **Live mode** (default) — SSE streaming chat with real-time pipeline tracing
 *   2. **Read-only mode** — viewing a historical session loaded via GET /api/sessions/:id
 *
 * SSE events flow (live mode):
 *   event:trace → useTimeline.addTrace → TimelinePanel renders stage updates
 *   event:chat  → useChat state → ChatWindow renders streamed tokens
 *   event:done  → useTimeline.completeSession → TimelinePanel shows final stats
 *
 * Users can click any message with trace data to view its pipeline timeline.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useChatStream, type UseChatStreamOptions } from '../hooks/useChatStream';
import { useSessionHistory } from '../hooks/useSessionHistory';
import { ChatWindow } from '../components/ChatWindow';
import { TimelinePanel } from '../components/TimelinePanel';
import { DetailPanel } from '../components/DetailPanel';
import { SessionList } from '../components/SessionList';
import type { TraceEvent } from '../types';
import type { StageEntry } from '../types/timeline';
import {
  TOP_LEVEL_STAGES,
  RECALL_SUB_STAGES,
  BATCH_SUB_STAGES,
} from '../types/timeline';

interface ChatPageProps {
  /** Options forwarded to useChatStream (API URL, LLM settings, etc.) */
  options?: UseChatStreamOptions;
}

/**
 * ChatPage — main debug chat page with integrated pipeline timeline.
 *
 * Layout: three-column split
 *   - Left sidebar: SessionList (session browser)
 *   - Center: ChatWindow (messages + input)
 *   - Right: TimelinePanel (pipeline trace visualization)
 *
 * The timeline automatically shows traces for:
 *   1. The currently selected message (click to select)
 *   2. The latest session's traces (fallback when nothing is selected)
 */
export function ChatPage({ options }: ChatPageProps) {
  const {
    // Chat state
    messages,
    isStreaming,
    error,
    usage,
    totalDurationMs,
    isSessionEnded,
    isEndingSession,

    // Chat actions
    sendMessage,
    stop,
    clearChat,
    endSession,

    // Timeline state
    selectedTraces,
    selectedSession,
    selectedMessageId,
    sessionList,

    // Timeline actions
    selectMessage,
    hasTraces,
  } = useChatStream(options);

  // ─── Session History (for loading stored sessions in read-only mode) ───
  const history = useSessionHistory();

  // ─── Selected stage for DetailPanel ───
  const [selectedStage, setSelectedStage] = useState<string | null>(null);

  // ─── Sidebar toggle ───
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Track which historical message is selected for trace filtering
  const [historySelectedMsgId, setHistorySelectedMsgId] = useState<string | null>(null);

  // Are we in read-only mode (viewing a historical session)?
  const isReadOnly = history.loadedSession !== null;

  // ─── Session selection handler (loads full session from backend) ───
  const handleSelectStoredSession = useCallback((sessionId: string) => {
    setHistorySelectedMsgId(null);
    setSelectedStage(null);
    history.loadSession(sessionId);
  }, [history]);

  // ─── Return to live chat mode ───
  const handleNewChat = useCallback(() => {
    history.clearLoadedSession();
    setHistorySelectedMsgId(null);
    setSelectedStage(null);
  }, [history]);

  // ─── Historical message selection (for per-message trace filtering) ───
  const handleHistorySelectMessage = useCallback((messageId: string | null) => {
    setHistorySelectedMsgId(messageId);
    setSelectedStage(null);
  }, []);

  // Check if a historical message has associated trace data
  const historyHasTraces = useCallback((messageId: string): boolean => {
    if (!history.loadedSession) return false;
    const traces = history.loadedSession.tracesByMessage.get(messageId);
    return traces != null && traces.length > 0;
  }, [history.loadedSession]);

  // ─── Display data: determined by current mode (live vs read-only) ───
  const displayMessages = isReadOnly
    ? history.loadedSession!.messages
    : messages;

  const displaySelectedMessageId = isReadOnly
    ? historySelectedMsgId
    : selectedMessageId;

  // Determine which traces to display in the timeline
  const displayTraces: TraceEvent[] = useMemo(() => {
    if (isReadOnly && history.loadedSession) {
      if (historySelectedMsgId) {
        // Show traces for the selected historical message only
        return history.loadedSession.tracesByMessage.get(historySelectedMsgId) ?? [];
      }
      // Default: show all trace events from the loaded session
      return history.loadedSession.traceEvents;
    }

    // Live mode: selected message traces → latest session traces → empty
    if (selectedTraces.length > 0) return selectedTraces;
    if (sessionList.length > 0) return sessionList[sessionList.length - 1].traces;
    return [];
  }, [isReadOnly, history.loadedSession, historySelectedMsgId, selectedTraces, sessionList]);

  // Determine if the displayed session is still active (streaming) — live mode only
  const displaySession = isReadOnly
    ? null
    : (selectedSession ?? (sessionList.length > 0 ? sessionList[sessionList.length - 1] : null));

  // Refresh session list after a streaming response completes
  useEffect(() => {
    if (!isStreaming && messages.length > 0) {
      const timer = setTimeout(() => {
        history.fetchSessions();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, messages.length]);

  // Aggregate traces into StageEntry objects for the detail panel lookup
  const stageEntries = useMemo(() => {
    const stageMap = new Map<string, StageEntry>();
    for (const trace of displayTraces) {
      const existing = stageMap.get(trace.stage);
      if (trace.status === 'start') {
        stageMap.set(trace.stage, {
          stage: trace.stage, status: 'running', startedAt: trace.timestamp,
          input: trace.data as Record<string, unknown> | undefined,
          parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
            : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
            : undefined,
          isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
        });
      } else if (trace.status === 'complete') {
        const entry = existing ?? { stage: trace.stage, status: 'done' as const,
          parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
            : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
            : undefined,
          isTopLevel: TOP_LEVEL_STAGES.has(trace.stage) };
        stageMap.set(trace.stage, { ...entry, status: 'done', durationMs: trace.durationMs,
          completedAt: trace.timestamp, output: trace.data as Record<string, unknown> | undefined });
      } else if (trace.status === 'error') {
        const entry = existing ?? { stage: trace.stage, status: 'error' as const,
          parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
            : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
            : undefined,
          isTopLevel: TOP_LEVEL_STAGES.has(trace.stage) };
        stageMap.set(trace.stage, { ...entry, status: 'error', durationMs: trace.durationMs,
          completedAt: trace.timestamp,
          errorMessage: (trace.data as Record<string, unknown>)?.error as string
            ?? (trace.data as Record<string, unknown>)?.message as string ?? 'Unknown error' });
      } else if (trace.status === 'skipped') {
        stageMap.set(trace.stage, {
          stage: trace.stage, status: 'skipped', startedAt: trace.timestamp, completedAt: trace.timestamp,
          skipReason: (trace.data as Record<string, unknown>)?.reason as string
            ?? (trace.data as Record<string, unknown>)?.skipReason as string ?? 'Skipped',
          parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
            : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
            : undefined,
          isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
        });
      }
    }
    return stageMap;
  }, [displayTraces]);

  // Resolve the selected stage entry for the detail panel
  const selectedStageEntry = selectedStage ? stageEntries.get(selectedStage) ?? null : null;

  // Clear selected stage when traces change (new message selected)
  const handleSelectStage = useCallback((stage: string | null) => {
    setSelectedStage(stage);
  }, []);

  // Close detail panel on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedStage) {
        setSelectedStage(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedStage]);

  return (
    <div className="chat-page">
      {/* ─── Header ─── */}
      <header className="chat-page-header">
        <div className="header-left">
          <button
            className="btn-sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? 'Hide session sidebar' : 'Show session sidebar'}
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <h1 className="app-title">nero-mem2 Debug Chat</h1>
          {isReadOnly && history.loadedSession && (
            <span className="session-indicator session-indicator-readonly">
              Viewing: {history.loadedSession.title || `Session ${history.loadedSession.id.slice(0, 8)}`}
            </span>
          )}
          {!isReadOnly && sessionList.length > 0 && (
            <span className="session-indicator">
              {sessionList.length} session{sessionList.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="header-right">
          {/* Pipeline stats (live mode only) */}
          {!isReadOnly && totalDurationMs != null && (
            <span className="stat-chip stat-duration" title="Total pipeline duration">
              Pipeline: {totalDurationMs.toFixed(0)}ms
            </span>
          )}
          {!isReadOnly && usage && (
            <span className="stat-chip stat-tokens" title="Token usage (prompt + completion = total)">
              Tokens: {usage.promptTokens}+{usage.completionTokens}={usage.totalTokens}
            </span>
          )}
          {isReadOnly ? (
            <button
              onClick={handleNewChat}
              className="btn btn-back"
              title="Return to live chat"
            >
              Back to Chat
            </button>
          ) : (
            <>
              <button
                onClick={endSession}
                disabled={isStreaming || isSessionEnded || isEndingSession || messages.length === 0}
                className={`btn btn-end-session ${isSessionEnded ? 'btn-ended' : ''}`}
                title={
                  isSessionEnded
                    ? 'Session already ended'
                    : isEndingSession
                      ? 'Ending session...'
                      : 'End session and trigger batch extraction'
                }
              >
                {isEndingSession ? 'Ending...' : isSessionEnded ? 'Ended' : 'End Session'}
              </button>
              <button
                onClick={clearChat}
                disabled={isStreaming}
                className="btn btn-clear"
                title="Clear all messages and traces"
              >
                Clear
              </button>
            </>
          )}
        </div>
      </header>

      {/* ─── Error Banner ─── */}
      {(error || history.error) && (
        <div className="error-banner" role="alert">
          <span className="error-icon">⚠</span>
          <span className="error-text">{error || history.error}</span>
        </div>
      )}

      {/* ─── Main Content: Sidebar + Chat + Timeline ─── */}
      <div className="chat-page-body">
        {/* Left sidebar: Session list */}
        {sidebarOpen && (
          <SessionList
            onSelectSession={handleSelectStoredSession}
            onNewChat={handleNewChat}
            selectedSessionId={isReadOnly ? history.loadedSession?.id ?? null : null}
          />
        )}

        {/* Center panel: Chat */}
        <div className="chat-page-chat">
          {history.isLoadingDetail ? (
            <div className="chat-loading-overlay">
              <div className="chat-loading-spinner" />
              <span>Loading session...</span>
            </div>
          ) : (
            <ChatWindow
              messages={displayMessages}
              onSend={sendMessage}
              onStop={stop}
              isStreaming={isStreaming && !isReadOnly}
              selectedMessageId={displaySelectedMessageId}
              onSelectMessage={isReadOnly ? handleHistorySelectMessage : selectMessage}
              hasTraces={isReadOnly ? historyHasTraces : hasTraces}
              readOnly={isReadOnly}
            />
          )}
        </div>

        {/* Right panel: Timeline */}
        <div className={`chat-page-timeline ${selectedStageEntry ? 'timeline-with-detail' : ''}`}>
          {/* Session selector tabs (when multiple live sessions exist) */}
          {!isReadOnly && sessionList.length > 1 && (
            <div className="session-tabs">
              {sessionList.map((session, idx) => {
                const isActive =
                  selectedMessageId === session.messageId ||
                  selectedMessageId === session.assistantMessageId ||
                  (!selectedMessageId && idx === sessionList.length - 1);

                return (
                  <button
                    key={session.messageId}
                    className={`session-tab ${isActive ? 'session-tab-active' : ''} ${session.isActive ? 'session-tab-streaming' : ''}`}
                    onClick={() => selectMessage(session.messageId)}
                    title={`Session ${idx + 1}${session.isActive ? ' (streaming)' : ''}`}
                  >
                    <span className="session-tab-num">#{idx + 1}</span>
                    {session.isActive && <span className="session-tab-dot" />}
                    {session.totalDurationMs != null && (
                      <span className="session-tab-duration">
                        {session.totalDurationMs.toFixed(0)}ms
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Active session status bar (live mode) */}
          {displaySession && (
            <div className={`session-status-bar ${displaySession.isActive ? 'session-active' : 'session-complete'}`}>
              <span className="session-status-dot" />
              <span className="session-status-text">
                {displaySession.isActive
                  ? 'Pipeline running...'
                  : `Complete${displaySession.totalDurationMs != null ? ` — ${displaySession.totalDurationMs.toFixed(0)}ms` : ''}`}
              </span>
              {displaySession.usage && (
                <span className="session-status-tokens">
                  {displaySession.usage.totalTokens} tokens
                </span>
              )}
            </div>
          )}

          {/* Read-only session status bar */}
          {isReadOnly && history.loadedSession && (
            <div className="session-status-bar session-complete session-readonly">
              <span className="session-status-dot" />
              <span className="session-status-text">
                Saved Session — {history.loadedSession.traceEvents.length} trace event{history.loadedSession.traceEvents.length !== 1 ? 's' : ''}
                {historySelectedMsgId && (
                  <> (filtered by message)</>
                )}
              </span>
            </div>
          )}

          {/* Timeline + Detail split */}
          <div className={`timeline-detail-wrapper ${selectedStageEntry ? 'has-detail' : ''}`}>
            {/* Timeline visualization */}
            <TimelinePanel
              traces={displayTraces}
              selectedStep={selectedStage}
              onSelectStep={handleSelectStage}
            />

            {/* Detail panel (slides in when a stage is selected) */}
            <DetailPanel
              entry={selectedStageEntry}
              onClose={() => setSelectedStage(null)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
