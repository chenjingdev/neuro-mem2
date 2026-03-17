/**
 * useChat — React hook for SSE-streaming chat with the nero-mem2 backend.
 *
 * Sends POST requests to /api/chat and parses the SSE stream which contains:
 *   - event:trace  → pipeline stage instrumentation (recall, llm, ingestion)
 *   - event:chat   → LLM response tokens (delta, finish, error)
 *   - event:done   → stream completion signal with full response + timing
 *
 * The hook manages:
 *   - Chat message history (user + assistant messages)
 *   - Trace events from the current request (for timeline visualization)
 *   - Streaming state, errors, usage stats
 *   - AbortController for cancellation
 */

import { useState, useRef, useCallback } from 'react';
import type {
  ChatMessage,
  TraceEvent,
  ChatSSEEvent,
  DoneSSEEvent,
} from '../types';
import { parseSSEChunk } from './sse-parser';

// ─── Types ──────────────────────────────────────────────────

/** Options for the useChat hook. */
export interface UseChatOptions {
  /** API endpoint URL (default: '/api/chat') */
  apiUrl?: string;
  /** Optional system prompt override */
  systemPrompt?: string;
  /** LLM provider override ('openai' | 'anthropic') */
  provider?: 'openai' | 'anthropic';
  /** LLM model override */
  model?: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens for LLM response */
  maxTokens?: number;
}

/** Return type of the useChat hook. */
export interface UseChatReturn {
  /** All chat messages (user + assistant) */
  messages: ChatMessage[];
  /** Trace events from the current/last request */
  traces: TraceEvent[];
  /** Whether a streaming request is in progress */
  isStreaming: boolean;
  /** Error message from the last request, if any */
  error: string | null;
  /** Token usage from the last completed response */
  usage: ChatSSEEvent['usage'] | null;
  /** Total pipeline duration from the last request */
  totalDurationMs: number | null;
  /** Send a new message */
  sendMessage: (content: string) => void;
  /** Abort the current streaming request */
  stop: () => void;
  /** Clear all messages and traces */
  clearChat: () => void;
}

// ─── ID Generator ───────────────────────────────────────────

let nextId = 1;
function generateId(): string {
  return `msg-${Date.now()}-${nextId++}`;
}

// ─── Hook ───────────────────────────────────────────────────

/**
 * React hook for SSE-streaming chat with the nero-mem2 backend.
 *
 * @param options - Optional configuration (API URL, LLM settings)
 * @returns Chat state and actions
 *
 * @example
 * ```tsx
 * const { messages, traces, isStreaming, sendMessage, stop } = useChat();
 *
 * // Send a message — triggers SSE stream
 * sendMessage('What do you know about me?');
 *
 * // messages updates in real-time as delta events arrive
 * // traces updates as pipeline stage events arrive
 * ```
 */
export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const {
    apiUrl = '/api/chat',
    systemPrompt,
    provider,
    model,
    temperature,
    maxTokens,
  } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatSSEEvent['usage'] | null>(null);
  const [totalDurationMs, setTotalDurationMs] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Keep a ref to messages so sendMessage callback doesn't stale-close over messages state
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim()) return;

    // Clear previous request state
    setError(null);
    setUsage(null);
    setTotalDurationMs(null);
    setTraces([]);

    // Add user message
    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
    };

    // Add placeholder assistant message
    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    // Build history from previous messages (excluding the new user + assistant messages)
    const currentMessages = messagesRef.current;
    const history = currentMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Build request body matching backend ChatRequest interface
    const requestBody: Record<string, unknown> = {
      message: content.trim(),
    };

    if (history.length > 0) {
      requestBody.history = history;
    }
    if (systemPrompt) requestBody.systemPrompt = systemPrompt;
    if (provider) requestBody.provider = provider;
    if (model) requestBody.model = model;
    if (temperature !== undefined) requestBody.temperature = temperature;
    if (maxTokens !== undefined) requestBody.maxTokens = maxTokens;

    // Create abort controller
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Try to parse error body
        let errorText: string;
        try {
          const errorBody = await response.json();
          errorText = errorBody.message ?? errorBody.error ?? `HTTP ${response.status}`;
        } catch {
          errorText = `Chat request failed: ${response.status}`;
        }
        throw new Error(errorText);
      }

      if (!response.body) {
        throw new Error('Response body is empty — SSE streaming not supported');
      }

      // Read the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const assistantId = assistantMsg.id;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from the buffer
        const { events, remaining } = parseSSEChunk(buffer);
        buffer = remaining;

        for (const sseEvent of events) {
          switch (sseEvent.event) {
            case 'trace': {
              try {
                const traceData = JSON.parse(sseEvent.data) as TraceEvent;
                setTraces(prev => [...prev, traceData]);
              } catch {
                // Skip malformed trace JSON
              }
              break;
            }

            case 'chat': {
              try {
                const chatData = JSON.parse(sseEvent.data) as ChatSSEEvent;

                switch (chatData.type) {
                  case 'delta': {
                    // Append delta content to the assistant message
                    const deltaContent = chatData.content ?? '';
                    if (deltaContent) {
                      setMessages(prev => {
                        const updated = [...prev];
                        const idx = updated.findIndex(m => m.id === assistantId);
                        if (idx !== -1) {
                          updated[idx] = {
                            ...updated[idx],
                            content: updated[idx].content + deltaContent,
                          };
                        }
                        return updated;
                      });
                    }
                    break;
                  }

                  case 'finish': {
                    // Update assistant message with final content and usage
                    if (chatData.usage) {
                      setUsage(chatData.usage);
                    }
                    // Mark streaming as done on the message
                    setMessages(prev => {
                      const updated = [...prev];
                      const idx = updated.findIndex(m => m.id === assistantId);
                      if (idx !== -1) {
                        updated[idx] = {
                          ...updated[idx],
                          // Use finish content if present — it's the full text
                          content: chatData.content ?? updated[idx].content,
                          isStreaming: false,
                        };
                      }
                      return updated;
                    });
                    break;
                  }

                  case 'error': {
                    const errMsg = chatData.error ?? 'Unknown LLM error';
                    setError(errMsg);
                    setMessages(prev => {
                      const updated = [...prev];
                      const idx = updated.findIndex(m => m.id === assistantId);
                      if (idx !== -1) {
                        updated[idx] = {
                          ...updated[idx],
                          content: updated[idx].content || `Error: ${errMsg}`,
                          isStreaming: false,
                          isError: true,
                        };
                      }
                      return updated;
                    });
                    break;
                  }
                }
              } catch {
                // Skip malformed chat JSON
              }
              break;
            }

            case 'done': {
              try {
                const doneData = JSON.parse(sseEvent.data) as DoneSSEEvent;
                setTotalDurationMs(doneData.totalDurationMs);
                // Ensure assistant message has final content
                setMessages(prev => {
                  const updated = [...prev];
                  const idx = updated.findIndex(m => m.id === assistantId);
                  if (idx !== -1) {
                    updated[idx] = {
                      ...updated[idx],
                      content: doneData.fullResponse || updated[idx].content,
                      isStreaming: false,
                    };
                  }
                  return updated;
                });
              } catch {
                // "[DONE]" string or malformed JSON — stream is ending
              }
              break;
            }

            default:
              // Unknown event type — ignore
              break;
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled — mark assistant message as not streaming
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            updated[updated.length - 1] = {
              ...last,
              isStreaming: false,
              content: last.content || '(cancelled)',
            };
          }
          return updated;
        });
      } else {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        setError(errorMsg);
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: last.content || `Error: ${errorMsg}`,
              isStreaming: false,
              isError: true,
            };
          }
          return updated;
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [apiUrl, systemPrompt, provider, model, temperature, maxTokens]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearChat = useCallback(() => {
    // Don't allow clearing while streaming
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setMessages([]);
    setTraces([]);
    setError(null);
    setUsage(null);
    setTotalDurationMs(null);
    setIsStreaming(false);
  }, []);

  return {
    messages,
    traces,
    isStreaming,
    error,
    usage,
    totalDurationMs,
    sendMessage,
    stop,
    clearChat,
  };
}
