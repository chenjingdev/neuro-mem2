/**
 * Context Injector — injects retrieved memory context into API request bodies.
 *
 * Supports two API formats:
 *   - Anthropic Messages API: POST /v1/messages { system, messages }
 *   - OpenAI Chat API: POST /v1/chat/completions { messages: [{ role: "system", ... }] }
 *
 * Memory context is prepended to the system prompt using a configurable template.
 */

import type { MergedMemoryItem } from '../retrieval/types.js';
import type { TargetProvider } from './config.js';

// ─── Types ───────────────────────────────────────────────

export interface InjectionResult {
  /** Modified request body */
  body: unknown;
  /** Number of memories injected */
  memoriesInjected: number;
  /** Whether the body was modified */
  modified: boolean;
  /** The formatted memory context string */
  contextBlock: string;
}

export interface InjectionOptions {
  /** Template string. {{memories}} is replaced with formatted memories. */
  template: string;
  /** Maximum number of memories to include */
  maxMemories: number;
  /** Target provider format */
  provider: TargetProvider;
}

// ─── Memory Formatting ──────────────────────────────────

/**
 * Format memory items into a readable text block for injection.
 */
export function formatMemories(items: MergedMemoryItem[], maxCount: number): string {
  const selected = items.slice(0, maxCount);
  if (selected.length === 0) return '';

  return selected
    .map((item, i) => {
      const typeLabel = item.nodeType.charAt(0).toUpperCase() + item.nodeType.slice(1);
      const score = (item.score * 100).toFixed(0);
      return `[${i + 1}] (${typeLabel}, relevance: ${score}%) ${item.content}`;
    })
    .join('\n');
}

/**
 * Build the full context block from template and formatted memories.
 */
export function buildContextBlock(
  template: string,
  memories: MergedMemoryItem[],
  maxCount: number,
): string {
  const formatted = formatMemories(memories, maxCount);
  if (!formatted) return '';
  return template.replace('{{memories}}', formatted);
}

// ─── Anthropic Format Injection ──────────────────────────

interface AnthropicBody {
  system?: string | Array<{ type: string; text: string }>;
  messages?: unknown[];
  [key: string]: unknown;
}

function injectAnthropicSystem(body: AnthropicBody, contextBlock: string): AnthropicBody {
  const result = { ...body };

  if (typeof result.system === 'string') {
    // Prepend to existing string system prompt
    result.system = contextBlock + '\n\n' + result.system;
  } else if (Array.isArray(result.system)) {
    // Prepend as first text block
    result.system = [
      { type: 'text', text: contextBlock },
      ...result.system,
    ];
  } else {
    // No system prompt yet — add one
    result.system = contextBlock;
  }

  return result;
}

// ─── OpenAI Format Injection ─────────────────────────────

interface OpenAIMessage {
  role: string;
  content: string | unknown[];
  [key: string]: unknown;
}

interface OpenAIBody {
  messages?: OpenAIMessage[];
  [key: string]: unknown;
}

function injectOpenAISystem(body: OpenAIBody, contextBlock: string): OpenAIBody {
  const result = { ...body };
  const messages = [...(result.messages || [])];

  if (messages.length > 0 && messages[0]?.role === 'system') {
    // Prepend to existing system message
    const sysMsg = { ...messages[0] };
    if (typeof sysMsg.content === 'string') {
      sysMsg.content = contextBlock + '\n\n' + sysMsg.content;
    }
    messages[0] = sysMsg;
  } else {
    // Insert new system message at the beginning
    messages.unshift({ role: 'system', content: contextBlock });
  }

  result.messages = messages;
  return result;
}

// ─── Main Injection Function ─────────────────────────────

/**
 * Inject memory context into an API request body.
 *
 * @param body - The original parsed request body
 * @param memories - Retrieved memory items to inject
 * @param options - Injection options (template, max, provider)
 * @returns The injection result with modified body
 */
export function injectMemoryContext(
  body: unknown,
  memories: MergedMemoryItem[],
  options: InjectionOptions,
): InjectionResult {
  if (!memories || memories.length === 0 || !body || typeof body !== 'object') {
    return {
      body,
      memoriesInjected: 0,
      modified: false,
      contextBlock: '',
    };
  }

  const contextBlock = buildContextBlock(options.template, memories, options.maxMemories);
  if (!contextBlock) {
    return {
      body,
      memoriesInjected: 0,
      modified: false,
      contextBlock: '',
    };
  }

  const count = Math.min(memories.length, options.maxMemories);
  let modifiedBody: unknown;

  switch (options.provider) {
    case 'anthropic':
      modifiedBody = injectAnthropicSystem(body as AnthropicBody, contextBlock);
      break;
    case 'openai':
      modifiedBody = injectOpenAISystem(body as OpenAIBody, contextBlock);
      break;
    case 'custom':
      // For custom providers, try OpenAI format (most common)
      if (hasMessages(body)) {
        modifiedBody = injectOpenAISystem(body as OpenAIBody, contextBlock);
      } else {
        modifiedBody = injectAnthropicSystem(body as AnthropicBody, contextBlock);
      }
      break;
    default:
      modifiedBody = body;
  }

  return {
    body: modifiedBody,
    memoriesInjected: count,
    modified: true,
    contextBlock,
  };
}

function hasMessages(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'messages' in body &&
    Array.isArray((body as Record<string, unknown>)['messages'])
  );
}

// ─── Query Extraction ────────────────────────────────────

/**
 * Extract the user's query text from an API request body for memory retrieval.
 * Returns the content of the last user message.
 */
export function extractQueryFromBody(body: unknown, provider: TargetProvider): string | null {
  if (!body || typeof body !== 'object') return null;

  const b = body as Record<string, unknown>;

  // Both Anthropic and OpenAI use messages array
  const messages = b['messages'];
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.['role'] === 'user') {
      const content = msg['content'];
      if (typeof content === 'string') return content;
      // Handle Anthropic's content blocks
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((b: unknown) => (b as Record<string, unknown>)?.['type'] === 'text')
          .map((b: unknown) => (b as Record<string, unknown>)?.['text'] as string)
          .filter(Boolean);
        return textBlocks.join(' ') || null;
      }
      return null;
    }
  }

  return null;
}
