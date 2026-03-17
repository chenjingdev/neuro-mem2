/**
 * Fact Parser — parses and validates LLM responses into structured ExtractedFact objects.
 *
 * Handles:
 * - JSON extraction from potentially noisy LLM output
 * - Schema validation with sensible defaults
 * - Graceful error handling for malformed responses
 */

import { type ExtractedFact, type FactCategory, FACT_CATEGORIES } from '../models/fact.js';

/**
 * Result of parsing: either success with facts, or failure with reason.
 */
export type ParseResult =
  | { ok: true; facts: ExtractedFact[] }
  | { ok: false; error: string; rawContent: string };

/**
 * Extract JSON from LLM response that may contain markdown fences or extra text.
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
    // Check if there's a bare array before the first object
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
 * Validate and normalize a category string.
 */
function normalizeCategory(raw: unknown): FactCategory {
  if (typeof raw !== 'string') return 'other';
  const lower = raw.toLowerCase().trim() as FactCategory;
  return FACT_CATEGORIES.includes(lower) ? lower : 'other';
}

/**
 * Validate and clamp a confidence score.
 */
function normalizeConfidence(raw: unknown): number {
  if (typeof raw !== 'number' || isNaN(raw)) return 0.5;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Validate and normalize entities array.
 */
function normalizeEntities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .map((e) => e.trim());
}

/**
 * Extract an optional string field.
 */
function optionalString(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return undefined;
}

/**
 * Validate a single fact object from parsed JSON.
 */
function validateFact(raw: unknown): ExtractedFact | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  const content = typeof obj.content === 'string' ? obj.content.trim() : '';

  // Content is required and must be non-empty
  if (!content) return null;

  return {
    content,
    category: normalizeCategory(obj.category),
    confidence: normalizeConfidence(obj.confidence),
    entities: normalizeEntities(obj.entities),
    subject: optionalString(obj.subject),
    predicate: optionalString(obj.predicate),
    object: optionalString(obj.object),
  };
}

/**
 * Parse an LLM response string into a list of ExtractedFact objects.
 *
 * This is intentionally lenient — it tries multiple strategies to extract
 * valid facts from potentially imperfect LLM output.
 */
export function parseFactResponse(rawContent: string): ParseResult {
  if (!rawContent || !rawContent.trim()) {
    return { ok: true, facts: [] };
  }

  try {
    const jsonStr = extractJSON(rawContent);
    const parsed = JSON.parse(jsonStr);

    // Handle { facts: [...] } format
    let factsArray: unknown[];
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.facts)) {
      factsArray = parsed.facts;
    } else if (Array.isArray(parsed)) {
      // Handle bare array format
      factsArray = parsed;
    } else {
      return {
        ok: false,
        error: 'Response is not a facts array or object with facts property',
        rawContent,
      };
    }

    const facts: ExtractedFact[] = [];
    for (const raw of factsArray) {
      const fact = validateFact(raw);
      if (fact) {
        facts.push(fact);
      }
    }

    return { ok: true, facts };
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      rawContent,
    };
  }
}
