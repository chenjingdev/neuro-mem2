/**
 * Context Injector — injects formatted memory context into LLM API requests.
 *
 * Supports multiple API formats:
 *   - OpenAI Chat Completions API (messages array with system message)
 *   - Anthropic Messages API (system field + messages array)
 *   - Generic format (system prompt string)
 *
 * Injection strategies:
 *   - 'system_prepend': Prepend memory context to the system prompt
 *   - 'system_append': Append memory context to the system prompt
 *   - 'user_context': Insert as a user message before the last user message
 *   - 'dedicated_message': Insert as a separate system/assistant message
 *
 * The injector is format-agnostic — it works with plain JS objects and
 * does NOT import any LLM SDK. This ensures zero external dependencies
 * and compatibility with any HTTP proxy or middleware pipeline.
 */

import { ContextFormatter, type ContextFormatterConfig, type FormattedContext } from './context-formatter.js';
import type { MergedMemoryItem } from '../../retrieval/types.js';
import type { RecallResult } from '../../retrieval/dual-path-retriever.js';

// ─── Injection Strategy ──────────────────────────────────

export type InjectionStrategy =
  | 'system_prepend'
  | 'system_append'
  | 'user_context'
  | 'dedicated_message';

// ─── Configuration ───────────────────────────────────────

export interface ContextInjectorConfig {
  /** How to inject the memory context (default: 'system_prepend') */
  strategy: InjectionStrategy;
  /** Separator between memory context and existing content (default: '\n\n') */
  separator: string;
  /** Context formatter config */
  formatter?: Partial<ContextFormatterConfig>;
  /** Skip injection if no items (default: true) */
  skipIfEmpty: boolean;
}

export const DEFAULT_INJECTOR_CONFIG: ContextInjectorConfig = {
  strategy: 'system_prepend',
  separator: '\n\n',
  skipIfEmpty: true,
};

// ─── API Format Types (framework-agnostic) ───────────────

/** OpenAI-compatible chat message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'developer';
  content: string | ContentPart[];
  [key: string]: unknown;
}

/** Multimodal content part */
export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** OpenAI Chat Completions request (partial, relevant fields) */
export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  [key: string]: unknown;
}

/** Anthropic Messages API content block */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Anthropic Messages API message */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
}

/** Anthropic Messages API request (partial, relevant fields) */
export interface AnthropicMessagesRequest {
  model: string;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  [key: string]: unknown;
}

/** Injection result with metadata */
export interface InjectionResult<T> {
  /** The modified request */
  request: T;
  /** Information about what was injected */
  injection: {
    /** Whether context was actually injected */
    injected: boolean;
    /** The formatted context that was injected */
    formattedContext: FormattedContext | null;
    /** Which strategy was used */
    strategy: InjectionStrategy;
    /** Number of memory items included */
    itemCount: number;
  };
}

// ─── ContextInjector ─────────────────────────────────────

export class ContextInjector {
  private config: ContextInjectorConfig;
  private formatter: ContextFormatter;

  constructor(config?: Partial<ContextInjectorConfig>) {
    this.config = { ...DEFAULT_INJECTOR_CONFIG, ...config };
    this.formatter = new ContextFormatter(this.config.formatter);
  }

  // ── OpenAI Format ──────────────────────────────────────

  /**
   * Inject memory context into an OpenAI Chat Completions API request.
   *
   * Depending on strategy:
   * - system_prepend/system_append: Modifies or creates a system message
   * - user_context: Inserts a user message with memory context before last user message
   * - dedicated_message: Inserts a system message with memory context
   */
  injectOpenAI(
    request: OpenAIChatRequest,
    recallResult: RecallResult,
    config?: Partial<ContextInjectorConfig>,
  ): InjectionResult<OpenAIChatRequest> {
    return this.injectOpenAIFromItems(request, recallResult.items, config);
  }

  /**
   * Inject memory context from raw items into an OpenAI request.
   */
  injectOpenAIFromItems(
    request: OpenAIChatRequest,
    items: MergedMemoryItem[],
    config?: Partial<ContextInjectorConfig>,
  ): InjectionResult<OpenAIChatRequest> {
    const cfg = { ...this.config, ...config };
    const formatted = this.formatter.formatItems(items, cfg.formatter);

    if (cfg.skipIfEmpty && formatted.itemCount === 0) {
      return noInjection(request, cfg.strategy);
    }

    // Deep clone messages to avoid mutating the original
    const messages = structuredClone(request.messages);
    const result: OpenAIChatRequest = { ...request, messages };

    switch (cfg.strategy) {
      case 'system_prepend':
      case 'system_append': {
        const systemIdx = messages.findIndex(m => m.role === 'system' || m.role === 'developer');
        if (systemIdx >= 0) {
          const existing = getTextContent(messages[systemIdx].content);
          messages[systemIdx] = {
            ...messages[systemIdx],
            content: cfg.strategy === 'system_prepend'
              ? formatted.text + cfg.separator + existing
              : existing + cfg.separator + formatted.text,
          };
        } else {
          // Insert new system message at the beginning
          messages.unshift({ role: 'system', content: formatted.text });
        }
        break;
      }
      case 'user_context': {
        // Insert as user message before the last user message
        const lastUserIdx = findLastIndex(messages, m => m.role === 'user');
        const contextMsg: ChatMessage = {
          role: 'user',
          content: formatted.text,
        };
        if (lastUserIdx >= 0) {
          messages.splice(lastUserIdx, 0, contextMsg);
        } else {
          messages.unshift(contextMsg);
        }
        break;
      }
      case 'dedicated_message': {
        // Insert as system message after the first system message (or at beginning)
        const sysIdx = messages.findIndex(m => m.role === 'system' || m.role === 'developer');
        const insertAt = sysIdx >= 0 ? sysIdx + 1 : 0;
        messages.splice(insertAt, 0, { role: 'system', content: formatted.text });
        break;
      }
    }

    result.messages = messages;

    return {
      request: result,
      injection: {
        injected: true,
        formattedContext: formatted,
        strategy: cfg.strategy,
        itemCount: formatted.itemCount,
      },
    };
  }

  // ── Anthropic Format ───────────────────────────────────

  /**
   * Inject memory context into an Anthropic Messages API request.
   *
   * Anthropic has a dedicated `system` field (string or content blocks)
   * separate from the messages array.
   */
  injectAnthropic(
    request: AnthropicMessagesRequest,
    recallResult: RecallResult,
    config?: Partial<ContextInjectorConfig>,
  ): InjectionResult<AnthropicMessagesRequest> {
    return this.injectAnthropicFromItems(request, recallResult.items, config);
  }

  /**
   * Inject memory context from raw items into an Anthropic request.
   */
  injectAnthropicFromItems(
    request: AnthropicMessagesRequest,
    items: MergedMemoryItem[],
    config?: Partial<ContextInjectorConfig>,
  ): InjectionResult<AnthropicMessagesRequest> {
    const cfg = { ...this.config, ...config };
    const formatted = this.formatter.formatItems(items, cfg.formatter);

    if (cfg.skipIfEmpty && formatted.itemCount === 0) {
      return noInjection(request, cfg.strategy);
    }

    // Deep clone to avoid mutation
    const result: AnthropicMessagesRequest = structuredClone(request);

    switch (cfg.strategy) {
      case 'system_prepend':
      case 'system_append': {
        const existingSystem = getAnthropicSystemText(result.system);
        if (cfg.strategy === 'system_prepend') {
          result.system = existingSystem
            ? formatted.text + cfg.separator + existingSystem
            : formatted.text;
        } else {
          result.system = existingSystem
            ? existingSystem + cfg.separator + formatted.text
            : formatted.text;
        }
        break;
      }
      case 'user_context': {
        // Insert as user message before the last user message
        const lastUserIdx = findLastIndex(result.messages, m => m.role === 'user');
        const contextMsg: AnthropicMessage = {
          role: 'user',
          content: formatted.text,
        };
        if (lastUserIdx >= 0) {
          result.messages.splice(lastUserIdx, 0, contextMsg);
        } else {
          result.messages.unshift(contextMsg);
        }
        break;
      }
      case 'dedicated_message': {
        // For Anthropic, inject into system field as a block
        const existingSystem = getAnthropicSystemText(result.system);
        result.system = existingSystem
          ? existingSystem + cfg.separator + formatted.text
          : formatted.text;
        break;
      }
    }

    return {
      request: result,
      injection: {
        injected: true,
        formattedContext: formatted,
        strategy: cfg.strategy,
        itemCount: formatted.itemCount,
      },
    };
  }

  // ── Generic System Prompt ──────────────────────────────

  /**
   * Inject memory context into a plain system prompt string.
   * Returns the modified system prompt.
   */
  injectIntoSystemPrompt(
    systemPrompt: string,
    recallResult: RecallResult,
    config?: Partial<ContextInjectorConfig>,
  ): { systemPrompt: string; formattedContext: FormattedContext } {
    return this.injectIntoSystemPromptFromItems(systemPrompt, recallResult.items, config);
  }

  /**
   * Inject memory context from raw items into a plain system prompt.
   */
  injectIntoSystemPromptFromItems(
    systemPrompt: string,
    items: MergedMemoryItem[],
    config?: Partial<ContextInjectorConfig>,
  ): { systemPrompt: string; formattedContext: FormattedContext } {
    const cfg = { ...this.config, ...config };
    const formatted = this.formatter.formatItems(items, cfg.formatter);

    if (cfg.skipIfEmpty && formatted.itemCount === 0) {
      return { systemPrompt, formattedContext: formatted };
    }

    const strategy = cfg.strategy === 'system_prepend' || cfg.strategy === 'system_append'
      ? cfg.strategy
      : 'system_prepend'; // Default to prepend for non-message strategies

    const modified = strategy === 'system_prepend'
      ? formatted.text + cfg.separator + systemPrompt
      : systemPrompt + cfg.separator + formatted.text;

    return { systemPrompt: modified, formattedContext: formatted };
  }

  // ── Auto-detect Format ─────────────────────────────────

  /**
   * Auto-detect the API format and inject accordingly.
   * Examines the request shape to determine OpenAI vs Anthropic format.
   */
  injectAuto(
    request: Record<string, unknown>,
    recallResult: RecallResult,
    config?: Partial<ContextInjectorConfig>,
  ): InjectionResult<Record<string, unknown>> {
    return this.injectAutoFromItems(request, recallResult.items, config);
  }

  /**
   * Auto-detect format and inject from raw items.
   */
  injectAutoFromItems(
    request: Record<string, unknown>,
    items: MergedMemoryItem[],
    config?: Partial<ContextInjectorConfig>,
  ): InjectionResult<Record<string, unknown>> {
    if (isAnthropicRequest(request)) {
      return this.injectAnthropicFromItems(
        request as unknown as AnthropicMessagesRequest,
        items,
        config,
      ) as InjectionResult<Record<string, unknown>>;
    }

    if (isOpenAIRequest(request)) {
      return this.injectOpenAIFromItems(
        request as unknown as OpenAIChatRequest,
        items,
        config,
      ) as InjectionResult<Record<string, unknown>>;
    }

    // Fallback: try to find and modify a system prompt field
    const cfg = { ...this.config, ...config };
    const formatted = this.formatter.formatItems(items, cfg.formatter);

    if (cfg.skipIfEmpty && formatted.itemCount === 0) {
      return noInjection(request, cfg.strategy);
    }

    const result = structuredClone(request);

    // Try known system prompt fields
    for (const field of ['system', 'system_prompt', 'systemPrompt']) {
      if (typeof result[field] === 'string') {
        result[field] = cfg.strategy === 'system_append'
          ? (result[field] as string) + cfg.separator + formatted.text
          : formatted.text + cfg.separator + (result[field] as string);

        return {
          request: result,
          injection: {
            injected: true,
            formattedContext: formatted,
            strategy: cfg.strategy,
            itemCount: formatted.itemCount,
          },
        };
      }
    }

    // If no system field found, add one
    result.system = formatted.text;
    return {
      request: result,
      injection: {
        injected: true,
        formattedContext: formatted,
        strategy: cfg.strategy,
        itemCount: formatted.itemCount,
      },
    };
  }
}

// ─── Helper functions ────────────────────────────────────

function noInjection<T>(request: T, strategy: InjectionStrategy): InjectionResult<T> {
  return {
    request,
    injection: {
      injected: false,
      formattedContext: null,
      strategy,
      itemCount: 0,
    },
  };
}

function getTextContent(content: string | ContentPart[] | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: ContentPart) => p.type === 'text' && typeof p.text === 'string')
      .map((p: ContentPart) => p.text!)
      .join('\n');
  }
  return '';
}

function getAnthropicSystemText(system: string | AnthropicContentBlock[] | undefined): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text!)
      .join('\n');
  }
  return '';
}

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

function isOpenAIRequest(req: Record<string, unknown>): boolean {
  if (!Array.isArray(req.messages) || (req.messages as unknown[]).length === 0) return false;
  const messages = req.messages as ChatMessage[];
  const firstRole = messages[0]?.role;
  if (typeof firstRole !== 'string') return false;
  // OpenAI format: messages array may contain system/developer role messages
  const hasSystemMessage = messages.some(m => m.role === 'system' || m.role === 'developer');
  return hasSystemMessage || !('system' in req);
}

function isAnthropicRequest(req: Record<string, unknown>): boolean {
  // Anthropic requests have a top-level 'system' field (string or array)
  // and messages with only 'user'/'assistant' roles (no 'system' role in messages)
  if (!Array.isArray(req.messages)) return false;
  const hasTopLevelSystem = 'system' in req;
  const messages = req.messages as ChatMessage[];
  const hasSystemMessage = messages.some(m => m.role === 'system' || m.role === 'developer');
  return hasTopLevelSystem && !hasSystemMessage;
}
