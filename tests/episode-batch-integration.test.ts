/**
 * Integration tests for Episode batch extraction.
 *
 * Tests the full flow:
 * 1. Ingest a conversation into the DB
 * 2. Run EpisodeBatchExtractor (which bridges EpisodeExtractor → DB)
 * 3. Verify episodes are stored and retrievable
 * 4. Verify batch pipeline integration via event-driven flow
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CREATE_TABLES } from '../src/db/schema.js';
import { CREATE_GRAPH_TABLES } from '../src/db/graph-schema.js';
import { CREATE_ANCHOR_TABLES } from '../src/db/anchor-schema.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { EpisodeRepository } from '../src/db/episode-repo.js';
import { SessionRepository } from '../src/db/session-repo.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { EpisodeExtractor } from '../src/extraction/episode-extractor.js';
import { EpisodeBatchExtractor } from '../src/services/episode-batch-extractor.js';
import { BatchPipeline } from '../src/services/batch-pipeline.js';
import { EventBus } from '../src/events/event-bus.js';
import type { Episode } from '../src/models/episode.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES);
  db.exec(CREATE_GRAPH_TABLES);
  db.exec(CREATE_ANCHOR_TABLES);
  return db;
}

function makeLLMEpisodeResponse(
  episodes: Array<Record<string, unknown>>,
): string {
  return JSON.stringify(episodes);
}

describe('Episode Batch Integration', () => {
  let db: Database.Database;
  let conversationRepo: ConversationRepository;
  let episodeRepo: EpisodeRepository;
  let llm: MockLLMProvider;
  let episodeExtractor: EpisodeExtractor;
  let batchExtractor: EpisodeBatchExtractor;

  beforeEach(() => {
    db = createTestDb();
    conversationRepo = new ConversationRepository(db);
    episodeRepo = new EpisodeRepository(db);
    llm = new MockLLMProvider();
    episodeExtractor = new EpisodeExtractor(llm);
    batchExtractor = new EpisodeBatchExtractor(
      conversationRepo,
      episodeRepo,
      episodeExtractor,
    );
  });

  afterEach(() => {
    db.close();
  });

  describe('EpisodeBatchExtractor', () => {
    it('should extract episodes from a stored conversation and persist them', async () => {
      // 1. Ingest a conversation
      const conv = conversationRepo.ingest({
        source: 'test',
        title: 'TypeScript Project Setup',
        messages: [
          { role: 'user', content: 'Can you help me set up a TypeScript project?' },
          { role: 'assistant', content: 'Sure! Let me create the tsconfig.json for you.' },
          { role: 'user', content: 'Now let\'s add vitest for testing.' },
          { role: 'assistant', content: 'I\'ve configured vitest with the following settings...' },
        ],
      });

      // 2. Mock LLM response
      llm.addResponse(
        makeLLMEpisodeResponse([
          {
            type: 'action',
            title: 'Set up TypeScript project',
            description:
              'The assistant created a tsconfig.json for the TypeScript project setup.',
            startTurnIndex: 0,
            endTurnIndex: 1,
            actors: ['user', 'assistant'],
            outcome: 'TypeScript project configured',
          },
          {
            type: 'action',
            title: 'Configure vitest',
            description:
              'Added vitest testing framework configuration to the project.',
            startTurnIndex: 2,
            endTurnIndex: 3,
            actors: ['user', 'assistant'],
            outcome: 'Vitest configured',
          },
        ]),
      );

      // 3. Run batch extraction
      const result = await batchExtractor.extract(conv.id, 'session-1');

      // 4. Verify result summary
      expect(result.episodeCount).toBe(2);
      expect(result.extractionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.episodeTypes).toEqual({ action: 2 });

      // 5. Verify episodes are persisted in DB
      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored).toHaveLength(2);

      // Verify first episode
      expect(stored[0].type).toBe('action');
      expect(stored[0].title).toBe('Set up TypeScript project');
      expect(stored[0].conversationId).toBe(conv.id);
      expect(stored[0].startTurnIndex).toBe(0);
      expect(stored[0].endTurnIndex).toBe(1);
      expect(stored[0].actors).toEqual(['user', 'assistant']);
      expect(stored[0].outcome).toBe('TypeScript project configured');
      expect(stored[0].sourceMessageIds).toHaveLength(2);

      // Verify second episode
      expect(stored[1].title).toBe('Configure vitest');
      expect(stored[1].startTurnIndex).toBe(2);
      expect(stored[1].endTurnIndex).toBe(3);
    });

    it('should return skipped result for empty conversations', async () => {
      const conv = conversationRepo.ingest({
        source: 'test',
        messages: [],
      });

      const result = await batchExtractor.extract(conv.id, 'session-1');
      expect(result.episodeCount).toBe(0);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('empty conversation');
    });

    it('should throw for non-existent conversation', async () => {
      await expect(
        batchExtractor.extract('non-existent-id', 'session-1'),
      ).rejects.toThrow('Conversation not found');
    });

    it('should throw when LLM extraction fails', async () => {
      const conv = conversationRepo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
        ],
      });

      llm.addResponse('not valid json at all');

      await expect(
        batchExtractor.extract(conv.id, 'session-1'),
      ).rejects.toThrow();
    });

    it('should support re-extraction (delete old episodes first)', async () => {
      const conv = conversationRepo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First response' },
        ],
      });

      // First extraction
      llm.addResponse(
        makeLLMEpisodeResponse([
          {
            type: 'action',
            title: 'First extraction',
            description: 'Original episode.',
            startTurnIndex: 0,
            endTurnIndex: 1,
            actors: ['user'],
          },
        ]),
      );
      await batchExtractor.extract(conv.id, 'session-1');
      expect(episodeRepo.countEpisodes(conv.id)).toBe(1);

      // Re-extraction with different result
      llm.addResponse(
        makeLLMEpisodeResponse([
          {
            type: 'decision',
            title: 'Re-extracted episode A',
            description: 'New episode A.',
            startTurnIndex: 0,
            endTurnIndex: 0,
            actors: ['user'],
          },
          {
            type: 'discovery',
            title: 'Re-extracted episode B',
            description: 'New episode B.',
            startTurnIndex: 1,
            endTurnIndex: 1,
            actors: ['assistant'],
          },
        ]),
      );

      const result = await batchExtractor.extract(conv.id, 'session-1');
      expect(result.episodeCount).toBe(2);
      expect(result.previousEpisodesDeleted).toBe(1);

      // Old episodes replaced
      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored).toHaveLength(2);
      expect(stored[0].title).toBe('Re-extracted episode A');
      expect(stored[1].title).toBe('Re-extracted episode B');
    });

    it('should correctly map source message IDs from DB', async () => {
      const conv = conversationRepo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
          { role: 'user', content: 'C' },
        ],
      });

      llm.addResponse(
        makeLLMEpisodeResponse([
          {
            type: 'action',
            title: 'Full span',
            description: 'All turns.',
            startTurnIndex: 0,
            endTurnIndex: 2,
            actors: ['user', 'assistant'],
          },
        ]),
      );

      await batchExtractor.extract(conv.id, 'session-1');
      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored).toHaveLength(1);

      // sourceMessageIds should match turn-based refs (conversationId:turnIndex)
      const dbMessages = conversationRepo.getMessages(conv.id);
      expect(stored[0].sourceMessageIds).toEqual(
        dbMessages.map((m) => `${m.conversationId}:${m.turnIndex}`),
      );
    });

    it('should extract all four episode types', async () => {
      const conv = conversationRepo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'Why is the build failing?' },
          { role: 'assistant', content: 'I found a bug in the config.' },
          { role: 'user', content: 'Let\'s use Bun instead of Node.' },
          { role: 'assistant', content: 'Migrated to Bun runtime.' },
          { role: 'user', content: 'The CI just passed!' },
          { role: 'assistant', content: 'Great, deploying now.' },
        ],
      });

      llm.addResponse(
        makeLLMEpisodeResponse([
          {
            type: 'discovery',
            title: 'Found config bug',
            description: 'Identified a bug in the build config.',
            startTurnIndex: 0,
            endTurnIndex: 1,
            actors: ['assistant'],
            outcome: 'Bug identified',
          },
          {
            type: 'decision',
            title: 'Switch to Bun',
            description: 'Decided to switch from Node to Bun runtime.',
            startTurnIndex: 2,
            endTurnIndex: 2,
            actors: ['user'],
            outcome: 'Bun selected',
          },
          {
            type: 'action',
            title: 'Migrate to Bun',
            description: 'Migrated the project from Node to Bun.',
            startTurnIndex: 2,
            endTurnIndex: 3,
            actors: ['user', 'assistant'],
            outcome: 'Migration complete',
          },
          {
            type: 'event',
            title: 'CI passed',
            description: 'The CI pipeline passed after the migration.',
            startTurnIndex: 4,
            endTurnIndex: 5,
            actors: ['user', 'assistant'],
          },
        ]),
      );

      await batchExtractor.extract(conv.id, 'session-1');
      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored).toHaveLength(4);

      const types = stored.map((e) => e.type);
      expect(types).toContain('action');
      expect(types).toContain('decision');
      expect(types).toContain('event');
      expect(types).toContain('discovery');

      // Verify retrieval by type
      const decisions = episodeRepo.getEpisodesByType('decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].title).toBe('Switch to Bun');
    });

    it('should expose correct BatchExtractor interface properties', () => {
      expect(batchExtractor.name).toBe('episode-batch-extractor');
      expect(batchExtractor.jobType).toBe('episode_extraction');
    });
  });

  describe('BatchPipeline integration', () => {
    it('should process episode extraction via batch pipeline event flow', async () => {
      // Setup
      const sessionRepo = new SessionRepository(db);
      const eventBus = new EventBus();
      const pipeline = new BatchPipeline(sessionRepo, eventBus, {
        jobTypes: ['episode_extraction'],
      });

      pipeline.registerExtractor(batchExtractor);
      pipeline.start();

      // Ingest conversation
      const conv = conversationRepo.ingest({
        source: 'test',
        title: 'Pipeline test',
        messages: [
          { role: 'user', content: 'Write a function' },
          { role: 'assistant', content: 'Here is the function.' },
        ],
      });

      // Create session
      const session = sessionRepo.createSession({
        conversationId: conv.id,
      });

      // Mock LLM
      llm.addResponse(
        makeLLMEpisodeResponse([
          {
            type: 'action',
            title: 'Write function',
            description: 'Wrote a function as requested.',
            startTurnIndex: 0,
            endTurnIndex: 1,
            actors: ['user', 'assistant'],
            outcome: 'Function written',
          },
        ]),
      );

      // Trigger session ended
      const jobs = await pipeline.onSessionEnded({
        type: 'session.ended',
        sessionId: session.id,
        conversationId: conv.id,
        reason: 'explicit',
        timestamp: new Date().toISOString(),
      });

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobType).toBe('episode_extraction');

      // Wait for async processing to complete
      // onSessionEnded fires processJobs() non-blocking, so we need to wait
      await new Promise((r) => setTimeout(r, 50));

      // Verify episodes were stored
      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored).toHaveLength(1);
      expect(stored[0].title).toBe('Write function');

      // Verify job completed
      const sessionJobs = pipeline.getSessionJobs(session.id);
      expect(sessionJobs).toHaveLength(1);
      expect(sessionJobs[0].status).toBe('completed');

      pipeline.stop();
    });

    it('should handle extraction failure in pipeline gracefully', async () => {
      const sessionRepo = new SessionRepository(db);
      const eventBus = new EventBus();
      const pipeline = new BatchPipeline(sessionRepo, eventBus, {
        jobTypes: ['episode_extraction'],
      });

      pipeline.registerExtractor(batchExtractor);

      // Ingest conversation
      const conv = conversationRepo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
        ],
      });

      const session = sessionRepo.createSession({
        conversationId: conv.id,
      });

      // Mock LLM to return invalid response
      llm.addResponse('totally broken json {{{');

      await pipeline.onSessionEnded({
        type: 'session.ended',
        sessionId: session.id,
        conversationId: conv.id,
        reason: 'explicit',
        timestamp: new Date().toISOString(),
      });

      // Wait for async processing to complete
      await new Promise((r) => setTimeout(r, 50));

      // Job should be marked as failed
      const sessionJobs = pipeline.getSessionJobs(session.id);
      expect(sessionJobs).toHaveLength(1);
      expect(sessionJobs[0].status).toBe('failed');
      expect(sessionJobs[0].error).toBeDefined();

      // No episodes stored
      expect(episodeRepo.countEpisodes(conv.id)).toBe(0);
    });
  });

  describe('EpisodeRepository round-trip', () => {
    it('should store and retrieve episodes with all fields intact', async () => {
      const conv = conversationRepo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
        ],
      });

      llm.addResponse(
        makeLLMEpisodeResponse([
          {
            type: 'discovery',
            title: 'Important Finding',
            description: 'Found something critical during analysis.',
            startTurnIndex: 0,
            endTurnIndex: 1,
            actors: ['assistant'],
            outcome: 'Documented for future reference',
          },
        ]),
      );

      await batchExtractor.extract(conv.id, 'session-1');

      // Retrieve and verify all fields
      const episodes = episodeRepo.getEpisodesByConversation(conv.id);
      expect(episodes).toHaveLength(1);

      const ep = episodes[0];
      expect(ep.id).toBeDefined();
      expect(ep.conversationId).toBe(conv.id);
      expect(ep.type).toBe('discovery');
      expect(ep.title).toBe('Important Finding');
      expect(ep.description).toBe('Found something critical during analysis.');
      expect(ep.startTurnIndex).toBe(0);
      expect(ep.endTurnIndex).toBe(1);
      expect(ep.sourceMessageIds).toHaveLength(2);
      expect(ep.actors).toEqual(['assistant']);
      expect(ep.outcome).toBe('Documented for future reference');
      expect(ep.createdAt).toBeDefined();
      expect(ep.metadata).toBeDefined();
      expect(ep.metadata?.extractionModel).toBe('mock');

      // Also verify getEpisode by ID
      const byId = episodeRepo.getEpisode(ep.id);
      expect(byId).not.toBeNull();
      expect(byId!.title).toBe('Important Finding');
    });
  });
});
