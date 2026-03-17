/**
 * OpenAI LLMProvider implementation.
 *
 * Uses the OpenAI Chat Completions API directly via fetch (no SDK dependency).
 * Supports both standard completion and streaming for the Visual Debug Chat App.
 *
 * Auth is loaded from a local auth.json (Codex OAuth token) or an explicit API key.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from './llm-provider.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OpenAIProviderConfig {
  /** OpenAI API key. If omitted, loaded from auth.json or OPENAI_API_KEY env. */
  apiKey?: string;
  /** Path to Codex OAuth auth.json file. Defaults to ~/.codex/auth.json */
  authJsonPath?: string;
  /** Model to use. Defaults to "gpt-4o". */
  model?: string;
  /** Base URL for the API. Defaults to "https://api.openai.com/v1". */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadAuthToken(authJsonPath?: string): string | undefined {
  try {
    const filePath = authJsonPath ?? join(homedir(), '.codex', 'auth.json');
    if (!existsSync(filePath)) return undefined;

    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    // Codex auth.json stores the token under `token` or `api_key`
    return data.token ?? data.api_key ?? data.access_token ?? undefined;
  } catch {
    return undefined;
  }
}

/** Parse a single SSE line of the form "data: {json}" */
function parseSSELine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice(6).trim();
  if (payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAILLMProvider implements LLMProvider {
  readonly name = 'openai';

  private readonly model: string;
  private readonly baseUrl: string;
  private apiKey: string | undefined;
  private readonly authJsonPath: string | undefined;
  private keyResolved = false;

  constructor(config: OpenAIProviderConfig = {}) {
    this.model = config.model ?? 'gpt-4o';
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.authJsonPath = config.authJsonPath;
  }

  // ── Key resolution ──────────────────────────────────────────────

  private async resolveApiKey(): Promise<string> {
    if (this.keyResolved && this.apiKey) return this.apiKey;

    // 1. Explicit config
    if (this.apiKey) {
      this.keyResolved = true;
      return this.apiKey;
    }

    // 2. Environment variable
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) {
      this.apiKey = envKey;
      this.keyResolved = true;
      return envKey;
    }

    // 3. Codex auth.json
    const authToken = await loadAuthToken(this.authJsonPath);
    if (authToken) {
      this.apiKey = authToken;
      this.keyResolved = true;
      return authToken;
    }

    throw new Error(
      'OpenAI API key not found. Set OPENAI_API_KEY env, pass apiKey in config, or provide auth.json.',
    );
  }

  // ── Standard completion ─────────────────────────────────────────

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const apiKey = await this.resolveApiKey();
    const model = request.model ?? this.model;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? 0.0,
      stream: false,
    };

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const content = json.choices?.[0]?.message?.content ?? '';
    const usage = json.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined;

    return { content, usage };
  }

  // ── Streaming ───────────────────────────────────────────────────

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    const apiKey = await this.resolveApiKey();
    const model = request.model ?? this.model;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: request.system },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    // Request stream_options to get usage in the final chunk
    body.stream_options = { include_usage: true };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      yield { type: 'error', error: `OpenAI API error ${res.status}: ${errorText}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', error: 'No response body for streaming' };
      return;
    }

    // Read SSE stream
    let accumulated = '';
    let usageInfo:
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined;

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // skip empty lines and comments

          if (trimmed === 'data: [DONE]') {
            // Stream complete
            continue;
          }

          const parsed = parseSSELine(trimmed);
          if (!parsed) continue;

          // Extract usage from the final chunk (stream_options.include_usage)
          const chunkUsage = parsed.usage as
            | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
            | undefined;
          if (chunkUsage && chunkUsage.total_tokens) {
            usageInfo = {
              promptTokens: chunkUsage.prompt_tokens,
              completionTokens: chunkUsage.completion_tokens,
              totalTokens: chunkUsage.total_tokens,
            };
          }

          // Extract delta content
          const choices = parsed.choices as
            | Array<{ delta?: { content?: string }; finish_reason?: string | null }>
            | undefined;
          if (choices && choices.length > 0) {
            const delta = choices[0]?.delta;
            if (delta?.content) {
              accumulated += delta.content;
              yield { type: 'delta', content: delta.content };
            }
          }
        }
      }

      // Emit finish event
      yield {
        type: 'finish',
        content: accumulated,
        usage: usageInfo,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: `Stream error: ${message}` };
    }
  }
}
