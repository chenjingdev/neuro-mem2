/**
 * OpenAPI 3.0 specification for the nero-mem2 Memory API.
 *
 * This spec is generated programmatically to stay in sync with the
 * actual route handlers and request/response types.
 *
 * The paths match the Hono router routes defined in router.ts:
 *   POST /ingest         — ingest a conversation
 *   POST /ingest/append  — append a message
 *   POST /recall         — recall memories
 *   GET  /health         — health check
 */

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

export function generateOpenApiSpec(port: number = 3030): OpenApiSpec {
  return {
    openapi: '3.0.3',
    info: {
      title: 'nero-mem2 Memory API',
      version: '0.1.0',
      description:
        'Local memory infrastructure for AI conversations. ' +
        'Transforms conversations into structured memories with dual-path ' +
        '(vector + graph) retrieval for context reconstruction.',
    },
    servers: [
      {
        url: `http://127.0.0.1:${port}`,
        description: 'Local development server',
      },
    ],
    paths: {
      '/ingest': {
        post: {
          operationId: 'ingestConversation',
          summary: 'Ingest a conversation',
          description:
            'Store a complete conversation with all messages as immutable records. ' +
            'Optionally triggers real-time fact extraction per turn.',
          tags: ['Ingestion'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/IngestConversationRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Conversation ingested successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/IngestConversationResponse' },
                },
              },
            },
            '400': {
              description: 'Validation error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/ingest/append': {
        post: {
          operationId: 'appendMessage',
          summary: 'Append a message to an existing conversation',
          description:
            'Append a single message to an existing conversation. ' +
            'Supports per-turn ingestion for real-time use.',
          tags: ['Ingestion'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AppendMessageRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Message appended successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AppendMessageResponse' },
                },
              },
            },
            '400': {
              description: 'Validation error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Conversation not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/recall': {
        post: {
          operationId: 'recall',
          summary: 'Recall relevant memories',
          description:
            'Execute dual-path (vector + graph) retrieval for a query. ' +
            'Returns ranked, merged memory items for context injection.',
          tags: ['Retrieval'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RecallRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Memories recalled successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RecallResponse' },
                },
              },
            },
            '400': {
              description: 'Validation error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '503': {
              description: 'Recall service not configured',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/search/hybrid': {
        post: {
          operationId: 'hybridSearch',
          summary: 'FTS5 + vector hybrid search on MemoryNode',
          description:
            'Execute 2-stage hybrid search: FTS5 pre-filtering for keyword matching, ' +
            'followed by vector cosine similarity reranking. Supports 한영 혼용 (Korean-English mixed) queries. ' +
            'Falls back to brute-force vector search when FTS5 returns insufficient candidates.',
          tags: ['Retrieval'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HybridSearchRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Hybrid search completed successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HybridSearchResponse' },
                },
              },
            },
            '400': {
              description: 'Validation error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '503': {
              description: 'Hybrid search service not configured',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/health': {
        get: {
          operationId: 'healthCheck',
          summary: 'Health check',
          description: 'Returns server health status.',
          tags: ['System'],
          responses: {
            '200': {
              description: 'Server is healthy',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        IngestConversationRequest: {
          type: 'object',
          required: ['source', 'messages'],
          properties: {
            id: { type: 'string', description: 'Optional custom conversation ID' },
            source: {
              type: 'string',
              description: 'Source application (e.g., claude-code, codex)',
              minLength: 1,
            },
            title: { type: 'string', description: 'Optional conversation title' },
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/MessageInput' },
              minItems: 1,
            },
            metadata: {
              type: 'object',
              additionalProperties: true,
              description: 'Optional conversation-level metadata',
            },
          },
        },
        MessageInput: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: {
              type: 'string',
              enum: ['user', 'assistant', 'system'],
            },
            content: { type: 'string', minLength: 1 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        IngestConversationResponse: {
          type: 'object',
          properties: {
            conversationId: { type: 'string' },
            messageCount: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        AppendMessageRequest: {
          type: 'object',
          required: ['conversationId', 'role', 'content'],
          properties: {
            conversationId: { type: 'string', description: 'Target conversation ID' },
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: { type: 'string', minLength: 1 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        AppendMessageResponse: {
          type: 'object',
          properties: {
            conversationId: { type: 'string' },
            turnIndex: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        RecallRequest: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'Query text for memory retrieval',
            },
            maxResults: { type: 'integer', minimum: 1, maximum: 100 },
            minScore: { type: 'number', minimum: 0, maximum: 1 },
            vectorWeight: { type: 'number', minimum: 0, maximum: 1 },
            includeDiagnostics: { type: 'boolean', default: false },
            config: {
              type: 'object',
              description: 'Advanced config overrides',
            },
          },
        },
        RecallResponse: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: { $ref: '#/components/schemas/RecallItem' },
            },
            totalItems: { type: 'integer' },
            query: { type: 'string' },
            diagnostics: {
              type: 'object',
              nullable: true,
              description: 'Diagnostic info (only when includeDiagnostics=true)',
            },
          },
        },
        RecallItem: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            nodeType: { type: 'string', enum: ['fact', 'episode', 'concept', 'anchor'] },
            score: { type: 'number' },
            content: { type: 'string' },
            sources: {
              type: 'array',
              items: { type: 'string', enum: ['vector', 'graph'] },
            },
            sourceScores: {
              type: 'object',
              properties: {
                vector: { type: 'number', nullable: true },
                graph: { type: 'number', nullable: true },
              },
            },
          },
        },
        HybridSearchRequest: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'Query text for hybrid search (한영 혼용 supported)',
            },
            topK: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            minScore: { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
            ftsWeight: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
            nodeTypeFilter: {
              oneOf: [
                { type: 'string', enum: ['semantic', 'episodic', 'procedural', 'prospective', 'emotional'] },
                {
                  type: 'array',
                  items: { type: 'string', enum: ['semantic', 'episodic', 'procedural', 'prospective', 'emotional'] },
                },
              ],
            },
            nodeRoleFilter: { type: 'string', enum: ['hub', 'leaf'] },
            applyDecay: { type: 'boolean', default: true },
            includeStats: { type: 'boolean', default: false },
            currentEventCounter: { type: 'number', minimum: 0 },
          },
        },
        HybridSearchResponse: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: { $ref: '#/components/schemas/HybridSearchItem' },
            },
            totalItems: { type: 'integer' },
            query: { type: 'string' },
            stats: {
              type: 'object',
              nullable: true,
              description: 'Search performance stats (only when includeStats=true)',
            },
          },
        },
        HybridSearchItem: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            nodeType: { type: 'string', nullable: true },
            nodeRole: { type: 'string', enum: ['hub', 'leaf'] },
            frontmatter: { type: 'string' },
            score: { type: 'number' },
            scoreBreakdown: {
              type: 'object',
              properties: {
                ftsScore: { type: 'number' },
                vectorScore: { type: 'number' },
                decayFactor: { type: 'number' },
                combinedBeforeDecay: { type: 'number' },
              },
            },
            source: { type: 'string', enum: ['fts+vector', 'vector-only', 'fts-only'] },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok'] },
            version: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  message: { type: 'string' },
                },
              },
              nullable: true,
            },
          },
        },
      },
    },
  };
}

/**
 * Validate that the OpenAPI spec has all required fields.
 * Returns an array of validation errors (empty = valid).
 */
export function validateOpenApiSpec(spec: OpenApiSpec): string[] {
  const errors: string[] = [];

  if (!spec.openapi?.startsWith('3.')) {
    errors.push('Missing or invalid openapi version');
  }

  if (!spec.info?.title) errors.push('Missing info.title');
  if (!spec.info?.version) errors.push('Missing info.version');

  const paths = Object.keys(spec.paths || {});
  if (paths.length === 0) {
    errors.push('No paths defined');
  }

  for (const path of paths) {
    const methods = spec.paths[path] as Record<string, unknown>;
    for (const method of Object.keys(methods)) {
      const op = methods[method] as Record<string, unknown>;
      if (!op.operationId) {
        errors.push(`Missing operationId for ${method.toUpperCase()} ${path}`);
      }
      if (!op.responses) {
        errors.push(`Missing responses for ${method.toUpperCase()} ${path}`);
      }
    }
  }

  // Validate schema references
  const schemas = spec.components?.schemas || {};
  const definedSchemas = new Set(Object.keys(schemas));
  const specJson = JSON.stringify(spec);
  const refPattern = /\$ref.*?#\/components\/schemas\/(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(specJson)) !== null) {
    if (!definedSchemas.has(match[1]!)) {
      errors.push(`Referenced schema not defined: ${match[1]}`);
    }
  }

  return errors;
}

/** List of all defined operation IDs */
export function getOperationIds(spec: OpenApiSpec): string[] {
  const ids: string[] = [];
  for (const path of Object.values(spec.paths)) {
    const methods = path as Record<string, Record<string, unknown>>;
    for (const op of Object.values(methods)) {
      if (op.operationId) ids.push(op.operationId as string);
    }
  }
  return ids;
}

/** List of all defined paths with their methods */
export function getEndpoints(spec: OpenApiSpec): Array<{ path: string; method: string; operationId: string }> {
  const endpoints: Array<{ path: string; method: string; operationId: string }> = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    const ops = methods as Record<string, Record<string, unknown>>;
    for (const [method, op] of Object.entries(ops)) {
      endpoints.push({
        path,
        method: method.toUpperCase(),
        operationId: (op.operationId as string) ?? '',
      });
    }
  }
  return endpoints;
}

/**
 * The required routes that must exist in the OpenAPI spec.
 * Used to validate that the spec stays in sync with the actual router.
 */
export const REQUIRED_ROUTES = [
  { method: 'POST', path: '/ingest', operationId: 'ingestConversation' },
  { method: 'POST', path: '/ingest/append', operationId: 'appendMessage' },
  { method: 'POST', path: '/recall', operationId: 'recall' },
  { method: 'GET', path: '/health', operationId: 'healthCheck' },
] as const;
