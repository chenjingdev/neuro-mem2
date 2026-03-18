/**
 * Memory Node Parser — parses and validates LLM responses into ExtractedMemoryNode objects.
 *
 * Handles:
 * - JSON extraction from potentially noisy LLM output
 * - Schema validation with sensible defaults
 * - searchKeywords and relatedEntities normalization
 * - Graceful error handling for malformed responses
 */

import type {
  ExtractedMemoryNode,
  MemoryNodeType,
  MemoryNodeMetadata,
} from '../models/memory-node.js';
import { MEMORY_NODE_TYPES } from '../models/memory-node.js';

// ─── Parse Result ────────────────────────────────────────────────

export type MemoryNodeParseResult =
  | { ok: true; nodes: ExtractedMemoryNode[] }
  | { ok: false; error: string; rawContent: string };

// ─── Valid categories (same as fact categories) ──────────────────

const VALID_CATEGORIES = [
  'preference', 'technical', 'requirement', 'decision',
  'context', 'instruction', 'knowledge', 'relationship', 'other',
] as const;

// ─── JSON Extraction ─────────────────────────────────────────────

/**
 * Extract JSON from LLM response that may contain markdown fences or extra text.
 */
function extractJSON(raw: string): string {
  const trimmed = raw.trim();

  // Try markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }

  // Check both positions
  const braceStart = trimmed.indexOf('{');
  const bracketStart = trimmed.indexOf('[');

  // If array starts before object (bare array like [{...}]), extract array first
  if (bracketStart !== -1 && (braceStart === -1 || bracketStart < braceStart)) {
    const bracketEnd = trimmed.lastIndexOf(']');
    if (bracketEnd > bracketStart) {
      return trimmed.slice(bracketStart, bracketEnd + 1);
    }
  }

  // Try to find a JSON object
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  return trimmed;
}

// ─── Field Normalizers ───────────────────────────────────────────

function normalizeNodeType(raw: unknown): MemoryNodeType {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase().trim();
    if ((MEMORY_NODE_TYPES as readonly string[]).includes(lower)) {
      return lower as MemoryNodeType;
    }
  }
  return 'semantic'; // default
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .map((e) => e.trim());
}

function normalizeString(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return fallback;
}

function normalizeConfidence(raw: unknown): number {
  if (typeof raw !== 'number' || isNaN(raw)) return 0.5;
  return Math.max(0, Math.min(1, raw));
}

function normalizeCategory(raw: unknown): string {
  if (typeof raw !== 'string') return 'other';
  const lower = raw.toLowerCase().trim();
  return (VALID_CATEGORIES as readonly string[]).includes(lower) ? lower : 'other';
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return undefined;
}

// ─── Metadata Normalizer ─────────────────────────────────────────

function normalizeMetadata(raw: unknown, nodeType: MemoryNodeType): MemoryNodeMetadata {
  if (typeof raw !== 'object' || raw === null) return {};

  const obj = raw as Record<string, unknown>;
  const metadata: MemoryNodeMetadata = {};

  // Common fields
  if (obj.category) metadata.category = normalizeCategory(obj.category);
  if (obj.confidence !== undefined) metadata.confidence = normalizeConfidence(obj.confidence);
  if (obj.entities) metadata.entities = normalizeStringArray(obj.entities);
  if (obj.salience !== undefined && typeof obj.salience === 'number') {
    metadata.salience = Math.max(0, Math.min(1, obj.salience));
  }

  // Semantic-specific (SPO triple)
  if (nodeType === 'semantic') {
    metadata.subject = optionalString(obj.subject);
    metadata.predicate = optionalString(obj.predicate);
    metadata.object = optionalString(obj.object);
  }

  // Episodic-specific
  if (nodeType === 'episodic') {
    metadata.episodeType = optionalString(obj.episodeType) as MemoryNodeMetadata['episodeType'];
    metadata.actors = normalizeStringArray(obj.actors);
    metadata.outcome = optionalString(obj.outcome);
  }

  // Procedural-specific
  if (nodeType === 'procedural') {
    metadata.steps = normalizeStringArray(obj.steps);
    metadata.prerequisites = normalizeStringArray(obj.prerequisites);
  }

  // Prospective-specific
  if (nodeType === 'prospective') {
    metadata.dueDate = optionalString(obj.dueDate);
    metadata.priority = optionalString(obj.priority) as MemoryNodeMetadata['priority'];
    metadata.status = optionalString(obj.status) as MemoryNodeMetadata['status'];
  }

  // Emotional-specific
  if (nodeType === 'emotional') {
    metadata.emotion = optionalString(obj.emotion);
    metadata.trigger = optionalString(obj.trigger);
    if (typeof obj.intensity === 'number') {
      metadata.intensity = Math.max(0, Math.min(1, obj.intensity));
    }
  }

  return metadata;
}

// ─── Single Node Validation ──────────────────────────────────────

function validateNode(raw: unknown): ExtractedMemoryNode | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const obj = raw as Record<string, unknown>;

  // frontmatter/summary required
  const frontmatter = normalizeString(obj.frontmatter, '');
  const summary = normalizeString(obj.summary, '');
  if (!frontmatter && !summary) return null;

  const nodeType = normalizeNodeType(obj.nodeType);
  const searchKeywords = normalizeStringArray(obj.searchKeywords);
  const relatedEntities = normalizeStringArray(obj.relatedEntities);

  // Build keywords string from searchKeywords (space-separated for FTS5)
  const keywords = searchKeywords.join(' ');

  // Normalize metadata and inject relatedEntities into metadata.entities
  const metadata = normalizeMetadata(obj.metadata, nodeType);
  if (relatedEntities.length > 0) {
    // Merge LLM-extracted relatedEntities into metadata.entities
    const existing = new Set(metadata.entities ?? []);
    for (const entity of relatedEntities) {
      existing.add(entity);
    }
    metadata.entities = Array.from(existing);
  }

  return {
    nodeType,
    frontmatter: frontmatter || summary.slice(0, 80),
    keywords,
    searchKeywords,
    relatedEntities,
    summary: summary || frontmatter,
    metadata,
  };
}

// ─── Main Parser ─────────────────────────────────────────────────

/**
 * Parse an LLM response string into a list of ExtractedMemoryNode objects.
 *
 * Intentionally lenient — tries multiple strategies to extract valid nodes
 * from potentially imperfect LLM output.
 */
export function parseMemoryNodeResponse(rawContent: string): MemoryNodeParseResult {
  if (!rawContent || !rawContent.trim()) {
    return { ok: true, nodes: [] };
  }

  try {
    const jsonStr = extractJSON(rawContent);
    const parsed = JSON.parse(jsonStr);

    let nodesArray: unknown[];

    // Handle { nodes: [...] } format
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
      nodesArray = parsed.nodes;
    } else if (Array.isArray(parsed)) {
      // Handle bare array format
      nodesArray = parsed;
    } else {
      return {
        ok: false,
        error: 'Response is not a nodes array or object with nodes property',
        rawContent,
      };
    }

    const nodes: ExtractedMemoryNode[] = [];
    for (const raw of nodesArray) {
      const node = validateNode(raw);
      if (node) {
        nodes.push(node);
      }
    }

    return { ok: true, nodes };
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      rawContent,
    };
  }
}
