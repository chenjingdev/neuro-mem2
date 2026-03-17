/**
 * Session and Batch Job models.
 *
 * A Session represents an active conversation period.
 * When a session ends (explicit close or inactivity timeout),
 * batch extraction jobs are triggered for Episode/Concept extraction.
 */

export type SessionStatus = 'active' | 'ended' | 'processing' | 'completed' | 'failed';

export type SessionEndReason = 'explicit' | 'timeout' | 'ttl_expired';

export interface Session {
  /** Unique session identifier */
  id: string;
  /** Associated conversation ID */
  conversationId: string;
  /** Current session status */
  status: SessionStatus;
  /** ISO 8601 timestamp of session start */
  startedAt: string;
  /** ISO 8601 timestamp of last activity (message append, heartbeat) */
  lastActivityAt: string;
  /** ISO 8601 timestamp of session end (null if still active) */
  endedAt: string | null;
  /** Why the session ended */
  endReason: SessionEndReason | null;
  /** Inactivity timeout in milliseconds (default: 30 minutes) */
  timeoutMs: number;
  /** Maximum session lifetime in milliseconds (default: null = no limit) */
  ttlMs: number | null;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export type BatchJobType = 'episode_extraction' | 'concept_extraction' | 'full_extraction';

export type BatchJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BatchJob {
  /** Unique job identifier */
  id: string;
  /** Associated session ID */
  sessionId: string;
  /** Associated conversation ID */
  conversationId: string;
  /** Type of batch extraction */
  jobType: BatchJobType;
  /** Current job status */
  status: BatchJobStatus;
  /** ISO 8601 timestamp of job creation */
  createdAt: string;
  /** ISO 8601 timestamp of job start */
  startedAt: string | null;
  /** ISO 8601 timestamp of job completion */
  completedAt: string | null;
  /** Error message if failed */
  error: string | null;
  /** Optional result data */
  result?: Record<string, unknown>;
}

export interface CreateSessionInput {
  conversationId: string;
  /** Inactivity timeout in milliseconds (default: 30 * 60 * 1000 = 30min) */
  timeoutMs?: number;
  /** Maximum session lifetime in milliseconds (default: null = no limit) */
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface EndSessionInput {
  sessionId: string;
  reason: SessionEndReason;
}
