/**
 * Request Parser — extracts user messages from intercepted LLM API requests.
 *
 * Supports multiple API formats:
 *   - OpenAI Chat Completions (messages array with role/content)
 *   - Anthropic Messages API (messages array + system)
 *   - Generic/custom formats (configurable extractor)
 *
 * The parser is purely functional — no side effects, no DB access.
 * It transforms raw request bodies into a normalized ParsedRequest.
 */

// ─── API Format Detection ────────────────────────────────

/** Supported API formats */
export type ApiFormat = 'openai' | 'anthropic' | 'generic';

/** A single message extracted from the request */
export interface ParsedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Index in the original messages array */
  index: number;
}

/** Result of parsing a request body */
export interface ParsedRequest {
  /** Detected API format */
  format: ApiFormat;
  /** All messages in the conversation (normalized) */
  messages: ParsedMessage[];
  /** The latest user message (used as query for retrieval) */
  latestUserMessage: string | null;
  /** System prompt if present */
  systemPrompt: string | null;
  /** Model identifier from the request */
  model: string | null;
  /** Whether the request appears to be a streaming request */
  stream: boolean;
  /** Raw body preserved for later forwarding */
  rawBody: unknown;
}

/** Configuration for custom format extraction */
export interface RequestParserConfig {
  /** Override format detection */
  forceFormat?: ApiFormat;
  /** Custom extractor for unsupported formats */
  customExtractor?: (body: unknown) => ParsedRequest | null;
  /** Maximum number of trailing user messages to concatenate for query */
  maxQueryMessages?: number;
}

export const DEFAULT_PARSER_CONFIG: RequestParserConfig = {
  maxQueryMessages: 1,
};

// ─── OpenAI Types ────────────────────────────────────────

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: unknown }> | null;
  name?: string;
}

interface OpenAIRequestBody {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

// ─── Anthropic Types ─────────────────────────────────────

interface AnthropicMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; source?: unknown }>;
}

interface AnthropicRequestBody {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  stream?: boolean;
  max_tokens?: number;
  [key: string]: unknown;
}

// ─── Format Detection ────────────────────────────────────

/**
 * Detect the API format from the request body structure.
 *
 * Heuristics:
 *   - Anthropic: has `max_tokens` field (required in Anthropic API)
 *   - OpenAI: has `messages` array without `max_tokens` requirement
 *   - Generic: fallback
 */
export function detectApiFormat(body: unknown): ApiFormat {
  if (!body || typeof body !== 'object') return 'generic';
  const obj = body as Record<string, unknown>;

  // Anthropic Messages API always requires max_tokens
  if ('max_tokens' in obj && 'messages' in obj) {
    return 'anthropic';
  }

  // OpenAI Chat Completions API has messages array
  if ('messages' in obj && Array.isArray(obj.messages)) {
    return 'openai';
  }

  return 'generic';
}

// ─── OpenAI Parser ───────────────────────────────────────

/**
 * Extract text content from an OpenAI message content field.
 * Handles both string content and content array (multimodal).
 */
export function extractOpenAIContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text!)
      .join('\n');
  }
  return '';
}

function normalizeRole(role: string): ParsedMessage['role'] {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'system': return 'system';
    // OpenAI 'developer' role maps to system
    case 'developer': return 'system';
    // OpenAI 'tool'/'function' results map to assistant
    case 'tool':
    case 'function':
      return 'assistant';
    default:
      return 'user';
  }
}

function parseOpenAI(body: OpenAIRequestBody): ParsedRequest {
  const messages: ParsedMessage[] = [];
  let systemPrompt: string | null = null;

  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i]!;
      const role = normalizeRole(msg.role);
      const content = extractOpenAIContent(msg.content);

      if (role === 'system' && i === 0 && !systemPrompt) {
        systemPrompt = content;
      }

      messages.push({ role, content, index: i });
    }
  }

  return {
    format: 'openai',
    messages,
    latestUserMessage: null, // filled by parseRequest
    systemPrompt,
    model: body.model ?? null,
    stream: body.stream === true,
    rawBody: body,
  };
}

// ─── Anthropic Parser ────────────────────────────────────

function extractAnthropicContent(content: AnthropicMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text!)
      .join('\n');
  }
  return '';
}

function extractAnthropicSystem(system: AnthropicRequestBody['system']): string | null {
  if (!system) return null;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text!)
      .join('\n') || null;
  }
  return null;
}

function parseAnthropic(body: AnthropicRequestBody): ParsedRequest {
  const messages: ParsedMessage[] = [];
  const systemPrompt = extractAnthropicSystem(body.system);

  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i]!;
      // Anthropic only allows 'user' and 'assistant' roles in messages
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const content = extractAnthropicContent(msg.content);
      messages.push({ role, content, index: i });
    }
  }

  return {
    format: 'anthropic',
    messages,
    latestUserMessage: null, // filled by parseRequest
    systemPrompt,
    model: body.model ?? null,
    stream: body.stream === true,
    rawBody: body,
  };
}

// ─── Main Parser ─────────────────────────────────────────

/**
 * Parse an intercepted LLM API request body.
 *
 * Detects the API format, extracts messages, and identifies the
 * latest user message that should be used as a retrieval query.
 *
 * @param body - Raw JSON body from the intercepted request
 * @param config - Optional parser configuration
 * @returns Parsed request with normalized messages and query text
 */
export function parseRequest(
  body: unknown,
  config: RequestParserConfig = DEFAULT_PARSER_CONFIG,
): ParsedRequest {
  // Try custom extractor first
  if (config.customExtractor) {
    const result = config.customExtractor(body);
    if (result) return result;
  }

  const format = config.forceFormat ?? detectApiFormat(body);

  let parsed: ParsedRequest;

  switch (format) {
    case 'openai':
      parsed = parseOpenAI(body as OpenAIRequestBody);
      break;
    case 'anthropic':
      parsed = parseAnthropic(body as AnthropicRequestBody);
      break;
    case 'generic':
    default:
      parsed = {
        format: 'generic',
        messages: [],
        latestUserMessage: null,
        systemPrompt: null,
        model: null,
        stream: false,
        rawBody: body,
      };
      break;
  }

  // Extract latest user message(s) for retrieval query
  parsed.latestUserMessage = extractLatestUserQuery(
    parsed.messages,
    config.maxQueryMessages ?? 1,
  );

  return parsed;
}

/**
 * Extract the latest user message(s) to use as the retrieval query.
 *
 * When maxMessages > 1, concatenates the last N user messages
 * (useful when a user asks a follow-up referencing earlier messages).
 */
export function extractLatestUserQuery(
  messages: ParsedMessage[],
  maxMessages: number = 1,
): string | null {
  const userMessages = messages.filter(m => m.role === 'user' && m.content.trim());

  if (userMessages.length === 0) return null;

  const count = Math.min(maxMessages, userMessages.length);
  const latest = userMessages.slice(-count);

  return latest.map(m => m.content).join('\n');
}
