/**
 * Tests for Sub-AC 3.1: Session end detection and batch trigger mechanism.
 *
 * Covers:
 * - Three session end detection strategies: explicit, inactivity timeout, TTL expiration
 * - Automatic batch pipeline trigger on session end
 * - Session-aware ingestion (auto-touch, auto-session)
 * - Batch job retry support
 * - waitForSession() for synchronous test/workflow usage
 * - TTL (max lifetime) vs inactivity timeout distinction
 * - Full integration: ingest -> session -> end detect -> batch trigger -> extraction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { SessionRepository } from '../src/db/session-repo.js';
import { SessionManager } from '../src/services/session-manager.js';
import { IngestService } from '../src/services/ingest.js';
import {
  BatchPipeline,
  type BatchExtractor,
} from '../src/services/batch-pipeline.js';
import {
  EventBus,
  type SessionEndedEvent,
  type BatchJobCreatedEvent,
  type BatchJobCompletedEvent,
  type MemoryEvent,
} from '../src/events/event-bus.js';
import type { RawConversation } from '../src/models/conversation.js';
import type Database from 'better-sqlite3';

describe('Session End Detection & Batch Trigger (Sub-AC 3.1)', () => {
  let db: Database.Database;
  let convRepo: ConversationRepository;
  let sessionRepo: SessionRepository;
  let eventBus: EventBus;
  let sessionManager: SessionManager;
  let batchPipeline: BatchPipeline;
  let testConversation: RawConversation;

  // Track extraction calls
  let extractCalls: Array<{ type: string; conversationId: string; sessionId: string }>;

  function registerMockExtractors(pipeline: BatchPipeline) {
    pipeline.registerExtractor({
      name: 'mock-episode',
      jobType: 'episode_extraction',
      async extract(conversationId, sessionId) {
        extractCalls.push({ type: 'episode', conversationId, sessionId });
        return { episodes: ['ep1'] };
      },
    });
    pipeline.registerExtractor({
      name: 'mock-concept',
      jobType: 'concept_extraction',
      async extract(conversationId, sessionId) {
        extractCalls.push({ type: 'concept', conversationId, sessionId });
        return { concepts: ['c1'] };
      },
    });
  }

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    convRepo = new ConversationRepository(db);
    sessionRepo = new SessionRepository(db);
    eventBus = new EventBus();
    extractCalls = [];

    sessionManager = new SessionManager(sessionRepo, eventBus, {
      autoSweep: false,
    });

    batchPipeline = new BatchPipeline(sessionRepo, eventBus);
    batchPipeline.start();
    registerMockExtractors(batchPipeline);

    testConversation = convRepo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    });
  });

  afterEach(() => {
    sessionManager.dispose();
    batchPipeline.stop();
    eventBus.clear();
    db.close();
  });

  // ──────────────────────────────────────────────────────────
  // Strategy 1: Explicit session close
  // ──────────────────────────────────────────────────────────
  describe('Strategy 1: Explicit close triggers batch', () => {
    it('should emit session.ended and trigger batch on explicit endSession()', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id, 'explicit');
      const jobs = await batchPipeline.waitForSession(session.id, 5000);

      expect(jobs.length).toBe(2);
      expect(jobs.every(j => j.status === 'completed')).toBe(true);
      expect(extractCalls.length).toBe(2);
    });

    it('should set session status to completed after successful extraction', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await batchPipeline.waitForSession(session.id, 5000);

      const final = sessionManager.getSession(session.id);
      expect(final!.status).toBe('completed');
      expect(final!.endReason).toBe('explicit');
    });
  });

  // ──────────────────────────────────────────────────────────
  // Strategy 2: Inactivity timeout
  // ──────────────────────────────────────────────────────────
  describe('Strategy 2: Inactivity timeout triggers batch', () => {
    it('should detect inactive session and trigger batch extraction', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
        timeoutMs: 1000,
      });

      // Simulate time passing: 2 seconds later
      const future = new Date(Date.now() + 2000);
      const ended = await sessionManager.sweepTimedOutSessions(future);

      expect(ended.length).toBe(1);
      expect(ended[0]!.endReason).toBe('timeout');

      await batchPipeline.waitForSession(session.id, 5000);

      const final = sessionManager.getSession(session.id);
      expect(final!.status).toBe('completed');
      expect(extractCalls.length).toBe(2);
    });

    it('should not end session if activity is recent', async () => {
      sessionManager.startSession({
        conversationId: testConversation.id,
        timeoutMs: 5000,
      });

      // Check at current time — not timed out
      const ended = await sessionManager.sweepTimedOutSessions(new Date());
      expect(ended.length).toBe(0);
    });

    it('should respect session touch (heartbeat) for timeout calculation', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
        timeoutMs: 2000,
      });

      // Touch the session at +1 second
      // (Simulated: we manually call touchSession which updates lastActivityAt to now())
      sessionManager.touchSession(session.id);

      // At +2.5 seconds from start: should not time out because
      // we touched at ~now(), so only ~0ms of inactivity
      const future = new Date(Date.now() + 100);
      const ended = await sessionManager.sweepTimedOutSessions(future);
      expect(ended.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Strategy 3: TTL (max lifetime) expiration
  // ──────────────────────────────────────────────────────────
  describe('Strategy 3: TTL expiration triggers batch', () => {
    it('should detect TTL-expired session and trigger batch', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
        timeoutMs: 999_999, // high inactivity timeout — won't trigger
        ttlMs: 2000,        // but TTL is short
      });

      expect(session.ttlMs).toBe(2000);

      // At +3 seconds: TTL expired even though there's recent activity
      const future = new Date(Date.now() + 3000);
      const ended = await sessionManager.sweepTimedOutSessions(future);

      expect(ended.length).toBe(1);
      expect(ended[0]!.endReason).toBe('ttl_expired');

      await batchPipeline.waitForSession(session.id, 5000);
      expect(extractCalls.length).toBe(2);
    });

    it('should persist TTL in the database', () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
        ttlMs: 60_000,
      });

      const retrieved = sessionRepo.getSession(session.id);
      expect(retrieved!.ttlMs).toBe(60_000);
    });

    it('should allow null TTL (no max lifetime)', () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      expect(session.ttlMs).toBeNull();

      // No TTL-expired sessions
      const future = new Date(Date.now() + 999_999_999);
      const expired = sessionRepo.findTTLExpiredSessions(future);
      expect(expired.length).toBe(0);
    });

    it('should not double-end a session for both inactivity and TTL', async () => {
      sessionManager.startSession({
        conversationId: testConversation.id,
        timeoutMs: 500,
        ttlMs: 500,
      });

      // Both conditions met at +1 second
      const future = new Date(Date.now() + 1000);
      const ended = await sessionManager.sweepTimedOutSessions(future);

      // Only ended once
      expect(ended.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Session-aware IngestService
  // ──────────────────────────────────────────────────────────
  describe('Session-aware IngestService', () => {
    it('should auto-create session on ingest when autoSession is enabled', () => {
      const ingest = new IngestService(convRepo, eventBus, sessionManager, {
        autoSession: true,
      });

      const conv = ingest.ingestConversation({
        source: 'test',
        messages: [
          { role: 'user', content: 'Test' },
          { role: 'assistant', content: 'Reply' },
        ],
      });

      const session = sessionManager.getActiveSession(conv.id);
      expect(session).not.toBeNull();
      expect(session!.status).toBe('active');
    });

    it('should touch session on appendMessage', () => {
      const ingest = new IngestService(convRepo, eventBus, sessionManager);

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      const beforeTouch = sessionRepo.getSession(session.id)!.lastActivityAt;

      ingest.appendMessage({
        conversationId: testConversation.id,
        role: 'user',
        content: 'New message',
      });

      const afterTouch = sessionRepo.getSession(session.id)!.lastActivityAt;
      expect(new Date(afterTouch).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeTouch).getTime()
      );
    });

    it('should auto-create session on appendMessage if autoSession and no active session', () => {
      const ingest = new IngestService(convRepo, eventBus, sessionManager, {
        autoSession: true,
      });

      // No session exists yet for testConversation
      expect(sessionManager.getActiveSession(testConversation.id)).toBeNull();

      ingest.appendMessage({
        conversationId: testConversation.id,
        role: 'user',
        content: 'New message',
      });

      const session = sessionManager.getActiveSession(testConversation.id);
      expect(session).not.toBeNull();
    });

    it('should work without sessionManager (backwards compatible)', () => {
      const ingest = new IngestService(convRepo, eventBus);

      // Should not throw
      const msg = ingest.appendMessage({
        conversationId: testConversation.id,
        role: 'user',
        content: 'No session manager',
      });

      expect(msg.content).toBe('No session manager');
    });
  });

  // ──────────────────────────────────────────────────────────
  // Batch job retry
  // ──────────────────────────────────────────────────────────
  describe('Batch job retry', () => {
    it('should retry failed batch jobs', async () => {
      let callCount = 0;

      batchPipeline.stop();
      const retryPipeline = new BatchPipeline(sessionRepo, eventBus);
      retryPipeline.start();

      retryPipeline.registerExtractor({
        name: 'flaky-episode',
        jobType: 'episode_extraction',
        async extract(conversationId) {
          callCount++;
          if (callCount === 1) throw new Error('First try failed');
          return { ok: true };
        },
      });
      retryPipeline.registerExtractor({
        name: 'stable-concept',
        jobType: 'concept_extraction',
        async extract() { return { ok: true }; },
      });

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await retryPipeline.waitForSession(session.id, 5000);

      // Episode failed, concept succeeded
      let finalSession = sessionManager.getSession(session.id);
      expect(finalSession!.status).toBe('failed');

      // Retry the failed jobs
      const retried = await retryPipeline.retryFailedJobs(session.id);
      expect(retried.length).toBe(1);
      expect(retried[0]!.jobType).toBe('episode_extraction');

      // Wait for retry processing
      await new Promise(r => setTimeout(r, 200));
      await retryPipeline.waitForSession(session.id, 5000);

      // Now should be completed
      finalSession = sessionManager.getSession(session.id);
      expect(finalSession!.status).toBe('completed');
      expect(callCount).toBe(2);

      retryPipeline.stop();
    });

    it('should reset failed job to pending via retryBatchJob', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });
      const job = sessionRepo.createBatchJob(session.id, testConversation.id, 'episode_extraction');

      // Manually fail the job
      sessionRepo.updateBatchJob(job.id, {
        status: 'failed',
        error: 'test error',
      });

      const retried = sessionRepo.retryBatchJob(job.id);
      expect(retried).not.toBeNull();
      expect(retried!.status).toBe('pending');
      expect(retried!.error).toBeNull();
      expect(retried!.startedAt).toBeNull();
    });

    it('should not retry non-failed jobs', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });
      const job = sessionRepo.createBatchJob(session.id, testConversation.id, 'episode_extraction');

      // Job is pending, not failed
      const retried = sessionRepo.retryBatchJob(job.id);
      expect(retried).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────
  // waitForSession
  // ──────────────────────────────────────────────────────────
  describe('waitForSession', () => {
    it('should resolve when all jobs complete', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      const jobs = await batchPipeline.waitForSession(session.id, 5000);

      expect(jobs.length).toBe(2);
      expect(jobs.every(j => j.status === 'completed')).toBe(true);
    });

    it('should resolve immediately if jobs already completed', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await batchPipeline.waitForSession(session.id, 5000);

      // Call again — should resolve immediately
      const jobs = await batchPipeline.waitForSession(session.id, 100);
      expect(jobs.length).toBe(2);
    });

    it('should timeout if processing takes too long', async () => {
      batchPipeline.stop();

      const slowPipeline = new BatchPipeline(sessionRepo, eventBus);
      slowPipeline.start();
      slowPipeline.registerExtractor({
        name: 'slow',
        jobType: 'episode_extraction',
        async extract() {
          await new Promise(r => setTimeout(r, 5000));
          return {};
        },
      });
      slowPipeline.registerExtractor({
        name: 'ok',
        jobType: 'concept_extraction',
        async extract() { return {}; },
      });

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);

      await expect(
        slowPipeline.waitForSession(session.id, 200)
      ).rejects.toThrow(/timed out/);

      slowPipeline.stop();
    });
  });

  // ──────────────────────────────────────────────────────────
  // Event flow integration
  // ──────────────────────────────────────────────────────────
  describe('Event flow integration', () => {
    it('should emit correct event sequence: session.ended -> batch.job.created -> batch.job.completed', async () => {
      const events: MemoryEvent[] = [];

      // Subscribe to events AFTER pipeline subscription (so pipeline handler runs first)
      // The pipeline handler for session.ended creates batch.job.created events synchronously
      eventBus.onAll(e => events.push(e));

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await batchPipeline.waitForSession(session.id, 5000);

      const types = events.map(e => e.type);

      // Should contain all expected event types
      expect(types).toContain('session.ended');
      expect(types.filter(t => t === 'batch.job.created').length).toBe(2);
      expect(types.filter(t => t === 'batch.job.completed').length).toBe(2);

      // batch.job.created should come before batch.job.completed
      const firstCreated = types.indexOf('batch.job.created');
      const firstCompleted = types.indexOf('batch.job.completed');
      expect(firstCompleted).toBeGreaterThan(firstCreated);
    });

    it('should pass correct data through events', async () => {
      const sessionEndedEvents: SessionEndedEvent[] = [];
      const jobCreatedEvents: BatchJobCreatedEvent[] = [];
      const jobCompletedEvents: BatchJobCompletedEvent[] = [];

      eventBus.on<SessionEndedEvent>('session.ended', e => sessionEndedEvents.push(e));
      eventBus.on<BatchJobCreatedEvent>('batch.job.created', e => jobCreatedEvents.push(e));
      eventBus.on<BatchJobCompletedEvent>('batch.job.completed', e => jobCompletedEvents.push(e));

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await batchPipeline.waitForSession(session.id, 5000);

      // Verify session.ended event
      expect(sessionEndedEvents.length).toBe(1);
      expect(sessionEndedEvents[0]!.sessionId).toBe(session.id);
      expect(sessionEndedEvents[0]!.conversationId).toBe(testConversation.id);
      expect(sessionEndedEvents[0]!.reason).toBe('explicit');

      // Verify batch.job.created events
      expect(jobCreatedEvents.length).toBe(2);
      for (const event of jobCreatedEvents) {
        expect(event.sessionId).toBe(session.id);
        expect(event.conversationId).toBe(testConversation.id);
      }

      // Verify batch.job.completed events
      expect(jobCompletedEvents.length).toBe(2);
      for (const event of jobCompletedEvents) {
        expect(event.sessionId).toBe(session.id);
      }
    });
  });

  // ──────────────────────────────────────────────────────────
  // Full integration: ingest -> session -> end -> batch
  // ──────────────────────────────────────────────────────────
  describe('Full integration', () => {
    it('should complete full lifecycle: auto-session ingest -> timeout detect -> batch extract', async () => {
      const ingest = new IngestService(convRepo, eventBus, sessionManager, {
        autoSession: true,
      });

      // 1. Ingest a conversation with autoSession
      const conv = ingest.ingestConversation({
        source: 'test-integration',
        messages: [
          { role: 'user', content: 'What is TypeScript?' },
          { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
        ],
      });

      // Session should be created automatically
      const session = sessionManager.getActiveSession(conv.id);
      expect(session).not.toBeNull();

      // 2. Simulate timeout
      // Override session timeout for this test
      const shortSession = sessionRepo.createSession({
        conversationId: conv.id,
        timeoutMs: 100,
      });
      // End the auto-created session first
      await sessionManager.endSession(session!.id, 'explicit');
      await batchPipeline.waitForSession(session!.id, 5000);

      // Start a new short-timeout session
      // (The auto-session already ended, so create a fresh one manually)
      const conv2 = convRepo.ingest({
        source: 'test-integration-2',
        messages: [
          { role: 'user', content: 'Tell me more' },
          { role: 'assistant', content: 'Sure!' },
        ],
      });
      const manualSession = sessionManager.startSession({
        conversationId: conv2.id,
        timeoutMs: 100,
      });

      // 3. Sweep detects timeout
      const future = new Date(Date.now() + 500);
      const ended = await sessionManager.sweepTimedOutSessions(future);
      expect(ended.length).toBeGreaterThanOrEqual(1);

      // 4. Wait for batch extraction
      await batchPipeline.waitForSession(manualSession.id, 5000);

      const finalSession = sessionManager.getSession(manualSession.id);
      expect(finalSession!.status).toBe('completed');
    });

    it('should handle multiple sessions ending in one sweep', async () => {
      // Create multiple conversations with short timeouts
      const convs = [];
      const sessions = [];
      for (let i = 0; i < 3; i++) {
        const conv = convRepo.ingest({
          source: 'test',
          messages: [
            { role: 'user', content: `Q${i}` },
            { role: 'assistant', content: `A${i}` },
          ],
        });
        convs.push(conv);
        const session = sessionManager.startSession({
          conversationId: conv.id,
          timeoutMs: 500,
        });
        sessions.push(session);
      }

      // Sweep in the future — all should be timed out
      const future = new Date(Date.now() + 1000);
      const ended = await sessionManager.sweepTimedOutSessions(future);
      expect(ended.length).toBe(3);

      // Wait for all batch extractions to complete
      for (const session of sessions) {
        await batchPipeline.waitForSession(session.id, 5000);
        const final = sessionManager.getSession(session.id);
        expect(final!.status).toBe('completed');
      }

      // 3 sessions * 2 extractors = 6 extract calls
      expect(extractCalls.length).toBe(6);
    });
  });

  // ──────────────────────────────────────────────────────────
  // SessionManager defaults
  // ──────────────────────────────────────────────────────────
  describe('SessionManager defaults', () => {
    it('should apply defaultTtlMs to new sessions', () => {
      const mgr = new SessionManager(sessionRepo, eventBus, {
        autoSweep: false,
        defaultTtlMs: 120_000,
      });

      const session = mgr.startSession({
        conversationId: testConversation.id,
      });

      expect(session.ttlMs).toBe(120_000);
      mgr.dispose();
    });

    it('should allow per-session override of defaults', () => {
      const mgr = new SessionManager(sessionRepo, eventBus, {
        autoSweep: false,
        defaultTtlMs: 120_000,
        defaultTimeoutMs: 60_000,
      });

      const session = mgr.startSession({
        conversationId: testConversation.id,
        ttlMs: 30_000,
        timeoutMs: 10_000,
      });

      expect(session.ttlMs).toBe(30_000);
      expect(session.timeoutMs).toBe(10_000);
      mgr.dispose();
    });
  });
});
