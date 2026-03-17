/**
 * Tests for summary-prompt.ts and summary-parser.ts
 *
 * Validates:
 * - Prompt building for single and batch facts
 * - JSON parsing with various LLM output formats
 * - Edge cases: empty input, malformed JSON, missing fields
 * - Summary map construction for easy lookup
 */

import { describe, it, expect } from 'vitest';
import {
  buildSummaryGenerationRequest,
  buildSingleFactSummaryRequest,
  getSummaryGenerationSystemPrompt,
} from '../src/extraction/summary-prompt.js';
import {
  parseSummaryResponse,
  buildSummaryMap,
} from '../src/extraction/summary-parser.js';

describe('summary-prompt', () => {
  describe('buildSummaryGenerationRequest', () => {
    it('builds a valid LLM request for a single fact', () => {
      const req = buildSummaryGenerationRequest({
        facts: [
          {
            id: 'fact-1',
            content: 'The user prefers TypeScript over JavaScript for backend development.',
            category: 'preference',
            entities: ['TypeScript', 'JavaScript'],
          },
        ],
      });

      expect(req.system).toContain('Level 0');
      expect(req.system).toContain('Level 1');
      expect(req.system).toContain('Frontmatter');
      expect(req.prompt).toContain('fact-1');
      expect(req.prompt).toContain('TypeScript');
      expect(req.prompt).toContain('preference');
      expect(req.responseFormat).toBe('json');
      expect(req.temperature).toBe(0.0);
      expect(req.maxTokens).toBe(1024);
    });

    it('builds a valid LLM request for multiple facts', () => {
      const req = buildSummaryGenerationRequest({
        facts: [
          { id: 'f1', content: 'Fact one', category: 'technical', entities: [] },
          { id: 'f2', content: 'Fact two', category: 'decision', entities: ['React'] },
        ],
      });

      expect(req.prompt).toContain('f1');
      expect(req.prompt).toContain('f2');
      expect(req.prompt).toContain('Return exactly 2 summaries');
    });

    it('handles facts with no entities', () => {
      const req = buildSummaryGenerationRequest({
        facts: [{ id: 'f1', content: 'A simple fact.', category: 'other', entities: [] }],
      });

      expect(req.prompt).not.toContain('[entities:');
    });

    it('includes entities when present', () => {
      const req = buildSummaryGenerationRequest({
        facts: [{ id: 'f1', content: 'Uses React.', category: 'technical', entities: ['React'] }],
      });

      expect(req.prompt).toContain('[entities: React]');
    });
  });

  describe('buildSingleFactSummaryRequest', () => {
    it('is a convenience wrapper for single fact', () => {
      const req = buildSingleFactSummaryRequest('abc', 'Some content', 'knowledge', ['AI']);

      expect(req.prompt).toContain('abc');
      expect(req.prompt).toContain('Some content');
      expect(req.prompt).toContain('knowledge');
      expect(req.prompt).toContain('AI');
    });

    it('works with default empty entities', () => {
      const req = buildSingleFactSummaryRequest('abc', 'Content', 'other');
      expect(req.prompt).toContain('abc');
      expect(req.prompt).not.toContain('[entities:');
    });
  });

  describe('getSummaryGenerationSystemPrompt', () => {
    it('returns the system prompt string', () => {
      const prompt = getSummaryGenerationSystemPrompt();
      expect(prompt).toContain('Level 0');
      expect(prompt).toContain('Level 1');
      expect(prompt).toContain('summaries');
    });
  });
});

describe('summary-parser', () => {
  describe('parseSummaryResponse', () => {
    it('parses a well-formed JSON response', () => {
      const raw = JSON.stringify({
        summaries: [
          {
            id: 'f1',
            frontmatter: 'TypeScript preference',
            summary: 'User prefers TypeScript over JavaScript for backend.',
          },
        ],
      });

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(1);
        expect(result.summaries[0].id).toBe('f1');
        expect(result.summaries[0].frontmatter).toBe('TypeScript preference');
        expect(result.summaries[0].summary).toContain('TypeScript');
      }
    });

    it('parses JSON wrapped in markdown fences', () => {
      const raw = '```json\n{"summaries": [{"id": "f1", "frontmatter": "Test", "summary": "A test summary."}]}\n```';

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(1);
        expect(result.summaries[0].frontmatter).toBe('Test');
      }
    });

    it('parses a bare array response', () => {
      const raw = JSON.stringify([
        { id: 'f1', frontmatter: 'Label A', summary: 'Summary A.' },
        { id: 'f2', frontmatter: 'Label B', summary: 'Summary B.' },
      ]);

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(2);
      }
    });

    it('handles multiple summaries', () => {
      const raw = JSON.stringify({
        summaries: [
          { id: 'f1', frontmatter: 'A', summary: 'Summary A.' },
          { id: 'f2', frontmatter: 'B', summary: 'Summary B.' },
          { id: 'f3', frontmatter: 'C', summary: 'Summary C.' },
        ],
      });

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(3);
      }
    });

    it('returns empty array for empty input', () => {
      const result = parseSummaryResponse('');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(0);
      }
    });

    it('returns empty array for whitespace-only input', () => {
      const result = parseSummaryResponse('   \n\t  ');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(0);
      }
    });

    it('returns error for invalid JSON', () => {
      const result = parseSummaryResponse('not valid json at all');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('JSON parse error');
      }
    });

    it('returns error for non-array/non-object response', () => {
      const result = parseSummaryResponse('"just a string"');
      expect(result.ok).toBe(false);
    });

    it('skips entries with missing id', () => {
      const raw = JSON.stringify({
        summaries: [
          { id: 'f1', frontmatter: 'Good', summary: 'Valid entry.' },
          { frontmatter: 'No ID', summary: 'Missing id field.' },
          { id: '', frontmatter: 'Empty ID', summary: 'Empty id.' },
        ],
      });

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(1);
        expect(result.summaries[0].id).toBe('f1');
      }
    });

    it('skips entries with missing both frontmatter and summary', () => {
      const raw = JSON.stringify({
        summaries: [
          { id: 'f1', frontmatter: '', summary: '' },
          { id: 'f2', frontmatter: 'Has frontmatter', summary: '' },
        ],
      });

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(1);
        expect(result.summaries[0].id).toBe('f2');
      }
    });

    it('falls back frontmatter to summary when frontmatter is missing', () => {
      const raw = JSON.stringify({
        summaries: [
          { id: 'f1', frontmatter: '', summary: 'Only summary provided.' },
        ],
      });

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries[0].frontmatter).toBe('Only summary provided.');
        expect(result.summaries[0].summary).toBe('Only summary provided.');
      }
    });

    it('falls back summary to frontmatter when summary is missing', () => {
      const raw = JSON.stringify({
        summaries: [
          { id: 'f1', frontmatter: 'Only frontmatter', summary: '' },
        ],
      });

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries[0].frontmatter).toBe('Only frontmatter');
        expect(result.summaries[0].summary).toBe('Only frontmatter');
      }
    });

    it('handles extra text around JSON', () => {
      const raw = 'Here is the result:\n{"summaries": [{"id": "f1", "frontmatter": "Test", "summary": "A test."}]}\nDone!';

      const result = parseSummaryResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summaries).toHaveLength(1);
      }
    });
  });

  describe('buildSummaryMap', () => {
    it('builds a map from fact ID to summary', () => {
      const summaries = [
        { id: 'f1', frontmatter: 'Label A', summary: 'Summary A.' },
        { id: 'f2', frontmatter: 'Label B', summary: 'Summary B.' },
      ];

      const map = buildSummaryMap(summaries);

      expect(map.size).toBe(2);
      expect(map.get('f1')).toEqual({ frontmatter: 'Label A', summary: 'Summary A.' });
      expect(map.get('f2')).toEqual({ frontmatter: 'Label B', summary: 'Summary B.' });
    });

    it('returns empty map for empty array', () => {
      const map = buildSummaryMap([]);
      expect(map.size).toBe(0);
    });

    it('last entry wins for duplicate IDs', () => {
      const summaries = [
        { id: 'f1', frontmatter: 'First', summary: 'First summary.' },
        { id: 'f1', frontmatter: 'Second', summary: 'Second summary.' },
      ];

      const map = buildSummaryMap(summaries);
      expect(map.size).toBe(1);
      expect(map.get('f1')!.frontmatter).toBe('Second');
    });
  });
});
