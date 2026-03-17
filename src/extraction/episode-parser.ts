/**
 * Episode response parser — validates and normalizes LLM output
 * into ExtractedEpisodeRaw instances.
 */

import { EPISODE_TYPES, type EpisodeType, type ExtractedEpisodeRaw } from '../models/episode.js';

export interface EpisodeParseResult {
  ok: boolean;
  episodes: ExtractedEpisodeRaw[];
  error?: string;
}

/**
 * Parse and validate the LLM's JSON response into ExtractedEpisodeRaw[].
 *
 * Handles:
 * - Markdown code fences
 * - Invalid/missing fields (skip gracefully)
 * - Out-of-range turn indices
 * - Sort by startTurnIndex
 */
export function parseEpisodeResponse(
  raw: string,
  maxTurnIndex: number
): EpisodeParseResult {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      ok: false,
      episodes: [],
      error: `Failed to parse LLM episode response as JSON: ${cleaned.slice(0, 200)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      episodes: [],
      error: 'LLM episode response is not an array',
    };
  }

  const episodes: ExtractedEpisodeRaw[] = [];

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;

    const obj = item as Record<string, unknown>;

    // Validate type
    const type = obj['type'] as string;
    if (!EPISODE_TYPES.includes(type as EpisodeType)) continue;

    // Validate title
    const title = obj['title'];
    if (typeof title !== 'string' || !title.trim()) continue;

    // Validate description
    const description = obj['description'];
    if (typeof description !== 'string' || !description.trim()) continue;

    // Validate turn indices
    const startTurnIndex = obj['startTurnIndex'];
    const endTurnIndex = obj['endTurnIndex'];
    if (typeof startTurnIndex !== 'number' || typeof endTurnIndex !== 'number') continue;
    if (!Number.isInteger(startTurnIndex) || !Number.isInteger(endTurnIndex)) continue;
    if (startTurnIndex < 0 || endTurnIndex < 0) continue;
    if (startTurnIndex > endTurnIndex) continue;
    if (startTurnIndex > maxTurnIndex || endTurnIndex > maxTurnIndex) continue;

    // Validate actors
    const actors = obj['actors'];
    if (!Array.isArray(actors) || actors.length === 0) continue;
    const validActors = actors.filter(
      (a): a is string => typeof a === 'string' && a.trim() !== ''
    );
    if (validActors.length === 0) continue;

    // Optional outcome
    const outcome =
      typeof obj['outcome'] === 'string' && obj['outcome'].trim()
        ? obj['outcome'].trim()
        : undefined;

    episodes.push({
      type: type as EpisodeType,
      title: (title as string).trim(),
      description: (description as string).trim(),
      startTurnIndex,
      endTurnIndex,
      actors: validActors,
      outcome,
    });
  }

  // Sort chronologically
  episodes.sort((a, b) => a.startTurnIndex - b.startTurnIndex);

  return { ok: true, episodes };
}
