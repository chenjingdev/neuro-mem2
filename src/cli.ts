#!/usr/bin/env node
/**
 * CLI Entrypoint — starts the nero-mem2 API server with Visual Debug Chat App.
 *
 * Usage:
 *   npx tsx src/cli.ts
 *   node dist/cli.js
 *   npm start          (after npm run build)
 *   npm run dev        (via tsx, no build needed)
 *
 * Environment:
 *   PORT=3030        — Server port (default: 3030)
 *   DB_PATH=nero.db  — SQLite database path (default: ./nero.db)
 */

import { createDatabase } from './db/connection.js';
import { ConversationRepository } from './db/conversation-repo.js';
import { IngestService } from './services/ingest.js';
import { EventBus } from './events/event-bus.js';
import { startServer } from './api/server.js';
import { loadAuthCredentials } from './chat/auth-loader.js';
import { initChatDb } from './chat/db/connection.js';
import { OpenAILLMProvider } from './extraction/openai-llm-provider.js';
import { AnthropicLLMProvider } from './extraction/anthropic-llm-provider.js';
import { MockLLMProvider } from './extraction/llm-provider.js';
import type { LLMProvider } from './extraction/llm-provider.js';

const port = parseInt(process.env['PORT'] ?? '3030', 10);
const dbPath = process.env['DB_PATH'] ?? './nero.db';

// ── Database ──
const db = createDatabase({ path: dbPath });
const conversationRepo = new ConversationRepository(db);

// ── Event Bus ──
const eventBus = new EventBus();

// ── Ingest Service ──
const ingestService = new IngestService(conversationRepo, eventBus);

// ── Chat DB (separate SQLite for debug chat data) ──
const chatDb = initChatDb();

// ── Auth & LLM Provider ──
const auth = loadAuthCredentials();
let llmProvider: LLMProvider;

if (auth) {
  const provider = auth.defaultProvider ?? 'openai';
  console.log(`[nero-mem2] Auth loaded from: ${auth.sourcePath}`);
  console.log(`[nero-mem2] Provider: ${provider}`);

  if (provider === 'anthropic' && auth.anthropicApiKey) {
    llmProvider = new AnthropicLLMProvider({ apiKey: auth.anthropicApiKey });
  } else if (auth.openaiApiKey) {
    llmProvider = new OpenAILLMProvider({ apiKey: auth.openaiApiKey });
  } else {
    console.log('[nero-mem2] Auth found but no usable API key — using mock LLM provider');
    llmProvider = new MockLLMProvider();
  }
} else {
  console.log('[nero-mem2] No auth.json found — using mock LLM provider');
  console.log('[nero-mem2] To enable real LLM: create ~/.nero-mem/auth.json or ~/.codex/auth.json');
  llmProvider = new MockLLMProvider();
}

// ── Start Server ──
startServer(
  {
    ingestService,
    db,
    auth: false,       // localhost debug — no API key auth
    rateLimit: false,   // localhost debug — no rate limiting
    chatDeps: {
      llmProvider,
      chatDb,
      eventBus,
      ingestService,
    },
    chatDb,
  },
  { port, hostname: '127.0.0.1' },
);

console.log('');
console.log(`[nero-mem2] Server running on http://127.0.0.1:${port}`);
console.log(`[nero-mem2] DB: ${dbPath}`);
console.log('');
console.log('  Endpoints:');
console.log('  POST /ingest            Ingest conversation');
console.log('  POST /ingest/append     Append message');
console.log('  POST /recall            Recall memories');
console.log('  POST /api/chat          Debug chat (SSE stream)');
console.log('  GET  /api/sessions      List chat sessions');
console.log('  GET  /api/conversations List conversations');
console.log('  GET  /health            Health check');
console.log('');
console.log('  Debug Chat UI:');
console.log('    cd web && npm install && npm run dev');
console.log('    → http://localhost:5173');
