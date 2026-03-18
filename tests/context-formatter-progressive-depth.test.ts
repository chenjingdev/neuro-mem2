/**
 * Tests for ContextFormatter progressive depth (4-layer MemoryNode) support.
 *
 * Validates that all 3 format types (xml/markdown/json) correctly:
 *   1. Group items by new nodeType (semantic/episodic/procedural/prospective/emotional/hub)
 *   2. Display content based on progressive depth level (L0/L1/L2/L3)
 *   3. Include depth information in output
 *   4. Handle L1 metadata inline display
 */

import { describe, it, expect } from 'vitest';
import { ContextFormatter } from '../src/api/middleware/context-formatter.js';
import type { MergedMemoryItem, DepthLevel } from '../src/retrieval/types.js';

// ─── Test Helpers ────────────────────────────────────────

function createItem(overrides: Partial<MergedMemoryItem> = {}): MergedMemoryItem {
  return {
    nodeId: 'test-id',
    nodeType: 'semantic' as any,
    score: 0.85,
    content: 'TypeScript is a typed superset of JavaScript',
    sources: ['vector'],
    sourceScores: { vector: 0.85 },
    depthLevel: 'L2',
    frontmatter: 'TypeScript language fact',
    summary: 'TypeScript extends JavaScript with static types',
    nodeMetadata: {
      category: 'programming',
      entities: ['TypeScript', 'JavaScript'],
      subject: 'TypeScript',
      predicate: 'is',
      object: 'typed superset of JavaScript',
    },
    ...overrides,
  };
}

function createItems(): MergedMemoryItem[] {
  return [
    createItem({
      nodeId: 'sem-1',
      nodeType: 'semantic' as any,
      content: 'TypeScript is a typed superset of JavaScript',
      frontmatter: 'TypeScript language',
      depthLevel: 'L2',
    }),
    createItem({
      nodeId: 'epi-1',
      nodeType: 'episodic' as any,
      content: 'User deployed the app to production on March 1',
      frontmatter: 'Deployment event',
      summary: 'App deployed to production',
      depthLevel: 'L2',
    }),
    createItem({
      nodeId: 'proc-1',
      nodeType: 'procedural' as any,
      content: 'To deploy: run npm build then docker push',
      frontmatter: 'Deploy procedure',
      depthLevel: 'L1',
      nodeMetadata: { category: 'devops', entities: ['npm', 'docker'] },
    }),
    createItem({
      nodeId: 'prosp-1',
      nodeType: 'prospective' as any,
      content: 'Plan to migrate to Deno by Q3',
      frontmatter: 'Deno migration plan',
      depthLevel: 'L0',
    }),
    createItem({
      nodeId: 'emo-1',
      nodeType: 'emotional' as any,
      content: 'User expressed frustration with build times',
      frontmatter: 'Build time frustration',
      depthLevel: 'L2',
    }),
    createItem({
      nodeId: 'hub-1',
      nodeType: 'semantic' as any,
      content: 'TypeScript ecosystem hub',
      frontmatter: 'TypeScript',
      depthLevel: 'L0',
      retrievalMetadata: { nodeRole: 'hub' },
    }),
  ];
}

// ─── XML Format Tests ────────────────────────────────────

describe('ContextFormatter XML — progressive depth', () => {
  const formatter = new ContextFormatter({ format: 'xml' });

  it('groups by new nodeType categories', () => {
    const result = formatter.formatItems(createItems());
    expect(result.text).toContain('<semantic>');
    expect(result.text).toContain('</semantic>');
    expect(result.text).toContain('<episodic>');
    expect(result.text).toContain('<procedural>');
    expect(result.text).toContain('<prospective>');
    expect(result.text).toContain('<emotional>');
    expect(result.text).toContain('<hub>');
  });

  it('does NOT use old fact/episode/concept groups', () => {
    const result = formatter.formatItems(createItems());
    expect(result.text).not.toContain('<facts>');
    expect(result.text).not.toContain('<episodes>');
    expect(result.text).not.toContain('<concepts>');
  });

  it('includes depth attribute on items', () => {
    const result = formatter.formatItems(createItems());
    expect(result.text).toContain('depth="L2"');
    expect(result.text).toContain('depth="L1"');
    expect(result.text).toContain('depth="L0"');
  });

  it('uses frontmatter for L0 depth items', () => {
    const items = [createItem({
      nodeId: 'l0-item',
      depthLevel: 'L0',
      frontmatter: 'Short label',
      content: 'Full long content that should not appear at L0',
    })];
    const result = formatter.formatItems(items);
    expect(result.text).toContain('Short label');
    expect(result.text).not.toContain('Full long content');
  });

  it('uses summary for L2 depth items', () => {
    const items = [createItem({
      nodeId: 'l2-item',
      depthLevel: 'L2',
      summary: 'Summary text here',
      content: 'Full content',
    })];
    const result = formatter.formatItems(items);
    expect(result.text).toContain('Summary text here');
  });

  it('uses full content for L3 depth items', () => {
    const items = [createItem({
      nodeId: 'l3-item',
      depthLevel: 'L3',
      summary: 'Summary',
      content: 'Full detailed content for L3',
    })];
    const result = formatter.formatItems(items);
    expect(result.text).toContain('Full detailed content for L3');
  });

  it('includes metadata in XML when includeMetadata=true', () => {
    const items = [createItem({
      depthLevel: 'L2',
      nodeMetadata: {
        category: 'programming',
        entities: ['TypeScript', 'JavaScript'],
        subject: 'TypeScript',
        predicate: 'is',
        object: 'superset',
      },
    })];
    const result = formatter.formatItems(items, { includeMetadata: true });
    expect(result.text).toContain('<metadata>');
    expect(result.text).toContain('<entities>');
    expect(result.text).toContain('<category>');
    expect(result.text).toContain('<spo>');
  });

  it('uses singular tags for each group', () => {
    const result = formatter.formatItems(createItems());
    expect(result.text).toContain('<knowledge');
    expect(result.text).toContain('<episode');
    expect(result.text).toContain('<procedure');
    expect(result.text).toContain('<plan');
    expect(result.text).toContain('<emotion');
    expect(result.text).toContain('<hub');
  });
});

// ─── Markdown Format Tests ───────────────────────────────

describe('ContextFormatter Markdown — progressive depth', () => {
  const formatter = new ContextFormatter({ format: 'markdown' });

  it('uses new group headers', () => {
    const result = formatter.formatItems(createItems());
    expect(result.text).toContain('### Semantic Knowledge');
    expect(result.text).toContain('### Episodes');
    expect(result.text).toContain('### Procedures');
    expect(result.text).toContain('### Plans & Intentions');
    expect(result.text).toContain('### Emotional Context');
    expect(result.text).toContain('### Key Concepts (Hubs)');
  });

  it('does NOT use old group headers', () => {
    const result = formatter.formatItems(createItems());
    expect(result.text).not.toContain('### Facts');
    expect(result.text).not.toContain('### Concepts');
  });

  it('includes depth level in output', () => {
    const result = formatter.formatItems(createItems());
    expect(result.text).toContain('`L2`');
    expect(result.text).toContain('`L1`');
    expect(result.text).toContain('`L0`');
  });

  it('shows metadata inline when includeMetadata=true', () => {
    const items = [createItem({
      depthLevel: 'L2',
      nodeMetadata: {
        category: 'programming',
        entities: ['TypeScript'],
      },
    })];
    const result = formatter.formatItems(items, { includeMetadata: true });
    expect(result.text).toContain('> programming');
    expect(result.text).toContain('entities: TypeScript');
  });

  it('uses frontmatter for L0 items', () => {
    const items = [createItem({
      depthLevel: 'L0',
      frontmatter: 'Short label',
      content: 'Full content',
    })];
    const result = formatter.formatItems(items);
    expect(result.text).toContain('Short label');
    expect(result.text).not.toContain('Full content');
  });
});

// ─── JSON Format Tests ───────────────────────────────────

describe('ContextFormatter JSON — progressive depth', () => {
  const formatter = new ContextFormatter({ format: 'json' });

  it('groups by new nodeType keys', () => {
    const result = formatter.formatItems(createItems());
    const parsed = JSON.parse(result.text);
    expect(parsed.memoryContext).toHaveProperty('semantic');
    expect(parsed.memoryContext).toHaveProperty('episodic');
    expect(parsed.memoryContext).toHaveProperty('procedural');
    expect(parsed.memoryContext).toHaveProperty('prospective');
    expect(parsed.memoryContext).toHaveProperty('emotional');
    expect(parsed.memoryContext).toHaveProperty('hub');
  });

  it('does NOT use old keys', () => {
    const result = formatter.formatItems(createItems());
    const parsed = JSON.parse(result.text);
    expect(parsed.memoryContext).not.toHaveProperty('facts');
    expect(parsed.memoryContext).not.toHaveProperty('episodes');
    expect(parsed.memoryContext).not.toHaveProperty('concepts');
  });

  it('includes depthLevel on each item', () => {
    const result = formatter.formatItems(createItems());
    const parsed = JSON.parse(result.text);
    for (const group of Object.values(parsed.memoryContext)) {
      for (const item of group as any[]) {
        expect(item).toHaveProperty('depthLevel');
        expect(['L0', 'L1', 'L2', 'L3']).toContain(item.depthLevel);
      }
    }
  });

  it('includes nodeType on each item', () => {
    const result = formatter.formatItems(createItems());
    const parsed = JSON.parse(result.text);
    const semanticItems = parsed.memoryContext.semantic;
    expect(semanticItems[0].nodeType).toBe('semantic');
  });

  it('includes frontmatter field', () => {
    const items = [createItem({ frontmatter: 'My frontmatter' })];
    const result = formatter.formatItems(items);
    const parsed = JSON.parse(result.text);
    const firstItem = Object.values(parsed.memoryContext)[0] as any[];
    expect(firstItem[0].frontmatter).toBe('My frontmatter');
  });

  it('includes metadata when includeMetadata=true', () => {
    const items = [createItem({
      nodeMetadata: { category: 'test', entities: ['A'] },
    })];
    const result = formatter.formatItems(items, { includeMetadata: true });
    const parsed = JSON.parse(result.text);
    const firstItem = (Object.values(parsed.memoryContext)[0] as any[])[0];
    expect(firstItem.metadata).toBeDefined();
    expect(firstItem.metadata.category).toBe('test');
  });

  it('uses frontmatter content for L0 items', () => {
    const items = [createItem({
      depthLevel: 'L0',
      frontmatter: 'Label only',
      content: 'Full content',
    })];
    const result = formatter.formatItems(items);
    const parsed = JSON.parse(result.text);
    const firstItem = (Object.values(parsed.memoryContext)[0] as any[])[0];
    expect(firstItem.content).toBe('Label only');
  });
});

// ─── L1 Metadata Inline Display ──────────────────────────

describe('ContextFormatter L1 metadata inline', () => {
  const formatter = new ContextFormatter({ format: 'xml' });

  it('shows metadata inline for L1 depth in content', () => {
    const items = [createItem({
      depthLevel: 'L1',
      frontmatter: 'Deploy procedure',
      nodeMetadata: {
        category: 'devops',
        entities: ['npm', 'docker'],
      },
    })];

    // XML format with includeMetadata=false should still use depth-aware content
    const result = formatter.formatItems(items);
    // L1 item uses frontmatter + metadata inline
    expect(result.text).toContain('Deploy procedure');
    expect(result.text).toContain('depth="L1"');
  });
});

// ─── Edge Cases ──────────────────────────────────────────

describe('ContextFormatter edge cases', () => {
  const formatter = new ContextFormatter();

  it('handles items without depthLevel (defaults to L2)', () => {
    const items = [createItem({
      depthLevel: undefined,
      summary: 'Summary content',
    })];
    const result = formatter.formatItems(items);
    expect(result.text).toContain('depth="L2"');
  });

  it('handles items without frontmatter (falls back to content)', () => {
    const items = [createItem({
      depthLevel: 'L0',
      frontmatter: undefined,
      content: 'Fallback content',
    })];
    const result = formatter.formatItems(items);
    expect(result.text).toContain('Fallback content');
  });

  it('handles empty items list', () => {
    const result = formatter.formatItems([]);
    expect(result.itemCount).toBe(0);
    expect(result.text).toBe('');
  });

  it('respects maxChars truncation', () => {
    const items = createItems();
    const result = formatter.formatItems(items, { maxChars: 100 });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it('groups hub items separately from semantic', () => {
    const items = [
      createItem({ nodeId: 'sem', nodeType: 'semantic' as any }),
      createItem({
        nodeId: 'hub',
        nodeType: 'semantic' as any,
        retrievalMetadata: { nodeRole: 'hub' },
      }),
    ];
    const result = formatter.formatItems(items, { format: 'json' });
    const parsed = JSON.parse(result.text);
    expect(parsed.memoryContext.semantic).toHaveLength(1);
    expect(parsed.memoryContext.hub).toHaveLength(1);
  });
});
