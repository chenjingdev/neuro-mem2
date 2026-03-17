/**
 * Integration tests for storing extracted Episode/Concept nodes
 * in the graph DB and verifying batch extraction results.
 *
 * Sub-AC 3.4: Episode/Concept 노드를 그래프 DB에 저장하고
 * 배치 결과를 검증하는 통합 테스트
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { EpisodeRepository } from '../src/db/episode-repo.js';
import { ConceptRepository } from '../src/db/concept-repo.js';
import { EdgeRepository } from '../src/db/edge-repo.js';
import { IngestService } from '../src/services/ingest.js';
import type { Episode } from '../src/models/episode.js';
import type { Concept } from '../src/models/concept.js';
import type { CreateEdgeInput } from '../src/models/memory-edge.js';
import { v4 as uuidv4 } from 'uuid';

describe('Graph Storage: Episode & Concept Nodes', () => {
  let db: Database.Database;
  let convRepo: ConversationRepository;
  let episodeRepo: EpisodeRepository;
  let conceptRepo: ConceptRepository;
  let edgeRepo: EdgeRepository;
  let ingestService: IngestService;

  // Helper: create a test conversation and return its ID + message IDs
  function createTestConversation() {
    const conv = ingestService.ingestConversation({
      source: 'claude-code',
      title: 'TypeScript Migration Discussion',
      messages: [
        { role: 'user', content: 'I want to migrate our project from JavaScript to TypeScript.' },
        { role: 'assistant', content: 'Great choice! Let me help you plan the migration. First, we should set up tsconfig.json.' },
        { role: 'user', content: 'We use React with Webpack. What settings do you recommend?' },
        { role: 'assistant', content: 'For a React + Webpack project, I recommend strict mode with JSX support. Here is a sample config...' },
        { role: 'user', content: 'We decided to use strict mode. Let\'s start with the util files.' },
        { role: 'assistant', content: 'Good plan. I\'ll convert the utility files first since they have fewer dependencies.' },
      ],
    });
    return conv;
  }

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    convRepo = new ConversationRepository(db);
    episodeRepo = new EpisodeRepository(db);
    conceptRepo = new ConceptRepository(db);
    edgeRepo = new EdgeRepository(db);
    ingestService = new IngestService(convRepo);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Episode Storage Tests ───────────────────────────────────────

  describe('Episode node storage', () => {
    it('should save a batch of episodes for a conversation', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const episodes: Episode[] = [
        {
          id: uuidv4(),
          conversationId: conv.id,
          type: 'decision',
          title: 'Decided to migrate to TypeScript',
          description: 'The user decided to migrate the JavaScript project to TypeScript with strict mode.',
          startTurnIndex: 0,
          endTurnIndex: 1,
          sourceMessageIds: [conv.messages[0]!.id, conv.messages[1]!.id],
          actors: ['user', 'assistant'],
          outcome: 'Migration plan initiated',
          createdAt: now,
        },
        {
          id: uuidv4(),
          conversationId: conv.id,
          type: 'action',
          title: 'Configured TypeScript with React support',
          description: 'Set up tsconfig.json with strict mode and JSX support for React + Webpack project.',
          startTurnIndex: 2,
          endTurnIndex: 3,
          sourceMessageIds: [conv.messages[2]!.id, conv.messages[3]!.id],
          actors: ['assistant'],
          createdAt: now,
        },
        {
          id: uuidv4(),
          conversationId: conv.id,
          type: 'action',
          title: 'Started converting utility files',
          description: 'Began TypeScript migration with utility files as the first target.',
          startTurnIndex: 4,
          endTurnIndex: 5,
          sourceMessageIds: [conv.messages[4]!.id, conv.messages[5]!.id],
          actors: ['user', 'assistant'],
          outcome: 'Utility files queued for conversion',
          createdAt: now,
        },
      ];

      episodeRepo.saveEpisodes(episodes);

      // Verify all episodes are stored
      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored).toHaveLength(3);
    });

    it('should preserve episode fields accurately after storage', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();
      const episodeId = uuidv4();

      const episode: Episode = {
        id: episodeId,
        conversationId: conv.id,
        type: 'decision',
        title: 'Chose strict TypeScript mode',
        description: 'The team decided to enable strict mode in TypeScript configuration.',
        startTurnIndex: 4,
        endTurnIndex: 5,
        sourceMessageIds: [conv.messages[4]!.id, conv.messages[5]!.id],
        actors: ['user', 'assistant'],
        outcome: 'strict mode enabled',
        createdAt: now,
        metadata: { extractionModel: 'claude-3', confidence: 0.92 },
      };

      episodeRepo.saveEpisodes([episode]);

      const fetched = episodeRepo.getEpisode(episodeId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(episodeId);
      expect(fetched!.conversationId).toBe(conv.id);
      expect(fetched!.type).toBe('decision');
      expect(fetched!.title).toBe('Chose strict TypeScript mode');
      expect(fetched!.description).toBe('The team decided to enable strict mode in TypeScript configuration.');
      expect(fetched!.startTurnIndex).toBe(4);
      expect(fetched!.endTurnIndex).toBe(5);
      expect(fetched!.sourceMessageIds).toEqual([conv.messages[4]!.id, conv.messages[5]!.id]);
      expect(fetched!.actors).toEqual(['user', 'assistant']);
      expect(fetched!.outcome).toBe('strict mode enabled');
      expect(fetched!.metadata).toEqual({ extractionModel: 'claude-3', confidence: 0.92 });
    });

    it('should order episodes by start turn index', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      // Insert episodes out of order
      const episodes: Episode[] = [
        {
          id: uuidv4(),
          conversationId: conv.id,
          type: 'action',
          title: 'Third episode',
          description: 'Third',
          startTurnIndex: 4,
          endTurnIndex: 5,
          sourceMessageIds: [],
          actors: ['user'],
          createdAt: now,
        },
        {
          id: uuidv4(),
          conversationId: conv.id,
          type: 'decision',
          title: 'First episode',
          description: 'First',
          startTurnIndex: 0,
          endTurnIndex: 1,
          sourceMessageIds: [],
          actors: ['user'],
          createdAt: now,
        },
        {
          id: uuidv4(),
          conversationId: conv.id,
          type: 'event',
          title: 'Second episode',
          description: 'Second',
          startTurnIndex: 2,
          endTurnIndex: 3,
          sourceMessageIds: [],
          actors: ['assistant'],
          createdAt: now,
        },
      ];

      episodeRepo.saveEpisodes(episodes);

      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored[0]!.title).toBe('First episode');
      expect(stored[1]!.title).toBe('Second episode');
      expect(stored[2]!.title).toBe('Third episode');
    });

    it('should filter episodes by type', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      episodeRepo.saveEpisodes([
        {
          id: uuidv4(), conversationId: conv.id, type: 'decision',
          title: 'Decision 1', description: 'desc', startTurnIndex: 0, endTurnIndex: 1,
          sourceMessageIds: [], actors: ['user'], createdAt: now,
        },
        {
          id: uuidv4(), conversationId: conv.id, type: 'action',
          title: 'Action 1', description: 'desc', startTurnIndex: 2, endTurnIndex: 3,
          sourceMessageIds: [], actors: ['user'], createdAt: now,
        },
        {
          id: uuidv4(), conversationId: conv.id, type: 'decision',
          title: 'Decision 2', description: 'desc', startTurnIndex: 4, endTurnIndex: 5,
          sourceMessageIds: [], actors: ['user'], createdAt: now,
        },
      ]);

      const decisions = episodeRepo.getEpisodesByType('decision');
      expect(decisions).toHaveLength(2);
      expect(decisions.every(d => d.type === 'decision')).toBe(true);
    });

    it('should count episodes correctly', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      expect(episodeRepo.countEpisodes(conv.id)).toBe(0);

      episodeRepo.saveEpisodes([
        {
          id: uuidv4(), conversationId: conv.id, type: 'action',
          title: 'Ep 1', description: 'd', startTurnIndex: 0, endTurnIndex: 1,
          sourceMessageIds: [], actors: ['user'], createdAt: now,
        },
        {
          id: uuidv4(), conversationId: conv.id, type: 'event',
          title: 'Ep 2', description: 'd', startTurnIndex: 2, endTurnIndex: 3,
          sourceMessageIds: [], actors: ['user'], createdAt: now,
        },
      ]);

      expect(episodeRepo.countEpisodes(conv.id)).toBe(2);
    });

    it('should support re-extraction by deleting and re-saving episodes', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      // First extraction
      episodeRepo.saveEpisodes([{
        id: uuidv4(), conversationId: conv.id, type: 'action',
        title: 'Old episode', description: 'old', startTurnIndex: 0, endTurnIndex: 1,
        sourceMessageIds: [], actors: ['user'], createdAt: now,
      }]);

      expect(episodeRepo.countEpisodes(conv.id)).toBe(1);

      // Re-extract: delete old, save new
      const deleted = episodeRepo.deleteEpisodesByConversation(conv.id);
      expect(deleted).toBe(1);

      episodeRepo.saveEpisodes([
        {
          id: uuidv4(), conversationId: conv.id, type: 'decision',
          title: 'New episode 1', description: 'new1', startTurnIndex: 0, endTurnIndex: 2,
          sourceMessageIds: [], actors: ['user', 'assistant'], createdAt: now,
        },
        {
          id: uuidv4(), conversationId: conv.id, type: 'discovery',
          title: 'New episode 2', description: 'new2', startTurnIndex: 3, endTurnIndex: 5,
          sourceMessageIds: [], actors: ['user'], createdAt: now,
        },
      ]);

      expect(episodeRepo.countEpisodes(conv.id)).toBe(2);
      const stored = episodeRepo.getEpisodesByConversation(conv.id);
      expect(stored[0]!.title).toBe('New episode 1');
    });

    it('should return null for non-existent episode', () => {
      expect(episodeRepo.getEpisode('non-existent-id')).toBeNull();
    });
  });

  // ─── Concept Storage Tests ───────────────────────────────────────

  describe('Concept node storage', () => {
    it('should create and retrieve a concept', () => {
      const conv = createTestConversation();

      const concept = conceptRepo.createConcept({
        name: 'TypeScript',
        description: 'Statically typed superset of JavaScript used as the primary language',
        aliases: ['TS'],
        category: 'technology',
        relevance: 0.95,
        sourceConversationId: conv.id,
      });

      expect(concept.id).toBeDefined();
      expect(concept.name).toBe('TypeScript');
      expect(concept.aliases).toEqual(['TS']);
      expect(concept.category).toBe('technology');
      expect(concept.relevance).toBe(0.95);
      expect(concept.sourceConversationIds).toEqual([conv.id]);

      // Verify retrieval
      const fetched = conceptRepo.getConcept(concept.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('TypeScript');
      expect(fetched!.description).toBe('Statically typed superset of JavaScript used as the primary language');
    });

    it('should save a batch of concepts transactionally', () => {
      const conv = createTestConversation();

      const concepts = conceptRepo.saveConcepts([
        {
          name: 'TypeScript',
          description: 'Typed JavaScript superset',
          aliases: ['TS'],
          category: 'technology',
          relevance: 0.95,
          sourceConversationId: conv.id,
        },
        {
          name: 'React',
          description: 'UI component library',
          aliases: ['React.js', 'ReactJS'],
          category: 'technology',
          relevance: 0.85,
          sourceConversationId: conv.id,
        },
        {
          name: 'Webpack',
          description: 'Module bundler for JavaScript applications',
          category: 'technology',
          relevance: 0.7,
          sourceConversationId: conv.id,
        },
        {
          name: 'Strict Mode',
          description: 'TypeScript strict type-checking configuration',
          category: 'preference',
          relevance: 0.8,
          sourceConversationId: conv.id,
        },
      ]);

      expect(concepts).toHaveLength(4);
      expect(conceptRepo.countConcepts()).toBe(4);
    });

    it('should find concepts by name (case-insensitive)', () => {
      const conv = createTestConversation();

      conceptRepo.createConcept({
        name: 'TypeScript',
        description: 'Typed JS',
        category: 'technology',
        relevance: 0.9,
        sourceConversationId: conv.id,
      });

      expect(conceptRepo.findByName('typescript')).not.toBeNull();
      expect(conceptRepo.findByName('TYPESCRIPT')).not.toBeNull();
      expect(conceptRepo.findByName('TypeScript')).not.toBeNull();
      expect(conceptRepo.findByName('NotExist')).toBeNull();
    });

    it('should enforce unique concept names (case-insensitive)', () => {
      const conv = createTestConversation();

      conceptRepo.createConcept({
        name: 'TypeScript',
        description: 'desc1',
        category: 'technology',
        relevance: 0.9,
        sourceConversationId: conv.id,
      });

      // Attempting to create a concept with same name (different case) should fail
      expect(() => conceptRepo.createConcept({
        name: 'typescript',
        description: 'desc2',
        category: 'technology',
        relevance: 0.8,
        sourceConversationId: conv.id,
      })).toThrow();
    });

    it('should filter concepts by category', () => {
      const conv = createTestConversation();

      conceptRepo.saveConcepts([
        { name: 'TypeScript', description: 'd', category: 'technology', relevance: 0.9, sourceConversationId: conv.id },
        { name: 'React', description: 'd', category: 'technology', relevance: 0.8, sourceConversationId: conv.id },
        { name: 'TDD', description: 'd', category: 'methodology', relevance: 0.6, sourceConversationId: conv.id },
      ]);

      const techConcepts = conceptRepo.getConceptsByCategory('technology');
      expect(techConcepts).toHaveLength(2);
      expect(techConcepts.every(c => c.category === 'technology')).toBe(true);

      // Ordered by relevance desc
      expect(techConcepts[0]!.name).toBe('TypeScript');
      expect(techConcepts[1]!.name).toBe('React');
    });

    it('should update a concept with new source conversation', () => {
      const conv1 = createTestConversation();
      const conv2 = ingestService.ingestConversation({
        source: 'codex',
        messages: [{ role: 'user', content: 'Also using TypeScript here' }],
      });

      const concept = conceptRepo.createConcept({
        name: 'TypeScript',
        description: 'Typed JS superset',
        category: 'technology',
        relevance: 0.9,
        sourceConversationId: conv1.id,
      });

      const updated = conceptRepo.updateConcept(concept.id, {
        addSourceConversationId: conv2.id,
        relevance: 0.95,
        addAliases: ['TS', 'ts'],
      });

      expect(updated).not.toBeNull();
      expect(updated!.sourceConversationIds).toContain(conv1.id);
      expect(updated!.sourceConversationIds).toContain(conv2.id);
      expect(updated!.relevance).toBe(0.95);
      expect(updated!.aliases).toContain('TS');
      expect(updated!.aliases).toContain('ts');
    });

    it('should preserve metadata through storage cycle', () => {
      const conv = createTestConversation();

      const concept = conceptRepo.createConcept({
        name: 'TypeScript',
        description: 'desc',
        category: 'technology',
        relevance: 0.9,
        sourceConversationId: conv.id,
        metadata: {
          extractionModel: 'claude-3',
          relatedConcepts: ['JavaScript', 'Node.js'],
          firstMentionTurn: 0,
        },
      });

      const fetched = conceptRepo.getConcept(concept.id);
      expect(fetched!.metadata).toEqual({
        extractionModel: 'claude-3',
        relatedConcepts: ['JavaScript', 'Node.js'],
        firstMentionTurn: 0,
      });
    });

    it('should list concepts with pagination', () => {
      const conv = createTestConversation();

      for (let i = 0; i < 5; i++) {
        conceptRepo.createConcept({
          name: `Concept${i}`,
          description: `Description ${i}`,
          category: 'technology',
          relevance: 0.5 + i * 0.1,
          sourceConversationId: conv.id,
        });
      }

      const page1 = conceptRepo.listConcepts({ limit: 2, offset: 0 });
      const page2 = conceptRepo.listConcepts({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // Should be ordered by relevance DESC
      expect(page1[0]!.relevance).toBeGreaterThanOrEqual(page1[1]!.relevance);
    });
  });

  // ─── Memory Edge Storage Tests ──────────────────────────────────

  describe('Memory edge storage', () => {
    it('should create edges between episodes and concepts', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      // Create an episode
      const episodeId = uuidv4();
      episodeRepo.saveEpisodes([{
        id: episodeId, conversationId: conv.id, type: 'decision',
        title: 'Chose TypeScript', description: 'desc',
        startTurnIndex: 0, endTurnIndex: 1,
        sourceMessageIds: [], actors: ['user'], createdAt: now,
      }]);

      // Create a concept
      const concept = conceptRepo.createConcept({
        name: 'TypeScript', description: 'desc', category: 'technology',
        relevance: 0.9, sourceConversationId: conv.id,
      });

      // Create edge: episode mentions concept
      const edge = edgeRepo.createEdge({
        sourceId: episodeId,
        sourceType: 'episode',
        targetId: concept.id,
        targetType: 'concept',
        edgeType: 'episode_mentions_concept',
        weight: 0.8,
      });

      expect(edge.id).toBeDefined();
      expect(edge.sourceId).toBe(episodeId);
      expect(edge.targetId).toBe(concept.id);
      expect(edge.edgeType).toBe('episode_mentions_concept');
      expect(edge.weight).toBe(0.8);
    });

    it('should save a batch of edges transactionally', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const ep1Id = uuidv4();
      const ep2Id = uuidv4();
      episodeRepo.saveEpisodes([
        { id: ep1Id, conversationId: conv.id, type: 'decision', title: 'Ep1', description: 'd',
          startTurnIndex: 0, endTurnIndex: 1, sourceMessageIds: [], actors: ['user'], createdAt: now },
        { id: ep2Id, conversationId: conv.id, type: 'action', title: 'Ep2', description: 'd',
          startTurnIndex: 2, endTurnIndex: 3, sourceMessageIds: [], actors: ['user'], createdAt: now },
      ]);

      const concepts = conceptRepo.saveConcepts([
        { name: 'TypeScript', description: 'd', category: 'technology', relevance: 0.9, sourceConversationId: conv.id },
        { name: 'React', description: 'd', category: 'technology', relevance: 0.8, sourceConversationId: conv.id },
      ]);

      const edgeInputs: CreateEdgeInput[] = [
        { sourceId: ep1Id, sourceType: 'episode', targetId: concepts[0]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.9 },
        { sourceId: ep1Id, sourceType: 'episode', targetId: concepts[1]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.7 },
        { sourceId: ep2Id, sourceType: 'episode', targetId: concepts[0]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.85 },
        { sourceId: concepts[0]!.id, sourceType: 'concept', targetId: concepts[1]!.id, targetType: 'concept', edgeType: 'concept_related_to', weight: 0.75 },
        { sourceId: ep1Id, sourceType: 'episode', targetId: ep2Id, targetType: 'episode', edgeType: 'temporal_next', weight: 1.0 },
      ];

      const edges = edgeRepo.saveEdges(edgeInputs);
      expect(edges).toHaveLength(5);
      expect(edgeRepo.countEdges()).toBe(5);
    });

    it('should retrieve outgoing edges from a node', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const epId = uuidv4();
      episodeRepo.saveEpisodes([{
        id: epId, conversationId: conv.id, type: 'action', title: 'Ep', description: 'd',
        startTurnIndex: 0, endTurnIndex: 1, sourceMessageIds: [], actors: ['user'], createdAt: now,
      }]);

      const c1 = conceptRepo.createConcept({ name: 'TS', description: 'd', category: 'technology', relevance: 0.9, sourceConversationId: conv.id });
      const c2 = conceptRepo.createConcept({ name: 'React', description: 'd', category: 'technology', relevance: 0.8, sourceConversationId: conv.id });

      edgeRepo.saveEdges([
        { sourceId: epId, sourceType: 'episode', targetId: c1.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.9 },
        { sourceId: epId, sourceType: 'episode', targetId: c2.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.7 },
      ]);

      const outgoing = edgeRepo.getOutgoingEdges(epId);
      expect(outgoing).toHaveLength(2);
      // Ordered by weight DESC
      expect(outgoing[0]!.weight).toBeGreaterThanOrEqual(outgoing[1]!.weight);
    });

    it('should retrieve incoming edges to a node', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const concept = conceptRepo.createConcept({
        name: 'TypeScript', description: 'd', category: 'technology',
        relevance: 0.9, sourceConversationId: conv.id,
      });

      const ep1Id = uuidv4();
      const ep2Id = uuidv4();
      episodeRepo.saveEpisodes([
        { id: ep1Id, conversationId: conv.id, type: 'action', title: 'Ep1', description: 'd',
          startTurnIndex: 0, endTurnIndex: 1, sourceMessageIds: [], actors: ['user'], createdAt: now },
        { id: ep2Id, conversationId: conv.id, type: 'decision', title: 'Ep2', description: 'd',
          startTurnIndex: 2, endTurnIndex: 3, sourceMessageIds: [], actors: ['user'], createdAt: now },
      ]);

      edgeRepo.saveEdges([
        { sourceId: ep1Id, sourceType: 'episode', targetId: concept.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.8 },
        { sourceId: ep2Id, sourceType: 'episode', targetId: concept.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.6 },
      ]);

      const incoming = edgeRepo.getIncomingEdges(concept.id);
      expect(incoming).toHaveLength(2);
    });

    it('should enforce unique edge constraint (source, target, type)', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const epId = uuidv4();
      episodeRepo.saveEpisodes([{
        id: epId, conversationId: conv.id, type: 'action', title: 'Ep', description: 'd',
        startTurnIndex: 0, endTurnIndex: 1, sourceMessageIds: [], actors: ['user'], createdAt: now,
      }]);

      const concept = conceptRepo.createConcept({
        name: 'TypeScript', description: 'd', category: 'technology',
        relevance: 0.9, sourceConversationId: conv.id,
      });

      edgeRepo.createEdge({
        sourceId: epId, sourceType: 'episode',
        targetId: concept.id, targetType: 'concept',
        edgeType: 'episode_mentions_concept', weight: 0.8,
      });

      // Duplicate edge should fail
      expect(() => edgeRepo.createEdge({
        sourceId: epId, sourceType: 'episode',
        targetId: concept.id, targetType: 'concept',
        edgeType: 'episode_mentions_concept', weight: 0.5,
      })).toThrow();
    });

    it('should update edge weight (Hebbian reinforcement)', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const epId = uuidv4();
      episodeRepo.saveEpisodes([{
        id: epId, conversationId: conv.id, type: 'action', title: 'Ep', description: 'd',
        startTurnIndex: 0, endTurnIndex: 1, sourceMessageIds: [], actors: ['user'], createdAt: now,
      }]);

      const concept = conceptRepo.createConcept({
        name: 'TypeScript', description: 'd', category: 'technology',
        relevance: 0.9, sourceConversationId: conv.id,
      });

      const edge = edgeRepo.createEdge({
        sourceId: epId, sourceType: 'episode',
        targetId: concept.id, targetType: 'concept',
        edgeType: 'episode_mentions_concept', weight: 0.5,
      });

      // Reinforce the edge
      const reinforced = edgeRepo.reinforceEdge(edge.id, 0.2);
      expect(reinforced).not.toBeNull();
      // new_weight = 0.5 + 0.2 * (1 - 0.5) = 0.5 + 0.1 = 0.6
      expect(reinforced!.weight).toBeCloseTo(0.6, 5);

      // Verify persistence
      const fetched = edgeRepo.getEdge(edge.id);
      expect(fetched!.weight).toBeCloseTo(0.6, 5);
    });

    it('should clamp edge weights to [0, 1]', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const epId = uuidv4();
      episodeRepo.saveEpisodes([{
        id: epId, conversationId: conv.id, type: 'action', title: 'Ep', description: 'd',
        startTurnIndex: 0, endTurnIndex: 1, sourceMessageIds: [], actors: ['user'], createdAt: now,
      }]);

      const concept = conceptRepo.createConcept({
        name: 'TypeScript', description: 'd', category: 'technology',
        relevance: 0.9, sourceConversationId: conv.id,
      });

      const edge = edgeRepo.createEdge({
        sourceId: epId, sourceType: 'episode',
        targetId: concept.id, targetType: 'concept',
        edgeType: 'episode_mentions_concept', weight: 0.9,
      });

      // Try to set weight > 1
      edgeRepo.updateWeight(edge.id, 1.5);
      let fetched = edgeRepo.getEdge(edge.id);
      expect(fetched!.weight).toBe(1.0);

      // Try to set weight < 0
      edgeRepo.updateWeight(edge.id, -0.5);
      fetched = edgeRepo.getEdge(edge.id);
      expect(fetched!.weight).toBe(0.0);
    });

    it('should get edges by type', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const ep1Id = uuidv4();
      const ep2Id = uuidv4();
      episodeRepo.saveEpisodes([
        { id: ep1Id, conversationId: conv.id, type: 'action', title: 'Ep1', description: 'd',
          startTurnIndex: 0, endTurnIndex: 1, sourceMessageIds: [], actors: ['user'], createdAt: now },
        { id: ep2Id, conversationId: conv.id, type: 'action', title: 'Ep2', description: 'd',
          startTurnIndex: 2, endTurnIndex: 3, sourceMessageIds: [], actors: ['user'], createdAt: now },
      ]);

      const c1 = conceptRepo.createConcept({ name: 'TS', description: 'd', category: 'technology', relevance: 0.9, sourceConversationId: conv.id });
      const c2 = conceptRepo.createConcept({ name: 'React', description: 'd', category: 'technology', relevance: 0.8, sourceConversationId: conv.id });

      edgeRepo.saveEdges([
        { sourceId: ep1Id, sourceType: 'episode', targetId: c1.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.9 },
        { sourceId: c1.id, sourceType: 'concept', targetId: c2.id, targetType: 'concept', edgeType: 'concept_related_to', weight: 0.7 },
        { sourceId: ep1Id, sourceType: 'episode', targetId: ep2Id, targetType: 'episode', edgeType: 'temporal_next', weight: 1.0 },
      ]);

      const mentionEdges = edgeRepo.getEdgesByType('episode_mentions_concept');
      expect(mentionEdges).toHaveLength(1);

      const relatedEdges = edgeRepo.getEdgesByType('concept_related_to');
      expect(relatedEdges).toHaveLength(1);

      const temporalEdges = edgeRepo.getEdgesByType('temporal_next');
      expect(temporalEdges).toHaveLength(1);
    });
  });

  // ─── Batch Extraction Integration Tests ────────────────────────

  describe('Batch extraction result verification', () => {
    it('should store a complete batch extraction result (episodes + concepts + edges)', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      // Simulate batch extraction output
      const ep1Id = uuidv4();
      const ep2Id = uuidv4();
      const episodes: Episode[] = [
        {
          id: ep1Id, conversationId: conv.id, type: 'decision',
          title: 'Decided to migrate to TypeScript',
          description: 'User initiated migration from JS to TS.',
          startTurnIndex: 0, endTurnIndex: 1,
          sourceMessageIds: [conv.messages[0]!.id, conv.messages[1]!.id],
          actors: ['user', 'assistant'], createdAt: now,
        },
        {
          id: ep2Id, conversationId: conv.id, type: 'action',
          title: 'Configured TypeScript with React',
          description: 'Set up tsconfig.json with React + Webpack settings.',
          startTurnIndex: 2, endTurnIndex: 5,
          sourceMessageIds: conv.messages.slice(2).map(m => m.id),
          actors: ['assistant', 'user'], outcome: 'Config ready',
          createdAt: now,
        },
      ];

      // Store episodes
      episodeRepo.saveEpisodes(episodes);

      // Store concepts
      const concepts = conceptRepo.saveConcepts([
        { name: 'TypeScript', description: 'Typed JS superset', aliases: ['TS'], category: 'technology', relevance: 0.95, sourceConversationId: conv.id },
        { name: 'React', description: 'UI library', aliases: ['React.js'], category: 'technology', relevance: 0.85, sourceConversationId: conv.id },
        { name: 'Webpack', description: 'Module bundler', category: 'technology', relevance: 0.7, sourceConversationId: conv.id },
        { name: 'Strict Mode', description: 'TS strict type checking', category: 'preference', relevance: 0.8, sourceConversationId: conv.id },
      ]);

      // Store edges
      const edgeInputs: CreateEdgeInput[] = [
        // Episode -> Concept edges
        { sourceId: ep1Id, sourceType: 'episode', targetId: concepts[0]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.95 },
        { sourceId: ep1Id, sourceType: 'episode', targetId: concepts[3]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.8 },
        { sourceId: ep2Id, sourceType: 'episode', targetId: concepts[0]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.9 },
        { sourceId: ep2Id, sourceType: 'episode', targetId: concepts[1]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.85 },
        { sourceId: ep2Id, sourceType: 'episode', targetId: concepts[2]!.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.7 },
        // Concept -> Concept edges
        { sourceId: concepts[0]!.id, sourceType: 'concept', targetId: concepts[1]!.id, targetType: 'concept', edgeType: 'concept_related_to', weight: 0.8 },
        { sourceId: concepts[0]!.id, sourceType: 'concept', targetId: concepts[3]!.id, targetType: 'concept', edgeType: 'concept_related_to', weight: 0.75 },
        { sourceId: concepts[1]!.id, sourceType: 'concept', targetId: concepts[2]!.id, targetType: 'concept', edgeType: 'concept_related_to', weight: 0.65 },
        // Temporal edge
        { sourceId: ep1Id, sourceType: 'episode', targetId: ep2Id, targetType: 'episode', edgeType: 'temporal_next', weight: 1.0 },
      ];

      const edges = edgeRepo.saveEdges(edgeInputs);

      // ── Verify: Episodes ──
      const storedEpisodes = episodeRepo.getEpisodesByConversation(conv.id);
      expect(storedEpisodes).toHaveLength(2);
      expect(storedEpisodes[0]!.type).toBe('decision');
      expect(storedEpisodes[1]!.type).toBe('action');

      // ── Verify: Concepts ──
      expect(conceptRepo.countConcepts()).toBe(4);
      expect(conceptRepo.findByName('TypeScript')).not.toBeNull();
      expect(conceptRepo.findByName('React')).not.toBeNull();

      // ── Verify: Edges ──
      expect(edgeRepo.countEdges()).toBe(9);

      // Check episode1 -> TypeScript edge
      const ep1Outgoing = edgeRepo.getOutgoingEdges(ep1Id);
      expect(ep1Outgoing.length).toBeGreaterThanOrEqual(2);
      const tsMentionEdge = ep1Outgoing.find(e => e.targetId === concepts[0]!.id);
      expect(tsMentionEdge).toBeDefined();
      expect(tsMentionEdge!.weight).toBe(0.95);

      // Check TypeScript -> React concept_related_to edge
      const tsOutgoing = edgeRepo.getOutgoingEdges(concepts[0]!.id);
      const tsReactEdge = tsOutgoing.find(e => e.targetId === concepts[1]!.id);
      expect(tsReactEdge).toBeDefined();
      expect(tsReactEdge!.edgeType).toBe('concept_related_to');

      // Check temporal ordering
      const temporalEdges = edgeRepo.getEdgesByType('temporal_next');
      expect(temporalEdges).toHaveLength(1);
      expect(temporalEdges[0]!.sourceId).toBe(ep1Id);
      expect(temporalEdges[0]!.targetId).toBe(ep2Id);
    });

    it('should maintain referential integrity between conversation and episodes', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      // Save episodes referencing real conversation message IDs
      const episode: Episode = {
        id: uuidv4(),
        conversationId: conv.id,
        type: 'action',
        title: 'Migration setup',
        description: 'desc',
        startTurnIndex: 0,
        endTurnIndex: 3,
        sourceMessageIds: conv.messages.slice(0, 4).map(m => m.id),
        actors: ['user', 'assistant'],
        createdAt: now,
      };

      episodeRepo.saveEpisodes([episode]);

      // Verify source messages still exist and are immutable
      const stored = episodeRepo.getEpisode(episode.id);
      for (const msgId of stored!.sourceMessageIds) {
        const msg = convRepo.getMessage(msgId);
        expect(msg).not.toBeNull();
      }

      // Verify conversation is intact
      const conversation = convRepo.getConversation(conv.id);
      expect(conversation).not.toBeNull();
      expect(conversation!.messages).toHaveLength(6);
    });

    it('should handle extraction from multiple conversations independently', () => {
      const conv1 = createTestConversation();
      const conv2 = ingestService.ingestConversation({
        source: 'codex',
        title: 'Python Data Pipeline',
        messages: [
          { role: 'user', content: 'Help me build a data pipeline in Python.' },
          { role: 'assistant', content: 'Sure! We can use pandas and Apache Airflow.' },
        ],
      });

      const now = new Date().toISOString();

      // Episodes for conv1
      episodeRepo.saveEpisodes([{
        id: uuidv4(), conversationId: conv1.id, type: 'decision',
        title: 'TS Migration', description: 'desc',
        startTurnIndex: 0, endTurnIndex: 1,
        sourceMessageIds: [], actors: ['user'], createdAt: now,
      }]);

      // Episodes for conv2
      episodeRepo.saveEpisodes([{
        id: uuidv4(), conversationId: conv2.id, type: 'action',
        title: 'Data Pipeline Setup', description: 'desc',
        startTurnIndex: 0, endTurnIndex: 1,
        sourceMessageIds: [], actors: ['user', 'assistant'], createdAt: now,
      }]);

      // Concepts from both conversations
      const tsConcept = conceptRepo.createConcept({
        name: 'TypeScript', description: 'd', category: 'technology',
        relevance: 0.9, sourceConversationId: conv1.id,
      });
      const pythonConcept = conceptRepo.createConcept({
        name: 'Python', description: 'd', category: 'technology',
        relevance: 0.9, sourceConversationId: conv2.id,
      });

      // Verify independence
      expect(episodeRepo.getEpisodesByConversation(conv1.id)).toHaveLength(1);
      expect(episodeRepo.getEpisodesByConversation(conv2.id)).toHaveLength(1);
      expect(tsConcept.sourceConversationIds).toEqual([conv1.id]);
      expect(pythonConcept.sourceConversationIds).toEqual([conv2.id]);
    });

    it('should handle empty batch extraction gracefully', () => {
      const conv = createTestConversation();

      // Empty episode batch
      episodeRepo.saveEpisodes([]);
      expect(episodeRepo.countEpisodes(conv.id)).toBe(0);

      // Empty concept batch
      const concepts = conceptRepo.saveConcepts([]);
      expect(concepts).toHaveLength(0);

      // Empty edge batch
      const edges = edgeRepo.saveEdges([]);
      expect(edges).toHaveLength(0);
    });

    it('should allow graph traversal from episode to related concepts', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      // Create a mini-graph
      const epId = uuidv4();
      episodeRepo.saveEpisodes([{
        id: epId, conversationId: conv.id, type: 'decision',
        title: 'Chose TypeScript for React project', description: 'desc',
        startTurnIndex: 0, endTurnIndex: 5,
        sourceMessageIds: [], actors: ['user', 'assistant'], createdAt: now,
      }]);

      const tsConcept = conceptRepo.createConcept({
        name: 'TypeScript', description: 'd', category: 'technology',
        relevance: 0.95, sourceConversationId: conv.id,
      });
      const reactConcept = conceptRepo.createConcept({
        name: 'React', description: 'd', category: 'technology',
        relevance: 0.85, sourceConversationId: conv.id,
      });
      const strictConcept = conceptRepo.createConcept({
        name: 'Strict Mode', description: 'd', category: 'preference',
        relevance: 0.8, sourceConversationId: conv.id,
      });

      edgeRepo.saveEdges([
        { sourceId: epId, sourceType: 'episode', targetId: tsConcept.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.95 },
        { sourceId: epId, sourceType: 'episode', targetId: reactConcept.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.85 },
        { sourceId: epId, sourceType: 'episode', targetId: strictConcept.id, targetType: 'concept', edgeType: 'episode_mentions_concept', weight: 0.7 },
        { sourceId: tsConcept.id, sourceType: 'concept', targetId: reactConcept.id, targetType: 'concept', edgeType: 'concept_related_to', weight: 0.8 },
        { sourceId: tsConcept.id, sourceType: 'concept', targetId: strictConcept.id, targetType: 'concept', edgeType: 'concept_related_to', weight: 0.75 },
      ]);

      // Traverse: Episode -> mentioned concepts
      const epEdges = edgeRepo.getOutgoingEdges(epId);
      const mentionedConceptIds = epEdges
        .filter(e => e.edgeType === 'episode_mentions_concept')
        .sort((a, b) => b.weight - a.weight)
        .map(e => e.targetId);

      expect(mentionedConceptIds).toHaveLength(3);
      // Highest weight first
      expect(mentionedConceptIds[0]).toBe(tsConcept.id);
      expect(mentionedConceptIds[1]).toBe(reactConcept.id);
      expect(mentionedConceptIds[2]).toBe(strictConcept.id);

      // Traverse: TypeScript concept -> related concepts
      const tsRelated = edgeRepo.getOutgoingEdges(tsConcept.id);
      const relatedIds = tsRelated
        .filter(e => e.edgeType === 'concept_related_to')
        .map(e => e.targetId);
      expect(relatedIds).toContain(reactConcept.id);
      expect(relatedIds).toContain(strictConcept.id);

      // Traverse: React concept -> incoming (who mentions it?)
      const reactIncoming = edgeRepo.getIncomingEdges(reactConcept.id);
      const mentioners = reactIncoming.map(e => ({ id: e.sourceId, type: e.sourceType }));
      expect(mentioners).toContainEqual({ id: epId, type: 'episode' });
      expect(mentioners).toContainEqual({ id: tsConcept.id, type: 'concept' });
    });
  });

  // ─── Immutability & Data Integrity ──────────────────────────────

  describe('Immutability and data integrity', () => {
    it('should preserve original conversation data after batch extraction', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();
      const originalMsgContents = conv.messages.map(m => m.content);

      // Run batch extraction and store results
      episodeRepo.saveEpisodes([{
        id: uuidv4(), conversationId: conv.id, type: 'decision',
        title: 'Decision', description: 'desc',
        startTurnIndex: 0, endTurnIndex: 5,
        sourceMessageIds: conv.messages.map(m => m.id),
        actors: ['user', 'assistant'], createdAt: now,
      }]);

      conceptRepo.saveConcepts([
        { name: 'TypeScript', description: 'd', category: 'technology', relevance: 0.9, sourceConversationId: conv.id },
      ]);

      // Verify original conversation is unchanged
      const refetched = convRepo.getConversation(conv.id);
      expect(refetched).not.toBeNull();
      expect(refetched!.messages).toHaveLength(6);
      for (let i = 0; i < originalMsgContents.length; i++) {
        expect(refetched!.messages[i]!.content).toBe(originalMsgContents[i]);
      }
    });

    it('should handle all episode types correctly', () => {
      const conv = createTestConversation();
      const now = new Date().toISOString();

      const allTypes: Array<Episode['type']> = ['action', 'decision', 'event', 'discovery'];
      const episodes: Episode[] = allTypes.map((type, i) => ({
        id: uuidv4(),
        conversationId: conv.id,
        type,
        title: `${type} episode`,
        description: `A ${type} occurred`,
        startTurnIndex: i,
        endTurnIndex: i,
        sourceMessageIds: [conv.messages[i]!.id],
        actors: ['user'],
        createdAt: now,
      }));

      episodeRepo.saveEpisodes(episodes);

      for (const type of allTypes) {
        const byType = episodeRepo.getEpisodesByType(type);
        expect(byType).toHaveLength(1);
        expect(byType[0]!.type).toBe(type);
      }
    });

    it('should handle all concept categories correctly', () => {
      const conv = createTestConversation();
      const categories = [
        'technology', 'architecture', 'domain', 'methodology',
        'preference', 'project', 'platform', 'standard', 'other',
      ] as const;

      for (const cat of categories) {
        conceptRepo.createConcept({
          name: `Test${cat}`,
          description: `A ${cat} concept`,
          category: cat,
          relevance: 0.5,
          sourceConversationId: conv.id,
        });
      }

      expect(conceptRepo.countConcepts()).toBe(categories.length);
      for (const cat of categories) {
        const byCat = conceptRepo.getConceptsByCategory(cat);
        expect(byCat).toHaveLength(1);
      }
    });
  });
});
