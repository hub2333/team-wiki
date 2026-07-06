/**
 * Agent factory — creates an OpenAI Agents SDK agent
 * with direct function tools for knowledge graph access.
 *
 * Flow:
 * 1. Create direct function tools wrapping KnowledgeGraph methods
 * 2. Create Agent with the tools
 *
 * The AI provider (DeepSeek / OpenAI / other) is configured via
 * environment variables set in app.ts (OPENAI_BASE_URL, OPENAI_API_KEY).
 *
 * Note: MCP server is NOT used internally. It remains available
 * for external consumers (Claude Desktop, Cursor, etc.).
 */

import { Agent } from '@openai/agents';
import { KnowledgeGraph } from '../graph/index.js';
import { createKnowledgeTools } from './tools.js';
import { KNOWLEDGE_AGENT_PROMPT } from './prompts.js';

export interface AgentConfig {
  /** Model name (e.g. deepseek-chat, gpt-4o) */
  model?: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  model: 'deepseek-v4-flash',
};

/**
 * Create a Knowledge Agent with direct function tools.
 *
 * After this, call `run(agent, input)` to execute.
 */
export function createKnowledgeAgent(
  graph: KnowledgeGraph,
  config: Partial<AgentConfig> = {}
): Agent {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const agent = new Agent({
    name: 'Knowledge Agent',
    model: cfg.model as any,
    instructions: KNOWLEDGE_AGENT_PROMPT,
    tools: createKnowledgeTools(graph),
  });

  return agent;
}
