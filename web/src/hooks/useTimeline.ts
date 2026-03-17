/**
 * useTimeline — React hook for managing per-message trace sessions.
 *
 * Associates pipeline trace events with their triggering chat messages,
 * enabling the user to click any message and see its full pipeline trace
 * in the TimelinePanel.
 *
 * Maintains:
 *   - A map of message IDs → TraceSession
 *   - Selected message ID for timeline display
 *   - Auto-selection of the latest active session during streaming
 */

import { useState, useCallback, useRef } from 'react';
import type { TraceEvent, TraceSession, ChatSSEEvent } from '../types';
import type { StageEntry } from '../types/timeline';

// Re-export for consumers
export type { StageEntry } from '../types/timeline';

// ─── Types ──────────────────────────────────────────────────

export interface UseTimelineReturn {
  /** All trace sessions keyed by message ID */
  sessions: Map<string, TraceSession>;
  /** Currently selected message ID (for timeline display) */
  selectedMessageId: string | null;
  /** Traces for the currently selected message */
  selectedTraces: TraceEvent[];
  /** The active trace session (if currently selected) */
  selectedSession: TraceSession | null;
  /** Select a message to view its trace timeline */
  selectMessage: (messageId: string | null) => void;
  /** Start a new trace session for a user→assistant message pair */
  startSession: (userMessageId: string, assistantMessageId: string) => void;
  /** Add a trace event to the current active session */
  addTrace: (trace: TraceEvent) => void;
  /** Mark session complete with final stats */
  completeSession: (
    messageId: string,
    totalDurationMs: number | null,
    usage: ChatSSEEvent['usage'] | null,
  ) => void;
  /** Clear all sessions */
  clearAll: () => void;
  /** Get traces for a specific message */
  getTracesForMessage: (messageId: string) => TraceEvent[];
  /** Check if a message has trace data */
  hasTraces: (messageId: string) => boolean;
  /** The list of all session entries (for iteration) */
  sessionList: TraceSession[];
}

// ─── Hook ───────────────────────────────────────────────────

export function useTimeline(): UseTimelineReturn {
  const [sessions, setSessions] = useState<Map<string, TraceSession>>(new Map());
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  // Track the currently active session's message ID for appending traces
  const activeSessionRef = useRef<string | null>(null);

  const startSession = useCallback(
    (userMessageId: string, assistantMessageId: string) => {
      const session: TraceSession = {
        messageId: userMessageId,
        assistantMessageId,
        traces: [],
        totalDurationMs: null,
        usage: null,
        isActive: true,
        startedAt: Date.now(),
      };

      setSessions((prev) => {
        const next = new Map(prev);
        next.set(userMessageId, session);
        next.set(assistantMessageId, session);
        return next;
      });

      activeSessionRef.current = userMessageId;
      // Auto-select the new session
      setSelectedMessageId(userMessageId);
    },
    [],
  );

  const addTrace = useCallback((trace: TraceEvent) => {
    const activeId = activeSessionRef.current;
    if (!activeId) return;

    setSessions((prev) => {
      const session = prev.get(activeId);
      if (!session) return prev;

      const updatedSession: TraceSession = {
        ...session,
        traces: [...session.traces, trace],
      };

      const next = new Map(prev);
      next.set(session.messageId, updatedSession);
      next.set(session.assistantMessageId, updatedSession);
      return next;
    });
  }, []);

  const completeSession = useCallback(
    (
      messageId: string,
      totalDurationMs: number | null,
      usage: ChatSSEEvent['usage'] | null,
    ) => {
      setSessions((prev) => {
        const session = prev.get(messageId);
        if (!session) return prev;

        const updatedSession: TraceSession = {
          ...session,
          totalDurationMs,
          usage,
          isActive: false,
        };

        const next = new Map(prev);
        next.set(session.messageId, updatedSession);
        next.set(session.assistantMessageId, updatedSession);
        return next;
      });

      if (activeSessionRef.current === messageId) {
        activeSessionRef.current = null;
      }
    },
    [],
  );

  const selectMessage = useCallback((messageId: string | null) => {
    setSelectedMessageId(messageId);
  }, []);

  const clearAll = useCallback(() => {
    setSessions(new Map());
    setSelectedMessageId(null);
    activeSessionRef.current = null;
  }, []);

  const getTracesForMessage = useCallback(
    (messageId: string): TraceEvent[] => {
      return sessions.get(messageId)?.traces ?? [];
    },
    [sessions],
  );

  const hasTraces = useCallback(
    (messageId: string): boolean => {
      const session = sessions.get(messageId);
      return session != null && session.traces.length > 0;
    },
    [sessions],
  );

  // Derived state
  const selectedSession = selectedMessageId ? sessions.get(selectedMessageId) ?? null : null;
  const selectedTraces = selectedSession?.traces ?? [];

  // Deduplicated list of sessions (avoid duplicates from user+assistant mapping)
  const seen = new Set<string>();
  const sessionList: TraceSession[] = [];
  for (const session of sessions.values()) {
    if (!seen.has(session.messageId)) {
      seen.add(session.messageId);
      sessionList.push(session);
    }
  }

  return {
    sessions,
    selectedMessageId,
    selectedTraces,
    selectedSession,
    selectMessage,
    startSession,
    addTrace,
    completeSession,
    clearAll,
    getTracesForMessage,
    hasTraces,
    sessionList,
  };
}
