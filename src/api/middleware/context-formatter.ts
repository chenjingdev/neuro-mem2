/**
 * Context Formatter — transforms RecallResult into structured text blocks
 * suitable for injection into LLM system prompts or message arrays.
 *
 * Supports multiple output formats:
 *   - 'xml': XML-tagged blocks (best for Claude/Anthropic)
 *   - 'markdown': Markdown sections (universal)
 *   - 'json': JSON structure (for programmatic consumption)
 *
 * The formatter groups memory items by type (fact, episode, concept)
 * and orders them by relevance score descending.
 */

import type { MergedMemoryItem } from '../../retrieval/types.js';
import type { RecallResult } from '../../retrieval/dual-path-retriever.js';

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
};

// ─── Grouped Items ───────────────────────────────────────

interface GroupedMemoryItems {
  facts: MergedMemoryItem[];
  episodes: MergedMemoryItem[];
  concepts: MergedMemoryItem[];
  others: MergedMemoryItem[];
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

    // Group by type
    const grouped = groupByType(filtered);

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

// ─── Grouping ────────────────────────────────────────────

function groupByType(items: MergedMemoryItem[]): GroupedMemoryItems {
  const grouped: GroupedMemoryItems = {
    facts: [],
    episodes: [],
    concepts: [],
    others: [],
  };

  for (const item of items) {
    switch (item.nodeType) {
      case 'fact':
        grouped.facts.push(item);
        break;
      case 'episode':
        grouped.episodes.push(item);
        break;
      case 'concept':
        grouped.concepts.push(item);
        break;
      default:
        grouped.others.push(item);
    }
  }

  return grouped;
}

// ─── XML Format ──────────────────────────────────────────

function formatXml(grouped: GroupedMemoryItems, cfg: ContextFormatterConfig): string {
  const lines: string[] = [];
  const preamble = cfg.preamble ?? 'The following memory context was retrieved from previous conversations and may be relevant to the current query.';

  lines.push('<memory_context>');
  lines.push(`<preamble>${escapeXml(preamble)}</preamble>`);

  if (grouped.facts.length > 0) {
    lines.push('<facts>');
    for (const item of grouped.facts) {
      lines.push(formatXmlItem(item, 'fact', cfg));
    }
    lines.push('</facts>');
  }

  if (grouped.episodes.length > 0) {
    lines.push('<episodes>');
    for (const item of grouped.episodes) {
      lines.push(formatXmlItem(item, 'episode', cfg));
    }
    lines.push('</episodes>');
  }

  if (grouped.concepts.length > 0) {
    lines.push('<concepts>');
    for (const item of grouped.concepts) {
      lines.push(formatXmlItem(item, 'concept', cfg));
    }
    lines.push('</concepts>');
  }

  if (grouped.others.length > 0) {
    lines.push('<other>');
    for (const item of grouped.others) {
      lines.push(formatXmlItem(item, 'memory', cfg));
    }
    lines.push('</other>');
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
  if (cfg.includeScores) attrs.push(`score="${item.score.toFixed(3)}"`);
  if (cfg.includeSources) attrs.push(`sources="${item.sources.join(',')}"`);

  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  return `<${tag}${attrStr}>${escapeXml(item.content)}</${tag}>`;
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

  if (grouped.facts.length > 0) {
    lines.push('### Facts');
    for (const item of grouped.facts) {
      lines.push(formatMarkdownItem(item, cfg));
    }
    lines.push('');
  }

  if (grouped.episodes.length > 0) {
    lines.push('### Episodes');
    for (const item of grouped.episodes) {
      lines.push(formatMarkdownItem(item, cfg));
    }
    lines.push('');
  }

  if (grouped.concepts.length > 0) {
    lines.push('### Concepts');
    for (const item of grouped.concepts) {
      lines.push(formatMarkdownItem(item, cfg));
    }
    lines.push('');
  }

  if (grouped.others.length > 0) {
    lines.push('### Other');
    for (const item of grouped.others) {
      lines.push(formatMarkdownItem(item, cfg));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatMarkdownItem(item: MergedMemoryItem, cfg: ContextFormatterConfig): string {
  let suffix = '';
  if (cfg.includeScores) suffix += ` (score: ${item.score.toFixed(3)})`;
  if (cfg.includeSources) suffix += ` [${item.sources.join(', ')}]`;
  return `- ${item.content}${suffix}`;
}

// ─── JSON Format ─────────────────────────────────────────

function formatJson(grouped: GroupedMemoryItems, cfg: ContextFormatterConfig): string {
  const output: Record<string, unknown[]> = {};

  for (const [key, items] of Object.entries(grouped)) {
    if ((items as MergedMemoryItem[]).length > 0) {
      output[key] = (items as MergedMemoryItem[]).map(item => {
        const entry: Record<string, unknown> = { content: item.content };
        if (cfg.includeScores) entry.score = item.score;
        if (cfg.includeSources) entry.sources = item.sources;
        return entry;
      });
    }
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
