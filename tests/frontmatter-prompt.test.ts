/**
 * Tests for frontmatter-prompt.ts and frontmatter-parser.ts
 *
 * Validates:
 * - Prompt building for single and batch facts
 * - Structured frontmatter JSON parsing with category, keywords, domain, importance
 * - Fallback generation without LLM
 * - Edge cases: empty input, malformed JSON, missing fields
 */

import { describe, it, expect } from 'vitest';
import {
  buildFrontmatterRequest,
  buildBatchFrontmatterRequest,
  getFrontmatterSystemPrompt,
  type FrontmatterInput,
} from '../src/extraction/frontmatter-prompt.js';
import {
  parseFrontmatterResponse,
  parseBatchFrontmatterResponse,
  generateFallbackFrontmatter,
} from '../src/extraction/frontmatter-parser.js';

// ---------------------------------------------------------------------------
// frontmatter-prompt tests
// ---------------------------------------------------------------------------

describe('frontmatter-prompt', () => {
  const sampleInput: FrontmatterInput = {
    factContent: 'The user prefers TypeScript over JavaScript for backend development.',
    category: 'preference',
    entities: ['TypeScript', 'JavaScript'],
  };

  describe('buildFrontmatterRequest', () => {
    it('builds a valid LLM request for a single fact', () => {
      const req = buildFrontmatterRequest(sampleInput);

      expect(req.system).toContain('metadata indexer');
      expect(req.system).toContain('frontmatter');
      expect(req.system).toContain('keywords');
      expect(req.prompt).toContain('TypeScript over JavaScript');
      expect(req.prompt).toContain('preference');
      expect(req.prompt).toContain('TypeScript, JavaScript');
      expect(req.responseFormat).toBe('json');
      expect(req.temperature).toBe(0.1);
      expect(req.maxTokens).toBe(512);
    });

    it('includes conversation context when provided', () => {
      const req = buildFrontmatterRequest({
        ...sampleInput,
        conversationContext: 'Discussing backend architecture choices',
      });

      expect(req.prompt).toContain('<context>');
      expect(req.prompt).toContain('backend architecture');
    });

    it('handles empty entities gracefully', () => {
      const req = buildFrontmatterRequest({
        factContent: 'A simple fact.',
        category: 'other',
        entities: [],
      });

      expect(req.prompt).not.toContain('Entities:');
    });

    it('includes pre-assigned category', () => {
      const req = buildFrontmatterRequest(sampleInput);
      expect(req.prompt).toContain('Pre-assigned category: preference');
    });
  });

  describe('buildBatchFrontmatterRequest', () => {
    it('builds a valid batch request for multiple facts', () => {
      const inputs: FrontmatterInput[] = [
        { factContent: 'Fact one', category: 'technical', entities: ['React'] },
        { factContent: 'Fact two', category: 'decision', entities: [] },
      ];

      const req = buildBatchFrontmatterRequest(inputs);

      expect(req.prompt).toContain('index="0"');
      expect(req.prompt).toContain('index="1"');
      expect(req.prompt).toContain('Fact one');
      expect(req.prompt).toContain('Fact two');
      expect(req.prompt).toContain('exactly 2 items');
      expect(req.maxTokens).toBe(1024); // 512 * 2
    });
  });

  describe('getFrontmatterSystemPrompt', () => {
    it('returns the system prompt string', () => {
      const prompt = getFrontmatterSystemPrompt();
      expect(prompt).toContain('metadata indexer');
      expect(prompt).toContain('label');
      expect(prompt).toContain('keywords');
      expect(prompt).toContain('domain');
      expect(prompt).toContain('importance');
    });
  });
});

// ---------------------------------------------------------------------------
// frontmatter-parser tests
// ---------------------------------------------------------------------------

describe('frontmatter-parser', () => {
  describe('parseFrontmatterResponse', () => {
    it('parses a well-formed JSON response', () => {
      const raw = JSON.stringify({
        frontmatter: {
          label: 'Prefers TypeScript for backend',
          category: 'preference',
          keywords: ['typescript', 'backend', 'language-preference'],
          domain: 'backend',
          importance: 'medium',
        },
        summary: 'The user prefers TypeScript over JavaScript for backend development.',
      });

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.label).toBe('Prefers TypeScript for backend');
        expect(fm.category).toBe('preference');
        expect(fm.keywords).toContain('typescript');
        expect(fm.domain).toBe('backend');
        expect(fm.importance).toBe('medium');
        expect(result.result.summary).toContain('TypeScript');
      }
    });

    it('parses JSON wrapped in markdown fences', () => {
      const raw = '```json\n' + JSON.stringify({
        frontmatter: { label: 'Test', category: 'other', keywords: ['test'] },
        summary: 'A test summary.',
      }) + '\n```';

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.label).toBe('Test');
      }
    });

    it('normalizes invalid category to "other"', () => {
      const raw = JSON.stringify({
        frontmatter: { label: 'Test', category: 'invalid_cat', keywords: [] },
        summary: 'Test.',
      });

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.category).toBe('other');
      }
    });

    it('deduplicates keywords', () => {
      const raw = JSON.stringify({
        frontmatter: { label: 'Test', category: 'technical', keywords: ['react', 'React', 'react'] },
        summary: 'Test.',
      });

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.keywords).toEqual(['react']);
      }
    });

    it('truncates label to 80 characters', () => {
      const longLabel = 'A'.repeat(100);
      const raw = JSON.stringify({
        frontmatter: { label: longLabel, category: 'other', keywords: [] },
        summary: 'Test.',
      });

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.label.length).toBe(80);
      }
    });

    it('caps keywords at 10', () => {
      const keywords = Array.from({ length: 15 }, (_, i) => `kw${i}`);
      const raw = JSON.stringify({
        frontmatter: { label: 'Test', category: 'other', keywords },
        summary: 'Test.',
      });

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.keywords.length).toBe(10);
      }
    });

    it('uses fallbackContent when frontmatter fields are missing', () => {
      const raw = JSON.stringify({
        frontmatter: {},
        summary: '',
      });

      const result = parseFrontmatterResponse(raw, 'The fallback content');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.label).toBe('The fallback content');
        expect(result.result.summary).toBe('The fallback content');
      }
    });

    it('returns fallback for empty input', () => {
      const result = parseFrontmatterResponse('', 'Fallback');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.summary).toBe('Fallback');
      }
    });

    it('returns error for invalid JSON', () => {
      const result = parseFrontmatterResponse('not json at all');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('JSON parse error');
      }
    });

    it('returns error for non-object JSON', () => {
      const result = parseFrontmatterResponse('"just a string"');
      expect(result.ok).toBe(false);
    });

    it('omits optional fields when not provided', () => {
      const raw = JSON.stringify({
        frontmatter: { label: 'Test', category: 'other', keywords: [] },
        summary: 'Test.',
      });

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.domain).toBeUndefined();
        expect(fm.importance).toBeUndefined();
      }
    });

    it('validates importance values', () => {
      const raw = JSON.stringify({
        frontmatter: { label: 'Test', category: 'other', keywords: [], importance: 'critical' },
        summary: 'Test.',
      });

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        // 'critical' is not valid, should be omitted
        expect(fm.importance).toBeUndefined();
      }
    });

    it('handles extra text around JSON', () => {
      const raw = 'Here is the result:\n' + JSON.stringify({
        frontmatter: { label: 'Test', category: 'other', keywords: ['test'] },
        summary: 'A test.',
      }) + '\nDone!';

      const result = parseFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fm = JSON.parse(result.result.frontmatter);
        expect(fm.label).toBe('Test');
      }
    });
  });

  describe('parseBatchFrontmatterResponse', () => {
    it('parses a well-formed batch response', () => {
      const raw = JSON.stringify({
        results: [
          {
            frontmatter: { label: 'A', category: 'technical', keywords: ['react'] },
            summary: 'Summary A.',
          },
          {
            frontmatter: { label: 'B', category: 'decision', keywords: ['deploy'] },
            summary: 'Summary B.',
          },
        ],
      });

      const result = parseBatchFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toHaveLength(2);
        const fmA = JSON.parse(result.results[0].frontmatter);
        expect(fmA.label).toBe('A');
        expect(result.results[1].summary).toBe('Summary B.');
      }
    });

    it('parses a bare array response', () => {
      const raw = JSON.stringify([
        {
          frontmatter: { label: 'A', category: 'other', keywords: [] },
          summary: 'Summary A.',
        },
      ]);

      const result = parseBatchFrontmatterResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toHaveLength(1);
      }
    });

    it('returns error for empty input', () => {
      const result = parseBatchFrontmatterResponse('');
      expect(result.ok).toBe(false);
    });

    it('uses fallback contents for malformed entries', () => {
      const raw = JSON.stringify({
        results: [null, { frontmatter: { label: 'B', category: 'other', keywords: [] }, summary: 'B.' }],
      });

      const result = parseBatchFrontmatterResponse(raw, ['Fallback A', 'Fallback B']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toHaveLength(2);
        // First entry should use fallback
        const fmA = JSON.parse(result.results[0].frontmatter);
        expect(fmA.label).toBe('Fallback A');
      }
    });

    it('returns error when no results array found', () => {
      const result = parseBatchFrontmatterResponse('{"data": "wrong format"}');
      expect(result.ok).toBe(false);
    });
  });

  describe('generateFallbackFrontmatter', () => {
    it('generates frontmatter from fact content without LLM', () => {
      const result = generateFallbackFrontmatter(
        'The user prefers TypeScript for backend.',
        'preference',
        ['TypeScript'],
      );

      const fm = JSON.parse(result.frontmatter);
      expect(fm.label).toBe('The user prefers TypeScript for backend.');
      expect(fm.category).toBe('preference');
      expect(fm.keywords).toContain('typescript');
      expect(result.summary).toBe('The user prefers TypeScript for backend.');
    });

    it('truncates long content for label', () => {
      const longContent = 'A'.repeat(100);
      const result = generateFallbackFrontmatter(longContent, 'other', []);

      const fm = JSON.parse(result.frontmatter);
      expect(fm.label.length).toBe(80);
      expect(fm.label).toContain('...');
    });

    it('normalizes entities to lowercase keywords', () => {
      const result = generateFallbackFrontmatter('Test', 'technical', ['React', 'Node.js']);

      const fm = JSON.parse(result.frontmatter);
      expect(fm.keywords).toContain('react');
      expect(fm.keywords).toContain('node.js');
    });

    it('normalizes invalid category to "other"', () => {
      const result = generateFallbackFrontmatter('Test', 'invalid', []);

      const fm = JSON.parse(result.frontmatter);
      expect(fm.category).toBe('other');
    });

    it('caps keywords at 5 from entities', () => {
      const entities = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
      const result = generateFallbackFrontmatter('Test', 'other', entities);

      const fm = JSON.parse(result.frontmatter);
      expect(fm.keywords.length).toBe(5);
    });
  });
});
