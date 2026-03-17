/**
 * Tests for FactIngestionPipeline — the service that orchestrates
 * LLM frontmatter generation → summary generation → DB persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { FactIngestionPipeline } from '../src/services/fact-ingestion-pipeline.js';
import type { CreateFactInput } from '../src/models/fact.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONV_ID = 'conv-001';

function makeFactInput(overrides: Partial<CreateFactInput> = {}): CreateFactInput {
  return {
    content: 'The user prefers TypeScript for backend development',
    conversationId: TEST_CONV_ID,
    sourceMessageIds: ['msg-u1', 'msg-a1'],
    sourceTurnIndex: 1,
    confidence: 0.95,
    category: 'preference',
    entities: ['TypeScript'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FactIngestionPipeline', () => {
  let db: Database.Database;
  let factRepo: FactRepository;
  let mockLLM: MockLLMProvider;
  let pipeline: FactIngestionPipeline;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    factRepo = new FactRepository(db);
    mockLLM = new MockLLMProvider();
    pipeline = new FactIngestionPipeline(mockLLM, factRepo);

    // Seed a conversation so FK constraints pass
    const convRepo = new ConversationRepository(db);
    convRepo.ingest({
      id: TEST_CONV_ID,
      source: 'test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Sequential pipeline: frontmatter → summary → DB save
  // -------------------------------------------------------------------------

  describe('sequential pipeline: frontmatter → summary → DB', () => {
    it('should generate frontmatter then summary then persist', async () => {
      // LLM call 1: frontmatter
      mockLLM.addResponse('TypeScript preference');
      // LLM call 2: summary
      mockLLM.addResponse('User prefers TypeScript for backend work.');

      const result = await pipeline.ingestOne(makeFactInput());

      // Should have made exactly 2 LLM calls
      expect(mockLLM.calls).toHaveLength(2);

      // Call 1 is frontmatter
      expect(mockLLM.calls[0]!.system).toContain('labeler');
      expect(mockLLM.calls[0]!.prompt).toContain('TypeScript');

      // Call 2 is summary — prompt includes frontmatter as context
      expect(mockLLM.calls[1]!.system).toContain('summarizer');
      expect(mockLLM.calls[1]!.prompt).toContain('TypeScript preference');

      // Fact persisted with both fields
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.frontmatter).toBe('TypeScript preference');
      expect(result.facts[0]!.summary).toBe('User prefers TypeScript for backend work.');
      expect(result.warnings).toHaveLength(0);

      // Verify DB round-trip
      const dbFact = factRepo.getById(result.facts[0]!.id);
      expect(dbFact).not.toBeNull();
      expect(dbFact!.frontmatter).toBe('TypeScript preference');
      expect(dbFact!.summary).toBe('User prefers TypeScript for backend work.');
    });

    it('should process batch of facts sequentially', async () => {
      // Fact 1: frontmatter + summary
      mockLLM.addResponse('TS backend pref');
      mockLLM.addResponse('Prefers TypeScript for backends.');
      // Fact 2: frontmatter + summary
      mockLLM.addResponse('React frontend');
      mockLLM.addResponse('Uses React for frontend.');

      const inputs = [
        makeFactInput({ content: 'User prefers TypeScript' }),
        makeFactInput({ content: 'User uses React for frontend', category: 'technical', entities: ['React'] }),
      ];

      const result = await pipeline.ingestMany(inputs);

      expect(result.facts).toHaveLength(2);
      expect(mockLLM.calls).toHaveLength(4); // 2 per fact

      expect(result.facts[0]!.frontmatter).toBe('TS backend pref');
      expect(result.facts[0]!.summary).toBe('Prefers TypeScript for backends.');
      expect(result.facts[1]!.frontmatter).toBe('React frontend');
      expect(result.facts[1]!.summary).toBe('Uses React for frontend.');
    });

    it('should preserve existing frontmatter/summary if already provided', async () => {
      // Only summary LLM call should happen (frontmatter already set)
      mockLLM.addResponse('LLM-generated summary.');

      const input = makeFactInput({
        frontmatter: 'Pre-set frontmatter',
      });

      const result = await pipeline.ingestOne(input);

      // Only 1 LLM call (summary), not 2
      expect(mockLLM.calls).toHaveLength(1);
      expect(mockLLM.calls[0]!.system).toContain('summarizer');

      expect(result.facts[0]!.frontmatter).toBe('Pre-set frontmatter');
      expect(result.facts[0]!.summary).toBe('LLM-generated summary.');
    });

    it('should skip both LLM calls when both fields are pre-populated', async () => {
      const input = makeFactInput({
        frontmatter: 'Existing label',
        summary: 'Existing summary.',
      });

      const result = await pipeline.ingestOne(input);

      expect(mockLLM.calls).toHaveLength(0);
      expect(result.facts[0]!.frontmatter).toBe('Existing label');
      expect(result.facts[0]!.summary).toBe('Existing summary.');
    });
  });

  // -------------------------------------------------------------------------
  // Graceful degradation
  // -------------------------------------------------------------------------

  describe('graceful degradation on LLM failure', () => {
    it('should still save fact when frontmatter generation fails', async () => {
      // Frontmatter call throws
      const failingLLM = new MockLLMProvider();
      failingLLM.addResponse(''); // placeholder — will be overridden
      failingLLM.complete = async (req) => {
        if (req.system.includes('labeler')) {
          throw new Error('LLM timeout');
        }
        return { content: 'A summary.' };
      };

      const failPipeline = new FactIngestionPipeline(failingLLM, factRepo);
      const result = await failPipeline.ingestOne(makeFactInput());

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.frontmatter).toBeUndefined();
      expect(result.facts[0]!.summary).toBe('A summary.');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Frontmatter generation failed');
      expect(result.warnings[0]).toContain('LLM timeout');
    });

    it('should still save fact when summary generation fails', async () => {
      const failingLLM = new MockLLMProvider();
      failingLLM.complete = async (req) => {
        if (req.system.includes('summarizer')) {
          throw new Error('Rate limit');
        }
        return { content: 'A label' };
      };

      const failPipeline = new FactIngestionPipeline(failingLLM, factRepo);
      const result = await failPipeline.ingestOne(makeFactInput());

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.frontmatter).toBe('A label');
      expect(result.facts[0]!.summary).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Summary generation failed');
    });

    it('should still save fact when both LLM calls fail', async () => {
      const failingLLM = new MockLLMProvider();
      failingLLM.complete = async () => {
        throw new Error('Service unavailable');
      };

      const failPipeline = new FactIngestionPipeline(failingLLM, factRepo);
      const result = await failPipeline.ingestOne(makeFactInput());

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.frontmatter).toBeUndefined();
      expect(result.facts[0]!.summary).toBeUndefined();
      expect(result.warnings).toHaveLength(2);

      // Fact is still in DB
      const dbFact = factRepo.getById(result.facts[0]!.id);
      expect(dbFact).not.toBeNull();
      expect(dbFact!.content).toBe('The user prefers TypeScript for backend development');
    });
  });

  // -------------------------------------------------------------------------
  // Options / configuration
  // -------------------------------------------------------------------------

  describe('pipeline options', () => {
    it('should skip frontmatter when generateFrontmatter is false', async () => {
      // Only summary call
      mockLLM.addResponse('A summary.');

      const noFmPipeline = new FactIngestionPipeline(mockLLM, factRepo, {
        generateFrontmatter: false,
      });

      const result = await noFmPipeline.ingestOne(makeFactInput());

      expect(mockLLM.calls).toHaveLength(1);
      expect(mockLLM.calls[0]!.system).toContain('summarizer');
      expect(result.facts[0]!.frontmatter).toBeUndefined();
      expect(result.facts[0]!.summary).toBe('A summary.');
    });

    it('should skip summary when generateSummary is false', async () => {
      // Only frontmatter call
      mockLLM.addResponse('A label');

      const noSumPipeline = new FactIngestionPipeline(mockLLM, factRepo, {
        generateSummary: false,
      });

      const result = await noSumPipeline.ingestOne(makeFactInput());

      expect(mockLLM.calls).toHaveLength(1);
      expect(mockLLM.calls[0]!.system).toContain('labeler');
      expect(result.facts[0]!.frontmatter).toBe('A label');
      expect(result.facts[0]!.summary).toBeUndefined();
    });

    it('should skip both when both generation flags are false', async () => {
      const nothingPipeline = new FactIngestionPipeline(mockLLM, factRepo, {
        generateFrontmatter: false,
        generateSummary: false,
      });

      const result = await nothingPipeline.ingestOne(makeFactInput());

      expect(mockLLM.calls).toHaveLength(0);
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.frontmatter).toBeUndefined();
      expect(result.facts[0]!.summary).toBeUndefined();
    });

    it('should pass custom temperature and maxTokens to LLM', async () => {
      mockLLM.addResponse('label');
      mockLLM.addResponse('summary');

      const customPipeline = new FactIngestionPipeline(mockLLM, factRepo, {
        temperature: 0.7,
        maxTokens: 50,
      });

      await customPipeline.ingestOne(makeFactInput());

      expect(mockLLM.calls[0]!.temperature).toBe(0.7);
      expect(mockLLM.calls[0]!.maxTokens).toBe(50);
      expect(mockLLM.calls[1]!.temperature).toBe(0.7);
      expect(mockLLM.calls[1]!.maxTokens).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty input array', async () => {
      const result = await pipeline.ingestMany([]);

      expect(result.facts).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(mockLLM.calls).toHaveLength(0);
    });

    it('should trim whitespace from LLM responses', async () => {
      mockLLM.addResponse('  padded label  \n');
      mockLLM.addResponse('\n  padded summary.  \n\n');

      const result = await pipeline.ingestOne(makeFactInput());

      expect(result.facts[0]!.frontmatter).toBe('padded label');
      expect(result.facts[0]!.summary).toBe('padded summary.');
    });

    it('should pass frontmatter as context hint to summary prompt', async () => {
      mockLLM.addResponse('TS pref');
      mockLLM.addResponse('Prefers TS.');

      await pipeline.ingestOne(makeFactInput());

      // The summary prompt should include the frontmatter label
      const summaryCall = mockLLM.calls[1]!;
      expect(summaryCall.prompt).toContain('Label: TS pref');
    });

    it('should persist all fact fields correctly through the pipeline', async () => {
      mockLLM.addResponse('Node.js decision');
      mockLLM.addResponse('Decided to use Node.js runtime.');

      const input = makeFactInput({
        content: 'The project uses Node.js runtime',
        category: 'technical',
        confidence: 0.88,
        entities: ['Node.js'],
        subject: 'project',
        predicate: 'uses',
        object: 'Node.js',
        metadata: { extractionModel: 'mock' },
      });

      const result = await pipeline.ingestOne(input);
      const fact = result.facts[0]!;

      // Original fields preserved
      expect(fact.content).toBe('The project uses Node.js runtime');
      expect(fact.category).toBe('technical');
      expect(fact.confidence).toBe(0.88);
      expect(fact.entities).toEqual(['Node.js']);
      expect(fact.subject).toBe('project');
      expect(fact.predicate).toBe('uses');
      expect(fact.object).toBe('Node.js');
      expect(fact.conversationId).toBe('conv-001');
      expect(fact.sourceMessageIds).toEqual(['msg-u1', 'msg-a1']);

      // Enriched fields
      expect(fact.frontmatter).toBe('Node.js decision');
      expect(fact.summary).toBe('Decided to use Node.js runtime.');

      // DB round-trip
      const dbFact = factRepo.getById(fact.id);
      expect(dbFact!.subject).toBe('project');
      expect(dbFact!.frontmatter).toBe('Node.js decision');
      expect(dbFact!.summary).toBe('Decided to use Node.js runtime.');
    });
  });

  // -------------------------------------------------------------------------
  // Pipeline traceability
  // -------------------------------------------------------------------------

  describe('pipeline traceability', () => {
    it('should track LLM call order: frontmatter before summary', async () => {
      const callOrder: string[] = [];
      const tracingLLM = new MockLLMProvider();
      const originalComplete = tracingLLM.complete.bind(tracingLLM);

      tracingLLM.addResponse('label');
      tracingLLM.addResponse('summary');

      tracingLLM.complete = async (req) => {
        if (req.system.includes('labeler')) callOrder.push('frontmatter');
        if (req.system.includes('summarizer')) callOrder.push('summary');
        return originalComplete(req);
      };

      const tracePipeline = new FactIngestionPipeline(tracingLLM, factRepo);
      await tracePipeline.ingestOne(makeFactInput());

      expect(callOrder).toEqual(['frontmatter', 'summary']);
    });

    it('should report warnings per-fact in batch mode', async () => {
      // Fact 1: frontmatter ok, summary fails
      // Fact 2: both ok
      let callCount = 0;
      const selectiveLLM = new MockLLMProvider();
      selectiveLLM.complete = async (req) => {
        callCount++;
        // Call 2 is fact-1 summary — make it fail
        if (callCount === 2) throw new Error('Oops');
        return { content: `response-${callCount}` };
      };

      const batchPipeline = new FactIngestionPipeline(selectiveLLM, factRepo);
      const result = await batchPipeline.ingestMany([
        makeFactInput({ content: 'Fact one' }),
        makeFactInput({ content: 'Fact two' }),
      ]);

      expect(result.facts).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Summary generation failed');
      expect(result.warnings[0]).toContain('Fact one');
    });
  });
});
