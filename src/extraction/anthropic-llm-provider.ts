/**
 * Anthropic LLM Provider — concrete implementation using Anthropic Messages API.
 *
 * Supports both buffered `complete()` and streaming `stream()` methods.
 * Uses raw `fetch` to avoid extra SDK dependencies; compatible with
 * Anthropic's SSE streaming protocol (event: message_start / content_block_delta / message_stop).
 */

import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from './llm-provider.js';

// ── Configuration ────────────────────────────────────────────────

export interface AnthropicProviderConfig {
  /** Anthropic API key. If omitted, reads from ANTHROPIC_API_KEY env. */
  apiKey?: string;
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Base URL (default: https://api.anthropic.com) */
  baseUrl?: string;
  /** Anthropic API version header (default: 2023-06-01) */
  apiVersion?: string;
  /** Default max tokens (default: 4096) */
  defaultMaxTokens?: number;
}

// ── Provider Implementation ──────────────────────────────────────

export class AnthropicLLMProvider implements LLMProvider {
  readonly name = 'anthropic';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly defaultMaxTokens: number;

  constructor(config: AnthropicProviderConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.apiVersion = config.apiVersion ?? '2023-06-01';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;

    if (!this.apiKey) {
      throw new Error(
        'AnthropicLLMProvider: API key required. Set ANTHROPIC_API_KEY env or pass apiKey in config.',
      );
    }
  }

  // ── Buffered completion ──────────────────────────────────────

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const body = {
      model: request.model ?? this.model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      temperature: request.temperature ?? 0.0,
      system: request.system,
      messages: [{ role: 'user' as const, content: request.prompt }],
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(false),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as AnthropicMessageResponse;

    const content = json.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    return {
      content,
      usage: json.usage
        ? {
            promptTokens: json.usage.input_tokens,
            completionTokens: json.usage.output_tokens,
            totalTokens: json.usage.input_tokens + json.usage.output_tokens,
          }
        : undefined,
    };
  }

  // ── Streaming completion ─────────────────────────────────────

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    const body = {
      model: request.model ?? this.model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      temperature: request.temperature ?? 0.0,
      stream: true,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: 'error', error: `Anthropic API error ${res.status}: ${text}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', error: 'Anthropic API returned no body' };
      return;
    }

    let accumulated = '';
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

    try {
      for await (const event of this.parseSSE(res.body)) {
        switch (event.event) {
          case 'content_block_delta': {
            const delta = event.data as ContentBlockDelta;
            if (delta.delta?.type === 'text_delta' && delta.delta.text) {
              accumulated += delta.delta.text;
              yield { type: 'delta', content: delta.delta.text };
            }
            break;
          }
          case 'message_delta': {
            const msgDelta = event.data as MessageDelta;
            if (msgDelta.usage) {
              // message_delta carries output_tokens
              usage = {
                promptTokens: usage?.promptTokens ?? 0,
                completionTokens: msgDelta.usage.output_tokens,
                totalTokens: (usage?.promptTokens ?? 0) + msgDelta.usage.output_tokens,
              };
            }
            break;
          }
          case 'message_start': {
            const msgStart = event.data as MessageStart;
            if (msgStart.message?.usage) {
              usage = {
                promptTokens: msgStart.message.usage.input_tokens,
                completionTokens: 0,
                totalTokens: msgStart.message.usage.input_tokens,
              };
            }
            break;
          }
          case 'message_stop': {
            // Final event — emit finish
            break;
          }
          case 'error': {
            const errData = event.data as { error?: { message?: string } };
            yield {
              type: 'error',
              error: errData.error?.message ?? 'Unknown Anthropic stream error',
            };
            return;
          }
          // Ignore: content_block_start, content_block_stop, ping
          default:
            break;
        }
      }

      // Finalize
      if (usage) {
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }
      yield { type: 'finish', content: accumulated, usage };
    } catch (err) {
      yield {
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  private headers(streaming: boolean): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion,
    };
    if (streaming) {
      h['Accept'] = 'text/event-stream';
    }
    return h;
  }

  /**
   * Parse an SSE stream from the Anthropic Messages API.
   * Yields parsed { event, data } objects for each SSE frame.
   */
  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncIterable<{ event: string; data: unknown }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE frames (separated by double newline)
        const frames = buffer.split('\n\n');
        // Keep the last (potentially incomplete) chunk
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (!frame.trim()) continue;

          let eventType = 'message';
          let dataStr = '';

          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              dataStr += line.slice(6);
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5);
            }
          }

          if (!dataStr) continue;

          try {
            const data = JSON.parse(dataStr);
            yield { event: eventType, data };
          } catch {
            // Non-JSON data line — skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── Anthropic API response types (minimal) ───────────────────────

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

interface ContentBlockDelta {
  delta?: { type: string; text?: string };
}

interface MessageDelta {
  usage?: { output_tokens: number };
}

interface MessageStart {
  message?: { usage?: { input_tokens: number } };
}
