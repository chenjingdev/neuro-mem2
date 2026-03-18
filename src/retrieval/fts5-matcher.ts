/**
 * FTS5 Keyword Match — standalone FTS5 keyword matching with BM25 scoring.
 *
 * Provides a reusable function to execute search queries against the
 * memory_nodes_fts virtual table and return normalized keyword match scores.
 *
 * Features:
 * - BM25 column weighting: frontmatter:2, keywords:10, summary:1
 * - Korean/English mixed query support (한영 혼용)
 * - Score normalization to [0, 1] range
 * - Multiple match modes: OR (broad recall), AND (precision)
 * - Column-targeted search (keywords-only, frontmatter-only, etc.)
 * - Optional node type/role filtering
 * - Designed for 수십만 노드 scale (FTS5 inverted index is sub-ms)
 *
 * Usage:
 *   const matcher = new Fts5Matcher(db);
 *   const results = matcher.match("TypeScript 마이그레이션");
 *   // results: [{ id, rawRank, normalizedScore }, ...]
 */

import type Database from 'better-sqlite3';
import {
  buildFtsMatchQuery,
  buildColumnFtsQuery,
} from '../utils/keyword-normalizer.js';
import type {
  MemoryNodeType,
  MemoryNodeRole,
  MemoryNodeTypeNullable,
} from '../models/memory-node.js';

// ─── BM25 Column Weights ────────────────────────────────────────
// These weights determine the relative importance of each FTS5 column
// in the BM25 scoring formula. Keywords get the highest weight because
// they are pre-normalized search anchors extracted during ingestion.

/** BM25 weight for frontmatter column (node label) */
export const BM25_WEIGHT_FRONTMATTER = 2.0;

/** BM25 weight for keywords column (normalized search terms) */
export const BM25_WEIGHT_KEYWORDS = 10.0;

/** BM25 weight for summary column (human-readable summary) */
export const BM25_WEIGHT_SUMMARY = 1.0;

// ─── Result Types ───────────────────────────────────────────────

/**
 * A single FTS5 keyword match result with scoring information.
 */
export interface Fts5MatchResult {
  /** Memory node ID */
  id: string;
  /**
   * Raw BM25 rank from FTS5 (negative; more negative = better match).
   * This is the native SQLite bm25() output.
   */
  rawRank: number;
  /**
   * Normalized score in [0, 1] range.
   * 1.0 = best match in the result set, 0.0 = worst match.
   * When only one result, score is 1.0.
   */
  normalizedScore: number;
}

/**
 * Options for FTS5 keyword matching.
 */
export interface Fts5MatchOptions {
  /** Maximum results to return. Default: 200 */
  limit?: number;
  /** Match mode: 'or' for broad recall, 'and' for precision. Default: 'or' */
  mode?: 'or' | 'and';
  /** Target specific column(s). Default: all columns */
  column?: 'frontmatter' | 'keywords' | 'summary';
  /** Filter by node type(s) */
  nodeType?: MemoryNodeTypeNullable | MemoryNodeTypeNullable[];
  /** Filter by node role */
  nodeRole?: MemoryNodeRole;
  /**
   * Custom BM25 column weights [frontmatter, keywords, summary].
   * Default: [2.0, 10.0, 1.0]
   */
  bm25Weights?: [number, number, number];
  /**
   * Minimum normalized score threshold [0, 1].
   * Results below this score are excluded.
   * Default: 0 (no threshold — return all matches)
   */
  minScore?: number;
}

// ─── Fts5Matcher Class ──────────────────────────────────────────

/**
 * Executes FTS5 keyword match queries against memory_nodes_fts
 * and returns normalized BM25 scores.
 *
 * Thread-safe: uses only read queries.
 * Scale: sub-ms at 수십만 nodes (FTS5 inverted index).
 */
export class Fts5Matcher {
  constructor(private db: Database.Database) {}

  /**
   * Execute an FTS5 keyword match query and return scored results.
   *
   * @param query - Natural language search query (한영 혼용 지원)
   * @param options - Match options (limit, mode, column, filters)
   * @returns Array of Fts5MatchResult sorted by score descending
   *
   * @example
   * // Broad search across all columns
   * matcher.match("React 컴포넌트 설계")
   *
   * @example
   * // Precise keyword-only search
   * matcher.match("typescript migration", { column: 'keywords', mode: 'and' })
   *
   * @example
   * // Filtered by node type
   * matcher.match("API 설계", { nodeType: 'semantic', limit: 50 })
   */
  match(query: string, options?: Fts5MatchOptions): Fts5MatchResult[] {
    if (!query || !query.trim()) return [];

    const opts = options ?? {};
    const limit = opts.limit ?? 200;
    const mode = opts.mode ?? 'or';
    const bm25Weights = opts.bm25Weights ?? [
      BM25_WEIGHT_FRONTMATTER,
      BM25_WEIGHT_KEYWORDS,
      BM25_WEIGHT_SUMMARY,
    ];

    // Build the FTS5 MATCH expression
    let matchExpr: string | null;
    if (opts.column) {
      matchExpr = buildColumnFtsQuery(opts.column, query);
    } else {
      matchExpr = buildFtsMatchQuery(query, mode);
    }

    if (!matchExpr) return [];

    // Build the SQL query with optional filters
    const { sql, params } = this.buildFilteredQuery(
      matchExpr,
      bm25Weights,
      limit,
      opts,
    );

    // Execute
    const rows = this.db.prepare(sql).all(...params) as {
      id: string;
      rank: number;
    }[];

    if (rows.length === 0) return [];

    // Normalize ranks to [0, 1]
    return normalizeRanks(rows, opts.minScore);
  }

  /**
   * Get the raw BM25 rank for a specific node against a query.
   * Useful for scoring a single known node without a full search.
   *
   * @param nodeId - The memory node ID to score
   * @param query - The search query
   * @returns Raw BM25 rank (negative, more negative = better), or null if no match
   */
  matchOne(nodeId: string, query: string): number | null {
    if (!query || !query.trim()) return null;

    const matchExpr = buildFtsMatchQuery(query, 'or');
    if (!matchExpr) return null;

    const row = this.db.prepare(`
      SELECT bm25(memory_nodes_fts, ${BM25_WEIGHT_FRONTMATTER}, ${BM25_WEIGHT_KEYWORDS}, ${BM25_WEIGHT_SUMMARY}) AS rank
      FROM memory_nodes_fts fts
      JOIN memory_nodes mn ON mn.rowid = fts.rowid
      WHERE memory_nodes_fts MATCH ?
        AND mn.id = ?
    `).get(matchExpr, nodeId) as { rank: number } | undefined;

    return row?.rank ?? null;
  }

  /**
   * Batch match: score multiple node IDs against a query.
   * Returns a Map of nodeId → normalizedScore for matched nodes.
   * Nodes that don't match the query are omitted from the result.
   *
   * @param nodeIds - Array of node IDs to score
   * @param query - The search query
   * @returns Map of nodeId → normalizedScore [0, 1]
   */
  matchBatch(nodeIds: string[], query: string): Map<string, number> {
    if (nodeIds.length === 0 || !query || !query.trim()) return new Map();

    const matchExpr = buildFtsMatchQuery(query, 'or');
    if (!matchExpr) return new Map();

    const placeholders = nodeIds.map(() => '?').join(',');

    const rows = this.db.prepare(`
      SELECT mn.id, bm25(memory_nodes_fts, ${BM25_WEIGHT_FRONTMATTER}, ${BM25_WEIGHT_KEYWORDS}, ${BM25_WEIGHT_SUMMARY}) AS rank
      FROM memory_nodes_fts fts
      JOIN memory_nodes mn ON mn.rowid = fts.rowid
      WHERE memory_nodes_fts MATCH ?
        AND mn.id IN (${placeholders})
      ORDER BY rank
    `).all(matchExpr, ...nodeIds) as { id: string; rank: number }[];

    if (rows.length === 0) return new Map();

    const results = normalizeRanks(rows);
    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r.id, r.normalizedScore);
    }
    return map;
  }

  /**
   * Count the number of FTS5 matches for a query (without fetching rows).
   * Useful for estimating result set size before executing full search.
   */
  countMatches(query: string, options?: Pick<Fts5MatchOptions, 'column' | 'mode'>): number {
    if (!query || !query.trim()) return 0;

    const mode = options?.mode ?? 'or';
    let matchExpr: string | null;
    if (options?.column) {
      matchExpr = buildColumnFtsQuery(options.column, query);
    } else {
      matchExpr = buildFtsMatchQuery(query, mode);
    }
    if (!matchExpr) return 0;

    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM memory_nodes_fts
      WHERE memory_nodes_fts MATCH ?
    `).get(matchExpr) as { cnt: number };

    return row.cnt;
  }

  // ─── Internal: SQL Builder ──────────────────────────────────────

  private buildFilteredQuery(
    matchExpr: string,
    bm25Weights: [number, number, number],
    limit: number,
    opts: Fts5MatchOptions,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [matchExpr];
    const conditions: string[] = [];

    // Node type filter
    if (opts.nodeType !== undefined) {
      if (Array.isArray(opts.nodeType)) {
        const nonNull = opts.nodeType.filter(
          (t): t is MemoryNodeType => t !== null,
        );
        const hasNull = opts.nodeType.includes(null);
        const parts: string[] = [];
        if (nonNull.length > 0) {
          const ph = nonNull.map(() => '?').join(',');
          parts.push(`mn.node_type IN (${ph})`);
          params.push(...nonNull);
        }
        if (hasNull) parts.push('mn.node_type IS NULL');
        if (parts.length > 0) conditions.push(`(${parts.join(' OR ')})`);
      } else if (opts.nodeType === null) {
        conditions.push('mn.node_type IS NULL');
      } else {
        conditions.push('mn.node_type = ?');
        params.push(opts.nodeType);
      }
    }

    // Node role filter
    if (opts.nodeRole) {
      conditions.push('mn.node_role = ?');
      params.push(opts.nodeRole);
    }

    const whereExtra =
      conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    params.push(limit);

    const sql = `
      SELECT mn.id, bm25(memory_nodes_fts, ${bm25Weights[0]}, ${bm25Weights[1]}, ${bm25Weights[2]}) AS rank
      FROM memory_nodes_fts fts
      JOIN memory_nodes mn ON mn.rowid = fts.rowid
      WHERE memory_nodes_fts MATCH ?
      ${whereExtra}
      ORDER BY rank
      LIMIT ?
    `;

    return { sql, params };
  }
}

// ─── Pure Helper Functions (exported for testing) ────────────────

/**
 * Normalize an array of FTS5 BM25 ranks to [0, 1] range.
 *
 * FTS5 bm25() returns negative values where more negative = better match.
 * This function maps them to [0, 1] where 1.0 = best, 0.0 = worst.
 *
 * When all ranks are identical (single result or all same score),
 * all normalized scores become 1.0.
 *
 * @param rows - Raw FTS5 results with { id, rank }
 * @param minScore - Optional minimum score threshold (filter out below)
 * @returns Fts5MatchResult[] sorted by normalizedScore descending
 */
export function normalizeRanks(
  rows: { id: string; rank: number }[],
  minScore?: number,
): Fts5MatchResult[] {
  if (rows.length === 0) return [];

  // Find rank range for normalization
  let minRank = Infinity; // most negative = best
  let maxRank = -Infinity; // least negative = worst
  for (const r of rows) {
    if (r.rank < minRank) minRank = r.rank;
    if (r.rank > maxRank) maxRank = r.rank;
  }

  const range = maxRank - minRank;

  const results: Fts5MatchResult[] = [];
  for (const r of rows) {
    const normalizedScore =
      range === 0 ? 1.0 : round4((maxRank - r.rank) / range);

    if (minScore != null && normalizedScore < minScore) continue;

    results.push({
      id: r.id,
      rawRank: r.rank,
      normalizedScore,
    });
  }

  // Sort by normalizedScore descending (best first)
  results.sort((a, b) => b.normalizedScore - a.normalizedScore);
  return results;
}

// ─── Internal Utilities ──────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
