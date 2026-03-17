/**
 * LLM Provider interface — abstracts LLM API calls for memory extraction.
 *
 * This interface allows swapping between different LLM backends
 * (OpenAI, Anthropic, local models) without changing extraction logic.
 * Designed to be replaced by a dedicated ML model in the future.
 */

export interface LLMCompletionRequest {
  /** System prompt */
  system: string;
  /** User prompt */
  prompt: string;
  /** Optional model override */
  model?: string;
  /** Optional session id for providers with session-aware routing or caching */
  sessionId?: string;
  /** Expected response format */
  responseFormat?: 'json' | 'text';
  /** Temperature (0.0 = deterministic, 1.0 = creative) */
  temperature?: number;
  /** Maximum tokens in response */
  maxTokens?: number;
}

export interface LLMCompletionResponse {
  /** Raw text content from the LLM */
  content: string;
  /** Token usage stats (optional) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Streaming types for the Visual Debug Chat App
// ---------------------------------------------------------------------------

/** A streaming request extends the standard completion request with chat history. */
export interface LLMStreamRequest {
  /** System prompt */
  system: string;
  /** Conversation messages (multi-turn) */
  messages: LLMChatMessage[];
  /** Optional model override */
  model?: string;
  /** Optional session id for providers with session-aware routing or caching */
  sessionId?: string;
  /** Temperature (0.0 = deterministic, 1.0 = creative) */
  temperature?: number;
  /** Maximum tokens in response */
  maxTokens?: number;
}

/** A single chat message in a conversation. */
export interface LLMChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Events emitted during LLM streaming.
 *
 * - `delta`  : incremental text token from the LLM
 * - `finish` : stream completed, includes aggregated usage stats
 * - `error`  : an error occurred during streaming
 */
export type LLMStreamEvent =
  | LLMStreamDeltaEvent
  | LLMStreamFinishEvent
  | LLMStreamErrorEvent;

export interface LLMStreamDeltaEvent {
  type: 'delta';
  /** Incremental text content */
  content: string;
}

export interface LLMStreamFinishEvent {
  type: 'finish';
  /** Full accumulated response text */
  content: string;
  /** Token usage stats (optional, provider-dependent) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMStreamErrorEvent {
  type: 'error';
  error: string;
}

/**
 * Abstract interface for LLM providers.
 * Implementations handle the actual API communication.
 */
export interface LLMProvider {
  /** Provider name for logging/debugging */
  readonly name: string;

  /**
   * Send a completion request and get a response.
   * Implementations should handle retries and error formatting.
   */
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;

  /**
   * Stream a chat completion, yielding incremental tokens via an async iterator.
   * Used by the Visual Debug Chat App for real-time SSE streaming.
   * Optional — providers that don't support streaming can omit this.
   */
  stream?(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent>;
}

/**
 * A mock LLM provider for testing that returns predefined responses.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  private responses: string[] = [];
  private callIndex = 0;
  public calls: LLMCompletionRequest[] = [];

  /**
   * Queue a response to be returned on the next call.
   */
  addResponse(response: string): void {
    this.responses.push(response);
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    this.calls.push(request);
    const content = this.responses[this.callIndex] ?? '{"facts": []}';
    this.callIndex++;
    return { content };
  }

  /** Reset state for test isolation */
  reset(): void {
    this.responses = [];
    this.callIndex = 0;
    this.calls = [];
  }
}
