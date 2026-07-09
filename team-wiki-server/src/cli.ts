#!/usr/bin/env node

/**
 * CLI entry point for md-knowledge-graph-mcp.
 *
 * Usage:
 *   mdkg-mcp                           # Start with defaults
 *   VAULT_PATH=/path/to/obsidian-vault npm start   # Custom vault path
 *   VAULT_PATH=/path/to/obsidian-vault PORT=3100 AUTH_TOKEN=secret npm start
 *   OPENAI_API_KEY=sk-xxx npm start     # Enable agent chat
 *   ENV_FILE=.env.sqlite npm run dev    # Use sqlite profile
 *   ENV_FILE=.env.postgres npm start    # Use postgres profile
 */

import { startApp } from './app.js';

async function main() {
  try {
    const { stop } = await startApp();

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}`);
      await stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('Press Ctrl+C to stop');
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

main();
