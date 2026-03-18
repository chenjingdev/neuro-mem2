/**
 * MemoryContextFormatter — transforms UnifiedRecallResult into structured
 * text blocks suitable for injection into LLM system prompts or context windows.
 *
 * Unlike the generic ContextFormatter (which works with MergedMemoryItem from
 * the old dual-path retriever), this formatter is designed specifically for the
 * unified brain-like retrieval pipeline:
 *
 *   1. Multi-level content: Uses Level 0 (frontmatter) / Level 1 (summary) /
 *      full content based on token budget and detail level
 *   2. Anchor association context: Shows which semantic anchors activated and
 *      how memories are connected through associative links
 *   3. Retrieval provenance: Distinguishes vector-matched vs BFS-expanded items
 *   4. Pipeline traceability: Optionally includes diagnostics for debugging
 *
 * Output formats:
 *   - 'xml': XML-tagged blocks (best for Claude/Anthropic models)
 *   - 'markdown': Markdown sections (universal, readable)
 *   - 'plain': Minimal plain text (lowest token overhead)
 *
 * Brain-like behavior: The formatter preserves anchor-association structure in
 * the output, so the LLM can see *why* a memory was recalled (through which
 * conceptual anchor) — enabling more contextual responses.
 */

import type { ScoredMemoryItem } from './types.js';
import type { AnchorMatch } from './vector-searcher.js';
import type {
  UnifiedRecallResult,
  UnifiedRecallDiagnostics,
  PipelineStage,
} from './unified-retriever.js';

// ─── Configuration ───────────────────────────────────────────────

export type MemoryContextFormat = 'xml' | 'markdown' | 'plain';

/** How much detail to include per memory item */
export type DetailLevel = 'frontmatter' | 'summary' | 'full' | 'adaptive';

export interface MemoryContextFormatterConfig {
  /** Output format (default: 'xml') */
  format: MemoryContextFormat;
  /** Maximum total characters for the formatted context (default: 4000) */
  maxChars: number;
  /** Minimum score threshold — items below this are excluded (default: 0.0) */
  minScore: number;
  /** Maximum number of memory items to include (default: 15) */
  maxItems: number;
  /** Content detail level per item (default: 'adaptive') */
  detailLevel: DetailLevel;
  /** Include relevance scores in output (default: false) */
  includeScores: boolean;
  /** Include retrieval source info (vector/graph/bfs) (default: false) */
  includeSources: boolean;
  /** Include activated anchor context (default: true) */
  includeAnchors: boolean;
  /** Include pipeline diagnostics (default: false — only for debugging) */
  includeDiagnostics: boolean;
  /** Custom preamble text (replaces default) */
  preamble?: string;
  /**
   * Character budget threshold for adaptive detail level.
   * When detailLevel='adaptive':
   *   - If total chars < adaptiveThreshold → use 'full'
   *   - If total chars < adaptiveThreshold * 2 → use 'summary'
   *   - Otherwise → use 'frontmatter'
   * Default: 2000
   */
  adaptiveThreshold: number;
}

export const DEFAULT_MEMORY_CONTEXT_CONFIG: MemoryContextFormatterConfig = {
  format: 'xml',
  maxChars: 4000,
  minScore: 0.0,
  maxItems: 15,
  detailLevel: 'adaptive',
  includeScores: false,
  includeSources: false,
  includeAnchors: true,
  includeDiagnostics: false,
  adaptiveThreshold: 2000,
};

// ─── Output Types ────────────────────────────────────────────────

export interface FormattedMemoryContext {
  /** The formatted context string ready for injection */
  text: string;
  /** Number of memory items included */
  itemCount: number;
  /** Number of anchors included */
  anchorCount: number;
  /** Whether the output was truncated due to maxChars */
  truncated: boolean;
  /** The format used */
  format: MemoryContextFormat;
  /** Effective detail level used (resolved from 'adaptive') */
  effectiveDetailLevel: DetailLevel;
}

// ─── Internal: enriched item with multi-level content ────────────

interface EnrichedItem {
  nodeId: string;
  nodeType: string;
  nodeRole?: string;
  score: number;
  source: string;
  content: string;
  frontmatter?: string;
  summary?: string;
  category?: string;
  /** Progressive depth level (L0/L1/L2/L3) */
  depthLevel: string;
  /** L1 structured metadata */
  nodeMetadata?: Record<string, unknown>;
  /** Anchor labels that led to this item */
  viaAnchors: string[];
  /** Whether this item was found via BFS expansion */
  bfsExpanded: boolean;
}

// ─── MemoryContextFormatter ──────────────────────────────────────

export class MemoryContextFormatter {
  readonly config: MemoryContextFormatterConfig;

  constructor(config?: Partial<MemoryContextFormatterConfig>) {
    this.config = { ...DEFAULT_MEMORY_CONTEXT_CONFIG, ...config };
  }

  /**
   * Format a UnifiedRecallResult into a structured context string.
   */
  format(
    recallResult: UnifiedRecallResult,
    config?: Partial<MemoryContextFormatterConfig>,
  ): FormattedMemoryContext {
    const cfg = { ...this.config, ...config };

    // Filter and limit items
    const filtered = recallResult.items
      .filter(item => item.score >= cfg.minScore && item.content.trim().length > 0)
      .slice(0, cfg.maxItems);

    if (filtered.length === 0) {
      return {
        text: '',
        itemCount: 0,
        anchorCount: 0,
        truncated: false,
        format: cfg.format,
        effectiveDetailLevel: cfg.detailLevel === 'adaptive' ? 'full' : cfg.detailLevel,
      };
    }

    // Enrich items with multi-level content and anchor provenance
    const enriched = enrichItems(filtered, recallResult.activatedAnchors);

    // Resolve adaptive detail level
    const effectiveDetail = resolveDetailLevel(enriched, cfg);

    // Format based on output format
    let text: string;
    switch (cfg.format) {
      case 'xml':
        text = formatXml(enriched, recallResult.activatedAnchors, recallResult.diagnostics, effectiveDetail, cfg);
        break;
      case 'markdown':
        text = formatMarkdown(enriched, recallResult.activatedAnchors, recallResult.diagnostics, effectiveDetail, cfg);
        break;
      case 'plain':
        text = formatPlain(enriched, recallResult.activatedAnchors, effectiveDetail, cfg);
        break;
      default:
        text = formatXml(enriched, recallResult.activatedAnchors, recallResult.diagnostics, effectiveDetail, cfg);
    }

    // Apply character limit
    let truncated = false;
    if (text.length > cfg.maxChars) {
      text = truncateToLimit(text, cfg.maxChars, cfg.format);
      truncated = true;
    }

    return {
      text,
      itemCount: enriched.length,
      anchorCount: cfg.includeAnchors ? recallResult.activatedAnchors.length : 0,
      truncated,
      format: cfg.format,
      effectiveDetailLevel: effectiveDetail,
    };
  }

  /**
   * Format raw scored items with anchor context (without full UnifiedRecallResult).
   * Useful when you have items from a partial pipeline or custom retrieval.
   */
  formatItems(
    items: ScoredMemoryItem[],
    anchors?: AnchorMatch[],
    config?: Partial<MemoryContextFormatterConfig>,
  ): FormattedMemoryContext {
    const result: UnifiedRecallResult = {
      items,
      activatedAnchors: anchors ?? [],
      diagnostics: {
        embeddingTimeMs: 0,
        anchorSearchTimeMs: 0,
        expansionTimeMs: 0,
        rerankTimeMs: 0,
        llmRerankTimeMs: 0,
        bfsExpansionTimeMs: 0,
        reinforceTimeMs: 0,
        totalTimeMs: 0,
        anchorsCompared: 0,
        anchorsMatched: anchors?.length ?? 0,
        nodesExpanded: items.length,
        bfsNodesAdded: 0,
        edgesReinforced: 0,
        stages: [],
      },
    };
    return this.format(result, config);
  }

  /**
   * Inject formatted memory context into a system prompt string.
   * Returns the modified system prompt.
   */
  injectIntoSystemPrompt(
    systemPrompt: string,
    recallResult: UnifiedRecallResult,
    position: 'prepend' | 'append' = 'prepend',
    config?: Partial<MemoryContextFormatterConfig>,
  ): { systemPrompt: string; context: FormattedMemoryContext } {
    const context = this.format(recallResult, config);

    if (context.itemCount === 0) {
      return { systemPrompt, context };
    }

    const separator = '\n\n';
    const modified = position === 'prepend'
      ? context.text + separator + systemPrompt
      : systemPrompt + separator + context.text;

    return { systemPrompt: modified, context };
  }

  /**
   * Inject formatted memory context into an OpenAI-style messages array.
   * Modifies or creates the system message.
   */
  injectIntoMessages(
    messages: Array<{ role: string; content: string; [key: string]: unknown }>,
    recallResult: UnifiedRecallResult,
    position: 'prepend' | 'append' = 'prepend',
    config?: Partial<MemoryContextFormatterConfig>,
  ): {
    messages: Array<{ role: string; content: string; [key: string]: unknown }>;
    context: FormattedMemoryContext;
  } {
    const context = this.format(recallResult, config);

    if (context.itemCount === 0) {
      return { messages, context };
    }

    const result = structuredClone(messages);
    const separator = '\n\n';

    const systemIdx = result.findIndex(m => m.role === 'system' || m.role === 'developer');
    if (systemIdx >= 0) {
      const existing = result[systemIdx].content;
      result[systemIdx] = {
        ...result[systemIdx],
        content: position === 'prepend'
          ? context.text + separator + existing
          : existing + separator + context.text,
      };
    } else {
      result.unshift({ role: 'system', content: context.text });
    }

    return { messages: result, context };
  }

  /**
   * Inject formatted memory context into an Anthropic-style request.
   * Modifies the top-level `system` field.
   */
  injectIntoAnthropicRequest(
    request: { system?: string; messages: Array<{ role: string; content: unknown }>; [key: string]: unknown },
    recallResult: UnifiedRecallResult,
    position: 'prepend' | 'append' = 'prepend',
    config?: Partial<MemoryContextFormatterConfig>,
  ): {
    request: { system?: string; messages: Array<{ role: string; content: unknown }>; [key: string]: unknown };
    context: FormattedMemoryContext;
  } {
    const context = this.format(recallResult, config);

    if (context.itemCount === 0) {
      return { request, context };
    }

    const result = structuredClone(request);
    const separator = '\n\n';

    const existing = typeof result.system === 'string' ? result.system : '';
    result.system = position === 'prepend'
      ? (existing ? context.text + separator + existing : context.text)
      : (existing ? existing + separator + context.text : context.text);

    return { request: result, context };
  }
}

// ─── Enrichment ──────────────────────────────────────────────────

/**
 * Enrich scored items with multi-level content and anchor provenance.
 * Extracts frontmatter/summary from retrievalMetadata if available.
 */
function enrichItems(
  items: ScoredMemoryItem[],
  anchors: AnchorMatch[],
): EnrichedItem[] {
  // Build a map of anchor IDs to labels for provenance tracking
  const anchorLabelMap = new Map<string, string>();
  for (const a of anchors) {
    anchorLabelMap.set(a.anchorId, a.label);
  }

  return items.map(item => {
    const meta = item.retrievalMetadata ?? {};

    // Extract multi-level content from metadata
    const frontmatter = typeof meta.frontmatter === 'string' ? meta.frontmatter : undefined;
    const summary = typeof meta.summary === 'string' ? meta.summary : undefined;
    const category = typeof meta.category === 'string' ? meta.category : undefined;

    // Extract anchor provenance
    const viaAnchors: string[] = [];
    if (typeof meta.sourceAnchorId === 'string') {
      const label = anchorLabelMap.get(meta.sourceAnchorId);
      if (label) viaAnchors.push(label);
    }
    if (Array.isArray(meta.sourceAnchors)) {
      for (const sa of meta.sourceAnchors) {
        if (typeof sa === 'object' && sa !== null) {
          const anchorObj = sa as Record<string, unknown>;
          const label = typeof anchorObj.label === 'string'
            ? anchorObj.label
            : anchorLabelMap.get(anchorObj.anchorId as string);
          if (label && !viaAnchors.includes(label)) {
            viaAnchors.push(label);
          }
        }
      }
    }

    const bfsExpanded = meta.bfsExpanded === true;

    // Extract progressive depth data
    const depthLevel = item.depthLevel ?? 'L2';
    const nodeMetadata = item.nodeMetadata as Record<string, unknown> | undefined;
    const nodeRole = typeof meta.nodeRole === 'string' ? meta.nodeRole : undefined;

    return {
      nodeId: item.nodeId,
      nodeType: item.nodeType,
      nodeRole,
      score: item.score,
      source: item.source,
      content: item.content,
      frontmatter,
      summary,
      category,
      depthLevel,
      nodeMetadata,
      viaAnchors,
      bfsExpanded,
    };
  });
}

// ─── Detail Level Resolution ─────────────────────────────────────

function resolveDetailLevel(
  items: EnrichedItem[],
  cfg: MemoryContextFormatterConfig,
): Exclude<DetailLevel, 'adaptive'> {
  if (cfg.detailLevel !== 'adaptive') {
    return cfg.detailLevel;
  }

  // Estimate total characters at full detail
  const totalFullChars = items.reduce((sum, item) => sum + item.content.length, 0);

  if (totalFullChars <= cfg.adaptiveThreshold) {
    return 'full';
  } else if (totalFullChars <= cfg.adaptiveThreshold * 2) {
    return 'summary';
  } else {
    return 'frontmatter';
  }
}

/**
 * Get the appropriate display content for an item based on detail level
 * and its progressive depth (L0/L1/L2/L3).
 *
 * Progressive depth governs what data is *available* on the item:
 *   L0 → only frontmatter
 *   L1 → frontmatter + metadata
 *   L2 → frontmatter + metadata + summary
 *   L3 → full content + source references
 *
 * Detail level governs what we *show*:
 *   'frontmatter' → always show just frontmatter
 *   'summary' → show summary (fall back to frontmatter)
 *   'full' → show full content
 *
 * The effective display is min(detailLevel, depthLevel).
 */
function getDisplayContent(
  item: EnrichedItem,
  level: Exclude<DetailLevel, 'adaptive'>,
): string {
  const depth = item.depthLevel;

  // If depth is L0, we can only show frontmatter regardless of detail level
  if (depth === 'L0') {
    return item.frontmatter ?? item.content;
  }

  // If depth is L1, we can show frontmatter + metadata inline, but not summary
  if (depth === 'L1') {
    const fm = item.frontmatter ?? item.content;
    if (level === 'frontmatter') return fm;
    // For summary/full with L1 depth, show frontmatter + metadata inline
    if (item.nodeMetadata) {
      const metaParts: string[] = [];
      const meta = item.nodeMetadata;
      if (meta.category) metaParts.push(String(meta.category));
      if (meta.entities && Array.isArray(meta.entities) && meta.entities.length > 0) {
        metaParts.push(`entities: ${meta.entities.join(', ')}`);
      }
      if (metaParts.length > 0) return `${fm} (${metaParts.join('; ')})`;
    }
    return fm;
  }

  // Depth L2/L3: full progressive depth available, use detail level
  switch (level) {
    case 'frontmatter':
      return item.frontmatter ?? item.summary ?? item.content;
    case 'summary':
      return item.summary ?? item.content;
    case 'full':
    default:
      return item.content;
  }
}

// ─── XML Format ──────────────────────────────────────────────────

function formatXml(
  items: EnrichedItem[],
  anchors: AnchorMatch[],
  diagnostics: UnifiedRecallDiagnostics,
  detailLevel: Exclude<DetailLevel, 'adaptive'>,
  cfg: MemoryContextFormatterConfig,
): string {
  const lines: string[] = [];
  const preamble = cfg.preamble ??
    'The following memories were recalled through associative anchor activation. ' +
    'These are not keyword-search results — they were retrieved because semantic anchors ' +
    'in your memory network were activated by the current context.';

  lines.push('<memory_context>');
  lines.push(`<preamble>${escapeXml(preamble)}</preamble>`);

  // Activated anchors section
  if (cfg.includeAnchors && anchors.length > 0) {
    lines.push('<activated_anchors>');
    for (const anchor of anchors) {
      const attrs: string[] = [`label="${escapeXml(anchor.label)}"`];
      if (cfg.includeScores) attrs.push(`similarity="${anchor.similarity.toFixed(3)}"`);
      lines.push(`  <anchor ${attrs.join(' ')} />`);
    }
    lines.push('</activated_anchors>');
  }

  // Group items by type
  const grouped = groupByType(items);

  for (const [groupName, groupItems] of Object.entries(grouped)) {
    if (groupItems.length === 0) continue;

    lines.push(`<${groupName}>`);
    for (const item of groupItems) {
      const tag = singularTag(groupName);
      const attrs = buildItemAttrs(item, cfg);
      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
      const displayContent = getDisplayContent(item, detailLevel);

      if (item.viaAnchors.length > 0 && cfg.includeAnchors) {
        lines.push(`  <${tag}${attrStr}>`);
        lines.push(`    <text>${escapeXml(displayContent)}</text>`);
        lines.push(`    <via_anchors>${escapeXml(item.viaAnchors.join(', '))}</via_anchors>`);
        lines.push(`  </${tag}>`);
      } else {
        lines.push(`  <${tag}${attrStr}>${escapeXml(displayContent)}</${tag}>`);
      }
    }
    lines.push(`</${groupName}>`);
  }

  // Optional diagnostics
  if (cfg.includeDiagnostics) {
    lines.push(formatDiagnosticsXml(diagnostics));
  }

  lines.push('</memory_context>');
  return lines.join('\n');
}

function formatDiagnosticsXml(diagnostics: UnifiedRecallDiagnostics): string {
  const lines: string[] = [];
  lines.push('<diagnostics>');
  lines.push(`  <total_time_ms>${diagnostics.totalTimeMs}</total_time_ms>`);
  lines.push(`  <anchors_matched>${diagnostics.anchorsMatched}</anchors_matched>`);
  lines.push(`  <nodes_expanded>${diagnostics.nodesExpanded}</nodes_expanded>`);
  if (diagnostics.bfsNodesAdded > 0) {
    lines.push(`  <bfs_nodes_added>${diagnostics.bfsNodesAdded}</bfs_nodes_added>`);
  }
  lines.push('  <pipeline>');
  for (const stage of diagnostics.stages) {
    lines.push(`    <stage name="${escapeXml(stage.name)}" status="${stage.status}" duration_ms="${stage.durationMs}" />`);
  }
  lines.push('  </pipeline>');
  lines.push('</diagnostics>');
  return lines.join('\n');
}

// ─── Markdown Format ─────────────────────────────────────────────

function formatMarkdown(
  items: EnrichedItem[],
  anchors: AnchorMatch[],
  diagnostics: UnifiedRecallDiagnostics,
  detailLevel: Exclude<DetailLevel, 'adaptive'>,
  cfg: MemoryContextFormatterConfig,
): string {
  const lines: string[] = [];
  const preamble = cfg.preamble ??
    'The following memories were recalled through associative anchor activation.';

  lines.push('## Memory Context');
  lines.push('');
  lines.push(preamble);
  lines.push('');

  // Activated anchors section
  if (cfg.includeAnchors && anchors.length > 0) {
    lines.push('**Activated anchors:** ' + anchors.map(a => {
      if (cfg.includeScores) return `${a.label} (${(a.similarity * 100).toFixed(0)}%)`;
      return a.label;
    }).join(', '));
    lines.push('');
  }

  // Group items by type
  const grouped = groupByType(items);

  for (const [groupName, groupItems] of Object.entries(grouped)) {
    if (groupItems.length === 0) continue;

    lines.push(`### ${groupDisplayName(groupName)}`);
    for (const item of groupItems) {
      const displayContent = getDisplayContent(item, detailLevel);
      let line = `- ${displayContent}`;

      const suffixes: string[] = [];
      suffixes.push(item.depthLevel);
      if (cfg.includeScores) suffixes.push(`score: ${item.score.toFixed(3)}`);
      if (cfg.includeSources) suffixes.push(item.bfsExpanded ? 'via BFS' : item.source);
      if (cfg.includeAnchors && item.viaAnchors.length > 0) {
        suffixes.push(`via: ${item.viaAnchors.join(', ')}`);
      }
      if (suffixes.length > 0) line += ` _(${suffixes.join(' | ')})_`;

      lines.push(line);
    }
    lines.push('');
  }

  // Optional diagnostics
  if (cfg.includeDiagnostics) {
    lines.push('---');
    lines.push(`_Pipeline: ${diagnostics.totalTimeMs}ms, ${diagnostics.anchorsMatched} anchors, ${diagnostics.nodesExpanded} nodes_`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Plain Text Format ───────────────────────────────────────────

function formatPlain(
  items: EnrichedItem[],
  anchors: AnchorMatch[],
  detailLevel: Exclude<DetailLevel, 'adaptive'>,
  cfg: MemoryContextFormatterConfig,
): string {
  const lines: string[] = [];

  const preamble = cfg.preamble ?? 'Recalled memories:';
  lines.push(preamble);
  lines.push('');

  // Anchor context (compact)
  if (cfg.includeAnchors && anchors.length > 0) {
    lines.push('Anchors: ' + anchors.map(a => a.label).join(', '));
    lines.push('');
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const displayContent = getDisplayContent(item, detailLevel);
    const typeLabel = capitalize(item.nodeType);

    let line = `[${i + 1}] (${typeLabel}/${item.depthLevel}) ${displayContent}`;

    if (cfg.includeScores) line += ` [${(item.score * 100).toFixed(0)}%]`;
    if (cfg.includeAnchors && item.viaAnchors.length > 0) {
      line += ` (via: ${item.viaAnchors.join(', ')})`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Group by MemoryNode nodeType (4-layer model).
 * Hub nodes are identified by nodeRole in retrievalMetadata.
 */
function groupByType(items: EnrichedItem[]): Record<string, EnrichedItem[]> {
  const groups: Record<string, EnrichedItem[]> = {
    semantic: [],
    episodic: [],
    procedural: [],
    prospective: [],
    emotional: [],
    hub: [],
    other: [],
  };

  for (const item of items) {
    // Check if this is a hub node (by nodeRole in metadata or bfs context)
    if (item.nodeType === 'hub' || item.nodeRole === 'hub') {
      groups.hub.push(item);
      continue;
    }

    switch (item.nodeType) {
      case 'semantic':    groups.semantic.push(item); break;
      case 'episodic':    groups.episodic.push(item); break;
      case 'procedural':  groups.procedural.push(item); break;
      case 'prospective': groups.prospective.push(item); break;
      case 'emotional':   groups.emotional.push(item); break;
      default:            groups.other.push(item); break;
    }
  }

  return groups;
}

/** Display name for progressive depth node type groups */
function groupDisplayName(groupName: string): string {
  switch (groupName) {
    case 'semantic':    return 'Semantic Knowledge';
    case 'episodic':    return 'Episodes';
    case 'procedural':  return 'Procedures';
    case 'prospective': return 'Plans & Intentions';
    case 'emotional':   return 'Emotional Context';
    case 'hub':         return 'Key Concepts (Hubs)';
    case 'other':       return 'Other';
    default:            return capitalize(groupName);
  }
}

function singularTag(groupName: string): string {
  switch (groupName) {
    case 'semantic':    return 'knowledge';
    case 'episodic':    return 'episode';
    case 'procedural':  return 'procedure';
    case 'prospective': return 'plan';
    case 'emotional':   return 'emotion';
    case 'hub':         return 'hub';
    case 'other':       return 'memory';
    default:            return 'item';
  }
}

function buildItemAttrs(item: EnrichedItem, cfg: MemoryContextFormatterConfig): string[] {
  const attrs: string[] = [];
  // Always include depth level for progressive depth visibility
  const depth = (item as unknown as Record<string, unknown>)['depthLevel'] ?? 'L2';
  attrs.push(`depth="${depth}"`);
  if (cfg.includeScores) attrs.push(`score="${item.score.toFixed(3)}"`);
  if (cfg.includeSources) attrs.push(`source="${item.bfsExpanded ? 'bfs' : item.source}"`);
  if (item.category) attrs.push(`category="${escapeXml(item.category)}"`);
  return attrs;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncateToLimit(text: string, maxChars: number, format: MemoryContextFormat): string {
  if (text.length <= maxChars) return text;

  if (format === 'xml') {
    const closingTag = '\n</memory_context>';
    const available = maxChars - closingTag.length;
    if (available > 0) return text.slice(0, available) + closingTag;
  }

  if (format === 'markdown') {
    const suffix = '\n\n*[Memory context truncated]*';
    const available = maxChars - suffix.length;
    if (available > 0) return text.slice(0, available) + suffix;
  }

  return text.slice(0, maxChars);
}
