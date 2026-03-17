/**
 * useSessions — React hook for fetching and managing stored conversation sessions.
 *
 * Calls GET /api/conversations to load previous sessions from the backend SQLite store.
 * Provides selection state management and refresh capability.
 */

import { useState, useEffect, useCallback } from 'react';

// ─── Types ──────────────────────────────────────────────────

/** A stored conversation session from the backend. */
export interface StoredSession {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  userId: string;
  messageCount?: number;
  metadata?: Record<string, unknown>;
}

export interface UseSessionsOptions {
  /** Base URL for the API (default: '/api') */
  apiBaseUrl?: string;
  /** Auto-fetch on mount (default: true) */
  autoFetch?: boolean;
  /** Limit number of sessions to fetch (default: 50) */
  limit?: number;
}

export interface UseSessionsReturn {
  /** List of stored sessions (most recent first) */
  sessions: StoredSession[];
  /** Currently selected session ID */
  selectedSessionId: string | null;
  /** Whether sessions are currently being fetched */
  isLoading: boolean;
  /** Error from the last fetch attempt */
  error: string | null;
  /** Select a session by ID (null to deselect) */
  selectSession: (id: string | null) => void;
  /** Refresh the session list from the server */
  refresh: () => Promise<void>;
}

// ─── Hook ───────────────────────────────────────────────────

export function useSessions(options: UseSessionsOptions = {}): UseSessionsReturn {
  const {
    apiBaseUrl = '/api',
    autoFetch = true,
    limit = 50,
  } = options;

  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const url = `${apiBaseUrl}/conversations?limit=${limit}`;
      const response = await fetch(url);

      if (!response.ok) {
        let errorMsg: string;
        try {
          const body = await response.json();
          errorMsg = body.message ?? body.error ?? `HTTP ${response.status}`;
        } catch {
          errorMsg = `Failed to fetch sessions: HTTP ${response.status}`;
        }
        throw new Error(errorMsg);
      }

      const data = await response.json();
      const conversations: StoredSession[] = (data.conversations ?? []).map(
        (c: Record<string, unknown>) => ({
          id: c.id as string,
          title: (c.title as string | null) ?? null,
          createdAt: c.createdAt as string,
          updatedAt: c.updatedAt as string,
          sessionId: (c.sessionId as string | null) ?? null,
          userId: (c.userId as string) ?? 'debug-user',
          messageCount: (c.messageCount as number | undefined) ?? undefined,
          metadata: (c.metadata as Record<string, unknown> | undefined) ?? undefined,
        }),
      );

      setSessions(conversations);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error fetching sessions';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, limit]);

  // Auto-fetch on mount
  useEffect(() => {
    if (autoFetch) {
      fetchSessions();
    }
  }, [autoFetch, fetchSessions]);

  const selectSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
  }, []);

  return {
    sessions,
    selectedSessionId,
    isLoading,
    error,
    selectSession,
    refresh: fetchSessions,
  };
}
