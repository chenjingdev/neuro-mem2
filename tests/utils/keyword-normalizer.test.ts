/**
 * Tests for keyword normalization utilities.
 *
 * Validates:
 * - Lowercasing (English)
 * - Deduplication
 * - Sorting (deterministic)
 * - Whitespace trimming
 * - Korean/English mixed (한영 혼용) handling
 * - Punctuation-only token filtering
 * - FTS5 query building with column targeting
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeKeywords,
  extractKeywordTokens,
  mergeKeywords,
  buildFtsMatchQuery,
  buildColumnFtsQuery,
} from '../../src/utils/keyword-normalizer.js';

describe('normalizeKeywords', () => {
  it('lowercases English tokens', () => {
    expect(normalizeKeywords('React Vue Angular')).toBe('angular react vue');
  });

  it('deduplicates case-insensitive tokens', () => {
    expect(normalizeKeywords('React react REACT')).toBe('react');
  });

  it('sorts tokens alphabetically', () => {
    expect(normalizeKeywords('zebra apple mango')).toBe('apple mango zebra');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeKeywords('  React  Vue  ')).toBe('react vue');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeKeywords('React    Vue     Angular')).toBe('angular react vue');
  });

  it('handles Korean keywords', () => {
    expect(normalizeKeywords('리액트 프레임워크 선호')).toBe('리액트 선호 프레임워크');
  });

  it('handles mixed Korean/English (한영 혼용)', () => {
    const result = normalizeKeywords('React 리액트 frontend 프론트엔드');
    expect(result).toBe('frontend react 리액트 프론트엔드');
  });

  it('deduplicates mixed-case Korean/English', () => {
    const result = normalizeKeywords('React react 리액트 REACT');
    expect(result).toBe('react 리액트');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeKeywords('')).toBe('');
    expect(normalizeKeywords('   ')).toBe('');
  });

  it('returns empty string for null/undefined-like input', () => {
    expect(normalizeKeywords(null as any)).toBe('');
    expect(normalizeKeywords(undefined as any)).toBe('');
  });

  it('strips punctuation-only tokens', () => {
    expect(normalizeKeywords('React --- ... !! Vue')).toBe('react vue');
  });

  it('preserves tokens with mixed alphanumeric and punctuation', () => {
    // C++ and node.js contain letters, so they should be kept
    expect(normalizeKeywords('C++ node.js')).toContain('c++');
    expect(normalizeKeywords('C++ node.js')).toContain('node.js');
  });

  it('handles tabs and newlines as separators', () => {
    expect(normalizeKeywords('React\tVue\nAngular')).toBe('angular react vue');
  });
});

describe('extractKeywordTokens', () => {
  it('extracts individual tokens', () => {
    expect(extractKeywordTokens('react vue angular')).toEqual(['react', 'vue', 'angular']);
  });

  it('returns empty array for empty input', () => {
    expect(extractKeywordTokens('')).toEqual([]);
    expect(extractKeywordTokens('   ')).toEqual([]);
  });
});

describe('mergeKeywords', () => {
  it('merges multiple keyword sources', () => {
    const result = mergeKeywords('React frontend', '리액트 ReactJS', 'UI library');
    expect(result).toContain('react');
    expect(result).toContain('frontend');
    expect(result).toContain('리액트');
    expect(result).toContain('reactjs');
    expect(result).toContain('ui');
    expect(result).toContain('library');
  });

  it('handles undefined/null sources', () => {
    const result = mergeKeywords('React', undefined, null, 'Vue');
    expect(result).toBe('react vue');
  });

  it('deduplicates across sources', () => {
    const result = mergeKeywords('React frontend', 'react FRONTEND');
    expect(result).toBe('frontend react');
  });

  it('returns empty for all empty sources', () => {
    expect(mergeKeywords('', undefined, null)).toBe('');
  });
});

describe('buildFtsMatchQuery', () => {
  it('wraps tokens in quotes for OR mode (default)', () => {
    const result = buildFtsMatchQuery('React Vue');
    expect(result).toBe('"react" OR "vue"');
  });

  it('wraps tokens in quotes for AND mode', () => {
    const result = buildFtsMatchQuery('React Vue', 'and');
    expect(result).toBe('"react" AND "vue"');
  });

  it('escapes double quotes in tokens', () => {
    const result = buildFtsMatchQuery('he said "hello"');
    expect(result).toContain('""hello""');
  });

  it('lowercases tokens', () => {
    const result = buildFtsMatchQuery('React ANGULAR');
    expect(result).toBe('"react" OR "angular"');
  });

  it('handles Korean tokens', () => {
    const result = buildFtsMatchQuery('리액트 프레임워크');
    expect(result).toBe('"리액트" OR "프레임워크"');
  });

  it('returns null for empty query', () => {
    expect(buildFtsMatchQuery('')).toBeNull();
    expect(buildFtsMatchQuery('  ')).toBeNull();
  });

  it('strips punctuation-only tokens', () => {
    const result = buildFtsMatchQuery('React ... Vue');
    expect(result).toBe('"react" OR "vue"');
  });
});

describe('buildColumnFtsQuery', () => {
  it('targets keywords column', () => {
    const result = buildColumnFtsQuery('keywords', 'React Vue');
    expect(result).toBe('keywords: "react" OR "vue"');
  });

  it('targets frontmatter column', () => {
    const result = buildColumnFtsQuery('frontmatter', 'test');
    expect(result).toBe('frontmatter: "test"');
  });

  it('targets summary column', () => {
    const result = buildColumnFtsQuery('summary', '리액트');
    expect(result).toBe('summary: "리액트"');
  });

  it('returns null for empty query', () => {
    expect(buildColumnFtsQuery('keywords', '')).toBeNull();
  });
});
