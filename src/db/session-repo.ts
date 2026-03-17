/**
 * Repository for session and batch job storage.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Session,
  BatchJob,
  BatchJobType,
  BatchJobStatus,
  CreateSessionInput,
  SessionEndReason,
} from '../models/session.js';

/** Raw row shape from SQLite for sessions */
interface SessionRow {
  id: string;
  conversation_id: string;
  status: string;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  end_reason: string | null;
  timeout_ms: number;
  ttl_ms: number | null;
  metadata: string | null;
}

/** Raw row shape from SQLite for batch jobs */
interface BatchJobRow {
  id: string;
  session_id: string;
  conversation_id: string;
  job_type: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result: string | null;
}

export class SessionRepository {
  constructor(private db: Database.Database) {}

  // ── Row Mappers ──

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status as Session['status'],
      startedAt: row.started_at,
      lastActivityAt: row.last_activity_at,
      endedAt: row.ended_at,
      endReason: row.end_reason as SessionEndReason | null,
      timeoutMs: row.timeout_ms,
      ttlMs: row.ttl_ms,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private rowToBatchJob(row: BatchJobRow): BatchJob {
    return {
      id: row.id,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      jobType: row.job_type as BatchJobType,
      status: row.status as BatchJobStatus,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      result: row.result ? JSON.parse(row.result) : undefined,
    };
  }

  // ── Sessions ──

  /**
   * Create a new session.
   */
  createSession(input: CreateSessionInput): Session {
    const now = new Date().toISOString();
    const id = uuidv4();
    const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000; // 30 minutes default
    const ttlMs = input.ttlMs ?? null;

    const session: Session = {
      id,
      conversationId: input.conversationId,
      status: 'active',
      startedAt: now,
      lastActivityAt: now,
      endedAt: null,
      endReason: null,
      timeoutMs,
      ttlMs,
      metadata: input.metadata,
    };

    this.db.prepare(`
      INSERT INTO sessions (id, conversation_id, status, started_at, last_activity_at, ended_at, end_reason, timeout_ms, ttl_ms, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.conversationId,
      session.status,
      session.startedAt,
      session.lastActivityAt,
      session.endedAt,
      session.endReason,
      session.timeoutMs,
      session.ttlMs,
      session.metadata ? JSON.stringify(session.metadata) : null
    );

    return session;
  }

  /**
   * Update the last activity timestamp for a session (heartbeat).
   */
  touchSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE sessions SET last_activity_at = ? WHERE id = ? AND status = 'active'
    `).run(now, sessionId);
  }

  /**
   * End a session.
   */
  endSession(sessionId: string, reason: SessionEndReason): Session | null {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = ?
      WHERE id = ? AND status = 'active'
    `).run(now, reason, sessionId);

    return this.getSession(sessionId);
  }

  /**
   * Update session status (e.g., to 'processing', 'completed', 'failed').
   */
  updateSessionStatus(sessionId: string, status: Session['status']): void {
    this.db.prepare(`
      UPDATE sessions SET status = ? WHERE id = ?
    `).run(status, sessionId);
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): Session | null {
    const row = this.db.prepare(`
      SELECT id, conversation_id, status, started_at, last_activity_at, ended_at, end_reason, timeout_ms, ttl_ms, metadata
      FROM sessions WHERE id = ?
    `).get(sessionId) as SessionRow | undefined;

    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * Get the active session for a conversation.
   */
  getActiveSession(conversationId: string): Session | null {
    const row = this.db.prepare(`
      SELECT id, conversation_id, status, started_at, last_activity_at, ended_at, end_reason, timeout_ms, ttl_ms, metadata
      FROM sessions WHERE conversation_id = ? AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get(conversationId) as SessionRow | undefined;

    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * Find sessions that have timed out (inactivity timeout) or exceeded their TTL.
   * Returns sessions grouped by reason so the caller knows which end reason to use.
   */
  findTimedOutSessions(now?: Date): Session[] {
    const currentTime = (now ?? new Date()).getTime();

    const rows = this.db.prepare(`
      SELECT id, conversation_id, status, started_at, last_activity_at, ended_at, end_reason, timeout_ms, ttl_ms, metadata
      FROM sessions WHERE status = 'active'
    `).all() as SessionRow[];

    return rows.filter((row) => {
      const lastActivity = new Date(row.last_activity_at).getTime();
      const inactivityExpired = currentTime - lastActivity >= row.timeout_ms;
      return inactivityExpired;
    }).map((row) => this.rowToSession(row));
  }

  /**
   * Find sessions that have exceeded their maximum lifetime (TTL).
   * Separate from inactivity timeout — TTL is measured from session start.
   */
  findTTLExpiredSessions(now?: Date): Session[] {
    const currentTime = (now ?? new Date()).getTime();

    const rows = this.db.prepare(`
      SELECT id, conversation_id, status, started_at, last_activity_at, ended_at, end_reason, timeout_ms, ttl_ms, metadata
      FROM sessions WHERE status = 'active' AND ttl_ms IS NOT NULL
    `).all() as SessionRow[];

    return rows.filter((row) => {
      const startTime = new Date(row.started_at).getTime();
      return row.ttl_ms !== null && currentTime - startTime >= row.ttl_ms;
    }).map((row) => this.rowToSession(row));
  }

  /**
   * Reset a failed batch job back to 'pending' for retry.
   */
  retryBatchJob(jobId: string): BatchJob | null {
    const existing = this.getBatchJob(jobId);
    if (!existing || existing.status !== 'failed') return null;

    this.db.prepare(`
      UPDATE batch_jobs SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL, result = NULL
      WHERE id = ? AND status = 'failed'
    `).run(jobId);

    return this.getBatchJob(jobId);
  }

  /**
   * Reset all failed jobs for a session back to 'pending'.
   */
  retryFailedJobsForSession(sessionId: string): BatchJob[] {
    this.db.prepare(`
      UPDATE batch_jobs SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL, result = NULL
      WHERE session_id = ? AND status = 'failed'
    `).run(sessionId);

    // Also reset session status back to 'processing'
    this.updateSessionStatus(sessionId, 'processing');

    return this.getBatchJobsBySession(sessionId).filter(j => j.status === 'pending');
  }

  // ── Batch Jobs ──

  /**
   * Create a batch job.
   */
  createBatchJob(sessionId: string, conversationId: string, jobType: BatchJobType): BatchJob {
    const now = new Date().toISOString();
    const id = uuidv4();

    const job: BatchJob = {
      id,
      sessionId,
      conversationId,
      jobType,
      status: 'pending',
      createdAt: now,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    this.db.prepare(`
      INSERT INTO batch_jobs (id, session_id, conversation_id, job_type, status, created_at, started_at, completed_at, error, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.sessionId, job.conversationId, job.jobType,
      job.status, job.createdAt, job.startedAt, job.completedAt,
      job.error, null
    );

    return job;
  }

  /**
   * Update batch job status.
   */
  updateBatchJob(jobId: string, updates: {
    status?: BatchJobStatus;
    startedAt?: string;
    completedAt?: string;
    error?: string | null;
    result?: Record<string, unknown>;
  }): BatchJob | null {
    const existing = this.getBatchJob(jobId);
    if (!existing) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.startedAt !== undefined) { fields.push('started_at = ?'); values.push(updates.startedAt); }
    if (updates.completedAt !== undefined) { fields.push('completed_at = ?'); values.push(updates.completedAt); }
    if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }
    if (updates.result !== undefined) { fields.push('result = ?'); values.push(JSON.stringify(updates.result)); }

    if (fields.length > 0) {
      values.push(jobId);
      this.db.prepare(`UPDATE batch_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    return this.getBatchJob(jobId);
  }

  /**
   * Get a batch job by ID.
   */
  getBatchJob(jobId: string): BatchJob | null {
    const row = this.db.prepare(`
      SELECT id, session_id, conversation_id, job_type, status, created_at, started_at, completed_at, error, result
      FROM batch_jobs WHERE id = ?
    `).get(jobId) as BatchJobRow | undefined;

    if (!row) return null;
    return this.rowToBatchJob(row);
  }

  /**
   * Get all batch jobs for a session.
   */
  getBatchJobsBySession(sessionId: string): BatchJob[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, conversation_id, job_type, status, created_at, started_at, completed_at, error, result
      FROM batch_jobs WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as BatchJobRow[];

    return rows.map((row) => this.rowToBatchJob(row));
  }

  /**
   * Get pending batch jobs (for queue processing).
   */
  getPendingBatchJobs(limit = 10): BatchJob[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, conversation_id, job_type, status, created_at, started_at, completed_at, error, result
      FROM batch_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
    `).all(limit) as BatchJobRow[];

    return rows.map((row) => this.rowToBatchJob(row));
  }
}
