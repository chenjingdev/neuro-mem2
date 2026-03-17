/**
 * End-to-end integration test for the batch extraction pipeline.
 *
 * Sub-AC 3.4: 세션 종료 → 추출 → 저장 전체 흐름의 end-to-end 테스트
 *
 * Tests the full lifecycle:
 *   1. Ingest a conversation
 *   2. Start and end a session
 *   3. BatchPipeline triggers Episode + Concept extraction (via mock LLM)
 *   4. Extracted nodes are stored in the graph DB (episodes, concepts, edges)
 *   5. Verify stored data matches extraction output
 *   6. Verify original conversation data is immutable
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { EpisodeRepository } from '../src/db/episode-repo.js';
import { ConceptRepository } from '../src/db/concept-repo.js';
import { EdgeRepository } from '../src/db/edge-repo.js';
import { SessionRepository } from '../src/db/session-repo.js';
import { IngestService } from '../src/services/ingest.js';
import { SessionManager } from '../src/services/session-manager.js';
import { BatchPipeline, type BatchExtractor } from '../src/services/batch-pipeline.js';
import { EventBus, type BatchJobCompletedEvent, type BatchJobFailedEvent, type MemoryEvent } from '../src/events/event-bus.js';
import { EpisodeExtractor } from '../src/extraction/episode-extractor.js';
import { ConceptExtractor } from '../src/extraction/concept-extractor.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import type { RawConversation } from '../src/models/conversation.js';
import type Database from 'better-sqlite3';

// ─── Mock LLM Responses ─────────────────────────────────────

/** Realistic mock episode extraction response (parser expects a plain JSON array) */
const MOCK_EPISODE_RESPONSE = JSON.stringify([
  {
    type: 'decision',
    title: 'Decided to migrate to TypeScript',
    description: 'The user decided to migrate their JavaScript project to TypeScript for better type safety.',
    startTurnIndex: 0,
    endTurnIndex: 1,
    actors: ['user', 'assistant'],
    outcome: 'Migration plan initiated',
  },
  {
    type: 'action',
    title: 'Configured tsconfig.json for React + Webpack',
    description: 'Set up TypeScript compiler configuration with strict mode and JSX support for the React + Webpack project.',
    startTurnIndex: 2,
    endTurnIndex: 3,
    actors: ['assistant'],
    outcome: 'TypeScript configuration ready',
  },
  {
    type: 'action',
    title: 'Started converting utility files',
    description: 'Began the TypeScript migration by converting utility files first, as they have fewer dependencies.',
    startTurnIndex: 4,
    endTurnIndex: 5,
    actors: ['user', 'assistant'],
    outcome: 'Utility files queued for conversion',
  },
]);

/** Realistic mock concept extraction response */
const MOCK_CONCEPT_RESPONSE = JSON.stringify({
  concepts: [
    {
      name: 'TypeScript',
      description: 'Statically typed superset of JavaScript used as the target language for migration',
      aliases: ['TS'],
      category: 'technology',
      relevance: 0.95,
      relatedConcepts: ['React', 'Strict Mode'],
    },
    {
      name: 'React',
      description: 'UI component library used in the project alongside Webpack',
      aliases: ['React.js', 'ReactJS'],
      category: 'technology',
      relevance: 0.85,
      relatedConcepts: ['TypeScript', 'Webpack'],
    },
    {
      name: 'Webpack',
      description: 'Module bundler used for the JavaScript/TypeScript build pipeline',
      category: 'technology',
      relevance: 0.7,
      relatedConcepts: ['React'],
    },
    {
      name: 'Strict Mode',
      description: 'TypeScript compiler option for strict type checking, chosen as the project default',
      category: 'preference',
      relevance: 0.8,
      relatedConcepts: ['TypeScript'],
    },
  ],
});

// ─── Test Helpers ────────────────────────────────────────────

function createConversationMessages() {
  return [
    { role: 'user' as const, content: 'I want to migrate our project from JavaScript to TypeScript.' },
    { role: 'assistant' as const, content: 'Great choice! Let me help you plan the migration. First, we should set up tsconfig.json.' },
    { role: 'user' as const, content: 'We use React with Webpack. What settings do you recommend?' },
    { role: 'assistant' as const, content: 'For a React + Webpack project, I recommend strict mode with JSX support. Here is a sample config...' },
    { role: 'user' as const, content: 'We decided to use strict mode. Let\'s start with the util files.' },
    { role: 'assistant' as const, content: 'Good plan. I\'ll convert the utility files first since they have fewer dependencies.' },
  ];
}

describe('Batch Extraction E2E: Session End → Extract → Store', () => {
  let db: Database.Database;
  let convRepo: ConversationRepository;
  let episodeRepo: EpisodeRepository;
  let conceptRepo: ConceptRepository;
  let edgeRepo: EdgeRepository;
  let sessionRepo: SessionRepository;
  let eventBus: EventBus;
  let ingestService: IngestService;
  let sessionManager: SessionManager;
  let batchPipeline: BatchPipeline;
  let mockLLM: MockLLMProvider;
  let conversation: RawConversation;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    convRepo = new ConversationRepository(db);
    episodeRepo = new EpisodeRepository(db);
    conceptRepo = new ConceptRepository(db);
    edgeRepo = new EdgeRepository(db);
    sessionRepo = new SessionRepository(db);
    eventBus = new EventBus();
    ingestService = new IngestService(convRepo);
    mockLLM = new MockLLMProvider();

    sessionManager = new SessionManager(sessionRepo, eventBus, {
      autoSweep: false,
    });

    batchPipeline = new BatchPipeline(sessionRepo, eventBus);
    batchPipeline.start();

    // Ingest a test conversation
    conversation = ingestService.ingestConversation({
      source: 'claude-code',
      title: 'TypeScript Migration Discussion',
      messages: createConversationMessages(),
    });
  });

  afterEach(() => {
    sessionManager.dispose();
    batchPipeline.stop();
    eventBus.clear();
    db.close();
  });

  /**
   * Create a BatchExtractor that uses the EpisodeExtractor with mock LLM,
   * and stores the resulting episodes + temporal edges in the DB.
   */
  function createEpisodeBatchExtractor(): BatchExtractor {
    const episodeExtractor = new EpisodeExtractor(mockLLM);

    return {
      name: 'episode-extractor',
      jobType: 'episode_extraction',
      async extract(conversationId: string, _sessionId: string) {
        const conv = convRepo.getConversation(conversationId);
        if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

        const result = await episodeExtractor.extract(conv);
        if (!result.ok) throw new Error(result.error ?? 'Episode extraction failed');

        // Store episodes in graph DB
        episodeRepo.saveEpisodes(result.episodes);

        // Create temporal edges between consecutive episodes
        const sortedEpisodes = [...result.episodes].sort(
          (a, b) => a.startTurnIndex - b.startTurnIndex
        );
        for (let i = 0; i < sortedEpisodes.length - 1; i++) {
          edgeRepo.createEdge({
            sourceId: sortedEpisodes[i]!.id,
            sourceType: 'episode',
            targetId: sortedEpisodes[i + 1]!.id,
            targetType: 'episode',
            edgeType: 'temporal_next',
            weight: 1.0,
          });
        }

        return {
          episodeCount: result.episodes.length,
          extractionTimeMs: result.extractionTimeMs,
        };
      },
    };
  }

  /**
   * Create a BatchExtractor that uses the ConceptExtractor with mock LLM,
   * and stores the resulting concepts + edges in the DB.
   * Also creates episode_mentions_concept edges by matching episode titles/descriptions.
   */
  function createConceptBatchExtractor(): BatchExtractor {
    const conceptExtractor = new ConceptExtractor(mockLLM);

    return {
      name: 'concept-extractor',
      jobType: 'concept_extraction',
      async extract(conversationId: string, _sessionId: string) {
        const conv = convRepo.getConversation(conversationId);
        if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

        const result = await conceptExtractor.extract({
          conversationId,
          messages: conv.messages,
        });

        // Store concepts in graph DB
        const storedConcepts = conceptRepo.saveConcepts(
          result.concepts.map((c) => ({
            name: c.name,
            description: c.content,
            aliases: c.aliases,
            category: c.category,
            relevance: (c.metadata?.relevance as number) ?? 0.5,
            sourceConversationId: conversationId,
            metadata: c.metadata,
          }))
        );

        // Store concept_related_to edges
        // Map extracted concept IDs to stored concept IDs (by name)
        const nameToStoredId = new Map<string, string>();
        for (const sc of storedConcepts) {
          nameToStoredId.set(sc.name.toLowerCase(), sc.id);
        }

        // Re-map edges from extraction to stored concept IDs
        const remappedEdges = result.edges
          .map((e) => {
            // Find stored IDs by looking up the concept names from the extraction result
            const sourceConcept = result.concepts.find((c) => c.id === e.sourceId);
            const targetConcept = result.concepts.find((c) => c.id === e.targetId);
            if (!sourceConcept || !targetConcept) return null;

            const storedSourceId = nameToStoredId.get(sourceConcept.name.toLowerCase());
            const storedTargetId = nameToStoredId.get(targetConcept.name.toLowerCase());
            if (!storedSourceId || !storedTargetId) return null;

            return {
              ...e,
              sourceId: storedSourceId,
              targetId: storedTargetId,
            };
          })
          .filter((e): e is NonNullable<typeof e> => e !== null);

        if (remappedEdges.length > 0) {
          edgeRepo.saveEdges(remappedEdges);
        }

        // Create episode_mentions_concept edges
        const episodes = episodeRepo.getEpisodesByConversation(conversationId);
        const mentionEdges = [];
        for (const ep of episodes) {
          const epText = `${ep.title} ${ep.description}`.toLowerCase();
          for (const sc of storedConcepts) {
            const names = [sc.name, ...sc.aliases].map((n) => n.toLowerCase());
            if (names.some((n) => epText.includes(n))) {
              mentionEdges.push({
                sourceId: ep.id,
                sourceType: 'episode' as const,
                targetId: sc.id,
                targetType: 'concept' as const,
                edgeType: 'episode_mentions_concept' as const,
                weight: sc.relevance,
              });
            }
          }
        }

        if (mentionEdges.length > 0) {
          edgeRepo.saveEdges(mentionEdges);
        }

        return {
          conceptCount: storedConcepts.length,
          edgeCount: remappedEdges.length + mentionEdges.length,
        };
      },
    };
  }

  // ─── E2E: Full Pipeline ─────────────────────────────────────

  it('should extract episodes and concepts via batch pipeline and store them in graph DB', async () => {
    // Setup mock LLM responses (episode first, then concept)
    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    // Register extractors
    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    // Track events
    const allEvents: MemoryEvent[] = [];
    eventBus.onAll((e) => allEvents.push(e));

    // 1. Start session
    const session = sessionManager.startSession({
      conversationId: conversation.id,
    });
    expect(session.status).toBe('active');

    // 2. Record some activity
    sessionManager.touchSession(session.id);

    // 3. End session → triggers batch pipeline
    await sessionManager.endSession(session.id);

    // 4. Wait for async batch processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    // ── Verify: Session completed ──
    const finalSession = sessionManager.getSession(session.id);
    expect(finalSession!.status).toBe('completed');

    // ── Verify: Events emitted ──
    const eventTypes = allEvents.map((e) => e.type);
    expect(eventTypes).toContain('session.ended');
    expect(eventTypes.filter((t) => t === 'batch.job.created').length).toBe(2);
    expect(eventTypes.filter((t) => t === 'batch.job.completed').length).toBe(2);

    // ── Verify: Episodes stored in graph DB ──
    const storedEpisodes = episodeRepo.getEpisodesByConversation(conversation.id);
    expect(storedEpisodes).toHaveLength(3);

    // Episodes should be ordered by start_turn_index
    expect(storedEpisodes[0]!.title).toBe('Decided to migrate to TypeScript');
    expect(storedEpisodes[0]!.type).toBe('decision');
    expect(storedEpisodes[0]!.startTurnIndex).toBe(0);
    expect(storedEpisodes[0]!.endTurnIndex).toBe(1);
    expect(storedEpisodes[0]!.actors).toEqual(['user', 'assistant']);
    expect(storedEpisodes[0]!.outcome).toBe('Migration plan initiated');

    expect(storedEpisodes[1]!.title).toBe('Configured tsconfig.json for React + Webpack');
    expect(storedEpisodes[1]!.type).toBe('action');

    expect(storedEpisodes[2]!.title).toBe('Started converting utility files');
    expect(storedEpisodes[2]!.type).toBe('action');

    // Episodes should have source message IDs from the original conversation
    for (const ep of storedEpisodes) {
      expect(ep.sourceMessageIds.length).toBeGreaterThan(0);
      for (const msgId of ep.sourceMessageIds) {
        const msg = convRepo.getMessage(msgId);
        expect(msg).not.toBeNull();
      }
    }

    // ── Verify: Concepts stored in graph DB ──
    expect(conceptRepo.countConcepts()).toBe(4);

    const ts = conceptRepo.findByName('TypeScript');
    expect(ts).not.toBeNull();
    expect(ts!.category).toBe('technology');
    expect(ts!.relevance).toBe(0.95);
    expect(ts!.aliases).toContain('TS');
    expect(ts!.sourceConversationIds).toContain(conversation.id);

    const react = conceptRepo.findByName('React');
    expect(react).not.toBeNull();
    expect(react!.aliases).toContain('React.js');
    expect(react!.aliases).toContain('ReactJS');

    const webpack = conceptRepo.findByName('Webpack');
    expect(webpack).not.toBeNull();

    const strictMode = conceptRepo.findByName('Strict Mode');
    expect(strictMode).not.toBeNull();
    expect(strictMode!.category).toBe('preference');

    // ── Verify: Temporal edges between episodes ──
    const temporalEdges = edgeRepo.getEdgesByType('temporal_next');
    expect(temporalEdges).toHaveLength(2);

    // ── Verify: concept_related_to edges ──
    const relatedEdges = edgeRepo.getEdgesByType('concept_related_to');
    expect(relatedEdges.length).toBeGreaterThanOrEqual(1);

    // ── Verify: episode_mentions_concept edges ──
    const mentionEdges = edgeRepo.getEdgesByType('episode_mentions_concept');
    expect(mentionEdges.length).toBeGreaterThan(0);

    // Episode about TypeScript migration should mention TypeScript concept
    const ep1Outgoing = edgeRepo.getOutgoingEdges(storedEpisodes[0]!.id);
    const tsMention = ep1Outgoing.find(
      (e) => e.edgeType === 'episode_mentions_concept' && e.targetId === ts!.id
    );
    expect(tsMention).toBeDefined();

    // ── Verify: Original conversation is immutable ──
    const refetched = convRepo.getConversation(conversation.id);
    expect(refetched!.messages).toHaveLength(6);
    expect(refetched!.messages[0]!.content).toBe(
      'I want to migrate our project from JavaScript to TypeScript.'
    );
  });

  it('should handle episode extraction failure without losing concept extraction', async () => {
    // Concept extractor uses the mock LLM, so queue only the concept response
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    const failingEpisodeExtractor: BatchExtractor = {
      name: 'failing-episode',
      jobType: 'episode_extraction',
      async extract() {
        throw new Error('Episode extraction failed: invalid LLM response');
      },
    };

    batchPipeline.registerExtractor(failingEpisodeExtractor);
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    const failedEvents: BatchJobFailedEvent[] = [];
    const completedEvents: BatchJobCompletedEvent[] = [];
    eventBus.on<BatchJobFailedEvent>('batch.job.failed', (e) => failedEvents.push(e));
    eventBus.on<BatchJobCompletedEvent>('batch.job.completed', (e) => completedEvents.push(e));

    const session = sessionManager.startSession({ conversationId: conversation.id });
    await sessionManager.endSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Episode extraction failed
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]!.jobType).toBe('episode_extraction');

    // Concept extraction succeeded
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]!.jobType).toBe('concept_extraction');

    // No episodes stored
    expect(episodeRepo.countEpisodes(conversation.id)).toBe(0);

    // But concepts ARE stored
    expect(conceptRepo.countConcepts()).toBe(4);
    expect(conceptRepo.findByName('TypeScript')).not.toBeNull();
  });

  it('should store episodes with correct source message ID references', async () => {
    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    const session = sessionManager.startSession({ conversationId: conversation.id });
    await sessionManager.endSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const episodes = episodeRepo.getEpisodesByConversation(conversation.id);

    // First episode (turns 0-1) should reference message IDs at those turn indices
    const ep0 = episodes[0]!;
    expect(ep0.sourceMessageIds).toHaveLength(2);

    // Verify the actual messages match the turn range
    for (const msgId of ep0.sourceMessageIds) {
      const msg = convRepo.getMessage(msgId);
      expect(msg).not.toBeNull();
      expect(msg!.turnIndex).toBeGreaterThanOrEqual(ep0.startTurnIndex);
      expect(msg!.turnIndex).toBeLessThanOrEqual(ep0.endTurnIndex);
    }
  });

  it('should support graph traversal from episode to related concepts after extraction', async () => {
    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    const session = sessionManager.startSession({ conversationId: conversation.id });
    await sessionManager.endSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const episodes = episodeRepo.getEpisodesByConversation(conversation.id);
    const ts = conceptRepo.findByName('TypeScript')!;
    const react = conceptRepo.findByName('React')!;

    // Traverse: Episode[0] → outgoing edges → concept targets
    const ep0Edges = edgeRepo.getOutgoingEdges(episodes[0]!.id);
    const ep0ConceptTargets = ep0Edges
      .filter((e) => e.edgeType === 'episode_mentions_concept')
      .map((e) => e.targetId);
    expect(ep0ConceptTargets).toContain(ts.id);

    // Traverse: Episode[1] (React + Webpack config) → should mention React
    const ep1Edges = edgeRepo.getOutgoingEdges(episodes[1]!.id);
    const ep1ConceptTargets = ep1Edges
      .filter((e) => e.edgeType === 'episode_mentions_concept')
      .map((e) => e.targetId);
    expect(ep1ConceptTargets).toContain(react.id);

    // Traverse: TypeScript concept → incoming edges → who mentions it?
    const tsIncoming = edgeRepo.getIncomingEdges(ts.id);
    const tsMentioners = tsIncoming
      .filter((e) => e.edgeType === 'episode_mentions_concept')
      .map((e) => e.sourceId);
    // At least the first episode should mention TypeScript
    expect(tsMentioners).toContain(episodes[0]!.id);
  });

  it('should track batch job results in session repository', async () => {
    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    const session = sessionManager.startSession({ conversationId: conversation.id });
    await sessionManager.endSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const jobs = batchPipeline.getSessionJobs(session.id);
    expect(jobs).toHaveLength(2);

    const episodeJob = jobs.find((j) => j.jobType === 'episode_extraction');
    expect(episodeJob).toBeDefined();
    expect(episodeJob!.status).toBe('completed');
    expect(episodeJob!.completedAt).toBeTruthy();

    const result = episodeJob!.result as Record<string, unknown>;
    expect(result.episodeCount).toBe(3);

    const conceptJob = jobs.find((j) => j.jobType === 'concept_extraction');
    expect(conceptJob).toBeDefined();
    expect(conceptJob!.status).toBe('completed');

    const conceptResult = conceptJob!.result as Record<string, unknown>;
    expect(conceptResult.conceptCount).toBe(4);
  });

  it('should handle timeout-triggered batch extraction end-to-end', async () => {
    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    // Start session with short timeout
    const session = sessionManager.startSession({
      conversationId: conversation.id,
      timeoutMs: 500,
    });

    // Sweep in the future to trigger timeout
    const future = new Date(Date.now() + 1000);
    const ended = await sessionManager.sweepTimedOutSessions(future);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.endReason).toBe('timeout');

    // Wait for batch processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify extraction happened
    expect(episodeRepo.countEpisodes(conversation.id)).toBe(3);
    expect(conceptRepo.countConcepts()).toBe(4);

    const finalSession = sessionManager.getSession(session.id);
    expect(finalSession!.status).toBe('completed');
  });

  it('should handle extraction from multiple independent sessions', async () => {
    // Create a second conversation
    const conversation2 = ingestService.ingestConversation({
      source: 'codex',
      title: 'Python Data Pipeline',
      messages: [
        { role: 'user', content: 'Help me build a data pipeline in Python.' },
        { role: 'assistant', content: 'Sure! We can use pandas and Apache Airflow for the pipeline.' },
        { role: 'user', content: 'Let\'s use pandas for the data transformation step.' },
        { role: 'assistant', content: 'Good choice. pandas provides excellent data manipulation APIs.' },
      ],
    });

    const mockEpisodeResponse2 = JSON.stringify([
      {
        type: 'action',
        title: 'Built Python data pipeline',
        description: 'Created a data pipeline using Python, pandas, and Apache Airflow.',
        startTurnIndex: 0,
        endTurnIndex: 3,
        actors: ['user', 'assistant'],
        outcome: 'Pipeline architecture defined',
      },
    ]);

    const mockConceptResponse2 = JSON.stringify({
      concepts: [
        {
          name: 'Python',
          description: 'Programming language used for data pipeline',
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: ['pandas'],
        },
        {
          name: 'pandas',
          description: 'Data manipulation library for Python',
          category: 'technology',
          relevance: 0.85,
          relatedConcepts: ['Python'],
        },
      ],
    });

    // Queue LLM responses for both sessions (episode1, concept1, episode2, concept2)
    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);
    mockLLM.addResponse(mockEpisodeResponse2);
    mockLLM.addResponse(mockConceptResponse2);

    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    // End first session
    const session1 = sessionManager.startSession({ conversationId: conversation.id });
    await sessionManager.endSession(session1.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // End second session
    const session2 = sessionManager.startSession({ conversationId: conversation2.id });
    await sessionManager.endSession(session2.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify conversation 1 episodes
    const eps1 = episodeRepo.getEpisodesByConversation(conversation.id);
    expect(eps1).toHaveLength(3);
    expect(eps1[0]!.title).toContain('TypeScript');

    // Verify conversation 2 episodes
    const eps2 = episodeRepo.getEpisodesByConversation(conversation2.id);
    expect(eps2).toHaveLength(1);
    expect(eps2[0]!.title).toContain('Python');

    // Verify concepts from both conversations exist
    // Conv1 concepts: TypeScript, React, Webpack, Strict Mode
    // Conv2 concepts: Python, pandas
    expect(conceptRepo.countConcepts()).toBe(6);
    expect(conceptRepo.findByName('TypeScript')).not.toBeNull();
    expect(conceptRepo.findByName('Python')).not.toBeNull();
    expect(conceptRepo.findByName('pandas')).not.toBeNull();

    // Both sessions completed
    expect(sessionManager.getSession(session1.id)!.status).toBe('completed');
    expect(sessionManager.getSession(session2.id)!.status).toBe('completed');
  });

  it('should preserve conversation immutability throughout the full pipeline', async () => {
    // Capture original state
    const originalMessages = conversation.messages.map((m) => ({
      id: m.id,
      content: m.content,
      role: m.role,
      turnIndex: m.turnIndex,
    }));

    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    const session = sessionManager.startSession({ conversationId: conversation.id });
    await sessionManager.endSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Re-fetch the conversation and verify it's unchanged
    const refetched = convRepo.getConversation(conversation.id);
    expect(refetched).not.toBeNull();
    expect(refetched!.messages).toHaveLength(originalMessages.length);

    for (let i = 0; i < originalMessages.length; i++) {
      expect(refetched!.messages[i]!.id).toBe(originalMessages[i]!.id);
      expect(refetched!.messages[i]!.content).toBe(originalMessages[i]!.content);
      expect(refetched!.messages[i]!.role).toBe(originalMessages[i]!.role);
      expect(refetched!.messages[i]!.turnIndex).toBe(originalMessages[i]!.turnIndex);
    }
  });

  it('should produce a connected graph that can be traversed end-to-end', async () => {
    mockLLM.addResponse(MOCK_EPISODE_RESPONSE);
    mockLLM.addResponse(MOCK_CONCEPT_RESPONSE);

    batchPipeline.registerExtractor(createEpisodeBatchExtractor());
    batchPipeline.registerExtractor(createConceptBatchExtractor());

    const session = sessionManager.startSession({ conversationId: conversation.id });
    await sessionManager.endSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Total edge count: temporal + concept_related_to + episode_mentions_concept
    const totalEdges = edgeRepo.countEdges();
    expect(totalEdges).toBeGreaterThan(0);

    // Multi-hop traversal: Episode[0] → TypeScript concept → related concepts
    const episodes = episodeRepo.getEpisodesByConversation(conversation.id);
    const ts = conceptRepo.findByName('TypeScript')!;

    // Hop 1: Episode → Concept (via episode_mentions_concept)
    const ep0Outgoing = edgeRepo.getOutgoingEdges(episodes[0]!.id);
    const tsEdge = ep0Outgoing.find(
      (e) => e.targetId === ts.id && e.edgeType === 'episode_mentions_concept'
    );
    expect(tsEdge).toBeDefined();

    // Hop 2: TypeScript concept → related concepts (via concept_related_to)
    const tsOutgoing = edgeRepo.getOutgoingEdges(ts.id);
    const relatedConceptIds = tsOutgoing
      .filter((e) => e.edgeType === 'concept_related_to')
      .map((e) => e.targetId);

    // TypeScript should be related to at least one other concept
    expect(relatedConceptIds.length).toBeGreaterThanOrEqual(1);

    // Verify the related concepts exist in the DB
    for (const conceptId of relatedConceptIds) {
      const concept = conceptRepo.getConcept(conceptId);
      expect(concept).not.toBeNull();
    }

    // Hop 3: Follow temporal edges between episodes
    const ep0Temporal = ep0Outgoing.find((e) => e.edgeType === 'temporal_next');
    expect(ep0Temporal).toBeDefined();
    expect(ep0Temporal!.targetId).toBe(episodes[1]!.id);
  });
});
