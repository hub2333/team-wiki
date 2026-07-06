/**
 * Configuration loader for the md-knowledge-graph-mcp server.
 *
 * Reads from .env file (via dotenv) and environment variables with sensible defaults.
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import type { ServerConfig } from './types.js';

/** Extends ServerConfig with agent and auth settings */
export interface AppConfig extends ServerConfig {
  /** SQLite database path */
  dbPath: string;
  /** JWT secret (empty = disabled) */
  jwtSecret: string;
  /** AI API Key (DeepSeek / OpenAI) */
  aiApiKey: string;
  /** AI API Base URL (default: DeepSeek) */
  aiBaseUrl: string;
  /** AI Model name */
  aiModel: string;
  /** Static file path for web UI */
  webDir: string;
}

export function loadConfig(overrides?: Record<string, string | undefined>): AppConfig {
  const env = overrides ?? (process.env as Record<string, string | undefined>);

  return {
    vaultPath: resolve(env.VAULT_PATH ?? './vault'),
    port: parseInt(env.PORT ?? '3100', 10),
    authToken: env.AUTH_TOKEN ?? '',
    transport: (env.TRANSPORT as ServerConfig['transport']) ?? 'streamable-http',
    mcpEnabled: (env.MCP_ENABLED ?? 'true') !== 'false',
    watchDebounceMs: parseInt(env.WATCH_DEBOUNCE_MS ?? '2000', 10),
    ignoreDotfiles: (env.IGNORE_DOTFILES ?? 'true') !== 'false',
    ignorePatterns: (env.IGNORE_PATTERNS ?? '.obsidian/**').split(',').map(s => s.trim()).filter(Boolean),
    indexConcurrency: parseInt(env.INDEX_CONCURRENCY ?? '10', 10),
    maxTraversalDepth: parseInt(env.MAX_TRAVERSAL_DEPTH ?? '5', 10),
    maxGraphNodes: parseInt(env.MAX_GRAPH_NODES ?? '200', 10),

    // AI config (defaults to DeepSeek)
    dbPath: resolve(env.DB_PATH ?? './data/chat.db'),
    jwtSecret: env.JWT_SECRET ?? '',
    aiApiKey: env.AI_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '',
    aiBaseUrl: env.AI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
    aiModel: env.AI_MODEL || 'deepseek-v4-flash',
    webDir: resolve(env.WEB_DIR ?? './web/dist'),
  };
}
