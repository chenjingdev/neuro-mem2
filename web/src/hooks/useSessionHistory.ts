/**
 * useSessionHistory — React hook for fetching historical session data.
 *
 * Provides:
 *   - Session list fetching (GET /api/sessions)
 *   - Session detail loading (GET /api/sessions/:id)
 *   - Conversion of stored data to ChatMessage[] + TraceEvent[] for
 *     read-only rendering in ChatWindow + TimelinePanel
 *
 * When a session is loaded, the hook converts the server response
 * into the same data shapes used by the live chat hooks, enabling
 * seamless rendering in the existing UI components.
 */

import { useState, useCallback, useEffect } from 'react';
import type { ChatMessage, TraceEvent } from '../types';

// ─── API Response Types ─────────────────────────────────

/** Session summary from GET /api/sessions */
export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: string;
  messageCount: number;
}

/** Message from GET /api/sessions/:id */
interface ServerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  turnIndex: number;
  createdAt: string;
  model?: string;
  durationMs?: number;
  tokenCount?: number;
}

/** Timeline event from GET /api/sessions/:id */
interface ServerTimelineEvent {
  id: number;
  messageId: string;
  traceId: number;
  stage: string;
  status: string;
  parentStage?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  skipReason?: string;
  durationMs?: number;
  timestamp: string;
}

/** Full session detail from GET /api/sessions/:id */
interface SessionDetail {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
  messages: ServerMessage[];
  timeline: ServerTimelineEvent[];
}

// ─── Loaded Session Data ────────────────────────────────

/** A historical session loaded for read-only rendering. */
export interface LoadedSession {
  id: string;
  title: string | null;
  createdAt: string;
  messages: ChatMessage[];
  traceEvents: TraceEvent[];
  /** Mapping from messageId to its trace events */
  tracesByMessage: Map<string, TraceEvent[]>;
}

// ─── Hook Return Type ───────────────────────────────────

export interface UseSessionHistoryReturn {
  /** List of available sessions */
  sessionList: SessionSummary[];
  /** Whether the session list is loading */
  isLoadingList: boolean;
  /** Currently loaded session (read-only mode) */
  loadedSession: LoadedSession | null;
  /** Whether a session detail is loading */
  isLoadingDetail: boolean;
  /** Error message */
  error: string | null;
  /** Fetch the session list */
  fetchSessions: () => Promise<void>;
  /** Load a specific session by ID */
  loadSession: (sessionId: string) => Promise<void>;
  /** Clear the loaded session (return to live chat mode) */
  clearLoadedSession: () => void;
}

// ─── Conversion Helpers ─────────────────────────────────

/**
 * Convert server message to frontend ChatMessage shape.
 */
function toMessage(msg: ServerMessage): ChatMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: new Date(msg.createdAt).getTime(),
    isStreaming: false,
  };
}

/**
 * Convert server timeline event to frontend TraceEvent shape.
 *
 * The server stores decomposed fields (input/output/error/skipReason),
 * while the frontend expects a single `data` field. We reconstruct
 * the `data` field based on the event status.
 */
function toTraceEvent(evt: ServerTimelineEvent): TraceEvent {
  let data: Record<string, unknown> | undefined;

  switch (evt.status) {
    case 'start':
      if (evt.input != null) data = evt.input as Record<string, unknown>;
      break;
    case 'complete':
      if (evt.output != null) data = evt.output as Record<string, unknown>;
      break;
    case 'error':
      data = {};
      if (evt.error) data.error = evt.error;
      if (evt.output != null) Object.assign(data, evt.output as Record<string, unknown>);
      break;
    case 'skipped':
      data = {};
      if (evt.skipReason) data.reason = evt.skipReason;
      if (evt.output != null) Object.assign(data, evt.output as Record<string, unknown>);
      break;
    default:
      if (evt.output != null) data = evt.output as Record<string, unknown>;
  }

  return {
    stage: evt.stage,
    status: evt.status as TraceEvent['status'],
    durationMs: evt.durationMs,
    data,
    timestamp: evt.timestamp,
  };
}

/**
 * Group trace events by messageId.
 */
function groupTracesByMessage(events: ServerTimelineEvent[]): Map<string, TraceEvent[]> {
  const map = new Map<string, TraceEvent[]>();
  for (const evt of events) {
    const traces = map.get(evt.messageId) ?? [];
    traces.push(toTraceEvent(evt));
    map.set(evt.messageId, traces);
  }
  return map;
}

// ─── Hook ───────────────────────────────────────────────

export function useSessionHistory(apiBaseUrl = '/api'): UseSessionHistoryReturn {
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [loadedSession, setLoadedSession] = useState<LoadedSession | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoadingList(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBaseUrl}/sessions`);
      if (!resp.ok) {
        throw new Error(`Failed to fetch sessions: ${resp.status}`);
      }
      const body = await resp.json();
      setSessionList(body.sessions ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsLoadingList(false);
    }
  }, [apiBaseUrl]);

  const loadSession = useCallback(async (sessionId: string) => {
    setIsLoadingDetail(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBaseUrl}/sessions/${sessionId}`);
      if (!resp.ok) {
        if (resp.status === 404) {
          throw new Error(`Session ${sessionId} not found`);
        }
        throw new Error(`Failed to load session: ${resp.status}`);
      }
      const detail: SessionDetail = await resp.json();

      const messages = detail.messages.map(toMessage);
      const traceEvents = detail.timeline.map(toTraceEvent);
      const tracesByMessage = groupTracesByMessage(detail.timeline);

      setLoadedSession({
        id: detail.id,
        title: detail.title,
        createdAt: detail.createdAt,
        messages,
        traceEvents,
        tracesByMessage,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsLoadingDetail(false);
    }
  }, [apiBaseUrl]);

  const clearLoadedSession = useCallback(() => {
    setLoadedSession(null);
  }, []);

  // Fetch session list on mount
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  return {
    sessionList,
    isLoadingList,
    loadedSession,
    isLoadingDetail,
    error,
    fetchSessions,
    loadSession,
    clearLoadedSession,
  };
}
