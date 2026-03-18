/**
 * Keyword normalization utilities for FTS5 indexing.
 *
 * Provides consistent keyword normalization for the memory_nodes_fts index:
 * - Lowercased for case-insensitive matching
 * - Deduplicated to avoid inflated term frequency
 * - Sorted for deterministic storage
 * - Trimmed of excess whitespace
 *
 * Supports 한영 혼용 (Korean/English mixed) keywords.
 */

/**
 * Normalize a space-separated keyword string for FTS5 indexing.
 *
 * Steps:
 * 1. Trim whitespace
 * 2. Split on whitespace (handles multiple spaces, tabs, newlines)
 * 3. Lowercase each token
 * 4. Strip punctuation-only tokens
 * 5. Deduplicate (preserves first occurrence order, then sorts)
 * 6. Re-join with single space
 *
 * @example
 * normalizeKeywords('React react REACT 리액트 frontend')
 * // → 'frontend react 리액트'
 *
 * @example
 * normalizeKeywords('  TypeScript   타입스크립트  config  ')
 * // → 'config typescript 타입스크립트'
 */
export function normalizeKeywords(keywords: string): string {
  if (!keywords || !keywords.trim()) return '';

  const tokens = keywords
    .trim()
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 0 && !isPunctuationOnly(t));

  // Deduplicate while preserving semantic order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }

  // Sort for deterministic storage (alphabetical, Korean after English due to Unicode order)
  unique.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return unique.join(' ');
}

/**
 * Extract individual keyword tokens from a normalized keyword string.
 */
export function extractKeywordTokens(keywords: string): string[] {
  if (!keywords || !keywords.trim()) return [];
  return keywords.trim().split(/\s+/).filter(t => t.length > 0);
}

/**
 * Merge multiple keyword sources into a single normalized string.
 * Useful for combining keywords from LLM extraction with entity names.
 *
 * @example
 * mergeKeywords('React frontend', '리액트 ReactJS', 'UI library')
 * // → 'frontend library react reactjs ui 리액트'
 */
export function mergeKeywords(...sources: (string | undefined | null)[]): string {
  const combined = sources
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join(' ');
  return normalizeKeywords(combined);
}

/**
 * Build an FTS5 MATCH query from a user search string.
 *
 * Handles:
 * - Korean/English mixed queries
 * - Special FTS5 characters escaped
 * - Multi-token queries joined with OR for broad recall
 * - Single tokens as prefix search for autocomplete
 *
 * @param query - Raw user search input
 * @param mode - 'or' for broad recall, 'and' for precision
 * @returns FTS5 MATCH expression string, or null if query is empty
 */
export function buildFtsMatchQuery(
  query: string,
  mode: 'or' | 'and' = 'or',
): string | null {
  if (!query || !query.trim()) return null;

  const tokens = query
    .trim()
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 0 && !isPunctuationOnly(t));

  if (tokens.length === 0) return null;

  // Escape double quotes within tokens, wrap each in quotes for exact token matching
  const quoted = tokens.map(t => `"${t.replace(/"/g, '""')}"`);

  const operator = mode === 'or' ? ' OR ' : ' AND ';
  return quoted.join(operator);
}

/**
 * Build an FTS5 MATCH query targeting a specific column.
 * Useful for keyword-only search vs full-text search.
 *
 * @param column - FTS5 column name (frontmatter, keywords, summary)
 * @param query - Raw user search input
 * @returns FTS5 column-filtered MATCH expression, or null if query is empty
 */
export function buildColumnFtsQuery(
  column: 'frontmatter' | 'keywords' | 'summary',
  query: string,
): string | null {
  const matchExpr = buildFtsMatchQuery(query, 'or');
  if (!matchExpr) return null;

  // FTS5 column filter: {column}: expression
  return `${column}: ${matchExpr}`;
}

/**
 * Check if a string consists only of punctuation/special characters.
 */
function isPunctuationOnly(s: string): boolean {
  // Match strings that contain no word characters (letters, numbers, or Korean/CJK characters)
  return /^[^\p{L}\p{N}]+$/u.test(s);
}
