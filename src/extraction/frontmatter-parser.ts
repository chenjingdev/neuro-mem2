/**
 * Frontmatter Parser — parses and validates LLM responses for Level 0 frontmatter
 * and Level 1 summary generation.
 *
 * Handles:
 * - JSON extraction from potentially noisy LLM output
 * - Schema validation with sensible defaults
 * - Graceful fallback for malformed responses
 * - Both single-fact and batch response formats
 */

import type { FactFrontmatter, FrontmatterResult } from './frontmatter-prompt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FrontmatterParseResult =
  | { ok: true; result: FrontmatterResult }
  | { ok: false; error: string; rawContent: string };

export type BatchFrontmatterParseResult =
  | { ok: true; results: FrontmatterResult[] }
  | { ok: false; error: string; rawContent: string };

// ---------------------------------------------------------------------------
// JSON extraction (reused pattern from fact-parser.ts)
// ---------------------------------------------------------------------------

function extractJSON(raw: string): string {
  const trimmed = raw.trim();

  // Try markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }

  // Find JSON object or array
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');

  // If array starts before object, extract the array
  if (bracketStart !== -1 && bracketEnd > bracketStart &&
      (braceStart === -1 || bracketStart < braceStart)) {
    return trimmed.slice(bracketStart, bracketEnd + 1);
  }

  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  return trimmed;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'preference', 'technical', 'requirement', 'decision',
  'context', 'instruction', 'knowledge', 'relationship', 'other',
]);

const VALID_IMPORTANCE = new Set(['high', 'medium', 'low']);

/**
 * Validate and normalize a frontmatter object from parsed JSON.
 * Returns a cleaned FactFrontmatter or a best-effort fallback.
 */
function validateFrontmatter(raw: unknown, fallbackContent?: string): FactFrontmatter {
  const defaults: FactFrontmatter = {
    label: fallbackContent
      ? fallbackContent.slice(0, 80)
      : 'Untitled fact',
    category: 'other',
    keywords: [],
  };

  if (typeof raw !== 'object' || raw === null) return defaults;

  const obj = raw as Record<string, unknown>;

  // label
  const label = typeof obj.label === 'string' && obj.label.trim().length > 0
    ? obj.label.trim().slice(0, 80)
    : defaults.label;

  // category
  const category = typeof obj.category === 'string' && VALID_CATEGORIES.has(obj.category.toLowerCase().trim())
    ? obj.category.toLowerCase().trim()
    : defaults.category;

  // keywords
  let keywords: string[] = [];
  if (Array.isArray(obj.keywords)) {
    keywords = obj.keywords
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map((k) => k.trim().toLowerCase())
      .filter((k, i, arr) => arr.indexOf(k) === i)  // deduplicate
      .slice(0, 10);  // cap at 10
  }

  // domain
  const domain = typeof obj.domain === 'string' && obj.domain.trim().length > 0
    ? obj.domain.trim().toLowerCase()
    : undefined;

  // importance
  const importance = typeof obj.importance === 'string' && VALID_IMPORTANCE.has(obj.importance.toLowerCase().trim())
    ? obj.importance.toLowerCase().trim() as 'high' | 'medium' | 'low'
    : undefined;

  return { label, category, keywords, domain, importance };
}

/**
 * Validate and normalize a summary string.
 */
function validateSummary(raw: unknown, fallbackContent?: string): string {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  // Fallback: use the fact content itself as the summary
  return fallbackContent ?? '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single-fact frontmatter LLM response.
 *
 * Expected format:
 * {
 *   "frontmatter": { "label": "...", "category": "...", "keywords": [...], ... },
 *   "summary": "..."
 * }
 */
export function parseFrontmatterResponse(
  rawContent: string,
  fallbackContent?: string,
): FrontmatterParseResult {
  if (!rawContent || !rawContent.trim()) {
    return {
      ok: true,
      result: buildFallbackResult(fallbackContent),
    };
  }

  try {
    const jsonStr = extractJSON(rawContent);
    const parsed = JSON.parse(jsonStr);

    if (typeof parsed !== 'object' || parsed === null) {
      return {
        ok: false,
        error: 'Response is not a JSON object',
        rawContent,
      };
    }

    const frontmatter = validateFrontmatter(parsed.frontmatter, fallbackContent);
    const summary = validateSummary(parsed.summary, fallbackContent);

    return {
      ok: true,
      result: {
        frontmatter: JSON.stringify(frontmatter),
        summary,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      rawContent,
    };
  }
}

/**
 * Parse a batch frontmatter LLM response.
 *
 * Expected format:
 * {
 *   "results": [
 *     { "frontmatter": { ... }, "summary": "..." },
 *     ...
 *   ]
 * }
 */
export function parseBatchFrontmatterResponse(
  rawContent: string,
  fallbackContents?: string[],
): BatchFrontmatterParseResult {
  if (!rawContent || !rawContent.trim()) {
    return {
      ok: false,
      error: 'Empty response',
      rawContent: rawContent ?? '',
    };
  }

  try {
    const jsonStr = extractJSON(rawContent);
    const parsed = JSON.parse(jsonStr);

    if (typeof parsed !== 'object' || parsed === null) {
      return {
        ok: false,
        error: 'Response is not a JSON object',
        rawContent,
      };
    }

    let resultsArray: unknown[];
    if (Array.isArray(parsed.results)) {
      resultsArray = parsed.results;
    } else if (Array.isArray(parsed)) {
      resultsArray = parsed;
    } else {
      return {
        ok: false,
        error: 'Response does not contain a results array',
        rawContent,
      };
    }

    const results: FrontmatterResult[] = resultsArray.map((item, i) => {
      const fallback = fallbackContents?.[i];
      if (typeof item !== 'object' || item === null) {
        return buildFallbackResult(fallback);
      }
      const obj = item as Record<string, unknown>;
      const frontmatter = validateFrontmatter(obj.frontmatter, fallback);
      const summary = validateSummary(obj.summary, fallback);
      return {
        frontmatter: JSON.stringify(frontmatter),
        summary,
      };
    });

    return { ok: true, results };
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      rawContent,
    };
  }
}

/**
 * Generate frontmatter and summary without an LLM call.
 * Used as a fallback when LLM is unavailable or for testing.
 */
export function generateFallbackFrontmatter(
  factContent: string,
  category: string,
  entities: string[],
): FrontmatterResult {
  const label = factContent.length <= 80
    ? factContent
    : factContent.slice(0, 77) + '...';

  const keywords = entities
    .map((e) => e.toLowerCase().replace(/\s+/g, '-'))
    .slice(0, 5);

  const frontmatter: FactFrontmatter = {
    label,
    category: VALID_CATEGORIES.has(category) ? category : 'other',
    keywords,
  };

  return {
    frontmatter: JSON.stringify(frontmatter),
    summary: factContent,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFallbackResult(fallbackContent?: string): FrontmatterResult {
  return {
    frontmatter: JSON.stringify({
      label: fallbackContent ? fallbackContent.slice(0, 80) : 'Untitled fact',
      category: 'other',
      keywords: [],
    } satisfies FactFrontmatter),
    summary: fallbackContent ?? '',
  };
}
