/**
 * Chat module — Visual Debug Chat App backend components.
 *
 * Re-exports the auth-loader, chat-router, SSE helpers, trace types/collector,
 * and DB layer for the debug chat interface.
 */

// ─── Auth Loader ──────────────────────────────────────────
export {
  loadAuthCredentials,
  findAuthFile,
  parseAuthFile,
  resolveCredentials,
  getApiKeyForProvider,
  AUTH_SEARCH_PATHS,
} from './auth-loader.js';
export type { AuthFileContent, AuthCredentials } from './auth-loader.js';

// ─── SSE Helpers ──────────────────────────────────────────
export {
  formatSSE,
  safeSerialize,
  formatTraceSSE,
  formatChatSSE,
  formatDoneSSE,
  toSSETraceEvent,
  parseSSE,
  parseTraceSSE,
} from './sse-helpers.js';
export type {
  SSETraceEvent,
  SSEChatEvent,
  SSEDoneEvent,
} from './sse-helpers.js';

// ─── Trace Types ──────────────────────────────────────────
export type {
  RecallPipelineStage,
  TopLevelStage,
  TraceStage,
  TraceStatus,
  TraceEvent,
  TraceEventListener,
  VectorSearchTraceInput,
  VectorSearchTraceOutput,
  GraphTraversalTraceInput,
  GraphTraversalTraceOutput,
  MergeTraceInput,
  MergeTraceOutput,
  ReinforceTraceInput,
  ReinforceTraceOutput,
  FormatTraceInput,
  FormatTraceOutput,
  InjectTraceInput,
  InjectTraceOutput,
  BatchExtractionTraceInput,
  BatchExtractionTraceOutput,
  EpisodeExtractionTraceInput,
  EpisodeExtractionTraceOutput,
  ConceptExtractionTraceInput,
  ConceptExtractionTraceOutput,
} from './trace-types.js';

// ─── Trace Collector ──────────────────────────────────────
export { TraceCollector } from './trace-collector.js';

// ─── Chat Router ──────────────────────────────────────────
export { createChatRouter, validateChatRequest } from './chat-router.js';
export type {
  ChatRequest,
  TraceEvent as ChatRouterTraceEvent,
  ChatEvent,
  DoneEvent,
  ChatRouterDependencies,
  IngestionHandler,
} from './chat-router.js';

// ─── History Router ──────────────────────────────────────
export { createHistoryRouter } from './history-router.js';
export type { HistoryRouterDependencies } from './history-router.js';

// ─── Sessions Router ─────────────────────────────────────
export { createSessionsRouter } from './sessions-router.js';
export type {
  SessionsRouterDependencies,
  SessionSummary,
  SessionDetail,
  SessionMessage,
  SessionTimelineEvent,
  SessionStatus,
  SessionEndHandler,
  SessionEndResponse,
} from './sessions-router.js';

// ─── DB Layer ─────────────────────────────────────────────
export { ensureChatTables, openChatDatabase, getChatSchemaVersion } from './db/connection.js';
export type { ChatDatabaseOptions } from './db/connection.js';
export { CREATE_CHAT_TABLES, CHAT_SCHEMA_VERSION } from './db/schema.js';
export {
  saveTraceEvent,
  saveTraceEvents,
  savePipelineTraceEvents,
  getTraceEventsByMessage,
  getTraceEventsByConversation,
  getTraceEventsByStage,
  getTraceTimeline,
  getTraceTimelineWithData,
  getTraceStats,
  deleteTraceEventsByConversation,
  createPersistingListener,
} from './db/traceRepo.js';
export type { TraceEventRow, StoredTraceEvent, PipelineTraceEvent } from './db/traceRepo.js';

// ─── Conversation Repo ───────────────────────────────────
export {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  createMessage,
  getMessagesByConversation,
  getMessage,
  getNextTurnIndex,
  getMessageCount,
  deleteMessage,
  saveChatTurn,
  getOrCreateConversation,
} from './db/conversationRepo.js';
export type {
  ConversationRow,
  MessageRow,
  StoredConversation,
  StoredMessage,
  SaveChatTurnParams,
  SaveChatTurnResult,
} from './db/conversationRepo.js';
