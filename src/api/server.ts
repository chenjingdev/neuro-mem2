/**
 * HTTP Server — creates and starts the nero-mem2 REST API server.
 *
 * Designed for zero-config startup: downloads and runs immediately.
 * Uses @hono/node-server for Node.js HTTP compatibility.
 *
 * Usage:
 *   import { createServer, startServer } from './server.js';
 *   const server = await startServer({ port: 3030 });
 */

import { serve, type ServerType } from '@hono/node-server';
import type Database from 'better-sqlite3';
import { createRouter, type RouterDependencies } from './router.js';
import type { IngestService } from '../services/ingest.js';
import type { DualPathRetriever } from '../retrieval/dual-path-retriever.js';

// ─── Server Configuration ────────────────────────────────

export interface ServerConfig {
  /** Port to listen on (default: 3030) */
  port?: number;
  /** Hostname to bind to (default: '127.0.0.1') */
  hostname?: string;
}

export const DEFAULT_SERVER_CONFIG: Required<ServerConfig> = {
  port: 3030,
  hostname: '127.0.0.1',
};

// ─── Server Factory ──────────────────────────────────────

/**
 * Create and start the HTTP server with given dependencies.
 *
 * @returns A handle to the running server for shutdown control
 */
export function startServer(
  deps: RouterDependencies,
  config?: ServerConfig,
): ServerType {
  const cfg = { ...DEFAULT_SERVER_CONFIG, ...config };
  const app = createRouter(deps);

  const server = serve({
    fetch: app.fetch,
    port: cfg.port,
    hostname: cfg.hostname,
  }, (info) => {
    console.log(`[nero-mem2] API server listening on http://${cfg.hostname}:${info.port}`);
  });

  return server;
}

/**
 * Gracefully stop the server.
 */
export function stopServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
