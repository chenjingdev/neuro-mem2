/**
 * SSE (Server-Sent Events) Parser for the nero-mem2 chat API.
 *
 * Parses the wire format:
 *   event: trace\n
 *   data: {"stage":"recall","status":"start",...}\n
 *   \n
 *
 * Events are separated by double-newlines (\n\n).
 * Each event block has an `event:` line and a `data:` line.
 */

/** Parsed SSE event with event type and raw data string. */
export interface ParsedSSEEvent {
  event: string;
  data: string;
}

/**
 * Incrementally parse SSE text into structured events.
 *
 * Takes a buffer of accumulated text and splits it into complete SSE events.
 * Returns the parsed events and any remaining incomplete text.
 *
 * @param buffer - Accumulated text from the SSE stream
 * @returns Parsed events and remaining incomplete buffer
 */
export function parseSSEChunk(buffer: string): { events: ParsedSSEEvent[]; remaining: string } {
  const events: ParsedSSEEvent[] = [];

  // Split on double-newline (SSE event boundary)
  const blocks = buffer.split('\n\n');

  // The last element might be an incomplete block — keep it as remaining
  const remaining = blocks.pop() ?? '';

  for (const block of blocks) {
    if (!block.trim()) continue;

    let eventType = '';
    let data = '';

    const lines = block.split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // Support multi-line data by appending
        if (data) {
          data += '\n' + line.slice(5).trim();
        } else {
          data = line.slice(5).trim();
        }
      }
    }

    if (eventType && data) {
      events.push({ event: eventType, data });
    }
  }

  return { events, remaining };
}
