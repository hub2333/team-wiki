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
import { run } from '@openai/agents';
import type { KnowledgeGraph } from '../graph/index.js';
import { createKnowledgeAgent } from '../agent/index.js';
import * as sessions from '../db/sessions.js';
import type { AppConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Chat');

// Rough token estimate: ~2 chars per token for mixed CJK/Latin text
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2);
}

export function createChatRouter(
  graph: KnowledgeGraph,
  config: AppConfig
): Router {
  const router = Router();

  // ─── POST /api/chat — SSE streaming chat ─────────────────

  router.post('/chat', async (req: Request, res: Response) => {
    const userId = (req as any).userId || 'anonymous';
    const { message, sessionId: existingSessionId } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'Message is required' });
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
      log.info(`Start`, `userId=${userId} msg="${message.trim().slice(0, 50)}"`);

      // 1. Get or create session
      sessionId = existingSessionId ?? null;
      let session = sessionId ? sessions.getSession(sessionId) : null;

      if (!session) {
        session = sessions.createSession(userId);
        sessionId = session.id;
      }

      // 2. Save user message
      sessions.addMessage({
        sessionId: sessionId!,
        role: 'user',
        content: message.trim(),
      });

      // 3. Create agent with direct KnowledgeGraph tools
      const agent = createKnowledgeAgent(graph, {
        model: (config as any).aiModel || 'deepseek-v4-flash',
      });

      // 4. Run agent with streaming
      const mcpResult = await run(agent, message.trim(), {
        stream: true,
      } as any);

      // Collect tool calls and final text
      const toolCalls: Array<{ name: string; args: any; result: any; durationMs: number }> = [];
      let fullText = '';
      const toolStartTimes = new Map<string, number>();
      let toolCallIdx = 0;

      // 5. Iterate through the stream
      const stream = (mcpResult as any).toStream();
      for await (const event of stream) {
        const eventType: string = event.type;

        if (eventType === 'raw_model_stream_event') {
          const data = event.data;
          const dataType: string = data.type;

          // Text tokens from the model
          if (dataType === 'output_text_delta') {
            const delta: string = data.delta || '';
            if (delta) {
              fullText += delta;
              sse('text', { content: delta });
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
            toolStartTimes.set(toolName + ':' + idx, Date.now());
            sse('tool_start', {
              tool: toolName,
              args: truncateValue(args),
              index: idx,
            });
          } else if (itemName === 'tool_output') {
            const toolName: string = rawItem.name || 'unknown';
            const output: any = item.output || rawItem.output || {};
            const resultStr = typeof output === 'string'
              ? output
              : JSON.stringify(output);

            // Compute elapsed time
            let durationMs = 0;
            // Match by position among pending tool calls of the same name
            const sameCalls = [...toolStartTimes.entries()]
              .filter(([k]) => k.startsWith(toolName + ':'))
              .sort();
            for (const [key, start] of sameCalls) {
              if (!toolCalls.some(tc => tc.name === toolName && tc.durationMs === 0)) {
                toolStartTimes.delete(key);
                durationMs = Date.now() - start;
                break;
              }
            }

            toolCalls.push({ name: toolName, args: {}, result: resultStr, durationMs });
            sse('tool_end', {
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
              sse('thought', { content: reasoningText });
            }
          }
        }
      }

      // 6. Compute usage stats
      const elapsedMs = Date.now() - startTime;
      const inputChars = message.trim().length;
      const outputChars = fullText.length;
      const totalInputChars = inputChars + (toolCalls.reduce((s, tc) => s + JSON.stringify(tc.args).length + (tc.result?.length || 0), 0));
      const usage = {
        elapsedMs,
        inputChars,
        outputChars,
        estimatedInputTokens: estimateTokens(totalInputChars),
        estimatedOutputTokens: estimateTokens(outputChars),
        estimatedTotalTokens: estimateTokens(totalInputChars) + estimateTokens(outputChars),
      };

      log.info(`Done`, `session=${sessionId} elapsed=${elapsedMs}ms tokens=${usage.estimatedTotalTokens}`);

      // 7. Save assistant message
      sessions.addMessage({
        sessionId: sessionId!,
        role: 'assistant',
        content: fullText,
        toolCalls: toolCalls.length > 0 ? JSON.stringify(toolCalls.map(({ name, args, result, durationMs }) => ({ name, args, result: truncateString(result, 500), durationMs }))) : undefined,
      });

      // 8. Auto-title: use first message to set session title
      const history = sessions.getMessages(sessionId!);
      if (history.length <= 2) {
        const title = message.trim().slice(0, 50) + (message.length > 50 ? '...' : '');
        sessions.updateSessionTitle(sessionId!, title);
      }

      // 9. Send done event with usage
      sse('done', {
        sessionId: sessionId!,
        toolCalls: toolCalls.map(({ name, result, durationMs }) => ({ name, result: truncateString(result, 500), durationMs })),
        usage,
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

  router.get('/sessions', (_req: Request, res: Response) => {
    const userId = (_req as any).userId || 'anonymous';
    const list = sessions.listSessions(userId);
    res.json({ sessions: list });
  });

  // ─── GET /api/sessions/:id — Get session messages ──────

  router.get('/sessions/:id', (req: Request, res: Response) => {
    const sid = String(req.params.id);
    const session = sessions.getSession(sid);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const msgs = sessions.getMessages(sid);
    res.json({ session, messages: msgs });
  });

  // ─── DELETE /api/sessions/:id — Delete session ─────────

  router.delete('/sessions/:id', (req: Request, res: Response) => {
    sessions.deleteSession(String(req.params.id));
    res.json({ ok: true });
  });

  return router;
}

// ─── Helpers ──────────────────────────────────────────────

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
