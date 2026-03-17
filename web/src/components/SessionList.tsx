/**
 * SessionList — Sidebar panel displaying stored conversation sessions.
 *
 * Fetches sessions from GET /api/conversations and renders them as a
 * clickable list. Supports:
 *   - Selection state (highlight active session)
 *   - Session metadata display (title, message count, timestamps)
 *   - Loading and error states
 *   - Refresh button to re-fetch
 *   - "New Chat" action to start fresh
 */

import { useSessions, type StoredSession } from '../hooks/useSessions';

// ─── Props ──────────────────────────────────────────────────

export interface SessionListProps {
  /** Called when a session is selected (with conversation ID) */
  onSelectSession?: (sessionId: string) => void;
  /** Called when "New Chat" is clicked */
  onNewChat?: () => void;
  /** API base URL override */
  apiBaseUrl?: string;
  /** Externally controlled selected session ID */
  selectedSessionId?: string | null;
}

// ─── Component ──────────────────────────────────────────────

export function SessionList({
  onSelectSession,
  onNewChat,
  apiBaseUrl,
  selectedSessionId: externalSelectedId,
}: SessionListProps) {
  const {
    sessions,
    selectedSessionId: internalSelectedId,
    isLoading,
    error,
    selectSession,
    refresh,
  } = useSessions({ apiBaseUrl });

  // Use external selection if provided, otherwise internal
  const activeId = externalSelectedId !== undefined ? externalSelectedId : internalSelectedId;

  const handleSelect = (session: StoredSession) => {
    selectSession(session.id);
    onSelectSession?.(session.id);
  };

  return (
    <div className="session-list-panel">
      {/* ─── Header ─── */}
      <div className="session-list-header">
        <h2 className="session-list-title">Sessions</h2>
        <div className="session-list-actions">
          <button
            className="btn-session-action btn-refresh"
            onClick={() => refresh()}
            disabled={isLoading}
            title="Refresh session list"
          >
            {isLoading ? '...' : '↻'}
          </button>
          {onNewChat && (
            <button
              className="btn-session-action btn-new-chat"
              onClick={onNewChat}
              title="Start new chat"
            >
              +
            </button>
          )}
        </div>
      </div>

      {/* ─── Error ─── */}
      {error && (
        <div className="session-list-error">
          <span className="session-list-error-icon">⚠</span>
          <span className="session-list-error-text">{error}</span>
        </div>
      )}

      {/* ─── Loading State ─── */}
      {isLoading && sessions.length === 0 && (
        <div className="session-list-loading">
          <div className="session-list-spinner" />
          <span>Loading sessions...</span>
        </div>
      )}

      {/* ─── Empty State ─── */}
      {!isLoading && !error && sessions.length === 0 && (
        <div className="session-list-empty">
          <span className="session-list-empty-icon">💬</span>
          <span>No previous sessions</span>
          <span className="session-list-empty-hint">
            Start a chat to create your first session
          </span>
        </div>
      )}

      {/* ─── Session Items ─── */}
      <div className="session-list-items">
        {sessions.map((session) => {
          const isActive = activeId === session.id;
          return (
            <button
              key={session.id}
              className={`session-list-item ${isActive ? 'session-list-item-active' : ''}`}
              onClick={() => handleSelect(session)}
              title={`Session ${session.id}\nCreated: ${formatDate(session.createdAt)}`}
            >
              <div className="session-item-main">
                <span className="session-item-title">
                  {session.title || formatSessionTitle(session)}
                </span>
                {session.messageCount != null && session.messageCount > 0 && (
                  <span className="session-item-count">
                    {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div className="session-item-meta">
                <span className="session-item-time">
                  {formatRelativeTime(session.updatedAt)}
                </span>
                <span className="session-item-id">
                  {session.id.slice(0, 8)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────

function formatSessionTitle(session: StoredSession): string {
  const date = new Date(session.createdAt);
  return `Chat ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}
