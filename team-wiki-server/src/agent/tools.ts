/**
 * Direct OpenAI function tools wrapping KnowledgeGraph methods.
 *
 * The executable tool logic lives in knowledge-tools-core.ts so other agent
 * runtimes can use exactly the same schemas and handlers.
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import { KnowledgeGraph } from '../graph/index.js';
import { executeKnowledgeTool, KNOWLEDGE_TOOL_SPECS, type KnowledgeToolName } from './knowledge-tools-core.js';

export function createKnowledgeTools(graph: KnowledgeGraph) {
  return KNOWLEDGE_TOOL_SPECS.map(spec =>
    tool({
      name: spec.name,
      description: spec.description,
      parameters: z.object(spec.inputSchema),
      strict: true,
      execute: async (args) => executeKnowledgeTool(graph, spec.name as KnowledgeToolName, args),
    })
  );
}
