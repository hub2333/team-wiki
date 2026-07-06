/**
 * Application entry point - wires together all components.
 *
 * To use DeepSeek (default):
 *   export AI_API_KEY=sk-your-deepseek-key
 *   npm start
 *
 * To use OpenAI:
 *   export AI_API_KEY=sk-your-openai-key
 *   export AI_BASE_URL=https://api.openai.com/v1
 *   export AI_MODEL=gpt-4o
 *   npm start
 */

import express from 'express';
import { setOpenAIAPI } from '@openai/agents-openai';
import { setTracingDisabled } from '@openai/agents-core';
import { KnowledgeGraph } from './graph/index.js';
import { McpService } from './mcp/index.js';
import { VaultWatcher } from './watcher/index.js';
import { loadConfig, type AppConfig } from './config.js';
import { initDb } from './db/index.js';
import { createAuthMiddleware } from './auth/index.js';
import { createChatRouter } from './chat/index.js';
import { createLogger } from './utils/logger.js';
import type { ServerConfig } from './types.js';

const log = createLogger('App');

export async function startApp(configOverrides?: Partial<ServerConfig>): Promise<{
  graph: KnowledgeGraph;
  mcp: McpService | null;
  watcher: VaultWatcher;
  stop: () => Promise<void>;
}> {
  const config = loadConfig();

  // Merge overrides for testing
  if (configOverrides) {
    Object.assign(config, configOverrides);
  }

  // ── Configure AI Provider (DeepSeek or compatible) ──

  // Force chat-completions API (DeepSeek doesn't support Responses API)
  setOpenAIAPI('chat_completions');

  // Disable tracing/telemetry (causes 403 errors when OpenAI tracing endpoint is geo-blocked)
  setTracingDisabled(true);

  // Set environment variables used by the OpenAI SDK
  if (config.aiApiKey) {
    process.env.OPENAI_API_KEY = config.aiApiKey;
  }
  if (config.aiBaseUrl) {
    process.env.OPENAI_BASE_URL = config.aiBaseUrl;
  }

  log.info('start', { vault: config.vaultPath, port: config.port, auth: !!config.authToken, db: config.dbPath, ai: `${config.aiBaseUrl} / ${config.aiModel}` });

  // 1. Init database
  initDb({ path: config.dbPath });
  log.info('db_ready');

  // 2. Create Express app
  const app = express();

  // Manual CORS middleware — runs before everything else
  app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Session-Id, Accept, Origin, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  // 3. Auth middleware (only applies to /api routes)
  const authMiddleware = createAuthMiddleware({
    bearerToken: config.authToken,
    jwtSecret: config.jwtSecret,
  });
  app.use('/api', authMiddleware);

  // 4. Health check is registered in MCP router
  //

  // 5. Create the knowledge graph
  const graph = new KnowledgeGraph();

  // 6. Start the vault watcher (builds initial index)
  const watcher = new VaultWatcher(graph, config, {
    onIndexingStart: () => log.info('index_start'),
    onIndexingComplete: (elapsed) =>
      log.info('index_done', { files: graph.nodes.size, elapsedMs: elapsed }),
    onError: (err) => log.error('watcher_error', { msg: err.message }),
    onFileChange: (path, action) => log.debug('file_change', { action, path }),
  });

  await watcher.start();

  // 7. Conditionally register MCP routes on Express (for external AI tools)
  let mcp: McpService | null = null;
  if (config.mcpEnabled) {
    mcp = new McpService(graph, config);
    mcp.mountOn(app);
    console.log(`  MCP: enabled (endpoint: /mcp)`);
  } else {
    // Mount health check directly if MCP is disabled (normally handled by MCP router)
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', files: graph.nodes.size });
    });
  }

  // 8. Register Chat API routes
  const chatRouter = createChatRouter(graph, config);
  app.use('/api', chatRouter);

  // 9. Web UI disabled (frontend removed)

  // 10. Start server
  const httpServer = app.listen(config.port, () => {
    console.log(`Server ready at http://localhost:${config.port}`);
    if (config.mcpEnabled) {
      console.log(`  MCP endpoint: http://localhost:${config.port}/mcp`);
    }
    console.log(`  Chat endpoint: POST http://localhost:${config.port}/api/chat`);
    console.log(`  Health: http://localhost:${config.port}/health`);
  });
  httpServer.on('error', (err: any) => {
    log.error('listen_error', { port: config.port, msg: err.message });
    process.exit(1);
  });

  // 11. Return shutdown function
  const stop = async () => {
    console.log('Shutting down...');
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    if (mcp) await mcp.stop();
    await watcher.stop();
    console.log('Shutdown complete');
  };

  return { graph, mcp, watcher, stop };
}
