/**
 * useChatStream — Unified React hook composing SSE streaming chat + trace timeline.
 *
 * This hook bridges useChat (SSE fetch streaming) and useTimeline (per-message
 * trace session management) into a single API that:
 *
 *   1. Sends POST /api/chat and reads the SSE stream (fetch + ReadableStream)
 *   2. Routes event:trace → addTrace (timeline session)
 *   3. Routes event:chat  → updates assistant message content (delta/finish/error)
 *   4. Routes event:done  → completes the trace session with final stats
 *   5. Manages full Session lifecycle (startSession / endSession per message pair)
 *
 * Usage:
 * ```tsx
 * const {
 *   messages, isStreaming, sendMessage, stop, clearChat,
 *   sessions, selectedTraces, selectMessage,
 * } = useChatStream();
 * ```
 */

import { useState, useRef, useCallback } from 'react';
import type {
  ChatMessage,
  TraceEvent,
  ChatSSEEvent,
  DoneSSEEvent,
  TraceSession,
} from '../types';
import { parseSSEChunk } from './sse-parser';
import { useTimeline } from './useTimeline';

// ─── Types ──────────────────────────────────────────────────

export interface UseChatStreamOptions {
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

export interface UseChatStreamReturn {
  // ─── Chat State ───
  /** All chat messages (user + assistant) */
  messages: ChatMessage[];
  /** Whether a streaming request is in progress */
  isStreaming: boolean;
  /** Error message from the last request, if any */
  error: string | null;
  /** Token usage from the last completed response */
  usage: ChatSSEEvent['usage'] | null;
  /** Total pipeline duration from the last request */
  totalDurationMs: number | null;
  /** Whether the session has been ended */
  isSessionEnded: boolean;
  /** Whether a session end request is in progress */
  isEndingSession: boolean;

  // ─── Chat Actions ───
  /** Send a new message — triggers SSE stream and starts a trace session */
  sendMessage: (content: string) => void;
  /** Abort the current streaming request */
  stop: () => void;
  /** Clear all messages, traces, and sessions */
  clearChat: () => void;
  /** End the current session — triggers batch extraction */
  endSession: () => Promise<void>;

  // ─── Timeline State ───
  /** All trace sessions keyed by message ID */
  sessions: Map<string, TraceSession>;
  /** Currently selected message ID (for timeline display) */
  selectedMessageId: string | null;
  /** Traces for the currently selected message */
  selectedTraces: TraceEvent[];
  /** The active trace session (if currently selected) */
  selectedSession: TraceSession | null;
  /** Deduplicated list of all sessions */
  sessionList: TraceSession[];

  // ─── Timeline Actions ───
  /** Select a message to view its trace timeline */
  selectMessage: (messageId: string | null) => void;
  /** Check if a message has trace data */
  hasTraces: (messageId: string) => boolean;
  /** Get traces for a specific message */
  getTracesForMessage: (messageId: string) => TraceEvent[];
}

// ─── ID Generator ───────────────────────────────────────────

let nextId = 1;
function generateId(): string {
  return `msg-${Date.now()}-${nextId++}`;
}

// ─── Hook ───────────────────────────────────────────────────

export function useChatStream(options: UseChatStreamOptions = {}): UseChatStreamReturn {
  const {
    apiUrl = '/api/chat',
    systemPrompt,
    provider,
    model,
    temperature,
    maxTokens,
  } = options;

  // ─── Chat state ───
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatSSEEvent['usage'] | null>(null);
  const [totalDurationMs, setTotalDurationMs] = useState<number | null>(null);
  const [isSessionEnded, setIsSessionEnded] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  // ─── Timeline integration ───
  const timeline = useTimeline();

  // ─── sendMessage: orchestrates fetch → SSE → timeline lifecycle ───
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      // Clear previous request state
      setError(null);
      setUsage(null);
      setTotalDurationMs(null);

      // Create user + assistant message pair
      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: content.trim(),
        timestamp: Date.now(),
      };

      const assistantMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      // ── Start trace session for this message pair ──
      timeline.startSession(userMsg.id, assistantMsg.id);

      // Build history from previous messages
      const currentMessages = messagesRef.current;
      const history = currentMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      // Build request body
      const requestBody: Record<string, unknown> = {
        message: content.trim(),
      };
      if (history.length > 0) requestBody.history = history;
      if (systemPrompt) requestBody.systemPrompt = systemPrompt;
      if (provider) requestBody.provider = provider;
      if (model) requestBody.model = model;
      if (temperature !== undefined) requestBody.temperature = temperature;
      if (maxTokens !== undefined) requestBody.maxTokens = maxTokens;

      // Create abort controller
      const controller = new AbortController();
      abortRef.current = controller;

      const assistantId = assistantMsg.id;
      const userMsgId = userMsg.id;
      let finalUsage: ChatSSEEvent['usage'] | null = null;
      let finalDuration: number | null = null;

      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!response.ok) {
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

        // ── Read the SSE stream ──
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const { events, remaining } = parseSSEChunk(buffer);
          buffer = remaining;

          for (const sseEvent of events) {
            switch (sseEvent.event) {
              // ── event:trace → route to timeline ──
              case 'trace': {
                try {
                  const traceData = JSON.parse(sseEvent.data) as TraceEvent;
                  timeline.addTrace(traceData);
                } catch {
                  // Skip malformed trace JSON
                }
                break;
              }

              // ── event:chat → update assistant message ──
              case 'chat': {
                try {
                  const chatData = JSON.parse(sseEvent.data) as ChatSSEEvent;

                  switch (chatData.type) {
                    case 'delta': {
                      const deltaContent = chatData.content ?? '';
                      if (deltaContent) {
                        setMessages((prev) => {
                          const updated = [...prev];
                          const idx = updated.findIndex((m) => m.id === assistantId);
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
                      if (chatData.usage) {
                        finalUsage = chatData.usage;
                        setUsage(chatData.usage);
                      }
                      setMessages((prev) => {
                        const updated = [...prev];
                        const idx = updated.findIndex((m) => m.id === assistantId);
                        if (idx !== -1) {
                          updated[idx] = {
                            ...updated[idx],
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
                      setMessages((prev) => {
                        const updated = [...prev];
                        const idx = updated.findIndex((m) => m.id === assistantId);
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

              // ── event:done → complete trace session ──
              case 'done': {
                try {
                  const doneData = JSON.parse(sseEvent.data) as DoneSSEEvent;
                  finalDuration = doneData.totalDurationMs;
                  setTotalDurationMs(doneData.totalDurationMs);

                  // Ensure assistant message has final content
                  setMessages((prev) => {
                    const updated = [...prev];
                    const idx = updated.findIndex((m) => m.id === assistantId);
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
                  // "[DONE]" string or malformed JSON
                }
                break;
              }

              default:
                break;
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // User cancelled
          setMessages((prev) => {
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
          setMessages((prev) => {
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
        // ── End trace session ──
        timeline.completeSession(userMsgId, finalDuration, finalUsage);

        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [apiUrl, systemPrompt, provider, model, temperature, maxTokens, timeline],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ─── endSession: end current session via SSE streaming with batch extraction traces ───
  const endSession = useCallback(
    async () => {
      if (isSessionEnded || isEndingSession || isStreaming) return;

      setIsEndingSession(true);
      setError(null);

      // Determine the API base from apiUrl (e.g., '/api/chat' -> '/api')
      const apiBase = apiUrl.replace(/\/chat$/, '');

      // Create a trace session for the session end pipeline visualization
      const endSessionMsgId = generateId();
      const endSessionAssistantId = generateId();
      timeline.startSession(endSessionMsgId, endSessionAssistantId);

      // Emit session_end:start trace locally
      timeline.addTrace({
        stage: 'session_end',
        status: 'start',
        data: { reason: 'explicit' },
        timestamp: new Date().toISOString(),
      });

      const endStart = performance.now();

      try {
        // Use the SSE streaming endpoint for real-time batch extraction traces
        // Use 'current' as session ID — the backend finds the most recent active session
        const response = await fetch(`${apiBase}/sessions/current/end-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          const endDuration = Math.round(performance.now() - endStart);
          let errorText: string;
          try {
            const errorBody = await response.json();
            errorText = errorBody.message ?? errorBody.error ?? `HTTP ${response.status}`;
          } catch {
            errorText = `Session end failed: ${response.status}`;
          }

          timeline.addTrace({
            stage: 'session_end',
            status: 'error',
            durationMs: endDuration,
            data: { error: errorText },
            timestamp: new Date().toISOString(),
          });

          setError(errorText);
          timeline.completeSession(endSessionMsgId, endDuration, null);
          return;
        }

        if (!response.body) {
          throw new Error('Response body is empty — SSE streaming not supported');
        }

        // Read the SSE stream — batch extraction traces arrive in real-time
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let hasBatchExtraction = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseSSEChunk(buffer);
          buffer = remaining;

          for (const sseEvent of events) {
            if (sseEvent.event === 'trace') {
              try {
                const traceData = JSON.parse(sseEvent.data) as TraceEvent;
                timeline.addTrace(traceData);
                if (traceData.stage === 'batch_extraction') {
                  hasBatchExtraction = true;
                }
              } catch {
                // Skip malformed trace JSON
              }
            } else if (sseEvent.event === 'done') {
              // Session end complete — emit session_end:complete
              const endDuration = Math.round(performance.now() - endStart);
              timeline.addTrace({
                stage: 'session_end',
                status: 'complete',
                durationMs: endDuration,
                data: { result: sseEvent.data },
                timestamp: new Date().toISOString(),
              });
            }
          }
        }

        // Complete the trace session
        const totalDuration = Math.round(performance.now() - endStart);
        timeline.completeSession(endSessionMsgId, totalDuration, null);

        setIsSessionEnded(true);

        // Add a system message indicating session ended
        const systemMsg: ChatMessage = {
          id: generateId(),
          role: 'system',
          content: `Session ended${hasBatchExtraction ? ' — batch extraction triggered' : ''}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, systemMsg]);
      } catch (err: unknown) {
        const endDuration = Math.round(performance.now() - endStart);
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';

        timeline.addTrace({
          stage: 'session_end',
          status: 'error',
          durationMs: endDuration,
          data: { error: errorMsg },
          timestamp: new Date().toISOString(),
        });

        setError(errorMsg);
        timeline.completeSession(endSessionMsgId, endDuration, null);
      } finally {
        setIsEndingSession(false);
      }
    },
    [apiUrl, isSessionEnded, isEndingSession, isStreaming, timeline],
  );

  const clearChat = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setMessages([]);
    setError(null);
    setUsage(null);
    setTotalDurationMs(null);
    setIsStreaming(false);
    setIsSessionEnded(false);
    setIsEndingSession(false);
    timeline.clearAll();
  }, [timeline]);

  return {
    // Chat state
    messages,
    isStreaming,
    error,
    usage,
    totalDurationMs,
    isSessionEnded,
    isEndingSession,

    // Chat actions
    sendMessage,
    stop,
    clearChat,
    endSession,

    // Timeline state (delegated from useTimeline)
    sessions: timeline.sessions,
    selectedMessageId: timeline.selectedMessageId,
    selectedTraces: timeline.selectedTraces,
    selectedSession: timeline.selectedSession,
    sessionList: timeline.sessionList,

    // Timeline actions
    selectMessage: timeline.selectMessage,
    hasTraces: timeline.hasTraces,
    getTracesForMessage: timeline.getTracesForMessage,
  };
}
