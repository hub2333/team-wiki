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
import { closeDb, initDb } from './db/index.js';
import { createAuthMiddleware } from './auth/index.js';
import { createChatRouter } from './chat/index.js';
import { createLogger } from './utils/logger.js';
import type { ServerConfig } from './types.js';
import { bootstrapProductData } from './admin/bootstrap.js';
import { createProductRouter, createPublicAuthRouter, getJwtSecret } from './admin/routes.js';
import { VaultGraphManager } from './graph/manager.js';
import { getDb } from './db/index.js';
import { DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT, SYSTEM_PROMPT_SETTING_KEY } from './agent/prompts.js';

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

  log.info('start', {
    vault: config.vaultPath,
    port: config.port,
    auth: !!config.authToken,
    dbProvider: config.dbProvider,
    db: config.dbProvider === 'postgres' ? config.dbUrl : config.dbPath,
    ai: `${config.aiBaseUrl} / ${config.aiModel}`,
    envFile: config.envFile,
  });

  // 1. Init database
  await initDb({
    provider: config.dbProvider,
    path: config.dbPath,
    url: config.dbUrl,
    ssl: config.dbSsl,
    poolMax: config.dbPoolMax,
  });
  log.info('db_ready');

  await bootstrapProductData(config);

  // 2. Start all enabled vault graphs before accepting product traffic.
  const vaultManager = new VaultGraphManager(config);
  await vaultManager.start(await getDb().listVaults({ enabledOnly: true }));
  const defaultContext = vaultManager.first();
  if (!defaultContext) {
    throw new Error('No enabled knowledge vaults configured.');
  }
  const graph = defaultContext.graph;
  const watcher = defaultContext.watcher;
  const systemPrompt = defaultContext.systemPrompt;

  // 3. Create Express app
  const app = express();

  // Manual CORS middleware — runs before everything else
  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    const allowAnyOrigin = config.corsOrigins.includes('*');
    const isAllowedOrigin = requestOrigin ? config.corsOrigins.includes(requestOrigin) : false;

    if (allowAnyOrigin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (requestOrigin && isAllowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

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

  app.use('/api', createPublicAuthRouter(config));

  // 3. Auth middleware (only applies to /api routes)
  const authMiddleware = createAuthMiddleware({
    bearerToken: config.authToken,
    jwtSecret: getJwtSecret(config),
  });
  app.use('/api', authMiddleware);
  app.use('/api', createProductRouter(config, vaultManager));

  // 4. Health check is registered in MCP router
  //

  log.info('agent_prompt_ready', {
    mode: config.agentSystemPromptFile
      ? 'file+dynamic'
      : config.agentSystemPrompt
        ? 'inline+dynamic'
        : 'default+dynamic',
    promptChars: systemPrompt.length,
  });

  // 7. Conditionally register MCP routes on Express (for external AI tools)
  let mcp: McpService | null = null;
  if (config.mcpEnabled) {
    mcp = new McpService(graph, config);
    mcp.mountOn(app);
    console.log(`  MCP: enabled (endpoint: /mcp)`);
  } else {
    // Mount health check directly if MCP is disabled (normally handled by MCP router)
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', files: graph.nodes.size, vaults: vaultManager.listStatus() });
    });
  }

  // 8. Register Chat API routes
  const chatRouter = createChatRouter(graph, config, {
    systemPrompt,
    getGraphContext: (vaultId) => vaultManager.get(vaultId),
    getBaseSystemPrompt: async () => {
      const setting = await getDb().getSetting(SYSTEM_PROMPT_SETTING_KEY);
      return setting?.value || config.agentSystemPrompt || DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT;
    },
  });
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
    await vaultManager.stop();
    await closeDb();
    console.log('Shutdown complete');
  };

  return { graph, mcp, watcher, stop };
}
