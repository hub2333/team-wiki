/**
 * Chat API endpoint — POST /api/chat with SSE streaming response.
 *
 * Flow:
 * 1. Client sends POST /api/chat with { sessionId?, message }
 * 2. Server loads session history from SQLite (or creates new session)
 * 3. Creates @openai/agents Agent with direct KnowledgeGraph tools
 * 4. Runs agent in streaming mode
 * 5. Emits SSE events: thought, tool_start, tool_end, text, done
 * 6. Saves conversation to SQLite
 */

import { Router, type Request, type Response } from 'express';
import { Agent, run, type AgentInputItem } from '@openai/agents';
import type { KnowledgeGraph } from '../graph/index.js';
import { createKnowledgeAgent } from '../agent/index.js';
import * as sessions from '../db/sessions.js';
import type { AppConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import type { GraphContext } from '../graph/manager.js';
import { getRequestUserId } from '../auth/index.js';
import type { ModelConfig } from '../db/types.js';
import {
  DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT,
  SYSTEM_PROMPT_SETTING_KEY,
  buildKnowledgeAgentPromptFromBase,
} from '../agent/prompts.js';

const log = createLogger('Chat');

interface ChatSource {
  title: string;
  path: string;
  vaultId?: string | null;
  vaultName?: string;
  snippet?: string;
  score?: number;
  tags?: string[];
}

interface CapturedToolCall {
  tool: string;
  args: any;
  result: any;
  durationMs: number;
  vaultId?: string | null;
  vaultName?: string;
}

type SseFn = (event: string, data: unknown) => void;

interface AgentCaptureOptions {
  emitText?: boolean;
  onToolStart?: (tool: string, args: unknown) => void;
  onToolEnd?: (tool: string, result: string, durationMs: number) => void;
}

interface RuntimeModel {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  hasApiKey: boolean;
  isDefault: boolean;
}

// Rough token estimate: ~2 chars per token for mixed CJK/Latin text
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2);
}

export function createChatRouter(
  graph: KnowledgeGraph,
  config: AppConfig,
  options?: {
    systemPrompt?: string;
    getGraphContext?: (vaultId?: string | null) => GraphContext | null;
    getBaseSystemPrompt?: () => Promise<string>;
  }
): Router {
  const router = Router();

  // ─── POST /api/chat — SSE streaming chat ─────────────────

  router.post('/chat', async (req: Request, res: Response) => {
    const userId = getRequestUserId(req);
    const { message, sessionId: existingSessionId } = req.body;
    const requestedVaultIds = normalizeVaultIds(req.body?.vaultIds, req.body?.vaultId);
    const requestedModelId = normalizeOptionalId(req.body?.modelId);

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const trimmedMessage = message.trim();
    let session = existingSessionId ? await sessions.getSession(String(existingSessionId)) : null;
    if (existingSessionId && (!session || session.userId !== userId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const activeVaultIds = session ? getSessionVaultIds(session) : requestedVaultIds;
    const selectedVaultIds = activeVaultIds.length > 0 ? activeVaultIds : requestedVaultIds;
    for (const vaultId of selectedVaultIds) {
      if (!(await canAccessVault(userId, vaultId))) {
        res.status(403).json({ error: 'Vault access denied' });
        return;
      }
    }

    const contexts = selectedVaultIds.length > 0
      ? selectedVaultIds.map(vaultId => options?.getGraphContext?.(vaultId) ?? null)
      : [options?.getGraphContext?.(null) ?? null];
    if (contexts.some(ctx => !ctx)) {
      res.status(409).json({ error: 'One or more vaults are not indexed or disabled. Please refresh the vault configuration.' });
      return;
    }
    const activeContexts = contexts.filter(Boolean) as GraphContext[];
    if (!activeContexts.length) {
      res.status(409).json({ error: 'No indexed vault is available.' });
      return;
    }
    const persistedVaultIds = activeContexts.map(ctx => ctx.vault.id);
    const activeVaultId = activeContexts.length === 1 ? activeContexts[0].vault.id : null;
    const baseSystemPrompt = await resolveBaseSystemPrompt(config, options);
    const sessionModelId = normalizeOptionalId(session?.metadata?.modelId);
    let selectedModel: RuntimeModel;
    try {
      selectedModel = await resolveRuntimeModel(config, requestedModelId || sessionModelId);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid model configuration' });
      return;
    }

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Helper to send SSE events
    const sse = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client may have disconnected
      }
    };

    const startTime = Date.now();
    let sessionId: string | null = null;
    try {
      log.info(`Start`, `userId=${userId} msg="${trimmedMessage.slice(0, 50)}"`);

      // 1. Get or create session
      sessionId = existingSessionId ?? null;
      if (!session) {
        session = await sessions.createSession(userId, undefined, activeVaultId, {
          vaultIds: persistedVaultIds,
          modelId: selectedModel.id,
          modelName: selectedModel.name,
          model: selectedModel.model,
          modelBaseUrl: selectedModel.baseUrl,
        });
        sessionId = session.id;
      }

      const priorMessages = (await sessions.getMessages(sessionId!, 50))
        .filter(msg => msg.role === 'user' || msg.role === 'assistant');

      // 2. Save user message
      await sessions.addMessage({
        sessionId: sessionId!,
        role: 'user',
        content: trimmedMessage,
      });

      const runResult = activeContexts.length === 1
        ? await runSingleVaultAgent(activeContexts[0], baseSystemPrompt, selectedModel.model, priorMessages, trimmedMessage, sse)
        : await runParallelVaultAgents(activeContexts, baseSystemPrompt, selectedModel.model, trimmedMessage, sse);
      const fullText = runResult.fullText;
      const toolCalls = runResult.toolCalls;

      // 6. Compute usage stats
      const elapsedMs = Date.now() - startTime;
      const inputChars = trimmedMessage.length;
      const outputChars = fullText.length;
      const historyChars = priorMessages.reduce((sum, msg) => sum + msg.content.length, 0);
      const totalInputChars = historyChars + inputChars + toolCalls.reduce((s, tc) => s + JSON.stringify(tc.args).length + (tc.result?.length || 0), 0);
      const inputTokens = estimateTokens(totalInputChars);
      const outputTokens = estimateTokens(outputChars);
      const usage = {
        elapsedMs,
        inputChars,
        outputChars,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: outputTokens,
        estimatedTotalTokens: inputTokens + outputTokens,
      };
      const sources = extractSources(toolCalls);

      log.info(`Done`, `session=${sessionId} elapsed=${elapsedMs}ms tokens=${usage.estimatedTotalTokens}`);

      // 7. Save assistant message
      await sessions.addMessage({
        sessionId: sessionId!,
        role: 'assistant',
        content: fullText,
        toolCalls: toolCalls.length > 0
          ? JSON.stringify(toolCalls.map(({ tool, args, result, durationMs, vaultId, vaultName }) => ({
              tool,
              args,
              result: truncateString(result, 500),
              durationMs,
              vaultId,
              vaultName,
            })))
          : undefined,
        metadata: {
          usage,
          model: publicRuntimeModel(selectedModel),
          sources,
        },
      });

      await getDb().addUsageEvent({
        userId,
        vaultId: activeVaultId,
        sessionId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        elapsedMs,
      });

      // 8. Auto-title: use first message to set session title
      const history = await sessions.getMessages(sessionId!);
      if (history.length <= 2) {
        const title = trimmedMessage.slice(0, 50) + (trimmedMessage.length > 50 ? '...' : '');
        await sessions.updateSessionTitle(sessionId!, title);
      }

      // 9. Send done event with usage
      sse('done', {
        sessionId: sessionId!,
        vaultId: activeVaultId,
        toolCalls: toolCalls.map(({ tool, args, result, durationMs, vaultId, vaultName }) => ({
          tool,
          args,
          result: truncateString(result, 500),
          durationMs,
          vaultId,
          vaultName,
        })),
        sources,
        usage,
        model: publicRuntimeModel(selectedModel),
      });

      res.end();

    } catch (err: any) {
      log.error(`Error (${Date.now() - startTime}ms)`, err.message);
      try {
        sse('error', { message: err.message || 'Internal server error' });
        sse('done', { sessionId: null });
        res.end();
      } catch {
        res.end();
      }
    }
  });

  // ─── GET /api/sessions — List user sessions ─────────────

  router.get('/sessions', async (_req: Request, res: Response) => {
    const userId = getRequestUserId(_req);
    const vaultIds = normalizeVaultIds(_req.query.vaultIds, _req.query.vaultId);
    for (const vaultId of vaultIds) {
      if (!(await canAccessVault(userId, vaultId))) {
        res.status(403).json({ error: 'Vault access denied' });
        return;
      }
    }
    const list = await sessions.listSessions(userId, 50);
    res.json({
      sessions: vaultIds.length > 0
        ? list.filter(session => {
            const ids = getSessionVaultIds(session);
            return vaultIds.some(id => ids.includes(id));
          })
        : list,
    });
  });

  // ─── GET /api/sessions/:id — Get session messages ──────

  router.get('/sessions/:id', async (req: Request, res: Response) => {
    const userId = getRequestUserId(req);
    const sid = String(req.params.id);
    const session = await sessions.getSession(sid);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const msgs = await sessions.getMessages(sid);
    res.json({ session, messages: msgs });
  });

  // ─── DELETE /api/sessions/:id — Delete session ─────────

  router.put('/sessions/:id', async (req: Request, res: Response) => {
    const userId = getRequestUserId(req);
    const sid = String(req.params.id);
    const title = String(req.body?.title || '').trim();
    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    const session = await sessions.getSession(sid);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await sessions.updateSessionTitle(sid, title.slice(0, 120));
    const next = await sessions.getSession(sid);
    res.json({ session: next });
  });

  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    const userId = getRequestUserId(req);
    const sid = String(req.params.id);
    const session = await sessions.getSession(sid);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await sessions.deleteSession(sid);
    res.json({ ok: true });
  });

  return router;
}

// ─── Helpers ──────────────────────────────────────────────

async function canAccessVault(userId: string, vaultId: string): Promise<boolean> {
  if (userId === 'anonymous' || userId === 'user') return true;
  const user = await getDb().getUser(userId);
  if (!user || user.status !== 'active') return false;
  if (user.role === 'admin') return true;
  const ids = await getDb().getUserVaultIds(user.id);
  return ids.includes(vaultId);
}

async function resolveBaseSystemPrompt(
  config: AppConfig,
  options?: { systemPrompt?: string; getBaseSystemPrompt?: () => Promise<string> }
): Promise<string> {
  if (options?.getBaseSystemPrompt) return options.getBaseSystemPrompt();
  const setting = await getDb().getSetting(SYSTEM_PROMPT_SETTING_KEY);
  return setting?.value || config.agentSystemPrompt || options?.systemPrompt || DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT;
}

async function resolveRuntimeModel(config: AppConfig, requestedModelId?: string): Promise<RuntimeModel> {
  if (requestedModelId && requestedModelId !== 'environment') {
    const modelConfig = await getDb().getModelConfig(requestedModelId);
    if (!modelConfig) throw new Error('Model config not found');
    if (!modelConfig.enabled) throw new Error('Selected model is disabled');
    return applyModelEnvironment(toRuntimeModel(modelConfig));
  }

  const defaultConfig = requestedModelId === 'environment' ? null : await getDb().getDefaultModelConfig();
  if (defaultConfig?.enabled) {
    return applyModelEnvironment(toRuntimeModel(defaultConfig, true));
  }

  return applyModelEnvironment({
    id: 'environment',
    name: 'Environment default',
    baseUrl: config.aiBaseUrl,
    model: config.aiModel || 'deepseek-v4-flash',
    apiKey: config.aiApiKey,
    hasApiKey: Boolean(config.aiApiKey),
    isDefault: true,
  });
}

function toRuntimeModel(modelConfig: ModelConfig, isDefault = modelConfig.isDefault): RuntimeModel {
  return {
    id: modelConfig.id,
    name: modelConfig.name,
    baseUrl: modelConfig.baseUrl,
    model: modelConfig.model,
    apiKey: modelConfig.apiKey,
    hasApiKey: Boolean(modelConfig.apiKey),
    isDefault,
  };
}

function applyModelEnvironment(model: RuntimeModel): RuntimeModel {
  if (!model.hasApiKey) {
    throw new Error(`Selected model "${model.name}" is missing an API key`);
  }
  if (model.apiKey) process.env.OPENAI_API_KEY = model.apiKey;
  if (model.baseUrl) process.env.OPENAI_BASE_URL = model.baseUrl;
  return model;
}

function publicRuntimeModel(model: RuntimeModel) {
  return {
    id: model.id,
    name: model.name,
    baseUrl: model.baseUrl,
    model: model.model,
    enabled: true,
    isDefault: model.isDefault,
    hasApiKey: model.hasApiKey,
  };
}

async function runSingleVaultAgent(
  ctx: GraphContext,
  basePrompt: string,
  model: string,
  priorMessages: sessions.Message[],
  message: string,
  sse: SseFn
): Promise<{ fullText: string; toolCalls: CapturedToolCall[] }> {
  const started = Date.now();
  sse('sub_agent_start', {
    vaultId: ctx.vault.id,
    vaultName: ctx.vault.name,
    index: 0,
    status: 'searching',
  });
  const agent = createKnowledgeAgent(ctx.graph, {
    model,
    instructions: buildKnowledgeAgentPromptFromBase(ctx.graph, basePrompt),
  });
  const result = await runAgentAndCapture(agent, buildRunInput(priorMessages, message), sse, {
    onToolStart: (tool, args) => {
      sse('sub_agent_progress', {
        vaultId: ctx.vault.id,
        vaultName: ctx.vault.name,
        status: tool === 'read_note' ? 'reading' : 'searching',
        step: {
          type: 'tool_start',
          tool,
          args: truncateValue(args),
        },
      });
    },
    onToolEnd: (tool, output, durationMs) => {
      sse('sub_agent_progress', {
        vaultId: ctx.vault.id,
        vaultName: ctx.vault.name,
        status: tool === 'read_note' ? 'reading' : 'searching',
        step: {
          type: 'tool_end',
          tool,
          result: truncateString(output, 300),
          durationMs,
        },
      });
    },
  });
  const toolCalls = result.toolCalls.map(call => ({
    ...call,
    vaultId: ctx.vault.id,
    vaultName: ctx.vault.name,
  }));
  sse('sub_agent_done', {
    vaultId: ctx.vault.id,
    vaultName: ctx.vault.name,
    status: result.fullText.trim() ? 'done' : 'weak_evidence',
    summary: truncateString(result.fullText || '未收集到可用线索。', 600),
    durationMs: Math.max(0, Date.now() - started),
    sources: extractSources(toolCalls, 6),
  });
  return {
    fullText: result.fullText,
    toolCalls,
  };
}

async function runParallelVaultAgents(
  contexts: GraphContext[],
  basePrompt: string,
  model: string,
  message: string,
  sse: SseFn
): Promise<{ fullText: string; toolCalls: CapturedToolCall[] }> {
  const started = Date.now();
  const subResults = await Promise.all(contexts.map(async (ctx, index) => {
    const label = `sub_agent:${ctx.vault.name}`;
    const subStarted = Date.now();
    sse('sub_agent_start', {
      vaultId: ctx.vault.id,
      vaultName: ctx.vault.name,
      index,
      status: 'searching',
    });
    sse('tool_start', {
      tool: label,
      args: { vaultId: ctx.vault.id, vaultName: ctx.vault.name },
      index,
    });

    const instructions = `${buildKnowledgeAgentPromptFromBase(ctx.graph, basePrompt)}

你现在是知识库「${ctx.vault.name}」的线索收集 sub agent。
只在这个知识库内检索证据。请输出：
1. 与问题相关的关键结论或事实。
2. 明确的来源路径。
3. 证据不足或冲突之处。
不要做跨知识库综合判断。`;
    const agent = createKnowledgeAgent(ctx.graph, { model, instructions });
    const result = await runAgentAndCapture(agent, [{
      role: 'user',
      content: `用户问题：${message}\n\n请并行收集本知识库的线索。`,
    } as AgentInputItem], undefined, {
      emitText: false,
      onToolStart: (tool, args) => {
        sse('sub_agent_progress', {
          vaultId: ctx.vault.id,
          vaultName: ctx.vault.name,
          status: tool === 'read_note' ? 'reading' : 'searching',
          step: {
            type: 'tool_start',
            tool,
            args: truncateValue(args),
          },
        });
      },
      onToolEnd: (tool, output, durationMs) => {
        sse('sub_agent_progress', {
          vaultId: ctx.vault.id,
          vaultName: ctx.vault.name,
          status: tool === 'read_note' ? 'reading' : 'searching',
          step: {
            type: 'tool_end',
            tool,
            result: truncateString(output, 300),
            durationMs,
          },
        });
      },
    });
    const durationMs = Math.max(0, Date.now() - subStarted);
    const toolCalls = result.toolCalls.map(call => ({
      ...call,
      vaultId: ctx.vault.id,
      vaultName: ctx.vault.name,
    }));
    sse('sub_agent_done', {
      vaultId: ctx.vault.id,
      vaultName: ctx.vault.name,
      status: result.fullText.trim() ? 'done' : 'weak_evidence',
      summary: truncateString(result.fullText || '未收集到可用线索。', 600),
      durationMs,
      sources: extractSources(toolCalls, 6),
    });
    sse('tool_end', {
      tool: label,
      result: truncateString(result.fullText || '(no clues)', 300),
      durationMs,
    });

    return {
      vaultId: ctx.vault.id,
      vaultName: ctx.vault.name,
      text: result.fullText,
      toolCalls,
    };
  }));

  const synthesisStarted = Date.now();
  sse('synthesis_start', {
    vaultCount: contexts.length,
    vaults: contexts.map(ctx => ({ vaultId: ctx.vault.id, vaultName: ctx.vault.name })),
  });
  const synthAgent = new Agent({
    name: 'Knowledge Synthesizer',
    model: model as any,
    instructions: buildSynthesisPrompt(basePrompt, subResults),
  });
  const synthesis = await runAgentAndCapture(synthAgent, [{
    role: 'user',
    content: `用户问题：${message}\n\n请基于 sub agent 并行收集到的线索给出最终回答。`,
  } as AgentInputItem], sse);
  sse('synthesis_done', {
    durationMs: Math.max(0, Date.now() - synthesisStarted),
  });

  const toolCalls = subResults.flatMap(result => result.toolCalls);
  toolCalls.push({
    tool: 'parallel_sub_agents',
    args: { vaultIds: contexts.map(ctx => ctx.vault.id) },
    result: JSON.stringify(subResults.map(({ vaultId, vaultName, text }) => ({ vaultId, vaultName, text }))),
    durationMs: Math.max(0, Date.now() - started),
    vaultId: '',
    vaultName: 'Parallel sub agents',
  });

  return {
    fullText: synthesis.fullText,
    toolCalls,
  };
}
async function runAgentAndCapture(
  agent: Agent,
  input: AgentInputItem[],
  sse?: SseFn,
  options: AgentCaptureOptions = {}
): Promise<{ fullText: string; toolCalls: CapturedToolCall[] }> {
  const mcpResult = await run(agent, input, { stream: true } as any);
  const toolCalls: CapturedToolCall[] = [];
  let fullText = '';
  const pendingToolCalls: Array<{ tool: string; args: any; startedAt: number }> = [];
  let toolCallIdx = 0;

  const stream = (mcpResult as any).toStream();
  for await (const event of stream) {
    const eventType: string = event.type;

    if (eventType === 'raw_model_stream_event') {
      const data = event.data;
      if (data.type === 'output_text_delta') {
        const delta: string = data.delta || '';
        if (delta) {
          fullText += delta;
          if (options.emitText !== false) {
            sse?.('text', { content: delta });
          }
        }
      }
    } else if (eventType === 'run_item_stream_event') {
      const itemName: string = event.name;
      const item: any = event.item;
      const rawItem: any = item?.rawItem || {};

      if (itemName === 'tool_called') {
        const toolName: string = rawItem.name || 'unknown';
        const args = rawItem.arguments || rawItem.input || {};
        const idx = toolCallIdx++;
        pendingToolCalls.push({ tool: toolName, args, startedAt: Date.now() });
        options.onToolStart?.(toolName, args);
        sse?.('tool_start', {
          tool: toolName,
          args: truncateValue(args),
          index: idx,
        });
      } else if (itemName === 'tool_output') {
        const toolName: string = rawItem.name || 'unknown';
        const output: any = item.output || rawItem.output || {};
        const resultStr = typeof output === 'string' ? output : JSON.stringify(output);
        const pendingIdx = pendingToolCalls.findIndex(tc => tc.tool === toolName);
        const pending = pendingIdx >= 0
          ? pendingToolCalls.splice(pendingIdx, 1)[0]
          : { tool: toolName, args: {}, startedAt: Date.now() };
        const durationMs = Math.max(0, Date.now() - pending.startedAt);

        toolCalls.push({
          tool: toolName,
          args: pending.args,
          result: resultStr,
          durationMs,
        });
        options.onToolEnd?.(toolName, resultStr, durationMs);
        sse?.('tool_end', {
          tool: toolName,
          result: truncateString(resultStr, 300),
          durationMs,
        });
      } else if (itemName === 'reasoning_item_created') {
        const content: any[] = rawItem.content || [];
        const reasoningText = content
          .map((c: any) => c.text || '')
          .filter(Boolean)
          .join(' ');
        if (reasoningText) {
          sse?.('thought', { content: reasoningText });
        }
      }
    }
  }

  return { fullText, toolCalls };
}

function buildSynthesisPrompt(
  basePrompt: string,
  subResults: Array<{ vaultId: string; vaultName: string; text: string }>
): string {
  const evidence = subResults.map(result => `## 知识库：${result.vaultName} (${result.vaultId})
${result.text || '未收集到可用线索。'}`).join('\n\n');

  return `${basePrompt.trim()}

你是最终回答合成 agent。你只能基于下面这些 sub agent 并行收集到的线索作答。
要求：
1. 明确区分不同知识库的证据，不要把一个知识库的结论误归到另一个知识库。
2. 证据不足时说明不足。
3. 回答中保留来源路径；如果来源来自不同知识库，标出知识库名称。
4. 不要再调用工具。

并行线索：
${evidence}`;
}

function truncateValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  const str = JSON.stringify(val);
  if (str.length > 200) {
    return str.slice(0, 200) + '...';
  }
  return val;
}

function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function normalizeVaultIds(rawVaultIds: unknown, legacyVaultId?: unknown): string[] {
  const ids = new Set<string>();
  if (Array.isArray(rawVaultIds)) {
    for (const id of rawVaultIds) {
      const value = String(id || '').trim();
      if (value) ids.add(value);
    }
  } else if (typeof rawVaultIds === 'string') {
    for (const id of rawVaultIds.split(',')) {
      const value = id.trim();
      if (value) ids.add(value);
    }
  }

  const legacy = legacyVaultId ? String(legacyVaultId).trim() : '';
  if (legacy) ids.add(legacy);
  return [...ids];
}

function normalizeOptionalId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function getSessionVaultIds(session: sessions.Session): string[] {
  if (Array.isArray(session.vaultIds) && session.vaultIds.length) {
    return session.vaultIds.map(id => String(id)).filter(Boolean);
  }
  const metadataVaultIds = session.metadata?.vaultIds;
  if (Array.isArray(metadataVaultIds)) {
    return metadataVaultIds.map(id => String(id)).filter(Boolean);
  }
  return session.vaultId ? [session.vaultId] : [];
}

function extractSources(toolCalls: CapturedToolCall[], limit = 12): ChatSource[] {
  const sources = new Map<string, ChatSource>();

  for (const call of toolCalls) {
    if (!['search', 'search_by_tags', 'read_note', 'list_notes'].includes(call.tool)) continue;
    const parsed = parseToolResult(call.result);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as any;
      const path = candidate.path || candidate.source?.path;
      const key = `${call.vaultId || 'default'}:${path}`;
      if (!path || sources.has(key)) continue;

      sources.set(key, {
        title: candidate.title || candidate.basename || basenameFromPath(path),
        path,
        vaultId: call.vaultId ?? null,
        vaultName: call.vaultName,
        snippet: candidate.snippet,
        score: typeof candidate.score === 'number' ? candidate.score : undefined,
        tags: Array.isArray(candidate.tags)
          ? candidate.tags
          : Array.isArray(candidate.source?.tags)
            ? candidate.source.tags
            : undefined,
      });

      if (sources.size >= limit) {
        return [...sources.values()];
      }
    }
  }

  return [...sources.values()];
}

function parseToolResult(raw: any): any {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const file = normalized.split('/').pop() || path;
  return file.replace(/\.md$/i, '');
}

function buildRunInput(
  history: sessions.Message[],
  message: string
): AgentInputItem[] {
  const boundedHistory = history.slice(-24);
  const items: AgentInputItem[] = [];

  for (const msg of boundedHistory) {
    if (msg.role === 'assistant') {
      items.push({
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: msg.content }],
      } as AgentInputItem);
    } else {
      items.push({
        role: 'user',
        content: msg.content,
      } as AgentInputItem);
    }
  }

  items.push({
    role: 'user',
    content: message,
  } as AgentInputItem);

  return items;
}
