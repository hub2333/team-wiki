/**
 * MCP server supporting both SSE (legacy) and Streamable HTTP (modern).
 *
 * Endpoints:
 *   SSE (legacy):     GET  /sse        → SSE connection
 *                     POST /messages?sessionId=xxx → client message
 *   Streamable HTTP:  ALL  /mcp        → single endpoint for all operations
 *   Shared:           GET  /health     → health check
 *
 * Based on the official SDK example: sseAndStreamableHttpCompatibleServer.js
 * Each transport connection gets its own McpServer instance sharing the same KnowledgeGraph.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { type KnowledgeGraph } from '../graph/index.js';
import type { AppConfig } from '../config.js';
import { createAuthMiddleware } from '../auth/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MCP');

export class McpService {
  private mcpRouter: Router;
  /** All transports indexed by sessionId */
  private transports: Record<string, SSEServerTransport | StreamableHTTPServerTransport> = {};
  private graph: KnowledgeGraph;
  private config: AppConfig;

  constructor(graph: KnowledgeGraph, config: AppConfig) {
    this.graph = graph;
    this.config = config;
    this.mcpRouter = Router();
    this.setupRoutes();
  }

  /**
   * Mount MCP routes onto an existing Express app.
   * Must be registered BEFORE express.json() middleware
   * so that raw body reading works for SSE transport.
   */
  mountOn(app: { use: (path: string, router: Router) => void }): void {
    app.use('/', this.mcpRouter);
  }

  async stop(): Promise<void> {
    for (const t of Object.values(this.transports)) {
      try { (t as any).close?.(); } catch {}
    }
    this.transports = {};
  }

  /**
   * Handle Streamable HTTP requests (POST for JSON-RPC, DELETE for session termination).
   */
  private async handleStreamableHttp(
    req: any,
    res: any,
  ): Promise<void> {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const body = req.body || {};
      const isInitRequest = body && typeof body === 'object' && body.method === 'initialize';
      let transport: StreamableHTTPServerTransport | undefined;

      // 1) Existing session — reuse transport
      if (sessionId && this.transports[sessionId] instanceof StreamableHTTPServerTransport) {
        transport = this.transports[sessionId] as StreamableHTTPServerTransport;
      }

      // 2) Initialize request (with or without sessionId) — create new transport
      if (!transport && isInitRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            this.transports[newSessionId] = transport!;
          },
        });

        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid && this.transports[sid]) {
            delete this.transports[sid];
          }
        };

        const server = this.createMcpServer();
        await server.connect(transport);
      }

      // 3) Neither — invalid (only for POST; DELETE without session is also invalid)
      if (!transport) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('handle_err', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  /**
   * Create a fresh McpServer with all tools registered.
   * Each transport connection gets its own instance sharing the same graph.
   */
  private createMcpServer(): McpServer {
    const server = new McpServer({
      name: 'md-knowledge-graph-mcp',
      version: '0.1.0',
    });
    registerTools(server, this.graph);
    return server;
  }

  private setupRoutes(): void {
    // ─── CORS is handled at app level in app.ts ──────────────

    // ─── Auth ──────────────────────────────────────────────
    this.mcpRouter.use(createAuthMiddleware({
      bearerToken: this.config.authToken,
      jwtSecret: this.config.jwtSecret,
    }));

    // ─── Health ────────────────────────────────────────────
    this.mcpRouter.get('/health', (_req, res) => {
      res.json({ status: 'ok', files: this.graph.nodes.size });
    });

    // ═══════════════════════════════════════════════════════
    // STREAMABLE HTTP TRANSPORT (protocol 2025-11-25)
    // POST /mcp → Streamable HTTP (all messages)
    // ═══════════════════════════════════════════════════════

    // ─── POST /mcp — Streamable HTTP JSON-RPC messages ─────
    this.mcpRouter.post('/mcp', async (req, res) => {
      await this.handleStreamableHttp(req, res);
    });

    // ─── DELETE /mcp — Streamable HTTP session termination ──
    this.mcpRouter.delete('/mcp', async (req, res) => {
      await this.handleStreamableHttp(req, res);
    });

    // ═══════════════════════════════════════════════════════
    // SSE TRANSPORT (protocol 2024-11-05, deprecated)
    // GET  /sse  or  GET /mcp → SSE connection (both work for compatibility)
    // POST /messages?sessionId=xxx → client messages
    // ═══════════════════════════════════════════════════════

    // Shared SSE handler function
    const handleSseConnection = async (req: any, res: any) => {
      try {
        const transport = new SSEServerTransport('/messages', res);
        this.transports[transport.sessionId] = transport;

        res.on('close', () => {
          delete this.transports[transport.sessionId];
        });

        // Each connection gets its own McpServer sharing the same graph
        const server = this.createMcpServer();
        await server.connect(transport);
      } catch (err) {
        log.error('sse_conn_err', err);
        if (!res.headersSent) {
          res.status(500).end('Internal server error');
        }
      }
    };

    // GET /sse — SSE connection (new standard endpoint)
    this.mcpRouter.get('/sse', handleSseConnection);

    // GET /mcp — SSE connection (backward compatibility for old clients)
    this.mcpRouter.get('/mcp', handleSseConnection);

    // POST /messages?sessionId=xxx — receive client messages via SSE
    this.mcpRouter.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string | undefined;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId query parameter required' });
        return;
      }

      const transport = this.transports[sessionId];
      if (!(transport instanceof SSEServerTransport)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      try {
        // Pass req.body as parsedBody (pre-parsed by express.json())
        await transport.handlePostMessage(req, res, req.body);
      } catch (err) {
        log.error('sse_post_err', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal error' });
        }
      }
    });
  }
}

// ─── Tool Registration ──────────────────────────────────

function registerTools(server: McpServer, graph: KnowledgeGraph): void {
  server.tool('search', 'Full-text search across all notes', {
    query: z.string(), limit: z.number().min(1).max(100).default(20),
  }, async ({ query, limit }) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.search(query, limit), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('search_by_tags', 'Find notes by tags', {
    tags: z.array(z.string()), mode: z.enum(['and', 'or']).default('or'), limit: z.number().min(1).max(100).default(20),
  }, async ({ tags, mode, limit }) => {
    try {
      const norm = tags.map(t => t.startsWith('#') ? t : `#${t}`);
      return { content: [{ type: 'text', text: JSON.stringify(graph.searchEngine.searchByTags(norm, mode).slice(0, limit), null, 2) }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('get_forwardlinks', 'Get outgoing wikilinks from a note', { path: z.string() }, async ({ path }) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.getForwardLinks(path), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('get_backlinks', 'Get incoming backlinks to a note', { path: z.string() }, async ({ path }) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.getBacklinks(path), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('get_neighbors', 'Get forward + back links', { path: z.string() }, async ({ path }) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.getNeighbors(path), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('traverse_graph', 'BFS traverse from a starting note', {
    start: z.string(), depth: z.number().min(1).max(10).default(2),
    direction: z.enum(['forward', 'backward', 'both']).default('both'),
    max_nodes: z.number().min(1).max(500).default(200),
    tag_filter: z.array(z.string()).optional(),
  }, async ({ start, depth, direction, max_nodes, tag_filter }) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.traverse(start, depth, direction, max_nodes, tag_filter), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('shortest_path', 'Shortest path between two notes', { from: z.string(), to: z.string() }, async ({ from, to }) => {
    try {
      const p = graph.shortestPath(from, to);
      if (p) return { content: [{ type: 'text', text: JSON.stringify({ path: p, length: p.length - 1 }, null, 2) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ message: 'No path found' }) }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('get_graph_stats', 'Graph statistics', {}, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.getStats(), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('read_note', 'Read full content of a note', { path: z.string() }, async ({ path }) => {
    try {
      const node = graph.nodes.get(path);
      if (!node) return { isError: true, content: [{ type: 'text', text: `Not found: ${path}` }] };
      const m = node.metadata;
      return { content: [{ type: 'text', text: JSON.stringify({
        path: m.path, basename: m.basename, frontmatter: m.frontmatter,
        headings: m.headings, tags: m.tags.map(t => t.name),
        links: m.links.map(l => ({ target: l.target, alias: l.alias })),
        content: m.content,
      }, null, 2) }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('list_notes', 'List notes, optionally by folder', {
    folder: z.string().optional(), limit: z.number().min(1).max(1000).default(100),
  }, async ({ folder, limit }) => {
    try {
      const results: Array<{ path: string; title: string; tags: string[] }> = [];
      for (const [p, node] of graph.nodes) {
        if (folder && !p.startsWith(folder)) continue;
        results.push({ path: p, title: node.metadata.basename, tags: node.metadata.tags.map(t => t.name) });
        if (results.length >= limit) break;
      }
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('get_tags', 'List all tags with counts', {}, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.getTags(), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('get_tag_hierarchy', 'Nested tag hierarchy', {}, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.getTagHierarchy(), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });

  server.tool('get_index_status', 'Index status', {}, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(graph.getStatus(), null, 2) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] }; }
  });
}
