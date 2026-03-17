/**
 * Tests for session lifecycle management and batch extraction pipeline.
 *
 * Covers:
 * - Session creation, touch, explicit end
 * - Inactivity timeout detection via sweep
 * - EventBus event emission on session end
 * - BatchPipeline job creation on session.ended event
 * - Batch job execution with registered extractors
 * - Error handling for missing extractors and failed extraction
 * - Session status transitions through full lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { SessionRepository } from '../src/db/session-repo.js';
import { SessionManager } from '../src/services/session-manager.js';
import { BatchPipeline, type BatchExtractor } from '../src/services/batch-pipeline.js';
import { EventBus, type SessionEndedEvent, type BatchJobCreatedEvent, type BatchJobCompletedEvent, type BatchJobFailedEvent, type MemoryEvent } from '../src/events/event-bus.js';
import type { RawConversation } from '../src/models/conversation.js';
import type Database from 'better-sqlite3';

describe('Session & Batch Pipeline', () => {
  let db: Database.Database;
  let convRepo: ConversationRepository;
  let sessionRepo: SessionRepository;
  let eventBus: EventBus;
  let sessionManager: SessionManager;
  let batchPipeline: BatchPipeline;
  let testConversation: RawConversation;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    convRepo = new ConversationRepository(db);
    sessionRepo = new SessionRepository(db);
    eventBus = new EventBus();

    // Create session manager with auto-sweep disabled for deterministic tests
    sessionManager = new SessionManager(sessionRepo, eventBus, {
      autoSweep: false,
    });

    batchPipeline = new BatchPipeline(sessionRepo, eventBus);
    batchPipeline.start();

    // Create a test conversation
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

  describe('SessionRepository', () => {
    it('should create a session', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      expect(session.id).toBeTruthy();
      expect(session.conversationId).toBe(testConversation.id);
      expect(session.status).toBe('active');
      expect(session.startedAt).toBeTruthy();
      expect(session.lastActivityAt).toBeTruthy();
      expect(session.endedAt).toBeNull();
      expect(session.endReason).toBeNull();
      expect(session.timeoutMs).toBe(30 * 60 * 1000); // 30min default
    });

    it('should get a session by ID', () => {
      const created = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      const fetched = sessionRepo.getSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.conversationId).toBe(testConversation.id);
    });

    it('should get active session for a conversation', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      const active = sessionRepo.getActiveSession(testConversation.id);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(session.id);
    });

    it('should return null for non-existent active session', () => {
      const active = sessionRepo.getActiveSession('non-existent');
      expect(active).toBeNull();
    });

    it('should touch session and update last_activity_at', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      // Small delay to ensure different timestamp
      const before = session.lastActivityAt;
      sessionRepo.touchSession(session.id);
      const updated = sessionRepo.getSession(session.id)!;

      expect(updated.lastActivityAt).toBeTruthy();
      // The timestamp should be >= the original
      expect(new Date(updated.lastActivityAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime()
      );
    });

    it('should end a session', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      const ended = sessionRepo.endSession(session.id, 'explicit');
      expect(ended).not.toBeNull();
      expect(ended!.status).toBe('ended');
      expect(ended!.endedAt).toBeTruthy();
      expect(ended!.endReason).toBe('explicit');
    });

    it('should not end an already ended session', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      sessionRepo.endSession(session.id, 'explicit');
      // Try to end again - the UPDATE won't match (status != 'active')
      const result = sessionRepo.endSession(session.id, 'timeout');
      // It returns the session but status is still 'ended' with original reason
      expect(result!.endReason).toBe('explicit');
    });

    it('should find timed-out sessions', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
        timeoutMs: 1000, // 1 second timeout
      });

      // Not timed out yet
      const notTimedOut = sessionRepo.findTimedOutSessions(new Date());
      expect(notTimedOut.length).toBe(0);

      // Simulate time passage (2 seconds later)
      const futureTime = new Date(Date.now() + 2000);
      const timedOut = sessionRepo.findTimedOutSessions(futureTime);
      expect(timedOut.length).toBe(1);
      expect(timedOut[0]!.id).toBe(session.id);
    });

    it('should create a batch job', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      const job = sessionRepo.createBatchJob(
        session.id,
        testConversation.id,
        'episode_extraction'
      );

      expect(job.id).toBeTruthy();
      expect(job.sessionId).toBe(session.id);
      expect(job.conversationId).toBe(testConversation.id);
      expect(job.jobType).toBe('episode_extraction');
      expect(job.status).toBe('pending');
    });

    it('should update batch job status', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });
      const job = sessionRepo.createBatchJob(
        session.id,
        testConversation.id,
        'episode_extraction'
      );

      const updated = sessionRepo.updateBatchJob(job.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('running');
      expect(updated!.startedAt).toBeTruthy();
    });

    it('should get pending batch jobs', () => {
      const session = sessionRepo.createSession({
        conversationId: testConversation.id,
      });

      sessionRepo.createBatchJob(session.id, testConversation.id, 'episode_extraction');
      sessionRepo.createBatchJob(session.id, testConversation.id, 'concept_extraction');

      const pending = sessionRepo.getPendingBatchJobs();
      expect(pending.length).toBe(2);
    });
  });

  describe('SessionManager', () => {
    it('should start a session for a conversation', () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      expect(session.status).toBe('active');
      expect(session.conversationId).toBe(testConversation.id);
    });

    it('should return existing active session instead of creating a new one', () => {
      const first = sessionManager.startSession({
        conversationId: testConversation.id,
      });
      const second = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      expect(second.id).toBe(first.id);
    });

    it('should explicitly end a session', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      const ended = await sessionManager.endSession(session.id);
      expect(ended).not.toBeNull();
      expect(ended!.status).toBe('ended');
      expect(ended!.endReason).toBe('explicit');
    });

    it('should emit session.ended event on explicit end', async () => {
      const events: SessionEndedEvent[] = [];
      eventBus.on<SessionEndedEvent>('session.ended', (e) => {
        events.push(e);
      });

      // Stop the pipeline to isolate event testing
      batchPipeline.stop();

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);

      expect(events.length).toBe(1);
      expect(events[0]!.sessionId).toBe(session.id);
      expect(events[0]!.conversationId).toBe(testConversation.id);
      expect(events[0]!.reason).toBe('explicit');
    });

    it('should sweep timed-out sessions', async () => {
      const events: SessionEndedEvent[] = [];
      eventBus.on<SessionEndedEvent>('session.ended', (e) => {
        events.push(e);
      });

      // Stop the pipeline
      batchPipeline.stop();

      sessionManager.startSession({
        conversationId: testConversation.id,
        timeoutMs: 1000,
      });

      // Sweep now - should find nothing
      const none = await sessionManager.sweepTimedOutSessions(new Date());
      expect(none.length).toBe(0);

      // Sweep in the future - should find the timed-out session
      const future = new Date(Date.now() + 2000);
      const ended = await sessionManager.sweepTimedOutSessions(future);
      expect(ended.length).toBe(1);
      expect(ended[0]!.endReason).toBe('timeout');

      expect(events.length).toBe(1);
      expect(events[0]!.reason).toBe('timeout');
    });

    it('should get active session', () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      const active = sessionManager.getActiveSession(testConversation.id);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(session.id);
    });

    it('should return null for active session after end', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      // Stop pipeline to avoid async issues
      batchPipeline.stop();

      await sessionManager.endSession(session.id);

      const active = sessionManager.getActiveSession(testConversation.id);
      expect(active).toBeNull();
    });
  });

  describe('BatchPipeline', () => {
    it('should create batch jobs when session ends', async () => {
      const jobEvents: BatchJobCreatedEvent[] = [];
      eventBus.on<BatchJobCreatedEvent>('batch.job.created', (e) => {
        jobEvents.push(e);
      });

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);

      // Should create 2 jobs: episode_extraction and concept_extraction
      expect(jobEvents.length).toBe(2);
      expect(jobEvents.map((e) => e.jobType).sort()).toEqual([
        'concept_extraction',
        'episode_extraction',
      ]);
    });

    it('should mark session as processing after job creation', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      const updated = sessionRepo.getSession(session.id);
      // Should be processing or failed (no extractors registered)
      expect(['processing', 'failed']).toContain(updated!.status);
    });

    it('should execute registered extractors', async () => {
      const extractCalls: string[] = [];

      const mockEpisodeExtractor: BatchExtractor = {
        name: 'mock-episode',
        jobType: 'episode_extraction',
        async extract(conversationId, sessionId) {
          extractCalls.push(`episode:${conversationId}`);
          return { episodeCount: 3 };
        },
      };

      const mockConceptExtractor: BatchExtractor = {
        name: 'mock-concept',
        jobType: 'concept_extraction',
        async extract(conversationId, sessionId) {
          extractCalls.push(`concept:${conversationId}`);
          return { conceptCount: 5 };
        },
      };

      batchPipeline.registerExtractor(mockEpisodeExtractor);
      batchPipeline.registerExtractor(mockConceptExtractor);

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(extractCalls.length).toBe(2);
      expect(extractCalls).toContain(`episode:${testConversation.id}`);
      expect(extractCalls).toContain(`concept:${testConversation.id}`);

      // Session should be completed
      const updated = sessionRepo.getSession(session.id);
      expect(updated!.status).toBe('completed');
    });

    it('should handle extractor failure gracefully', async () => {
      const failedEvents: BatchJobFailedEvent[] = [];
      eventBus.on<BatchJobFailedEvent>('batch.job.failed', (e) => {
        failedEvents.push(e);
      });

      const failingExtractor: BatchExtractor = {
        name: 'failing-episode',
        jobType: 'episode_extraction',
        async extract() {
          throw new Error('LLM API call failed');
        },
      };

      batchPipeline.registerExtractor(failingExtractor);

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);

      // Wait for async processing to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Both episode (failed) and concept (no extractor = failed) should fail
      expect(failedEvents.length).toBeGreaterThanOrEqual(1);

      const episodeFail = failedEvents.find((e) => e.jobType === 'episode_extraction');
      expect(episodeFail).toBeTruthy();
      expect(episodeFail!.error).toBe('LLM API call failed');

      // Session should be marked as failed
      const updated = sessionRepo.getSession(session.id);
      expect(updated!.status).toBe('failed');
    });

    it('should emit batch.job.completed events', async () => {
      const completedEvents: BatchJobCompletedEvent[] = [];
      eventBus.on<BatchJobCompletedEvent>('batch.job.completed', (e) => {
        completedEvents.push(e);
      });

      batchPipeline.registerExtractor({
        name: 'mock-episode',
        jobType: 'episode_extraction',
        async extract() { return { ok: true }; },
      });
      batchPipeline.registerExtractor({
        name: 'mock-concept',
        jobType: 'concept_extraction',
        async extract() { return { ok: true }; },
      });

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(completedEvents.length).toBe(2);
    });

    it('should get session jobs', async () => {
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const jobs = batchPipeline.getSessionJobs(session.id);
      expect(jobs.length).toBe(2);
    });

    it('should support custom job types', async () => {
      batchPipeline.stop();

      const customPipeline = new BatchPipeline(sessionRepo, eventBus, {
        jobTypes: ['full_extraction'],
      });
      customPipeline.start();

      const extractCalls: string[] = [];
      customPipeline.registerExtractor({
        name: 'full',
        jobType: 'full_extraction',
        async extract(conversationId) {
          extractCalls.push(conversationId);
          return { full: true };
        },
      });

      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });

      await sessionManager.endSession(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(extractCalls.length).toBe(1);

      const jobs = customPipeline.getSessionJobs(session.id);
      expect(jobs.length).toBe(1);
      expect(jobs[0]!.jobType).toBe('full_extraction');

      customPipeline.stop();
    });
  });

  describe('EventBus', () => {
    it('should support subscribing and unsubscribing', async () => {
      const events: MemoryEvent[] = [];
      const unsub = eventBus.on<SessionEndedEvent>('session.ended', (e) => {
        events.push(e);
      });

      await eventBus.emit({
        type: 'session.ended',
        sessionId: 'test',
        conversationId: 'test',
        reason: 'explicit',
        timestamp: new Date().toISOString(),
      });

      expect(events.length).toBe(1);

      unsub();

      await eventBus.emit({
        type: 'session.ended',
        sessionId: 'test2',
        conversationId: 'test2',
        reason: 'explicit',
        timestamp: new Date().toISOString(),
      });

      // Should still be 1 after unsubscribing
      expect(events.length).toBe(1);
    });

    it('should support onAll handler', async () => {
      const events: MemoryEvent[] = [];
      eventBus.onAll((e) => {
        events.push(e);
      });

      // Stop pipeline so it doesn't interfere
      batchPipeline.stop();

      await eventBus.emit({
        type: 'session.ended',
        sessionId: 'a',
        conversationId: 'a',
        reason: 'explicit',
        timestamp: new Date().toISOString(),
      });

      await eventBus.emit({
        type: 'batch.job.created',
        jobId: 'b',
        sessionId: 'a',
        conversationId: 'a',
        jobType: 'episode_extraction',
        timestamp: new Date().toISOString(),
      });

      expect(events.length).toBe(2);
    });

    it('should handle errors in event handlers gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      eventBus.on<SessionEndedEvent>('session.ended', () => {
        throw new Error('Handler crash');
      });

      // Stop pipeline
      batchPipeline.stop();

      // Should not throw
      await eventBus.emit({
        type: 'session.ended',
        sessionId: 'test',
        conversationId: 'test',
        reason: 'explicit',
        timestamp: new Date().toISOString(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('Full Lifecycle Integration', () => {
    it('should handle complete session lifecycle: start -> activity -> end -> extract', async () => {
      const allEvents: MemoryEvent[] = [];
      eventBus.onAll((e) => allEvents.push(e));

      // Register extractors
      batchPipeline.registerExtractor({
        name: 'episode',
        jobType: 'episode_extraction',
        async extract() { return { episodes: ['ep1', 'ep2'] }; },
      });
      batchPipeline.registerExtractor({
        name: 'concept',
        jobType: 'concept_extraction',
        async extract() { return { concepts: ['c1'] }; },
      });

      // 1. Start session
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
      });
      expect(session.status).toBe('active');

      // 2. Record activity
      sessionManager.touchSession(session.id);

      // 3. End session
      await sessionManager.endSession(session.id);

      // 4. Wait for batch processing
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify events: session.ended, 2x batch.job.created, 2x batch.job.completed
      const eventTypes = allEvents.map((e) => e.type);
      expect(eventTypes).toContain('session.ended');
      expect(eventTypes.filter((t) => t === 'batch.job.created').length).toBe(2);
      expect(eventTypes.filter((t) => t === 'batch.job.completed').length).toBe(2);

      // Verify final session status
      const finalSession = sessionManager.getSession(session.id);
      expect(finalSession!.status).toBe('completed');

      // Verify jobs have results
      const jobs = batchPipeline.getSessionJobs(session.id);
      expect(jobs.length).toBe(2);
      for (const job of jobs) {
        expect(job.status).toBe('completed');
        expect(job.result).toBeTruthy();
        expect(job.completedAt).toBeTruthy();
      }
    });

    it('should handle timeout-based session end with batch extraction', async () => {
      // Register extractors
      batchPipeline.registerExtractor({
        name: 'episode',
        jobType: 'episode_extraction',
        async extract() { return { ok: true }; },
      });
      batchPipeline.registerExtractor({
        name: 'concept',
        jobType: 'concept_extraction',
        async extract() { return { ok: true }; },
      });

      // Start with short timeout
      const session = sessionManager.startSession({
        conversationId: testConversation.id,
        timeoutMs: 500,
      });

      // Sweep in the future
      const future = new Date(Date.now() + 1000);
      const ended = await sessionManager.sweepTimedOutSessions(future);
      expect(ended.length).toBe(1);
      expect(ended[0]!.endReason).toBe('timeout');

      // Wait for batch processing
      await new Promise((resolve) => setTimeout(resolve, 150));

      const finalSession = sessionManager.getSession(session.id);
      expect(finalSession!.status).toBe('completed');
    });
  });
});
