/**
 * Tests for proxy context-injector progressive depth support.
 */

import { describe, it, expect } from 'vitest';
import { formatMemories } from '../src/proxy/context-injector.js';
import type { MergedMemoryItem } from '../src/retrieval/types.js';

function createItem(overrides: Partial<MergedMemoryItem> = {}): MergedMemoryItem {
  return {
    nodeId: 'test-id',
    nodeType: 'semantic' as any,
    score: 0.85,
    content: 'Full detailed content',
    sources: ['vector'],
    sourceScores: { vector: 0.85 },
    depthLevel: 'L2',
    frontmatter: 'Short label',
    summary: 'Summary text',
    nodeMetadata: {
      category: 'programming',
      entities: ['TypeScript'],
    },
    ...overrides,
  };
}

describe('formatMemories — progressive depth', () => {
  it('includes depth level in output', () => {
    const result = formatMemories([createItem()], 10);
    expect(result).toContain('/L2');
  });

  it('uses frontmatter for L0 items', () => {
    const result = formatMemories([createItem({ depthLevel: 'L0' })], 10);
    expect(result).toContain('Short label');
    expect(result).not.toContain('Full detailed content');
    expect(result).toContain('/L0');
  });

  it('uses summary for L2 items', () => {
    const result = formatMemories([createItem({ depthLevel: 'L2' })], 10);
    expect(result).toContain('Summary text');
  });

  it('uses full content for L3 items', () => {
    const result = formatMemories([createItem({ depthLevel: 'L3' })], 10);
    expect(result).toContain('Full detailed content');
    expect(result).toContain('/L3');
  });

  it('shows metadata inline for L1 items', () => {
    const result = formatMemories([createItem({ depthLevel: 'L1' })], 10);
    expect(result).toContain('Short label');
    expect(result).toContain('programming');
    expect(result).toContain('/L1');
  });

  it('falls back to content when frontmatter missing at L0', () => {
    const result = formatMemories([createItem({
      depthLevel: 'L0',
      frontmatter: undefined,
    })], 10);
    expect(result).toContain('Full detailed content');
  });

  it('defaults to L2 when depthLevel not set', () => {
    const result = formatMemories([createItem({ depthLevel: undefined })], 10);
    expect(result).toContain('/L2');
  });
});
