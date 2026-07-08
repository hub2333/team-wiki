/**
 * Configuration loader for the md-knowledge-graph-mcp server.
 *
 * Supports selecting different env files, for example:
 *   ENV_FILE=.env.sqlite npm run dev
 *   ENV_FILE=.env.postgres npm start
 *   npm start -- --env-file .env.sqlite
 */

import { config as loadDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerConfig } from './types.js';

let envLoaded = false;

/** Extends ServerConfig with agent and auth settings */
export interface AppConfig extends ServerConfig {
  /** Selected env file path */
  envFile: string;
  /** Database provider */
  dbProvider: 'sqlite' | 'postgres';
  /** SQLite database path */
  dbPath: string;
  /** PostgreSQL connection string */
  dbUrl: string;
  /** Whether to use SSL for PostgreSQL */
  dbSsl: boolean;
  /** PostgreSQL connection pool max */
  dbPoolMax: number;
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
  /** Allowed CORS origins ("*" means any origin) */
  corsOrigins: string[];
  /** Optional resolved agent system prompt override */
  agentSystemPrompt: string;
  /** Optional agent system prompt file path */
  agentSystemPromptFile: string;
}

export function loadConfig(overrides?: Record<string, string | undefined>): AppConfig {
  ensureEnvLoaded(overrides);
  const env = overrides ?? (process.env as Record<string, string | undefined>);
  const envFile = resolve(getEnvFilePath(env));

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

    envFile,
    dbProvider: normalizeDbProvider(env.DB_PROVIDER),
    dbPath: resolve(env.DB_PATH ?? './data/chat.sqlite'),
    dbUrl: env.DATABASE_URL || env.DB_URL || '',
    dbSsl: (env.DB_SSL ?? 'false') === 'true',
    dbPoolMax: parseInt(env.DB_POOL_MAX ?? '20', 10),
    jwtSecret: env.JWT_SECRET ?? '',
    aiApiKey: env.AI_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '',
    aiBaseUrl: env.AI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
    aiModel: env.AI_MODEL || 'deepseek-v4-flash',
    webDir: resolve(env.WEB_DIR ?? './web/dist'),
    corsOrigins: (env.CORS_ORIGINS || env.CORS_ORIGIN || '*')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    agentSystemPrompt: loadAgentSystemPrompt(env),
    agentSystemPromptFile: resolveAgentSystemPromptFile(env),
  };
}

function ensureEnvLoaded(overrides?: Record<string, string | undefined>): void {
  if (envLoaded || overrides) return;

  const envFile = resolve(getEnvFilePath(process.env as Record<string, string | undefined>));
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile });
  }
  envLoaded = true;
}

function getEnvFilePath(env: Record<string, string | undefined>): string {
  return env.ENV_FILE || getCliEnvFile() || '.env';
}

function getCliEnvFile(): string | undefined {
  const exact = process.argv.find(arg => arg.startsWith('--env-file='));
  if (exact) {
    return exact.slice('--env-file='.length);
  }

  const idx = process.argv.indexOf('--env-file');
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }

  return undefined;
}

function normalizeDbProvider(raw: string | undefined): 'sqlite' | 'postgres' {
  return raw === 'postgres' ? 'postgres' : 'sqlite';
}

function resolveAgentSystemPromptFile(env: Record<string, string | undefined>): string {
  const raw = env.AGENT_SYSTEM_PROMPT_FILE?.trim();
  return raw ? resolve(raw) : '';
}

function loadAgentSystemPrompt(env: Record<string, string | undefined>): string {
  const filePath = resolveAgentSystemPromptFile(env);
  if (filePath && existsSync(filePath)) {
    return readFileSync(filePath, 'utf-8').trim();
  }

  return env.AGENT_SYSTEM_PROMPT?.trim() || '';
}
