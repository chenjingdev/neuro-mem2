/**
 * Summary Parser — parses and validates LLM responses for Level 0/1 summary generation.
 *
 * Follows the same lenient parsing strategy as fact-parser.ts:
 * handles markdown fences, bare arrays, and noisy LLM output gracefully.
 */

import type { GeneratedSummary } from './summary-prompt.js';

/**
 * Result of parsing: either success with summaries, or failure with reason.
 */
export type SummaryParseResult =
  | { ok: true; summaries: GeneratedSummary[] }
  | { ok: false; error: string; rawContent: string };

/**
 * Extract JSON from LLM response that may contain markdown fences or extra text.
 * (Same strategy as fact-parser.ts extractJSON)
 */
function extractJSON(raw: string): string {
  const trimmed = raw.trim();

  // Try to extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }

  // Try to find a JSON object in the response
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    const bracketStart = trimmed.indexOf('[');
    if (bracketStart !== -1 && bracketStart < braceStart) {
      const bracketEnd = trimmed.lastIndexOf(']');
      if (bracketEnd > bracketStart) {
        return trimmed.slice(bracketStart, bracketEnd + 1);
      }
    }
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  // Try to find a bare JSON array
  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return trimmed.slice(bracketStart, bracketEnd + 1);
  }

  return trimmed;
}

/**
 * Validate and normalize a single summary object from parsed JSON.
 */
function validateSummary(raw: unknown): GeneratedSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  const frontmatter = typeof obj.frontmatter === 'string' ? obj.frontmatter.trim() : '';
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';

  // ID is required
  if (!id) return null;

  // At least one of frontmatter or summary must be present
  if (!frontmatter && !summary) return null;

  return {
    id,
    frontmatter: frontmatter || summary, // fallback: use summary as frontmatter
    summary: summary || frontmatter,      // fallback: use frontmatter as summary
  };
}

/**
 * Parse an LLM response string into a list of GeneratedSummary objects.
 *
 * Intentionally lenient — tries multiple strategies to extract
 * valid summaries from potentially imperfect LLM output.
 */
export function parseSummaryResponse(rawContent: string): SummaryParseResult {
  if (!rawContent || !rawContent.trim()) {
    return { ok: true, summaries: [] };
  }

  try {
    const jsonStr = extractJSON(rawContent);
    const parsed = JSON.parse(jsonStr);

    // Handle { summaries: [...] } format
    let summariesArray: unknown[];
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.summaries)) {
      summariesArray = parsed.summaries;
    } else if (Array.isArray(parsed)) {
      // Handle bare array format
      summariesArray = parsed;
    } else {
      return {
        ok: false,
        error: 'Response is not a summaries array or object with summaries property',
        rawContent,
      };
    }

    const summaries: GeneratedSummary[] = [];
    for (const raw of summariesArray) {
      const summary = validateSummary(raw);
      if (summary) {
        summaries.push(summary);
      }
    }

    return { ok: true, summaries };
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      rawContent,
    };
  }
}

/**
 * Build a map from fact ID to generated summary for easy lookup.
 */
export function buildSummaryMap(
  summaries: GeneratedSummary[],
): Map<string, { frontmatter: string; summary: string }> {
  const map = new Map<string, { frontmatter: string; summary: string }>();
  for (const s of summaries) {
    map.set(s.id, { frontmatter: s.frontmatter, summary: s.summary });
  }
  return map;
}
