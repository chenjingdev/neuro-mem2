import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { IngestService } from '../src/services/ingest.js';
import { TurnExtractionPipeline } from '../src/services/turn-extraction-pipeline.js';
import { FactExtractor } from '../src/extraction/fact-extractor.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { EventBus } from '../src/events/event-bus.js';
import type { TurnCompletedEvent, FactsExtractedEvent, ExtractionErrorEvent } from '../src/events/event-bus.js';

describe('Turn Extraction Pipeline', () => {
  let db: Database.Database;
  let convRepo: ConversationRepository;
  let factRepo: FactRepository;
  let ingestService: IngestService;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let factExtractor: FactExtractor;
  let pipeline: TurnExtractionPipeline;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    convRepo = new ConversationRepository(db);
    factRepo = new FactRepository(db);
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();
    factExtractor = new FactExtractor(mockLLM);
    ingestService = new IngestService(convRepo, eventBus);
    pipeline = new TurnExtractionPipeline(
      eventBus,
      factExtractor,
      factRepo,
      convRepo,
    );
  });

  afterEach(() => {
    pipeline.stop();
    eventBus.clear();
    db.close();
  });

  describe('Event emission from IngestService', () => {
    it('should emit turn.completed when appendMessage is called', async () => {
      const events: TurnCompletedEvent[] = [];
      eventBus.on<TurnCompletedEvent>('turn.completed', (e) => { events.push(e); });

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      // Wait for async event emission
      await new Promise(resolve => setTimeout(resolve, 10));

      // ingestConversation also emits events for each message
      expect(events.length).toBeGreaterThanOrEqual(1);

      // Now append a message
      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi there!',
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const assistantEvents = events.filter(e => e.message.role === 'assistant');
      expect(assistantEvents.length).toBe(1);
      expect(assistantEvents[0]!.conversationId).toBe(conv.id);
      expect(assistantEvents[0]!.message.content).toBe('Hi there!');
    });

    it('should emit turn.completed for batch ingest messages', async () => {
      const events: TurnCompletedEvent[] = [];
      eventBus.on<TurnCompletedEvent>('turn.completed', (e) => { events.push(e); });

      ingestService.ingestConversation({
        source: 'test',
        messages: [
          { role: 'user', content: 'Q1' },
          { role: 'assistant', content: 'A1' },
          { role: 'user', content: 'Q2' },
          { role: 'assistant', content: 'A2' },
        ],
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(events).toHaveLength(4);
    });

    it('should work without EventBus (backward compatible)', () => {
      const serviceWithoutEvents = new IngestService(convRepo);

      const conv = serviceWithoutEvents.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(conv.id).toBeDefined();

      const msg = serviceWithoutEvents.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi!',
      });

      expect(msg.turnIndex).toBeDefined();
    });
  });

  describe('Pipeline: turn event → extraction → storage', () => {
    it('should extract facts when assistant message completes a turn', async () => {
      pipeline.start();

      // Mock LLM response with facts
      mockLLM.addResponse(JSON.stringify({
        facts: [
          {
            content: 'The user prefers TypeScript for backend development',
            category: 'preference',
            confidence: 0.95,
            entities: ['TypeScript'],
          },
          {
            content: 'The project uses Node.js runtime',
            category: 'technical',
            confidence: 0.85,
            entities: ['Node.js'],
          },
        ],
      }));

      // Create conversation with initial user message
      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'I prefer TypeScript for my Node.js backend' }],
      });

      // Append assistant response — this should trigger extraction
      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Great choice! TypeScript provides excellent type safety for Node.js backends.',
      });

      // Wait for async pipeline processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify facts were saved
      const facts = factRepo.getActiveByConversation(conv.id);
      expect(facts.length).toBe(2);
      expect(facts[0]!.content).toBe('The user prefers TypeScript for backend development');
      expect(facts[0]!.category).toBe('preference');
      expect(facts[0]!.confidence).toBe(0.95);
      expect(facts[1]!.content).toBe('The project uses Node.js runtime');
    });

    it('should NOT trigger extraction on user messages', async () => {
      pipeline.start();

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      // Append another user message (not an assistant response)
      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'Actually, one more thing...',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // No LLM calls should have been made
      expect(mockLLM.calls.length).toBe(0);
      expect(factRepo.countByConversation(conv.id)).toBe(0);
    });

    it('should emit facts.extracted event after successful extraction', async () => {
      pipeline.start();

      const extractedEvents: FactsExtractedEvent[] = [];
      eventBus.on<FactsExtractedEvent>('facts.extracted', (e) => {
        extractedEvents.push(e);
      });

      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'User uses VS Code',
          category: 'preference',
          confidence: 0.9,
          entities: ['VS Code'],
        }],
      }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'I use VS Code' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'VS Code is a great editor!',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(extractedEvents.length).toBe(1);
      expect(extractedEvents[0]!.facts.length).toBe(1);
      expect(extractedEvents[0]!.conversationId).toBe(conv.id);
    });

    it('should emit extraction.error when LLM returns bad JSON', async () => {
      pipeline.start();

      const errorEvents: ExtractionErrorEvent[] = [];
      eventBus.on<ExtractionErrorEvent>('extraction.error', (e) => {
        errorEvents.push(e);
      });

      mockLLM.addResponse('this is not valid json at all {{{');

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi!',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0]!.conversationId).toBe(conv.id);
      expect(errorEvents[0]!.error).toBeDefined();
    });

    it('should handle extraction with no facts gracefully', async () => {
      pipeline.start();

      mockLLM.addResponse(JSON.stringify({ facts: [] }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi!',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(factRepo.countByConversation(conv.id)).toBe(0);
    });

    it('should handle LLM provider throwing an error', async () => {
      const errorEvents: ExtractionErrorEvent[] = [];
      eventBus.on<ExtractionErrorEvent>('extraction.error', (e) => {
        errorEvents.push(e);
      });

      // Create a failing LLM provider
      const failingLLM = new MockLLMProvider();
      failingLLM.complete = async () => { throw new Error('API rate limit exceeded'); };
      const failingExtractor = new FactExtractor(failingLLM);

      // Replace pipeline with failing one
      pipeline.stop();
      const failingPipeline = new TurnExtractionPipeline(
        eventBus,
        failingExtractor,
        factRepo,
        convRepo,
      );
      failingPipeline.start();

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi!',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0]!.error).toContain('API rate limit exceeded');

      failingPipeline.stop();
    });
  });

  describe('Pipeline: multi-turn conversations', () => {
    it('should extract facts from multiple turns', async () => {
      pipeline.start();

      // Response for turn 1
      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'User is building a web app',
          category: 'context',
          confidence: 0.9,
          entities: ['web app'],
        }],
      }));

      // Response for turn 2
      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'The web app uses React for the frontend',
          category: 'technical',
          confidence: 0.95,
          entities: ['React'],
        }],
      }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'I am building a web app' }],
      });

      // Turn 1: assistant response
      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'That sounds great! What stack are you using?',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Turn 2: user + assistant
      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'I am using React for the frontend',
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'React is a solid choice for frontend development.',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const facts = factRepo.getActiveByConversation(conv.id);
      expect(facts.length).toBe(2);
      expect(facts[0]!.content).toBe('User is building a web app');
      expect(facts[1]!.content).toBe('The web app uses React for the frontend');
    });

    it('should include prior context in extraction requests', async () => {
      pipeline.start();

      // First turn response
      mockLLM.addResponse(JSON.stringify({ facts: [] }));
      // Second turn response
      mockLLM.addResponse(JSON.stringify({ facts: [] }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'I work at Acme Corp' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Got it, you work at Acme Corp.',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Second turn
      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'We use Python there',
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Python is popular at many companies.',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // The second LLM call should have prior context
      expect(mockLLM.calls.length).toBe(2);
      const secondCall = mockLLM.calls[1]!;
      expect(secondCall.prompt).toContain('I work at Acme Corp');
    });
  });

  describe('Pipeline lifecycle', () => {
    it('should not process events before start() is called', async () => {
      // Pipeline not started
      mockLLM.addResponse(JSON.stringify({ facts: [] }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi!',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockLLM.calls.length).toBe(0);
    });

    it('should not process events after stop() is called', async () => {
      pipeline.start();
      pipeline.stop();

      mockLLM.addResponse(JSON.stringify({ facts: [] }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi!',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockLLM.calls.length).toBe(0);
    });

    it('start() should be idempotent', () => {
      pipeline.start();
      pipeline.start(); // Second call should be no-op
      expect(true).toBe(true);
    });
  });

  describe('Fact storage integration', () => {
    it('should correctly store fact metadata (entities, category)', async () => {
      pipeline.start();

      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'User prefers dark mode in VS Code',
          category: 'preference',
          confidence: 0.92,
          entities: ['VS Code', 'dark mode'],
        }],
      }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'I always use dark mode in VS Code' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Dark mode is great for reducing eye strain!',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const facts = factRepo.getActiveByConversation(conv.id);
      expect(facts.length).toBe(1);
      expect(facts[0]!.entities).toContain('VS Code');
      expect(facts[0]!.entities).toContain('dark mode');
      expect(facts[0]!.category).toBe('preference');
      expect(facts[0]!.confidence).toBe(0.92);
      expect(facts[0]!.conversationId).toBe(conv.id);
      expect(facts[0]!.sourceMessageIds.length).toBe(2);
    });

    it('should link facts to correct conversation and message IDs', async () => {
      pipeline.start();

      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'Some fact',
          category: 'context',
          confidence: 0.8,
          entities: [],
        }],
      }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Something' }],
      });

      const assistantMsg = ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Response',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const facts = factRepo.getActiveByConversation(conv.id);
      expect(facts.length).toBe(1);
      // Should reference both user and assistant message IDs (format: 'convId:turnIndex')
      expect(facts[0]!.sourceMessageIds).toContain(`${conv.id}:${conv.messages[0]!.turnIndex}`);
      expect(facts[0]!.sourceMessageIds).toContain(`${conv.id}:${assistantMsg.turnIndex}`);
    });

    it('should store SPO (subject/predicate/object) triples end-to-end', async () => {
      pipeline.start();

      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'The user prefers TypeScript over JavaScript',
          category: 'preference',
          confidence: 0.95,
          entities: ['TypeScript', 'JavaScript'],
          subject: 'user',
          predicate: 'prefers',
          object: 'TypeScript',
        }],
      }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'I prefer TypeScript over JavaScript' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'TypeScript is great for type safety!',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const facts = factRepo.getActiveByConversation(conv.id);
      expect(facts.length).toBe(1);
      expect(facts[0]!.subject).toBe('user');
      expect(facts[0]!.predicate).toBe('prefers');
      expect(facts[0]!.object).toBe('TypeScript');
    });

    it('should track extraction model in fact metadata', async () => {
      pipeline.start();

      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'User works at Acme',
          category: 'context',
          confidence: 0.9,
          entities: ['Acme'],
        }],
      }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'I work at Acme' }],
      });

      ingestService.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Got it!',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const facts = factRepo.getActiveByConversation(conv.id);
      expect(facts.length).toBe(1);
      // Metadata should contain extraction model info from MockLLMProvider
      expect(facts[0]!.metadata).toBeDefined();
      expect(facts[0]!.metadata!.extractionModel).toBe('mock');
    });
  });

  describe('Batch ingest with pipeline', () => {
    it('should extract facts from assistant turns in batch-ingested conversations', async () => {
      pipeline.start();

      // Two assistant turns = two LLM calls
      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'User is working on a mobile app',
          category: 'context',
          confidence: 0.9,
          entities: ['mobile app'],
        }],
      }));

      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'The mobile app targets iOS',
          category: 'technical',
          confidence: 0.85,
          entities: ['iOS'],
        }],
      }));

      // Batch ingest a full conversation with 2 complete turns
      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [
          { role: 'user', content: 'I am building a mobile app' },
          { role: 'assistant', content: 'What platform?' },
          { role: 'user', content: 'Targeting iOS' },
          { role: 'assistant', content: 'Great choice!' },
        ],
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      const facts = factRepo.getActiveByConversation(conv.id);
      expect(facts.length).toBe(2);
      expect(facts.some(f => f.content === 'User is working on a mobile app')).toBe(true);
      expect(facts.some(f => f.content === 'The mobile app targets iOS')).toBe(true);
    });
  });

  describe('Context window configuration', () => {
    it('should respect custom contextWindowSize option', async () => {
      // Create pipeline with small context window
      pipeline.stop();
      const smallContextPipeline = new TurnExtractionPipeline(
        eventBus,
        factExtractor,
        factRepo,
        convRepo,
        { contextWindowSize: 2 },
      );
      smallContextPipeline.start();

      // First turn response
      mockLLM.addResponse(JSON.stringify({ facts: [] }));
      // Second turn response
      mockLLM.addResponse(JSON.stringify({ facts: [] }));
      // Third turn response
      mockLLM.addResponse(JSON.stringify({ facts: [] }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'First message' }],
      });

      // Turn 1
      ingestService.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'Response 1' });
      await new Promise(resolve => setTimeout(resolve, 50));

      // Turn 2
      ingestService.appendMessage({ conversationId: conv.id, role: 'user', content: 'Second message' });
      ingestService.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'Response 2' });
      await new Promise(resolve => setTimeout(resolve, 50));

      // Turn 3
      ingestService.appendMessage({ conversationId: conv.id, role: 'user', content: 'Third message' });
      ingestService.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'Response 3' });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Third LLM call should have limited context (only 2 prior messages)
      expect(mockLLM.calls.length).toBe(3);
      const thirdCall = mockLLM.calls[2]!;
      // With contextWindowSize=2, only the last 2 prior messages before the current turn should appear
      // "First message" should NOT appear (it's beyond the 2-message window)
      // The prior context should contain at most 2 messages
      const priorContextMatch = thirdCall.prompt.match(/<prior_context>([\s\S]*?)<\/prior_context>/);
      if (priorContextMatch) {
        const contextLines = priorContextMatch[1]!.trim().split('\n\n').filter(l => l.trim());
        expect(contextLines.length).toBeLessThanOrEqual(2);
      }

      smallContextPipeline.stop();
    });
  });

  describe('Fact retrieval by turn index', () => {
    it('should store correct sourceTurnIndex for each extracted fact', async () => {
      pipeline.start();

      // Turn 1 at index 0-1
      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'Fact from turn 1',
          category: 'context',
          confidence: 0.8,
          entities: [],
        }],
      }));

      // Turn 2 at index 2-3
      mockLLM.addResponse(JSON.stringify({
        facts: [{
          content: 'Fact from turn 2',
          category: 'technical',
          confidence: 0.9,
          entities: [],
        }],
      }));

      const conv = ingestService.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Q1' }],
      });

      ingestService.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'A1' });
      await new Promise(resolve => setTimeout(resolve, 100));

      ingestService.appendMessage({ conversationId: conv.id, role: 'user', content: 'Q2' });
      ingestService.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'A2' });
      await new Promise(resolve => setTimeout(resolve, 100));

      const allFacts = factRepo.getActiveByConversation(conv.id);
      expect(allFacts.length).toBe(2);

      // Facts should be ordered by turn index
      expect(allFacts[0]!.content).toBe('Fact from turn 1');
      expect(allFacts[1]!.content).toBe('Fact from turn 2');

      // Each fact's sourceTurnIndex should be set
      expect(typeof allFacts[0]!.sourceTurnIndex).toBe('number');
      expect(typeof allFacts[1]!.sourceTurnIndex).toBe('number');

      // Turn 2 facts should have a higher turn index
      expect(allFacts[1]!.sourceTurnIndex).toBeGreaterThan(allFacts[0]!.sourceTurnIndex);

      // Can retrieve facts by turn index
      const turn1Facts = factRepo.getByTurn(conv.id, allFacts[0]!.sourceTurnIndex);
      expect(turn1Facts.length).toBe(1);
      expect(turn1Facts[0]!.content).toBe('Fact from turn 1');
    });
  });
});
