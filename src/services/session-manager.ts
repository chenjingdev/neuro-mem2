/**
 * Session Manager — Detects session endings and triggers batch extraction.
 *
 * Session end detection strategies:
 * 1. Explicit close — caller invokes endSession()
 * 2. Inactivity timeout — periodic sweep detects stale sessions
 * 3. TTL expiration — session exceeds maximum lifetime
 *
 * When a session ends, the manager:
 * 1. Marks the session as 'ended'
 * 2. Emits a 'session.ended' event via EventBus
 * 3. The BatchPipeline (subscribed to the event) creates extraction jobs
 */

import type { SessionRepository } from '../db/session-repo.js';
import type { EventBus } from '../events/event-bus.js';
import type {
  Session,
  CreateSessionInput,
  SessionEndReason,
} from '../models/session.js';
import type { SessionEndedEvent } from '../events/event-bus.js';

export interface SessionManagerOptions {
  /** Interval (ms) for checking timed-out sessions. Default: 60_000 (1 min) */
  sweepIntervalMs?: number;
  /** Whether to start the sweep timer automatically. Default: true */
  autoSweep?: boolean;
  /** Default TTL (ms) for new sessions. Default: null (no limit) */
  defaultTtlMs?: number | null;
  /** Default inactivity timeout (ms) for new sessions. Default: 30 min */
  defaultTimeoutMs?: number;
}

export class SessionManager {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sweepIntervalMs: number;
  private readonly defaultTtlMs: number | null;
  private readonly defaultTimeoutMs: number;

  constructor(
    private repo: SessionRepository,
    private eventBus: EventBus,
    options: SessionManagerOptions = {}
  ) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.defaultTtlMs = options.defaultTtlMs ?? null;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30 * 60 * 1000;

    if (options.autoSweep !== false) {
      this.startSweep();
    }
  }

  /**
   * Start a new session for a conversation.
   * If an active session already exists for the conversation, returns it.
   */
  startSession(input: CreateSessionInput): Session {
    const existing = this.repo.getActiveSession(input.conversationId);
    if (existing) {
      // Touch the existing session to update activity
      this.repo.touchSession(existing.id);
      return { ...existing, lastActivityAt: new Date().toISOString() };
    }

    // Apply defaults if not specified
    const sessionInput: CreateSessionInput = {
      ...input,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      ttlMs: input.ttlMs ?? this.defaultTtlMs ?? undefined,
    };

    return this.repo.createSession(sessionInput);
  }

  /**
   * Record activity on a session (message append, heartbeat).
   */
  touchSession(sessionId: string): void {
    this.repo.touchSession(sessionId);
  }

  /**
   * Explicitly end a session and trigger batch extraction.
   */
  async endSession(sessionId: string, reason: SessionEndReason = 'explicit'): Promise<Session | null> {
    const session = this.repo.endSession(sessionId, reason);
    if (!session) return null;

    await this.emitSessionEnded(session, reason);
    return session;
  }

  /**
   * Get the active session for a conversation.
   */
  getActiveSession(conversationId: string): Session | null {
    return this.repo.getActiveSession(conversationId);
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): Session | null {
    return this.repo.getSession(sessionId);
  }

  /**
   * Sweep for timed-out sessions (inactivity + TTL) and end them.
   * This is called periodically by the sweep timer, but can also be called manually.
   * Returns the list of sessions that were ended.
   */
  async sweepTimedOutSessions(now?: Date): Promise<Session[]> {
    const ended: Session[] = [];

    // 1. Inactivity timeout
    const timedOut = this.repo.findTimedOutSessions(now);
    for (const session of timedOut) {
      const endedSession = this.repo.endSession(session.id, 'timeout');
      if (endedSession) {
        await this.emitSessionEnded(endedSession, 'timeout');
        ended.push(endedSession);
      }
    }

    // 2. TTL expiration (separate from inactivity — a session can be active but exceed its max lifetime)
    const ttlExpired = this.repo.findTTLExpiredSessions(now);
    for (const session of ttlExpired) {
      // Skip if already ended by inactivity check above
      if (ended.some(s => s.id === session.id)) continue;

      const endedSession = this.repo.endSession(session.id, 'ttl_expired');
      if (endedSession) {
        await this.emitSessionEnded(endedSession, 'ttl_expired');
        ended.push(endedSession);
      }
    }

    return ended;
  }

  /**
   * Start the periodic sweep timer.
   */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepTimedOutSessions().catch((err) => {
        console.error('Session sweep error:', err);
      });
    }, this.sweepIntervalMs);

    // Unref so the timer doesn't keep the process alive
    if (typeof this.sweepTimer === 'object' && 'unref' in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }

  /**
   * Stop the periodic sweep timer.
   */
  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.stopSweep();
  }

  private async emitSessionEnded(session: Session, reason: SessionEndReason): Promise<void> {
    const event: SessionEndedEvent = {
      type: 'session.ended',
      sessionId: session.id,
      conversationId: session.conversationId,
      reason,
      timestamp: session.endedAt ?? new Date().toISOString(),
    };

    await this.eventBus.emit(event);
  }
}
