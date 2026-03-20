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
import { openChatDatabase } from './chat/db/connection.js';
import { OpenAILLMProvider } from './extraction/openai-llm-provider.js';
import { OpenAICodexLLMProvider } from './extraction/openai-codex-llm-provider.js';
import { AnthropicLLMProvider } from './extraction/anthropic-llm-provider.js';
import { MockLLMProvider } from './extraction/llm-provider.js';
import type { LLMProvider } from './extraction/llm-provider.js';
import { FactExtractor } from './extraction/fact-extractor.js';
import { FactRepository } from './db/fact-repo.js';
import { MemoryNodeRepository } from './db/memory-node-repo.js';
import { WeightedEdgeRepository } from './db/weighted-edge-repo.js';
import { DualPathRetriever } from './retrieval/dual-path-retriever.js';
import { MockEmbeddingProvider } from './retrieval/embedding-provider.js';
import { TurnExtractionPipeline } from './services/turn-extraction-pipeline.js';

const port = parseInt(process.env['PORT'] ?? '3030', 10);
const dbPath = process.env['DB_PATH'] ?? './nero.db';

// ── Database ──
const db = createDatabase({ dbPath });
const conversationRepo = new ConversationRepository(db);

// ── Event Bus ──
const eventBus = new EventBus();

// ── Ingest Service ──
const ingestService = new IngestService(conversationRepo, eventBus);

// ── Chat DB (separate SQLite for debug chat data) ──
const chatDb = openChatDatabase();

// ── Auth & LLM Provider ──
const auth = loadAuthCredentials();
let llmProvider: LLMProvider;

if (auth) {
  console.log(`[nero-mem2] Auth loaded from: ${auth.sourcePath}`);

  if (auth.codexOAuth) {
    console.log('[nero-mem2] Provider: openai-codex (local Codex token)');
    llmProvider = new OpenAICodexLLMProvider({
      authJsonPath: auth.sourcePath,
      credentials: auth.codexOAuth,
    });
  } else if (auth.defaultProvider === 'anthropic' && auth.anthropicApiKey) {
    console.log('[nero-mem2] Provider: anthropic');
    llmProvider = new AnthropicLLMProvider({ apiKey: auth.anthropicApiKey });
  } else if (auth.openaiApiKey) {
    console.log('[nero-mem2] Provider: openai');
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

// ── Fact Extractor & Repository ──
const factExtractor = new FactExtractor(llmProvider);
const factRepo = new FactRepository(db);

// ── Memory Node & Edge Repositories (for Memory Explorer UI) ──
const memoryNodeRepo = new MemoryNodeRepository(db);
const weightedEdgeRepo = new WeightedEdgeRepository(db);

// ── Turn Extraction Pipeline (auto-saves facts on turn.completed events) ──
const turnPipeline = new TurnExtractionPipeline(
  eventBus, factExtractor, factRepo, conversationRepo,
  { memoryNodeRepo },
);
turnPipeline.start();

// ── Retriever (hash-based embedding — no external embedding API) ──
const embeddingProvider = new MockEmbeddingProvider(256);
const retriever = new DualPathRetriever(db, embeddingProvider);

// ── Start Server ──
startServer(
  {
    ingestService,
    retriever,
    db,
    auth: false,       // localhost debug — no API key auth
    rateLimit: false,   // localhost debug — no rate limiting
    chatDeps: {
      llmProvider,
      retriever,
      factExtractor,
      factRepo,
      chatDb,
      eventBus,
      ingestService,
    },
    chatDb,
    memoryNodeDeps: {
      nodeRepo: memoryNodeRepo,
      edgeRepo: weightedEdgeRepo,
    },
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
console.log('  Full stack dev:');
console.log('    npm run dev');
console.log('    → frontend: http://localhost:5173');
console.log('');
console.log('  Backend only:');
console.log('    npm run dev:server');
console.log('');
console.log('  Frontend only:');
console.log('    npm run dev:web');
