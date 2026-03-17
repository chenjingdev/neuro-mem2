/**
 * Memory Retrieval Bridge — connects parsed proxy requests to Dual-path retrieval.
 *
 * Responsibilities:
 *   1. Takes a ParsedRequest (from request-parser) and extracts the query text
 *   2. Calls DualPathRetriever.recall() with the query
 *   3. Formats retrieved memory items into injectable context blocks
 *   4. Returns formatted context ready for injection into the LLM request
 *
 * This bridge is the glue between the proxy layer and the memory retrieval engine.
 * It does NOT modify the original request — context injection is handled separately.
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import {
  DualPathRetriever,
  type DualPathRetrieverConfig,
  type RecallResult,
} from '../retrieval/dual-path-retriever.js';
import type { MergedMemoryItem } from '../retrieval/types.js';
import type { ParsedRequest } from './request-parser.js';

// ─── Configuration ───────────────────────────────────────

export interface MemoryBridgeConfig {
  /** Dual-path retriever configuration overrides */
  retrieverConfig?: Partial<DualPathRetrieverConfig>;
  /** Maximum number of memory items to include in context */
  maxContextItems?: number;
  /** Minimum score threshold for inclusion (overrides retriever's minScore) */
  minContextScore?: number;
  /** Maximum total character length for injected context */
  maxContextChars?: number;
  /** Format template for individual memory items */
  itemFormat?: 'plain' | 'structured' | 'xml';
  /** Whether to include retrieval diagnostics in the result */
  includeDiagnostics?: boolean;
  /** Whether to skip retrieval when no user message found */
  skipOnNoQuery?: boolean;
}

export const DEFAULT_BRIDGE_CONFIG: MemoryBridgeConfig = {
  maxContextItems: 15,
  minContextScore: 0.05,
  maxContextChars: 4000,
  itemFormat: 'xml',
  includeDiagnostics: false,
  skipOnNoQuery: true,
};

// ─── Context Result ──────────────────────────────────────

/** A formatted memory context block ready for injection */
export interface MemoryContextBlock {
  /** Formatted text content for injection */
  text: string;
  /** Number of memory items included */
  itemCount: number;
  /** Total character length of the formatted context */
  charCount: number;
  /** The query text used for retrieval */
  queryText: string;
  /** Individual items with their scores (for debugging) */
  items: ContextItem[];
}

/** A single memory item formatted for context */
export interface ContextItem {
  nodeId: string;
  nodeType: string;
  score: number;
  content: string;
  sources: string[];
}

/** Full result of the memory retrieval bridge */
export interface MemoryBridgeResult {
  /** Whether retrieval was performed */
  retrieved: boolean;
  /** The formatted context block (null if not retrieved or no results) */
  context: MemoryContextBlock | null;
  /** Retrieval diagnostics (if includeDiagnostics is true) */
  diagnostics: RecallResult['diagnostics'] | null;
  /** Time taken for the entire bridge operation (ms) */
  bridgeTimeMs: number;
  /** Reason if retrieval was skipped */
  skipReason: string | null;
}

// ─── Memory Retrieval Bridge ─────────────────────────────

export class MemoryRetrievalBridge {
  private retriever: DualPathRetriever;
  private config: MemoryBridgeConfig;

  constructor(
    db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    config?: Partial<MemoryBridgeConfig>,
  ) {
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
    this.retriever = new DualPathRetriever(
      db,
      embeddingProvider,
      this.config.retrieverConfig,
    );
  }

  /**
   * Retrieve memory context for an intercepted request.
   *
   * Flow:
   *   1. Extract query text from ParsedRequest
   *   2. Call DualPathRetriever.recall()
   *   3. Filter and format results
   *   4. Return formatted context block
   */
  async retrieve(parsedRequest: ParsedRequest): Promise<MemoryBridgeResult> {
    const start = performance.now();

    // Check if we have a query to work with
    const queryText = parsedRequest.latestUserMessage;

    // No user message at all (null)
    if (queryText === null || queryText === undefined) {
      return {
        retrieved: false,
        context: null,
        diagnostics: null,
        bridgeTimeMs: round2(performance.now() - start),
        skipReason: 'no_user_message',
      };
    }

    // User message exists but is empty or whitespace-only
    const query = queryText.trim();
    if (query.length === 0) {
      return {
        retrieved: false,
        context: null,
        diagnostics: null,
        bridgeTimeMs: round2(performance.now() - start),
        skipReason: 'empty_query',
      };
    }

    // Execute dual-path retrieval
    const recallResult = await this.retriever.recall({
      queryText: query,
      config: this.config.retrieverConfig,
    });

    // Filter by minimum score
    const minScore = this.config.minContextScore ?? 0.05;
    let items = recallResult.items.filter(item => item.score >= minScore);

    // Limit number of items
    const maxItems = this.config.maxContextItems ?? 15;
    items = items.slice(0, maxItems);

    // Format context block
    const contextBlock = this.formatContextBlock(items, query);

    // Truncate if exceeding max chars
    const maxChars = this.config.maxContextChars ?? 4000;
    const truncated = this.truncateContext(contextBlock, items, query, maxChars);

    return {
      retrieved: true,
      context: truncated,
      diagnostics: this.config.includeDiagnostics ? recallResult.diagnostics : null,
      bridgeTimeMs: round2(performance.now() - start),
      skipReason: null,
    };
  }

  /**
   * Retrieve memory context directly from a query string.
   * Convenience method when you already have the query text.
   */
  async retrieveByQuery(queryText: string): Promise<MemoryBridgeResult> {
    const pseudoRequest: ParsedRequest = {
      format: 'generic',
      messages: [{ role: 'user', content: queryText, index: 0 }],
      latestUserMessage: queryText,
      systemPrompt: null,
      model: null,
      stream: false,
      rawBody: null,
    };
    return this.retrieve(pseudoRequest);
  }

  // ── Formatting ──

  private formatContextBlock(
    items: MergedMemoryItem[],
    queryText: string,
  ): MemoryContextBlock {
    const format = this.config.itemFormat ?? 'xml';
    const contextItems = items.map(item => this.toContextItem(item));

    let text: string;
    switch (format) {
      case 'xml':
        text = this.formatXml(contextItems);
        break;
      case 'structured':
        text = this.formatStructured(contextItems);
        break;
      case 'plain':
      default:
        text = this.formatPlain(contextItems);
        break;
    }

    return {
      text,
      itemCount: contextItems.length,
      charCount: text.length,
      queryText,
      items: contextItems,
    };
  }

  private toContextItem(item: MergedMemoryItem): ContextItem {
    return {
      nodeId: item.nodeId,
      nodeType: item.nodeType,
      score: item.score,
      content: item.content,
      sources: item.sources,
    };
  }

  private formatXml(items: ContextItem[]): string {
    if (items.length === 0) return '';

    const lines = ['<memory-context>'];
    for (const item of items) {
      lines.push(`  <memory type="${item.nodeType}" score="${item.score.toFixed(2)}">`);
      lines.push(`    ${escapeXml(item.content)}`);
      lines.push('  </memory>');
    }
    lines.push('</memory-context>');
    return lines.join('\n');
  }

  private formatStructured(items: ContextItem[]): string {
    if (items.length === 0) return '';

    const lines = ['[Memory Context]'];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      lines.push(`[${i + 1}] (${item.nodeType}, score=${item.score.toFixed(2)}) ${item.content}`);
    }
    return lines.join('\n');
  }

  private formatPlain(items: ContextItem[]): string {
    if (items.length === 0) return '';
    return items.map(item => item.content).join('\n');
  }

  private truncateContext(
    block: MemoryContextBlock,
    items: MergedMemoryItem[],
    queryText: string,
    maxChars: number,
  ): MemoryContextBlock {
    if (block.charCount <= maxChars) return block;

    // Progressively remove lowest-scored items until within limit
    let truncatedItems = [...items];
    while (truncatedItems.length > 0) {
      truncatedItems = truncatedItems.slice(0, -1);
      const newBlock = this.formatContextBlock(truncatedItems, queryText);
      if (newBlock.charCount <= maxChars) return newBlock;
    }

    // If even empty is too long (shouldn't happen), return empty
    return {
      text: '',
      itemCount: 0,
      charCount: 0,
      queryText,
      items: [],
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
