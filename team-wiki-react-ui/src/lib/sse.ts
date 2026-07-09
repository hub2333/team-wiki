import type { ChatSource, ChatUsage, ReasoningStatus, ReasoningStep } from '../types';

export type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; tool: string; args?: unknown }
  | { type: 'tool_end'; tool: string; result?: string; durationMs?: number }
  | { type: 'sub_agent_start'; vaultId: string; vaultName: string; status: ReasoningStatus; index?: number }
  | { type: 'sub_agent_progress'; vaultId: string; vaultName: string; status: ReasoningStatus; step: Omit<ReasoningStep, 'createdAt'> }
  | { type: 'sub_agent_done'; vaultId: string; vaultName: string; status: ReasoningStatus; summary?: string; durationMs?: number; sources?: ChatSource[] }
  | { type: 'synthesis_start'; vaultCount?: number; vaults?: Array<{ vaultId: string; vaultName: string }> }
  | { type: 'synthesis_done'; durationMs?: number }
  | { type: 'done'; sessionId?: string; vaultId?: string | null; usage?: ChatUsage; sources?: ChatSource[]; model?: { id: string; name: string; model: string; baseUrl: string; hasApiKey: boolean; isDefault: boolean } }
  | { type: 'error'; message: string };

export async function streamChat(
  token: string,
  payload: { message: string; vaultIds: string[]; sessionId?: string | null; modelId?: string },
  onEvent: (event: ChatEvent) => void,
) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok || !res.body) {
    throw new Error(await readError(res));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let data = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      } else if (line === '' && eventName && data) {
        onEvent(normalizeEvent(eventName, JSON.parse(data)));
        eventName = '';
        data = '';
      }
    }
  }
}

function normalizeEvent(name: string, data: any): ChatEvent {
  if (name === 'text') return { type: 'text', content: data.content || '' };
  if (name === 'tool_start') return { type: 'tool_start', tool: data.tool || 'unknown', args: data.args };
  if (name === 'tool_end') {
    return {
      type: 'tool_end',
      tool: data.tool || 'unknown',
      result: data.result,
      durationMs: data.durationMs,
    };
  }
  if (name === 'sub_agent_start') {
    return {
      type: 'sub_agent_start',
      vaultId: data.vaultId,
      vaultName: data.vaultName,
      status: data.status || 'searching',
      index: data.index,
    };
  }
  if (name === 'sub_agent_progress') {
    return {
      type: 'sub_agent_progress',
      vaultId: data.vaultId,
      vaultName: data.vaultName,
      status: data.status || 'searching',
      step: data.step,
    };
  }
  if (name === 'sub_agent_done') {
    return {
      type: 'sub_agent_done',
      vaultId: data.vaultId,
      vaultName: data.vaultName,
      status: data.status || 'done',
      summary: data.summary,
      durationMs: data.durationMs,
      sources: data.sources || [],
    };
  }
  if (name === 'synthesis_start') return { type: 'synthesis_start', vaultCount: data.vaultCount, vaults: data.vaults || [] };
  if (name === 'synthesis_done') return { type: 'synthesis_done', durationMs: data.durationMs };
  if (name === 'done') return { type: 'done', sessionId: data.sessionId, vaultId: data.vaultId, usage: data.usage, sources: data.sources || [], model: data.model };
  if (name === 'error') return { type: 'error', message: data.message || 'Request failed' };
  return { type: 'text', content: '' };
}

async function readError(res: Response) {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    return body.error || body.message || text;
  } catch {
    return text || `${res.status} ${res.statusText}`;
  }
}
