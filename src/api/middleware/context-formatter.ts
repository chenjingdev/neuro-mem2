/**
 * Context Formatter — transforms RecallResult into structured text blocks
 * suitable for injection into LLM system prompts or message arrays.
 *
 * Supports multiple output formats:
 *   - 'xml': XML-tagged blocks (best for Claude/Anthropic)
 *   - 'markdown': Markdown sections (universal)
 *   - 'json': JSON structure (for programmatic consumption)
 *
 * Groups memory items by MemoryNode nodeType:
 *   semantic / episodic / procedural / prospective / emotional / hub
 *
 * Progressive depth (4-layer) support:
 *   L0 — frontmatter (one-line label)
 *   L1 — metadata (structured JSON: entities, category, SPO, etc.)
 *   L2 — summary (human-readable summary)
 *   L3 — sourceMessageIds (raw conversation references)
 *
 * The formatter selects display content based on the depthLevel field
 * present on each MergedMemoryItem.
 */

import type { MergedMemoryItem, DepthLevel } from '../../retrieval/types.js';
import type { RecallResult } from '../../retrieval/dual-path-retriever.js';
import type { MemoryNodeMetadata } from '../../models/memory-node.js';

// ─── Configuration ───────────────────────────────────────

export type ContextFormat = 'xml' | 'markdown' | 'json';

export interface ContextFormatterConfig {
  /** Output format (default: 'xml') */
  format: ContextFormat;
  /** Maximum total characters for the formatted context (default: 4000) */
  maxChars: number;
  /** Minimum score threshold — items below this are excluded (default: 0.0) */
  minScore: number;
  /** Maximum number of items to include (default: 15) */
  maxItems: number;
  /** Whether to include score values in the output (default: false) */
  includeScores: boolean;
  /** Whether to include retrieval source info (default: false) */
  includeSources: boolean;
  /** Whether to include L1 metadata in output when available (default: false) */
  includeMetadata: boolean;
  /** Custom header/preamble text (default: built-in preamble) */
  preamble?: string;
}

export const DEFAULT_FORMATTER_CONFIG: ContextFormatterConfig = {
  format: 'xml',
  maxChars: 4000,
  minScore: 0.0,
  maxItems: 15,
  includeScores: false,
  includeSources: false,
  includeMetadata: false,
};

// ─── Node type groups (MemoryNode 4-layer model) ─────────

/** All MemoryNode nodeType groups + hub role */
const NODE_TYPE_GROUPS = [
  'semantic', 'episodic', 'procedural', 'prospective', 'emotional', 'hub', 'other',
] as const;

type NodeTypeGroup = typeof NODE_TYPE_GROUPS[number];

interface GroupedMemoryItems {
  semantic: MergedMemoryItem[];
  episodic: MergedMemoryItem[];
  procedural: MergedMemoryItem[];
  prospective: MergedMemoryItem[];
  emotional: MergedMemoryItem[];
  hub: MergedMemoryItem[];
  other: MergedMemoryItem[];
}

// ─── Formatter Output ────────────────────────────────────

export interface FormattedContext {
  /** The formatted context string ready for injection */
  text: string;
  /** Number of items included */
  itemCount: number;
  /** Whether the output was truncated due to maxChars */
  truncated: boolean;
  /** The format used */
  format: ContextFormat;
}

// ─── ContextFormatter ────────────────────────────────────

export class ContextFormatter {
  private config: ContextFormatterConfig;

  constructor(config?: Partial<ContextFormatterConfig>) {
    this.config = { ...DEFAULT_FORMATTER_CONFIG, ...config };
  }

  /**
   * Format a RecallResult into a structured context string.
   */
  format(recallResult: RecallResult, config?: Partial<ContextFormatterConfig>): FormattedContext {
    return this.formatItems(recallResult.items, config);
  }

  /**
   * Format a list of MergedMemoryItems directly.
   */
  formatItems(items: MergedMemoryItem[], config?: Partial<ContextFormatterConfig>): FormattedContext {
    const cfg = { ...this.config, ...config };

    // Filter and limit items
    const filtered = items
      .filter(item => item.score >= cfg.minScore && item.content.trim().length > 0)
      .slice(0, cfg.maxItems);

    if (filtered.length === 0) {
      return { text: '', itemCount: 0, truncated: false, format: cfg.format };
    }

    // Group by MemoryNode type/role
    const grouped = groupByNodeType(filtered);

    // Format based on output format
    let text: string;
    switch (cfg.format) {
      case 'xml':
        text = formatXml(grouped, cfg);
        break;
      case 'markdown':
        text = formatMarkdown(grouped, cfg);
        break;
      case 'json':
        text = formatJson(grouped, cfg);
        break;
      default:
        text = formatXml(grouped, cfg);
    }

    // Apply character limit
    let truncated = false;
    if (text.length > cfg.maxChars) {
      text = truncateToLimit(text, cfg.maxChars, cfg.format);
      truncated = true;
    }

    return {
      text,
      itemCount: filtered.length,
      truncated,
      format: cfg.format,
    };
  }
}

// ─── Progressive Depth Content Selection ─────────────────

/**
 * Select the appropriate display content for an item based on its progressive depth level.
 *
 * L0 → frontmatter (one-line label)
 * L1 → frontmatter + metadata summary
 * L2 → summary text (or full content if no summary)
 * L3 → full content (with source references)
 */
function getDepthContent(item: MergedMemoryItem): string {
  const depth = item.depthLevel ?? 'L2';

  switch (depth) {
    case 'L0':
      return item.frontmatter ?? item.content;
    case 'L1': {
      const fm = item.frontmatter ?? item.content;
      if (item.nodeMetadata) {
        const metaSummary = formatMetadataInline(item.nodeMetadata);
        return metaSummary ? `${fm} — ${metaSummary}` : fm;
      }
      return fm;
    }
    case 'L2':
      return item.summary ?? item.content;
    case 'L3':
    default:
      return item.content;
  }
}

/**
 * Format L1 metadata into a compact inline string.
 */
function formatMetadataInline(meta: MemoryNodeMetadata): string {
  const parts: string[] = [];
  if (meta.category) parts.push(meta.category);
  if (meta.subject && meta.predicate && meta.object) {
    parts.push(`${meta.subject} ${meta.predicate} ${meta.object}`);
  }
  if (meta.entities?.length) parts.push(`entities: ${meta.entities.join(', ')}`);
  if (meta.emotion) parts.push(`emotion: ${meta.emotion}`);
  if (meta.priority) parts.push(`priority: ${meta.priority}`);
  if (meta.status) parts.push(`status: ${meta.status}`);
  return parts.join('; ');
}

// ─── Grouping ────────────────────────────────────────────

function groupByNodeType(items: MergedMemoryItem[]): GroupedMemoryItems {
  const grouped: GroupedMemoryItems = {
    semantic: [],
    episodic: [],
    procedural: [],
    prospective: [],
    emotional: [],
    hub: [],
    other: [],
  };

  for (const item of items) {
    // Check retrievalMetadata for nodeRole to identify hubs
    const nodeRole = item.retrievalMetadata?.nodeRole as string | undefined;
    if (nodeRole === 'hub') {
      grouped.hub.push(item);
      continue;
    }

    const nodeType = item.nodeType as string;
    switch (nodeType) {
      case 'semantic':  grouped.semantic.push(item);    break;
      case 'episodic':  grouped.episodic.push(item);    break;
      case 'procedural': grouped.procedural.push(item); break;
      case 'prospective': grouped.prospective.push(item); break;
      case 'emotional': grouped.emotional.push(item);   break;
      default:          grouped.other.push(item);        break;
    }
  }

  return grouped;
}

/** Display name for each node type group */
function groupDisplayName(group: NodeTypeGroup): string {
  switch (group) {
    case 'semantic':    return 'Semantic Knowledge';
    case 'episodic':    return 'Episodes';
    case 'procedural':  return 'Procedures';
    case 'prospective': return 'Plans & Intentions';
    case 'emotional':   return 'Emotional Context';
    case 'hub':         return 'Key Concepts (Hubs)';
    case 'other':       return 'Other';
  }
}

/** Singular XML tag for each node type group */
function singularTag(group: NodeTypeGroup): string {
  switch (group) {
    case 'semantic':    return 'knowledge';
    case 'episodic':    return 'episode';
    case 'procedural':  return 'procedure';
    case 'prospective': return 'plan';
    case 'emotional':   return 'emotion';
    case 'hub':         return 'hub';
    case 'other':       return 'memory';
  }
}

// ─── XML Format ──────────────────────────────────────────

function formatXml(grouped: GroupedMemoryItems, cfg: ContextFormatterConfig): string {
  const lines: string[] = [];
  const preamble = cfg.preamble ?? 'The following memory context was retrieved from previous conversations and may be relevant to the current query.';

  lines.push('<memory_context>');
  lines.push(`<preamble>${escapeXml(preamble)}</preamble>`);

  for (const group of NODE_TYPE_GROUPS) {
    const items = grouped[group];
    if (items.length === 0) continue;

    lines.push(`<${group}>`);
    for (const item of items) {
      const tag = singularTag(group);
      lines.push(formatXmlItem(item, tag, cfg));
    }
    lines.push(`</${group}>`);
  }

  lines.push('</memory_context>');
  return lines.join('\n');
}

function formatXmlItem(
  item: MergedMemoryItem,
  tag: string,
  cfg: ContextFormatterConfig,
): string {
  const attrs: string[] = [];
  const depth = item.depthLevel ?? 'L2';
  attrs.push(`depth="${depth}"`);
  if (cfg.includeScores) attrs.push(`score="${item.score.toFixed(3)}"`);
  if (cfg.includeSources) attrs.push(`sources="${item.sources.join(',')}"`);

  const attrStr = ' ' + attrs.join(' ');
  const displayContent = getDepthContent(item);

  // For L1+ with metadata, include structured metadata as child elements
  if (cfg.includeMetadata && item.nodeMetadata && (depth === 'L1' || depth === 'L2' || depth === 'L3')) {
    const metaLines: string[] = [];
    metaLines.push(`  <${tag}${attrStr}>`);
    metaLines.push(`    <text>${escapeXml(displayContent)}</text>`);
    metaLines.push(`    <metadata>`);
    if (item.nodeMetadata.entities?.length) {
      metaLines.push(`      <entities>${escapeXml(item.nodeMetadata.entities.join(', '))}</entities>`);
    }
    if (item.nodeMetadata.category) {
      metaLines.push(`      <category>${escapeXml(item.nodeMetadata.category)}</category>`);
    }
    if (item.nodeMetadata.subject && item.nodeMetadata.predicate && item.nodeMetadata.object) {
      metaLines.push(`      <spo>${escapeXml(item.nodeMetadata.subject)} ${escapeXml(item.nodeMetadata.predicate)} ${escapeXml(item.nodeMetadata.object)}</spo>`);
    }
    metaLines.push(`    </metadata>`);
    metaLines.push(`  </${tag}>`);
    return metaLines.join('\n');
  }

  return `  <${tag}${attrStr}>${escapeXml(displayContent)}</${tag}>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Markdown Format ─────────────────────────────────────

function formatMarkdown(grouped: GroupedMemoryItems, cfg: ContextFormatterConfig): string {
  const lines: string[] = [];
  const preamble = cfg.preamble ?? 'The following memory context was retrieved from previous conversations and may be relevant to the current query.';

  lines.push('## Memory Context');
  lines.push('');
  lines.push(preamble);
  lines.push('');

  for (const group of NODE_TYPE_GROUPS) {
    const items = grouped[group];
    if (items.length === 0) continue;

    lines.push(`### ${groupDisplayName(group)}`);
    for (const item of items) {
      lines.push(formatMarkdownItem(item, cfg));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatMarkdownItem(item: MergedMemoryItem, cfg: ContextFormatterConfig): string {
  const displayContent = getDepthContent(item);
  let suffix = '';
  const depth = item.depthLevel ?? 'L2';
  if (cfg.includeScores) suffix += ` (score: ${item.score.toFixed(3)})`;
  if (cfg.includeSources) suffix += ` [${item.sources.join(', ')}]`;
  suffix += ` \`${depth}\``;

  let line = `- ${displayContent}${suffix}`;

  // For L1+ with metadata, include key metadata inline
  if (cfg.includeMetadata && item.nodeMetadata) {
    const metaSummary = formatMetadataInline(item.nodeMetadata);
    if (metaSummary) line += `\n  > ${metaSummary}`;
  }

  return line;
}

// ─── JSON Format ─────────────────────────────────────────

function formatJson(grouped: GroupedMemoryItems, cfg: ContextFormatterConfig): string {
  const output: Record<string, unknown[]> = {};

  for (const group of NODE_TYPE_GROUPS) {
    const items = grouped[group];
    if (items.length === 0) continue;

    output[group] = items.map(item => {
      const depth = item.depthLevel ?? 'L2';
      const entry: Record<string, unknown> = {
        content: getDepthContent(item),
        depthLevel: depth,
        nodeType: item.nodeType,
      };
      if (item.frontmatter) entry.frontmatter = item.frontmatter;
      if (item.summary && depth !== 'L0') entry.summary = item.summary;
      if (cfg.includeScores) entry.score = item.score;
      if (cfg.includeSources) entry.sources = item.sources;
      if (cfg.includeMetadata && item.nodeMetadata) entry.metadata = item.nodeMetadata;
      return entry;
    });
  }

  return JSON.stringify({ memoryContext: output }, null, 2);
}

// ─── Truncation ──────────────────────────────────────────

function truncateToLimit(text: string, maxChars: number, format: ContextFormat): string {
  if (text.length <= maxChars) return text;

  // For XML, try to close the root tag cleanly
  if (format === 'xml') {
    const closingTag = '\n</memory_context>';
    const available = maxChars - closingTag.length;
    if (available > 0) {
      return text.slice(0, available) + closingTag;
    }
  }

  // For markdown, just truncate
  if (format === 'markdown') {
    const suffix = '\n\n*[Memory context truncated]*';
    const available = maxChars - suffix.length;
    if (available > 0) {
      return text.slice(0, available) + suffix;
    }
  }

  // Default: hard truncate
  return text.slice(0, maxChars);
}
