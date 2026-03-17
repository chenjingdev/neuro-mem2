import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  complete as piComplete,
  getModels,
  stream as piStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ProviderStreamOptions,
  type Usage,
} from '@mariozechner/pi-ai';
import {
  getOAuthApiKey,
  type OAuthCredentials,
} from '@mariozechner/pi-ai/oauth';

import type { CodexOAuthCredentials } from '../chat/auth-loader.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from './llm-provider.js';

export interface OpenAICodexProviderConfig {
  model?: string;
  authJsonPath?: string;
  credentials?: CodexOAuthCredentials;
  transport?: 'sse' | 'websocket' | 'auto';
}

type PersistedAuthFile = Record<string, unknown>;

const DEFAULT_MODEL = 'gpt-5.4';
const PROVIDER_ID = 'openai-codex';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOAuthCredentials(credentials: CodexOAuthCredentials): OAuthCredentials {
  return {
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
  };
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function toUsage(message: AssistantMessage):
  | { promptTokens: number; completionTokens: number; totalTokens: number }
  | undefined {
  const usage = message.usage;
  if (!usage) return undefined;

  return {
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
  };
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function toPiAiMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: Model<any>,
): Message[] {
  const baseTimestamp = Date.now();

  return messages.map((message, index) => {
    const timestamp = baseTimestamp + index;

    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.content,
        timestamp,
      };
    }

    return {
      role: 'assistant',
      content: [{ type: 'text', text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: 'stop',
      timestamp,
    };
  });
}

function resolveModel(modelId?: string): Model<any> {
  const models = getModels(PROVIDER_ID);
  const selectedId = modelId ?? DEFAULT_MODEL;
  const selected = models.find((model) => model.id === selectedId);

  if (selected) {
    return selected;
  }
  if (models[0]) {
    return models[0];
  }

  throw new Error('No OpenAI Codex models available in pi-ai registry');
}

function readPersistedAuthFile(filePath: string): PersistedAuthFile | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function persistCodexCredentials(
  filePath: string,
  credentials: OAuthCredentials,
): void {
  const existing = readPersistedAuthFile(filePath) ?? {};

  if (isRecord(existing[PROVIDER_ID])) {
    const next = {
      ...existing,
      [PROVIDER_ID]: {
        ...existing[PROVIDER_ID],
        type: 'oauth',
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
        ...(typeof credentials.accountId === 'string' && credentials.accountId
          ? { accountId: credentials.accountId }
          : {}),
      },
    };

    writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    return;
  }

  const nextTokens = isRecord(existing['tokens']) ? { ...existing['tokens'] } : {};
  nextTokens['access_token'] = credentials.access;
  nextTokens['refresh_token'] = credentials.refresh;
  if (typeof credentials.accountId === 'string' && credentials.accountId) {
    nextTokens['account_id'] = credentials.accountId;
  }

  const next = {
    ...existing,
    auth_mode: typeof existing['auth_mode'] === 'string' ? existing['auth_mode'] : 'chatgpt',
    tokens: nextTokens,
    last_refresh: new Date().toISOString(),
  };

  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

export class OpenAICodexLLMProvider implements LLMProvider {
  readonly name = PROVIDER_ID;

  private readonly defaultModelId: string;
  private readonly authJsonPath?: string;
  private readonly transport: OpenAICodexProviderConfig['transport'];
  private credentials?: OAuthCredentials;

  constructor(config: OpenAICodexProviderConfig = {}) {
    this.defaultModelId = config.model ?? DEFAULT_MODEL;
    this.authJsonPath = config.authJsonPath;
    this.transport = config.transport ?? 'auto';
    this.credentials = config.credentials ? toOAuthCredentials(config.credentials) : undefined;
  }

  private async resolveApiKey(): Promise<string> {
    if (!this.credentials) {
      throw new Error('OpenAI Codex credentials not configured');
    }

    const result = await getOAuthApiKey(PROVIDER_ID, {
      [PROVIDER_ID]: this.credentials,
    });

    if (!result) {
      throw new Error('OpenAI Codex OAuth credentials not available');
    }

    this.credentials = result.newCredentials;

    if (this.authJsonPath) {
      persistCodexCredentials(this.authJsonPath, result.newCredentials);
    }

    return result.apiKey;
  }

  private buildContext(
    request: LLMCompletionRequest | LLMStreamRequest,
    model: Model<any>,
  ): Context {
    const userContent =
      'prompt' in request
        ? [{ role: 'user' as const, content: request.prompt }]
        : request.messages;

    return {
      systemPrompt: request.system,
      messages: toPiAiMessages(userContent, model),
    };
  }

  private buildStreamOptions(
    request: LLMCompletionRequest | LLMStreamRequest,
    apiKey: string,
  ): ProviderStreamOptions {
    const options: ProviderStreamOptions = {
      apiKey,
      transport: this.transport,
    };

    if (request.maxTokens !== undefined) {
      options.maxTokens = request.maxTokens;
    }
    if ('sessionId' in request && request.sessionId) {
      options.sessionId = request.sessionId;
    }

    return options;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const apiKey = await this.resolveApiKey();
    const model = resolveModel(request.model ?? this.defaultModelId);
    const message = await piComplete(
      model,
      this.buildContext(request, model),
      this.buildStreamOptions(request, apiKey),
    );

    return {
      content: extractText(message),
      usage: toUsage(message),
    };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    const apiKey = await this.resolveApiKey();
    const model = resolveModel(request.model ?? this.defaultModelId);
    const responseStream = piStream(
      model,
      this.buildContext(request, model),
      this.buildStreamOptions(request, apiKey),
    );

    for await (const event of responseStream) {
      switch (event.type) {
        case 'text_delta':
          yield { type: 'delta', content: event.delta };
          break;

        case 'done':
          yield {
            type: 'finish',
            content: extractText(event.message),
            usage: toUsage(event.message),
          };
          break;

        case 'error':
          yield {
            type: 'error',
            error: event.error.errorMessage ?? 'OpenAI Codex stream failed',
          };
          break;
      }
    }
  }
}
