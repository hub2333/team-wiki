import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentInputItem } from '@openai/agents';
import { KnowledgeGraph } from '../graph/index.js';
import {
  executeKnowledgeTool,
  KNOWLEDGE_TOOL_SPECS,
  type KnowledgeToolName,
} from './knowledge-tools-core.js';

export interface ClaudeToolCapture {
  tool: string;
  args: any;
  result: string;
  durationMs: number;
}

export interface ClaudeCaptureOptions {
  emitText?: boolean;
  onText?: (delta: string) => void;
  onToolStart?: (tool: string, args: unknown) => void;
  onToolEnd?: (tool: string, result: string, durationMs: number) => void;
}

export async function runClaudeKnowledgeAgent(
  graph: KnowledgeGraph | null,
  input: AgentInputItem[],
  options: {
    model?: string;
    instructions: string;
    toolsEnabled?: boolean;
    maxTurns?: number;
    capture?: ClaudeCaptureOptions;
  }
): Promise<{ fullText: string; toolCalls: ClaudeToolCapture[] }> {
  const toolCalls: ClaudeToolCapture[] = [];
  const prompt = buildClaudePrompt(options.instructions, input);
  const capture = options.capture ?? {};
  let fullText = '';
  let sawStreamingText = false;
  const mcpServers = graph && options.toolsEnabled !== false
    ? { teamwiki: createClaudeKnowledgeServer(graph, capture, toolCalls) }
    : undefined;
  const allowedTools = mcpServers
    ? KNOWLEDGE_TOOL_SPECS.map(spec => `mcp__teamwiki__${spec.name}`)
    : [];

  const stream = query({
    prompt,
    options: {
      model: options.model || undefined,
      maxTurns: options.maxTurns ?? 8,
      tools: [],
      mcpServers,
      allowedTools,
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch'],
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      includePartialMessages: true,
      persistSession: false,
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'teamwiki/1.0',
      },
    },
  });

  for await (const message of stream) {
    if (message.type === 'stream_event') {
      const event: any = message.event;
      const delta = extractStreamTextDelta(event);
      if (delta) {
        sawStreamingText = true;
        fullText += delta;
        if (capture.emitText !== false) capture.onText?.(delta);
      }
      continue;
    }

    if (message.type === 'assistant' && !sawStreamingText) {
      const text = extractAssistantText(message.message?.content);
      if (text) {
        fullText += text;
        if (capture.emitText !== false) capture.onText?.(text);
      }
      continue;
    }

    if (message.type === 'result' && !fullText.trim() && 'result' in message && message.result) {
      fullText = String(message.result);
      if (capture.emitText !== false) capture.onText?.(fullText);
    }
  }

  return { fullText, toolCalls };
}

function createClaudeKnowledgeServer(
  graph: KnowledgeGraph,
  capture: ClaudeCaptureOptions,
  toolCalls: ClaudeToolCapture[]
) {
  return createSdkMcpServer({
    name: 'teamwiki',
    version: '1.0.0',
    instructions: 'Read-only TeamWiki knowledge graph tools. Use these tools to search and read the selected knowledge vault.',
    alwaysLoad: true,
    tools: KNOWLEDGE_TOOL_SPECS.map(spec =>
      tool(
        spec.name,
        spec.description,
        spec.inputSchema,
        async (args): Promise<CallToolResult> => {
          const started = Date.now();
          capture.onToolStart?.(spec.name, args);
          const result = await executeKnowledgeTool(graph, spec.name as KnowledgeToolName, args);
          const durationMs = Math.max(0, Date.now() - started);
          toolCalls.push({
            tool: spec.name,
            args,
            result,
            durationMs,
          });
          capture.onToolEnd?.(spec.name, result, durationMs);
          return {
            content: [{ type: 'text', text: result }],
          };
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          alwaysLoad: true,
        }
      )
    ),
  });
}

function buildClaudePrompt(instructions: string, input: AgentInputItem[]): string {
  const messages = input.map((item: any) => {
    if (item.role === 'assistant') {
      return `Assistant: ${extractOpenAIInputText(item.content)}`;
    }
    return `User: ${extractOpenAIInputText(item.content)}`;
  }).join('\n\n');

  return `${instructions.trim()}

Conversation:
${messages}

Answer the latest user message. Use the TeamWiki tools when evidence is needed.`;
}

function extractOpenAIInputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part || typeof part !== 'object') return '';
      const obj = part as Record<string, unknown>;
      return typeof obj.text === 'string' ? obj.text : '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function extractStreamTextDelta(event: any): string {
  if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return event.delta.text || '';
  }
  return '';
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part || typeof part !== 'object') return '';
    const block = part as Record<string, unknown>;
    return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).filter(Boolean).join('\n');
}
